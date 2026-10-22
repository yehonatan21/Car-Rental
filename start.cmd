@echo off
rem One-click local start on Windows: installs dependencies, creates demo data, starts https://localhost:3000
setlocal
cd /d "%~dp0"
title Car Rental - https://localhost:3000

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo Node.js 22.13 or newer is required. You have:
  node --version
  echo Install the current LTS version from https://nodejs.org and run this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :error
)
if not exist .env copy .env.development.example .env >nul

call npm run seed
if errorlevel 1 goto :error

echo.
echo ============================================================
echo  Opening https://localhost:3000
echo  The browser will warn about the certificate (self-signed for
echo  localhost): click "Advanced" and then "Proceed to localhost".
echo.
echo  Admin login:  admin@example.org / Password1
echo  User login:   noa@example.org   / Password1
echo  E-mails are saved in the data\outbox folder.
echo  Press Ctrl+C in this window to stop the server.
echo ============================================================
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start https://localhost:3000"
call npm run dev
goto :eof

:error
echo.
echo Something went wrong - see the messages above.
pause
exit /b 1
