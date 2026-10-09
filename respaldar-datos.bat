@echo off
setlocal
cd /d "%~dp0"
if not exist "instance\comanda.sqlite3" (
  echo Todavia no hay datos para respaldar.
  pause
  exit /b 1
)
if not exist "respaldos" mkdir "respaldos"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm"') do set STAMP=%%i
copy /y "instance\comanda.sqlite3" "respaldos\comanda_%STAMP%.sqlite3" >nul
echo Respaldo guardado en la carpeta "respaldos": comanda_%STAMP%.sqlite3
echo Para restaurarlo: cerra la comanda y copia ese archivo sobre instance\comanda.sqlite3
pause