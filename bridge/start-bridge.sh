#!/usr/bin/env bash
# zen-bridge launcher (Linux / macOS) with an auto-restart loop.
#
# The gateway points at this bridge; if it dies, every free model goes dark,
# so the wrapper restarts it instead of giving up.
set -u

cd "$(dirname "$0")"

LOG="zen-bridge.log"
NODE="${NODE:-node}"

# --- free-lane backpressure -------------------------------------------------
# Zen meters the anonymous free lane per model AND per IP, while the gateway's
# cooldown is per account. These knobs stop one consumer from exhausting the
# quota for everyone. Raise ZEN_MAX_INPUT_CHARS only when your clients genuinely
# need very long context; oversized prompts are what burned a whole quota in a
# single day once.
export ZEN_MIN_GAP_MS="${ZEN_MIN_GAP_MS:-9000}"
export ZEN_MAX_INFLIGHT="${ZEN_MAX_INFLIGHT:-1}"
export ZEN_MAX_TOTAL="${ZEN_MAX_TOTAL:-2}"
export ZEN_QUEUE_MAX="${ZEN_QUEUE_MAX:-6}"
export ZEN_MAX_INPUT_CHARS="${ZEN_MAX_INPUT_CHARS:-120000}"
export ZEN_MAX_OUTPUT_TOKENS="${ZEN_MAX_OUTPUT_TOKENS:-8000}"
export ZEN_TRIP_COOLDOWN_MS="${ZEN_TRIP_COOLDOWN_MS:-120000}"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting zen-bridge" >> "$LOG"
  "$NODE" zen-bridge.mjs >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] zen-bridge exited, restarting in 5s" >> "$LOG"
  sleep 5
done