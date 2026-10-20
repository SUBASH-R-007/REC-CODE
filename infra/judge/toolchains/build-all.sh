#!/usr/bin/env bash
# Build or install every pinned toolchain under /opt/toolchains. Each step is
# idempotent (an installed, verified toolchain is skipped). Logs to
# /var/tmp/build-<name>.log. Run as root.
#
#   sudo bash infra/judge/toolchains/build-all.sh            # everything
#   sudo bash infra/judge/toolchains/build-all.sh node go    # selected steps
#
# Built from GPG-verified sources: gcc (C17, C++17, C++20) + its precompiled
# <bits/stdc++.h>, cpython (+ numpy). Installed from checksum-verified vendor
# releases: temurin (Java 21, and the JVM for Kotlin), kotlin, pypy, node, go,
# and the testlib checker library. Then: verify-toolchains.sh.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# Order matters: gcc-pch needs gcc; kotlin needs temurin.
STEPS=(cpython gcc gcc-pch temurin kotlin pypy node go testlib)
declare -A SCRIPT=(
  [cpython]=build-cpython.sh
  [gcc]=build-gcc.sh
  [gcc-pch]=build-gcc-pch.sh
  [temurin]=install-temurin.sh
  [kotlin]=install-kotlin.sh
  [pypy]=install-pypy.sh
  [node]=install-node.sh
  [go]=install-go.sh
  [testlib]=install-testlib.sh
)

selected=("$@")
if ((${#selected[@]} == 0)); then selected=("${STEPS[@]}"); fi
for name in "${selected[@]}"; do
  if [[ -z "${SCRIPT[$name]:-}" ]]; then
    echo "unknown step '${name}' (steps: ${STEPS[*]})" >&2
    exit 2
  fi
done

status=0
for name in "${STEPS[@]}"; do
  [[ " ${selected[*]} " == *" ${name} "* ]] || continue
  tmp="/tmp/build-${name}.sh"
  sed 's/\r$//' "$here/${SCRIPT[$name]}" > "$tmp"
  if nice -n 5 bash "$tmp" > "/var/tmp/build-${name}.log" 2>&1; then
    echo "${name}: ok — $(tail -1 "/var/tmp/build-${name}.log")"
  else
    echo "${name}: FAILED (see /var/tmp/build-${name}.log)"
    tail -20 "/var/tmp/build-${name}.log"
    status=1
  fi
  rm -f "$tmp"
done
exit $status
