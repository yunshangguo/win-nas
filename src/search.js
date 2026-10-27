'use strict';
// ============================================================================
// 搜索模块（v2）：名称索引 + 全文内容搜索，全部异步分块，绝不冻结事件循环。
// ----------------------------------------------------------------------------
//  - 名称索引覆盖：静态 ROOTS + 每个用户的“个人主目录”（带 owner 标记）。
//  - 个人空间按 owner 隔离：普通用户查 __home__ 只能看到自己的文件；admin 查 __home__ 也只看自己家。
//  - “此电脑(__computer__)”名称搜索：admin 可触发“实时受限遍历”（带深度/数量上限，分块让出），不冻结。
//  - 全文内容搜索：按用户被授权的根（个人空间 + 被分配静态根 + admin 的此电脑）实时分块遍历，带上限。
//  所有遍历都会 await setImmediate 让出事件循环，避免大目录把服务器卡死。
// ============================================================================
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ROOTS } = require('../config');
const { COMPUTER_ROOT, HOME_ROOT, homePathFor } = require('./paths');
const auth = require('./auth'); // 无循环依赖：auth 不依赖 search

const INDEX_DIR = path.join(DATA_DIR, 'index');
fs.mkdirSync(INDEX_DIR, { recursive: true });
const INDEX_FILE = path.join(INDEX_DIR, 'files.json');
const MAX_ENTRIES = 500000;        // 名称索引条目上限（MVP 防护）
const WALK_DEPTH_MAX = 60;         // 递归深度上限
const YIELD_EVERY = 1000;          // 每处理 N 个条目让出一次事件循环 + 节流休眠
// 节流休眠（毫秒）：每批让出后再 sleep 一段时间，主动降低磁盘/CPU 占用，防止全盘扫描时系统卡死。
// 可通过环境变量 SEARCH_THROTTLE_MS 调整（设 0 关闭节流；值越大越省资源但索引越慢）。
const THROTTLE_MS = Math.max(0, Number(process.env.SEARCH_THROTTLE_MS || 2));

// 全文内容搜索参数
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'js', 'ts', 'jsx', 'tsx', 'html', 'htm',
  'css', 'scss', 'xml', 'yaml', 'yml', 'csv', 'log', 'conf', 'ini', 'py', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'sh', 'php', 'rb', 'lua', 'sql', 'properties', 'toml', 'gitignore', 'vue', 'bat', 'ps1']);
const CONTENT_SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);
const CONTENT_MAX_FILES = 60000;
const CONTENT_MAX_SIZE = 5 * 1024 * 1024;
const CONTENT_MAX_MATCHES = 500;

let index = [];                 // 内存名称索引
let building = false;
let lastBuild = null;
let progress = { total: 0, done: 0 };
let _listDrives = null;         // 由 server.js 注入，用于枚举“此电脑”所有盘

function setListDrives(fn) { _listDrives = fn; }

function loadFromDisk() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const arr = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (Array.isArray(arr)) index = arr;
    }
  } catch (e) { index = []; }
}
function persist() {
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(index)); }
  catch (e) { /* 写盘失败不致命，内存仍可用 */ }
}

// 列出需要纳入“名称索引”的根：静态 ROOTS + 每个用户的个人主目录（带 owner）
function indexRoots() {
  const roots = [];
  for (const [key, p] of Object.entries(ROOTS)) roots.push({ key, abs: p, owner: null });
  for (const u of auth.listUsers()) {
    const h = homePathFor(u.username);
    if (h && fs.existsSync(h)) roots.push({ key: HOME_ROOT, abs: h, owner: u.username });
  }
  return roots;
}

function yieldEL() { return new Promise(r => setImmediate(r)); }
function sleep(ms) { return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve(); }

// 通用异步遍历：对每个条目调用 visitor({full,name,isDir,size,mtime})；返回 false 可提前中止。
// state = { count, aborted }，跨递归共享，用于全局上限与中止。
async function walkDir(dir, depth, state, visitor) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const d of entries) {
    if (state.aborted) return;
    const full = path.join(dir, d.name);
    const isDir = d.isDirectory();
    let size = 0, mtime = 0;
    try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
    const cont = await visitor({ full, name: d.name, isDir, size, mtime });
    if (cont === false) { state.aborted = true; return; }
    if ((++state.count) % YIELD_EVERY === 0) { await yieldEL(); await sleep(THROTTLE_MS); }
    if (state.count >= MAX_ENTRIES) { state.aborted = true; return; }
    if (isDir && depth < WALK_DEPTH_MAX) await walkDir(full, depth + 1, state, visitor);
  }
}

// 全量重建名称索引（异步分块）
async function buildIndex() {
  if (building) return false;
  building = true;
  lastBuild = { startedAt: Date.now(), finishedAt: null, count: 0, error: null };
  progress = { total: 0, done: 0 };
  const out = [];
  const state = { count: 0, aborted: false };
  try {
    for (const r of indexRoots()) {
      await walkDir(r.abs, 0, state, (e) => {
        out.push({
          root: r.key, owner: r.owner || '', path: relFrom(r.abs, e.full), name: e.name,
          dir: e.isDir ? 1 : 0, size: e.size, mtime: e.mtime,
          ext: path.extname(e.name).toLowerCase()
        });
        return true;
      });
    }
    index = out;
    persist();
    lastBuild.finishedAt = Date.now();
    lastBuild.count = index.length;
  } catch (e) {
    lastBuild.error = e.message;
  } finally {
    building = false;
  }
  return true;
}
function relFrom(base, full) {
  const rel = path.relative(base, full);
  return rel ? rel.split(path.sep).join('/') : '';
}

// 异步触发全量重建（立即返回，后台执行）
function buildIndexAsync() {
  if (building) return false;
  setImmediate(() => { buildIndex(); });
  return true;
}

// 仅重建某根（静态根：替换该 root key 的条目；__home__：重建所有用户个人目录）
async function rebuildRoot(rootKey) {
  const state = { count: 0, aborted: false };
  const out = [];
  const roots = [];
  if (rootKey === HOME_ROOT) {
    for (const u of auth.listUsers()) {
      const h = homePathFor(u.username);
      if (h && fs.existsSync(h)) roots.push({ key: HOME_ROOT, abs: h, owner: u.username });
    }
  } else if (ROOTS[rootKey]) {
    roots.push({ key: rootKey, abs: ROOTS[rootKey], owner: null });
  } else {
    return false;
  }
  for (const r of roots) {
    await walkDir(r.abs, 0, state, (e) => {
      out.push({
        root: r.key, owner: r.owner || '', path: relFrom(r.abs, e.full), name: e.name,
        dir: e.isDir ? 1 : 0, size: e.size, mtime: e.mtime,
        ext: path.extname(e.name).toLowerCase()
      });
      return true;
    });
  }
  index = index.filter(e => !(e.root === rootKey)) .concat(out);
  persist();
  return true;
}

function normExt(ext) {
  ext = (ext || '').toLowerCase();
  return ext.startsWith('.') ? ext : (ext ? '.' + ext : '');
}

// 名称搜索：基于内存索引（个人空间按 owner 隔离）。root=__computer__ 时 admin 触发实时受限遍历。
async function query(opts, user) {
  const q = (opts.q || '').toLowerCase();
  const ext = normExt(opts.ext);
  const root = opts.root || '';
  const minSize = opts.minSize != null ? Number(opts.minSize) : null;
  const maxSize = opts.maxSize != null ? Number(opts.maxSize) : null;
  const after = opts.after != null ? Number(opts.after) : null;
  const before = opts.before != null ? Number(opts.before) : null;
  const limit = opts.limit ? Math.min(Number(opts.limit), 2000) : 500;
  const isAdmin = !!(user && user.role === 'admin');
  const me = user ? user.username : '';

  // 此电脑名称搜索：admin 实时受限遍历所有盘（分块、带上限，不冻结）
  if (root === COMPUTER_ROOT) {
    if (!isAdmin) return [];
    return liveNameSearch(q, ext, minSize, maxSize, after, before, limit);
  }

  const results = [];
  for (const e of index) {
    if (root && e.root !== root) continue;
    // 个人空间隔离：__home__ 只返回本人（owner === 当前用户）的条目
    if (e.root === HOME_ROOT && e.owner && e.owner !== me) continue;
    if (q && !e.name.toLowerCase().includes(q)) continue;
    if (ext && e.ext !== ext) continue;
    if (minSize != null && e.size < minSize) continue;
    if (maxSize != null && e.size > maxSize) continue;
    if (after != null && e.mtime < after) continue;
    if (before != null && e.mtime > before) continue;
    results.push(e);
    if (results.length >= limit) break;
  }
  return results;
}

// 实时名称遍历（限此电脑；admin）。遍历所有盘，匹配文件名，带上限。
async function liveNameSearch(q, ext, minSize, maxSize, after, before, limit) {
  const drives = (_listDrives && typeof _listDrives === 'function') ? _listDrives() : [];
  const results = [];
  const state = { count: 0, aborted: false };
  const ql = q.toLowerCase();
  for (const d of drives) {
    if (state.aborted) break;
    const abs = (d.key || '') + ':\\';
    try {
      await walkDir(abs, 0, state, (e) => {
        if (q && !e.name.toLowerCase().includes(ql)) return true;
        if (ext && path.extname(e.name).toLowerCase() !== ext) return true;
        if (minSize != null && e.size < minSize) return true;
        if (maxSize != null && e.size > maxSize) return true;
        if (after != null && e.mtime < after) return true;
        if (before != null && e.mtime > before) return true;
        results.push({ root: COMPUTER_ROOT, owner: '', path: relFrom(abs, e.full), name: e.name, size: e.size, mtime: e.mtime, ext: path.extname(e.name).toLowerCase() });
        if (results.length >= limit) return false; // 达到上限即停
        return true;
      });
    } catch (e) {}
  }
  return results;
}

// 全文内容搜索：按用户被授权的根实时分块遍历（不冻结）。
async function searchContent(q, opts, user) {
  opts = opts || {};
  const needle = (q || '').toLowerCase();
  if (!needle) return { count: 0, results: [] };
  const rootKey = opts.root || '';
  const isAdmin = !!(user && user.role === 'admin');
  // 计算本用户被授权搜索的根（绝对路径列表）
  const roots = [];
  const allowed = auth.userRoots(user);
  for (const r of allowed) {
    if (r === COMPUTER_ROOT) {
      if (isAdmin && _listDrives) {
        for (const d of _listDrives()) roots.push({ abs: (d.key || '') + ':\\', rel: '' });
      }
    } else if (r === HOME_ROOT) {
      const h = homePathFor(user.username);
      if (h) roots.push({ abs: h, rel: '' });
    } else if (ROOTS[r]) {
      roots.push({ abs: ROOTS[r], rel: '' });
    }
  }
  if (rootKey) { // 若指定了 root，仅在该根内搜索
    // 找到匹配的根
    const filtered = [];
    if (rootKey === COMPUTER_ROOT) { if (isAdmin && _listDrives) for (const d of _listDrives()) filtered.push({ abs: (d.key || '') + ':\\', rel: '' }); }
    else if (rootKey === HOME_ROOT) { const h = homePathFor(user.username); if (h) filtered.push({ abs: h, rel: '' }); }
    else if (ROOTS[rootKey]) filtered.push({ abs: ROOTS[rootKey], rel: '' });
    if (filtered.length) roots.length = 0, roots.push(...filtered);
    else return { count: 0, results: [] };
  }
  const results = [];
  let filesScanned = 0;
  const state = { count: 0, aborted: false };
  for (const base of roots) {
    if (state.aborted || results.length >= CONTENT_MAX_MATCHES || filesScanned >= CONTENT_MAX_FILES) break;
    await walkDir(base.abs, 0, state, (e) => {
      if (state.aborted || results.length >= CONTENT_MAX_MATCHES || filesScanned >= CONTENT_MAX_FILES) return false;
      if (e.isDir) return true;
      filesScanned++;
      const ext = path.extname(e.name).toLowerCase().replace(/^\./, '');
      if (!TEXT_EXT.has(ext)) return true;
      let st; try { st = fs.statSync(e.full); } catch (e2) { return true; }
      if (st.size > CONTENT_MAX_SIZE || st.size === 0) return true;
      let text;
      try { text = fs.readFileSync(e.full, 'utf8'); } catch (e2) { return true; }
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) return true;
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + needle.length + 80);
      results.push({
        root: rootKey || 'mixed', owner: base.owner || '',
        rel: base.rel ? base.rel + '/' + relFrom(base.abs, e.full) : relFrom(base.abs, e.full),
        path: relFrom(base.abs, e.full), name: e.name, size: st.size, mtime: st.mtimeMs,
        snippet: (start > 0 ? '…' : '') + text.slice(start, end).replace(/\r?\n/g, ' ') + (end < text.length ? '…' : '')
      });
      if (results.length >= CONTENT_MAX_MATCHES) return false;
      return true;
    });
  }
  return { count: results.length, scanned: filesScanned, results };
}

// 静态根归属判定（仅用于静态 ROOTS；个人空间由 owner 决定）
function findRootKeyFor(full) {
  for (const [key, root] of Object.entries(ROOTS)) {
    const rel = path.relative(root, full);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return key;
  }
  return null;
}

loadFromDisk();

module.exports = {
  buildIndexAsync, buildIndex, query, searchContent, rebuildRoot, findRootKeyFor, setListDrives,
  getStatus: () => ({ building, lastBuild, progress, count: index.length })
};
