@echo off
cd /d "%~dp0"
title Porkfolio Launcher
echo.
echo  ================================
echo    Porkfolio - AIO PS5 Utility
echo  ================================
echo.

:: Check Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install it from https://nodejs.org
    pause
    exit /b 1
)

:: Install / restore dependencies
echo [Porkfolio] Checking dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo.

:: Generate icon only if one does not already exist
if not exist build\icon.png (
    echo [Porkfolio] No icon found - generating default icon...
    call node scripts/gen-icon.js
    if %errorlevel% neq 0 (
        echo [WARN] Icon generation failed - app will use default Electron icon.
        echo.
    )
)

echo [Porkfolio] Starting...
echo.
call npm start
