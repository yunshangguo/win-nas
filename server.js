'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { DATA_DIR, ROOTS, PORT, getDrive, SYSTEM_DRIVES } = require('./config');
const { resolveWithin, isSystemDrive, isSystemDriveRoot, needSystemConfirm, safeName, COMPUTER_ROOT, COMPUTER_SENTINEL, HOME_ROOT, homePathFor } = require('./src/paths');
const userCtx = require('./src/userctx');
const recycle = require('./src/recycle');
const thumbnails = require('./src/thumbnails');
const search = require('./src/search');
search.setListDrives(listDrives); // 注入盘枚举，供“此电脑”搜索/实时遍历使用
const auth = require('./src/auth');
const archive = require('./src/archive');
const share = require('./src/share');
const { Server: TusServer } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const iconv = require('iconv-lite');
const jobs = require('./src/jobs');
const favorites = require('./src/favorites');
const versions = require('./src/versions');
const dedup = require('./src/dedup');
const office = require('./src/office');
const acmeMgr = require('./src/acme');
const { execSync } = require('child_process');

// 文档类扩展名（版本历史仅对这类文件生效；图片/视频/音频等媒体不做历史版本）。
const DOC_EXT = new Set(['doc', 'docx', 'docm', 'dotx', 'dotm', 'xls', 'xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb', 'ppt', 'pptx', 'pptm', 'potx', 'ppsx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'pdf', 'json', 'xml', 'html', 'htm', 'js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'sh', 'bat', 'ps1', 'sql', 'yaml', 'yml', 'ini', 'cfg', 'log', 'rtf', 'odt', 'ods', 'odp']);
function isDocExt(abs) {
  const ext = (path.extname(abs) || '').toLowerCase().replace(/^\./, '');
  return DOC_EXT.has(ext);
}


// ---- Windows 文件属性（只读 / 隐藏）辅助 ----
function setHiddenAttr(abs, hidden) {
  if (process.platform !== 'win32') return;
  try { execSync('attrib ' + (hidden ? '+' : '-') + 'h "' + abs + '"', { windowsHide: true }); } catch (e) {}
}
function getHiddenAttr(abs) {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('attrib "' + abs + '"', { windowsHide: true }).toString();
    const first = (out.split('\n')[0] || '').trim();
    return /\bH\b/.test(first);
  } catch (e) { return false; }
}
// 批量读取目录下所有文件的隐藏属性：一次 execSync（cmd /u 输出 UTF-16LE，中文名正确），
// 解析为 { 文件名: true } 映射。避免在 /list 中对每个文件逐次 spawn attrib 子进程（大目录极慢）。
// 加缓存：同一目录在 TTL 内复用结果，显著减少子进程开销（目录树展开 / 反复列举时尤其明显），
// 这是“打开文件夹慢”的主要优化点之一（每次 /list 原本都要现 spawn 一次 attrib）。
// ---- 可持久化设置（统一存到 DATA_DIR/settings.json，重启后保留） ----
let WEBDAV_ENABLED = true;          // WebDAV 网络磁盘开关
let HIDE_WINDOWS_HIDDEN = false;    // 是否扫描 Windows 隐藏属性
// 版本快照保留天数 / 回收站自动清理天数：env 为初值，settings.json 可覆盖（0 = 关闭自动清理）
let VERSIONS_MAX_AGE_DAYS = process.env.VERSIONS_MAX_AGE_DAYS ? Number(process.env.VERSIONS_MAX_AGE_DAYS) : 90;
let RECYCLE_AUTOPURGE_DAYS = process.env.RECYCLE_AUTOPURGE_DAYS ? Number(process.env.RECYCLE_AUTOPURGE_DAYS) : 0;
// Let's Encrypt / ACME 自动证书：启用开关 + 域名(逗号分隔) + 邮箱 + 是否用 staging 测试环境
let LETSENCRYPT_ENABLED = false;
let LETSENCRYPT_DOMAINS = '';
let LETSENCRYPT_EMAIL = '';
let LETSENCRYPT_STAGING = false;
// ACME 挑战端口 / HTTPS 端口（默认 80 / 443；绑定 80/443 通常需要管理员权限）
const ACME_HTTP_PORT = parseInt(process.env.ACME_HTTP_PORT || '80', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
// 留存（存储清理）最近一次执行记录：{ runAt, versionsPruned, recyclePurged }，持久化以便前端展示
let retentionLastRun = null;

// ---- 登录防爆破：单 IP 滑动窗口限流（避免明文 HTTP 下被无限试密码） ----
const LOGIN_MAX_FAIL = 5;            // 窗口内最多失败次数
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 失败计数窗口 15 分钟
const LOGIN_BLOCK_MS = 15 * 60 * 1000;  // 触发后锁定 15 分钟
const loginFails = new Map();           // ip -> { count, firstTs, blockedUntil }
function loginClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}
function loginCheckBlock(ip) {
  const e = loginFails.get(ip);
  return !!(e && e.blockedUntil && e.blockedUntil > Date.now());
}
function loginRegisterSuccess(ip) { loginFails.delete(ip); }
function loginRegisterFailure(ip) {
  const now = Date.now();
  let e = loginFails.get(ip);
  if (!e || !e.firstTs || (now - e.firstTs > LOGIN_WINDOW_MS)) {
    e = { count: 0, firstTs: now, blockedUntil: 0 };
  }
  e.count++;
  if (e.count >= LOGIN_MAX_FAIL) { e.blockedUntil = now + LOGIN_BLOCK_MS; e.count = 0; }
  loginFails.set(ip, e);
}
// 周期性清理过期限流记录，避免 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFails) {
    if (e.blockedUntil && e.blockedUntil <= now) loginFails.delete(ip);
    else if (!e.blockedUntil && e.firstTs && (now - e.firstTs > LOGIN_WINDOW_MS)) loginFails.delete(ip);
  }
}, 10 * 60 * 1000);
function loadPersistedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (typeof s.webdavEnabled === 'boolean') WEBDAV_ENABLED = s.webdavEnabled;
      if (typeof s.hideWindowsHidden === 'boolean') HIDE_WINDOWS_HIDDEN = s.hideWindowsHidden;
      if (typeof s.versionsMaxAgeDays === 'number' && isFinite(s.versionsMaxAgeDays) && s.versionsMaxAgeDays >= 0) VERSIONS_MAX_AGE_DAYS = s.versionsMaxAgeDays;
      if (typeof s.recycleAutopurgeDays === 'number' && isFinite(s.recycleAutopurgeDays) && s.recycleAutopurgeDays >= 0) RECYCLE_AUTOPURGE_DAYS = s.recycleAutopurgeDays;
      if (typeof s.letsencryptEnabled === 'boolean') LETSENCRYPT_ENABLED = s.letsencryptEnabled;
      if (typeof s.letsencryptDomains === 'string') LETSENCRYPT_DOMAINS = s.letsencryptDomains;
      if (typeof s.letsencryptEmail === 'string') LETSENCRYPT_EMAIL = s.letsencryptEmail;
      if (typeof s.letsencryptStaging === 'boolean') LETSENCRYPT_STAGING = s.letsencryptStaging;
      if (s.retentionLastRun && typeof s.retentionLastRun === 'object') retentionLastRun = s.retentionLastRun;
    }
  } catch (e) { /* 损坏则用默认值 */ }
}
function savePersistedSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      webdavEnabled: WEBDAV_ENABLED,
      hideWindowsHidden: HIDE_WINDOWS_HIDDEN,
      versionsMaxAgeDays: VERSIONS_MAX_AGE_DAYS,
      recycleAutopurgeDays: RECYCLE_AUTOPURGE_DAYS,
      letsencryptEnabled: LETSENCRYPT_ENABLED,
      letsencryptDomains: LETSENCRYPT_DOMAINS,
      letsencryptEmail: LETSENCRYPT_EMAIL,
      letsencryptStaging: LETSENCRYPT_STAGING,
      retentionLastRun: retentionLastRun
    }, null, 2));
  } catch (e) { /* 忽略写入失败 */ }
}
// 统一的状态变更函数（所有设置写入的唯一入口）：保证后端是状态的唯一权威来源，
// 前端无论走“统一保存 /api/settings”还是“单独开关 /api/settings/webdav”都汇总到这里。
function applySettings(b) {
  if (!b || typeof b !== 'object') return;
  if (typeof b.webdavEnabled === 'boolean') WEBDAV_ENABLED = b.webdavEnabled;
  if (typeof b.hideWindowsHidden === 'boolean') HIDE_WINDOWS_HIDDEN = b.hideWindowsHidden;
  if (typeof b.versionsMaxAgeDays === 'number' && isFinite(b.versionsMaxAgeDays) && b.versionsMaxAgeDays >= 0) VERSIONS_MAX_AGE_DAYS = b.versionsMaxAgeDays;
  if (typeof b.recycleAutopurgeDays === 'number' && isFinite(b.recycleAutopurgeDays) && b.recycleAutopurgeDays >= 0) RECYCLE_AUTOPURGE_DAYS = b.recycleAutopurgeDays;
  if (typeof b.letsencryptEnabled === 'boolean') LETSENCRYPT_ENABLED = b.letsencryptEnabled;
  if (typeof b.letsencryptDomains === 'string') LETSENCRYPT_DOMAINS = b.letsencryptDomains;
  if (typeof b.letsencryptEmail === 'string') LETSENCRYPT_EMAIL = b.letsencryptEmail;
  if (typeof b.letsencryptStaging === 'boolean') LETSENCRYPT_STAGING = b.letsencryptStaging;
  savePersistedSettings();
}
loadPersistedSettings();

// ---- 用户显示偏好（前端只读取/设置，后端持久化为唯一来源；单用户，存 prefs.json） ----
// 这些只影响前端展示（布局 / 是否显示隐藏文件 / 是否自动算文件夹大小 / 侧栏宽度），不含任何服务端操作状态。
let PREFS = { layout: 'list', showHidden: false, autoFolderSize: false, sidebarW: 272 };
function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
      if (p && typeof p === 'object') {
        if (typeof p.layout === 'string') PREFS.layout = p.layout;
        if (typeof p.showHidden === 'boolean') PREFS.showHidden = p.showHidden;
        if (typeof p.autoFolderSize === 'boolean') PREFS.autoFolderSize = p.autoFolderSize;
        if (typeof p.sidebarW === 'number' && p.sidebarW >= 180 && p.sidebarW <= 600) PREFS.sidebarW = p.sidebarW;
      }
    }
  } catch (e) {}
}
function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(PREFS, null, 2)); } catch (e) {}
}
loadPrefs();
const hiddenMapCache = new Map();
const HIDDEN_CACHE_TTL = 2000; // 2 秒内复用
const HIDDEN_CACHE_MAX = 800;
function trimHiddenCache() {
  if (hiddenMapCache.size <= HIDDEN_CACHE_MAX) return;
  let oldestKey = null, oldestTs = Infinity;
  for (const [k, v] of hiddenMapCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
  if (oldestKey) hiddenMapCache.delete(oldestKey);
}
function getHiddenMap(abs) {
  // 性能优化：默认不扫描 Windows 隐藏属性（避免每个目录都 spawn attrib 子进程，2000 文件约 600ms）。
  // 仅当用户在设置中开启“隐藏 Windows 隐藏属性文件”时才扫描；名字规则始终生效。
  if (!HIDE_WINDOWS_HIDDEN) return Object.create(null);
  const now = Date.now();
  const cached = hiddenMapCache.get(abs);
  if (cached && now - cached.ts < HIDDEN_CACHE_TTL) return cached.map;
  const map = Object.create(null);
  if (process.platform === 'win32') {
    try {
      const buf = execSync('cmd /u /c attrib "' + abs + '\\*"', { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      let text;
      // 鲁棒解码：cmd /u 输出 UTF-16LE（通常无 BOM）；失败则按 UTF-8 / GBK（中文路径兜底）解码
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        try { text = iconv.decode(buf.slice(2), 'utf16-le'); } catch (e) { text = buf.toString('latin1'); }
      } else if (buf.length >= 2 && buf[1] === 0x00 && buf[0] !== 0x00) {
        try { text = iconv.decode(buf, 'utf16-le'); } catch (e) { text = buf.toString('latin1'); }
      } else {
        try { text = iconv.decode(buf, 'utf8'); } catch (e) {
          try { text = iconv.decode(buf, 'gbk'); } catch (e2) { text = buf.toString('latin1'); }
        }
      }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去掉 UTF-16 BOM
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const parts = t.split(/\s{2,}/);
        if (parts.length < 2) continue;
        const attrs = parts[0];
        const fullPath = parts[parts.length - 1].trim();
        const name = fullPath.split('\\').pop();
        if (/\bH\b/.test(attrs) && name) map[name] = true;
      }
    } catch (e) { /* 空目录等：attrib 报错，返回空映射 */ }
  }
  hiddenMapCache.set(abs, { ts: now, map });
  trimHiddenCache();
  return map;
}

auth.init(); // 初始化密码哈希（未配置则一次性生成初始密码）
share.init(DATA_DIR); // 初始化共享链接存储

// ---- 文件预览 / 编辑 支持的 MIME 与流式传输（含 Range 以支持视频拖动） ----
function extOf(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mkv: 'video/x-matroska', flv: 'video/x-flv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', js: 'text/javascript',
  ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript', html: 'text/html', htm: 'text/html',
  css: 'text/css', scss: 'text/css', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  csv: 'text/csv', log: 'text/plain', conf: 'text/plain', ini: 'text/plain', env: 'text/plain',
  py: 'text/x-python', java: 'text/x-java', c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c', go: 'text/x-go',
  rs: 'text/x-rust', sh: 'text/x-sh', bat: 'text/plain', ps1: 'text/plain', toml: 'text/plain', cfg: 'text/plain',
  properties: 'text/plain', sql: 'text/plain', php: 'text/x-php', rb: 'text/x-ruby', lua: 'text/plain', vue: 'text/plain',
  gitignore: 'text/plain'
};
function mimeOf(name) { return MIME[extOf(name)] || 'application/octet-stream'; }

// 文本类 MIME（需要按字符集解码，避免中文乱码）
const TEXT_MIME = /^(text\/|application\/(json|xml)|application\/javascript)/;
// 将文件 Buffer 解码为 UTF-8 字符串：优先识别 BOM，再用严格 UTF-8 探测，
// 失败则按 GBK/GB2312 解码（覆盖 Windows 记事本默认编码导致的乱码）。
function decodeToUtf8(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return iconv.decode(buf.slice(2), 'utf16-le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return iconv.decode(buf.slice(2), 'utf16-be');
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return dec.decode(buf);
  } catch (e) {
    try { return iconv.decode(buf, 'gbk'); } catch (e2) { return buf.toString('utf8'); }
  }
}

// ===== 最小可用 Office 文档生成（不依赖第三方库，手写 ZIP store） =====
function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32._t = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// 生成一个 ZIP（仅 store 压缩），parts: [{ name, data:Buffer }]
function makeZip(parts) {
  const local = [], central = [];
  let offset = 0;
  for (const f of parts) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);
    const cs = Buffer.alloc(46);
    cs.writeUInt32LE(0x02014b50, 0); cs.writeUInt16LE(20, 4); cs.writeUInt16LE(20, 6);
    cs.writeUInt16LE(0, 8); cs.writeUInt16LE(0, 10); cs.writeUInt16LE(0, 12);
    cs.writeUInt32LE(crc, 16); cs.writeUInt32LE(data.length, 20); cs.writeUInt32LE(data.length, 24);
    cs.writeUInt16LE(nameBuf.length, 28); cs.writeUInt16LE(0, 30); cs.writeUInt16LE(0, 32);
    cs.writeUInt16LE(0, 34); cs.writeUInt16LE(0, 36); cs.writeUInt32LE(0, 38); cs.writeUInt32LE(offset, 42);
    central.push(cs, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, end]);
}
const DOCX_FILES = [
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8') },
  { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8') },
  { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>', 'utf8') }
];
const XLSX_FILES = [
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', 'utf8') },
  { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', 'utf8') },
  { name: 'xl/workbook.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>', 'utf8') },
  { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
  { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>', 'utf8') }
];

function streamFile(req, res, abs, mime, attachment) {
  const stat = fs.statSync(abs);
  const total = stat.size;
  const isText = TEXT_MIME.test(mime) && !attachment; // 附件下载不做文本转码，原样落盘
  // 文本文件：小文件（<=25MB）整体读取并做编码转换，根治中文乱码
  let buf = null;
  if (isText && total > 0 && total <= 25 * 1024 * 1024) {
    buf = Buffer.from(decodeToUtf8(fs.readFileSync(abs)), 'utf8');
  }
  const sendMime = isText ? (mime + '; charset=utf-8') : mime;
  const sendTotal = buf ? buf.length : total;
  if (attachment) {
    res.set('Content-Disposition', 'attachment; filename="' +
      encodeURIComponent(path.basename(abs)) + '"; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(abs)));
  }
  const range = req.headers.range;
  res.set('Content-Type', sendMime);
  res.set('Accept-Ranges', 'bytes');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0, end = sendTotal - 1;
    if (m) { if (m[1]) start = parseInt(m[1], 10); if (m[2]) end = parseInt(m[2], 10); }
    if (isNaN(start) || isNaN(end) || start > end || start >= sendTotal) {
      return res.status(416).set('Content-Range', 'bytes */' + sendTotal).end();
    }
    end = Math.min(end, sendTotal - 1);
    res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + sendTotal).set('Content-Length', end - start + 1);
    if (buf) res.end(buf.slice(start, end + 1));
    else fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.status(200).set('Content-Length', sendTotal);
    if (buf) res.end(buf);
    else fs.createReadStream(abs).pipe(res);
  }
}

const app = express();
app.set('trust proxy', 'loopback'); // 让 req.secure 在反向代理(如 Caddy)后正确识别 HTTPS
app.use(express.json());

// HTTPS 时强制 HSTS（防 SSL 剥离 / 强制客户端始终走 TLS）。仅在真实加密连接时下发。
app.use((req, res, next) => {
  const proto = (req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (req.secure || proto === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---- 解析 Cookie（不引第三方依赖） ----
function parseCookies(req) {
  const out = {};
  const c = req.headers.cookie;
  if (!c) return out;
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ===== 强制登录 + 注入当前用户 =====
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const id = parseCookies(req).nm_session;
  const s = auth.getSession(id);
  if (s) req.user = auth.getUser(s.username); // 会话有效则注入用户记录（角色 / 可访问根 / 权限）
  // 免校验端点：登录 / 会话探测（SSE 事件流仍需经下方作用域校验）
  if (req.path === '/api/login' || req.path === '/api/login/challenge' || req.path === '/api/session') return next();
  if (!s) return res.status(401).json({ error: 'UNAUTHORIZED' });
  req.session = s;
  // 把当前请求用户写入请求级上下文，使 resolveWithin 能解析 __home__ 到本人目录
  userCtx.run(req.user, () => next());
});

// ===== 权限作用域：根目录隔离 + 权限位 + 管理员专属路由 =====
// 所有文件操作都经 resolveWithin(rootKey, sub) 解析根；本中间件统一把关，
// 无需在 90+ 个接口里逐个加校验：非管理员只能访问其被分配的根，并按权限位受限。
const PERM_MAP = {
  'GET /api/list': 'read', 'GET /api/stat': 'read', 'GET /api/download': 'read', 'GET /api/file': 'read',
  'GET /api/audio-meta': 'read', 'GET /api/thumbnail': 'read', 'GET /api/attr': 'read', 'GET /api/checksum': 'read',
  'GET /api/recycle/list': 'read', 'GET /api/favorites': 'read', 'GET /api/versions': 'read',
  'GET /api/version/content': 'read', 'GET /api/dedup': 'read', 'GET /api/search': 'read', 'GET /api/shares': 'read',
  'GET /api/archive/list': 'read', 'GET /api/archive/preview-one': 'read',
  'GET /api/office/preview': 'read', 'GET /api/office/excel': 'read', 'GET /api/office/word': 'read',
  'POST /api/mkdir': 'write', 'POST /api/rename': 'write', 'POST /api/move': 'write', 'POST /api/copy': 'write',
  'POST /api/create': 'write', 'POST /api/compress': 'write', 'POST /api/extract': 'write',
  'POST /api/archive/extract-one': 'write', 'POST /api/batch-rename': 'write', 'POST /api/chmod': 'write',
  'POST /api/favorite': 'write', 'POST /api/version/restore': 'write', 'POST /api/recycle/restore': 'write',
  'POST /api/share': 'write', 'POST /api/share/extend': 'write',
  'PUT /api/file': 'write', 'POST /api/office/excel/save': 'write', 'POST /api/office/word/save': 'write',
  'POST /api/delete': 'delete', 'POST /api/version/delete': 'delete',
  'POST /api/recycle/purge': 'delete', 'DELETE /api/favorite': 'delete', 'DELETE /api/share': 'delete'
};
// 管理员专属路由。method 仅用于 /api/settings：GET（基础读取）对所有登录用户开放
// （子账号也能打开设置/修改密码），写操作(POST/PUT) 与子路由仍仅 admin。
function isAdminOnlyRoute(p, method) {
  if (p.startsWith('/api/users')) return true;
  if (p === '/api/settings') return !!(method && method !== 'GET');
  if (p.startsWith('/api/settings/')) return true;
  if (p === '/api/admin/clear-thumbnails' || p === '/api/admin/retention-run') return true;
  if (p === '/api/letsencrypt/request' || p === '/api/letsencrypt/status') return true;
  if (p === '/api/search/reindex') return true;
  return false;
}
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.path === '/api/login' || req.path === '/api/login/challenge' || req.path === '/api/session' || req.path === '/api/events') return next();
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  // 管理员专属路由
  if (isAdminOnlyRoute(req.path, req.method) && user.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN_ADMIN' });
  // 根目录作用域：请求中出现的 root / destRoot 必须属于该用户（admin = 全部；非 admin 禁止“此电脑”）
  const allowed = auth.userRoots(user);
  const cand = [];
  if (req.query && req.query.root != null) cand.push(String(req.query.root));
  if (req.body && req.body.root != null) cand.push(String(req.body.root));
  if (req.body && req.body.destRoot != null) cand.push(String(req.body.destRoot));
  if (req.query && req.query.destRoot != null) cand.push(String(req.query.destRoot));
  for (const r of cand) {
    if (r === COMPUTER_ROOT) { if (user.role !== 'admin' && !allowed.includes(COMPUTER_ROOT)) return res.status(403).json({ error: 'FORBIDDEN_ROOT' }); }
    else if (r === HOME_ROOT) { /* 个人主目录：始终允许访问本人空间，无需额外校验 */ }
    else if (!Object.prototype.hasOwnProperty.call(ROOTS, r) || !allowed.includes(r)) return res.status(403).json({ error: 'FORBIDDEN_ROOT' });
  }
  // 权限位
  const perm = PERM_MAP[req.method + ' ' + req.path];
  if (perm && !auth.hasPerm(user, perm)) return res.status(403).json({ error: 'FORBIDDEN_PERM', perm });
  next();
});

const api = express.Router();

// ===== 登录防重放：一次性 nonce（server 签发、单次消费、短过期） =====
const loginNonces = new Map(); // nonce -> expiresAt(ms)
function purgeExpiredNonces() {
  const now = Date.now();
  for (const [k, v] of loginNonces) if (v <= now) loginNonces.delete(k);
}
setInterval(purgeExpiredNonces, 60 * 1000);

// 签发一次性登录 nonce（5 分钟有效）。前端登录时携带，server 消费后即作废，
// 使截获的登录请求无法被原样重放（配合 HSTS 强制 TLS，构成完整防重放）。
api.get('/login/challenge', (req, res) => {
  purgeExpiredNonces();
  const nonce = crypto.randomBytes(24).toString('hex');
  loginNonces.set(nonce, Date.now() + 5 * 60 * 1000);
  res.json({ nonce, ttl: 300 });
});

// ---- 登录：用户名 + (SHA-256(password) 或 password) + 可选 nonce，服务端 scrypt 校验 ----
api.post('/login', (req, res) => {
  const ip = loginClientIp(req);
  if (loginCheckBlock(ip)) {
    const retry = Math.max(0, Math.ceil((loginFails.get(ip).blockedUntil - Date.now()) / 1000));
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', retryAfter: retry });
  }
  const body = req.body || {};
  // 防重放：携带 nonce 时必须是未过期且未使用的一次性值（立即消费）；
  // 不携带 nonce 走旧兼容路径（旧前端/脚本仍可登录，但无重放保护）。
  const nonce = body.nonce;
  if (nonce) {
    const exp = loginNonces.get(nonce);
    if (!exp || exp < Date.now()) return res.status(401).json({ error: 'BAD_NONCE', message: '登录凭证已过期，请重试' });
    loginNonces.delete(nonce); // 立即作废，防止同一登录请求被重放
  }
  const u = auth.verifyLogin(body);
  if (!u) {
    loginRegisterFailure(ip);
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  loginRegisterSuccess(ip);
  const sid = auth.createSession(u.username);
  // 仅在真实 HTTPS（直连 TLS 或被反代且带 X-Forwarded-Proto:https）时加 Secure 标记
  const secure = (req.secure || (req.connection && req.connection.encrypted)) ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    'nm_session=' + sid + '; HttpOnly; SameSite=Strict' + secure +
    '; Path=/; Max-Age=' + Math.floor(auth.SESSION_TTL / 1000));
  res.json({ ok: true, username: u.username, role: u.role });
});

// ---- 登出：销毁会话并清除 Cookie ----
api.post('/logout', (req, res) => {
  auth.destroySession(parseCookies(req).nm_session);
  res.setHeader('Set-Cookie', 'nm_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---- 会话探测：前端据此决定显示登录页还是主界面 ----
api.get('/session', (req, res) => {
  const s = auth.getSession(parseCookies(req).nm_session);
  const u = s ? auth.getUser(s.username) : null;
  res.json({ authenticated: !!s, username: s ? s.username : null, role: u ? u.role : null, isAdmin: !!(u && u.role === 'admin') });
});

// ===== SSE：实时文件系统变更推送（前端据此自动刷新当前目录树） =====
const sseClients = new Set();
// SSE 实时刷新：仅监听“前端当前正在查看的目录”（非递归），该目录的直接子项变化才推送，
// 从而做到“外部改了文件即时看到”，又不会因全盘递归监听的噪音（Windows 后台写入）导致页面不停闪烁。
api.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 3000\n\n');
  const client = res;
  sseClients.add(client);
  let dirWatcher = null;
  const rootKey = req.query.root;
  const sub = (req.query.path || '').toString().replace(/\\/g, '/');
  let watchAbs = null;
  if (rootKey === HOME_ROOT) {
    const h = homePathFor(req.user); // 个人主目录：监听当前用户自己的空间
    if (h) watchAbs = h;
  } else if (rootKey && Object.prototype.hasOwnProperty.call(ROOTS, rootKey)) {
    const abs = path.join(ROOTS[rootKey], sub);
    // 防越界：解析后必须仍在根目录内
    if (abs === ROOTS[rootKey] || abs.startsWith(ROOTS[rootKey] + path.sep)) watchAbs = abs;
  }
  if (watchAbs) {
    try {
      dirWatcher = fs.watch(watchAbs, { recursive: false }, () => {
        broadcastFsChange(rootKey, sub);   // 仅该目录变化才推送（rel 即该目录本身）
        scheduleRootReindex(rootKey);       // 顺便后台增量重建搜索索引
      });
      dirWatcher.on('error', () => { /* 目录被删等，保持连接但不监听 */ });
    } catch (e) { /* 目录不存在等，保持连接 */ }
  }
  const ping = setInterval(() => { try { client.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(client);
    if (dirWatcher) { try { dirWatcher.close(); } catch (e) {} }
  });
});
function broadcastFsChange(rootKey, rel) {
  if (sseClients.size === 0) return;
  const data = JSON.stringify({ type: 'fschange', root: rootKey, path: rel, ts: Date.now() });
  for (const c of sseClients) { try { c.write('data: ' + data + '\n\n'); } catch (e) {} }
}

// ---- 全部磁盘枚举（含 U 盘 / 光驱 / 网络盘 / RAM 盘） ----
function tryStat(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }

// 磁盘列表持久化缓存：枚举磁盘要 spawn PowerShell（约 1.6s），成本较高。
// 把结果落盘，服务重启/被环境回收后立即可用，避免每次冷枚举造成“打开此电脑/WebDAV 根很慢”。
const DRIVE_CACHE = { ts: 0, data: null, ttl: 15000 };
const DRIVE_CACHE_FILE = path.join(DATA_DIR, '.drive_cache.json');
const DRIVE_CACHE_FILE_TTL = 60000; // 落盘缓存 60s 内复用（U 盘热插拔等罕见变更可接受）
function loadDriveCacheFile() {
  try {
    const j = JSON.parse(fs.readFileSync(DRIVE_CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.drives) && j.ts && (Date.now() - j.ts < DRIVE_CACHE_FILE_TTL)) return j.drives;
  } catch (e) {}
  return null;
}
function saveDriveCacheFile(drives) {
  try { fs.writeFileSync(DRIVE_CACHE_FILE, JSON.stringify({ ts: Date.now(), drives })); } catch (e) {}
}
function listDrives(force) {
  const now = Date.now();
  if (!force && DRIVE_CACHE.data && now - DRIVE_CACHE.ts < DRIVE_CACHE.ttl) return DRIVE_CACHE.data;
  // 内存无缓存时，先尝试落盘缓存（重启后秒级回暖），避免冷枚举
  if (!force && !DRIVE_CACHE.data) {
    const disk = loadDriveCacheFile();
    if (disk) { DRIVE_CACHE.data = disk; DRIVE_CACHE.ts = now; return disk; }
  }
  let drives = [];
  if (process.platform === 'win32') drives = enumDrivesWin();
  else drives.push({ key: '/', name: '/', type: 'local', ready: tryStat('/'), size: 0, free: 0 });
  DRIVE_CACHE.data = drives; DRIVE_CACHE.ts = now;
  saveDriveCacheFile(drives);
  return drives;
}

function enumDrivesWin() {
  let raw = null;
  // 优先 PowerShell（Win11 已移除 wmic 的稳妥方案）
  try {
    const ps = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress';
    raw = execSync('powershell -NoProfile -Command "' + ps + '"', { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }).toString('utf8');
  } catch (e) { raw = null; }
  // 回退 wmic（较旧系统）
  if (!raw) {
    try {
      raw = execSync('wmic logicaldisk get DeviceID,DriveType,VolumeName,Size,FreeSpace /format:csv', { windowsHide: true, maxBuffer: 16 * 1024 *1024, timeout: 15000 }).toString('latin1');
    } catch (e) { raw = null; }
  }
  const typeMap = { 2: 'removable', 3: 'local', 4: 'network', 5: 'cdrom', 6: 'ramdisk' };
  const map = {}; // id -> { type, name, size, free }
  if (raw) {
    const trimmed = (raw || '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // JSON（PowerShell）
      try {
        const parsed = JSON.parse(trimmed);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const d of arr) {
          const dt = Number(d.DriveType);
          if (dt === 0 || dt === 1) continue; // 未知 / 无根目录
          const id = String(d.DeviceID || '').replace(/:/g, '').toUpperCase();
          if (!id) continue;
          map[id] = { type: typeMap[dt] || 'unknown', name: d.VolumeName || '', size: Number(d.Size) || 0, free: Number(d.FreeSpace) || 0 };
        }
      } catch (e) {}
    } else {
      // CSV（wmic）：跳过表头与空行
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || /Node,?DeviceID/i.test(t)) continue;
        const cols = t.split(',');
        const id = String(cols[1] || '').replace(/:/g, '').toUpperCase();
        if (!id || !/^[A-Z]$/.test(id)) continue;
        const dt = Number(cols[2]);
        if (dt === 0 || dt === 1) continue;
        map[id] = { type: typeMap[dt] || 'unknown', name: (cols[3] || '').trim(), size: Number(cols[4]) || 0, free: Number(cols[5]) || 0 };
      }
    }
  }
  const drives = [];
  for (const id of Object.keys(map)) {
    const info = map[id];
    // 用 PowerShell 返回的 Size 判断就绪，避免对未就绪的光驱 / 网络盘执行会阻塞的 statSync
    const ready = (Number(info.size) > 0);
    const label = info.name ? (info.name + ' (' + id + ':)') : (id + ':');
    drives.push({ key: id, name: label, type: info.type, ready, size: info.size, free: info.free });
  }
  return drives;
}

// ---- 根目录列表（管理员首位为“此电脑”，可遍历全部硬盘 / U 盘 / 光驱） ----
api.get('/roots', (req, res) => {
  const user = req.user;
  const allowed = auth.userRoots(user);
  const roots = [];
  if (user && (user.role === 'admin' || allowed.includes(COMPUTER_ROOT))) roots.push({ key: COMPUTER_ROOT, path: COMPUTER_SENTINEL, systemDrive: false, label: '此电脑' });
  for (const [key, p] of Object.entries(ROOTS)) {
    if (key === COMPUTER_ROOT) continue;
    if (allowed.includes(key)) roots.push({ key, path: p, systemDrive: isSystemDrive(p) });
  }
  // 个人主目录：每个账号独立拥有的空间，始终展示。
  // 即便位于系统盘也标记为 systemDrive:false（已通过 needSystemConfirm 豁免二次确认 + 上传放行），
  // 避免“只有 C 盘”的机器把“自己的文件”误判为系统盘危险区。
  const home = homePathFor(user);
  if (home) roots.push({ key: HOME_ROOT, path: home, systemDrive: false, label: '我的空间 (' + (user ? user.username : '') + ')' });
  res.json({ roots, system: SYSTEM_DRIVES });
});

// ---- 全部磁盘列表 ----
api.get('/drives', (req, res) => { res.json({ drives: listDrives(req.query.force === '1') }); });

// ---- 列目录 ----
api.get('/list', (req, res) => {
  // “此电脑”顶级（无子路径）：返回全部磁盘而非列目录
  if (req.query.root === COMPUTER_ROOT && !(req.query.path || '')) {
    return res.json({ path: COMPUTER_SENTINEL, drives: listDrives(req.query.force === '1'), total: 0 });
  }
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM', path: abs });
  const baseRel = req.query.path || '';
  try {
    const showHidden = req.query.showHidden === '1';
    const hiddenMap = getHiddenMap(abs);
    let entries = fs.readdirSync(abs, { withFileTypes: true }).map(d => {
      const full = path.join(abs, d.name);
      let size = 0, mtime = '';
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
      const rel = baseRel ? baseRel + '/' + d.name : d.name;
      // 隐藏判定：① Windows 隐藏属性(H) ② Unix 约定以“.”开头的文件/文件夹 ③ .bak 备份 ④ Windows 系统受保护目录（以“$”开头，如 $Recycle.Bin、$WINDOWS.~BT）
      const name = d.name;
      const isDot = name.startsWith('.');
      const isBak = name.toLowerCase().endsWith('.bak');
      const isSystem = name.startsWith('$');
      const hidden = !!hiddenMap[name] || isDot || isBak || isSystem;
      return { name, isDir: d.isDirectory(), size, mtime, favorited: favorites.has(req.query.root, rel), hidden };
    }).filter(e => showHidden || !e.hidden);
    // 排序（服务端，保证分页跨页一致）；folder 始终在前
    const sortKey = req.query.sort || '';
    const sortDir = req.query.sortDir === '-1' ? -1 : 1;
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (!sortKey) return a.name.localeCompare(b.name);
      let va, vb;
      if (sortKey === 'name') { va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); return sortDir * va.localeCompare(vb); }
      if (sortKey === 'type') { va = a.ext || ''; vb = b.ext || ''; return sortDir * va.localeCompare(vb); }
      if (sortKey === 'size') { va = a.size || 0; vb = b.size || 0; return sortDir * (va - vb); }
      if (sortKey === 'mtime') { va = a.mtime || 0; vb = b.mtime || 0; return sortDir * (va - vb); }
      return 0;
    });
    // 分页（防止单目录文件过多一次性加载卡死）
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 200, 1), 1000);
    const total = entries.length;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const start = (page - 1) * pageSize;
    const pageEntries = entries.slice(start, start + pageSize);
    res.json({ path: abs, entries: pageEntries, total, page, pageSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 统计（递归大小 / 文件数 / 绝对路径），属性面板用 ----
api.get('/stat', (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  let size = 0, count = 0;
  (function walk(p) {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      let ents; try { ents = fs.readdirSync(p); } catch (e) { return; }
      for (const d of ents) walk(path.join(p, d));
    } else { size += st.size; count++; }
  })(abs);
  res.json({ absolute: abs, size, count });
});

// ---- 新建目录 ----
api.post('/mkdir', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  try { fs.mkdirSync(abs, { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 重命名 ----
api.post('/rename', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  const target = path.join(path.dirname(abs), safeName(req.body.newName));
  try { fs.renameSync(abs, target); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 移动（异步后台任务 + 进度） ----
api.post('/move', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  const dest = resolveWithin(req.body.destRoot, req.body.destPath);
  if (!abs || !dest) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req) || needSystemConfirm(dest, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  const target = path.join(dest, path.basename(abs));
  if (fs.existsSync(target)) return res.status(409).json({ error: 'EXISTS' });
  const job = jobs.createJob('move', path.basename(abs), { root: req.body.root, path: req.body.path, destRoot: req.body.destRoot, destPath: req.body.destPath }, { path: req.body.destPath || '', modifier: req.body.modifier || '' });
  jobs.moveAsync(abs, target, job.id);
  res.json({ ok: true, jobId: job.id });
});

// ---- 下载（文件直接下；文件夹 ?zip=1 打包为 zip 流式返回） ----
api.get('/download', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  if (fs.statSync(abs).isDirectory()) {
    if (req.query.zip !== '1') return res.status(400).json({ error: 'IS_DIR' });
    const tmp = path.join(DATA_DIR, 'tmp', Date.now() + '_' + path.basename(abs) + '.zip');
    try { await archive.zipFolder(abs, tmp); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.download(tmp, path.basename(abs) + '.zip', (err) => { try { fs.unlinkSync(tmp); } catch (_) {} });
  }
  // 单文件下载：支持 Range 断点续传
  streamFile(req, res, abs, mimeOf(abs), true);
});

// ---- 音频元数据：标签（标题/歌手/专辑）+ 内嵌歌词 + 封面 + 同目录 .lrc 歌词 / 封面图 ----
api.get('/audio-meta', (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'NOT_FOUND' });
  const meta = { ok: true, title: '', artist: '', album: '', lyrics: null, lyricsFrom: null, coverUrl: null, coverBase64: null };
  try {
    const size = fs.statSync(abs).size;
    const fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(Math.min(3 * 1024 * 1024, size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const clean = s => String(s || '').replace(/\0+/g, '').trim();
    const dec = (buf, enc) => { try { return clean(new TextDecoder(enc).decode(buf)); } catch (e) { return clean(buf.toString('latin1')); } };
    // ID3v2 文本帧解码（0=latin1 1=utf16+BOM 2=utf16be 3=utf8）
    // 实际国内 MP3 常在 enc=0 中直接写 UTF-8 或 GBK 字节，做启发式解码
    const decText = b => {
      if (!b.length) return '';
      const enc = b[0]; const body = b.slice(1);
      if (enc === 1) return dec(body, 'utf-16le');
      if (enc === 2) return dec(body, 'utf-16be');
      if (enc === 3) return dec(body, 'utf-8');
      if (enc === 0) {
        if (body.some(x => x > 0x7f)) {
          try { const s = new TextDecoder('utf-8', { fatal: true }).decode(body); if (/[^\x00-\x7f]/.test(s)) return clean(s); } catch (e) {}
          try { const g = new TextDecoder('gbk', { fatal: true }).decode(body); if (/[^\x00-\x7f]/.test(g)) return clean(g); } catch (e) {}
        }
        return dec(body, 'latin1');
      }
      return dec(body, 'latin1');
    };
    const termLen = (buf, start, wide) => { // 找 null 终止符
      if (wide) { for (let i = start; i + 1 < buf.length; i += 2) { if (buf[i] === 0 && buf[i + 1] === 0) return i + 2; } }
      else { for (let i = start; i < buf.length; i++) { if (buf[i] === 0) return i + 1; } }
      return buf.length;
    };
    if (head.length > 10 && head.slice(0, 3).toString('latin1') === 'ID3') {
      const ver = head[3];
      const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      let p = 10;
      const end = Math.min(10 + tagSize, head.length);
      while (p + 10 <= end) {
        const id = head.slice(p, p + 4).toString('latin1');
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const fsz = ver === 4
          ? ((head[p + 4] & 0x7f) << 21) | ((head[p + 5] & 0x7f) << 14) | ((head[p + 6] & 0x7f) << 7) | (head[p + 7] & 0x7f)
          : head.readUInt32BE(p + 4);
        if (fsz <= 0 || p + 10 + fsz > head.length) break;
        const body = head.slice(p + 10, p + 10 + fsz);
        if (id === 'TIT2') meta.title = decText(body);
        else if (id === 'TPE1') meta.artist = decText(body);
        else if (id === 'TALB') meta.album = decText(body);
        else if (id === 'USLT' && !meta.lyrics) {
          // enc(1) lang(3) 描述(null 终止,随 enc) 文本
          try {
            const enc = body[0]; const wide = enc === 1 || enc === 2;
            const dEnd = termLen(body, 4, wide);
            const textBuf = body.slice(dEnd);
            meta.lyrics = enc === 1 ? dec(textBuf, 'utf-16le') : enc === 2 ? dec(textBuf, 'utf-16be') : enc === 3 ? dec(textBuf, 'utf-8') : dec(textBuf, 'latin1');
            if (meta.lyrics) meta.lyricsFrom = 'embedded';
          } catch (e) {}
        } else if (id === 'APIC' && !meta.coverBase64) {
          try {
            const enc = body[0];
            const mimeEnd = termLen(body, 1, false);
            const mime = body.slice(1, mimeEnd - 1).toString('latin1') || 'image/jpeg';
            const picType = body[mimeEnd];
            const wide = enc === 1 || enc === 2;
            const dEnd = termLen(body, mimeEnd + 1, wide);
            const pic = body.slice(dEnd);
            if (pic.length > 10) meta.coverBase64 = 'data:' + mime + ';base64,' + pic.toString('base64');
          } catch (e) {}
        }
        p += 10 + fsz;
      }
    } else if (head.length > 8 && head.slice(0, 4).toString('latin1') === 'fLaC') {
      // FLAC 元数据块：type4=VORBIS_COMMENT type6=PICTURE
      let p = 4;
      while (p + 4 <= head.length) {
        const bh = head[p];
        const type = bh & 0x7f;
        const bsz = (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3];
        if (bsz <= 0 || p + 4 + bsz > head.length) break;
        const body = head.slice(p + 4, p + 4 + bsz);
        if (type === 4) {
          try {
            let q = 0;
            const vlen = body.readUInt32LE(q); q += 4 + vlen;
            const count = body.readUInt32LE(q); q += 4;
            for (let i = 0; i < count && q + 4 <= body.length; i++) {
              const cl = body.readUInt32LE(q); q += 4;
              const c = body.slice(q, q + cl).toString('utf8'); q += cl;
              const eq = c.indexOf('=');
              if (eq < 1) continue;
              const k = c.slice(0, eq).toUpperCase(), v = c.slice(eq + 1);
              if (k === 'TITLE' && !meta.title) meta.title = v;
              else if (k === 'ARTIST' && !meta.artist) meta.artist = v;
              else if (k === 'ALBUM' && !meta.album) meta.album = v;
              else if ((k === 'LYRICS' || k === 'SYNCEDLYRICS' || k === 'UNSYNCEDLYRICS') && !meta.lyrics) { meta.lyrics = v; meta.lyricsFrom = 'embedded'; }
            }
          } catch (e) {}
        } else if (type === 6 && !meta.coverBase64) {
          try {
            let q = 0;
            q += 4; // 图片类型
            const mlen = body.readUInt32BE(q); q += 4;
            const mime = body.slice(q, q + mlen).toString('latin1') || 'image/jpeg'; q += mlen;
            const dlen = body.readUInt32BE(q); q += 4 + dlen;
            q += 16; // w/h/depth/colors
            const plen = body.readUInt32BE(q); q += 4;
            const pic = body.slice(q, q + plen);
            if (pic.length > 10) meta.coverBase64 = 'data:' + mime + ';base64,' + pic.toString('base64');
          } catch (e) {}
        }
        if (bh & 0x80) break; // last block
        p += 4 + bsz;
      }
    }
    // 同目录 .lrc 歌词与封面图兜底
    try {
      const dir = path.dirname(abs);
      const base = path.basename(abs).replace(/\.[^.]+$/, '');
      const ents = fs.readdirSync(dir);
      if (!meta.lyrics) {
        const lrcName = ents.find(n => n.toLowerCase() === base.toLowerCase() + '.lrc');
        if (lrcName) { meta.lyrics = fs.readFileSync(path.join(dir, lrcName), 'utf8').replace(/^\uFEFF/, ''); meta.lyricsFrom = 'file'; }
      }
      if (!meta.coverUrl && !meta.coverBase64) {
        const coverName = ents.find(n => /^(cover|folder|front|album|thumb)\.(jpe?g|png|webp|bmp)$/i.test(n));
        if (coverName) {
          const rel = path.posix.join(path.posix.dirname((req.query.path || '').replace(/\\/g, '/')), coverName);
          meta.coverUrl = '/api/file?root=' + encodeURIComponent(req.query.root) + '&path=' + encodeURIComponent(rel === '.' ? coverName : rel) +
            (req.query.confirmSystemDrive ? '&confirmSystemDrive=1' : '');
        }
      }
    } catch (e) {}
    if (!meta.title) meta.title = path.basename(abs).replace(/\.[^.]+$/, '');
    res.json(meta);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 复制（文件或文件夹，递归；异步后台任务 + 进度） ----
api.post('/copy', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  const dest = resolveWithin(req.body.destRoot, req.body.destPath);
  if (!abs || !dest) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req) || needSystemConfirm(dest, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  const target = path.join(dest, path.basename(abs));
  if (fs.existsSync(target)) return res.status(409).json({ error: 'EXISTS' });
  try { fs.mkdirSync(dest, { recursive: true }); } catch (e) {}
  const job = jobs.createJob('copy', path.basename(abs), { root: req.body.root, path: req.body.path, destRoot: req.body.destRoot, destPath: req.body.destPath }, { path: req.body.destPath || '', modifier: req.body.modifier || '' });
  jobs.copyAsync(abs, target, job.id);
  res.json({ ok: true, jobId: job.id });
});

// ---- 新建文件（txt 空白；docx/xlsx 生成最小可用 Office 文档） ----
api.post('/create', async (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (fs.existsSync(abs)) return res.status(409).json({ error: 'EXISTS' });
  const kind = (req.body.kind || '').toLowerCase();
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (kind === 'txt') {
      fs.writeFileSync(abs, '');
    } else if (kind === 'docx') {
      await office.createWord(abs);
    } else if (kind === 'xlsx') {
      await office.createExcel(abs);
    } else {
      return res.status(400).json({ error: 'UNKNOWN_KIND' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 压缩（多文件/文件夹 → zip，可选级别 + 密码） ----
api.post('/compress', async (req, res) => {
  const { root, items, destRoot, destPath, name, level, password } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'NO_ITEMS' });
  const srcRoot = root || 'share';
  const absItems = items.map(p => resolveWithin(srcRoot, p)).filter(Boolean);
  if (absItems.some(a => needSystemConfirm(a, req))) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (absItems.some(a => !fs.existsSync(a))) return res.status(404).json({ error: 'NOT_FOUND' });
  const dr = destRoot || srcRoot;
  const parentAbs = path.dirname(absItems[0]);
  const destFolder = resolveWithin(dr, destPath || '') || parentAbs;
  if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory())
    return res.status(400).json({ error: 'BAD_DEST' });
  let zipName = (name && name.trim()) ? name.trim() : (path.basename(absItems[0]) + '.zip');
  if (!zipName.toLowerCase().endsWith('.zip')) zipName += '.zip';
  const outPath = path.join(destFolder, safeName(zipName));
  if (fs.existsSync(outPath)) return res.status(409).json({ error: 'EXISTS' });
  try {
    await archive.zipItems(absItems.map(a => ({ abs: a, entryName: path.basename(a) })), outPath,
      { password: password || null, store: level === 'store' });
    res.json({ ok: true, file: path.basename(outPath) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 解压缩（仅压缩包；提取到此处 / 提取到新文件夹 / 提取选中） ----
api.post('/extract', async (req, res) => {
  const { root, path: itemPath, destRoot, destPath, mode, password } = req.body || {};
  const abs = resolveWithin(root, itemPath);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(400).json({ error: 'NOT_AN_ARCHIVE' });
  const parentAbs = path.dirname(abs);
  let destFolder;
  if (mode === 'to') destFolder = path.join(parentAbs, path.basename(abs, path.extname(abs)));
  else destFolder = (destPath ? resolveWithin(destRoot || root, destPath) : parentAbs) || parentAbs;
  if (!destFolder || needSystemConfirm(destFolder, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  try {
    await archive.extractArchive(abs, destFolder, { password: password || null });
    res.json({ ok: true, folder: destFolder });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 压缩包内容列表（zip / tar.gz；7z/rar 返回 UNSUPPORTED_FORMAT） ----
api.get('/archive/list', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(400).json({ error: 'NOT_AN_ARCHIVE' });
  try {
    const r = await archive.listArchive(abs);
    res.json(r);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_FORMAT') return res.status(415).json({ error: 'UNSUPPORTED_FORMAT', hint: '当前仅支持 ZIP / TAR.GZ 预览；7z / RAR 请先用本地工具解压后上传' });
    res.status(500).json({ error: e.message });
  }
});

// ---- 解压压缩包中的单个文件到指定目录 ----
api.post('/archive/extract-one', async (req, res) => {
  const { root, path: itemPath, entry, destRoot, destPath, password } = req.body || {};
  const abs = resolveWithin(root, itemPath);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(400).json({ error: 'NOT_AN_ARCHIVE' });
  const dr = destRoot || root;
  const destFolder = resolveWithin(dr, destPath || '') || path.dirname(abs);
  if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory())
    return res.status(400).json({ error: 'BAD_DEST' });
  try {
    await archive.extractOne(abs, entry, destFolder, { password: password || null });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'UNSUPPORTED_FORMAT') return res.status(415).json({ error: 'UNSUPPORTED_FORMAT' });
    res.status(500).json({ error: e.message });
  }
});

// ---- 选中多项打包为 ZIP 流式下载（QNAP “Download as ZIP”） ----
api.post('/download-selected', async (req, res) => {
  const { root, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'NO_ITEMS' });
  const srcRoot = root || 'share';
  const absItems = items.map(p => resolveWithin(srcRoot, p)).filter(Boolean);
  if (absItems.some(a => needSystemConfirm(a, req))) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (absItems.some(a => !fs.existsSync(a))) return res.status(404).json({ error: 'NOT_FOUND' });
  const tmp = path.join(DATA_DIR, 'tmp', Date.now() + '_selected.zip');
  try {
    await archive.zipItems(absItems.map(a => ({ abs: a, entryName: path.basename(a) })), tmp, {});
    res.download(tmp, 'selected_' + Date.now() + '.zip', (err) => { try { fs.unlinkSync(tmp); } catch (_) {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 批量重命名（前缀 / 后缀 / 查找替换 / 序号） ----
api.post('/batch-rename', (req, res) => {
  const { root, items, mode, param } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'NO_ITEMS' });
  const absItems = items.map(p => resolveWithin(root, p)).filter(Boolean);
  if (absItems.some(a => needSystemConfirm(a, req))) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  const results = []; let n = 0;
  for (const a of absItems) {
    const base = path.basename(a);
    const dot = base.lastIndexOf('.');
    const nm = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let nn;
    if (mode === 'prefix') nn = (param || '') + base;
    else if (mode === 'suffix') nn = nm + (param || '') + ext;
    else if (mode === 'replace') { const i = (param || '||').indexOf('||'); const f = (param || '||').slice(0, i); const r = (param || '||').slice(i + 2); nn = f ? base.split(f).join(r) : base; }
    else if (mode === 'number') nn = (param || '') + (++n) + ext;
    else nn = base;
    const target = path.join(path.dirname(a), safeName(nn));
    if (target === a || fs.existsSync(target)) { results.push({ from: base, to: nn, status: 'skip' }); continue; }
    try { fs.renameSync(a, target); results.push({ from: base, to: nn, status: 'ok' }); }
    catch (e) { results.push({ from: base, to: nn, status: 'err', error: e.message }); }
  }
  res.json({ ok: true, results });
});

// ---- 共享链接（免登录临时访问，可设密码 + 有效期） ----
api.post('/share', (req, res) => {
  const { root, path: itemPath, expiresInHours, password } = req.body || {};
  const abs = resolveWithin(root, itemPath); // 创建时基于当前用户上下文解析（个人空间可正确解析到本人目录）
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  // 存绝对路径快照，公开访问（无会话）时直接基于绝对路径解析，避免个人空间因缺少用户上下文而 404
  const rec = share.addShare({ root, itemPath, absBase: abs, expiresInHours: expiresInHours ? Number(expiresInHours) : 0, password: password || null });
  res.json({ ok: true, token: rec.token, url: '/s/' + rec.token, hasPassword: !!rec.password, passwordText: rec.passwordText || null, expiresAt: rec.expiresAt });
});
api.get('/shares', (req, res) => res.json({ shares: share.listShares() }));
api.delete('/share', (req, res) => {
  const t = (req.body && req.body.token) || req.query.token;
  res.json({ ok: share.revoke(t) });
});
// 调整有效期：hours 为数字表示相对延长 N 小时；hours=0 设为永久有效
api.post('/share/extend', (req, res) => {
  const { token, hours } = req.body || {};
  if (!token) return res.status(400).json({ error: 'MISSING_TOKEN' });
  const ok = share.extend(token, hours === undefined ? null : Number(hours));
  if (!ok) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true, expiresAt: (share.getShare(token) || {}).expiresAt });
});

// ---- 账户：修改自己的密码（先校验旧密码） ----
api.post('/account/change-password', (req, res) => {
  const oldHash = req.body.oldHash, newHash = req.body.newHash;
  if (!oldHash || !newHash) return res.status(400).json({ error: 'MISSING' });
  const r = auth.setOwnPassword(req.user.username, oldHash, newHash);
  if (r.error) return res.status(r.error === 'OLD_WRONG' ? 401 : 400).json(r);
  res.json({ ok: true });
});

// ===== 用户管理（仅管理员；作用域中间件已拦截非管理员）=====
api.get('/users', (req, res) => {
  res.json({ users: auth.listUsers(), roots: Object.keys(ROOTS).concat([COMPUTER_ROOT, HOME_ROOT]) });
});
api.post('/users', (req, res) => {
  const b = req.body || {};
  const r = auth.createUser({ username: b.username, password: b.password, role: b.role, roots: b.roots, perms: b.perms, createdBy: req.user.username });
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, user: r.user });
});
api.put('/users/:username', (req, res) => {
  const b = req.body || {};
  const r = auth.updateUser(req.params.username, { roots: b.roots, perms: b.perms, disabled: b.disabled, password: b.password }, req.user.username);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, user: r.user });
});
api.delete('/users/:username', (req, res) => {
  const r = auth.deleteUser(req.params.username, req.user.username);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});

// ---- 服务器信息（设置面板用） ----
api.get('/info', (req, res) => {
  const user = req.user || {};
  res.json({
    username: user.username || null, role: user.role || null, isAdmin: user.role === 'admin',
    dataDir: DATA_DIR, roots: auth.userRoots(user), system: SYSTEM_DRIVES, time: Date.now(),
    hideWindowsHidden: HIDE_WINDOWS_HIDDEN, webdavEnabled: WEBDAV_ENABLED,
    versionsMaxAgeDays: VERSIONS_MAX_AGE_DAYS, recycleAutopurgeDays: RECYCLE_AUTOPURGE_DAYS,
    letsencryptEnabled: LETSENCRYPT_ENABLED, letsencryptDomains: LETSENCRYPT_DOMAINS,
    letsencryptEmail: LETSENCRYPT_EMAIL, letsencryptStaging: LETSENCRYPT_STAGING,
    httpsPort: HTTPS_PORT, acmeHttpPort: ACME_HTTP_PORT, retentionLastRun
  });
});

// ---- 运行时设置：是否扫描 Windows 隐藏属性（默认关闭以提速；开启后隐藏 pagefile.sys 等纯 H 文件） ----
api.get('/settings', (req, res) => res.json({
  hideWindowsHidden: HIDE_WINDOWS_HIDDEN, webdavEnabled: WEBDAV_ENABLED,
  versionsMaxAgeDays: VERSIONS_MAX_AGE_DAYS, recycleAutopurgeDays: RECYCLE_AUTOPURGE_DAYS,
  letsencryptEnabled: LETSENCRYPT_ENABLED, letsencryptDomains: LETSENCRYPT_DOMAINS,
  letsencryptEmail: LETSENCRYPT_EMAIL, letsencryptStaging: LETSENCRYPT_STAGING,
  retentionLastRun
}));
api.post('/settings/hide-windows-hidden', (req, res) => {
  applySettings({ hideWindowsHidden: !!(req.body && req.body.enabled) });
  res.json({ ok: true, hideWindowsHidden: HIDE_WINDOWS_HIDDEN });
});
// ---- 运行时设置：WebDAV 网络磁盘开关（持久化；关闭后 /dav 停止响应） ----
api.post('/settings/webdav', (req, res) => {
  applySettings({ webdavEnabled: !!(req.body && req.body.enabled) });
  res.json({ ok: true, webdavEnabled: WEBDAV_ENABLED });
});
// ---- 统一设置写入：一次性设置全部可视化设置项（持久化） ----
api.post('/settings', (req, res) => {
  applySettings(req.body || {});
  // 立即应用一次留存策略（例如刚把回收站自动清理从 0 改成 >0）
  try { runRetention(); } catch (e) {}
  // 若启用了 Let's Encrypt，立即拉起挑战服务器与（已有证书时）HTTPS 服务
  try { applyLetsEncrypt(); } catch (e) {}
  res.json({
    ok: true, hideWindowsHidden: HIDE_WINDOWS_HIDDEN, webdavEnabled: WEBDAV_ENABLED,
    versionsMaxAgeDays: VERSIONS_MAX_AGE_DAYS, recycleAutopurgeDays: RECYCLE_AUTOPURGE_DAYS,
    letsencryptEnabled: LETSENCRYPT_ENABLED, letsencryptDomains: LETSENCRYPT_DOMAINS,
    letsencryptEmail: LETSENCRYPT_EMAIL, letsencryptStaging: LETSENCRYPT_STAGING,
    retentionLastRun
  });
});
// ---- WebDAV 真实运行状态（后端权威：enabled=开关，serving=当前是否真的在响应 /dav） ----
api.get('/webdav/status', (req, res) => res.json({ enabled: WEBDAV_ENABLED, serving: WEBDAV_ENABLED, mountPath: '/dav' }));
// ---- 用户显示偏好：前端只读取/设置，后端持久化为唯一来源 ----
api.get('/prefs', (req, res) => res.json(Object.assign({}, PREFS)));
api.post('/prefs', (req, res) => {
  const b = req.body || {};
  if (typeof b.layout === 'string') PREFS.layout = b.layout;
  if (typeof b.showHidden === 'boolean') PREFS.showHidden = b.showHidden;
  if (typeof b.autoFolderSize === 'boolean') PREFS.autoFolderSize = b.autoFolderSize;
  if (typeof b.sidebarW === 'number' && b.sidebarW >= 180 && b.sidebarW <= 600) PREFS.sidebarW = b.sidebarW;
  savePrefs();
  res.json({ ok: true, prefs: Object.assign({}, PREFS) });
});

// ---- Let's Encrypt：查询证书状态（含申请进度 / 有效期 / 剩余天数） ----
api.get('/letsencrypt/status', (req, res) => res.json(acmeMgr.getStatus()));

// ---- Let's Encrypt：触发申请 / 续期（异步执行，先返回已接受，前端轮询 status） ----
api.post('/letsencrypt/request', (req, res) => {
  const domains = (req.body && req.body.domains ? req.body.domains : LETSENCRYPT_DOMAINS);
  const email = (req.body && req.body.email ? req.body.email : LETSENCRYPT_EMAIL);
  const staging = (req.body && typeof req.body.staging === 'boolean') ? req.body.staging : LETSENCRYPT_STAGING;
  const dl = String(domains).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!dl.length) return res.status(400).json({ error: 'NO_DOMAINS' });
  if (!email) return res.status(400).json({ error: 'NO_EMAIL' });
  // 持久化本次使用的域名/邮箱/staging，便于后续自动续期
  LETSENCRYPT_DOMAINS = dl.join(',');
  LETSENCRYPT_EMAIL = email;
  LETSENCRYPT_STAGING = staging;
  savePersistedSettings();
  res.json({ ok: true, started: true, domains: dl, staging });
  // 后台异步申请，不阻塞响应
  acmeMgr.requestCertificate({ domains: dl, email, staging })
    .then(() => { console.log('[ACME] 证书申请/续期完成: ' + dl.join(', ')); tryStartHttps(); })
    .catch((e) => { console.error('[ACME] 证书申请失败: ' + (e && e.message)); acmeMgr.setRuntime('error', e && e.message ? e.message : String(e)); });
});

// ---- 管理：清空缩略图缓存 ----
api.post('/admin/clear-thumbnails', (req, res) => {
  const dir = path.join(DATA_DIR, 'thumbnails');
  try {
    let n = 0;
    for (const f of fs.readdirSync(dir)) { fs.unlinkSync(path.join(dir, f)); n++; }
    res.json({ ok: true, cleared: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 管理：立即执行一次存储清理（版本快照 + 回收站），由后端操作并回报结果 ----
api.post('/admin/retention-run', async (req, res) => {
  try {
    const r = await runRetention();
    res.json({ ok: true, runAt: r.runAt, versionsPruned: r.versionsPruned, recyclePurged: r.recyclePurged });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 文件预览（图片/视频/音频/PDF/文本 等；支持 Range 以便视频拖动进度） ----
api.get('/file', (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).end();
  streamFile(req, res, abs, mimeOf(abs));
});

// ---- 文本文件保存（编辑后写回，自动备份 .bak 防丢） ----
api.put('/file', express.text({ type: () => true, limit: '50mb' }), (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'not a file' });
  // 保存前生成版本快照（可恢复，存放于 DATA_DIR，不污染共享目录）
  for (const [k, r] of Object.entries(ROOTS)) {
    const rel = path.relative(r, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) { try { if (isDocExt(abs)) versions.snapshot(k, rel, fs.readFileSync(abs)); } catch (e) {} break; }
  }
  // 生成隐藏的 .bak 备份（与源文件同目录，设为系统隐藏属性，默认不在列表中显示）
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
    try { fs.copyFileSync(abs, abs + '.bak'); setHiddenAttr(abs + '.bak', true); } catch (e) {}
  }
  try {
    fs.writeFileSync(abs, req.body == null ? '' : req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 删除（进回收站，记录到后台任务） ----
api.post('/delete', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  // 禁止删除根目录本身（防整盘误删）
  if (abs === ROOTS[req.body.root]) return res.status(400).json({ error: 'CANNOT_DELETE_ROOT' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  // 先建任务，再异步送回收站，前端可在「后台任务」查看进度与结果
  const job = jobs.createJob('delete', path.basename(abs), { root: req.body.root, path: req.body.path }, { path: req.body.path || '', modifier: req.body.modifier || '' });
  (async () => {
    try {
      const r = await recycle.doDelete(abs);
      if (!r.ok) jobs.finishJob(job.id, new Error(r.error || '删除失败'));
      else jobs.finishJob(job.id);
    } catch (e) { jobs.finishJob(job.id, e); }
  })();
  res.json({ ok: true, jobId: job.id });
});

// ---- 回收站（按当前用户可访问根做作用域隔离） ----
api.get('/recycle/list', (req, res) => {
  const allowed = auth.userRoots(req.user);
  recycle.run('list', null, (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    let items = Array.isArray(data) ? data : [];
    if (req.user.role !== 'admin') items = items.filter(it => it.root && allowed.includes(it.root));
    res.json(items);
  });
});
api.post('/recycle/restore', (req, res) => {
  const allowed = auth.userRoots(req.user);
  recycle.run('list', null, (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    const items = Array.isArray(data) ? data : [];
    const it = items.find(x => x.id === (req.body && req.body.id));
    if (!it) return res.status(404).json({ error: 'NOT_FOUND' });
    if (req.user.role !== 'admin' && !(it.root && allowed.includes(it.root))) return res.status(403).json({ error: 'FORBIDDEN_ROOT' });
    recycle.run('restore', { id: it.id, originalPath: it.originalPath, name: it.name }, (e2, d2) => {
      if (e2) return res.status(500).json({ error: e2.message });
      res.json(d2);
    });
  });
});
api.post('/recycle/purge', (req, res) => {
  const id = req.body && req.body.id;
  const allowed = auth.userRoots(req.user);
  if (!id) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN_ADMIN' });
    recycle.run('purge', null, (e2, d2) => { if (e2) return res.status(500).json({ error: e2.message }); res.json(d2); });
    return;
  }
  recycle.run('list', null, (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    const items = Array.isArray(data) ? data : [];
    const it = items.find(x => x.id === id);
    if (!it) return res.status(404).json({ error: 'NOT_FOUND' });
    if (req.user.role !== 'admin' && !(it.root && allowed.includes(it.root))) return res.status(403).json({ error: 'FORBIDDEN_ROOT' });
    recycle.run('purge', id, (e2, d2) => { if (e2) return res.status(500).json({ error: e2.message }); res.json(d2); });
  });
});

// ---- 校验和（MD5 / SHA1 / SHA256） ----
api.post('/checksum', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(400).json({ error: 'NOT_A_FILE' });
  try {
    const buf = fs.readFileSync(abs);
    res.json({
      ok: true,
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      sha1: crypto.createHash('sha1').update(buf).digest('hex'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 收藏夹 ----
api.get('/favorites', (req, res) => {
  // 返回收藏项并附带文件元数据（名称/类型/大小/修改时间），前端可像文件管理器一样展示
  const out = favorites.all().map(f => {
    const abs = resolveWithin(f.root, f.relPath);
    let meta = { name: f.relPath ? f.relPath.split('/').pop() : '(根)', isDir: false, size: 0, mtime: f.addedAt, missing: true };
    try {
      if (abs && fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        meta = { name: path.basename(abs), isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, missing: false };
      }
    } catch (e) {}
    return Object.assign({}, f, meta);
  });
  res.json({ favorites: out });
});
api.post('/favorite', (req, res) => {
  const r = favorites.add(req.body.root, req.body.path || '');
  res.json(r);
});
api.delete('/favorite', (req, res) => {
  // DELETE 请求体在 Node/部分代理下不可靠，优先从 query 取，body 兜底
  const root = (req.query && req.query.root) || (req.body && req.body.root) || '';
  const relPath = (req.query && req.query.path) || (req.body && req.body.path) || '';
  const r = favorites.remove(root, relPath);
  res.json(r);
});

// ---- 文件版本历史 ----
api.get('/versions', (req, res) => {
  res.json({ versions: versions.list(req.query.root, req.query.path || '') });
});
api.post('/version/restore', (req, res) => {
  const r = versions.restore(req.body.root, req.body.path, req.body.name);
  res.json(r);
});
// 读取单版本内容（用于预览）；ext 用于决定 Content-Type，无扩展名时按二进制处理
api.get('/version/content', (req, res) => {
  const fp = versions.read(req.query.root, req.query.path || '', req.query.name || '');
  if (!fp) return res.status(404).json({ error: 'NOT_FOUND' });
  let buf;
  try { buf = fs.readFileSync(fp); } catch (e) { return res.status(500).json({ error: e.message }); }
  const ext = String(req.query.ext || '').toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Length', buf.length);
  if (!/^(image|video|audio)/.test(ct)) {
    const base = (req.query.path || '').split('/').pop() || 'file';
    res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(base + (ext ? '.' + ext : '')) + '"');
  }
  res.send(buf);
});
// 删除单版本
api.post('/version/delete', (req, res) => {
  const { root, path, name } = req.body || {};
  res.json(versions.remove(root, path || '', name));
});

// ---- 文件去重（按大小 + SHA256 分组） ----
api.get('/dedup', (req, res) => {
  try { res.json(dedup.findDuplicates(req.query.root || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 全文内容搜索 ----
api.post('/search/content', async (req, res) => {
  try { res.json(await search.searchContent(req.body.q || '', { root: req.body.root }, req.user)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 属性：只读 + 隐藏（Windows 通过文件属性实现；ACL/所有者暂不支持） ----
api.post('/chmod', (req, res) => {
  const abs = resolveWithin(req.body.root, req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    if (typeof req.body.readonly === 'boolean') fs.chmodSync(abs, req.body.readonly ? 0o444 : 0o644);
    if (typeof req.body.hidden === 'boolean') setHiddenAttr(abs, req.body.hidden);
    const readonly = (fs.statSync(abs).mode & 0o200) === 0;
    res.json({ ok: true, readonly, hidden: getHiddenAttr(abs) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 读取当前只读 / 隐藏属性（属性面板用） ----
api.get('/attr', (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const readonly = (fs.statSync(abs).mode & 0o200) === 0;
    res.json({ readonly, hidden: getHiddenAttr(abs) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 后台任务查询 ----
api.get('/jobs', (req, res) => res.json({ jobs: jobs.listJobs() }));
api.get('/job/:id', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'NO_JOB' });
  res.json(j);
});
// 通用任务创建（前端上传等场景使用），返回 jobId
api.post('/jobs', (req, res) => {
  const { type, name, meta } = req.body || {};
  if (!type || !name) return res.status(400).json({ error: 'MISSING_FIELDS' });
  const job = jobs.createJob(String(type), String(name), meta || {}, {
    path: (meta && (meta.path || meta.destPath)) || '', modifier: (req.body && req.body.modifier) || ''
  });
  res.json({ ok: true, jobId: job.id });
});
// 更新任务进度（上传场景）
api.post('/job/:id/progress', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'NO_JOB' });
  if (typeof req.body.percent === 'number') jobs.setProgress(req.params.id, req.body.percent);
  else if (typeof req.body.done === 'number' && typeof req.body.total === 'number') jobs.updateProgress(req.params.id, req.body.done, req.body.total);
  res.json({ ok: true });
});
// 结束任务（上传完成 / 失败）
api.post('/job/:id/finish', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'NO_JOB' });
  const status = (req.body && req.body.status) || 'done';
  if (status === 'failed') jobs.finishJob(req.params.id, new Error((req.body && req.body.error) || '失败'));
  else jobs.finishJob(req.params.id);
  res.json({ ok: true });
});
// 手动删除某条任务记录
api.delete('/jobs/:id', (req, res) => {
  const had = jobs.removeJob(req.params.id);
  res.json({ ok: true, removed: had });
});

// ---- 离线 Office 预览（docx / xlsx，免 CDN） ----
api.get('/office/preview', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'NOT_FOUND' });
  const ext = extOf(abs);
  const kind = ['docx', 'docm', 'dotx', 'dotm'].includes(ext) ? 'docx' : (['xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb'].includes(ext) ? 'xlsx' : null);
  if (!kind) return res.status(415).json({ error: 'UNSUPPORTED' });
  try { res.json(await office.preview(abs, kind)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Office 编辑：Excel 读取（多表 → 2D 网格，公式以 = 开头） ----
api.get('/office/excel', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!['xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb'].includes(extOf(abs))) return res.status(415).json({ error: 'UNSUPPORTED' });
  try { res.json(await office.excelRead(abs, { preview: req.query.preview === '1' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Office 编辑：Excel 保存（原地改写，保留样式/公式） ----
api.post('/office/excel/save', async (req, res) => {
  const { root, path: rel, sheets, bookType } = req.body || {};
  const abs = resolveWithin(root, rel || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'NOT_FOUND' });
  const ext = extOf(abs);
  if (!['xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb'].includes(ext)) return res.status(415).json({ error: 'UNSUPPORTED' });
  if (ext === 'xlsb') return res.status(415).json({ error: 'XLSB_SAVE_UNSUPPORTED' }); // xlsb 仅支持预览，编辑保存暂不支持
  try {
    // 文档类文件保存前生成版本快照（可恢复，存放于 DATA_DIR，不污染共享目录）
    for (const [k, r] of Object.entries(ROOTS)) {
      const rel = path.relative(r, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) { try { if (isDocExt(abs)) versions.snapshot(k, rel, fs.readFileSync(abs)); } catch (e) {} break; }
    }
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      try { fs.copyFileSync(abs, abs + '.bak'); setHiddenAttr(abs + '.bak', true); } catch (e) {}
    }
    res.json(await office.excelWrite(abs, sheets, bookType));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Office 编辑：Word 读取（docx → HTML，图片内联 base64） ----
api.get('/office/word', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'NOT_FOUND' });
  if (extOf(abs) !== 'docx') return res.status(415).json({ error: 'UNSUPPORTED' });
  try { res.json(await office.wordRead(abs)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Office 编辑：Word 保存（HTML → docx） ----
api.post('/office/word/save', async (req, res) => {
  const { root, path: rel, html } = req.body || {};
  const abs = resolveWithin(root, rel || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    // 文档类文件保存前生成版本快照
    for (const [k, r] of Object.entries(ROOTS)) {
      const rel = path.relative(r, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) { try { if (isDocExt(abs)) versions.snapshot(k, rel, fs.readFileSync(abs)); } catch (e) {} break; }
    }
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      try { fs.copyFileSync(abs, abs + '.bak'); setHiddenAttr(abs + '.bak', true); } catch (e) {}
    }
    res.json(await office.wordWrite(abs, html));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 压缩包内单个文件“直接预览”（解压到临时区后内联返回，不落用户目录） ----
api.get('/archive/preview-one', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(400).json({ error: 'NOT_AN_ARCHIVE' });
  const entry = req.query.entry;
  if (!entry) return res.status(400).json({ error: 'NO_ENTRY' });
  const tmpDir = path.join(DATA_DIR, 'tmp', 'ap_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    await archive.extractOne(abs, entry, tmpDir, { password: req.query.password || null });
    // 在临时目录中按文件名定位（兼容条目含子目录）
    const base = path.basename(entry);
    let found = null;
    (function walk(d) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const f of ents) {
        const fp = path.join(d, f.name);
        if (f.isDirectory()) walk(fp);
        else if (f.name === base && !found) found = fp;
      }
    })(tmpDir);
    if (!found) { fs.rmSync(tmpDir, { recursive: true, force: true }); return res.status(404).json({ error: 'ENTRY_NOT_FOUND' }); }
    const mime = mimeOf(found);
    streamFile(req, res, found, mime, false);
    res.on('finish', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} });
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    if (e.code === 'UNSUPPORTED_FORMAT') return res.status(415).json({ error: 'UNSUPPORTED_FORMAT' });
    res.status(500).json({ error: e.message });
  }
});

// ---- 缩略图（图片 sharp / 视频 ffmpeg 抽帧，缓存进 DATA_DIR/thumbnails） ----
api.get('/thumbnail', async (req, res) => {
  const abs = resolveWithin(req.query.root, req.query.path || '');
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (needSystemConfirm(abs, req)) return res.status(423).json({ error: 'SYSTEM_DRIVE_CONFIRM' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).end();
  try {
    const r = await thumbnails.getThumbnail(req.query.root, req.query.path || '', abs);
    if (r.status === 'ok') {
      res.set('Content-Type', r.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(r.buffer);
    }
  } catch (e) { /* fallthrough 404 */ }
  res.status(404).end(); // 前端按 404 视为“无缩略图”
});

// ---- 搜索（索引存 DATA_DIR/index，文件名/类型/大小/日期过滤） ----
api.post('/search/reindex', (req, res) => {
  const started = search.buildIndexAsync();
  res.json({ started, status: search.getStatus() });
});
api.get('/search/status', (req, res) => res.json(search.getStatus()));
api.get('/search', async (req, res) => {
  try {
    const results = await search.query({
      q: req.query.q, ext: req.query.ext, root: req.query.root,
      minSize: req.query.minSize, maxSize: req.query.maxSize,
      after: req.query.after ? Date.parse(req.query.after) : null,
      before: req.query.before ? Date.parse(req.query.before) : null,
      limit: req.query.limit
    }, req.user);
    res.json({ count: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', api);

// ===== WebDAV（HTTP Basic 认证；暴露“此电脑”全部磁盘，可直接挂载为网络驱动器） =====
// 可在“设置”里开关：关闭后 /dav 停止响应，无法挂载为网络磁盘（无需重启服务，即时生效）。
const webdav = require('./src/webdav')({ resolveWithin, COMPUTER_ROOT, COMPUTER_SENTINEL, listDrives, auth, mimeOf });
function handleDav(req, res) {
  if (!WEBDAV_ENABLED) { res.status(404).send('WebDAV 已禁用'); return; }
  webdav(req, res);
}
app.all('/dav', handleDav);
app.all('/dav/*', handleDav);

// ===== 共享链接访问（免主登录；可设密码 + 有效期；网盘式页面） =====
function sharePwForm(token) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>共享链接 · 需要密码</title>' +
    '<style>body{font-family:sans-serif;background:#eef2f7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    '.c{background:#fff;padding:30px 36px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.12);text-align:center;width:320px}' +
    'h3{margin:0 0 6px}.sub{color:#888;font-size:13px;margin-bottom:18px}' +
    'input{padding:10px 12px;border:1px solid #c9d2dc;border-radius:8px;font-size:14px;width:100%;box-sizing:border-box;margin-bottom:14px}' +
    'button{background:#2b6cb0;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;width:100%;cursor:pointer}</style></head>' +
    '<body><div class="c"><h3>🔒 需要密码访问</h3><div class="sub">该共享链接受密码保护</div>' +
    '<form method="get"><input type="hidden" name="t" value="' + token + '"/><input type="password" name="pw" placeholder="请输入访问密码" autofocus/>' +
    '<button type="submit">访问</button></form></div></body></html>';
}
function netdiskHead(title) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' +
    '*{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#eef2f7;margin:0;color:#222}' +
    '.topbar{background:#1f2a44;color:#fff;padding:12px 20px;font-size:15px;display:flex;align-items:center;gap:10px}' +
    '.wrap{max-width:880px;margin:24px auto;padding:0 16px}' +
    '.card{background:#fff;border-radius:12px;padding:22px;box-shadow:0 4px 18px rgba(0,0,0,.08)}' +
    '.fileinfo{display:flex;gap:16px;align-items:center}' +
    '.ficon{font-size:54px;line-height:1}' +
    '.fname{font-size:18px;font-weight:600;word-break:break-all}' +
    '.meta{color:#888;font-size:13px;margin-top:4px}' +
    '.btns{margin:18px 0;display:flex;gap:12px;flex-wrap:wrap}' +
    '.btn{background:#2b6cb0;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}' +
    '.btn.ghost{background:#fff;color:#2b6cb0;border:1px solid #cfe0f3}' +
    '.preview{margin-top:8px;border:1px solid #eef1f4;border-radius:10px;background:#fafbfc;padding:14px;overflow:auto;max-height:60vh}' +
    '.preview img{max-width:100%}.preview iframe{width:100%;height:60vh;border:0}' +
    '.preview pre{white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.6;margin:0}' +
    'a{color:#2b6cb0;text-decoration:none}</style></head><body>';
}
function iconForExt(name) {
  const e = extOf(name);
  const map = { jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼', bmp:'🖼', svg:'🖼', mp4:'🎬', webm:'🎬', mov:'🎬', avi:'🎬', wmv:'🎬', mkv:'🎬', flv:'🎬', mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵', m4a:'🎵', aac:'🎵', pdf:'📕', txt:'📄', md:'📝', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙', zip:'🗜', 'tar.gz':'🗜', tgz:'🗜', rar:'🗜', '7z':'🗜', json:'⚙', xml:'⚙', html:'🌐', htm:'🌐', css:'🎨', js:'📜', ts:'📜', py:'🐍', java:'☕', c:'📜', cpp:'📜', go:'🐹', rs:'🦀', php:'🐘', rb:'💎', sql:'🗄', csv:'📊', log:'📜' };
  return map[e] || '📄';
}
function netdiskFilePage(rec, abs) {
  const name = path.basename(abs);
  const size = fs.statSync(abs).size;
  const mtime = new Date(fs.statSync(abs).mtimeMs).toLocaleString('zh-CN');
  const e = extOf(name);
  const raw = '/s/' + rec.token + '/raw';
  const inlineTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'pdf', 'txt', 'md', 'json', 'xml', 'css', 'js', 'csv', 'log', 'html', 'htm'];
  let preview = '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(e))
    preview = '<div class="preview"><img src="' + raw + '" alt="预览"/></div>';
  else if (['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e))
    preview = '<div class="preview"><' + (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e) ? 'audio' : 'video') + ' controls style="width:100%" src="' + raw + '"></' + (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e) ? 'audio' : 'video') + '></div>';
  else if (e === 'pdf')
    preview = '<div class="preview"><iframe src="' + raw + '"></iframe></div>';
  else if (inlineTypes.includes(e))
    preview = '<div class="preview"><pre id="txt">加载中…</pre><script>fetch("' + raw + '").then(r=>r.text()).then(t=>{document.getElementById("txt").textContent=t;}).catch(()=>{document.getElementById("txt").textContent="（文本预览失败）";});</script></div>';
  return netdiskHead('共享文件 · ' + name) +
    '<div class="topbar">📦 NasManager 共享文件</div>' +
    '<div class="wrap"><div class="card">' +
    '<div class="fileinfo"><div class="ficon">' + iconForExt(name) + '</div>' +
    '<div><div class="fname">' + name + '</div>' +
    '<div class="meta">大小 ' + (size / 1024).toFixed(1) + ' KB · 修改于 ' + mtime + '</div></div></div>' +
    '<div class="btns"><a class="btn" href="' + raw + '?dl=1">⬇ 下载文件</a>' +
    '<a class="btn ghost" href="' + raw + '">🔍 在线预览</a></div>' +
    preview +
    '</div></div></body></html>';
}
function shareFolderHtml(rec, target, sub) {
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory() })); } catch (e) {}
  entries.sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
  const base = '/s/' + rec.token;
  const rows = entries.map(e => {
    const link = base + '?f=' + encodeURIComponent((sub ? sub + '/' : '') + e.name);
    return '<li>' + (e.isDir ? '📁 ' : '📄 ') + '<a href="' + link + '">' + e.name + (e.isDir ? '/' : '') + '</a></li>';
  }).join('');
  const up = sub ? '<p><a href="' + base + '?f=' + encodeURIComponent(sub.split('/').slice(0, -1).join('/')) + '">⬆ 上级目录</a></p>' : '';
  return netdiskHead('共享文件夹') +
    '<div class="topbar">📂 NasManager 共享文件夹</div>' +
    '<div class="wrap"><div class="card"><h2 style="margin:0 0 12px">📂 ' + path.basename(target) + '</h2>' +
    up + '<ul style="list-style:none;padding:0;margin:0">' + (rows || '<li style="color:#999">空文件夹</li>') + '</ul></div></div></body></html>';
}

// 解析共享目标并校验密码；成功返回 {rec, abs, sub}
function resolveShare(req, res) {
  const rec = share.getShare(req.params.token);
  if (!rec) { res.status(404).send('<h2 style="font-family:sans-serif;padding:40px">链接无效或已被撤销</h2>'); return null; }
  if (rec.expiresAt && rec.expiresAt < Date.now()) { res.status(410).send('<h2 style="font-family:sans-serif;padding:40px">链接已过期</h2>'); return null; }
  // 基于创建时保存的绝对路径快照解析（无需用户上下文，个人空间分享也能正常访问）
  const abs = rec.absBase || resolveWithin(rec.root, rec.itemPath);
  if (!abs || !fs.existsSync(abs)) { res.status(404).send('<h2 style="font-family:sans-serif;padding:40px">文件不存在</h2>'); return null; }
  const pw = req.query.pw || req.query.t && req.query.pw;
  if (rec.password && !share.verifyPw(pw || '', rec.password)) { res.status(403).send(sharePwForm(rec.token)); return null; }
  const sub = req.query.f || '';
  return { rec, abs, sub };
}

app.get('/s/:token', (req, res) => {
  const r = resolveShare(req, res); if (!r) return;
  const { rec, abs, sub } = r;
  share.bump(rec.token, 'views');
  if (fs.statSync(abs).isDirectory()) {
    const target = sub ? path.resolve(abs, sub.replace(/^\//, '')) : abs;
    if (!target || !target.startsWith(abs) || !fs.existsSync(target)) return res.status(404).send('<h2 style="font-family:sans-serif;padding:40px">不存在</h2>');
    if (fs.statSync(target).isDirectory()) return res.send(shareFolderHtml(rec, target, sub));
    return res.send(netdiskFilePage(rec, target));
  }
  res.send(netdiskFilePage(rec, abs));
});

// 共享文件原始流（内联预览 / 下载），支持密码与 Range 续传
app.get('/s/:token/raw', (req, res) => {
  const r = resolveShare(req, res); if (!r) return;
  const { rec, abs, sub } = r;
  const target = sub ? path.resolve(abs, sub.replace(/^\//, '')) : abs;
  if (!target || !target.startsWith(abs) || !fs.existsSync(target) || fs.statSync(target).isDirectory())
    return res.status(404).send('不存在');
  if (req.query.dl === '1') share.bump(rec.token, 'downloads');
  streamFile(req, res, target, mimeOf(target), req.query.dl === '1');
});

// 跨磁盘安全移动：rename 失败（如目标在另一块物理磁盘，EXDEV）时回退为“复制 + 删除原文件”。
// 用于把上传临时文件从 DATA_DIR/uploads 移动到目标根（目标根可能与 DATA_DIR 不在同一块盘）。
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      try {
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
        return true;
      } catch (e2) {
        console.error('[moveFile] 跨磁盘回退失败:', e2.message);
        return false;
      }
    }
    throw e;
  }
}

// ---- TUS 续传上传 ----
// 先落到 DATA_DIR/uploads 临时，完成后移动到目标 root（仅“系统盘根目录本身”被兜底拒绝，其子目录允许）
const tusStore = new FileStore({ directory: path.join(DATA_DIR, 'uploads') });
const tusServer = new TusServer({
  path: '/api/upload',
  datastore: tusStore,
  async onUploadFinish(req, res, upload) {
    const user = req.user;
    const meta = upload.metadata || {};
    const rootKey = meta.root || HOME_ROOT;
    const destSub = meta.path || '';
    // 根目录隔离（安全）：上传目标必须属于当前用户被授权的根；__computer__ 仅 admin 可写
    const allowed = (user && auth.userRoots(user)) || [];
    if (!allowed.includes(rootKey) && !(rootKey === HOME_ROOT && allowed.includes(HOME_ROOT))) {
      try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', upload.id)); } catch (e) {}
      console.warn('[TUS] upload rejected (root not allowed):', rootKey, 'user=', user && user.username);
      return { res, status_code: 403, body: 'root not allowed' };
    }
    const dest = resolveWithin(rootKey, destSub, user); // 显式传入 user，解析 __home__ 到本人目录
    const from = path.join(DATA_DIR, 'uploads', upload.id);
    // 仅禁止直接写到“系统盘根目录本身”（如 C:\），其下子目录（含个人主目录）允许上传；
    // 这样“只有 C 盘”的机器也能正常使用（个人空间位于 C:\<项目>\home，不再是系统盘根）。
    if (!dest || isSystemDriveRoot(dest)) {
      try { fs.unlinkSync(from); } catch (e) {}
      console.warn('[TUS] upload rejected (invalid/system dest):', dest);
      return { res, status_code: 403, body: 'system drive upload rejected' };
    }
    const target = path.join(dest, safeName(meta.filename) || upload.id);
    try {
      fs.mkdirSync(dest, { recursive: true });
      if (!moveFile(from, target)) throw new Error('move failed (cross-device fallback)');
    } catch (e) {
      try { fs.unlinkSync(from); } catch (_) {}
      console.error('[TUS] move failed:', e.message);
      return { res, status_code: 500, body: e.message };
    }
    // 必须返回含 res 的对象，否则 @tus/server 1.x 会读取 undefined.res 抛异常，
    // 导致“文件已落盘但前端报上传失败”的假错误（正是本次 bug 根因）
    return { res, status_code: 204 };
  }
});
app.all(['/api/upload', '/api/upload/*'], (req, res) => { tusServer.handle(req, res); });

// ---- 静态前端 ----
// 关键：前端是单页应用且频繁改版，必须禁止浏览器缓存 index.html，
// 否则用户会一直加载旧版（表现为“改了却看不到”）。仅对 HTML 入口禁用缓存，
// 其余静态资源（js/css/图片）仍可正常缓存。
app.use((req, res, next) => {
  const urlPath = req.path || '';
  if (urlPath === '/' || urlPath.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.get('/login', (req, res) => { if (auth.getSession(parseCookies(req).nm_session)) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'login.html')); });
// 未登录访问根路径 → 跳转独立登录页（已登录则正常进入文件管理）
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    if (!auth.getSession(parseCookies(req).nm_session)) return res.redirect('/login');
  }
  next();
});
// 静态资源：HTML 一律 no-store，强制浏览器每次拉取最新页面（避免旧版缓存导致“点了没反应”）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (String(filePath).endsWith('.html')) res.set('Cache-Control', 'no-store');
  }
}));

// ===== Let's Encrypt 集成：挑战服务器 + HTTPS 服务 + 自动续期 =====
let httpsServer = null;
function tryStartHttps() {
  if (!LETSENCRYPT_ENABLED || httpsServer) return;
  const tls = acmeMgr.loadTls();
  if (!tls) return;
  httpsServer = https.createServer(tls, app);
  httpsServer.on('error', (e) => console.error('[ACME] HTTPS server error:', e.message));
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('[ACME] HTTPS 已启用: https://localhost:' + HTTPS_PORT);
    acmeMgr.setHttpsActive(true);
  });
}
function applyLetsEncrypt() {
  if (!LETSENCRYPT_ENABLED) return;
  // 挑战服务器：始终启动（供申请与续期的 HTTP-01 校验；其余请求 301 跳 HTTPS）
  acmeMgr.startChallengeServer(ACME_HTTP_PORT, HTTPS_PORT);
  tryStartHttps();
}
function acmeAutoRenew() {
  if (!LETSENCRYPT_ENABLED) return;
  const st = acmeMgr.getStatus();
  if (st.cert && typeof st.cert.daysLeft === 'number' && st.cert.daysLeft < 30) {
    const dl = String(LETSENCRYPT_DOMAINS).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (!dl.length || !LETSENCRYPT_EMAIL) return;
    console.log('[ACME] 证书剩余 ' + st.cert.daysLeft + ' 天，开始自动续期…');
    acmeMgr.requestCertificate({ domains: dl, email: LETSENCRYPT_EMAIL, staging: LETSENCRYPT_STAGING })
      .then(() => { console.log('[ACME] 证书已自动续期'); tryStartHttps(); })
      .catch((e) => { console.error('[ACME] 自动续期失败: ' + (e && e.message)); });
  }
}
// 每日检查一次证书是否临近过期（<30 天）并自动续期；启动 60 秒后也检查一次
setInterval(acmeAutoRenew, 24 * 60 * 60 * 1000);
setTimeout(acmeAutoRenew, 60 * 1000);

// ===== 监听 =====
// 主服务 server：始终以 HTTP 监听 PORT（内部管理 / 看门狗健康检查 / 局域网访问）。
// 若配置了 TLS（Let's Encrypt 证书，或环境变量 HTTPS_CERT/HTTPS_KEY），额外起 httpsServer 提供加密访问。
const certPath = process.env.HTTPS_CERT;
const keyPath = process.env.HTTPS_KEY;
const tlsEnv = (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath))
  ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } : null;
let server = http.createServer(app);
if (tlsEnv) {
  httpsServer = https.createServer(tlsEnv, app);
  httpsServer.on('error', (e) => console.error('[TLS] HTTPS server error:', e.message));
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('传输加密 = 已启用 HTTPS（本机 TLS 证书），监听端口 ' + HTTPS_PORT);
  });
} else {
  console.log('传输加密 = 未启用 (HTTP 明文；可在设置中开启 Let\'s Encrypt 自动申请，或公网暴露前套 Caddy/反代)');
}

// 单实例选举：用“协调端口 5002”的 OS 级互斥保证全局只有一个 server 真正绑定 5000，
// 其余实例（无论被看门狗 / 多次双击 / 多 supervisor 以何种频率拉起）直接退出，
// 彻底消除重复实例抢占端口导致的“卡死/以为没反应”抖动；比 PID/文件锁在 Windows 上可靠得多。
const SERVER_COORD_PORT = 5002;
const serverCoord = net.createServer();
let coordRetries = 0;
const COORD_MAX_RETRIES = 40; // 退避重试上限（约 20s），之后确属重复实例才退出
serverCoord.on('listening', startServerListening);
serverCoord.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 端口被占用多为“上一份实例刚退出、socket 仍在 TIME_WAIT（Windows 偶有）”的瞬时状态，
    // 此时若直接退出，会被看门狗/多次拉起反复触发，形成“假死/卡顿”风暴。改为退避重试，
    // 让端口尽快释放后本实例正常接管；仅当长时间（上限）仍占用，才认定为真实重复实例而退出。
    if (coordRetries < COORD_MAX_RETRIES) {
      coordRetries++;
      const delay = Math.min(1000, 200 * coordRetries);
      console.warn('协调端口 ' + SERVER_COORD_PORT + ' 暂被占用，第 ' + coordRetries + ' 次重试（' + delay + 'ms 后）');
      setTimeout(() => { try { serverCoord.listen(SERVER_COORD_PORT); } catch (e) {} }, delay);
      return;
    }
    console.error('已有 NasManager server 实例在运行（协调端口 ' + SERVER_COORD_PORT + '），本进程退出');
    process.exit(0);
  }
  console.error('server coord error:', err);
  process.exit(1);
});
serverCoord.listen(SERVER_COORD_PORT);

function startServerListening() {
  // 端口被占用时优雅退出，避免未处理的 'error' 事件导致进程崩溃、
  // 看门狗反复拉起形成“假死/卡顿”抖动（EADDRINUSE 多由重复实例抢占 5000 端口引起）。
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('端口 ' + PORT + ' 已被占用（疑似重复实例），本进程退出，交由守护进程/看门狗重新拉起');
      process.exit(1);
    }
    console.error('server error:', err);
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log('NasManager 已启动: ' + (server instanceof https.Server ? 'https' : 'http') + '://localhost:' + PORT);
    console.log('DATA_DIR = ' + DATA_DIR + ' (盘符 ' + getDrive(DATA_DIR) + ')');
    console.log('ROOTS    = ' + JSON.stringify(ROOTS));
    console.log('SYSTEM   = ' + JSON.stringify(SYSTEM_DRIVES));
    console.log('登录认证 = 强制开启 (用户名/密码 + scrypt 加盐哈希 + HttpOnly 会话)');
    console.log('缩略图引擎 sharp = ' + (thumbnails.hasSharp ? '已加载' : '未安装(图像缩略图降级)') +
      ' | 搜索内存索引条目 = ' + search.getStatus().count);
    // 预热带：启动后立刻枚举一次磁盘并写入缓存，避免首个“此电脑”/WebDAV 根请求触发冷枚举（~1.6s）；
    // 同时落盘缓存（.drive_cache.json），服务被环境回收重启后也能秒级回暖。
    setTimeout(() => { try { listDrives(true); console.log('磁盘列表缓存已预热'); } catch (e) {} }, 500);
    // 启动文件系统监听（增量搜索索引 + 前端实时刷新），与预热错开避免启动期 IO 争用
    setTimeout(() => { try { startFsWatchers(); } catch (e) {} }, 1500);
    // 启动后自动在后台建立/刷新搜索索引（无需手动 POST /reindex）。分块让出事件循环 + 节流休眠，
    // 即使全盘扫描也不会卡死；如需手动全量刷新仍可用 POST /api/search/reindex。
    setTimeout(() => {
      try {
        const ok = search.buildIndexAsync();
        console.log(ok ? '搜索索引后台自动建立已触发' : '搜索索引已在构建中（跳过重复触发）');
      } catch (e) { console.error('搜索索引后台建立失败：', e.message); }
    }, 2000);
    // 启动 Let's Encrypt 挑战服务器与（已有证书时）HTTPS 服务
    setTimeout(() => { try { applyLetsEncrypt(); } catch (e) {} }, 800);
  });
}

// 定期清理已过期分享链接（每 60 秒一次），使其自动从分享管理中移除
setInterval(() => {
  try { const n = share.pruneExpired(); if (n > 0) console.log('已清理过期分享链接 ' + n + ' 条'); } catch (e) {}
}, 60 * 1000);

// ===== 文件系统监听：增量更新搜索索引（递归监听全盘，仅用于后台重建索引，不触发 UI 刷新） =====
// 注意：递归监听整盘会产生大量事件（尤其 Windows 后台写入），因此这里【只重建搜索索引】，
// 绝不直接向 UI 广播，避免“网页登录后不停闪烁”。UI 实时刷新由 /api/events 的“单目录监听”负责。
const rootWatchDebounce = new Map(); // rootKey -> timer
function scheduleRootReindex(rootKey) {
  if (rootWatchDebounce.has(rootKey)) return; // 同一根目录 3 秒内只重建一次索引
  const t = setTimeout(() => {
    rootWatchDebounce.delete(rootKey);
    try { search.rebuildRoot(rootKey); } catch (e) {}
  }, 3000);
  rootWatchDebounce.set(rootKey, t);
}
function startFsWatchers() {
  const watchList = [];
  for (const [key, root] of Object.entries(ROOTS)) watchList.push({ key, root });
  // 同时监听每个用户的个人主目录（其变化也触发索引重建）
  for (const u of (auth.listUsers ? auth.listUsers() : [])) {
    const h = homePathFor(u.username);
    if (h && fs.existsSync(h)) watchList.push({ key: HOME_ROOT, root: h });
  }
  for (const wd of watchList) {
    try {
      const w = fs.watch(wd.root, { recursive: true }, (event, filename) => {
        // 仅后台重建搜索索引；不广播 UI（避免刷新风暴）
        scheduleRootReindex(wd.key);
      });
      w.on('error', () => { /* 某些环境不支持 recursive 监听，忽略 */ });
    } catch (e) { console.warn('无法监听目录 ' + wd.root + '：' + e.message); }
  }
  console.log('文件系统监听已启动（' + watchList.length + ' 个根目录，仅用于增量搜索索引）');
}

// ===== 版本/回收站自动清理（避免磁盘无限膨胀） =====
async function runRetention() {
  let versionsPruned = 0, recyclePurged = 0;
  try {
    versionsPruned = versions.pruneOld(VERSIONS_MAX_AGE_DAYS * 86400000) || 0;
    if (versionsPruned > 0) console.log('已清理过期版本快照 ' + versionsPruned + ' 个');
  } catch (e) {}
  try {
    if (RECYCLE_AUTOPURGE_DAYS > 0) {
      const r = await recycle.doPurgeOld(RECYCLE_AUTOPURGE_DAYS);
      recyclePurged = (r && r.purged) || 0;
      if (recyclePurged > 0) console.log('已自动清理回收站 ' + recyclePurged + ' 项');
    }
  } catch (e) {}
  retentionLastRun = { runAt: Date.now(), versionsPruned, recyclePurged };
  try { savePersistedSettings(); } catch (e) {}
  return retentionLastRun;
}
runRetention();
setInterval(runRetention, 6 * 60 * 60 * 1000); // 每 6 小时执行一次
