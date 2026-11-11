#!/usr/bin/env bash
# Deploy the app host (Phase 10e).
#
#   RECX_WEB_IMAGE=registry/recx-web@sha256:… scripts/ops/deploy.sh
#   RUN_MIGRATIONS=true scripts/ops/deploy.sh      (a supervised step)
#   FORCE_DEPLOY=1      scripts/ops/deploy.sh      (during a live contest)
#
# ── Not run here ───────────────────────────────────────────────────────────
# There is no app host: one laptop, no second machine, no registry. Written
# as the artefact the college's ops person will use; docs/RUNBOOK.md §3
# records it as NOT RUN with what would have to be true to run it.
#
# ── Four rules, each of which exists because the alternative has bitten ────
#
# 1. **By digest, never by tag.** `RECX_WEB_IMAGE` must contain `@sha256:`.
#    A tag moves; a platform that redeploys "the same tag" and behaves
#    differently is a platform nobody can reason about.
#
# 2. **It refuses while a contest or an assessment is live**, by reading
#    `/api/health` — which exists partly for this (SPEC §10). `FORCE_DEPLOY=1`
#    overrides it, prints what it is overriding, and says so in the log.
#
# 3. **Migrations are a SEPARATE, SUPERVISED step**, off by default. SPEC's
#    reason, carried verbatim because it is the reason: auto-migrating on boot
#    runs migrations N times concurrently during a rolling deploy, and applies
#    a bad migration before anyone reads the error. With `RUN_MIGRATIONS=true`
#    this takes a backup first, applies them once, and only then restarts
#    replicas.
#
# 4. **One replica at a time, health-gated.** The new one must report healthy
#    before the next is touched, so a bad image takes out one replica rather
#    than the platform.

set -euo pipefail

COMPOSE_FILE="${RECX_COMPOSE_FILE:-deploy/compose.app.yml}"
ENV_FILE="${RECX_ENV_FILE:-deploy/app.env}"
HEALTH_URL="${RECX_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
FORCE_DEPLOY="${FORCE_DEPLOY:-0}"
LOG="${RECX_DEPLOY_LOG:-/var/log/recx/deploy.log}"

note() {
  printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG" 2>/dev/null || true
}

fail() {
  note "DEPLOY REFUSED: $1"
  exit 1
}

# ── 1. The image must be pinned ───────────────────────────────────────────
IMAGE="${RECX_WEB_IMAGE:-}"
[ -n "$IMAGE" ] || fail "RECX_WEB_IMAGE is not set"
case "$IMAGE" in
  *@sha256:*) ;;
  *) fail "RECX_WEB_IMAGE must be pinned by digest (…@sha256:…), not by the tag '$IMAGE'" ;;
esac
note "image $IMAGE"

# ── 2. Is anything live? ──────────────────────────────────────────────────
#
# One call, which is why `activeContest` is on the health endpoint at all:
# a deploy script should not need to know how contests are modelled.
health="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || echo '')"
[ -n "$health" ] || fail "cannot read $HEALTH_URL — deploy blind is not a deploy"

read_json() { printf '%s' "$health" | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '" '; }
ok_now="$(read_json ok)"
active_contest="$(read_json activeContest)"
active_assessment="$(read_json activeAssessment)"
migrations_state="$(read_json migrations)"
note "health: ok=$ok_now contest=$active_contest assessment=$active_assessment migrations=$migrations_state"

if [ "$active_contest" = "true" ] || [ "$active_assessment" = "true" ]; then
  if [ "$FORCE_DEPLOY" != "1" ]; then
    fail "a contest or an assessment is LIVE. Students are mid-attempt; a rolling restart drops their SSE streams and their next save races the restart. Wait for the window to close, or set FORCE_DEPLOY=1 and own it."
  fi
  note "FORCE_DEPLOY=1: deploying DURING a live contest or assessment, deliberately"
fi

# ── 3. Migrations: separate, supervised, and backed up first ──────────────
if [ "$RUN_MIGRATIONS" = "true" ]; then
  note "migrations: requested"
  if [ "${SKIP_BACKUP:-0}" != "1" ]; then
    note "migrations: taking a backup set first"
    scripts/ops/backup.sh --label pre-migration | sed 's/^/    /'
  else
    note "migrations: SKIP_BACKUP=1 — applying a schema change with no backup to go back to"
  fi
  # Expand/contract: this applies only migrations the PREVIOUS image can
  # still run against, which is a property of how they are written rather
  # than something this script can check. It is in the runbook as a review
  # step, not here as a guess.
  note "migrations: applying"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm \
    -e RUN_MIGRATIONS=true web npx prisma migrate deploy | sed 's/^/    /'
  note "migrations: applied"
else
  note "migrations: NOT run (RUN_MIGRATIONS=false, the default)"
  if [ "$migrations_state" = "behind" ]; then
    note "note: the database is BEHIND this image's migrations. Under expand/contract that is a normal state during a deploy, and the supervised step is what resolves it."
  fi
fi

# ── 4. Pull, then one replica at a time ───────────────────────────────────
note "pulling"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull web scheduler | sed 's/^/    /'

replicas="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --format '{{.Name}}' web 2>/dev/null || true)"
if [ -z "$replicas" ]; then
  note "no running web replicas: starting the stack"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
else
  for name in $replicas; do
    note "restarting $name"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps --force-recreate "$name" | sed 's/^/    /'
    # Health-gated: the next replica is not touched until this one answers.
    # `/api/health` always answers 200, so this reads the BODY — a 200 with
    # ok:false is a process that is up and not ready.
    for attempt in $(seq 1 30); do
      body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || echo '')"
      case "$body" in
        *'"ok":true'*) note "$name healthy after ${attempt}0s"; break ;;
      esac
      if [ "$attempt" -eq 30 ]; then
        fail "$name did not become healthy. The other replicas are still on the previous image; roll back with the digest in $LOG."
      fi
      sleep 10
    done
  done
  note "restarting the scheduler"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps --force-recreate scheduler | sed 's/^/    /'
fi

note "DEPLOYED $IMAGE"
printf '\nRolling back means deploying the previous digest from %s.\n' "$LOG"
