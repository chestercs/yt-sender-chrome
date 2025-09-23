@echo off
setlocal

set "SRC=src"
set "DIST=dist"
set "ZIP=%DIST%\YT-Sender.zip"

if not exist "%SRC%\manifest.json" (
  echo [ERROR] %SRC%\manifest.json not found.
  exit /b 1
)

if not exist "%DIST%" mkdir "%DIST%" >nul 2>nul
if exist "%ZIP%" del /f /q "%ZIP%" >nul 2>nul

REM --- Pack ONLY the CONTENTS of src/ into the ZIP root ---
powershell -NoProfile -Command "Compress-Archive -Path '%SRC%\*' -DestinationPath '%ZIP%' -Force"

if errorlevel 1 (
  echo [ERROR] Compress-Archive failed.
  exit /b 1
)

echo Done. Created "%ZIP%".
exit /b 0
