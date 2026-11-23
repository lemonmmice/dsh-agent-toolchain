@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0scripts\install-client.mjs" %*
) else (
  node "%~dp0scripts\install-client.mjs" %*
)
set "dsh_exit=%errorlevel%"
if not "%dsh_exit%"=="0" echo Installation failed. See the error above.
pause
exit /b %dsh_exit%
