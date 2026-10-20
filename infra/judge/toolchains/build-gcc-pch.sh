#!/usr/bin/env bash
# Precompile <bits/stdc++.h> into the pinned GCC toolchain, once per language
# flag set in the catalog (packages/shared/src/languages.ts). Every FUNCTION-
# mode C++ program includes it, and parsing it dominates compile time (2-7 s
# CPU at -O2 on a loaded host, against a 10 s compile cap). GCC picks a
# matching file from the stdc++.h.gch/ directory automatically and silently
# ignores any whose flags do not match, so this only ever speeds a compile up.
#
# Part of building the toolchain image; run as root after build-gcc.sh.
set -euo pipefail

PREFIX="/opt/toolchains/gcc-13.2.0"
GXX="$PREFIX/bin/g++"
HEADER="$PREFIX/include/c++/13.2.0/$("$GXX" -dumpmachine)/bits/stdc++.h"
[[ -f "$HEADER" ]] || { echo "stdc++.h not found at $HEADER" >&2; exit 1; }
GCH_DIR="${HEADER}.gch"

# Flag sets must match LANGUAGE_CATALOG exactly for every option that affects
# preprocessing / code generation (-std, -O). Link-only flags do not matter.
declare -A FLAGSETS=(
  [cpp17]="-std=c++17 -O2"
  [cpp20]="-std=c++20 -O2"
)

chmod u+w "$(dirname "$HEADER")"
mkdir -p "$GCH_DIR"
for name in "${!FLAGSETS[@]}"; do
  # shellcheck disable=SC2086
  "$GXX" ${FLAGSETS[$name]} -x c++-header "$HEADER" -o "$GCH_DIR/$name.gch"
done
chown -R root:root "$GCH_DIR"
chmod -R a-w,a+rX "$GCH_DIR" "$(dirname "$HEADER")"

# Prove the precompiled header is actually picked up for each flag set.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
printf '#include <bits/stdc++.h>\nint main(){std::vector<int> v{1};return v[0]-1;}\n' > "$probe/m.cpp"
for name in "${!FLAGSETS[@]}"; do
  # Capture first: `grep -q` would close the pipe early and, under pipefail,
  # g++'s resulting SIGPIPE would read as a failure.
  # shellcheck disable=SC2086
  trace="$("$GXX" ${FLAGSETS[$name]} -H -fsyntax-only "$probe/m.cpp" 2>&1)"
  if ! grep -q "^! .*${name}.gch" <<<"$trace"; then
    echo "PCH for $name was not used" >&2
    exit 1
  fi
done
ls -la "$GCH_DIR"
