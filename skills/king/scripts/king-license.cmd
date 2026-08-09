@echo off
setlocal

set "KING_SCRIPT_DIR=%~dp0"

if defined KING_NODE_PATH if exist "%KING_NODE_PATH%" (
  "%KING_NODE_PATH%" "%KING_SCRIPT_DIR%king-license.mjs" %*
  exit /b %errorlevel%
)

where node.exe >nul 2>nul
if not errorlevel 1 (
  node.exe "%KING_SCRIPT_DIR%king-license.mjs" %*
  exit /b %errorlevel%
)

1>&2 echo KING requires Node.js. Install or update Codex, or set KING_NODE_PATH to node.exe.
exit /b 127
