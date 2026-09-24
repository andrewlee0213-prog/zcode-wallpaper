@echo off
rem ============================================================
rem  Patch bat - apply/re-apply wallpaper + panel-opacity patch
rem  (v3.9 portable: auto-detects ZCode install, closes ZCode,
rem   rebuilds app.asar, relaunches ZCode)
rem ============================================================
setlocal enableextensions
chcp 65001 >nul
set "NODE_EXE=node"
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%~dp0runtime\node.exe" (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] node not found and no bundled runtime\node.exe
        pause
        exit /b 1
    )
)
"%NODE_EXE%" "%~dp0scripts\zcode-wallpaper.cjs" --apply
if errorlevel 1 (
    echo.
    echo [FAILED] ZCode may need manual relaunch.
    pause
    exit /b 1
)
timeout /t 5 /nobreak >nul
exit /b 0
