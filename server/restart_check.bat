@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\restart_and_check.ps1"
echo.
pause
