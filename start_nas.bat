@echo off
chcp 65001 >nul 2>&1
REM NasManager background launcher: starts supervisor (auto-restarts server.js on crash).
REM Double-click this file, or reference it in Task Scheduler / Startup folder.
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('dir /b /s "%USERPROFILE%\.workbuddy\binaries\node\versions\node.exe" 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node 22 or put node.exe in PATH.
  pause
  exit /b 1
)
start "" "%NODE_EXE%" "supervisor.js"
exit
