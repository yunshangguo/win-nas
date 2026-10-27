'use strict';
// ============================================================================
// WebDAV 模块：在 /dav 路径下暴露“此电脑”全部磁盘，可作为网络驱动器挂载。
// - 认证：HTTP Basic（WebDAV 客户端如 Windows 资源管理器 / macOS Finder / rclone /
//   Cyberduck 均使用 Basic 认证），凭证复用网页登录的 admin 账号（auth.verifyLogin）。
// - 路径：复用 paths.resolveWithin(COMPUTER_ROOT, sub)，天然防 ../ 越界与跨盘逃逸。
// - 协议：实现 OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / MOVE / COPY /
//   LOCK / UNLOCK / PROPPATCH。LOCK/UNLOCK 为最小实现（满足 Windows 资源管理器要求）。
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 工厂函数：由 server.js 注入依赖，避免重复引入与代码重复。
module.exports = function createWebdav({ resolveWithin, COMPUTER_ROOT, COMPUTER_SENTINEL, listDrives, auth, mimeOf }) {
  // ---- 内存锁表（仅用于返回 lock-token，满足 Windows 客户端；不强制校验锁） ----
  const lockStore = new Map(); // abs -> token

  // ---- WebDAV 路径 <-> 解析子路径 互转 ----
  // davSub 形如 ''（根）/ 'C' / 'C/Users/foo'（盘符不带冒号，避免 URL 中冒号歧义）
  function toResolveSub(davSub) {
    if (!davSub) return '';
    const m = davSub.match(/^([A-Za-z])(?:\/(.*))?$/);
    if (m) {
      const drive = m[1].toUpperCase();
      const rest = m[2] || '';
      return drive + ':' + (rest ? '/' + rest : '');
    }
    return davSub;
  }
  // 真实绝对路径 -> davSub（盘符去冒号，反斜杠转斜杠）
  function absToDavSub(abs) {
    const norm = path.resolve(abs);
    const m = norm.match(/^([A-Za-z]):\\?([\s\S]*)$/);
    if (m) {
      const drive = m[1].toUpperCase();
      const rest = m[2].replace(/\\/g, '/');
      return drive + (rest ? '/' + rest : '');
    }
    return null;
  }
  // 是否为盘符根（禁止删除/写入盘根，防整盘误删）
  function isDriveRoot(abs) { return /^[A-Za-z]:\\?$/i.test(abs); }

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 构造 DAV href（逐段 URL 编码，集合补尾斜杠）
  function hrefForDavSub(davSub, isDir) {
    const enc = String(davSub).split('/').map(s => s ? encodeURIComponent(s) : s).join('/');
    let h = '/dav/' + enc;
    if (isDir && !h.endsWith('/')) h += '/';
    return h;
  }

  function safeStat(abs) { try { return fs.statSync(abs); } catch (e) { return null; } }
  function fileInfo(abs, isDir, name) {
    const st = safeStat(abs);
    return {
      name: name != null ? name : path.basename(abs),
      isDir,
      size: st ? st.size : 0,
      mtime: st ? st.mtimeMs : Date.now(),
      ctime: st ? st.ctimeMs : Date.now()
    };
  }

  // ---- PROPFIND 单个资源的 propstat（返回属性值） ----
  function propResponse(href, isDir, info) {
    const size = isDir ? 0 : (info.size || 0);
    const mtime = info.mtime || Date.now();
    const ctime = info.ctime || mtime;
    const etag = '"' + size + '-' + mtime + '"';
    const resourcetype = isDir ? '<D:collection/>' : '';
    return '<D:response>' +
      '<D:href>' + xmlEscape(href) + '</D:href>' +
      '<D:propstat><D:prop>' +
        '<D:resourcetype>' + resourcetype + '</D:resourcetype>' +
        '<D:displayname>' + xmlEscape(info.name || path.basename(href)) + '</D:displayname>' +
        '<D:getlastmodified>' + new Date(mtime).toUTCString() + '</D:getlastmodified>' +
        '<D:creationdate>' + new Date(ctime).toISOString() + '</D:creationdate>' +
        '<D:getcontentlength>' + size + '</D:getcontentlength>' +
        '<D:getetag>' + etag + '</D:getetag>' +
        '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>' +
        '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>' +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
    '</D:response>';
  }
  // PROPFIND propname（仅返回属性名，值为空）
  function propNameResponse(href, isDir) {
    const props = ['resourcetype', 'displayname', 'getlastmodified', 'creationdate', 'getcontentlength', 'getetag', 'supportedlock'];
    const inner = props.map(p => '<D:' + p + '/>').join('');
    return '<D:response><D:href>' + xmlEscape(href) + '</D:href>' +
      '<D:propstat><D:prop>' + inner + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }
  function sendMulti(res, responses) {
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:multistatus xmlns:D="DAV:">\n' + responses.join('\n') + '\n</D:multistatus>';
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(207).send(xml);
  }

  function collectBody(req, limit) {
    limit = limit || (1 << 20);
    return new Promise((resolve) => {
      let data = ''; let size = 0; let done = false;
      req.on('data', c => {
        if (done) return;
        size += c.length;
        if (size > limit) { done = true; req.resume(); resolve(null); return; }
        data += c.toString('utf8');
      });
      req.on('end', () => { if (!done) resolve(data); });
      req.on('error', () => resolve(null));
    });
  }

  // ---- 认证：HTTP Basic ----
  function basicAuth(req, res) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="NasManager"');
      res.status(401).end();
      return null;
    }
    let cred;
    try { cred = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { cred = ''; }
    const i = cred.indexOf(':');
    const user = i >= 0 ? cred.slice(0, i) : cred;
    const pass = i >= 0 ? cred.slice(i + 1) : '';
    const u = auth.verifyLogin({ username: user, password: pass });
    if (!u) {
      res.set('WWW-Authenticate', 'Basic realm="NasManager"');
      res.status(401).end();
      return null;
    }
    // WebDAV 暴露“此电脑”全部磁盘，属高风险能力，仅对管理员开放。
    if (u.role !== 'admin') {
      res.set('WWW-Authenticate', 'Basic realm="NasManager"');
      res.status(403).end();
      return null;
    }
    return { user: u.username, role: u.role };
  }

  // ---- 各种方法实现 ----
  function handleOptions(req, res) {
    res.set('DAV', '1, 2');
    res.set('MS-AuthorVia', 'DAV');
    res.set('Allow', 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,COPY,PROPFIND,PROPPATCH,LOCK,UNLOCK');
    res.set('Public', 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,COPY,PROPFIND,PROPPATCH,LOCK,UNLOCK');
    res.status(200).end();
  }

  function handleRootPropfind(req, res, depth) {
    const responses = [];
    responses.push(propResponse('/dav/', true, { name: 'NasManager', isDir: true, size: 0, mtime: Date.now(), ctime: Date.now() }));
    if (depth === '0') return sendMulti(res, responses);
    const drives = (typeof listDrives === 'function') ? listDrives() : [];
    for (const d of drives) {
      const href = '/dav/' + d.key + '/';
      const label = (d.name ? d.name + ' (' + d.key + ':)' : d.key + ':');
      // 不逐盘 stat（未就绪的光驱 / 网络盘会阻塞）：直接用磁盘枚举结果，mtime 取当前时间（仅展示用）
      responses.push(propResponse(href, true, { name: label, isDir: true, size: 0, mtime: Date.now(), ctime: Date.now() }));
    }
    return sendMulti(res, responses);
  }

  async function handlePropfind(req, res, abs, sub) {
    const depth = (req.headers.depth || '1').toLowerCase();
    const body = await collectBody(req);
    const wantNames = body && /propname/i.test(body);
    const st = safeStat(abs);
    const isDir = !!st && st.isDirectory();
    const href = hrefForDavSub(sub, isDir);
    const selfInfo = { name: path.basename(abs), isDir, size: st ? st.size : 0, mtime: st ? st.mtimeMs : Date.now(), ctime: st ? st.ctimeMs : Date.now() };
    const responses = [];
    if (wantNames) responses.push(propNameResponse(href, isDir));
    else responses.push(propResponse(href, isDir, selfInfo));
    if (depth === '0') return sendMulti(res, responses);
    if (isDir) {
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return sendMulti(res, responses); }
      for (const e of entries) {
        const childAbs = path.join(abs, e.name);
        const childIsDir = e.isDirectory();
        const childDavSub = (sub ? sub + '/' : '') + e.name;
        const childHref = hrefForDavSub(childDavSub, childIsDir);
        const info = fileInfo(childAbs, childIsDir);
        if (wantNames) responses.push(propNameResponse(childHref, childIsDir));
        else responses.push(propResponse(childHref, childIsDir, info));
      }
    }
    return sendMulti(res, responses);
  }

  function streamRaw(req, res, abs, st) {
    const total = st.size;
    const mimetype = (typeof mimeOf === 'function') ? mimeOf(abs) : 'application/octet-stream';
    res.set('Content-Type', mimetype);
    res.set('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD') {
      res.status(200).set('Content-Length', total).end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = 0, end = total - 1;
      if (m) { if (m[1]) start = parseInt(m[1], 10); if (m[2]) end = parseInt(m[2], 10); }
      if (isNaN(start) || isNaN(end) || start > end || start >= total)
        return res.status(416).set('Content-Range', 'bytes */' + total).end();
      end = Math.min(end, total - 1);
      res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + total).set('Content-Length', end - start + 1);
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.status(200).set('Content-Length', total);
      fs.createReadStream(abs).pipe(res);
    }
  }

  function handleGet(req, res, abs, sub) {
    const st = safeStat(abs);
    if (!st) return res.status(404).end();
    if (st.isDirectory()) return res.status(404).end(); // 不能 GET 一个目录
    return streamRaw(req, res, abs, st);
  }

  function handlePut(req, res, abs, sub) {
    if (isDriveRoot(abs)) return res.status(403).end();
    const existed = !!safeStat(abs);
    if (existed && safeStat(abs).isDirectory()) return res.status(409).end(); // 不能 PUT 到已存在的目录
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (e) {}
    const ws = fs.createWriteStream(abs);
    req.pipe(ws);
    ws.on('finish', () => res.status(existed ? 204 : 201).end());
    ws.on('error', () => res.status(500).end());
    req.on('error', () => res.status(500).end());
  }

  function handleDelete(req, res, abs, sub) {
    if (!safeStat(abs)) return res.status(404).end();
    if (isDriveRoot(abs)) return res.status(403).end();
    try {
      if (safeStat(abs).isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
      res.status(204).end();
    } catch (e) { res.status(409).end(); }
  }

  function handleMkcol(req, res, abs, sub) {
    if (safeStat(abs)) return res.status(405).end(); // 已存在
    if (isDriveRoot(abs)) return res.status(403).end();
    try { fs.mkdirSync(abs, { recursive: false }); res.status(201).end(); }
    catch (e) { res.status(409).end(); } // 父目录不存在等
  }

  function parseDestination(req) {
    const dest = req.headers.destination;
    if (!dest) return null;
    let pathname;
    try { pathname = new URL(dest).pathname; } catch (e) { pathname = dest; }
    pathname = decodeURIComponent(pathname).replace(/^\/dav/, '').replace(/^\/+/, '');
    return toResolveSub(pathname);
  }

  function copyRecursive(src, dst) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src)) copyRecursive(path.join(src, e), path.join(dst, e));
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }

  function removeExisting(abs) {
    try {
      if (safeStat(abs).isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
      return true;
    } catch (e) { return false; }
  }

  function handleMove(req, res, abs, sub) {
    if (!safeStat(abs)) return res.status(404).end();
    if (isDriveRoot(abs)) return res.status(403).end();
    const destSub = parseDestination(req);
    const destAbs = resolveWithin(COMPUTER_ROOT, destSub);
    if (!destAbs || destAbs === COMPUTER_SENTINEL) return res.status(400).end();
    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
    if (safeStat(destAbs)) {
      if (!overwrite) return res.status(412).end();
      if (!removeExisting(destAbs)) return res.status(409).end();
    }
    try { fs.mkdirSync(path.dirname(destAbs), { recursive: true }); } catch (e) {}
    try {
      fs.renameSync(abs, destAbs);
      return res.status(204).end();
    } catch (e) {
      // 跨设备：复制后删除源
      try { copyRecursive(abs, destAbs); fs.rmSync(abs, { recursive: true, force: true }); res.status(204).end(); }
      catch (e2) { res.status(500).end(); }
    }
  }

  function handleCopy(req, res, abs, sub) {
    if (!safeStat(abs)) return res.status(404).end();
    if (isDriveRoot(abs)) return res.status(403).end();
    const destSub = parseDestination(req);
    const destAbs = resolveWithin(COMPUTER_ROOT, destSub);
    if (!destAbs || destAbs === COMPUTER_SENTINEL) return res.status(400).end();
    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
    if (safeStat(destAbs)) {
      if (!overwrite) return res.status(412).end();
      if (!removeExisting(destAbs)) return res.status(409).end();
    }
    try { fs.mkdirSync(path.dirname(destAbs), { recursive: true }); } catch (e) {}
    try { copyRecursive(abs, destAbs); res.status(201).end(); }
    catch (e) { res.status(500).end(); }
  }

  function handleLock(req, res, abs, sub) {
    let token = lockStore.get(abs);
    if (!token) { token = 'opaquelocktoken:' + crypto.randomBytes(16).toString('hex'); lockStore.set(abs, token); }
    const href = hrefForDavSub(sub, !!safeStat(abs) && safeStat(abs).isDirectory());
    const lockdiscovery =
      '<D:lockdiscovery><D:activelock>' +
        '<D:locktype><D:write/></D:locktype>' +
        '<D:lockscope><D:exclusive/></D:lockscope>' +
        '<D:depth>infinity</D:depth>' +
        '<D:timeout>Second-3600</D:timeout>' +
        '<D:locktoken><D:href>' + xmlEscape(token) + '</D:href></D:locktoken>' +
        '<D:lockroot><D:href>' + xmlEscape(href) + '</D:href></D:lockroot>' +
      '</D:activelock></D:lockdiscovery>';
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Lock-Token', '<' + token + '>');
    res.status(200).send('<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:">' + lockdiscovery + '</D:prop>');
  }

  function handleUnlock(req, res, abs, sub) {
    const tok = req.headers.lock_token;
    if (tok) {
      const t = tok.replace(/[<>]/g, '');
      for (const [k, v] of lockStore) if (v === t || ('<' + v + '>' === tok)) lockStore.delete(k);
    }
    res.status(204).end();
  }

  function handleProppatch(req, res, abs, sub) {
    const href = hrefForDavSub(sub, !!safeStat(abs) && safeStat(abs).isDirectory());
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:multistatus xmlns:D="DAV:"><D:response><D:href>' + xmlEscape(href) +
      '</D:href><D:propstat><D:prop></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(207).send(xml);
  }

  // ---- 主处理器 ----
  function handleWebdav(req, res) {
    const cred = basicAuth(req, res);
    if (!cred) return;
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return handleOptions(req, res);

    let p = req.path || '';
    let sub = p.replace(/^\/dav/, '');
    try { sub = decodeURIComponent(sub); } catch (e) {}
    sub = sub.replace(/^\/+/, '');
    const isRoot = (sub === '');

    if (isRoot) {
      if (method === 'PROPFIND') return handleRootPropfind(req, res, (req.headers.depth || '1').toLowerCase());
      if (method === 'GET' || method === 'HEAD') return res.status(200).set('Content-Type', 'text/html; charset=utf-8')
        .send('NasManager WebDAV 根目录。请用 WebDAV 客户端（Windows 资源管理器 / macOS Finder / rclone / Cyberduck）连接到此地址。');
      if (method === 'LOCK') return handleLock(req, res, COMPUTER_SENTINEL, '');
      if (method === 'UNLOCK') return handleUnlock(req, res, COMPUTER_SENTINEL, '');
      if (method === 'PROPPATCH') return handleProppatch(req, res, COMPUTER_SENTINEL, '');
      res.set('Allow', 'OPTIONS,GET,HEAD,PROPFIND,LOCK,UNLOCK,PROPPATCH').status(405).end();
      return;
    }

    const abs = resolveWithin(COMPUTER_ROOT, toResolveSub(sub));
    if (!abs || abs === COMPUTER_SENTINEL) return res.status(404).end();

    // 目录不存在时：PUT 允许创建（其余方法 404）
    const exists = !!safeStat(abs);
    if (!exists && method !== 'PUT' && method !== 'MKCOL' && method !== 'LOCK') {
      // LOCK 一个不存在的目标也允许（先创建再锁，常见于编辑器）
      if (method !== 'LOCK') return res.status(404).end();
    }

    switch (method) {
      case 'PROPFIND': return handlePropfind(req, res, abs, sub);
      case 'GET': case 'HEAD': return handleGet(req, res, abs, sub);
      case 'PUT': return handlePut(req, res, abs, sub);
      case 'DELETE': return handleDelete(req, res, abs, sub);
      case 'MKCOL': return handleMkcol(req, res, abs, sub);
      case 'MOVE': return handleMove(req, res, abs, sub);
      case 'COPY': return handleCopy(req, res, abs, sub);
      case 'LOCK': return handleLock(req, res, abs, sub);
      case 'UNLOCK': return handleUnlock(req, res, abs, sub);
      case 'PROPPATCH': return handleProppatch(req, res, abs, sub);
      default:
        res.set('Allow', 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,COPY,PROPFIND,PROPPATCH,LOCK,UNLOCK').status(405).end();
    }
  }

  return handleWebdav;
};
