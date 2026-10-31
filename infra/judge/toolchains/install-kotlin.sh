#!/usr/bin/env bash
# Install the pinned Kotlin compiler into /opt/toolchains/kotlin-2.0.21
# (kotlin20). Kotlin compiles and runs on the pinned Temurin JDK, so
# install-temurin.sh must have run first; a box judging Kotlin binds both
# directories read-only.
#
# Source: the official JetBrains GitHub release zip. Its sha256 is pinned
# below AND cross-checked against the .sha256 JetBrains publishes next to it.
#
# Idempotent; run as root.
set -euo pipefail

ID="kotlin-2.0.21"
VERSION="2.0.21"
PREFIX="/opt/toolchains/${ID}"
JDK="/opt/toolchains/temurin-21.0.4+7"
ZIP="kotlin-compiler-${VERSION}.zip"
URL="https://github.com/JetBrains/kotlin/releases/download/v${VERSION}/${ZIP}"
# JetBrains' published value (${ZIP}.sha256), pinned 2026-10-10.
SHA256="0352c0a45bd22f80f6b26e485cd04da8047baa5de54865281fb9f89a4a7bcf2a"

if [[ $EUID -ne 0 ]]; then
  echo "install-kotlin.sh must run as root" >&2
  exit 1
fi
if [[ ! -x "$JDK/bin/java" ]]; then
  echo "Kotlin needs the pinned JDK at ${JDK}: run install-temurin.sh first" >&2
  exit 1
fi

kotlinc_version() {
  JAVA_HOME="$JDK" PATH="$PREFIX/bin:$JDK/bin:/usr/bin:/bin" "$PREFIX/bin/kotlinc" -version 2>&1
}
installed() {
  [[ -x "$PREFIX/bin/kotlinc" && -f "$PREFIX/lib/kotlin-stdlib.jar" ]] && kotlinc_version | grep -q "kotlinc-jvm ${VERSION} "
}
if installed; then
  echo "kotlin ${VERSION} already installed at ${PREFIX}"
  exit 0
fi

need=()
command -v curl >/dev/null || need+=(curl)
command -v unzip >/dev/null || need+=(unzip)
[[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
if ((${#need[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${need[@]}" >/dev/null
fi

mkdir -p /opt/toolchains
work="$(mktemp -d /var/tmp/kotlin-install.XXXXXX)"
stage="$(mktemp -d /opt/toolchains/.staging-kotlin.XXXXXX)"
trap 'rm -rf "$work" "$stage"' EXIT

fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
fetch "$URL" "$work/$ZIP"
fetch "${URL}.sha256" "$work/published.sha256"
published="$(awk '{print $1; exit}' "$work/published.sha256")"
if [[ "$published" != "$SHA256" ]]; then
  echo "JetBrains publishes sha256 ${published} for ${ZIP}, pinned ${SHA256}: refusing" >&2
  exit 1
fi
echo "${SHA256}  $work/${ZIP}" | sha256sum -c -

unzip -q "$work/$ZIP" -d "$work/unpacked"
[[ -x "$work/unpacked/kotlinc/bin/kotlinc" ]] || { echo "unexpected layout in ${ZIP}" >&2; exit 1; }
cp -a "$work/unpacked/kotlinc/." "$stage/"
rm -f "$stage"/bin/*.bat
printf 'source=%s\nsha256=%s\njdk=%s\n' "$URL" "$SHA256" "$JDK" > "$stage/.recx-provenance"

chown -R root:root "$stage"
chmod -R a-w,a+rX "$stage"
rm -rf "$PREFIX"
mv -T "$stage" "$PREFIX"

installed || { echo "kotlinc at ${PREFIX} does not report ${VERSION}: $(kotlinc_version)" >&2; exit 1; }
kotlinc_version | head -1
