#!/usr/bin/env bash
# Restore a backup set into a database (Phase 10e).
#
#   scripts/ops/restore.sh BACKUP_SET_DIR --into postgresql://…/recx_scratch
#                                        [--testdata DIR] [--jobs N] [--force]
#
# ── It verifies first, every time ──────────────────────────────────────────
#
# verify-backup.sh runs before anything is written. Restoring an unverified
# set is how a corrupted dump becomes a corrupted database, and the moment
# somebody is restoring is the moment they are least likely to check by hand.
#
# ── It refuses a database that looks live ──────────────────────────────────
#
# A restore into the wrong database is unrecoverable in the way that matters:
# the thing it overwrites is the thing the backup exists to protect. So the
# target must be EMPTY, or be named like a scratch database
# (`*_scratch`, `*_restore`, `*_drill`), or be forced explicitly with
# `--force` — and `--force` prints what it is about to destroy and waits for
# the database's own name to be typed back.

set -euo pipefail

SET_DIR=""
TARGET=""
TESTDATA_OUT=""
JOBS=4
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET="$2"; shift 2 ;;
    --testdata) TESTDATA_OUT="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) if [ -z "$SET_DIR" ]; then SET_DIR="$1"; shift; else printf 'restore.sh: unexpected %s\n' "$1" >&2; exit 2; fi ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$SET_DIR" ] || [ -z "$TARGET" ]; then
  echo "usage: restore.sh BACKUP_SET_DIR --into DATABASE_URL [--testdata DIR] [--force]" >&2
  exit 2
fi

# ── 1. Verify ─────────────────────────────────────────────────────────────
bash "$HERE/verify-backup.sh" "$SET_DIR"

DB_NAME="$(printf '%s' "$TARGET" | sed 's#.*/##; s#?.*##')"

# ── 2. Refuse a target that is not obviously safe ─────────────────────────
is_scratch=0
case "$DB_NAME" in
  *_scratch|*_restore|*_drill|*_test) is_scratch=1 ;;
esac

TABLES="$(psql "$TARGET" -At -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "unreachable")"
if [ "$TABLES" = "unreachable" ]; then
  printf 'restore.sh: cannot reach %s\n' "$DB_NAME" >&2
  exit 1
fi

if [ "$TABLES" != "0" ] && [ "$is_scratch" -eq 0 ] && [ "$FORCE" -ne 1 ]; then
  cat >&2 <<EOF

restore.sh: refusing to restore into "$DB_NAME".

It holds $TABLES tables in the public schema and its name is not one of the
scratch shapes (*_scratch, *_restore, *_drill, *_test). A restore overwrites
the thing the backup exists to protect, so this needs --force and a typed
confirmation.
EOF
  exit 1
fi

if [ "$TABLES" != "0" ] && [ "$FORCE" -eq 1 ]; then
  printf '\nAbout to DROP and recreate the public schema of "%s" (%s tables).\n' "$DB_NAME" "$TABLES"
  printf 'Type the database name to confirm: '
  read -r typed
  if [ "$typed" != "$DB_NAME" ]; then
    echo "restore.sh: name did not match; nothing was changed." >&2
    exit 1
  fi
fi

# ── 3. Restore ────────────────────────────────────────────────────────────
printf '\nrestoring into %s\n' "$DB_NAME"

# A clean schema rather than --clean on the dump: pg_restore --clean emits a
# DROP per object and reports an error for each one that is not there, which
# buries the errors that matter in a restore log nobody then reads.
psql "$TARGET" -q -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

# --no-owner/--no-privileges: the dump was taken the same way, and a restore
# that fails because a role does not exist on this host is a restore that
# fails for a reason unrelated to the data.
#
# Errors are reported and not fatal only for the extension-ownership notices
# Postgres emits on a fresh schema; everything else stops the restore.
set +e
pg_restore --dbname "$TARGET" --jobs "$JOBS" --no-owner --no-privileges \
  --exit-on-error "$SET_DIR/database.dump"
status=$?
set -e
if [ $status -ne 0 ]; then
  printf 'restore.sh: pg_restore failed (%s)\n' "$status" >&2
  exit $status
fi

printf '  database … ok\n'

# ── 4. The test data, if asked ────────────────────────────────────────────
#
# Optional on purpose: a drill restores the database into a scratch schema
# and does not need 40 GB of blobs unpacked beside it. A REAL restore needs
# both, which is why the two are one set — and why this prints a warning
# rather than staying quiet when it is skipped.
if [ -n "$TESTDATA_OUT" ]; then
  mkdir -p "$TESTDATA_OUT"
  printf '  testdata … '
  zstd -d -q -c "$SET_DIR/testdata.tar.zst" | tar --extract --directory "$TESTDATA_OUT"
  printf 'ok (%s)\n' "$TESTDATA_OUT"
else
  printf '  testdata … SKIPPED (no --testdata): the database is restored WITHOUT its blobs.\n'
  printf '            A platform served from this state judges against test cases it cannot read.\n'
fi

printf '\nrestored. Next: the drift check, against this database:\n'
printf '  DATABASE_URL=%s npx pnpm@9.15.9 --filter @recx/db exec prisma migrate diff \\\n' "$TARGET"
printf '    --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --exit-code\n'
