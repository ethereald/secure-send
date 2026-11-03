#!/usr/bin/env bash
# Usage: ./local.sh [start|stop|restart|status] [--lan]
# Works on macOS, Linux and WSL.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
PID_FILE=".local-server.pid"
LOG=".local-server.log"
PORT=8787

ACTION="start"
LAN=0
for arg in "$@"; do
  case "$arg" in
    start|stop|restart|status) ACTION="$arg" ;;
    --lan|-l) LAN=1 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
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

lan_ips() {
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.' || true
  elif command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1; do ipconfig getifaddr "$iface" 2>/dev/null || true; done
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
  [ "$LAN" = 1 ] && args+=(--ip 0.0.0.0 --local-protocol https)
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
        lan_ips | while read -r ip; do
          [ -n "$ip" ] && echo "LAN: https://$ip:$PORT  (accept the self-signed cert warning)"
        done
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
