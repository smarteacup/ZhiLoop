@echo off
where zhiloop-sidecar.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  zhiloop-sidecar.exe %*
  exit /b %ERRORLEVEL%
)
if "%~1"=="hook" (
  exit /b 0
)
echo ZhiLoop sidecar is not installed or not on PATH. 1>&2
exit /b 127
