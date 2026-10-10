@echo off
setlocal

cd /d "%~dp0"

echo [1/4] Verificando Python...
where py >nul 2>nul
if %errorlevel%==0 (
    echo Usando: py -3
    set PY=py -3
) else (
    echo Usando: python
    set PY=python
)

echo.
echo [2/4] Instalando PyInstaller...
%PY% -m pip install --upgrade PyInstaller
if %errorlevel% neq 0 (
    echo ERROR: No se pudo instalar PyInstaller.
    pause
    exit /b 1
)

echo.
echo [3/4] Creando el ejecutable...
%PY% -m PyInstaller ^
    --name=ComanDeBar ^
    --onefile ^
    --windowed ^
    --add-data "static;static" ^
    --add-data "templates;templates" ^
    --hidden-import=carta ^
    --hidden-import=storage ^
    --collect-all=flask ^
    --collect-all=werkzeug ^
    --collect-all=jinja2 ^
    --collect-all=itsdangerous ^
    --collect-all=click ^
    --collect-all=blinker ^
    --collect-all=markupsafe ^
    --collect-all=sqlalchemy ^
    --collect-all=psycopg ^
    --collect-all=waitress ^
    app.py

if %errorlevel% neq 0 (
    echo ERROR: PyInstaller falló.
    pause
    exit /b 1
)

echo.
echo [4/4] Ejecutable listo: dist\ComanDeBar.exe
echo.
echo Para usar:
echo   1) Abre ComanDeBar.exe
echo   2) En la misma red, abrí http://<IP-de-la-pc>:8000 desde los teléfonos
echo   3) Si tenés base SQLite local, la usa instance/comanda.sqlite3
echo   4) Para Render o Nginx, usar app.py directamente con gunicorn/waitress
pause
