@echo off
REM NasManager 免安装启动脚本（Portable 版）
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
echo 正在启动 NasManager ...
node server.js
pause
