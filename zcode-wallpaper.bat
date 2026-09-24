@echo off
rem ============================================================
rem  zcode-wallpaper.bat - ZCode desktop wallpaper switcher
rem  Portable package. Rescan media dirs (fast mode).
rem
rem  Hotkeys inside ZCode (all use LEFT-Ctrl):
rem    Left-Ctrl + .    cycle wallpaper (images / videos)
rem    Left-Ctrl + 1    code-block opacity cycle (100-85-70-55-40)
rem    Left-Ctrl + 2    composer/input opacity cycle
rem    Left-Ctrl + 3/4  video slower / faster
rem    Left-Ctrl + 5/6  wallpaper mask darker / lighter
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
"%NODE_EXE%" "%~dp0scripts\zcode-wallpaper.cjs" %*
if errorlevel 1 (
    echo.
    echo [FAILED]
    pause
    exit /b 1
)
echo.
echo [DONE] In ZCode: Left-Ctrl + . cycle wallpaper, 1/2 panel opacity.
pause
exit /b 0
