@echo off
REM NasManager 便携版启动（双击运行；关闭窗口即停止服务）
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
echo 正在启动 NasManager，请稍候...
NasManager.exe server.js
pause
