@echo off
setlocal
cd /d "%~dp0"
set LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Comanda del bar.lnk
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%'); $s.TargetPath='%~dp0iniciar-comanda.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if exist "%LINK%" (
  echo Listo: la comanda se va a iniciar sola cada vez que se prenda esta PC.
) else (
  echo No se pudo crear el acceso directo.
)
pause