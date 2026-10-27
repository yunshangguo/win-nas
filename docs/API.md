# NasManager API 参考

本文件逐个列出 NasManager 的后端接口。前端为 Vue3 SPA，所有接口均经 `server.js`（Express，默认端口 `PORT=8080`）。

> 通用约定
> - 根路径：`/api/*` 返回 JSON（`Content-Type: application/json`）；`/api/download`、`/api/file`、`/api/thumbnail`、共享链接 `/s/:token/raw` 为二进制/流。
> - 认证：所有 `/api/*` 需登录（Cookie `nm_session`，`HttpOnly; SameSite=Strict`，HTTPS 时 `Secure`），未登录返回 `401 UNAUTHORIZED`。例外：`POST /api/login`、`GET /api/login/challenge`、`GET /api/session`、`GET /api/events`（SSE）、静态资源、`/s/:token` 与 `/s/:token/raw`（公开共享链接）。
> - 管理员专属：`/api/users*`、`POST|PUT /api/settings` 与 `/api/settings/*`、`/api/admin/*`、`/api/letsencrypt/*`、`POST /api/search/reindex`。`GET /api/settings` 对**所有登录用户开放**（设置面板 + 自助改密）。
> - 权限位：`read` / `write` / `delete`（`PERM_MAP`）。子账号缺位返回 `403 FORBIDDEN_PERM`。
> - 根目录隔离：请求中的 `root` / `destRoot` 必须属于该用户。`__computer__`（此电脑）仅 admin；`__home__`（个人主目录）始终访问本人空间；静态 `ROOTS` 需被显式分配。路径经 `resolveWithin` 解析，杜绝 `../` 越界与跨盘逃逸（越权返回 400/403）。
> - 系统盘守卫：落在系统盘的操作需 `confirmSystemDrive=1`（GET query）或 body 同名字段，否则返回 `423 SYSTEM_DRIVE_CONFIRM`。**个人主目录（`__home__`）即便位于系统盘也免确认**，确保“只有 C 盘”的机器可正常使用自己的空间。
> - 特殊根：`__computer__` = 此电脑（admin 遍历全部磁盘）；`__home__` = 个人主目录；其余为 `.env` 中 `ROOTS` 的键。

---

## 一、认证与会话

| 方法 | 路径 | 权限 | 说明 / 参数 | 返回 |
|---|---|---|---|---|
| GET | `/api/login/challenge` | 公开 | 签发一次性登录 nonce（5 分钟有效，单次消费） | `{ nonce, ttl }` |
| POST | `/api/login` | 公开 | Body：`{ username, password | passwordHash, nonce? }`。`passwordHash` 为 `SHA-256(password)` 十六进制（前端先哈希再传）；带 `nonce` 走防重放（消费后作废）。失败过多返回 `429 TOO_MANY_ATTEMPTS` | `{ ok, username, role }` + `Set-Cookie: nm_session=...`（失败 `401 INVALID_CREDENTIALS` / `BAD_NONCE`） |
| POST | `/api/logout` | 登录 | 销毁会话、清除 Cookie | `{ ok }` |
| GET | `/api/session` | 登录 | 会话探测 | `{ authenticated, username, role, isAdmin }` |
| GET | `/api/events` | 登录 | SSE 实时事件流（目录变更推送，免轮询） | `text/event-stream` |

---

## 二、根目录与浏览

| 方法 | 路径 | 权限 | 说明 / 参数 | 返回 |
|---|---|---|---|---|
| GET | `/api/roots` | read | 根目录列表（admin 首位为「此电脑」；个人主目录恒显示） | `{ roots:[{key,path,systemDrive,label}], system }` |
| GET | `/api/drives` | read | 全部磁盘列表（`?force=1` 强制重枚举） | `{ drives:[{key,name,type,ready,size,free}] }` |
| GET | `/api/list` | read | 列目录。Query：`root, path, showHidden(0/1), sort(name/type/size/mtime), sortDir(1/-1), page, pageSize, confirmSystemDrive`。`root=__computer__` 且无 `path` 时返回磁盘列表 | `{ path, entries:[{name,isDir,size,mtime,favorited,hidden}], total,page,pageSize }`（系统盘未确认 → `423`） |
| GET | `/api/stat` | read | 递归统计：`root, path`。返回递归大小 / 文件数 / 绝对路径 | `{ size, count, abs }` |
| GET | `/api/attr` | read | 读取只读/隐藏属性：`root, path` | `{ readonly, hidden }` |

---

## 三、文件操作（CRUD）

> 通用 Body 字段：`root, path, destRoot, destPath`（路径相对各根）。以下仅列差异。

| 方法 | 路径 | 权限 | 说明 / Body | 返回 |
|---|---|---|---|---|
| POST | `/api/mkdir` | write | 新建文件夹：`{ root, path }` | `{ ok }` |
| POST | `/api/rename` | write | 重命名：`{ root, path, newName }` | `{ ok }` |
| POST | `/api/move` | write | 移动：`{ root, path, destRoot, destPath }` | `{ ok }` |
| POST | `/api/copy` | write | 复制（递归）：`{ root, path, destRoot, destPath }` | `{ ok }` |
| POST | `/api/create` | write | 新建文件：`{ root, path, kind(txt\|docx\|xlsx) }`（docx/xlsx 服务端生成最小可用文档） | `{ ok }` |
| POST | `/api/batch-rename` | write | 批量重命名：`{ root, path, items:[{from,to}] }` 或按规则 | `{ ok, results }` |
| PUT | `/api/file` | write | 文本文件保存（写回原文件，自动备份 `.bak` + 版本快照）。Body 为文件内容（utf8，上限 50MB），Query：`root, path` | `{ ok }` |
| POST | `/api/delete` | delete | 删除 → 进回收站（异步，返回 jobId）：`{ root, path, modifier? }`。禁止删根目录本身 | `{ ok, jobId }` |
| POST | `/api/chmod` | write | 改只读/隐藏：`{ root, path, readonly?, hidden? }` | `{ ok, readonly, hidden }` |

---

## 四、上传（TUS 断点续传）

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| ALL | `/api/upload` `/api/upload/*` | write | TUS 协议端点（`@tus/server`）。上传元数据 `metadata` 含 `root`（目标根，缺省 `__home__`）、`path`（目标子路径）、`filename`。完成后由 `onUploadFinish` 移动到目标根（`DATA_DIR/uploads` 与目标根若不在同一块盘会自动「复制+删除」回退，避免跨磁盘 EXDEV）；**仅“系统盘根目录本身”（如 `C:\`）被兜底拒绝（403），其子目录（含个人主目录）均允许**；根隔离校验同步进行 | TUS 标准响应（`201 Created` / `204`）。前端用 `vendor/tus.min.js` |

> 前端上传进度通过 `POST /api/job/:id/progress` / `finish` 回报后台任务。

---

## 五、下载与预览

| 方法 | 路径 | 权限 | 说明 / Query | 返回 |
|---|---|---|---|---|
| GET | `/api/download` | read | 下载文件/文件夹打包：`root, path, confirmSystemDrive`。文件夹自动打包 ZIP 流式下载 | 二进制流（`Content-Disposition: attachment`） |
| GET | `/api/file` | read | 在线预览（图片/视频/音频/PDF/文本/Office）。支持 Range（视频拖动） | 对应 MIME 的二进制流 |
| GET | `/api/audio-meta` | read | 音频元数据 | `{ duration, ... }` |
| GET | `/api/thumbnail` | read | 缩略图：`root, path, confirmSystemDrive`。图片 sharp / 视频 ffmpeg 抽帧，缓存进 `DATA_DIR/thumbnails` | 图片二进制 |
| GET | `/api/archive/list` | read | 浏览压缩包内部条目：`root, path` | `{ entries:[{name,isDir,size}] }` |
| GET | `/api/archive/preview-one` | read | 预览压缩包内单个文件内容 | 二进制 |
| POST | `/api/archive/extract-one` | write | 解压压缩包内单个文件到目标：`{ root, path, entry, destRoot, destPath }` | `{ ok }` |
| GET | `/api/office/preview` | read | Office 预览（docx/xlsx → HTML/JSON，离线无需 CDN）：`root, path` | `{ type, html|sheets }` |
| GET | `/api/office/excel` | read | 读取 Excel 为 JSON：`root, path` | `{ sheets:[{name,rows}] }` |
| GET | `/api/office/word` | read | 读取 Word 为 HTML：`root, path` | `{ html }` |
| POST | `/api/office/excel/save` | write | 保存 Excel 编辑结果：`{ root, path, sheets }` | `{ ok }` |
| POST | `/api/office/word/save` | write | 保存 Word 编辑结果：`{ root, path, html }` | `{ ok }` |

---

## 六、压缩与解压

| 方法 | 路径 | 权限 | 说明 / Body | 返回 |
|---|---|---|---|---|
| POST | `/api/compress` | write | 压缩为 ZIP：`{ root, path, destRoot?, destPath?, password?, level(best\|store) }`（密码用 AES-256） | `{ ok, jobId? }` |
| POST | `/api/extract` | write | 解压：`{ root, path, destRoot?, destPath?, password? }`（支持 ZIP / TAR.GZ，解密校验） | `{ ok, jobId? }` |
| POST | `/api/download-selected` | write | 多选文件/文件夹打包 ZIP 下载：`{ root, items:[path...] }` | 二进制流 |

---

## 七、回收站

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| GET | `/api/recycle/list` | read | 回收站列表（按用户可访问根隔离；非 admin 仅见自己根的条目） | `[{ id, name, originalPath, root, size, deletedAt }]` |
| POST | `/api/recycle/restore` | delete | 还原：`{ id }` | `{ ok }` |
| POST | `/api/recycle/purge` | delete | 清空/删除：`{ id? }`（`id` 缺省 = 清空全部，需 admin；指定 `id` 按根隔离） | `{ ok }` |

---

## 八、收藏夹

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| GET | `/api/favorites` | read | 收藏列表 | `[{ root, path, name }]` |
| POST | `/api/favorite` | write | 添加：`{ root, path }` | `{ ok }` |
| DELETE | `/api/favorite` | delete | 移除：`{ root, path }` | `{ ok }` |

---

## 九、文件版本

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| GET | `/api/versions` | read | 某文件的历史版本列表：`root, path` | `{ versions:[{ name, size, mtime }] }` |
| POST | `/api/version/restore` | write | 还原某版本：`{ root, path, name }` | `{ ok }` |
| GET | `/api/version/content` | read | 读取单版本内容（预览）：`root, path, name, ext` | 二进制 |
| POST | `/api/version/delete` | delete | 删除单版本：`{ root, path, name }` | `{ ok }` |

> 版本保存于 `DATA_DIR`（不污染共享目录），默认保留 `VERSIONS_MAX_AGE_DAYS=90` 天。

---

## 十、搜索

> **索引自动构建**：服务启动后会在后台**自动**建立/刷新名称索引（无需手动触发）；`POST /api/search/reindex` 仍可用于强制全量重建。构建过程分批让出事件循环 + 节流休眠（`SEARCH_THROTTLE_MS`，默认 2ms/批），即使全盘扫描也不会卡死服务器。文件变更经 `fs.watch` 增量重建（3 秒防抖）。

| 方法 | 路径 | 权限 | 说明 / 参数 | 返回 |
|---|---|---|---|---|
| GET | `/api/search` | read | 名称搜索（内存索引）。Query：`q, ext, root, minSize, maxSize, after(ISO), before(ISO), limit`。`root=__computer__` 且 admin 触发实时受限遍历 | `{ count, results:[{root,owner,path,name,size,mtime,ext,dir}] }` |
| POST | `/api/search/content` | read | 全文内容搜索（按用户授权根实时分块遍历）：Body `{ q, root? }` | `{ count, scanned, results:[{root,path,name,snippet}] }` |
| POST | `/api/search/reindex` | **admin** | 异步重建名称索引（立即返回，轮询状态） | `{ started, status }` |
| GET | `/api/search/status` | read | 索引状态 | `{ building, lastBuild:{startedAt,finishedAt,count,error}, progress, count }` |

---

## 十一、去重与校验

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| GET | `/api/dedup` | read | 按内容哈希扫描重复文件：`root` | `{ groups:[{ hash, size, files:[...] }] }` |
| POST | `/api/checksum` | read | 计算校验和：`{ root, path, algo?(md5\|sha1\|sha256) }` | `{ algo, hash }` |

---

## 十二、共享链接（公开访问）

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| POST | `/api/share` | write | 创建：`{ root, path, expiresInHours?(0=永久), password? }`。基于绝对路径快照，个人空间分享也能公开访问 | `{ ok, token, url, hasPassword, expiresAt }` |
| GET | `/api/shares` | read | 列出全部共享 | `{ shares:[...] }` |
| DELETE | `/api/share` | write | 撤销：`{ token }` 或 `?token=` | `{ ok }` |
| POST | `/api/share/extend` | write | 延期：`{ token, hours }`（`hours=0` 永久） | `{ ok, expiresAt }` |
| GET | `/s/:token` | **公开** | 公开访问页（文件夹渲染目录、文件渲染预览页；可带 `?pw=密码`、`?f=子路径`） | HTML |
| GET | `/s/:token/raw` | **公开** | 原始文件流（内联预览/下载），支持 `?dl=1` 下载、`?pw=`、`?f=` 子路径、`Range` 续传 | 二进制流 |

---

## 十三、用户与权限（仅管理员）

| 方法 | 路径 | 权限 | 说明 / Body | 返回 |
|---|---|---|---|---|
| GET | `/api/users` | admin | 用户列表 + 可分配根 | `{ users:[{username,role,roots,perms,disabled}], roots }` |
| POST | `/api/users` | admin | 新建：`{ username, password(≥6), role?, roots?, perms? }`。自动建个人空间 `D:\<用户名>` | `{ ok, user }` |
| PUT | `/api/users/:username` | admin | 更新：`{ roots?, perms?, disabled?, password? }`。禁止禁用/删最后一个管理员；个人主目录不可移除 | `{ ok, user }` |
| DELETE | `/api/users/:username` | admin | 删除（禁删自己/最后一个管理员） | `{ ok }` |
| POST | `/api/account/change-password` | **登录** | 自助改密（任意用户）：`{ oldHash(SHA-256旧密码), newHash(SHA-256新密码) }`。旧密码错 → `401 OLD_WRONG`；改密后其他会话失效 | `{ ok }` |

> 角色：`admin`（拥有全部根 + 用户管理 + 全部权限）；`user`（仅被分配的根 + 个人主目录 + 按 `perms` 的 read/write/delete）。

---

## 十四、设置（运行时，持久化）

| 方法 | 路径 | 权限 | 说明 / Body | 返回 |
|---|---|---|---|---|
| GET | `/api/settings` | **登录** | 读取当前设置（供设置面板/自助改密） | `{ hideWindowsHidden, webdavEnabled, versionsMaxAgeDays, recycleAutopurgeDays, letsencrypt* }` |
| POST | `/api/settings` | admin | 一次性设置全部可视化项（持久化到 `DATA_DIR/settings.json`），并立即应用留存策略 + ACME | `{ ok, ...settings }` |
| POST | `/api/settings/hide-windows-hidden` | admin | 切换是否扫描 Windows 隐藏属性：`{ enabled }` | `{ ok, hideWindowsHidden }` |
| POST | `/api/settings/webdav` | admin | WebDAV 开关（运行时即时生效，无需重启）：`{ enabled }` | `{ ok, webdavEnabled }` |
| GET | `/api/webdav/status` | read | WebDAV 真实状态：`{ enabled, serving, mountPath:'/dav' }` | `{ enabled, serving, mountPath }` |
| GET | `/api/prefs` | 登录 | 用户显示偏好（前端唯一来源） | `{ ... }` |
| POST | `/api/prefs` | 登录 | 写入显示偏好 | `{ ok }` |
| GET | `/api/info` | 登录 | 服务器信息（用户名/数据目录/根/系统盘/各开关） | `{ username, role, dataDir, roots, system, hideWindowsHidden, webdavEnabled, letsencrypt*, httpsPort, acmeHttpPort, retentionLastRun }` |

---

## 十五、缩略图 / 后台任务 / 管理 / ACME

| 方法 | 路径 | 权限 | 说明 | 返回 |
|---|---|---|---|---|
| GET | `/api/thumbnail` | read | 见「五、下载与预览」 | 图片二进制 |
| GET | `/api/jobs` | 登录 | 后台任务列表（上传/压缩/解压/复制/删除进度） | `{ jobs:[...] }` |
| GET | `/api/job/:id` | 登录 | 单任务详情 | `{ ... }` |
| POST | `/api/job/:id/progress` | 登录 | 更新进度 `{ percent }` 或 `{ done, total }` | `{ ok }` |
| POST | `/api/job/:id/finish` | 登录 | 结束任务 `{ status?(done\|failed), error? }` | `{ ok }` |
| DELETE | `/api/jobs/:id` | 登录 | 删除任务记录 | `{ ok, removed }` |
| POST | `/api/admin/clear-thumbnails` | admin | 清空缩略图缓存 | `{ ok }` |
| POST | `/api/admin/retention-run` | admin | 立即执行留存策略（回收站自动清理 / 版本过期） | `{ ok }` |
| GET | `/api/letsencrypt/status` | admin | ACME 证书状态 | `{ cert:{ issuer, domains, daysLeft }, ... }` |
| POST | `/api/letsencrypt/request` | admin | 申请/续期证书：`{ domains, email, staging? }` | `{ ok }` |

---

## 十六、WebDAV（仅管理员）

WebDAV 挂载于 `/dav`（及 `/dav/*`），采用 HTTP Basic 认证（账密同网页登录），**仅 `admin` 可访问**（子账号 Basic 认证失败返回 `403`；未带凭证返回 `401`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| OPTIONS | `/dav` | 返回 `DAV: 1,2`、`MS-AuthorVia`、允许的 WebDAV 方法 |
| PROPFIND | `/dav` `/dav/<path>` | 列出磁盘 / 目录（Depth 0/1/infinity，207 multistatus XML） |
| GET / HEAD | `/dav/<path>` | 下载文件（支持 Range 续传） |
| PUT | `/dav/<path>` | 上传/覆盖（自动建父目录） |
| DELETE | `/dav/<path>` | 删除（禁删盘根） |
| MKCOL | `/dav/<path>` | 建目录 |
| MOVE / COPY | `/dav/<path>` | 移动 / 复制（跨设备 COPY 后删源） |
| LOCK / UNLOCK | `/dav/<path>` | 最小实现（返回 opaquelocktoken，满足 Windows 资源管理器） |
| PROPPATCH | `/dav/<path>` | 207 空响应 |

> 路径约定：URL 中盘符不带冒号，如 `/dav/C/Users` 对应 `C:\Users`。WebDAV 不过滤隐藏/系统文件（低层文件访问协议）。建议先套 HTTPS，否则 Basic 密码 base64 明文裸奔。

---

## 错误码速查

| 状态码 / error | 含义 |
|---|---|
| `400 invalid path` | 路径越界 / 解析失败（如 `../` 逃逸被拒） |
| `401 UNAUTHORIZED` | 未登录或登录失败（INVALID_CREDENTIALS / BAD_NONCE） |
| `403 FORBIDDEN_ROOT` | 请求的根不属于该用户；`FORBIDDEN_ADMIN` 需管理员；`FORBIDDEN_PERM` 缺权限位 |
| `404 NOT_FOUND` | 文件/资源不存在 |
| `423 SYSTEM_DRIVE_CONFIRM` | 系统盘操作需确认（带 `confirmSystemDrive=1`） |
| `429 TOO_MANY_ATTEMPTS` | 登录失败限流 |
| `500` | 服务端错误（见 `nas.log`） |
