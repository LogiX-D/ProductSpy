@echo off
setlocal
if not exist "%~dp0launcher\ProductSpy.ps1" (
  echo ProductSpy launcher is missing. Please extract the complete ZIP first.
  pause
  exit /b 1
)
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\ProductSpy.ps1"
exit /b
