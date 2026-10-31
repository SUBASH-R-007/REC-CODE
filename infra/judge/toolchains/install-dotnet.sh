#!/usr/bin/env bash
# Install the pinned .NET SDK into /opt/toolchains/dotnet-10.0.403 (cs8).
#
# Source: builds.dotnet.microsoft.com, the URL Microsoft's own release
# metadata names for this SDK. Its sha512 is pinned below AND re-checked
# against the hash that metadata publishes, fetched at install time — so a
# mirror serving different bytes fails here rather than at a student's first
# submission.
#
# Why .NET 10 for a language key called cs8: `cs8` is the C# LANGUAGE version
# SPEC §11 asks for, and the compiler pins it (`-langversion:8.0` in the
# response file below). The RUNTIME is the current LTS, because .NET 8 leaves
# support on 2026-11-10 and a judge host should not ship a runtime that stops
# getting security fixes in a month. A future C# 12 would be a NEW key and a
# NEW directory (docs/JUDGE.md §7), never an in-place change here.
#
# What a submission actually runs:
#
#   compile  bin/recx-cs-build — `dotnet exec …/Roslyn/bincore/csc.dll` with
#            share/recx-cs.rsp (langversion 8.0, optimize, every framework
#            reference assembly), then it writes main.runtimeconfig.json so
#            the produced main.dll is a runnable framework-dependent app.
#            MSBuild, NuGet and the project system are never invoked: they
#            want a writable home, a lock file and a network, and a
#            submission is one file.
#   run      `dotnet main.dll`.
#
# Idempotent; run as root.
set -euo pipefail

VERSION="10.0.403"
ID="dotnet-${VERSION}"
PREFIX="/opt/toolchains/${ID}"
TARBALL="dotnet-sdk-${VERSION}-linux-x64.tar.gz"
URL="https://builds.dotnet.microsoft.com/dotnet/Sdk/${VERSION}/${TARBALL}"
METADATA="https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json"
# Microsoft's published sha512 for this file (release metadata, pinned 2026-10-31).
SHA512="b7b3d8461cf98b07d2552ce9199702fa3ad010ac2671a5f8cd5136f7534e50f6855ba7bbb02b11494563f1d04156276a31cda1103b900e5eecd0d9473dc7b9c5"

if [[ $EUID -ne 0 ]]; then
  echo "install-dotnet.sh must run as root" >&2
  exit 1
fi

# The marker is bin/recx-cs-build, written LAST: an interrupted install
# leaves a tree with a working `dotnet` in it and nothing to compile with,
# and that must not read as "already installed".
if [[ -x "${PREFIX}/bin/recx-cs-build" ]]; then
  have="$("${PREFIX}/dotnet" --version 2>/dev/null || true)"
  if [[ "$have" == "$VERSION" ]]; then
    echo ".NET SDK ${VERSION} already installed at ${PREFIX}"
    exit 0
  fi
  echo "refusing to overwrite ${PREFIX}: it holds SDK ${have:-unknown}, not ${VERSION}" >&2
  exit 1
fi
if [[ -e "$PREFIX" ]]; then
  echo "clearing an unfinished install at ${PREFIX}"
  chmod -R u+w "$PREFIX"
  rm -rf "$PREFIX"
fi

work="$(mktemp -d /var/tmp/recx-dotnet.XXXXXX)"
trap 'rm -rf "$work"' EXIT
cd "$work"

echo "downloading ${URL}"
curl -fsSL -o "$TARBALL" "$URL"

# The publisher's own hash for this exact file name, read from the release
# metadata now; it must agree with the pin above and with the bytes we have.
published="$(
  curl -fsSL "$METADATA" | python3 -c '
import json, sys
want = sys.argv[1]
data = json.load(sys.stdin)
for release in data.get("releases", []):
    sdk = release.get("sdk") or {}
    if sdk.get("version") != want:
        continue
    for f in sdk.get("files", []):
        if f.get("rid") == "linux-x64" and f.get("name", "").endswith(".tar.gz"):
            print(f["hash"].lower())
            raise SystemExit
raise SystemExit("no linux-x64 sdk tarball for " + want)
' "$VERSION"
)"
actual="$(sha512sum "$TARBALL" | awk '{print $1}')"
if [[ -z "$published" ]]; then
  echo "could not read the published sha512 from ${METADATA}" >&2
  exit 1
fi
if [[ "$actual" != "$published" ]]; then
  echo "sha512 mismatch against Microsoft's release metadata:" >&2
  echo "  got       ${actual}" >&2
  echo "  published ${published}" >&2
  exit 1
fi
if [[ "$actual" != "$SHA512" ]]; then
  echo "sha512 mismatch against the pin in this script:" >&2
  echo "  got    ${actual}" >&2
  echo "  pinned ${SHA512}" >&2
  echo "if this is a deliberate re-pin, change SHA512 in install-dotnet.sh in the same commit" >&2
  exit 1
fi

# From here until the probe passes, a failure takes the tree with it: a
# half-installed toolchain that LOOKS installed is the one outcome worth
# guarding against, because a node would then advertise a language it cannot
# compile.
trap 'rm -rf "$work" "${probe:-}"; chmod -R u+w "$PREFIX" 2>/dev/null || true; rm -rf "$PREFIX"' EXIT
mkdir -p "$PREFIX"
tar -xzf "$TARBALL" -C "$PREFIX"
# Project templates are for `dotnet new`, which a judge never runs.
rm -rf "${PREFIX}/templates"

sdk_dir="${PREFIX}/sdk/${VERSION}"
csc="${sdk_dir}/Roslyn/bincore/csc.dll"
[[ -f "$csc" ]] || { echo "the SDK has no ${csc}" >&2; exit 1; }

# The reference assemblies a submission compiles against: the ref pack of
# the shared framework this SDK ships. Resolved ONCE, here, into a response
# file — a box has no network and no project system to resolve them.
ref_pack="$(find "${PREFIX}/packs/Microsoft.NETCore.App.Ref" -maxdepth 3 -type d -name 'net10.0' | sort | tail -1)"
[[ -n "$ref_pack" ]] || { echo "no Microsoft.NETCore.App.Ref/*/ref/net10.0 in the SDK" >&2; exit 1; }
runtime_version="$(basename "$(dirname "$(dirname "$ref_pack")")")"

mkdir -p "${PREFIX}/share" "${PREFIX}/bin"
{
  echo "-nologo"
  echo "-nostdlib+"
  echo "-optimize+"
  echo "-deterministic+"
  echo "-target:exe"
  echo "-utf8output"
  # SPEC §11 asks for cs8: the language version is pinned, so a submission
  # means in 2029 what it meant in 2026 — and a student reading "C# 8" on
  # the problem page gets C# 8 from the compiler.
  echo "-langversion:8.0"
  for dll in "${ref_pack}"/*.dll; do echo "-r:${dll}"; done
} > "${PREFIX}/share/recx-cs.rsp"

cat > "${PREFIX}/bin/recx-cs-build" <<SH
#!/bin/sh
# Compile /box/main.cs into a runnable framework-dependent main.dll, with no
# MSBuild, no NuGet and no network: csc with the install-time response file,
# then the runtimeconfig.json the host needs to pick a framework.
set -e
# -noconfig is a command-line option: csc warns CS2023 if it is read from a
# response file, and a student's compile output must carry only their own
# diagnostics.
"${PREFIX}/dotnet" exec "${csc}" -noconfig "@${PREFIX}/share/recx-cs.rsp" -out:main.dll main.cs
cat > main.runtimeconfig.json <<JSON
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "${runtime_version}" },
    "rollForward": "latestPatch",
    "configProperties": {
      "System.Globalization.Invariant": true,
      "System.Runtime.TieredPGO": false
    }
  }
}
JSON
SH
chmod 0755 "${PREFIX}/bin/recx-cs-build"

# Nothing writable, root-owned: the same posture every other toolchain has.
chown -R root:root "$PREFIX"
chmod -R a-w,a+rX "$PREFIX"

echo "verifying ${PREFIX}/dotnet"
"${PREFIX}/dotnet" --version

# The catalog's exact compile and run path, outside a box first: a failure
# here is the toolchain's, not isolate's.
probe="$(mktemp -d /var/tmp/recx-dotnet-probe.XXXXXX)"
cat > "${probe}/main.cs" <<'CS'
using System;

class Program {
    static void Main() {
        var parts = Console.In.ReadToEnd().Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        long a = long.Parse(parts[1]), b = long.Parse(parts[2]);
        Console.WriteLine($"Hello, {parts[0]}! {a + b}");
    }
}
CS
(
  cd "$probe"
  DOTNET_ROOT="$PREFIX" DOTNET_CLI_HOME=/tmp DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 \
    "${PREFIX}/bin/recx-cs-build"
  out="$(printf 'REC 40 2\n' | DOTNET_ROOT="$PREFIX" DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 "${PREFIX}/dotnet" main.dll)"
  test "$out" = "Hello, REC! 42" || { echo "the probe printed ${out@Q}" >&2; exit 1; }
)
rm -rf "$probe"
# The probe passed: keep the install.
trap 'rm -rf "$work"' EXIT

echo ".NET SDK ${VERSION} installed at ${PREFIX} (C# pinned to language version 8, runtime ${runtime_version})"
