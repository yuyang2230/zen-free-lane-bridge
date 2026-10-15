@echo off
REM ---------------------------------------------------------------------------
REM zen-bridge auto-restart launcher (Windows)
REM
REM The AI gateway points at this bridge. If the bridge dies, every free model
REM goes down, so this wrapper restarts it instead of giving up.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "LOG=%~dp0zen-bridge.log"
if "%NODE%"=="" set "NODE=node.exe"

REM ---------------------------------------------------------------------------
REM Free-lane backpressure. Zen meters the anonymous free lane per model and
REM per IP, while the gateway cooldown is per account. These knobs stop one
REM consumer from exhausting the quota for everyone.
REM
REM ZEN_MAX_INPUT_CHARS must be >= what your clients actually send. Agents that
REM are configured with a large context window (e.g. 1M) will NOT trim history
REM and will hit this cap with 413. Either lower the client's context label or
REM raise this (e.g. 4000000 to admit a full 1M-token conversation).
REM Restart the bridge after editing.
REM ---------------------------------------------------------------------------
if "%ZEN_MIN_GAP_MS%"=="" set "ZEN_MIN_GAP_MS=9000"
if "%ZEN_MAX_INFLIGHT%"=="" set "ZEN_MAX_INFLIGHT=1"
if "%ZEN_MAX_TOTAL%"=="" set "ZEN_MAX_TOTAL=2"
if "%ZEN_QUEUE_MAX%"=="" set "ZEN_QUEUE_MAX=6"
if "%ZEN_MAX_INPUT_CHARS%"=="" set "ZEN_MAX_INPUT_CHARS=120000"
if "%ZEN_MAX_OUTPUT_TOKENS%"=="" set "ZEN_MAX_OUTPUT_TOKENS=8000"
if "%ZEN_TRIP_COOLDOWN_MS%"=="" set "ZEN_TRIP_COOLDOWN_MS=120000"

REM Upstream mode: "ocserver" rides a local headless opencode server (the only
REM transport the free-lane gate currently accepts — see docs/root-cause.md).
REM Requires `opencode serve` running (deploy\start-ocserver.cmd / task).
if "%ZEN_MODE%"=="" set "ZEN_MODE=ocserver"
if "%OCC_URL%"=="" set "OCC_URL=http://127.0.0.1:4096"

:loop
echo [%date% %time%] starting zen-bridge >> "%LOG%"
"%NODE%" "%~dp0zen-bridge.mjs" >> "%LOG%" 2>&1
echo [%date% %time%] zen-bridge exited, restarting in 5s >> "%LOG%"
timeout /t 5 /nobreak >nul
goto loop