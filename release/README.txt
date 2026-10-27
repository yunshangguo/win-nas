NasManager for Windows (x64) — 便携版
=====================================

本包内置了 Node.js 运行时（NasManager.exe 即 Node 可执行文件），
无需另外安装 Node.js 即可运行。解压到任意目录后：

【快速开始】
1. 把整个目录解压到任意位置（例如 D:\NasManager）。
2. 双击 start.bat 启动；或双击 NasManager.exe 并在参数里指定 server.js
   （推荐直接用 start.bat）。
3. 浏览器打开 http://localhost:8080
4. 首次启动若未设置 AUTH_PASSWORD，随机管理员密码会写到：
   <本目录>\data\secrets\initial_admin_password.txt
   请打开该文件查看并用其登录，登录后建议立即修改密码。

【配置】
- 修改 .env（没有就复制 .env.example 为 .env）可调整端口、数据目录、
  系统盘、用户文件根目录 ROOTS 等。改完重启生效。
- 数据默认存放在本目录的 data/ 与 home/ 下，与盘符解耦，
  单 C 盘机器也能正常使用。

【注册为系统服务（开机自启 / 崩溃自重启）】
1. 从 https://nssm.cc/download 下载 nssm.exe（win64 版）放到本目录。
2. 右键“以管理员身份运行” install-service.bat。
   （NasManager.exe 自带单实例互斥，无需再单独运行 supervisor。）

【端口】
- 默认 HTTP 端口 8080（.env 的 PORT 可改）。
- 服务自身用协调端口 5002 做单实例互斥，请勿占用。

【缩略图说明】
- 本便携版未捆绑 sharp 原生二进制，图片缩略图为降级模式（仍可正常
  浏览/管理文件，仅不生成缩略图）。如需缩略图，请在源码版另行启用。

【卸载】
- 直接删除整个解压目录即可，无残留注册表项（除非已注册为服务，
  请先 services.msc 停止并删除 NasManager 服务）。
