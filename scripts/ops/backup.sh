#!/usr/bin/env bash
# One backup set: the database and the test data, captured together
# (Phase 10e).
#
#   scripts/ops/backup.sh [--out DIR] [--label LABEL]
#
# Environment:
#   DATABASE_URL_DIRECT   the database to dump (never the pooled URL)
#   TESTDATA_DIR          the local test-data store (TESTDATA_DRIVER=local)
#   RECX_IMAGE            the running image's digest, recorded in the manifest
#
# ── Why both or neither ────────────────────────────────────────────────────
#
# SPEC §3c: a problem's test cases live in content-addressed blobs, and a
# submission records which problem VERSION judged it. So a database dump
# restored next to a test-data snapshot from a different hour leaves
# submissions judged against test cases that no longer exist — and that is
# only ever discovered mid-incident, by somebody trying to explain a verdict.
#
# This script therefore writes a set or nothing. If either half fails, the
# directory is removed; there is no partial set to find later and believe.
#
# ── The manifest is the contract ───────────────────────────────────────────
#
# Both digests, the migration head, the image digest and the host.
# verify-backup.sh recomputes the digests and refuses a set whose manifest
# disagrees. A backup that cannot be verified is worse than no backup,
# because it is believed.

set -euo pipefail

OUT_ROOT="${RECX_BACKUP_DIR:-./backups}"
LABEL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_ROOT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) printf 'backup.sh: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

DB_URL="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "backup.sh: set DATABASE_URL_DIRECT (the direct, non-pooled URL)" >&2
  exit 2
fi

TESTDATA="${TESTDATA_DIR:-}"
if [ -z "$TESTDATA" ] || [ ! -d "$TESTDATA" ]; then
  echo "backup.sh: set TESTDATA_DIR to the local test-data store (a backup without it is half a set)" >&2
  exit 2
fi

for tool in pg_dump zstd sha256sum tar; do
  command -v "$tool" > /dev/null || { printf 'backup.sh: %s is not installed\n' "$tool" >&2; exit 2; }
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SET_DIR="$OUT_ROOT/recx-backup-$STAMP${LABEL:+-$LABEL}"

# Both or neither: anything that leaves this script early takes the directory
# with it.
cleanup() {
  status=$?
  if [ $status -ne 0 ] && [ -d "$SET_DIR" ]; then
    rm -rf "$SET_DIR"
    printf 'backup.sh: FAILED (%s); removed the partial set at %s\n' "$status" "$SET_DIR" >&2
  fi
  exit $status
}
trap cleanup EXIT

mkdir -p "$SET_DIR"
printf 'backup set: %s\n' "$SET_DIR"

# ── The database ──────────────────────────────────────────────────────────
#
# -Fc (custom) rather than plain SQL: it restores in parallel, it can be
# restored table by table during an incident, and pg_restore --list reads its
# table of contents without unpacking it.
printf '  pg_dump … '
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file "$SET_DIR/database.dump" "$DB_URL"
printf 'ok (%s)\n' "$(du -h "$SET_DIR/database.dump" | cut -f1)"

# ── The test data, at the same instant ────────────────────────────────────
#
# The store is content-addressed (blobs named by sha256), so tarring it is
# safe while the platform runs: a blob is written once and never mutated, and
# a blob written during the tar is either in the set or not — never half.
printf '  testdata … '
tar --create --directory "$TESTDATA" . | zstd -19 -T0 -q -o "$SET_DIR/testdata.tar.zst"
printf 'ok (%s)\n' "$(du -h "$SET_DIR/testdata.tar.zst" | cut -f1)"

# ── The manifest ──────────────────────────────────────────────────────────
#
# The migration head is in here because a dump restored under an image that
# expects a later schema is the other way a restore goes quietly wrong: the
# rows are all there and a column is not.
MIGRATION_HEAD="$(psql "$DB_URL" -At -c \
  'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1' \
  2>/dev/null || echo "unknown")"
MIGRATION_COUNT="$(psql "$DB_URL" -At -c \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' \
  2>/dev/null || echo "0")"

{
  printf 'recx-backup\n'
  printf 'version 1\n'
  printf 'created %s\n' "$STAMP"
  printf 'host %s\n' "$(hostname)"
  printf 'image %s\n' "${RECX_IMAGE:-unknown}"
  printf 'migration_head %s\n' "$MIGRATION_HEAD"
  printf 'migration_count %s\n' "$MIGRATION_COUNT"
  printf 'database_bytes %s\n' "$(stat -c %s "$SET_DIR/database.dump")"
  printf 'testdata_bytes %s\n' "$(stat -c %s "$SET_DIR/testdata.tar.zst")"
  printf 'sha256 %s database.dump\n' "$(sha256sum "$SET_DIR/database.dump" | cut -d' ' -f1)"
  printf 'sha256 %s testdata.tar.zst\n' "$(sha256sum "$SET_DIR/testdata.tar.zst" | cut -d' ' -f1)"
} > "$SET_DIR/MANIFEST.txt"

printf '  manifest … ok\n'
printf '\n'
cat "$SET_DIR/MANIFEST.txt"
printf '\nverify it before trusting it:\n  scripts/ops/verify-backup.sh %s\n' "$SET_DIR"
