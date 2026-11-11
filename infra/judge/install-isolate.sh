#!/usr/bin/env bash
# Build and install IOI isolate (pinned) on a judge host or a Linux dev box.
#
# Idempotent. Run as root. Used by cloud-init on production judge hosts
# (infra/judge/cloud-init.yaml), by CI, and on the WSL2 development box.
#
# Pinned to an exact upstream tag AND commit so a rebuilt host is
# byte-identical to the one it replaces.
#
#   sudo bash infra/judge/install-isolate.sh
#   sudo RECJUDGE_SLOTS=6 RECX_SLOT_CPUS=2,3,4,5,6,7 bash infra/judge/install-isolate.sh
#   RECX_SLOT_CPUS=2,4,6 bash infra/judge/install-isolate.sh --print-config   # no root; changes nothing
#
# Environment (or the equivalent --flags):
#   RECJUDGE_SLOTS   concurrent judge slots; sizes the RAM box root (default:
#                    the number of RECX_SLOT_CPUS entries, else 4)
#   RECX_SLOT_CPUS   CPU pinning, PRODUCTION HOSTS ONLY: a comma-separated list
#                    of logical CPU ids, one per slot, in slot order —
#                    "2,3,4,5,6,7" means slot 0 -> CPU 2, slot 1 -> CPU 3, …
#                    Each listed CPU must be a different physical core: its
#                    SMT sibling(s) are left idle (never another slot, never
#                    the OS). Slot N's run, compile and checker boxes
#                    (RECX_BOX_BASE+N, +100+N, +200+N) are all pinned to its
#                    CPU via isolate's per-box "box<id>.cpus" setting, and
#                    system.slice / user.slice (the OS, sshd, the worker
#                    process itself) are confined to the remaining
#                    housekeeping CPUs. Unset (the dev box, CI): no pinning,
#                    and the configuration is exactly the unpinned one.
#   RECX_BOX_BASE    the worker's box-id base (default 0); must match the
#                    worker's RECX_BOX_BASE
#   RECX_SELFCHECK_BOX_BASE
#                    the worker's maintenance boxes (default 900: 900-909 —
#                    self-check, calibration, startup credit). With pinning
#                    they run on the housekeeping CPUs, never on a slot's core.
set -euo pipefail

ISOLATE_TAG="v2.7"
ISOLATE_COMMIT="8f185bb37f3f23e29b33b0c7727c91c13429abe3"
SRC_DIR="/usr/local/src/isolate"
CONFIG_FILE="/usr/local/etc/isolate"
CPU_SYSFS="${RECX_CPU_SYSFS:-/sys/devices/system/cpu}"

die() { echo "install-isolate.sh: $*" >&2; exit 1; }

PRINT_CONFIG=0
SLOT_CPUS="${RECX_SLOT_CPUS:-}"
BOX_BASE="${RECX_BOX_BASE:-0}"
MAINT_BASE="${RECX_SELFCHECK_BOX_BASE:-900}"
SLOTS="${RECJUDGE_SLOTS:-}"
for arg in "$@"; do
  case "$arg" in
    --print-config) PRINT_CONFIG=1 ;;
    --slot-cpus=*) SLOT_CPUS="${arg#*=}" ;;
    --box-base=*) BOX_BASE="${arg#*=}" ;;
    --selfcheck-box-base=*) MAINT_BASE="${arg#*=}" ;;
    --slots=*) SLOTS="${arg#*=}" ;;
    -h | --help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "unknown argument '$arg' (see --help)" ;;
  esac
done

[[ "$BOX_BASE" =~ ^[0-9]+$ ]] || die "RECX_BOX_BASE must be a non-negative integer"
[[ "$MAINT_BASE" =~ ^[0-9]+$ ]] && ((MAINT_BASE >= 300 && MAINT_BASE <= 990)) || die "RECX_SELFCHECK_BOX_BASE must be 300..990"

# ── CPU pinning plan ────────────────────────────────────────────────────────
# Expand a kernel CPU list ("0-3,8,10-11") into one id per line.
expand_cpulist() {
  local part lo hi
  IFS=',' read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    if [[ "$part" == *-* ]]; then
      lo="${part%-*}"; hi="${part#*-}"
      for ((c = lo; c <= hi; c++)); do echo "$c"; done
    else
      echo "$part"
    fi
  done
}
# Compress sorted ids back into a kernel CPU list.
compress_cpulist() {
  local out="" start="" prev="" c
  range() { if ((prev > start)); then echo "$start-$prev"; else echo "$start"; fi; }
  for c in "$@"; do
    if [[ -z "$start" ]]; then start="$c"; prev="$c"; continue; fi
    if ((c == prev + 1)); then prev="$c"; continue; fi
    out+="${out:+,}$(range)"
    start="$c"; prev="$c"
  done
  if [[ -n "$start" ]]; then out+="${out:+,}$(range)"; fi
  echo "$out"
}

PIN_CPUS=()
HOUSEKEEPING=""
if [[ -n "$SLOT_CPUS" ]]; then
  [[ "$SLOT_CPUS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "RECX_SLOT_CPUS must be a comma-separated list of CPU ids, e.g. 2,3,4,5,6,7"
  IFS=',' read -ra PIN_CPUS <<<"$SLOT_CPUS"
  [[ -n "$SLOTS" ]] || SLOTS="${#PIN_CPUS[@]}"
  ((${#PIN_CPUS[@]} == SLOTS)) || die "RECX_SLOT_CPUS lists ${#PIN_CPUS[@]} CPUs for ${SLOTS} slots: one CPU per slot"
  mapfile -t ONLINE < <(expand_cpulist "$(cat "$CPU_SYSFS/online")")
  declare -A IS_ONLINE=()
  for cpu in "${ONLINE[@]}"; do IS_ONLINE[$cpu]=1; done
  declare -A RESERVED=()
  for cpu in "${PIN_CPUS[@]}"; do
    [[ -n "${IS_ONLINE[$cpu]:-}" ]] || die "CPU $cpu is not online on this host (online: $(cat "$CPU_SYSFS/online"))"
    [[ -z "${RESERVED[$cpu]:-}" ]] || die "CPU $cpu is listed twice, or is the SMT sibling of another slot's CPU (${RESERVED[$cpu]})"
    RESERVED[$cpu]="slot CPU"
    siblings="$(cat "$CPU_SYSFS/cpu$cpu/topology/thread_siblings_list")"
    while read -r sib; do
      [[ "$sib" == "$cpu" ]] && continue
      [[ -z "${RESERVED[$sib]:-}" ]] || die "CPUs $cpu and $sib are SMT siblings of one physical core: give each slot its own core"
      RESERVED[$sib]="idle SMT sibling of CPU $cpu"
    done < <(expand_cpulist "$siblings")
  done
  keep=()
  for cpu in "${ONLINE[@]}"; do [[ -n "${RESERVED[$cpu]:-}" ]] || keep+=("$cpu"); done
  ((${#keep[@]} > 0)) || die "no housekeeping CPU left for the OS and the worker: pin fewer slots"
  HOUSEKEEPING="$(compress_cpulist "${keep[@]}")"
  if [[ " ${PIN_CPUS[*]} " == *" 0 "* ]]; then
    echo "install-isolate.sh: warning: CPU 0 handles most interrupts; prefer to leave it to housekeeping" >&2
  fi
fi
SLOTS="${SLOTS:-4}"
[[ "$SLOTS" =~ ^[0-9]+$ ]] && ((SLOTS >= 1)) || die "RECJUDGE_SLOTS must be a positive integer"
((BOX_BASE + SLOTS <= 100)) || die "RECX_BOX_BASE + slots must be <= 100 (run, compile and checker box ids must not overlap)"

# NUMA node of a CPU (only written for multi-node hosts).
numa_nodes="$(find "$CPU_SYSFS/../node" -maxdepth 1 -name 'node[0-9]*' 2>/dev/null | wc -l)"
numa_node_of() {
  local n
  for n in "$CPU_SYSFS/cpu$1"/node[0-9]*; do [[ -e "$n" ]] && { basename "$n" | sed 's/^node//'; return; }; done
  echo 0
}

# REC Code configuration: box N runs as uid/gid 60000+N, so the nftables rule
# that drops sandbox egress can match the whole 60000-60999 range.
render_config() {
  cat <<'CONF'
# Managed by infra/judge/install-isolate.sh — do not edit by hand.
box_root = /var/local/lib/isolate
lock_root = /run/isolate/locks
cg_root = auto:/run/isolate/cgroup
first_uid = 60000
first_gid = 60000
num_boxes = 1000
# All isolate syscall restrictions on (keyrings, vsock, inode locks,
# io_uring, legacy architectures).
syscall_flags = 31
CONF
  if ((${#PIN_CPUS[@]})); then
    echo "# CPU pinning (RECX_SLOT_CPUS=${SLOT_CPUS}, RECX_BOX_BASE=${BOX_BASE}): slot N's run,"
    echo "# compile and checker boxes share slot N's physical core; SMT siblings idle;"
    echo "# housekeeping CPUs ${HOUSEKEEPING}."
    local slot cpu box
    for ((slot = 0; slot < SLOTS; slot++)); do
      cpu="${PIN_CPUS[$slot]}"
      for box in $((BOX_BASE + slot)) $((BOX_BASE + 100 + slot)) $((BOX_BASE + 200 + slot)); do
        echo "box${box}.cpus = ${cpu}"
        if ((numa_nodes > 1)); then echo "box${box}.mems = $(numa_node_of "$cpu")"; fi
      done
    done
    # The self-check fixtures (a fork loop, a 4 GiB allocation, an output
    # flood) and calibration re-run every 6 h while slots are judging: keep
    # them off the slot cores.
    echo "# Maintenance boxes (RECX_SELFCHECK_BOX_BASE=${MAINT_BASE}..+9): housekeeping CPUs only."
    for ((box = MAINT_BASE; box < MAINT_BASE + 10; box++)); do
      echo "box${box}.cpus = ${HOUSEKEEPING}"
    done
  fi
}

if ((PRINT_CONFIG)); then
  render_config
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  die "must run as root (or use --print-config)"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libcap-dev libsystemd-dev \
  libseccomp-dev git ca-certificates >/dev/null

if [[ ! -d "$SRC_DIR/.git" ]]; then
  rm -rf "$SRC_DIR"
  git clone -q --depth 1 --branch "$ISOLATE_TAG" https://github.com/ioi/isolate.git "$SRC_DIR"
fi
actual="$(git -C "$SRC_DIR" rev-parse HEAD)"
if [[ "$actual" != "$ISOLATE_COMMIT" ]]; then
  echo "isolate checkout is $actual, expected $ISOLATE_COMMIT — refusing to build" >&2
  exit 1
fi

make -C "$SRC_DIR" -j"$(nproc)" isolate isolate-cg-keeper >/dev/null
make -C "$SRC_DIR" install PREFIX=/usr/local >/dev/null

render_config > "$CONFIG_FILE"
chmod 644 "$CONFIG_FILE"
isolate --check-config

install -d -m 0755 /var/local/lib/isolate

# Box root on RAM: every box (run, compile, checker for every slot) lives on a
# tmpfs, so teardown is rm -rf on RAM and nothing a submission writes ever
# reaches disk. isolate creates and rmtree()s box_root/<id> itself on every
# --init/--cleanup, so a separate tmpfs per box directory is not possible;
# the size of one box is bounded instead by --fsize per file, the box's
# memory cgroup (tmpfs pages are charged to it), and tmpfs user quotas
# (isolate --quota) on kernels built with CONFIG_TMPFS_QUOTA. See docs/JUDGE.md.
BOXES=$(( SLOTS * 3 ))
SIZE_MB=$(( BOXES * 256 ))
INODES=$(( BOXES * 4096 + 1024 ))
QUOTA_OPT=""
if grep -q "CONFIG_TMPFS_QUOTA=y" "/boot/config-$(uname -r)" 2>/dev/null; then QUOTA_OPT=",usrquota"; fi
cat > /etc/systemd/system/var-local-lib-isolate.mount <<UNIT
# Managed by infra/judge/install-isolate.sh
[Unit]
Description=RAM-backed isolate box root (REC Code judge)
Before=isolate.service

[Mount]
What=recjudge-boxes
Where=/var/local/lib/isolate
Type=tmpfs
Options=size=${SIZE_MB}m,nr_inodes=${INODES},mode=0755,uid=0,gid=0,nosuid,nodev${QUOTA_OPT}

[Install]
WantedBy=multi-user.target
UNIT

# CPU pinning, the host side: everything except isolate's own slice (the
# boxes, each confined to its slot's core by the per-box cpuset above) runs on
# the housekeeping CPUs. isolate.service lives in isolate.slice, so this does
# not constrain the boxes. Only with RECX_SLOT_CPUS (production judge hosts).
for slice in system.slice user.slice; do
  dropin="/etc/systemd/system/${slice}.d/50-recjudge-cpus.conf"
  if [[ -n "$HOUSEKEEPING" ]]; then
    install -d -m 0755 "$(dirname "$dropin")"
    printf '# Managed by infra/judge/install-isolate.sh (RECX_SLOT_CPUS=%s)\n[Slice]\nAllowedCPUs=%s\n' \
      "$SLOT_CPUS" "$HOUSEKEEPING" > "$dropin"
  else
    rm -f "$dropin"
  fi
done

if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
  systemctl enable --now var-local-lib-isolate.mount >/dev/null
  systemctl enable --now isolate.service >/dev/null
  systemctl is-active isolate.service
  findmnt -no FSTYPE,OPTIONS /var/local/lib/isolate
fi

# Synthetic /etc for boxes: a 3-line passwd so getpwuid() callers (the JVM)
# work. Nothing else from the host /etc is ever visible inside a box.
install -d -m 0755 /var/lib/recjudge/etc
cat > /var/lib/recjudge/etc/passwd <<'PASSWD'
root:x:0:0:root:/root:/usr/sbin/nologin
box:x:60000:60000:sandbox:/box:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
PASSWD
chmod 0644 /var/lib/recjudge/etc/passwd
if [[ -n "$HOUSEKEEPING" ]]; then
  echo "CPU pinning: slots ${SLOT_CPUS} (one physical core each), housekeeping CPUs ${HOUSEKEEPING}"
fi
isolate --version | head -1
