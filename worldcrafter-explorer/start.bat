@echo off
rem Double-click to start WorldCrafter Explorer and open it in your browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Get it from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\@gradio\client" (
  echo Installing dependencies, one time only...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server.js --open %*
pause
