@echo off
setlocal enabledelayedexpansion
title UFS2Tool Batch Operations

:: ============================================================
::  UFS2Tool Batch Operations
::  Requires Administrator privileges for device operations
::  Image file operations can run without elevation
:: ============================================================

:MENU
cls
echo ============================================================
echo   UFS2Tool Batch Operations
echo ============================================================
echo.
echo  [1] Batch create PS5 .ffpkg images from folders  (newfs)
echo  [2] Batch create PS5 .ffpkg images from folders  (makefs)
echo  [3] Batch extract .ffpkg images to output folders
echo  [4] Batch image info / listing
echo  [5] Batch filesystem check (fsck_ufs)
echo  [6] Batch replace files inside images
echo  [7] Exit
echo.
set /p CHOICE="Select operation (1-7): "

if "%CHOICE%"=="1" goto BATCH_NEWFS
if "%CHOICE%"=="2" goto BATCH_MAKEFS
if "%CHOICE%"=="3" goto BATCH_EXTRACT
if "%CHOICE%"=="4" goto BATCH_INFO
if "%CHOICE%"=="5" goto BATCH_FSCK
if "%CHOICE%"=="6" goto BATCH_REPLACE
if "%CHOICE%"=="7" exit /b 0
echo Invalid choice.
pause
goto MENU


:: ============================================================
::  [1] Batch newfs  —  create one .ffpkg per sub-folder
::      UFS2Tool.exe newfs -D <folder> <output.ffpkg>
:: ============================================================
:BATCH_NEWFS
cls
echo ============================================================
echo  Batch create .ffpkg images using newfs -D
echo ============================================================
echo.
echo  Scans INPUT_DIR for sub-folders.
echo  For each sub-folder it creates  OUTPUT_DIR\<name>.ffpkg
echo.
set /p INPUT_DIR="Input folder (contains sub-folders): "
if not exist "%INPUT_DIR%" (
    echo ERROR: Folder not found: %INPUT_DIR%
    pause & goto MENU
)
set /p OUTPUT_DIR="Output folder for .ffpkg images: "
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo  Optional extra flags (leave blank for none)
echo  e.g.  -O 2 -U -b 32768 -f 4096
set /p EXTRA_FLAGS="Extra newfs flags: "

echo.
echo ============================================================
echo  Processing ...
echo ============================================================
set COUNT=0
set ERRORS=0

for /d %%F in ("%INPUT_DIR%\*") do (
    set FOLDER_NAME=%%~nxF
    set OUT_FILE=%OUTPUT_DIR%\!FOLDER_NAME!.ffpkg
    echo  [>>] %%F  ->  !OUT_FILE!
    "%~dp0UFS2Tool.exe" newfs %EXTRA_FLAGS% -D "%%F" "!OUT_FILE!"
    if !errorlevel! neq 0 (
        echo  [!!] FAILED: %%F
        set /a ERRORS+=1
    ) else (
        echo  [OK] %%~nxF.ffpkg
        set /a COUNT+=1
    )
    echo.
)

echo ============================================================
echo  Done.  Created: !COUNT!   Errors: !ERRORS!
echo ============================================================
pause
goto MENU


:: ============================================================
::  [2] Batch makefs  —  PS5-compatible FreeBSD FFS options
::      UFS2Tool.exe makefs -S 4096 -t ffs
::                  -o version=2,minfree=0,softupdates=0,optimization=space
::                  <output.ffpkg> <folder>
:: ============================================================
:BATCH_MAKEFS
cls
echo ============================================================
echo  Batch create .ffpkg images using makefs (PS5-compatible)
echo ============================================================
echo.
echo  Default options:  -S 4096 -t ffs
echo                    -o version=2,minfree=0,softupdates=0,optimization=space
echo.
set /p INPUT_DIR="Input folder (contains sub-folders): "
if not exist "%INPUT_DIR%" (
    echo ERROR: Folder not found: %INPUT_DIR%
    pause & goto MENU
)
set /p OUTPUT_DIR="Output folder for .ffpkg images: "
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo  Override -o options?  (leave blank to use PS5 defaults)
set /p FS_OPTS="Filesystem options (-o key=val,...): "
if "%FS_OPTS%"=="" set FS_OPTS=version=2,minfree=0,softupdates=0,optimization=space

echo.
echo ============================================================
echo  Processing ...
echo ============================================================
set COUNT=0
set ERRORS=0

for /d %%F in ("%INPUT_DIR%\*") do (
    set FOLDER_NAME=%%~nxF
    set OUT_FILE=%OUTPUT_DIR%\!FOLDER_NAME!.ffpkg
    echo  [>>] %%F  ->  !OUT_FILE!
    "%~dp0UFS2Tool.exe" makefs -S 4096 -t ffs -o "%FS_OPTS%" "!OUT_FILE!" "%%F"
    if !errorlevel! neq 0 (
        echo  [!!] FAILED: %%F
        set /a ERRORS+=1
    ) else (
        echo  [OK] %%~nxF.ffpkg
        set /a COUNT+=1
    )
    echo.
)

echo ============================================================
echo  Done.  Created: !COUNT!   Errors: !ERRORS!
echo ============================================================
pause
goto MENU


:: ============================================================
::  [3] Batch extract  —  extract every image in a folder
::      UFS2Tool.exe extract <image> <output-dir> [fs-path]
:: ============================================================
:BATCH_EXTRACT
cls
echo ============================================================
echo  Batch extract images (.ffpkg / .img) to output folders
echo ============================================================
echo.
set /p IMG_DIR="Folder containing image files: "
if not exist "%IMG_DIR%" (
    echo ERROR: Folder not found: %IMG_DIR%
    pause & goto MENU
)
set /p IMG_EXT="File extension to process (e.g. ffpkg, img): "
if "%IMG_EXT%"=="" set IMG_EXT=ffpkg
set /p OUTPUT_DIR="Output base folder (a sub-folder per image will be created): "
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo  Optional fs-path inside the image to extract (leave blank for entire image)
set /p FS_PATH="fs-path [blank=all]: "

echo.
echo ============================================================
echo  Processing ...
echo ============================================================
set COUNT=0
set ERRORS=0

for %%I in ("%IMG_DIR%\*.%IMG_EXT%") do (
    set IMG_NAME=%%~nI
    set OUT_SUBDIR=%OUTPUT_DIR%\!IMG_NAME!
    if not exist "!OUT_SUBDIR!" mkdir "!OUT_SUBDIR!"
    echo  [>>] %%~nxI  ->  !OUT_SUBDIR!
    if "%FS_PATH%"=="" (
        "%~dp0UFS2Tool.exe" extract "%%I" "!OUT_SUBDIR!"
    ) else (
        "%~dp0UFS2Tool.exe" extract "%%I" "!OUT_SUBDIR!" "%FS_PATH%"
    )
    if !errorlevel! neq 0 (
        echo  [!!] FAILED: %%~nxI
        set /a ERRORS+=1
    ) else (
        echo  [OK] %%~nxI extracted
        set /a COUNT+=1
    )
    echo.
)

echo ============================================================
echo  Done.  Extracted: !COUNT!   Errors: !ERRORS!
echo ============================================================
pause
goto MENU


:: ============================================================
::  [4] Batch info / listing
::      UFS2Tool.exe info <image>
::      UFS2Tool.exe ls   <image> [path]
:: ============================================================
:BATCH_INFO
cls
echo ============================================================
echo  Batch info / directory listing
echo ============================================================
echo.
set /p IMG_DIR="Folder containing image files: "
if not exist "%IMG_DIR%" (
    echo ERROR: Folder not found: %IMG_DIR%
    pause & goto MENU
)
set /p IMG_EXT="File extension to process (e.g. ffpkg, img): "
if "%IMG_EXT%"=="" set IMG_EXT=ffpkg

echo.
echo  Choose output mode:
echo   [1] info  — filesystem superblock information
echo   [2] ls    — list root directory contents
echo   [3] du    — disk usage summary (human-readable)
set /p INFO_MODE="Mode (1/2/3): "

echo.
set /p LOG_FILE="Save output to log file? (leave blank to print only): "

echo.
echo ============================================================

for %%I in ("%IMG_DIR%\*.%IMG_EXT%") do (
    echo ============================================================
    echo  Image: %%~nxI
    echo ============================================================
    if "%INFO_MODE%"=="1" (
        if not "%LOG_FILE%"=="" (
            echo === %%~nxI === >> "%LOG_FILE%"
            "%~dp0UFS2Tool.exe" info "%%I" >> "%LOG_FILE%" 2>&1
        ) else (
            "%~dp0UFS2Tool.exe" info "%%I"
        )
    ) else if "%INFO_MODE%"=="2" (
        if not "%LOG_FILE%"=="" (
            echo === %%~nxI === >> "%LOG_FILE%"
            "%~dp0UFS2Tool.exe" ls "%%I" >> "%LOG_FILE%" 2>&1
        ) else (
            "%~dp0UFS2Tool.exe" ls "%%I"
        )
    ) else (
        if not "%LOG_FILE%"=="" (
            echo === %%~nxI === >> "%LOG_FILE%"
            "%~dp0UFS2Tool.exe" du -h -s "%%I" >> "%LOG_FILE%" 2>&1
        ) else (
            "%~dp0UFS2Tool.exe" du -h -s "%%I"
        )
    )
    echo.
)

if not "%LOG_FILE%"=="" echo Output saved to: %LOG_FILE%
echo ============================================================
echo  Done.
echo ============================================================
pause
goto MENU


:: ============================================================
::  [5] Batch fsck_ufs  —  filesystem consistency check
::      UFS2Tool.exe fsck_ufs [-p] <image>
:: ============================================================
:BATCH_FSCK
cls
echo ============================================================
echo  Batch filesystem check (fsck_ufs)
echo ============================================================
echo.
set /p IMG_DIR="Folder containing image files: "
if not exist "%IMG_DIR%" (
    echo ERROR: Folder not found: %IMG_DIR%
    pause & goto MENU
)
set /p IMG_EXT="File extension to process (e.g. ffpkg, img): "
if "%IMG_EXT%"=="" set IMG_EXT=ffpkg

echo.
echo  fsck mode:
echo   [1] -p   Preen (auto-fix safe issues, non-interactive)
echo   [2] -n   Read-only check (no changes)
echo   [3] -fy  Force check and auto-answer yes to all prompts
set /p FSCK_MODE="Mode (1/2/3): "

if "%FSCK_MODE%"=="1" set FSCK_FLAGS=-p
if "%FSCK_MODE%"=="2" set FSCK_FLAGS=-n
if "%FSCK_MODE%"=="3" set FSCK_FLAGS=-fy
if "%FSCK_FLAGS%"=="" set FSCK_FLAGS=-p

echo.
echo ============================================================
echo  Processing (flags: %FSCK_FLAGS%) ...
echo ============================================================
set COUNT=0
set ERRORS=0

for %%I in ("%IMG_DIR%\*.%IMG_EXT%") do (
    echo  [>>] %%~nxI
    "%~dp0UFS2Tool.exe" fsck_ufs %FSCK_FLAGS% "%%I"
    if !errorlevel! neq 0 (
        echo  [!!] Issues detected: %%~nxI
        set /a ERRORS+=1
    ) else (
        echo  [OK] Clean: %%~nxI
        set /a COUNT+=1
    )
    echo.
)

echo ============================================================
echo  Done.  Clean: !COUNT!   Issues/Errors: !ERRORS!
echo ============================================================
pause
goto MENU


:: ============================================================
::  [6] Batch replace  —  replace a file/dir in every image
::      UFS2Tool.exe replace <image> <fs-path> <source-path>
:: ============================================================
:BATCH_REPLACE
cls
echo ============================================================
echo  Batch replace files inside multiple images
echo ============================================================
echo.
set /p IMG_DIR="Folder containing image files: "
if not exist "%IMG_DIR%" (
    echo ERROR: Folder not found: %IMG_DIR%
    pause & goto MENU
)
set /p IMG_EXT="File extension to process (e.g. ffpkg, img): "
if "%IMG_EXT%"=="" set IMG_EXT=ffpkg
set /p FS_PATH="Path inside the image to replace (e.g. /data/settings.cfg): "
set /p SOURCE_PATH="Local source file or folder to use as replacement: "
if not exist "%SOURCE_PATH%" (
    echo ERROR: Source not found: %SOURCE_PATH%
    pause & goto MENU
)

echo.
echo ============================================================
echo  Processing ...
echo ============================================================
set COUNT=0
set ERRORS=0

for %%I in ("%IMG_DIR%\*.%IMG_EXT%") do (
    echo  [>>] %%~nxI  [%FS_PATH%]  <-  %SOURCE_PATH%
    "%~dp0UFS2Tool.exe" replace "%%I" "%FS_PATH%" "%SOURCE_PATH%"
    if !errorlevel! neq 0 (
        echo  [!!] FAILED: %%~nxI
        set /a ERRORS+=1
    ) else (
        echo  [OK] %%~nxI updated
        set /a COUNT+=1
    )
    echo.
)

echo ============================================================
echo  Done.  Updated: !COUNT!   Errors: !ERRORS!
echo ============================================================
pause
goto MENU
