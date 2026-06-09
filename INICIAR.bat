@echo off
setlocal EnableDelayedExpansion
title JIREHAI - Iniciando...
color 0A
cls

echo.
echo  ===========================================================
echo    JIREHAI -- Plataforma de Licitaciones SECOP II
echo  ===========================================================
echo.

:: ================================================================
:: 1. Verificar Node.js
:: ================================================================
node --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: Node.js NO esta instalado.
    echo.
    echo  Descargalo gratuitamente en:
    echo    https://nodejs.org  ^(version LTS recomendada^)
    echo.
    echo  Luego cierra esta ventana y vuelve a ejecutar INICIAR.bat
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo  OK  Node.js !NODE_VER! encontrado

:: ================================================================
:: 2. Moverse a la carpeta del backend
:: ================================================================
cd /d "%~dp0backend"
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: No se encontro la carpeta backend.
    echo  Asegurate de ejecutar este archivo desde la carpeta jieredai\
    pause
    exit /b 1
)
echo  OK  Carpeta backend encontrada

:: ================================================================
:: 3. Leer el puerto desde .env (por defecto 3001)
:: ================================================================
set PORT=3001
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set "KEY=%%a"
        set "VAL=%%b"
        if /i "!KEY!"=="PORT" (
            :: Limpiar espacios y caracteres ocultos
            set "VAL=!VAL: =!"
            for /f "tokens=1" %%p in ("!VAL!") do set PORT=%%p
        )
    )
    echo  OK  Archivo .env encontrado  ^(puerto: !PORT!^)
) else (
    echo  AVISO: No hay archivo .env — usando puerto por defecto: !PORT!
)

:: ================================================================
:: 4. Si ya hay un servidor en ese puerto, cerrarlo
:: ================================================================
netstat -ano 2>nul | findstr ":!PORT! " | findstr "LISTEN" >nul
if !errorlevel! == 0 (
    echo.
    echo  Aviso: El puerto !PORT! ya esta en uso.
    echo  Cerrando instancia anterior...
    for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":!PORT! " ^| findstr "LISTEN"') do (
        taskkill /F /PID %%p >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    echo  OK  Instancia anterior cerrada
)

:: ================================================================
:: 5. Instalar dependencias si no existen
:: ================================================================
if not exist "node_modules\" (
    echo.
    echo  Instalando dependencias por primera vez...
    echo  ^(puede tardar 2-3 minutos, ten paciencia^)
    echo.
    call npm install 2>&1
    if !errorlevel! neq 0 (
        color 0C
        echo.
        echo  ERROR al instalar dependencias.
        echo  Asegurate de tener conexion a internet y vuelve a intentar.
        pause
        exit /b 1
    )
    echo.
    echo  OK  Dependencias instaladas correctamente
) else (
    echo  OK  Dependencias OK
)

:: ================================================================
:: 6. Abrir el servidor en una ventana separada (visible, con logs)
:: ================================================================
echo.
echo  Iniciando servidor JIREHAI en segundo plano...
start "JIREHAI Backend - No cierres esta ventana" cmd /k "title JIREHAI Backend && color 0A && echo. && echo  JIREHAI Backend corriendo... && echo  Deja esta ventana abierta mientras usas la aplicacion. && echo  Presiona Ctrl+C para detenerlo. && echo. && node server.js"

:: ================================================================
:: 7. Esperar a que el servidor responda (hasta 30 segundos)
:: ================================================================
echo.
echo  Esperando a que el servidor este listo...
set RETRIES=0

:wait_loop
timeout /t 1 /nobreak >nul
set /a RETRIES+=1

:: Usar PowerShell para el health-check (disponible en Windows 7+)
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:!PORT!/api/health' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if !errorlevel! == 0 goto server_ready

if !RETRIES! geq 30 (
    color 0E
    echo.
    echo  Aviso: El servidor tardo demasiado en responder.
    echo.
    echo  Es posible que haya un error. Revisa la ventana "JIREHAI Backend".
    echo  Si vez que el servidor esta corriendo, abre manualmente:
    echo    http://localhost:!PORT!/JIREHAI.html
    echo.
    pause
    exit /b 0
)

if !RETRIES! == 5  echo  Aun iniciando...  ^(5 seg^)
if !RETRIES! == 10 echo  Aun iniciando...  ^(10 seg^)
if !RETRIES! == 20 echo  Aun iniciando...  ^(20 seg^)
goto wait_loop

:: ================================================================
:: 8. Servidor listo — mostrar info y abrir navegador
:: ================================================================
:server_ready
cls
color 0A
echo.
echo  ===========================================================
echo    JIREHAI esta corriendo correctamente
echo  ===========================================================
echo.
echo  Aplicacion principal:   http://localhost:!PORT!/JIREHAI.html
echo  Panel de Administracion: http://localhost:!PORT!/admin.html
echo  Estado del servidor:    http://localhost:!PORT!/api/health
echo.
echo  Abriendo el navegador...
echo.
start "" "http://localhost:!PORT!/JIREHAI.html"

echo  ===========================================================
echo.
echo  IMPORTANTE:
echo    - Deja abierta la ventana "JIREHAI Backend" mientras usas
echo      la aplicacion. Si la cierras, el servidor se detendra.
echo.
echo    - Para detener todo, cierra la ventana "JIREHAI Backend"
echo      o presiona Ctrl+C en ella.
echo.
echo  Puedes cerrar ESTA ventana ahora.
echo.
echo  ===========================================================
echo.
pause
exit /b 0
