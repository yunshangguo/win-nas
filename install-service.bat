@echo off
REM NasManager 注册为 Windows 服务（7x24 开机自启、崩溃自动重启）
REM 需要同目录放置 nssm.exe（https://nssm.cc）
cd /d "%~dp0"
if not exist "nssm.exe" (
  echo 请将 nssm.exe 放到本目录后再运行此脚本。
  echo 下载: https://nssm.cc/download
  pause & exit /b 1
)
if not exist ".env" copy ".env.example" ".env" >nul
nssm install NasManager "%~dp0node.exe" "%~dp0server.js"
nssm set NasManager AppDirectory "%~dp0"
nssm set NasManager DisplayName "NasManager File Service"
nssm set NasManager Description "类 NAS 文件管理服务：断点续传 / 回收站 / 系统盘守卫"
nssm set NasManager Start SERVICE_AUTO_START
nssm set NasManager AppExit Default Restart
nssm start NasManager
echo NasManager 已注册并启动。可通过 services.msc 管理。
pause
