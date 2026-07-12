@echo off
setlocal
cd /d "%~dp0"

echo ================================
echo  PSNotifyModule - Standalone Test
echo ================================
echo.

:: Check Node is available
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not on PATH.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

set /p PS5_IP=Enter PS5 IP address: 
if "%PS5_IP%"=="" (
    echo No IP entered. Exiting.
    pause
    exit /b 1
)

set /p MSG=Message (leave blank for default test): 
set /p SUB=Sub-message (leave blank to skip): 

echo.
echo Running test against %PS5_IP%:6969 ...
echo.

if "%MSG%"=="" (
    node test.js %PS5_IP%
) else if "%SUB%"=="" (
    node test.js %PS5_IP% "%MSG%"
) else (
    node test.js %PS5_IP% "%MSG%" "%SUB%"
)

echo.
pause
