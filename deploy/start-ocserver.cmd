@echo off
REM ---------------------------------------------------------------------------
REM opencode serve keep-alive (Windows) — backend for zen-bridge ocserver mode.
REM
REM The bridge (ZEN_MODE=ocserver) forwards free-lane requests to this headless
REM server, which talks to opencode.ai with the real binary's TLS stack — the
REM only transport the free-lane gate currently accepts. If it dies the free
REM lane goes dark, so restart it instead of giving up.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "LOG=%~dp0ocserver.log"
if "%OC_PORT%"=="" set "OC_PORT=4096"

:loop
echo [%date% %time%] starting opencode serve --port %OC_PORT% >> "%LOG%"
opencode serve --port %OC_PORT% >> "%LOG%" 2>&1
echo [%date% %time%] opencode serve exited, restarting in 5s >> "%LOG%"
timeout /t 5 /nobreak >nul
goto loop
