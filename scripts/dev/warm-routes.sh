#!/usr/bin/env bash
# Pre-compile every route the end-to-end suite visits (Phase 10f).
#
#   scripts/dev/warm-routes.sh [BASE_URL]
#
# `next dev` compiles a route on its FIRST request. The e2e suite visits
# about sixty of them, so without a warm pass the first navigation to each
# one pays for a compile inside an assertion — and on a two-core CI runner
# that is several times slower than on a developer's machine. The first CI
# run of this suite lost two tests to `page.goto: Timeout 90000ms exceeded`,
# one of them the RBAC test that walks every `/super` page in a single test:
# a dozen first compiles in a row.
#
# Warming moves that cost HERE, where a slow compile is a slow build step
# rather than a test failure. It also absorbs the `next dev` heap restart
# documented in docs/RUNBOOK.md §1.5 — after a restart Next reuses its
# on-disk cache, so a second pass over the same list is cheap.
#
# Signed out is enough: a route compiles before its guard redirects. So this
# needs no session and no seed, and it never asserts anything — a 200, a 307
# to /login and a 404 all mean "compiled". Only an EMPTY reply (the server
# restarting mid-request) is worth reporting, and it is reported rather than
# failed on, because the next pass picks it up from the cache.

set -u

BASE="${1:-${E2E_BASE_URL:-http://localhost:3000}}"
PASSES="${WARM_PASSES:-2}"

# The routes the suite navigates: apps/web/e2e/a11y.spec.ts's page list, the
# /super list in rbac.spec.ts, and the student pages the keyboard journey
# walks. Kept in one place so the runbook, CI and a developer warm the same
# set; a route added to the suite belongs here too.
ROUTES="
/login /forgot-password /reset-password /dashboard /problems /problems/two-sum /problems/two-sum/submissions/none
/leaderboard /revision /interviews /mock-interviews /written /sheets /learn /profile /notes /bookmarks /help /judge /offline
/contests /aptitude /placement /notifications /accessibility /api/health
/account/leave /account/reactivate /account/new-password
/admin /admin/students /admin/students/import /admin/cohorts /admin/sheets
/admin/tracks /admin/reports /admin/announcements /admin/announcements/new
/admin/accommodations /admin/problems /admin/problems/new /admin/problems/import
/admin/judge /admin/contests /admin/assessments /admin/aptitude /admin/integrity
/admin/inactivity /admin/plans
/super /super/users /super/roles /super/settings/branding /super/settings/policy
/super/settings/judge /super/settings/ai /super/settings/integrations /super/audit /super/impersonate
/super/flags /super/jobs /super/data
/mentor /mentor/doubts /mentor/moderation /mentor/experiences /mentor/mock-interviews /mentor/written /placement-cell /placement-cell/heatmap /placement-cell/at-risk
/placement-cell/aptitude /placement-cell/export /placement-cell/drives
"

total=0
dead=0

for pass in $(seq 1 "$PASSES"); do
  printf '===== warm pass %s/%s against %s =====\n' "$pass" "$PASSES" "$BASE"
  pass_dead=0
  for route in $ROUTES; do
    total=$((total + 1))
    code="$(curl -s -o /dev/null -m 180 -w '%{http_code}' "$BASE$route" 2>/dev/null || echo 000)"
    if [ "$code" = "000" ]; then
      pass_dead=$((pass_dead + 1))
      printf '  DEAD %s (empty reply: the dev server restarted; the next pass compiles it from cache)\n' "$route"
    fi
  done
  # The sign-in POST handler compiles on its first request too, and the very
  # first thing the suite does is sign in — so without this the compile
  # happens inside `waitForURL`, which is how the first CI run of this suite
  # lost its storage-state setup ("Sign-in failed for 2116231001004", no
  # alert on the page, because the page had not navigated at all).
  #
  # An empty urlencoded body is refused as `identifier-missing` before
  # anything reaches the database or the rate limiter, so this compiles the
  # route and the modules behind it without signing anything in.
  total=$((total + 1))
  code="$(curl -s -o /dev/null -m 180 -w '%{http_code}' -X POST \
    -H 'Content-Type: application/x-www-form-urlencoded' --data '' \
    "$BASE/api/auth/login" 2>/dev/null || echo 000)"
  printf '  POST /api/auth/login -> %s (303 expected: the form was empty)\n' "$code"

  printf '  %s route(s) did not answer on this pass\n' "$pass_dead"
  dead=$pass_dead
done

printf '===== warmed %s request(s); %s unanswered on the last pass =====\n' "$total" "$dead"
# Never fails the build: an unwarmed route is slow, not broken, and the suite
# itself is what decides whether the page works.
exit 0
