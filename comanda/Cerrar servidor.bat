@echo off
chcp 65001 >nul
echo Cerrando el servidor de Comanda...
powershell.exe -NoProfile -Command "$servers = Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" | Where-Object { $_.CommandLine -match 'waitress.*--listen=127\.0\.0\.1:8000(\s|$)' }; if ($servers) { foreach ($server in $servers) { Stop-Process -Id $server.ProcessId -ErrorAction Stop }; Write-Host 'Servidor cerrado. Los datos guardados se conservan.' } else { Write-Host 'El servidor ya estaba cerrado.' }"
if errorlevel 1 echo No se pudo cerrar el servidor. Revisa el mensaje de arriba.
echo.
echo Ya podes cerrar esta ventana.
pause
