@echo off
REM NasManager 启动器：以后台方式拉起 supervisor（supervisor 会在 server.js 崩溃/假死时自动重启）
REM 用法：双击本文件，或在“任务计划程序”/“启动”文件夹中引用它。
cd /d D:\NasManager
start "" "C:\Users\媛宝\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" "D:\NasManager\supervisor.js"
exit
