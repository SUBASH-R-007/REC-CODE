#!/usr/bin/env bash
# Install the pinned PyPy into /opt/toolchains/pypy-7.3.17 (pypy310:
# PyPy 7.3.17, Python 3.10 language level). No third-party packages: the
# standard library only.
#
# Source: the official portable linux64 build on downloads.python.org/pypy.
# Its sha256 is pinned below AND cross-checked against the checksum PyPy
# publishes on https://pypy.org/checksums.html.
#
# The standard library is byte-compiled once here: a box runs with -B and a
# read-only toolchain, so nothing is ever compiled (or written) at run time.
#
# Idempotent; run as root.
set -euo pipefail

ID="pypy-7.3.17"
VERSION="7.3.17"
PREFIX="/opt/toolchains/${ID}"
TARBALL="pypy3.10-v${VERSION}-linux64.tar.bz2"
URL="https://downloads.python.org/pypy/${TARBALL}"
CHECKSUMS_URL="https://pypy.org/checksums.html"
# PyPy's published value (checksums.html), pinned 2026-10-10.
SHA256="fdcdb9b24f1a7726003586503fdeb264fd68fc37fbfcea022dcfe825a7fee18b"

if [[ $EUID -ne 0 ]]; then
  echo "install-pypy.sh must run as root" >&2
  exit 1
fi

installed() {
  [[ -x "$PREFIX/bin/pypy3" ]] &&
    "$PREFIX/bin/pypy3" -c "import sys; assert sys.pypy_version_info[:3] == (7, 3, 17) and sys.version_info[:2] == (3, 10)" 2>/dev/null
}
if installed; then
  echo "pypy ${VERSION} already installed at ${PREFIX}"
  exit 0
fi

need=()
command -v curl >/dev/null || need+=(curl)
command -v bzip2 >/dev/null || need+=(bzip2)
[[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
if ((${#need[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${need[@]}" >/dev/null
fi

mkdir -p /opt/toolchains
work="$(mktemp -d /var/tmp/pypy-install.XXXXXX)"
stage="$(mktemp -d /opt/toolchains/.staging-pypy.XXXXXX)"
trap 'rm -rf "$work" "$stage"' EXIT

fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
fetch "$URL" "$work/$TARBALL"
fetch "$CHECKSUMS_URL" "$work/checksums.html"
if ! grep -q "${SHA256}  ${TARBALL}" "$work/checksums.html"; then
  echo "pypy.org/checksums.html does not list ${SHA256} for ${TARBALL}: refusing" >&2
  exit 1
fi
echo "${SHA256}  $work/${TARBALL}" | sha256sum -c -

tar -xjf "$work/$TARBALL" -C "$stage" --strip-components=1 --no-same-owner
# Byte-compile the standard library (the box never writes .pyc files).
"$stage/bin/pypy3" -m compileall -q -j 0 "$stage/lib/pypy3.10" >/dev/null || true
printf 'source=%s\nsha256=%s\n' "$URL" "$SHA256" > "$stage/.recx-provenance"

chown -R root:root "$stage"
chmod -R a-w,a+rX "$stage"
rm -rf "$PREFIX"
mv -T "$stage" "$PREFIX"

installed || { echo "pypy at ${PREFIX} does not report ${VERSION} / Python 3.10" >&2; exit 1; }
"$PREFIX/bin/pypy3" -c "import sys; print('pypy', '.'.join(map(str, sys.pypy_version_info[:3])), 'python', sys.version.split()[0])"
