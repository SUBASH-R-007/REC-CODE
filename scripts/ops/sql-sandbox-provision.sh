#!/usr/bin/env bash
# REC Code — provision the SQL judge's sandbox cluster (Phase 12k, slice 5).
#
#   sudo scripts/ops/sql-sandbox-provision.sh
#
# Run on a SQL JUDGE host, once, after `docker compose -f
# deploy/compose.sql-judge.yml up -d sandbox-db` has brought the cluster up
# and before the judge is started. It is idempotent: running it again
# rotates nothing and changes nothing that is already correct.
#
# What it makes, and why each line is here:
#
#   recx_sql_student   the role a student's statement runs as. NOINHERIT,
#                      member of nothing, LOGIN only. No CREATE anywhere,
#                      no TEMPORARY, and nothing on schema public — every
#                      table it may read is granted per case by the owner
#                      and disappears with that case's schema.
#   REVOKE on public   the default PUBLIC privileges are the hole: a fresh
#                      PostgreSQL lets any role create objects in `public`
#                      and read `pg_catalog` freely. The first is revoked
#                      here; the second is what the judge's own boot checks
#                      verify it cannot reach anything useful through.
#   the two URLs       written to /run/recx/secrets, mode 0600, read by the
#                      compose file as Docker secrets. They never enter the
#                      repository, an image, or the app host.
#
# The password is generated here and piped to psql on stdin, so it never
# reaches a process list, a shell history or a log. The judge refuses to
# start if the two URLs are the same role (apps/sql-judge/src/config.ts),
# which is why there are two files rather than one.
#
# ── Not run here ───────────────────────────────────────────────────────────
# Never run: there is no SQL judge host. The equivalent for development is
# scripts/dev/sql-sandbox-up.mjs, which makes the same roles with the same
# grants in the WSL2 mirror and IS run on every SQL judging change.
set -euo pipefail

SECRETS_DIR="${RECX_SECRETS_DIR:-/run/recx/secrets}"
SANDBOX_DB="${RECX_SANDBOX_DB:-recx_sql_sandbox}"
OWNER="${RECX_SANDBOX_OWNER:-recx_sql_owner}"
STUDENT="${RECX_SANDBOX_STUDENT:-recx_sql_student}"
HOST="${RECX_SANDBOX_HOST:-sandbox-db}"
PORT="${RECX_SANDBOX_PORT:-5432}"
COMPOSE_SERVICE="${RECX_SANDBOX_SERVICE:-sandbox-db}"

owner_password_file="${SECRETS_DIR}/sandbox_owner_password"
owner_url_file="${SECRETS_DIR}/sandbox_owner_url"
student_url_file="${SECRETS_DIR}/sandbox_student_url"

if [ ! -s "$owner_password_file" ]; then
  echo "error: $owner_password_file is missing. The owner's password is created with the cluster," >&2
  echo "       by the compose file's sandbox_owner_password secret, not by this script." >&2
  exit 1
fi

umask 077
mkdir -p "$SECRETS_DIR"

owner_password="$(cat "$owner_password_file")"

# An existing student password is kept: rotating it here would break the
# running judge, which holds the URL as a file it read at boot.
if [ -s "$student_url_file" ]; then
  student_password="$(sed -E 's|.*://[^:]+:([^@]+)@.*|\1|' "$student_url_file")"
else
  student_password="$(head -c 24 /dev/urandom | base64 | tr -d '=+/' | cut -c1-32)"
fi

psql_as_owner() {
  docker compose -f deploy/compose.sql-judge.yml exec -T \
    -e PGPASSWORD="$owner_password" "$COMPOSE_SERVICE" \
    psql -v ON_ERROR_STOP=1 -U "$OWNER" -d "$SANDBOX_DB" -f -
}

# The student role, and the privileges it must NOT have. Written as one
# transaction so a half-applied grant set cannot leave a usable role behind.
psql_as_owner <<SQL
BEGIN;

DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${STUDENT}') THEN
    EXECUTE format('ALTER ROLE %I NOINHERIT LOGIN PASSWORD %L', '${STUDENT}', \$pw\$${student_password}\$pw\$);
  ELSE
    EXECUTE format('CREATE ROLE %I NOINHERIT LOGIN PASSWORD %L', '${STUDENT}', \$pw\$${student_password}\$pw\$);
  END IF;
END
\$\$;

-- Nothing by default, anywhere. Every table a case needs is granted by the
-- owner when it creates that case's schema, and is gone when it drops it.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM "${STUDENT}";
REVOKE ALL ON DATABASE "${SANDBOX_DB}" FROM PUBLIC;
REVOKE ALL ON DATABASE "${SANDBOX_DB}" FROM "${STUDENT}";
GRANT CONNECT ON DATABASE "${SANDBOX_DB}" TO "${STUDENT}";
-- TEMPORARY would let a statement write, which the read-only transaction
-- already refuses; revoking it means the refusal does not depend on that.
REVOKE TEMPORARY ON DATABASE "${SANDBOX_DB}" FROM "${STUDENT}";

COMMIT;
SQL

printf 'postgresql://%s:%s@%s:%s/%s' "$OWNER" "$owner_password" "$HOST" "$PORT" "$SANDBOX_DB" > "$owner_url_file"
printf 'postgresql://%s:%s@%s:%s/%s' "$STUDENT" "$student_password" "$HOST" "$PORT" "$SANDBOX_DB" > "$student_url_file"
chmod 0600 "$owner_url_file" "$student_url_file"

echo "sandbox ready: ${SANDBOX_DB} on ${HOST}:${PORT}, roles ${OWNER} and ${STUDENT}"
echo "wrote ${owner_url_file} and ${student_url_file} (0600). Neither password was printed."
echo "the judge verifies the rest at boot: no application table, student unprivileged, self-check green."
