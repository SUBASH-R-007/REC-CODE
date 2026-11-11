#!/usr/bin/env bash
# Vendor the pinned testlib (checker / validator library) into
# /opt/toolchains/testlib-0.9.41/testlib.h.
#
# testlibId "testlib-0.9.41" is what ProblemVersion.testlibId and the judge
# protocol's checker.testlibId carry; the worker binds this directory
# read-only into the checker's compile box. Checkers compile with the pinned
# GCC as C++20 (protocol: checker.language = "cpp20").
#
# Source: github.com/MikeMirzayanov/testlib, release tag 0.9.41 =
# commit 68f9f300b6abebec82d2a68d8ca04394f2664fb6 (tag -> commit checked via
# the GitHub API when pinned). The files are fetched by commit, never by a
# moving tag or branch, and each must match its pinned sha256.
#
# Idempotent; run as root.
set -euo pipefail

VERSION="0.9.41"
ID="testlib-${VERSION}"
COMMIT="68f9f300b6abebec82d2a68d8ca04394f2664fb6"
PREFIX="/opt/toolchains/${ID}"
BASE="https://raw.githubusercontent.com/MikeMirzayanov/testlib/${COMMIT}"
# sha256 of each file at that commit, pinned 2026-10-10.
declare -A FILES=(
  [testlib.h]="70f74c570f2b45d63086ae6e4c41bbb5c5ffd4428cba9914bbc0396d29be10d8"
  [LICENSE]="edf4e4b144f24cc4d8070b7a18d700f9429e850f3353736dd628a0a3cacff6c9"
)

if [[ $EUID -ne 0 ]]; then
  echo "install-testlib.sh must run as root" >&2
  exit 1
fi

installed() {
  local name
  for name in "${!FILES[@]}"; do
    [[ -f "$PREFIX/$name" ]] || return 1
    [[ "$(sha256sum "$PREFIX/$name" | cut -d' ' -f1)" == "${FILES[$name]}" ]] || return 1
  done
  grep -q "^#define VERSION \"${VERSION}\"" "$PREFIX/testlib.h"
}
if installed; then
  echo "testlib ${VERSION} already installed at ${PREFIX}"
  exit 0
fi

if ! command -v curl >/dev/null || [[ ! -e /etc/ssl/certs/ca-certificates.crt ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates >/dev/null
fi

mkdir -p /opt/toolchains
stage="$(mktemp -d /opt/toolchains/.staging-testlib.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
for name in "${!FILES[@]}"; do
  curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$stage/$name" "${BASE}/${name}"
  echo "${FILES[$name]}  $stage/$name" | sha256sum -c -
done
printf 'source=https://github.com/MikeMirzayanov/testlib\ntag=%s\ncommit=%s\n' "$VERSION" "$COMMIT" > "$stage/.recx-provenance"

chown -R root:root "$stage"
chmod -R a-w,a+rX "$stage"
rm -rf "$PREFIX"
mv -T "$stage" "$PREFIX"

installed || { echo "testlib at ${PREFIX} failed verification" >&2; exit 1; }
echo "testlib ${VERSION} (commit ${COMMIT:0:12}) at ${PREFIX}"
