#!/usr/bin/env bash
# Mirror the Windows checkout into the WSL-native filesystem and install
# Linux-native dependencies there. Windows and Linux node_modules cannot be
# shared (native binaries: Prisma engines, argon2, esbuild, rollup).
#
#   bash scripts/dev/linux-sync.sh [--install]
#
# Target: $RECX_LINUX_DIR (default ~/recx). Run as your normal WSL user.
set -euo pipefail

SRC="${RECX_SRC:-$(cd "$(dirname "$0")/../.." && pwd)}"
DEST="${RECX_LINUX_DIR:-$HOME/recx}"
mkdir -p "$DEST"

rsync -a --delete \
  --exclude node_modules/ \
  --exclude .next/ \
  --exclude dist/ \
  --exclude storage/ \
  --exclude 'apps/web/public/monaco/' \
  --exclude '*.tsbuildinfo' \
  --exclude .env --exclude '.env.local' \
  "$SRC/" "$DEST/"

# Line endings: the checkout is LF via .gitattributes, but files written on
# Windows before the first commit may carry CRLF. Shell scripts must not.
find "$DEST" -name '*.sh' -not -path '*/node_modules/*' -exec sed -i 's/\r$//' {} +

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if [[ "${1:-}" == "--install" || ! -d "$DEST/node_modules" ]]; then
  (cd "$DEST" && corepack pnpm@9.15.9 install --frozen-lockfile)
fi
# The schema may have changed since the last install: always regenerate the
# Prisma client (cheap, idempotent) so the mirror never typechecks stale models.
(cd "$DEST" && corepack pnpm@9.15.9 --filter @recx/db generate >/dev/null)
echo "synced to $DEST"
