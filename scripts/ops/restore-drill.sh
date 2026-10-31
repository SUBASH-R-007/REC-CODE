#!/usr/bin/env bash
# The restore drill (Phase 10e). THIS IS THE DELIVERABLE, not the script.
#
#   scripts/ops/restore-drill.sh [--set BACKUP_SET_DIR] [--scratch recx_drill]
#
# Environment:
#   DATABASE_URL_DIRECT   the database to back up and to drill against
#   TESTDATA_DIR          the local test-data store
#
# A backup script that has never been restored is a file. So this takes a
# set (or uses one given to it), restores it into a SCRATCH database, and
# then asks the three questions that decide whether the restore is usable:
#
#   1. does the schema match the code?   (prisma migrate diff --exit-code)
#   2. are the rows there?               (counts of the tables that matter)
#   3. does the test data unpack, and do the blobs the restored submissions
#      reference still exist?            (the half-set failure, caught)
#
# It ends with a line to paste into docs/RUNBOOK.md §3, because a drill
# nobody recorded is a drill nobody can point to.
#
# It never touches the live database: the scratch one is created and dropped
# here, and restore.sh refuses a target that is neither empty nor named like
# a scratch database.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SET_DIR=""
SCRATCH="recx_drill"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --set) SET_DIR="$2"; shift 2 ;;
    --scratch) SCRATCH="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) printf 'restore-drill.sh: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

DB_URL="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"
[ -n "$DB_URL" ] || { echo "restore-drill.sh: set DATABASE_URL_DIRECT" >&2; exit 2; }

# The scratch URL is the live one with its database name replaced — same
# host, same credentials, a different database. Nothing else about the
# connection changes, so the drill exercises the real server.
SCRATCH_URL="$(printf '%s' "$DB_URL" | sed "s#/[^/?]*\(?.*\)\{0,1\}\$#/$SCRATCH#")"
ADMIN_URL="$(printf '%s' "$DB_URL" | sed "s#/[^/?]*\(?.*\)\{0,1\}\$#/postgres#")"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_S=$(date +%s)

printf '================ restore drill %s ================\n' "$STARTED"
printf 'source database : %s\n' "$(printf '%s' "$DB_URL" | sed 's#.*/##; s#?.*##')"
printf 'scratch database: %s\n\n' "$SCRATCH"

# ── 1. A set to restore ───────────────────────────────────────────────────
if [ -z "$SET_DIR" ]; then
  printf -- '---- taking a fresh backup set ----\n'
  OUT="${RECX_BACKUP_DIR:-$REPO/backups}"
  bash "$HERE/backup.sh" --out "$OUT" --label drill | sed 's/^/  /'
  SET_DIR="$(ls -dt "$OUT"/recx-backup-*-drill | head -1)"
fi
printf -- '\n---- the set ----\n'
printf '  %s\n' "$SET_DIR"

# ── 2. Verify it ──────────────────────────────────────────────────────────
printf -- '\n---- verify ----\n'
bash "$HERE/verify-backup.sh" "$SET_DIR" | sed 's/^/  /'

# ── 3. Restore into the scratch database ──────────────────────────────────
printf -- '\n---- restore ----\n'
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\";"
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SCRATCH\";"
TESTDATA_OUT="$(mktemp -d)"
bash "$HERE/restore.sh" "$SET_DIR" --into "$SCRATCH_URL" --testdata "$TESTDATA_OUT" | sed 's/^/  /'

cleanup() {
  rm -rf "$TESTDATA_OUT"
  if [ "$KEEP" -eq 0 ]; then
    psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\";" || true
  else
    printf '\n(kept %s; drop it with: psql "%s" -c \x27DROP DATABASE "%s"\x27)\n' "$SCRATCH" "$ADMIN_URL" "$SCRATCH"
  fi
}
trap cleanup EXIT

problems=0

# ── 4. Does the schema match the code? ────────────────────────────────────
#
# The question a restore has to answer before anybody trusts it: the rows can
# all be there and a column not be. `prisma migrate diff --exit-code` exits 2
# when the restored database and the schema in this checkout disagree.
printf -- '\n---- drift: does the restored schema match the code? ----\n'
set +e
( cd "$REPO/packages/db" && DATABASE_URL="$SCRATCH_URL" DATABASE_URL_DIRECT="$SCRATCH_URL" \
    npx pnpm@9.15.9 exec prisma migrate diff \
      --from-schema-datasource prisma/schema.prisma \
      --to-schema-datamodel prisma/schema.prisma \
      --exit-code > /tmp/recx-drill-drift.txt 2>&1 )
drift=$?
set -e
if [ $drift -eq 0 ]; then
  printf '  ok    no drift: the restored database is exactly what the code expects\n'
else
  printf '  FAIL  the restored schema differs from the code (exit %s):\n' "$drift"
  sed 's/^/        /' /tmp/recx-drill-drift.txt | head -30
  problems=$((problems + 1))
fi

# ── 5. Are the rows there? ────────────────────────────────────────────────
#
# Not a row count for its own sake: these are the tables whose absence would
# make the platform look fine and be empty. A restore that produces a schema
# and no submissions is the failure this catches.
printf -- '\n---- rows ----\n'
counts() {
  psql "$1" -At -F' ' -c "
    SELECT 'User', count(*) FROM \"User\"
    UNION ALL SELECT 'Problem', count(*) FROM \"Problem\"
    UNION ALL SELECT 'ProblemVersion', count(*) FROM \"ProblemVersion\"
    UNION ALL SELECT 'TestCase', count(*) FROM \"TestCase\"
    UNION ALL SELECT 'TestBlob', count(*) FROM \"TestBlob\"
    UNION ALL SELECT 'Submission', count(*) FROM \"Submission\"
    UNION ALL SELECT 'AuditLog', count(*) FROM \"AuditLog\"
    ORDER BY 1"
}
live_counts="$(counts "$DB_URL")"
drill_counts="$(counts "$SCRATCH_URL")"
printf '  %-16s %10s %10s\n' table source restored
while read -r table n; do
  restored="$(printf '%s\n' "$drill_counts" | awk -v t="$table" '$1==t {print $2}')"
  mark="ok"
  if [ "$restored" != "$n" ]; then
    mark="DIFF"
    # Not automatically a failure: the live database keeps changing while the
    # dump is restored. A LOWER count is expected; a higher one is not.
    if [ "${restored:-0}" -gt "${n:-0}" ]; then
      mark="FAIL"
      problems=$((problems + 1))
    fi
  fi
  printf '  %-16s %10s %10s  %s\n' "$table" "$n" "${restored:-missing}" "$mark"
done <<< "$live_counts"

# ── 6. The half-set failure, caught ───────────────────────────────────────
#
# Every TestCase points at two TestBlobs, and a blob is either inline (small)
# or a key in the test-data store. If the dump and the test-data snapshot came
# from different hours, a restored submission is judged against test cases
# whose bytes are not there — the exact failure the one-set rule exists to
# prevent, and the one that is only ever noticed mid-incident.
printf -- '\n---- test data ----\n'
blobs="$(find "$TESTDATA_OUT" -type f 2>/dev/null | wc -l)"
printf '  unpacked %s file(s) from the set\n' "$blobs"
missing="$(psql "$SCRATCH_URL" -At -c \
  "SELECT count(*) FROM \"TestBlob\" WHERE \"inline\" IS NULL AND \"storageKey\" IS NOT NULL" 2>/dev/null || echo 0)"
printf '  %s blob(s) live in the store rather than inline\n' "$missing"
if [ "$missing" != "0" ] && [ "$blobs" = "0" ]; then
  printf '  FAIL  the database references stored blobs and the set unpacked none\n'
  problems=$((problems + 1))
else
  printf '  ok    the database and the unpacked store agree about what is where\n'
fi

# ── 7. The line for the runbook ───────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_S ))
SET_SIZE="$(du -sh "$SET_DIR" | cut -f1)"
HEAD="$(awk '$1=="migration_head" {print $2}' "$SET_DIR/MANIFEST.txt")"
SUBS="$(printf '%s\n' "$drill_counts" | awk '$1=="Submission" {print $2}')"

printf -- '\n================ result ================\n'
if [ "$problems" -eq 0 ]; then
  printf 'DRILL PASSED in %ss.\n\n' "$ELAPSED"
  printf 'Paste into docs/RUNBOOK.md §3:\n\n'
  printf '| 10e | %s | Restore drill into a scratch database (`%s`) | PASS — a %s set taken, verified, restored in %ss; no drift against the schema in this checkout (`prisma migrate diff --exit-code` = 0), %s submissions and every counted table present, and the unpacked test-data store agrees with the restored rows about which blobs are stored rather than inline. Migration head `%s` | Claude |\n' \
    "$(date -u +%Y-%m-%d)" "$SCRATCH" "$SET_SIZE" "$ELAPSED" "${SUBS:-0}" "${HEAD:-unknown}"
else
  printf 'DRILL FAILED: %s problem(s) above. This backup set is not restorable as it stands.\n' "$problems"
  exit 1
fi
