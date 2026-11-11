#!/usr/bin/env bash
# Start, restart or stop the `next dev` server the e2e job runs against.
#
#   bash scripts/dev/ci-web-server.sh start     # first boot
#   bash scripts/dev/ci-web-server.sh restart   # after warming the routes
#   bash scripts/dev/ci-web-server.sh stop
#
# Two steps need the same eight lines, which is why this is a file rather
# than twice in the workflow.
#
# The restart is the point. `next dev` watches its own heap and restarts
# when it nears the threshold — it says so, "⚠ Server is approaching the
# used memory threshold, restarting..." — and a navigation in flight at that
# moment either comes back empty or hangs until the navigation timeout. This
# suite visits about sixty routes, which is most of the app's module graph,
# so it is the one place in this repository that reliably reaches the
# threshold.
#
# Warming compiles those routes into `.next` ON DISK but also retains them
# in heap, so a suite that starts right after warming begins already near
# the ceiling. Restarting then keeps the on-disk cache and gives the run a
# fresh heap. docs/RUNBOOK.md §1.5 records what that was worth here: the
# rbac project went from failing its 40-URL sweep to 6/6 with zero restarts.
set -euo pipefail

ACTION="${1:-start}"
BASE="${2:-http://localhost:3000}"
STATE_DIR="${RUNNER_TEMP:-/tmp}"
PID_FILE="$STATE_DIR/recx-web.pid"
LOG_FILE="$STATE_DIR/web.log"

stop_server() {
  [ -f "$PID_FILE" ] || return 0
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    # Give it a moment to release port 3000 before anything rebinds it.
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

start_server() {
  # --disable-source-maps for the reason in docs/RUNBOOK.md §1.5: the
  # retained maps for several thousand modules are the bulk of the heap
  # growth behind the restarts above.
  nohup pnpm --filter @recx/web exec next dev -p 3000 --disable-source-maps >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
}

wait_ready() {
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$BASE/login"; then
      printf 'web server ready at %s\n' "$BASE"
      return 0
    fi
    sleep 2
  done
  echo "web server never became ready; last 100 lines of its log:" >&2
  tail -n 100 "$LOG_FILE" >&2 || true
  return 1
}

case "$ACTION" in
  start)
    start_server
    wait_ready
    ;;
  restart)
    stop_server
    start_server
    wait_ready
    ;;
  stop)
    stop_server
    ;;
  *)
    echo "usage: $0 {start|restart|stop} [base-url]" >&2
    exit 2
    ;;
esac
