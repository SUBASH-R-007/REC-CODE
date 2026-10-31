#!/usr/bin/env bash
# Verify a judge host's kernel hardening before it runs student code.
#
#   sudo bash infra/judge/verify-host.sh
#
# Prints every required setting with its expected and actual value and exits
# non-zero if any is wrong, missing or unreadable. recjudge-worker.service runs
# it (as root) before every start, so a host that drifted, or one whose kernel
# lacks a required knob, never claims a job. The worker's own in-process boot
# verification (sandbox self-checks reported in heartbeats) arrives in Phase 2.
#
# Keep REQUIRED in step with infra/judge/sysctl/99-recjudge.conf. The last
# entry, kernel.modules_disabled, is not in that file: it is one-way and is
# set late in boot by recjudge-modules-lock.service (see the sysctl file).
#
# Reads /proc/sys directly (no procps dependency). Run as root:
# net.core.bpf_jit_harden is mode 0600.
set -uo pipefail

REQUIRED=(
  "kernel.unprivileged_userns_clone=0"
  "kernel.unprivileged_bpf_disabled=2"
  "net.core.bpf_jit_harden=2"
  "kernel.io_uring_disabled=2"
  "kernel.dmesg_restrict=1"
  "kernel.kptr_restrict=2"
  "kernel.perf_event_paranoid=3"
  "kernel.yama.ptrace_scope=3"
  "vm.unprivileged_userfaultfd=0"
  "fs.protected_symlinks=1"
  "fs.protected_hardlinks=1"
  "fs.suid_dumpable=0"
  "kernel.core_pattern=|/bin/false"
  "kernel.modules_disabled=1"
)

echo "REC Code judge host verification - $(hostname 2>/dev/null || echo unknown), kernel $(uname -r)"
printf '%-34s %-13s %-13s %s\n' "SETTING" "EXPECTED" "ACTUAL" "RESULT"

failures=0
for entry in "${REQUIRED[@]}"; do
  key="${entry%%=*}"
  want="${entry#*=}"
  path="/proc/sys/${key//.//}"
  note=""
  if [[ ! -e "$path" ]]; then
    actual="(missing)"
    note="  this kernel has no such setting"
  elif ! actual="$(cat "$path" 2>/dev/null)"; then
    actual="(unreadable)"
    note="  run as root"
  else
    # Single-value knobs only; trim surrounding whitespace.
    actual="${actual#"${actual%%[![:space:]]*}"}"
    actual="${actual%"${actual##*[![:space:]]}"}"
  fi

  if [[ "$actual" == "$want" ]]; then
    result="PASS"
  else
    result="FAIL"
    failures=$((failures + 1))
    if [[ "$key" == "kernel.modules_disabled" && "$actual" == "0" ]]; then
      note="  set late in boot by recjudge-modules-lock.service"
    fi
  fi
  printf '%-34s %-13s %-13s %s%s\n' "$key" "$want" "$actual" "$result" "$note"
done

if (( failures > 0 )); then
  echo "FAILED: ${failures} of ${#REQUIRED[@]} settings are wrong. This host must not run student code." >&2
  exit 1
fi
echo "OK: all ${#REQUIRED[@]} settings verified."
