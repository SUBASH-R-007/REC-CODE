#!/usr/bin/env bash
# Install the pinned Node.js runtime into /opt/toolchains/node-22.11.0 (node22).
#
# This is the toolchain student JavaScript runs on, not the Node.js the judge
# worker itself runs on (that one lives at /opt/node22 on a judge host).
#
# Source: the official nodejs.org linux-x64 tarball. Its sha256 is pinned
# below AND cross-checked against the release's SHASUMS256.txt.
#
# npm, npx and corepack are removed: submissions run offline and may use the
# built-in modules only, exactly like CPython without pip.
#
# Idempotent; run as root.
set -euo pipefail

ID="node-22.11.0"
VERSION="22.11.0"
PREFIX="/opt/toolchains/${ID}"
TARBALL="node-v${VERSION}-linux-x64.tar.xz"
BASE="https://nodejs.org/dist/v${VERSION}"
# nodejs.org's published value (SHASUMS256.txt), pinned 2026-10-10.
SHA256="83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72"

if [[ $EUID -ne 0 ]]; then
  echo "install-node.sh must run as root" >&2
  exit 1
fi

installed() {
  [[ -x "$PREFIX/bin/node" ]] && [[ "$("$PREFIX/bin/node" --version 2>/dev/null)" == "v${VERSION}" ]]
}
if installed; then
  echo "node ${VERSION} already installed at ${PREFIX}"
  exit 0
fi

need=()
command -v curl >/dev/null || need+=(curl)
command -v xz >/dev/null || need+=(xz-utils)
[[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
if ((${#need[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${need[@]}" >/dev/null
fi

mkdir -p /opt/toolchains
work="$(mktemp -d /var/tmp/node-install.XXXXXX)"
stage="$(mktemp -d /opt/toolchains/.staging-node.XXXXXX)"
trap 'rm -rf "$work" "$stage"' EXIT

fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
fetch "${BASE}/${TARBALL}" "$work/$TARBALL"
fetch "${BASE}/SHASUMS256.txt" "$work/SHASUMS256.txt"
published="$(awk -v f="$TARBALL" '$2 == f {print $1}' "$work/SHASUMS256.txt")"
if [[ "$published" != "$SHA256" ]]; then
  echo "SHASUMS256.txt lists '${published}' for ${TARBALL}, pinned ${SHA256}: refusing" >&2
  exit 1
fi
echo "${SHA256}  $work/${TARBALL}" | sha256sum -c -

tar -xJf "$work/$TARBALL" -C "$stage" --strip-components=1 --no-same-owner
rm -rf "$stage/bin/npm" "$stage/bin/npx" "$stage/bin/corepack" \
  "$stage/lib/node_modules" "$stage/include" "$stage/share"
printf 'source=%s\nsha256=%s\n' "${BASE}/${TARBALL}" "$SHA256" > "$stage/.recx-provenance"

chown -R root:root "$stage"
chmod -R a-w,a+rX "$stage"
rm -rf "$PREFIX"
mv -T "$stage" "$PREFIX"

installed || { echo "node at ${PREFIX} does not report v${VERSION}" >&2; exit 1; }
echo "node $("$PREFIX/bin/node" --version) at ${PREFIX}"
