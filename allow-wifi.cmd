@echo off
rem Lets phones and computers on your Wi-Fi open the dev server: adds a Windows Firewall rule
rem for TCP port 3000 on PRIVATE networks only, then shows the addresses to use.
setlocal
set PORT=3000
set RULE=Car Rental dev (port %PORT%)

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator permission to change the firewall...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=%PORT% profile=private >nul
if errorlevel 1 (
  echo Could not add the firewall rule.
  pause
  exit /b 1
)

echo.
echo Firewall rule added: inbound TCP %PORT% on private networks.
echo.
echo Your Wi-Fi network must be set to "Private" (Settings ^> Network ^& internet ^> Wi-Fi ^> your network ^> Private network).
echo.
echo While the app is running (start.cmd), open one of these on another device on the same Wi-Fi:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { '    https://' + $_.IPAddress + ':%PORT%    (' + $_.InterfaceAlias + ')' }"
echo.
echo The device will warn about the certificate once: choose "Advanced" and continue.
echo.
pause
