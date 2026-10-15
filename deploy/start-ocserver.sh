#!/usr/bin/env bash
# opencode serve keep-alive (Linux / macOS) — backend for zen-bridge ocserver
# mode. The bridge forwards free-lane requests to this headless server, which
# talks to opencode.ai with the real binary's TLS stack.
set -u

cd "$(dirname "$0")"

LOG="ocserver.log"
OC_PORT="${OC_PORT:-4096}"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting opencode serve --port $OC_PORT" >> "$LOG"
  opencode serve --port "$OC_PORT" >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] opencode serve exited, restarting in 5s" >> "$LOG"
  sleep 5
done
