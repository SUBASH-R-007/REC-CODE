#!/usr/bin/env bash
# Install the pinned Rust toolchain into /opt/toolchains/rust-1.80.0 (rust180).
#
# Source: the official static.rust-lang.org tarball for the stable release,
# whose sha256 is pinned below AND cross-checked against the .sha256 file
# static.rust-lang.org publishes beside it. No rustup, no network at judge
# time, no cargo: a submission is ONE file compiled by rustc, which is the
# only shape that works in a box with no writable home and no file locks.
#
# What is installed, and what is removed:
#
#   * rustc, the standard library (rlibs + its source for diagnostics) and
#     the LLVM tools rustc needs, from the `rustc` and `rust-std` components;
#   * cargo, rustup, rustfmt, clippy, the docs and the self-updater are NOT
#     installed — nothing in the judge path uses them, and cargo would want
#     a writable CARGO_HOME and a network it will never have.
#
# The catalog (packages/shared/src/languages.ts, rust180) compiles with
#   rustc --edition 2021 -O -C target-feature=+crt-static \
#         -C linker=/opt/toolchains/gcc-13.2.0/bin/gcc -C codegen-units=1 \
#         -o main main.rs
# so this script checks, at install time, that exactly that command produces
# a STATIC binary — the box mounts the toolchain read-only and nothing else,
# so a dynamically linked program could not find libc at all. gcc-13.2.0 must
# already be installed: rustc links through a C compiler, and the box has no
# system one (docs/JUDGE.md §7).
#
# Idempotent; run as root.
set -euo pipefail

ID="rust-1.80.0"
VERSION="1.80.0"
PREFIX="/opt/toolchains/${ID}"
GCC="/opt/toolchains/gcc-13.2.0"
TRIPLE="x86_64-unknown-linux-gnu"
TARBALL="rust-${VERSION}-${TRIPLE}.tar.gz"
URL="https://static.rust-lang.org/dist/${TARBALL}"
# static.rust-lang.org's published value for rust-1.80.0-x86_64-unknown-linux-gnu.tar.gz.
SHA256="702d3b60816eb9410c84947895c0188e20f588cb91b3aee8d84cec23ddb63582"

if [[ $EUID -ne 0 ]]; then
  echo "install-rust.sh must run as root" >&2
  exit 1
fi

if [[ ! -x "${GCC}/bin/gcc" ]]; then
  echo "install-rust.sh needs ${GCC}/bin/gcc (rustc links through it): run build-gcc.sh first" >&2
  exit 1
fi

if [[ -x "${PREFIX}/bin/rustc" ]]; then
  have="$("${PREFIX}/bin/rustc" --version | awk '{print $2}')"
  if [[ "$have" == "$VERSION" ]]; then
    echo "rust ${VERSION} already installed at ${PREFIX}"
    exit 0
  fi
  echo "refusing to overwrite ${PREFIX}: it holds rustc ${have}, not ${VERSION}" >&2
  exit 1
fi

work="$(mktemp -d /var/tmp/recx-rust.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cd "$work"

echo "downloading ${URL}"
curl -fsSL -o "$TARBALL" "$URL"
# The publisher's own checksum, fetched now, must agree with the pin above:
# a mirror that served different bytes fails here rather than at a student's
# first submission.
curl -fsSL -o "${TARBALL}.sha256" "${URL}.sha256"
published="$(awk '{print $1}' "${TARBALL}.sha256")"
actual="$(sha256sum "$TARBALL" | awk '{print $1}')"
if [[ "$actual" != "$published" ]]; then
  echo "sha256 mismatch against static.rust-lang.org: got ${actual}, published ${published}" >&2
  exit 1
fi
if [[ "$actual" != "$SHA256" ]]; then
  echo "sha256 mismatch against the pin in this script: got ${actual}, pinned ${SHA256}" >&2
  echo "if this is a deliberate re-pin, change SHA256 in install-rust.sh in the same commit" >&2
  exit 1
fi

tar -xzf "$TARBALL"
src="rust-${VERSION}-${TRIPLE}"
# The installer's own components, not `./install.sh --components=…`: that
# script writes an uninstaller and a manifest into the prefix, neither of
# which a judge host should carry.
mkdir -p "$PREFIX"
for component in rustc rust-std-${TRIPLE}; do
  [[ -d "${src}/${component}" ]] || { echo "component ${component} missing from the tarball" >&2; exit 1; }
  (cd "${src}/${component}" && tar -cf - --exclude=manifest.in .) | (cd "$PREFIX" && tar -xf -)
done
# The components unpack as <prefix>/{bin,lib,libexec,share}; the manifests go.
find "$PREFIX" -maxdepth 1 -name 'manifest-*' -delete
rm -rf "${PREFIX}/share/doc" "${PREFIX}/share/man" "${PREFIX}/share/zsh"

# Nothing writable, root-owned: the same posture every other toolchain has.
chown -R root:root "$PREFIX"
chmod -R a-w,a+rX "$PREFIX"

echo "verifying ${PREFIX}/bin/rustc"
"${PREFIX}/bin/rustc" --version
test "$("${PREFIX}/bin/rustc" --version | awk '{print $2}')" = "$VERSION"

# The catalog's exact compile command, and the static link it promises.
probe="$(mktemp -d /var/tmp/recx-rust-probe.XXXXXX)"
cat > "${probe}/main.rs" <<'RS'
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("stdin");
    let mut it = input.split_whitespace();
    let name = it.next().unwrap_or("REC");
    let a: i64 = it.next().unwrap_or("0").parse().unwrap_or(0);
    let b: i64 = it.next().unwrap_or("0").parse().unwrap_or(0);
    println!("Hello, {}! {}", name, a + b);
}
RS
(
  cd "$probe"
  "${PREFIX}/bin/rustc" --edition 2021 -O -C target-feature=+crt-static \
    -C "linker=${GCC}/bin/gcc" -C codegen-units=1 -C strip=debuginfo -o main main.rs
)
out="$(printf 'REC 40 2\n' | "${probe}/main")"
test "$out" = "Hello, REC! 42" || { echo "the probe printed ${out@Q}" >&2; exit 1; }
# `+crt-static` on this target produces a static-PIE binary, which `file`
# describes as "static-pie linked" rather than "statically linked" — both are
# static. (The first real install printed the static-pie form, which is why
# this accepts both.) The authority either way is whether the ELF needs a
# shared library at all, which a box could not provide.
if ! file "${probe}/main" | grep -qE "static-pie linked|statically linked"; then
  echo "the catalog's compile argv did not produce a static binary:" >&2
  file "${probe}/main" >&2
  exit 1
fi
needed="$(readelf -d "${probe}/main" 2>/dev/null | grep -c NEEDED || true)"
if [[ "${needed:-0}" != "0" ]]; then
  echo "the binary still needs shared libraries, which a box does not have:" >&2
  readelf -d "${probe}/main" | grep NEEDED >&2
  exit 1
fi
rm -rf "$probe"

echo "rust ${VERSION} installed at ${PREFIX} (static binaries, linker ${GCC}/bin/gcc)"
