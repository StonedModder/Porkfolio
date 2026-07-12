@echo off
setlocal EnableDelayedExpansion
title Porkfolio — Build Distributable

:: ── Auto-elevate to Administrator ─────────────────────────────────────────────
:: electron-builder needs admin to create symlinks in its winCodeSign cache.
net session >nul 2>&1
if errorlevel 1 (
    echo [INFO] Requesting Administrator elevation…
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Work from the folder containing this script
cd /d "%~dp0"

echo.
echo ============================================================
echo   Porkfolio — Build Distributable
echo ============================================================
echo.

:: ── Prerequisite: Node.js ─────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo         Download from https://nodejs.org/
    pause & exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%
echo.

:: ── 1. Install / refresh dependencies ────────────────────────────────────────
echo [1/4] Installing dependencies…
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo [ERROR] npm install failed. See output above.
    pause & exit /b 1
)
echo       Done.
echo.

:: ── 2. Generate icon.png (pure Node.js, no extra packages) ───────────────────
echo [2/4] Generating app icon (PNG)…
node scripts\gen-icon.js
if errorlevel 1 (
    echo [WARN] gen-icon.js failed — existing icon will be used if present.
)
echo.

:: ── 3. Convert icon.png → icon.ico (electron-builder needs .ico for Windows) ──
echo [3/4] Converting icon.png to icon.ico…
if not exist "build\icon.png" (
    echo [ERROR] build\icon.png not found — cannot create icon.ico.
    pause & exit /b 1
)

:: Use scripts\gen-ico.ps1 — produces a proper multi-size Windows icon.
:: Sizes 256/128/64/48/32/16 are embedded so the icon looks sharp at any DPI.
:: Compatible with Windows PowerShell 5.1 and PowerShell 7+.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\gen-ico.ps1"

if errorlevel 1 (
    echo [WARN] icon.ico generation failed — electron-builder will use icon.png as fallback.
)
echo.

:: ── 4. Build distributable ───────────────────────────────────────────────────
echo [4/4] Choose output format:
echo.
echo   [1] Folder  (unpacked — zip and share)  [DEFAULT]
echo   [2] Portable EXE  (single file, no install required)
echo   [3] NSIS Installer  (setup.exe with uninstaller)
echo.
set CHOICE=1
set /p CHOICE="Enter choice [1-3, default=1]: "

if "%CHOICE%"=="2" goto build_portable
if "%CHOICE%"=="3" goto build_nsis
:: Default / "1" → unpacked dir
:build_dir
set BUILD_ARGS=--win dir
set BUILD_LABEL=Unpacked folder
set BUILD_OUT=%~dp0dist\win-unpacked
goto do_build

:build_portable
set BUILD_ARGS=--win portable
set BUILD_LABEL=Portable EXE
set BUILD_OUT=%~dp0dist
goto do_build

:build_nsis
set BUILD_ARGS=--win nsis
set BUILD_LABEL=NSIS Installer
set BUILD_OUT=%~dp0dist
goto do_build

:do_build
echo.
echo       Building: %BUILD_LABEL%
echo       Output:   %~dp0dist\
echo.

:: Disable code-signing — no cert is configured, and without this electron-builder
:: tries to extract winCodeSign (which contains macOS symlinks) and 7-Zip fails
:: because creating them requires the SeCreateSymbolicLinkPrivilege (hence admin).
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=

:: Wipe any stale winCodeSign cache — elevated builds can recreate it cleanly.
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    rd /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
)

call npx electron-builder %BUILD_ARGS% --x64
if errorlevel 1 (
    echo.
    echo [ERROR] electron-builder failed. See output above.
    pause & exit /b 1
)

echo.
echo ============================================================
echo   Build complete!
echo   Output: %~dp0dist\
echo.
if "%CHOICE%"=="1" (
    echo   Zip the "win-unpacked" folder to share Porkfolio.
    echo   Recipient runs: Porkfolio.exe  (no install needed)
)
echo.
echo   REMINDER: recipients must configure their own paths for
echo   UFS2Tool.exe and the ExFAT tool folder in Settings.
echo ============================================================
echo.

:: Open the output folder in Explorer
start "" "%~dp0dist"

pause
endlocal
