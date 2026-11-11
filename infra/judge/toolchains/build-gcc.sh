#!/usr/bin/env bash
# Build the pinned GCC toolchain into /opt/toolchains/gcc-13.2.0 (c17, cpp17,
# cpp20). Built from the GNU release tarball, GPG-verified against the GNU
# keyring. A toolchain upgrade is a NEW directory + a NEW LanguageConfig row,
# never an in-place rebuild of this one.
#
# Run as root on a judge host (or the Linux dev box). ~15-25 min on 8+ cores.
set -euo pipefail

VERSION="13.2.0"
PREFIX="/opt/toolchains/gcc-${VERSION}"
BASE="https://ftp.gnu.org/gnu/gcc/gcc-${VERSION}"
TARBALL="gcc-${VERSION}.tar.xz"
# Pinned after the first GPG-verified download (2026-10-10). A mismatch means
# the upstream artifact changed — stop and investigate.
SHA256="e275e76442a6067341a27f04c5c6b83d8613144004c0413528863dc6b5c743da"

if [[ -x "$PREFIX/bin/g++" ]] && "$PREFIX/bin/g++" --version | head -1 | grep -q " ${VERSION}"; then
  echo "gcc ${VERSION} already installed at ${PREFIX}"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential libgmp-dev libmpfr-dev libmpc-dev flex bison \
  gnupg curl xz-utils libc6-dev >/dev/null

work="$(mktemp -d /var/tmp/gcc-build.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSLO "${BASE}/${TARBALL}"
curl -fsSLO "${BASE}/${TARBALL}.sig"
curl -fsSL -o gnu-keyring.gpg https://ftp.gnu.org/gnu/gnu-keyring.gpg
gpgv --keyring ./gnu-keyring.gpg "${TARBALL}.sig" "${TARBALL}"
echo "${SHA256}  ${TARBALL}" | sha256sum -c -

tar -xJf "$TARBALL"
mkdir build && cd build
"../gcc-${VERSION}/configure" \
  --prefix="$PREFIX" \
  --enable-languages=c,c++ \
  --disable-multilib \
  --disable-bootstrap \
  --disable-nls \
  --disable-libsanitizer \
  --enable-static \
  --with-pkgversion="REC Code judge" >/dev/null
make -j"$(nproc)" >/dev/null
make install-strip >/dev/null

chown -R root:root "$PREFIX"
chmod -R a-w,a+rX "$PREFIX"
"$PREFIX/bin/g++" --version | head -1
