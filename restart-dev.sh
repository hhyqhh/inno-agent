#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Inno Agent dev/test orchestrator
#
# Subcommands:
#   restart   (default) build (unless --skip-build) and restart services
#   start     start services without building
#   stop      stop services
#   status    show service status
#   logs      tail logs (server|vite|both)
#   smoke     run smoke tests against running services
#   build     run `npm run build` only, no service changes
#
# Modes:
#   --mode dev   (default) backend (:3000) + Vite dev (:5173) with HMR
#   --mode prod  backend only — serves the built web/dist
#
# Sandbox:
#   --sandbox     start backend with pi-sandbox enabled
#   --no-sandbox  start without sandbox (default)
# ---------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# --- Defaults (env-overridable) ---
INNO_HOME="${INNO_HOME:-./runtime}"
WORKSPACE="${INNO_WORKSPACE:-./workspace}"
PORT="${INNO_PORT:-3000}"
WEB_PORT="${INNO_WEB_PORT:-5173}"
MODE="${INNO_MODE:-dev}"            # dev | prod
SANDBOX="${INNO_SANDBOX:-false}"    # true | false
SKIP_BUILD=false
TAIL_AFTER=false

CMD="restart"

usage() {
	cat <<EOF
Usage: ./restart-dev.sh [command] [options]

Commands:
  restart            (default) build + restart services
  start              start services without building
  stop               stop services
  status             show service status
  logs [TARGET]      tail logs (TARGET = server | vite | both, default both)
  smoke              run smoke tests against running services
  build              run \`npm run build\` only

Options:
  --mode dev|prod    dev (default): backend + Vite. prod: backend only (serves dist).
  --sandbox          enable pi-sandbox in backend
  --no-sandbox       disable pi-sandbox (default)
  --skip-build       skip build during restart
  --home <path>      runtime home dir          (default: ./runtime)
  --workspace <path> agent workspace dir       (default: ./workspace)
  --port <n>         backend port              (default: 3000)
  --web-port <n>     Vite port (dev mode only) (default: 5173)
  --tail             after starting, follow server.log in foreground
  -h, --help         show this help

Env vars: INNO_HOME, INNO_WORKSPACE, INNO_PORT, INNO_WEB_PORT, INNO_MODE, INNO_SANDBOX

Examples:
  ./restart-dev.sh                            # build + dev mode (server + vite)
  ./restart-dev.sh --skip-build               # restart without rebuilding
  ./restart-dev.sh --mode prod --skip-build   # restart backend only against built dist
  ./restart-dev.sh restart --sandbox          # rebuild and start with sandbox
  ./restart-dev.sh stop                       # stop everything
  ./restart-dev.sh status                     # show what's running
  ./restart-dev.sh logs server                # tail server.log
  ./restart-dev.sh smoke                      # quick health + WS upgrade probe
EOF
}

# --- Argument parsing ---
# First positional arg may be a command; otherwise default to `restart`.
case "${1:-}" in
	restart | start | stop | status | logs | smoke | build)
		CMD="$1"
		shift
		;;
esac

LOGS_TARGET="both"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-build) SKIP_BUILD=true; shift ;;
		--sandbox)    SANDBOX=true; shift ;;
		--no-sandbox) SANDBOX=false; shift ;;
		--mode)       MODE="$2"; shift 2 ;;
		--home)       INNO_HOME="$2"; shift 2 ;;
		--workspace)  WORKSPACE="$2"; shift 2 ;;
		--port)       PORT="$2"; shift 2 ;;
		--web-port)   WEB_PORT="$2"; shift 2 ;;
		--tail)       TAIL_AFTER=true; shift ;;
		-h | --help)  usage; exit 0 ;;
		server | vite | both)
			# Positional arg for `logs` subcommand.
			if [[ "$CMD" == "logs" ]]; then
				LOGS_TARGET="$1"; shift
			else
				echo "Unexpected argument: $1" >&2; usage >&2; exit 1
			fi
			;;
		*)
			echo "Unknown option: $1" >&2; usage >&2; exit 1
			;;
	esac
done

if [[ "$MODE" != "dev" && "$MODE" != "prod" ]]; then
	echo "Invalid --mode: $MODE (expected 'dev' or 'prod')" >&2
	exit 1
fi

LOG_DIR="${INNO_HOME}/logs"
SERVER_LOG="${LOG_DIR}/server.log"
VITE_LOG="${LOG_DIR}/vite.log"
SERVER_PID_FILE="${LOG_DIR}/server.pid"
VITE_PID_FILE="${LOG_DIR}/vite.pid"

mkdir -p "$LOG_DIR"

# --- Helpers ---

color() { local c="$1"; shift; printf '\033[%sm%s\033[0m' "$c" "$*"; }
ok()    { printf '%s %s\n' "$(color '32' '✓')" "$*"; }
warn()  { printf '%s %s\n' "$(color '33' '!')" "$*"; }
fail()  { printf '%s %s\n' "$(color '31' '✗')" "$*"; }
info()  { printf '%s %s\n' "$(color '36' 'i')" "$*"; }

pid_alive() {
	local pid="$1"
	[[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
	local f="$1"
	[[ -f "$f" ]] && cat "$f" 2>/dev/null || echo ""
}

kill_pidfile() {
	local f="$1"
	local pid
	pid="$(read_pid "$f")"
	if pid_alive "$pid"; then
		kill "$pid" 2>/dev/null || true
		# Give it a moment, then SIGKILL if still alive.
		for _ in 1 2 3 4 5; do
			pid_alive "$pid" || break
			sleep 0.2
		done
		pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
	fi
	rm -f "$f"
}

free_port() {
	local p="$1"
	local pids
	pids="$(lsof -ti tcp:"$p" 2>/dev/null || true)"
	if [[ -n "$pids" ]]; then
		# shellcheck disable=SC2086
		kill $pids 2>/dev/null || true
		sleep 0.3
		pids="$(lsof -ti tcp:"$p" 2>/dev/null || true)"
		[[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
	fi
}

stop_services() {
	info "stopping services..."
	kill_pidfile "$SERVER_PID_FILE"
	kill_pidfile "$VITE_PID_FILE"
	# Belt-and-braces: pattern match for this project root only, plus free ports.
	pkill -f "node .*apps/inno-agent/dist/server\.js.*--home ${INNO_HOME}" 2>/dev/null || true
	pkill -f "vite.*--port ${WEB_PORT}" 2>/dev/null || true
	free_port "$PORT"
	[[ "$MODE" == "dev" ]] && free_port "$WEB_PORT"
	ok "stopped"
}

wait_for_url() {
	local url="$1" label="$2"
	for _ in $(seq 1 40); do
		if curl -sf "$url" >/dev/null 2>&1; then
			ok "${label} ready"
			return 0
		fi
		sleep 0.5
	done
	warn "${label} did not become ready in time ($url)"
	return 1
}

# Build a clean restart of the configured services.
start_services() {
	# Verify build output exists if we're not building.
	if [[ "$SKIP_BUILD" == true ]]; then
		[[ -f apps/inno-agent/dist/server.js ]] || { fail "no apps/inno-agent/dist — run without --skip-build first"; exit 1; }
		[[ "$MODE" == "prod" && ! -f apps/inno-agent/web/dist/index.html ]] && { fail "no web/dist — run a build first"; exit 1; }
	fi

	# Compose server args.
	local server_args=(--home "$INNO_HOME" --workspace "$WORKSPACE" --port "$PORT")
	[[ "$SANDBOX" == true ]] && server_args+=(--sandbox)

	info "starting backend on :${PORT}  (mode=${MODE} sandbox=${SANDBOX})"
	info "  home=${INNO_HOME} workspace=${WORKSPACE}"
	nohup npm run server -- "${server_args[@]}" >"$SERVER_LOG" 2>&1 &
	echo $! >"$SERVER_PID_FILE"

	if [[ "$MODE" == "dev" ]]; then
		info "starting Vite dev on :${WEB_PORT}"
		nohup npm run web:dev -- --port "$WEB_PORT" >"$VITE_LOG" 2>&1 &
		echo $! >"$VITE_PID_FILE"
	fi

	wait_for_url "http://localhost:${PORT}/health" "backend" || true
	if [[ "$MODE" == "dev" ]]; then
		wait_for_url "http://localhost:${WEB_PORT}/" "vite" || true
	fi

	echo
	ok "ready"
	echo "  backend:  http://localhost:${PORT}"
	if [[ "$MODE" == "dev" ]]; then
		echo "  frontend: http://localhost:${WEB_PORT}  (HMR)"
	else
		echo "  frontend: http://localhost:${PORT}      (served from web/dist)"
	fi
	echo "  logs:     ${LOG_DIR}/"
	echo
	echo "Try:"
	echo "  ./restart-dev.sh status"
	echo "  ./restart-dev.sh logs server"
	echo "  ./restart-dev.sh smoke"
}

show_status() {
	local server_pid vite_pid backend_health vite_health
	server_pid="$(read_pid "$SERVER_PID_FILE")"
	vite_pid="$(read_pid "$VITE_PID_FILE")"

	echo "Backend (:${PORT})"
	if pid_alive "$server_pid"; then
		ok "  pid ${server_pid} alive"
	else
		warn "  pidfile missing or process dead"
	fi
	if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
		backend_health="$(curl -s "http://localhost:${PORT}/health")"
		ok "  /health → ${backend_health}"
	else
		fail "  /health unreachable"
	fi

	echo
	echo "Vite (:${WEB_PORT})"
	if pid_alive "$vite_pid"; then
		ok "  pid ${vite_pid} alive"
	else
		warn "  pidfile missing or process dead"
	fi
	if curl -sfI "http://localhost:${WEB_PORT}/" >/dev/null 2>&1; then
		vite_health="$(curl -sI "http://localhost:${WEB_PORT}/" | head -n1)"
		ok "  ${vite_health}"
	else
		warn "  not reachable (expected in --mode prod)"
	fi

	echo
	echo "Logs: ${LOG_DIR}/"
}

# Minimal smoke test: health + sessions list + create+close terminal + WS upgrade probe.
run_smoke() {
	local base="http://localhost:${PORT}"
	local fail_count=0

	info "1/4 GET /health"
	if curl -sf "${base}/health" >/dev/null; then ok "  ok"; else fail "  unreachable"; fail_count=$((fail_count+1)); fi

	info "2/4 GET /api/workspaces"
	local resp
	if resp="$(curl -sf "${base}/api/workspaces" 2>/dev/null)"; then
		ok "  $(echo "$resp" | tr ',' '\n' | grep -c '"id"') workspace(s) registered"
	else
		fail "  /api/workspaces failed"; fail_count=$((fail_count+1))
	fi

	info "3/4 POST /api/sessions + terminal create"
	local session_id workspace_id term_id
	session_id="$(curl -sf -X POST "${base}/api/sessions" -H 'Content-Type: application/json' -d '{}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
	workspace_id="$(curl -sf "${base}/api/sessions/${session_id}/workspace" | sed -n 's/.*"workspaceId":"\([^"]*\)".*/\1/p')"
	if [[ -n "$session_id" && -n "$workspace_id" ]]; then
		ok "  session=${session_id:0:24}… workspace=${workspace_id}"
	else
		fail "  could not create session"; fail_count=$((fail_count+1))
	fi
	term_id="$(curl -sf -X POST "${base}/api/terminal/sessions" -H 'Content-Type: application/json' -d "{\"sessionId\":\"${session_id}\"}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
	if [[ -n "$term_id" ]]; then
		ok "  terminal=${term_id}"
	else
		fail "  could not create terminal"; fail_count=$((fail_count+1))
	fi

	info "4/4 WebSocket upgrade probe"
	# curl returns the status of the HTTP→WS upgrade response. We don't actually
	# want to *stay* connected, so cap it with --max-time. Status 000 + timeout
	# is fine as long as we saw 101 in the headers.
	local headers
	headers="$(curl -s -i --max-time 2 \
		--http1.1 \
		-H "Connection: Upgrade" \
		-H "Upgrade: websocket" \
		-H "Sec-WebSocket-Version: 13" \
		-H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
		"${base}/api/terminal/sessions/${term_id}/ws" 2>/dev/null | head -n1 || true)"
	if [[ "$headers" == *"101"* ]]; then
		ok "  101 Switching Protocols"
	else
		fail "  no 101 upgrade (got: ${headers:-no response})"
		fail_count=$((fail_count+1))
	fi

	# Cleanup the throw-away session.
	[[ -n "$term_id" ]] && curl -sf -X POST "${base}/api/terminal/sessions/${term_id}/close" >/dev/null || true
	[[ -n "$session_id" ]] && curl -sf -X DELETE "${base}/api/sessions/${session_id}" >/dev/null || true

	echo
	if (( fail_count == 0 )); then
		ok "smoke passed"
	else
		fail "${fail_count} check(s) failed"
		exit 1
	fi
}

tail_logs() {
	local files=()
	case "$LOGS_TARGET" in
		server) files=("$SERVER_LOG") ;;
		vite)   files=("$VITE_LOG") ;;
		both)   files=("$SERVER_LOG" "$VITE_LOG") ;;
		*)      fail "Unknown logs target: $LOGS_TARGET"; exit 1 ;;
	esac
	for f in "${files[@]}"; do
		[[ -f "$f" ]] || warn "missing: $f"
	done
	exec tail -F "${files[@]}"
}

# --- Dispatch ---
case "$CMD" in
	restart)
		if [[ "$SKIP_BUILD" == false ]]; then
			info "running build (npm run build)"
			npm run build
		else
			info "skipping build"
		fi
		stop_services
		start_services
		[[ "$TAIL_AFTER" == true ]] && exec tail -F "$SERVER_LOG"
		;;
	start)
		stop_services
		start_services
		[[ "$TAIL_AFTER" == true ]] && exec tail -F "$SERVER_LOG"
		;;
	stop)
		stop_services
		;;
	status)
		show_status
		;;
	logs)
		tail_logs
		;;
	smoke)
		run_smoke
		;;
	build)
		npm run build
		ok "build done"
		;;
esac
