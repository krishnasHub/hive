@echo off
rem Runs Hive from source on Windows.
rem   start.bat          build and start Hive
rem   start.bat --dev    start with hot reload while you work on Hive
rem Anything else is passed to the app, e.g. start.bat --hidden starts in the tray.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Hive needs Node.js 20 or newer: https://nodejs.org
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"
if errorlevel 1 (
  echo Hive needs Node.js 20 or newer: https://nodejs.org
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

if /i "%~1"=="--dev" (
  call npm run dev
  exit /b
)

cd apps\desktop
echo Building Hive...
call npx electron-vite build
if errorlevel 1 exit /b 1
call npx electron . %*
