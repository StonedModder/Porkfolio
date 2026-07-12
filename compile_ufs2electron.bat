@echo off
setlocal
title Shadowbatch — Build Executable

:: ── Auto-elevate to Administrator ────────────────────────────────────────────
net session >nul 2>&1
if errorlevel 1 (
    echo [INFO] Requesting Administrator elevation…
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: App lives here; electron-builder must be run from the app directory
cd /d "%~dp0src\ufs2ElectronApp"

echo ============================================================
echo   UFS2 Patcher — Electron Builder
echo ============================================================
echo.

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from https://nodejs.org/
    pause & exit /b 1
)

:: ── Install / update dependencies ────────────────────────────────────────────
echo [1/3] Installing dependencies…
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause & exit /b 1
)
echo       Done.
echo.

:: ── Choose build target ───────────────────────────────────────────────────────
echo [2/3] Choose build target:
echo.
echo   [1] Portable EXE  (single-file, no install required) [DEFAULT]
echo   [2] NSIS Installer (.exe installer with uninstaller)
echo   [3] Directory only (unpacked, for testing)
echo.
set BUILD_TARGET=1
set /p BUILD_TARGET="Enter choice [1-3, default=1]: "

if "%BUILD_TARGET%"=="1" goto choice1
if "%BUILD_TARGET%"=="2" goto choice2
if "%BUILD_TARGET%"=="3" goto choice3
echo [WARN] Invalid choice, defaulting to Portable EXE.
:choice1
set BUILD_ARGS=--win portable
set BUILD_LABEL=Portable EXE
goto build
:choice2
set BUILD_ARGS=--win nsis
set BUILD_LABEL=NSIS Installer
goto build
:choice3
set BUILD_ARGS=--win dir
set BUILD_LABEL=Directory (unpacked)
goto build

:build

echo.
echo [3/3] Building: %BUILD_LABEL%…
echo       Output will be at: %~dp0src\ufs2ElectronApp\dist\
echo.
echo       NOTE: electron-builder bundles UFS2Tool from ../../UFS2Tool/
echo             The built EXE still requires Administrator elevation
echo             for UFS2Tool to function (embedded in app.manifest).
echo.

:: Disable code-signing entirely — no cert is configured, and without this
:: electron-builder tries to extract winCodeSign (which contains macOS symlinks)
:: and 7-Zip fails because Windows requires a special privilege to create them.
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=

:: Clear any stale/corrupt winCodeSign cache left by previous non-elevated runs.
:: When elevated (which this bat ensures), 7-Zip can create symlinks cleanly.
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    rd /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
)

call npx electron-builder %BUILD_ARGS% --x64
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See output above.
    pause & exit /b 1
)

echo.
echo ============================================================
echo   Build complete!
echo   Output: %~dp0src\ufs2ElectronApp\dist\
echo ============================================================
echo.

:: Open output folder
start "" "%~dp0src\ufs2ElectronApp\dist"

pause
endlocal
