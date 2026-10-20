#!/usr/bin/env bash
# Install the pinned Go toolchain into /opt/toolchains/go-1.23.2 (go123).
#
# Source: the official go.dev/dl linux-amd64 tarball. Its sha256 is pinned
# below AND cross-checked against the sha256 go.dev publishes for it
# (https://go.dev/dl/?mode=json&include=all).
#
# Submissions build with CGO_ENABLED=0, GO111MODULE=off and GOMAXPROCS=1 (the
# catalog's environment). The toolchain's own defaults file ($GOROOT/go.env)
# is rewritten so the go command can never try the network: no module proxy,
# no checksum database, no toolchain download (GOTOOLCHAIN=local).
#
# Prebuilt standard library + bin/recx-go-build. `go build` cannot work in a
# judge box: it needs flock() on its build cache (isolate syscall_flags bit 4
# blocks every file lock, so the build dies with "failed to trim cache"), and
# a fresh box has a cold cache, so every compile would rebuild the standard
# library (~7 s CPU, 280 MB — measured in a box). This script therefore also
# compiles the standard library once, here (-trimpath, CGO_ENABLED=0), into
# pkg/linux_amd64, writes pkg/recx-importcfg naming every archive, and
# installs bin/recx-go-build, which turns /box/main.go into /box/main with
# `go tool compile` + `go tool link` alone: no cache, no lock, ~0.1 s CPU.
# The catalog's go123 compile argv must call it (docs/JUDGE.md §7).
#
# Idempotent; run as root.
set -euo pipefail

ID="go-1.23.2"
VERSION="1.23.2"
PREFIX="/opt/toolchains/${ID}"
TARBALL="go${VERSION}.linux-amd64.tar.gz"
URL="https://go.dev/dl/${TARBALL}"
RELEASES_URL="https://go.dev/dl/?mode=json&include=all"
# go.dev's published value, pinned 2026-10-10.
SHA256="542d3c1705f1c6a1c5a80d5dc62e2e45171af291e755d591c5e6531ef63b454e"

if [[ $EUID -ne 0 ]]; then
  echo "install-go.sh must run as root" >&2
  exit 1
fi

installed() {
  [[ -x "$PREFIX/bin/go" && -x "$PREFIX/bin/recx-go-build" && -f "$PREFIX/pkg/recx-importcfg" ]] &&
    [[ -f "$PREFIX/pkg/linux_amd64/fmt.a" ]] &&
    [[ "$(GOROOT="$PREFIX" GOTOOLCHAIN=local "$PREFIX/bin/go" env GOVERSION 2>/dev/null)" == "go${VERSION}" ]] &&
    grep -qx "GOTOOLCHAIN=local" "$PREFIX/go.env"
}
if installed; then
  echo "go ${VERSION} already installed at ${PREFIX}"
  exit 0
fi

need=()
command -v curl >/dev/null || need+=(curl)
[[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
if ((${#need[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${need[@]}" >/dev/null
fi

mkdir -p /opt/toolchains
work="$(mktemp -d /var/tmp/go-install.XXXXXX)"
stage="$(mktemp -d /opt/toolchains/.staging-go.XXXXXX)"
trap 'rm -rf "$work" "$stage"' EXIT

fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
fetch "$URL" "$work/$TARBALL"
fetch "$RELEASES_URL" "$work/releases.json"
# The release index is one JSON document; the pinned file's entry carries
# "filename": "<tarball>", …, "sha256": "<hex>". Plain text search, no jq.
if ! tr -d ' \n' < "$work/releases.json" | grep -q "\"filename\":\"${TARBALL}\",\"os\":\"linux\",\"arch\":\"amd64\",\"version\":\"go${VERSION}\",\"sha256\":\"${SHA256}\""; then
  echo "go.dev does not publish sha256 ${SHA256} for ${TARBALL}: refusing" >&2
  exit 1
fi
echo "${SHA256}  $work/${TARBALL}" | sha256sum -c -

tar -xzf "$work/$TARBALL" -C "$stage" --strip-components=1 --no-same-owner
cat > "$stage/go.env" <<'GOENV'
# REC Code judge toolchain (infra/judge/toolchains/install-go.sh): replaces
# the upstream defaults so the go command never reaches for the network.
# Submissions build offline, with the standard library only.
GOPROXY=off
GOSUMDB=off
GOTOOLCHAIN=local
GOENV

# The standard library, compiled once. -trimpath keeps the staging path out of
# the archives, so they are valid after the rename below.
GOROOT="$stage" GOCACHE="$work/gocache" GOPATH="$work/gopath" GOTOOLCHAIN=local GOFLAGS= \
  CGO_ENABLED=0 GO111MODULE=off GODEBUG=installgoroot=all \
  "$stage/bin/go" install -trimpath std
(cd "$stage/pkg/linux_amd64" && find . -name '*.a' | LC_ALL=C sort | sed -e 's|^\./||' -e 's|\.a$||') |
  while read -r pkg; do
    printf 'packagefile %s=%s/pkg/linux_amd64/%s.a\n' "$pkg" "$PREFIX" "$pkg"
  done > "$stage/pkg/recx-importcfg"
cat > "$stage/bin/recx-go-build" <<SH
#!/bin/sh
# REC Code judge (infra/judge/toolchains/install-go.sh): build main.go into
# main in the current directory, offline, against the prebuilt standard
# library. Equivalent of "go build -trimpath -o main main.go" with
# CGO_ENABLED=0 in GOPATH mode, minus the go command's build cache (which
# needs file locks the judge sandbox blocks, and would rebuild the standard
# library in every fresh box). -complete: a function without a body is a
# compile error, as with go build (there is no assembly).
set -e
tool="${PREFIX}/pkg/tool/linux_amd64"
cfg="${PREFIX}/pkg/recx-importcfg"
"\$tool/compile" -o main.a -p main -complete -trimpath=/box -importcfg "\$cfg" -pack main.go
"\$tool/link" -o main -importcfg "\$cfg" -buildmode=exe main.a
rm -f main.a
SH
chmod 0755 "$stage/bin/recx-go-build"
printf 'source=%s\nsha256=%s\nmodified=go.env\nadded=pkg/linux_amd64 (std, -trimpath, CGO_ENABLED=0) pkg/recx-importcfg bin/recx-go-build\n' \
  "$URL" "$SHA256" > "$stage/.recx-provenance"

chown -R root:root "$stage"
chmod -R a-w,a+rX "$stage"
rm -rf "$PREFIX"
mv -T "$stage" "$PREFIX"

installed || { echo "go at ${PREFIX} does not report go${VERSION}" >&2; exit 1; }
# Prove the prebuilt build path end to end (outside a box; verify-toolchains.sh does it inside one).
probe="$work/probe"
mkdir -p "$probe"
printf 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("ok") }\n' > "$probe/main.go"
(cd "$probe" && GOMAXPROCS=1 "$PREFIX/bin/recx-go-build" && [[ "$(./main)" == "ok" ]])
echo "go $(GOROOT="$PREFIX" "$PREFIX/bin/go" env GOVERSION) at ${PREFIX}; std prebuilt ($(wc -l < "$PREFIX/pkg/recx-importcfg") packages)"
