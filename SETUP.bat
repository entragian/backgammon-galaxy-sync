@echo off
title Backgammon Galaxy Sync - Setup
cd /d "%~dp0"

echo ========================================
echo   Backgammon Galaxy Sync - Setup
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js is not installed!
    echo.
    echo Please install Node.js first:
    echo   1. Go to https://nodejs.org
    echo   2. Download the LTS version
    echo   3. Run the installer
    echo   4. Run this setup again
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

echo Node.js found:
node --version
echo.

echo Installing dependencies...
echo (This may take a minute)
echo.
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Installation failed! Please try again.
    pause
    exit /b 1
)

:: Playwright is an OPTIONAL peer dependency, so "npm install" above skips it.
:: The browser sign-in step in Sync Matches.bat needs it, so install it here.
echo.
echo Installing browser sign-in support (Playwright)...
echo (This may take another minute)
echo.
call npm install playwright

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Playwright install failed! Sign-in won't work without it.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo To sync your matches:
echo   Double-click "Sync Matches.bat"
echo.
pause
