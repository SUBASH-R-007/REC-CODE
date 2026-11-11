#!/usr/bin/env bash
# Run the phase gate in the WSL-native mirror (the "Linux runner" on a
# Windows development machine): lint, typecheck, test, build, then the real
# isolate integration suite. Usage (from WSL):
#   RECX_SRC=/mnt/c/.../REC-CODE bash scripts/dev/linux-gate.sh
set -uo pipefail
SRC="${RECX_SRC:?set RECX_SRC to the Windows checkout path}"
DEST="${RECX_LINUX_DIR:-$HOME/recx}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PNPM="corepack pnpm@9.15.9"

# A dev server running from the same mirror shares apps/web/.next with the
# gate's `next build` and corrupts it ("no direct app page entry found").
if pgrep -f "$DEST/.*next" >/dev/null 2>&1 || pgrep -f "next-server" >/dev/null 2>&1; then
  echo "A Next.js server is running from $DEST — stop it before running the gate." >&2
  exit 2
fi

RECX_SRC="$SRC" bash <(sed 's/\r$//' "$SRC/scripts/dev/linux-sync.sh") --install >/tmp/recx-sync.log 2>&1 \
  || { tail -20 /tmp/recx-sync.log; exit 1; }
cd "$DEST"

status=0
step() {
  local name="$1"; shift
  if "$@" >"/tmp/recx-gate-$name.log" 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (see /tmp/recx-gate-$name.log)"; tail -25 "/tmp/recx-gate-$name.log"; status=1
  fi
}
step lint      $PNPM lint
step typecheck $PNPM typecheck
step test      $PNPM test
step build     $PNPM build
# The database tests run against recx_test (or RECX_TEST_DATABASE_URL). Apply
# every migration to it first, so no suite depends on another one having
# migrated it (only packages/db's suites run `migrate deploy` themselves).
TEST_DB_URL="${RECX_TEST_DATABASE_URL:-postgresql://recx:recx-dev-only@localhost:5433/recx_test}"
case "${TEST_DB_URL%%\?*}" in
  *_test) ;;
  *) echo "RECX_TEST_DATABASE_URL must name a database ending in _test" >&2; exit 2 ;;
esac
step migrate-test-db env DATABASE_URL="$TEST_DB_URL" DATABASE_URL_DIRECT="$TEST_DB_URL" \
  $PNPM --filter @recx/db migrate:deploy
step services-tests env RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 RECX_TEST_DATABASE_URL="$TEST_DB_URL" $PNPM test
# The golden suite also judges every java21 reference solution (java21 ships
# its FUNCTION harness but is not enabled by default).
step isolate-integration env RECX_ISOLATE_INTEGRATION=1 RECX_CACHE_DIR=/tmp/recjudge-cache \
  RECX_GOLDEN_EXTRA_LANGUAGES=java21 \
  $PNPM --filter @recx/judge-worker test:integration
grep -hE "Test Files|Tests " /tmp/recx-gate-test.log /tmp/recx-gate-services-tests.log /tmp/recx-gate-isolate-integration.log | sed 's/^/      /'
exit $status
