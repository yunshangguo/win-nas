# NasManager · 类 NAS 文件管理（Windows 原生）

> **NasManager** is a Windows-native, web-based file manager with zero-install clients. It targets the core experience of QNAP File Station, with hard guarantees: no app data on the system drive, system-drive operations require confirmation, deletes go to the Windows Recycle Bin, and large uploads use resumable TUS transfer.
>
> 一个跑在 Windows 上的网页多客户端零安装文件管理器，目标是对齐 QNAP File Station 的核心体验。

[English abstract](#english-abstract) · [特性 Features](#-核心特性) · [快速开始 Quick Start](#-快速开始) · [API 参考 docs/API.md](docs/API.md)

---

## 目录

- [核心特性](#-核心特性)
- [系统架构](#-系统架构)
- [目录结构](#-目录结构)
- [快速开始](#-快速开始)
- [配置（.env）](#-配置env)
- [使用说明](#-使用说明)
- [API 概览](#-api-概览)
- [安全模型](#-安全模型)
- [部署](#-部署)
- [已知限制](#-已知限制)
- [故障排查](#-故障排查)
- [许可证](#-许可证)

---

## ✨ 核心特性

1. **应用数据盘符无关** —— 索引 / 缩略图 / 上传临时 / 数据库全部存 `DATA_DIR`，**默认就在项目安装目录下的 `data/`**（如 `<项目>/data`），与盘符彻底解耦：无论装在 C: 还是 D:，或电脑**只有 C 盘**，都能正常工作。若 `DATA_DIR` 落在系统盘，仅打印警告（不阻断启动）；如需恢复严格的“系统盘拒绝启动”，设 `ALLOW_DATA_ON_SYSTEM=0`。
2. **访问系统盘需二次确认** —— 任何落在系统盘（默认 `C:`）的文件操作，服务端强制要求确认标志，否则返回 `423 SYSTEM_DRIVE_CONFIRM`，前端弹确认框。**个人主目录即便位于系统盘也免确认**，确保“只有 C 盘”的机器也能正常使用自己的空间。
3. **删除连通 Windows 回收站** —— 删除走 `SHFileOperation(FOF_ALLOWUNDO)`，可浏览 / 还原 / 清空，删除的文件可找回。
4. **大文件断点续传** —— 上传采用工业级 TUS 可恢复分片协议，100GB 级传输断网续传、已传不丢；支持文件夹上传与拖拽上传。
5. **缩略图** —— 图片用 sharp 生成缓存缩略图（缓存进 `DATA_DIR/thumbnails`，默认就在项目目录下，与盘符解耦）；视频可选 ffmpeg 抽首帧。
6. **全局搜索** —— 文件名 / 类型 / 大小 / 日期多维过滤；内存索引存 `DATA_DIR/index`，**启动后自动在后台构建**（无需手动触发），构建过程分块让出事件循环 + 节流休眠，**全盘扫描也不会卡死**；随查随用；“此电脑”实时受限遍历（仅 admin）。
7. **在线预览 / 编辑** —— 网页内直接打开文件：文本类（txt / json / md / 代码 / csv / xml …）内置编辑器 + JSON 一键格式化 + 保存自动备份 `.bak`；图片 / 视频（拖动进度）/ 音频 / PDF 原生预览；Excel（SheetJS）/ Word（mammoth）/ PPT（fflate 抽取幻灯片文本）只读预览。
8. **压缩 / 解压** —— 右键「压缩为 ZIP」支持 AES-256 加密 + 压缩级别 best/store；ZIP / TAR.GZ「解压到此处 / 新文件夹」支持解密校验；压缩包内容可直接预览（含加密锁标记）。
9. **共享链接** —— 生成免登录临时访问链接，可设密码 + 有效期，公开访问时基于绝对路径快照解析（个人空间分享也能正常访问）。
10. **WebDAV 网络磁盘** —— 内置 WebDAV 服务（`/dav`），可把“此电脑”全部磁盘挂载为 Windows 网络驱动器；**仅管理员可访问**（子账号 403）。支持 OPTIONS/PROPFIND/GET/PUT/DELETE/MKCOL/MOVE/COPY/LOCK/UNLOCK 全套方法。
11. **多用户 / 权限** —— 管理员可创建子账号，为每个账号分配可访问根目录（静态 ROOTS / 此电脑 / 个人主目录）与 read/write/delete 权限位；新建账号自动在 `USER_HOME_BASE` 下创建独立个人空间（`D:\<用户名>`）。
12. **子账号自助改密** —— 任意登录用户在设置面板内可自助修改自己的密码（先校验旧密码），改密后其他会话立即失效。
13. **实时刷新** —— SSE 事件流（`/api/events`）推送目录变更，前端免轮询即时刷新。
14. **文件版本** —— 文本/图片类文件保存时自动留存历史版本（默认保留 90 天），可浏览 / 还原 / 下载 / 删除历史版本。
15. **去重 / 校验** —— 计算文件 SHA-256 校验和；按内容哈希扫描重复文件。
16. **后台任务系统** —— 上传 / 压缩 / 解压 / 复制等耗时操作进入后台任务队列，可暂停 / 继续 / 取消 / 清空已完成。
17. **导航与多视图** —— 左侧目录树（懒加载、展开折叠）+ 主视图「列表 / 平铺 / 幻灯片」三视图；工具栏前进 / 后退 / 上一级；地址栏显示真实 Windows 路径并支持输入跳转；批量多选、按名称/类型/大小/修改时间排序。
18. **传输安全加固** —— 登录防重放一次性 nonce + HSTS（仅 HTTPS 时下发）；会话 Cookie `HttpOnly + SameSite=Strict`（HTTPS 时 `Secure`）；登录失败 IP 限流。
19. **自动 HTTPS（ACME）** —— 内置 Let's Encrypt 自动申请 / 续期（HTTP-01 校验），或本机 TLS 证书，或由 Caddy/Nginx 反代终止 TLS。
20. **自愈守护** —— `supervisor.js` 通过协调端口选举单实例 leader，在 server 崩溃或“假死”（能连 TCP 但不回 HTTP）时自动重启，避免“网页/文件夹打不开”。

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器（Vue3 单页应用，public/index.html，零安装）            │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP / HTTPS (Cookie: nm_session)
┌───────────────▼─────────────────────────────────────────────┐
│  server.js (Express, 端口 PORT=8080，主服务)                  │
│   ├─ 鉴权中间件（强制登录 + 用户注入 + 根目录隔离 + 权限位）    │
│   ├─ 文件浏览/操作/上传(TUS)/下载/预览/回收站/压缩解压/共享      │
│   ├─ 搜索（src/search.js，异步分块索引）                       │
│   ├─ 多用户/权限（src/auth.js）                               │
│   ├─ WebDAV（src/webdav.js，挂载 /dav，仅 admin）             │
│   ├─ Office 预览 / 缩略图 / 文件版本 / 去重 / 后台任务          │
│   └─ ACME 自动证书（src/acme.js）                             │
└───────────────┬─────────────────────────────────────────────┘
                │ spawn + 健康检查（端口 5001 选举）
┌───────────────▼─────────────────────────────────────────────┐
│  supervisor.js（守护进程：server 崩溃/假死自愈重启）           │
└─────────────────────────────────────────────────────────────┘
```

- **前端**：`public/index.html` 是内联 Vue3 SPA（无构建步骤，浏览器直跑），登录页 `public/login.html`。已设置 `no-store` 强制刷新，避免旧版缓存。
- **后端**：单文件 `server.js`（Express 4）+ `src/` 下模块化拆分。纯 Node，无数据库依赖（用户/会话/设置/索引均以 JSON 落盘到 `DATA_DIR`）。
- **回收站**：`src/recycle.js` 调用 PowerShell 脚本 `scripts/recycle.ps1`（P/Invoke + Shell COM），把删除接入 Windows 回收站。
- **单实例保证**：`server.js` 用协调端口 **5002** 的 OS 级互斥保证全局只有一个实例真正绑定 `PORT`；`supervisor.js` 用协调端口 **5001** 选 leader，避免多份守护互相抢端口。

---

## 📁 目录结构

```
D:\NasManager\
├─ server.js              Express 主服务（文件/上传/下载/预览/搜索/WebDAV/ACME…）
├─ supervisor.js          守护进程（server 崩溃/假死自愈重启，端口 5001 选举）
├─ config.js              配置（DATA_DIR / USER_HOME_BASE 默认项目相对，与盘符解耦）
├─ package.json           依赖与启动脚本
├─ src\
│  ├─ paths.js            路径解析 + 系统盘守卫 + 个人主目录
│  ├─ auth.js             认证/多用户/权限（scrypt 哈希、会话落盘）
│  ├─ userctx.js          请求级用户上下文（解析 __home__）
│  ├─ recycle.js          回收站调用（PowerShell）
│  ├─ thumbnails.js       缩略图生成（sharp / ffmpeg，缓存进 DATA_DIR）
│  ├─ search.js           搜索索引（异步分块，存 DATA_DIR/index）
│  ├─ webdav.js           WebDAV 服务工厂（/dav 挂载，仅 admin）
│  ├─ acme.js             Let's Encrypt 自动申请/续期
│  ├─ office.js           Office 预览（Excel/Word 解析）
│  ├─ share.js            共享链接管理
│  ├─ favorites.js        收藏夹
│  ├─ versions.js         文件历史版本
│  ├─ recycle.js          回收站逻辑
│  ├─ dedup.js            去重
│  └─ jobs.js             后台任务队列
├─ scripts\
│  └─ recycle.ps1         回收站增删查（P/Invoke + Shell COM）
├─ public\
│  ├─ index.html          Vue3 前端（浏览/上传续传/下载/删除/回收站/系统盘确认/缩略图/搜索/WebDAV/多用户）
│  ├─ login.html          独立登录页
│  └─ icons.svg           图标
├─ vendor\
│  ├─ vue.global.prod.js  Vue3 运行时
│  ├─ tus.min.js          TUS 客户端
│  └─ README.md           vendor 说明
├─ start_nas.bat          启动器（后台拉起 supervisor）
├─ install-service.bat    注册为 Windows 服务（需 nssm.exe）
├─ nas_task.xml           任务计划程序 XML（登录自启 + 崩溃重启）
├─ nginx.conf.example     Nginx 反代 HTTPS 模板
├─ Caddyfile              Caddy 反代 HTTPS 模板（自动 ACME）
├─ .env.example           配置样例
└─ README.md              本文件
```

> 应用运行时数据（用户表、会话、索引、缩略图、上传临时、数据库）全部落在 `DATA_DIR`（**默认 `<项目>/data`**，与盘符解耦），**不会**写进仓库；单 C 盘机器也能用。用户文件默认落在 `<项目>/home/<用户名>`。

---

## 🚀 快速开始

```bat
cd /d D:\NasManager
npm install                 :: 安装依赖（express / @tus/server / sharp / archiver / acme-client …）
copy .env.example .env      :: 按需修改 DATA_DIR / ROOTS / PORT / AUTH_PASSWORD
start_nas.bat              :: 启动 supervisor（自动拉起 server），浏览器开 http://localhost:8080
```

- **免安装 Portable 版**：直接 `node server.js` 或 `start_nas.bat` 跑，数据全部落在项目目录下的 `data/` 与 `home/`，与盘符解耦——拷贝整个文件夹即可迁移，单 C 盘机器也能用。
- **长期 7×24 服务版**：把 `nssm.exe` 放本目录，运行 `install-service.bat`，注册为 Windows 服务，开机自启 + 崩溃重启。
- **首次启动**：若 `.env` 未设 `AUTH_PASSWORD`，会自动生成随机管理员密码并写入 `DATA_DIR/secrets/initial_admin_password.txt`，请用它登录后尽快修改。

> ⚠️ 端口说明：`server.js` 主服务监听 `PORT`（默认 8080）；`supervisor.js` 用协调端口 **5001** 选 leader；`server.js` 用协调端口 **5002** 保证单实例。**不要同时**直接 `node server.js` 与 `node supervisor.js`，二者都由 5002/5001 互斥，并存会互相抢端口。生产只跑 `supervisor.js` 即可（它会拉起 server）。

---

## ⚙️ 配置（.env）

复制 `.env.example` 为 `.env` 后修改。`DATA_DIR` / `SYSTEM_DRIVES` / `ROOTS` / `PORT` / 认证 在 `config.js` 与 `auth.js` 中读取；其余开关可在运行期通过「设置」面板或 `POST /api/settings` 动态调整并持久化。

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATA_DIR` | 应用数据目录（索引/缩略图/上传临时/数据库）。默认 `<项目>/data`，与盘符解耦（单 C 盘也能用）；可用绝对路径覆盖 | `<项目>/data` |
| `USER_HOME_BASE` | 用户个人主目录基地。`<基地>/<用户名>` 即各账号私有空间。默认 `<项目>/home`，与盘符解耦；可用绝对路径覆盖 | `<项目>/home` |
| `SYSTEM_DRIVES` | 系统盘列表，逗号/分号分隔，不带冒号；这些盘上的操作需二次确认 | `C` |
| `ROOTS` | 用户文件根目录，多组 `名:路径` 分号分隔（你真正管理的原文件落这里，Explorer 直接可读） | `share:D:\Share` |
| `PORT` | 主服务监听端口 | `8080` |
| `ALLOW_DATA_ON_SYSTEM` | 设为 `0` 可恢复“系统盘拒绝启动”的严格模式（默认仅警告、允许 `DATA_DIR` 落系统盘） | 不设（默认允许并警告） |
| `SEARCH_THROTTLE_MS` | 搜索索引构建节流：每批让出事件循环后额外休眠毫秒数，降低磁盘/CPU 占用（设 `0` 关闭节流；值越大越省资源但索引越慢） | `2` |
| `AUTH_USERNAME` | 管理员用户名 | `admin` |
| `AUTH_PASSWORD` | 管理员密码（留空则首次启动自动生成随机密码并写入 `DATA_DIR/secrets/initial_admin_password.txt`） | 自动生成 |
| `HTTPS_CERT` | 本机 TLS 证书（PEM）绝对路径；配齐 `HTTPS_KEY` 即启用本机 HTTPS | 不设 |
| `HTTPS_KEY` | 本机 TLS 私钥（PEM）绝对路径 | 不设 |
| `HTTPS_PORT` | 本机 HTTPS 监听端口（仅 `HTTPS_CERT/KEY` 配置时生效） | `443` |
| `ACME_HTTP_PORT` | ACME HTTP-01 挑战端口 | `80` |
| `LETSENCRYPT_ENABLED` | 开启 Let's Encrypt 自动申请/续期 | `false` |
| `LETSENCRYPT_DOMAINS` | 证书域名（逗号/空格分隔） | 空 |
| `LETSENCRYPT_EMAIL` | 申请证书用的邮箱 | 空 |
| `LETSENCRYPT_STAGING` | 先用 Let's Encrypt 测试环境（避免频繁申请触发限流） | `false` |
| `VERSIONS_MAX_AGE_DAYS` | 文件历史版本最长保留天数 | `90` |
| `RECYCLE_AUTOPURGE_DAYS` | 回收站自动清理天数（`0` = 不自动清理） | `0` |

> 运行期可在「设置」面板调整并持久化的项：`hideWindowsHidden`（是否扫描 Windows 隐藏属性，默认关以提速）、`webdavEnabled`（WebDAV 开关，默认开）、`versionsMaxAgeDays`、`recycleAutopurgeDays`、以及上述 ACME 相关项。

---

## 🖥️ 使用说明

### 网页端
- 浏览器打开 `http://localhost:8080`（或你的域名），首屏即登录页。
- 登录后左侧目录树含「此电脑」（admin 可遍历全部磁盘 / U 盘 / 光驱）、静态 `ROOTS`、个人主目录「我的空间」。
- 主视图工具栏：上传文件 / 上传文件夹 / 新建文件（txt·Word·Excel）/ 删除 / 粘贴 / 列表·平铺·幻灯片切换 / 前进·后退·上一级 / 显示隐藏文件。
- 右键菜单：打开 / 下载 / 复制 / 剪切 / 移动到… / 重命名 / 属性（大小·路径·改名含改后缀）/ 压缩为 ZIP / 解压 / 生成共享链接。
- 地址栏显示**真实 Windows 路径**，支持输入真实盘符路径回车跳转，可「复制路径」。
- 设置面板（齿轮）：修改密码、WebDAV 地址与开关、Windows 隐藏属性扫描开关、回收站自动清理、文件版本保留天数、ACME 证书。

### WebDAV（仅管理员）
1. 设置面板「🌐 WebDAV 网络磁盘」查看挂载地址（如 `http://localhost:8080/dav`），确认开关已开。
2. **强烈建议先套 HTTPS**（见[部署](#-部署)），否则 Basic 认证密码以 base64 明文在网络上裸奔。
3. Windows 映射网络驱动器 → 连接 WebDAV → 输入地址与**管理员**账密（子账号会被 403 拒绝）。
4. 盘符 URL 中不带冒号，例如 `/dav/C/Users` 对应 `C:\Users`。

### 共享链接
- 右键文件/文件夹「生成共享链接」，可设密码 + 有效期（小时，0 = 永久）。
- 生成 `/s/<token>` 公开链接，免登录即可访问/下载；可在「分享管理」查看、延期、撤销。

### 多用户
- 管理员在「用户管理」创建子账号，分配可访问的根（静态 ROOTS / 此电脑 / 个人主目录）与 read/write/delete 权限。
- 子账号登录后仅能看到被分配的根 + 自己的个人空间；无法访问「用户管理」「设置写操作」「WebDAV」。
- 子账号可在设置面板自助修改自己的密码。

### 搜索
- 右上搜索框输入关键字；首次使用请在「设置」或 `POST /api/search/reindex` 建立索引（异步，轮询 `/api/search/status`）。
- 支持按扩展名、大小区间、修改时间区间过滤；admin 搜 `__computer__` 触发实时受限遍历（带深度/数量上限，不冻结）。

---

## 🔌 API 概览

所有接口以 `/api/` 前缀提供 JSON（除上传/下载/预览为二进制流）。**鉴权总规则**：

- **免登录**：`POST /api/login`、`GET /api/login/challenge`、`GET /api/session`、`GET /api/events`（SSE）、静态资源、`/s/:token` 与 `/s/:token/raw`（公开共享链接）。
- **需登录**：其余所有 `/api/*`。未登录返回 `401 UNAUTHORIZED`。
- **仅管理员**：`/api/users*`（用户管理）、`POST|PUT /api/settings` 及 `/api/settings/*` 子路由、所有 `/api/admin/*`、`/api/letsencrypt/*`、`POST /api/search/reindex`。注意 `GET /api/settings` 对**所有登录用户开放**（供设置面板与自助改密）。
- **权限位**：读类接口需 `read`、写类需 `write`、删类需 `delete`（见 `PERM_MAP`）；子账号缺位返回 `403 FORBIDDEN_PERM`。
- **根目录隔离**：请求中出现的 `root` / `destRoot` 必须属于该用户（admin = 全部；非 admin 禁止「此电脑」`__computer__`）；个人主目录 `__home__` 始终访问本人空间。

完整逐接口文档（含请求参数与返回字段）见 **[docs/API.md](docs/API.md)**。常用接口速查：

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/api/login` | 登录（用户名 + SHA-256(password) [+ 一次性 nonce]） | 公开 |
| POST | `/api/logout` | 登出 | 登录 |
| GET | `/api/session` | 会话探测 | 登录 |
| GET | `/api/roots` | 根目录列表（含系统盘标记） | 登录 |
| GET | `/api/list` | 列目录（系统盘未确认 → 423） | read |
| POST | `/api/mkdir` `/api/rename` `/api/move` `/api/copy` `/api/create` | 文件 CRUD | write |
| ALL | `/api/upload` | TUS 续传上传，完成后移动到目标 root | write |
| GET | `/api/download` | 下载（流式，支持 Range） | read |
| POST | `/api/delete` | 删除 → 进回收站 | delete |
| GET/POST | `/api/recycle/*` | 回收站列表/还原/清空 | read/delete |
| GET | `/api/file` | 文件预览（图片/视频/音频/PDF/文本/Office，支持 Range） | read |
| PUT | `/api/file` | 文本文件保存（自动备份 `.bak`） | write |
| POST | `/api/compress` `/api/extract` | 压缩 / 解压（AES-256） | write |
| POST | `/api/share` | 生成共享链接（密码 + 有效期） | write |
| GET | `/api/search` | 搜索（名/类型/大小/日期） | read |
| POST | `/api/account/change-password` | 自助改密（校验旧密码） | 登录 |
| GET/POST | `/api/users*`（admin） | 子账号增删改查 | admin |
| POST | `/api/settings/webdav` | WebDAV 开关（持久化） | admin |
| ALL | `/dav` `/dav/*` | WebDAV 协议（仅 admin） | admin |

---

## 🔒 安全模型

- **强制登录**：所有 `/api/*` 必须先登录，未登录一律 `401`；前端首屏即登录页。
- **密码存储**：服务端以 `scrypt( SHA-256(password), salt )` 加盐哈希保存（salt 持久化在 `DATA_DIR/secrets/auth.salt`），**不存明文**；登录用恒定时间比较防时序攻击。
- **传输加密（HTTPS）**：三种方式任选其一 ——
  - **方式 A · 本机 TLS**：`.env` 配置 `HTTPS_CERT` + `HTTPS_KEY`，服务直接 HTTPS 启动，`Secure` Cookie 自动生效。
  - **方式 B · Caddy 反代（推荐）**：NasManager 仍跑内网 `http://localhost:8080`，由 Caddy 对外 HTTPS 并自动续期 Let's Encrypt（见 `Caddyfile`）。
  - **方式 C · Nginx 反代**：见 `nginx.conf.example`，由 Nginx 终止 TLS。
  - 反代需在转发头带 `X-Forwarded-Proto: https`，服务端据此自动给 Cookie 加 `Secure` 标记（已 `trust proxy = loopback`）。
- **HSTS**：仅当请求为真实 HTTPS（直连 TLS 或反代带 `X-Forwarded-Proto:https`）时下发 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。
- **登录防重放 nonce**：`GET /api/login/challenge` 签发一次性 nonce（5 分钟有效、单次消费），前端登录携带后服务端立即作废，使截获的登录请求无法原样重放（配合 HSTS 构成完整防重放）。
- **Cookie 加固**：会话 Cookie `nm_session` 为 `HttpOnly + SameSite=Strict`（HTTPS 时 `Secure`），JS 读不到，降低 XSS 偷令牌风险；非安全上下文（纯 HTTP 远程）访问会显示红色告警横幅。
- **登录限流**：同一 IP 连续失败触发限流，返回 `429 TOO_MANY_ATTEMPTS`。
- **根目录隔离**：非管理员只能访问被分配的根与个人空间，`__computer__`（此电脑）仅 admin；所有路径经 `resolveWithin` 解析，杜绝 `../` 越界与跨盘逃逸（实测越权返回 400/403）。
- **WebDAV 仅管理员**：`/dav` 的 Basic 认证在 `verifyLogin` 成功后额外校验 `role === 'admin'`，否则 `403`。
- **系统盘守卫**：系统盘上的操作强制二次确认；TUS 上传对系统盘兜底拒绝。
- **只暴露数据盘 `ROOTS`**：不要把系统盘整个加进 `ROOTS`。

---

## 📦 部署

### 1. 守护进程（自愈）
`supervisor.js` 通过协调端口 **5001** 选 leader，拉起 `server.js` 子进程；每 15s 健康检查——只要 HTTP 层有任何响应（含 302/401 登录页）即视为存活，仅「连不上/超时/连接重置」才记失败，连续 2 次失败即 `SIGKILL` 强制重启。这样即使 server 崩溃或被环境回收，文件管理器也能自愈。

```bat
:: 生产只跑这一个（它会拉起 server，单实例）
start_nas.bat                 :: 后台拉起 supervisor
:: 或注册为 Windows 服务（开机自启 + 崩溃重启），需 nssm.exe
install-service.bat
:: 或任务计划程序（登录自启 + 崩溃每 1 分钟重启 9999 次）
schtasks /create /tn NasManagerServer /xml D:\NasManager\nas_task.xml /f
```

### 2. 反向代理 HTTPS（强烈建议公网暴露前做）
**Nginx**（见 `nginx.conf.example`）：监听 443 终止 TLS，反向代理到 `127.0.0.1:5000`，关键头 `X-Forwarded-Proto $scheme`、`X-Forwarded-For`、`proxy_buffering off`（SSE 实时刷新需要）。
**Caddy**（见 `Caddyfile`）：`reverse_proxy 127.0.0.1:5000`，有公网域名时自动申请/续期 Let's Encrypt；纯局域网用 `tls internal` 自签。

### 3. ACME 自动证书
在「设置」面板或 `.env` 开启 `LETSENCRYPT_ENABLED` 并填 `LETSENCRYPT_DOMAINS` / `LETSENCRYPT_EMAIL`。服务端自动申请、每日检查临近过期（<30 天）自动续期，并在有证书时起 HTTPS 服务（`HTTPS_PORT`）。挑战服务器占用 `ACME_HTTP_PORT`（默认 80）。

### 4. 公网暴露（DDNS + 端口转发）
监听已绑定 `0.0.0.0`，网络可达即可外部访问。认证强制开启，登录后才能访问任何数据。**强烈建议先套 HTTPS**，否则凭据与文件以明文 HTTP 传输可被中间人窃听。
1. 固定内网 IP（静态 IP 或路由器 DHCP 绑定 MAC）。
2. （推荐）用 Caddy/Nginx 做 HTTPS 反代，对外 443、对内代理 `localhost:8080`。
3. 路由器端口转发：外部端口（建议避开常见扫描端口，如 `38080`）→ 内网 `192.168.1.50:8080`，TCP。
4. Windows 防火墙放行对应入站端口（或放行 `node.exe`）。
5. DDNS 把变化的公网 IP 绑定到域名。
6. 访问 `https://你的域名`（Caddy/Nginx）或 `http://你的域名:38080`（纯 HTTP，不推荐公网）。

---

## ⚠️ 已知限制

- **系统盘“根目录本身”（如 `C:\`）暂不支持直接上传**，以避免污染系统盘根；但其下任意子目录（含个人主目录 `<项目>/home/<用户>`）均可正常上传。浏览/下载/删除仍受二次确认保护（**个人主目录免确认**）。
- **搜索为内存索引**：启动后**自动在后台构建**（无需手动「重建索引」；`POST /api/search/reindex` 仍可用于强制全量刷新）；构建过程分块让出事件循环 + 节流休眠，大目录（数十万文件）也不会卡死；索引上限 50 万条（超量截断）。admin 搜「此电脑」为实时遍历，受深度/数量上限保护。
- **缩略图**：图片依赖 sharp（已装）；视频抽帧依赖系统 ffmpeg，未安装则视频缩略图降级为无预览（不影响其他功能）。
- **回收站依赖 Windows PowerShell**，需 `System32\WindowsPowerShell` 可用（标准 Windows 均具备）。
- **会话持久化但可重启失效风险**：会话落盘 `DATA_DIR/secrets/sessions.json`，server 重启后**不**踢下线；但若 `DATA_DIR` 被清空则失效。
- **Office 预览为只读**：Excel（SheetJS）/ Word（mammoth）/ PPT（fflate 抽取幻灯片文本）均为前端只读预览，不支持在线改 Office；PPT 预览抽取的是每页文本内容（不含图片版式）。
- **文本编辑上限**：`PUT /api/file` 限制单文件 50MB，足以覆盖绝大多数配置/日志/代码文件。
- **压缩包**：ZIP / TAR.GZ 支持压缩与解压（AES-256）；7z / RAR 暂不支持。
- **上传修复记录**：曾存在「TUS 上传文件已落盘但前端报失败」的 bug——`@tus/server` 的 `onUploadFinish` 返回 `undefined` 会触发其读取 `undefined.res` 抛异常、返回 500。已改为返回 `{ res, status_code: 204 }`；并加 `removeFingerprintOnSuccess` 避免重复上传已存在文件时误判为续传死链。

---

## 🛠️ 故障排查

- **网页打不开 / 文件夹点不开**：先确认服务进程还在——`netstat -ano | findstr :5000` 看有无 LISTENING。若端口有人但 HTTP 超时，是**僵死**（能收连接不处理），`taskkill /PID <pid> /F /T` 杀掉后由 supervisor 自动重启。纯 HTTP 探活请用 Node `http` 客户端，PowerShell/curl 的 cookie/引号处理易产生假象。
- **登录后一会跳回登录页**：多为会话被重启清空（现已落盘，重启不再踢下线）；检查 supervisor 是否陷“假死→重启”循环（`nas.log` / `supervisor.log`）。
- **端口抢用（EADDRINUSE）风暴**：不要同时直启 `node server.js` 与 `node supervisor.js`；确保只跑一个 `start_nas.bat`。server 对 EADDRINUSE 已优雅退出以收敛。
- **前端改了没生效**：前端已设 `no-store`，请 **Ctrl+F5 硬刷新**；仍不行在 F12 Console 看点击时有无红色报错。
- **搜索无结果**：先 `POST /api/search/reindex` 建索引并轮询 `/api/search/status`；索引为空通常是当前环境无文件（无静态 ROOTS 且家目录为空）。
- **WebDAV 连不上**：确认开关已开（`GET /api/webdav/status` 的 `serving` 应为 true）且用**管理员**账密；建议先 HTTPS。
- **日志**：运行日志 `nas.log`（server 输出）、`supervisor.log`（守护）、`supervisor_out.log`。

---

## 📄 许可证

[MIT](LICENSE) —— 详见仓库根目录 `LICENSE` 文件。

---

## English Abstract

**NasManager** is a Windows-native, web-based file manager (zero-install clients, Vue3 SPA + Node/Express backend) that aims at the core experience of QNAP File Station. Highlights:

- **Hard guarantees**: app data never lands on the system drive (refuses to boot otherwise); system-drive operations require explicit confirmation; deletes go to the Windows Recycle Bin; large uploads use resumable **TUS** transfer.
- **Rich features**: file browsing with tree/grid/slideshow views, thumbnails (sharp/ffmpeg), in-browser preview & edit (text/code/Markdown/CSV/PDF/Excel/Word/PPT), zip compress/extract with **AES-256**, share links (password + expiry), **WebDAV** mount (admin-only), full-text/filename **search**, recycle bin, file **versioning**, dedup/checksum, background task queue.
- **Multi-user & RBAC**: admin can create sub-accounts with per-root and read/write/delete permissions; each user gets an isolated personal home; sub-accounts can self-change password.
- **Security**: forced login, `scrypt` password hashing, anti-replay login nonce, HSTS, `HttpOnly; SameSite=Strict` session cookie, root-isolation, system-drive guard, login rate-limiting.
- **Ops**: self-healing `supervisor.js` (single-instance election + health-check restart), optional Windows service (nssm), reverse-proxy HTTPS via Nginx/Caddy, built-in Let's Encrypt (ACME) auto-cert.

See [docs/API.md](docs/API.md) for the full REST/WebDAV endpoint reference.
