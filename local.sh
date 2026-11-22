#!/usr/bin/env bash
# Usage: ./local.sh [start|stop|restart|status] [--lan] [--lan-address IPv4]
# Works on macOS, Linux and WSL.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
PID_FILE=".local-server.pid"
LOG=".local-server.log"
PORT=8787

ACTION="start"
LAN=0
LAN_ADDRESS=""
while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    start|stop|restart|status) ACTION="$arg" ;;
    --lan|-l) LAN=1 ;;
    --lan-address) shift; LAN_ADDRESS="${1:?Missing LAN IPv4 address}" ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
  shift
done
SCHEME=http
[ "$LAN" = 1 ] && SCHEME=https

running_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then echo "$pid"; return; fi
    rm -f "$PID_FILE"
  fi
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
  fi
}

# node_modules installed from another OS (e.g. Windows via a WSL mount) lacks this platform's workerd binary.
workerd_pkg() {
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; *) os=linux ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; *) arch=64 ;; esac
  echo "node_modules/@cloudflare/workerd-$os-$arch"
}

do_stop() {
  local pid
  pid="$(running_pid)"
  if [ -z "$pid" ]; then echo "Not running."; return; fi
  kill_tree "$pid"
  rm -f "$PID_FILE"
  echo "Stopped (PID $pid)."
}

do_start() {
  local pid
  pid="$(running_pid)"
  if [ -n "$pid" ]; then
    echo "Already running (PID $pid). Use './local.sh restart' to change mode."
    return
  fi
  if port_in_use; then
    echo "Port $PORT is already in use by another process." >&2
    exit 1
  fi

  if [ ! -d node_modules ] || [ ! -d "$(workerd_pkg)" ]; then npm install; fi
  npm run build

  local args=(node node_modules/wrangler/bin/wrangler.js dev --port "$PORT" --var DEV_MODE:1)
  # HTTPS is required off-localhost: WebCrypto is only available in secure contexts
  if [ "$LAN" = 1 ]; then
    if [ -z "$LAN_ADDRESS" ]; then
      LAN_ADDRESS="$(node scripts/lan-address.mjs)" || { echo "Specify the host IPv4 address with --lan-address." >&2; exit 1; }
    fi
    node -e 'const net = require("node:net"); const ip = process.argv[1]; if (net.isIP(ip) !== 4 || ip.startsWith("127.") || ip === "0.0.0.0") process.exit(1)' "$LAN_ADDRESS" || {
      echo "LAN address must be a non-loopback IPv4 address." >&2; exit 1;
    }
    args+=(--ip 0.0.0.0 --local-protocol https --var "LAN_ADDRESS:$LAN_ADDRESS")
  fi
  nohup "${args[@]}" >"$LOG" 2>&1 </dev/null &
  pid=$!
  echo "$pid" >"$PID_FILE"

  local i
  for ((i = 0; i < 240; i++)); do
    sleep 0.5
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Server exited. See $LOG" >&2
      exit 1
    fi
    if curl -sk -m 2 -o /dev/null "$SCHEME://localhost:$PORT/api/config"; then
      echo "secure-send running (PID $pid) at $SCHEME://localhost:$PORT"
      if [ "$LAN" = 1 ]; then
        echo "LAN invite address: https://$LAN_ADDRESS:$PORT  (accept the self-signed cert warning)"
      fi
      echo "Local dev mode: Turnstile disabled. Stop with './local.sh stop'."
      return
    fi
  done
  echo "Timed out waiting for the server. See $LOG" >&2
  exit 1
}

case "$ACTION" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status)
    pid="$(running_pid)"
    if [ -n "$pid" ]; then echo "Running (PID $pid) on port $PORT."; else echo "Not running."; fi
    ;;
esac
