@echo off
setlocal enabledelayedexpansion
title UFS2 Patcher — Electron Launcher

:: ── Auto-elevate to Administrator (UFS2Tool requires it) ─────────────────────
net session >nul 2>&1
if errorlevel 1 (
    echo [INFO] Requesting Administrator elevation…
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b
)

:: Always run from the workspace root (where electron is installed)
cd /d "%~dp0"

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from https://nodejs.org/
    pause & exit /b 1
)

:: ── Install/update workspace dependencies if electron is missing ──────────────
if not exist "node_modules\electron\dist\electron.exe" (
    echo [INFO] Electron not found — installing workspace dependencies…
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause & exit /b 1
    )
)

:: ── Install app-specific deps (electron-builder etc.) if needed ───────────────
if not exist "src\ufs2ElectronApp\node_modules" (
    echo [INFO] Installing app dependencies…
    pushd src\ufs2ElectronApp
    npm install --no-fund --no-audit --ignore-scripts
    popd
)

:: ── Launch ────────────────────────────────────────────────────────────────────
echo [INFO] Launching UFS2 Patcher (Administrator)…
echo.

node_modules\.bin\electron "%~dp0src\ufs2ElectronApp" %*
if errorlevel 1 (
    echo.
    echo [WARN] Electron exited with code %errorlevel%.
    pause
)
endlocal
