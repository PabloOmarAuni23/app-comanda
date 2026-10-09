@echo off
setlocal
cd /d "%~dp0"
title Comanda del bar

if "%PORT%"=="" set PORT=8000

set PY=
where py >nul 2>nul && set PY=py -3
if "%PY%"=="" where python >nul 2>nul && set PY=python
if "%PY%"=="" (
  echo No se encontro Python. Instalalo desde https://www.python.org/downloads/
  echo Marca la casilla "Add python.exe to PATH" durante la instalacion y volve a abrir este archivo.
  pause
  exit /b 1
)

if not exist ".deps-instaladas" (
  echo Instalando lo necesario la primera vez, puede tardar un minuto...
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias. Revisa la conexion a internet y volve a intentar.
    pause
    exit /b 1
  )
  echo ok> .deps-instaladas
)

echo.
echo ============================================================
echo   COMANDA DEL BAR esta funcionando. No cierres esta ventana.
echo.
echo   En esta PC:        http://localhost:%PORT%
echo   En los telefonos (conectados al mismo WiFi):
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { '       http://' + $_.IPAddress + ':%PORT%' }"
echo ============================================================
echo.

if not defined NO_BROWSER start "" "http://localhost:%PORT%"
%PY% -m waitress --listen=0.0.0.0:%PORT% --threads=8 app:app

echo.
echo El servidor se detuvo.
pause