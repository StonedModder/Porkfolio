@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title ufs2ElectronModule - Standalone Test

echo ============================================================
echo  ufs2ElectronModule - Standalone Test
echo ============================================================
echo.

:: ── Check Node.js ──────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not on PATH.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

:: ── Check UFS2Tool.exe ─────────────────────────────────────────────────────
set UFS2TOOL=..\..\..\UFS2Tool\UFS2Tool.exe
if not exist "%UFS2TOOL%" (
    echo WARNING: UFS2Tool.exe not found at expected path:
    echo   %~dp0%UFS2TOOL%
    echo.
    set /p CUSTOM_TOOL="Enter full path to UFS2Tool.exe (or press Enter to continue anyway): "
    if not "!CUSTOM_TOOL!"=="" set UFS2TOOL=!CUSTOM_TOOL!
    echo.
)

:: ── Menu ───────────────────────────────────────────────────────────────────
:MENU
cls
echo ============================================================
echo  ufs2ElectronModule Test Runner
echo ============================================================
echo.
echo  [1] Quick test (single makefs, dummy input, PS5 preset)
echo  [2] Quick test (single newfs -D, dummy input, PS5 preset)
echo  [3] Custom single test  (you provide folder + output path)
echo  [4] Batch test from folder of sub-directories
echo  [5] Run all tests (makefs + newfs + batch) on dummy data
echo  [6] Exit
echo.
set /p CHOICE="Select (1-6): "

if "%CHOICE%"=="1" goto SINGLE_MAKEFS
if "%CHOICE%"=="2" goto SINGLE_NEWFS
if "%CHOICE%"=="3" goto CUSTOM
if "%CHOICE%"=="4" goto BATCH
if "%CHOICE%"=="5" goto ALL
if "%CHOICE%"=="6" exit /b 0
echo Invalid choice.
pause
goto MENU

:: ── [1] Quick makefs PS5 ───────────────────────────────────────────────────
:SINGLE_MAKEFS
echo.
echo  Running single makefs-ps5 test with dummy data ...
echo.
if not "%UFS2TOOL%"=="%~dp0..\..\..\UFS2Tool\UFS2Tool.exe" (
    node test.js --ps5 --method makefs --tool-path "%UFS2TOOL%" --skip-cleanup
) else (
    node test.js --ps5 --method makefs --skip-cleanup
)
echo.
pause
goto MENU

:: ── [2] Quick newfs PS5 ────────────────────────────────────────────────────
:SINGLE_NEWFS
echo.
echo  Running single newfs-ps5 test with dummy data ...
echo.
if not "%UFS2TOOL%"=="%~dp0..\..\..\UFS2Tool\UFS2Tool.exe" (
    node test.js --ps5 --method newfs --tool-path "%UFS2TOOL%" --skip-cleanup
) else (
    node test.js --ps5 --method newfs --skip-cleanup
)
echo.
pause
goto MENU

:: ── [3] Custom single test ─────────────────────────────────────────────────
:CUSTOM
echo.
set /p INPUT_PATH="  Input folder path: "
set /p OUTPUT_PATH="  Output .ffpkg file path: "
echo.
echo  Method:
echo   [1] makefs (PS5 preset)
echo   [2] newfs  (PS5 preset)
echo   [3] makefs (no PS5 flags)
echo   [4] newfs  (no PS5 flags)
set /p METHOD_CHOICE="  Select (1-4): "

if "%METHOD_CHOICE%"=="1" set NODE_ARGS=--ps5 --method makefs
if "%METHOD_CHOICE%"=="2" set NODE_ARGS=--ps5 --method newfs
if "%METHOD_CHOICE%"=="3" set NODE_ARGS=--method makefs
if "%METHOD_CHOICE%"=="4" set NODE_ARGS=--method newfs
if "%NODE_ARGS%"=="" set NODE_ARGS=--ps5 --method makefs

echo.
node test.js %NODE_ARGS% --input "%INPUT_PATH%" --output "%OUTPUT_PATH%" --skip-cleanup
echo.
pause
goto MENU

:: ── [4] Batch from folder ──────────────────────────────────────────────────
:BATCH
echo.
set /p BATCH_SRC="  Folder containing sub-directories (each becomes a .ffpkg): "
set /p BATCH_OUT="  Output directory for .ffpkg files: "
echo.
echo  Use PS5 preset?
set /p USE_PS5="  [Y/n]: "
if /i "%USE_PS5%"=="n" (
    set PS5_FLAG=
) else (
    set PS5_FLAG=--ps5
)
echo.
node test.js %PS5_FLAG% --batch "%BATCH_SRC%" --output "%BATCH_OUT%" --skip-cleanup
echo.
pause
goto MENU

:: ── [5] All tests ──────────────────────────────────────────────────────────
:ALL
echo.
echo  ── All tests on dummy data ──
echo.
echo  [1/2] makefs-ps5 ...
node test.js --ps5 --method makefs --skip-cleanup
echo.
echo  [2/2] newfs-ps5 ...
node test.js --ps5 --method newfs --skip-cleanup
echo.
echo  All done.
pause
goto MENU
