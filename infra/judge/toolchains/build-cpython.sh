#!/usr/bin/env bash
# Build the pinned CPython toolchain into /opt/toolchains/cpython-3.12.6 with
# numpy 1.26.4 — the only third-party package offered. Compilation and runs
# are offline, so everything a submission may import is vendored here.
#
# Run as root on a judge host (or the Linux dev box). ~5 min on 8+ cores.
set -euo pipefail

VERSION="3.12.6"
NUMPY="1.26.4"
PREFIX="/opt/toolchains/cpython-${VERSION}"
TARBALL="Python-${VERSION}.tar.xz"
URL="https://www.python.org/ftp/python/${VERSION}/${TARBALL}"
# Pinned after the first download from python.org over HTTPS (2026-10-10).
SHA256="1999658298cf2fb837dffed8ff3c033ef0c98ef20cf73c5d5f66bed5ab89697c"

if [[ -x "$PREFIX/bin/python3" ]] && "$PREFIX/bin/python3" -c "import numpy,sys; assert sys.version.startswith('${VERSION}') and numpy.__version__=='${NUMPY}'" 2>/dev/null; then
  echo "cpython ${VERSION} + numpy ${NUMPY} already installed at ${PREFIX}"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential libffi-dev libssl-dev zlib1g-dev libbz2-dev \
  liblzma-dev libsqlite3-dev curl xz-utils gnupg >/dev/null

work="$(mktemp -d /var/tmp/cpython-build.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSLO "$URL"
curl -fsSLO "${URL}.asc"
# Release manager for 3.12: Thomas Wouters.
RM_FPR="7169605F62C751356D054A26A821E680E5FA6305"
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
curl -fsSL "https://keys.openpgp.org/vks/v1/by-fingerprint/${RM_FPR}" | gpg --batch --quiet --import
gpg --batch --status-fd 1 --verify "${TARBALL}.asc" "$TARBALL" 2>/dev/null | grep -q "VALIDSIG ${RM_FPR}"
echo "${SHA256}  ${TARBALL}" | sha256sum -c -
tar -xJf "$TARBALL"
cd "Python-${VERSION}"
./configure --prefix="$PREFIX" --without-ensurepip --disable-test-modules >/dev/null
make -j"$(nproc)" >/dev/null
make install >/dev/null

# pip only to vendor numpy, then remove it: nothing can be installed at runtime.
curl -fsSL -o get-pip.py https://bootstrap.pypa.io/get-pip.py
"$PREFIX/bin/python3" get-pip.py --no-cache-dir --no-warn-script-location -q
"$PREFIX/bin/python3" -m pip install --no-cache-dir -q --only-binary=:all: "numpy==${NUMPY}"
"$PREFIX/bin/python3" -m pip uninstall -y -q pip setuptools wheel >/dev/null 2>&1 || true
find "$PREFIX" -name '__pycache__' -type d -prune -exec rm -rf {} +
"$PREFIX/bin/python3" -m compileall -q "$PREFIX/lib/python3.12" >/dev/null || true

chown -R root:root "$PREFIX"
chmod -R a-w,a+rX "$PREFIX"
"$PREFIX/bin/python3" -c "import sys, numpy; print(sys.version.split()[0], 'numpy', numpy.__version__)"
