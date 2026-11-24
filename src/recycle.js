'use strict';
// 回收站：直接对接 Windows 系统回收站（与桌面回收站完全同步）。
// 删除 = SHFileOperation(FO_DELETE | FOF_ALLOWUNDO)；列举/还原/清空 = 读取真实回收站。
// 这样在 NasManager 里删除的文件，和你在资源管理器里删除的文件进同一个回收站，可互相还原。
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const { ROOTS, USER_HOME_BASE } = require('../config');
const { COMPUTER_ROOT, HOME_ROOT } = require('./paths');

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// 判断 abs 是否落在某个受管根目录内，并返回根 key 与相对路径。
// 支持三类来源：
//  1) 静态 ROOTS 里配置的根目录；
//  2) 个人主目录 USER_HOME_BASE（__home__）；
//  3) “此电脑”下任意盘符路径（__computer__）——admin 从“此电脑”删 D:/I: 等盘的文件时命中。
// 修复背景：本机 .env 的 ROOTS 为空，用户全部文件都在“此电脑”视图下访问，
// 旧逻辑只认 ROOTS 导致所有删除都报 NOT_IN_ROOT（见 2026-11-19 任务记录）。
function locateRoot(abs) {
  if (!abs) return null;
  const norm = path.resolve(abs);
  // 1) 静态根
  for (const [k, r] of Object.entries(ROOTS)) {
    const rel = path.relative(r, norm);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { rootKey: k, rel };
  }
  // 2) 个人主目录
  if (USER_HOME_BASE) {
    const rel = path.relative(path.resolve(USER_HOME_BASE), norm);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { rootKey: '__home__', rel };
  }
  // 3) “此电脑”盘符路径：Windows 绝对路径（X:\...）视为受管，虚拟根 key = __computer__
  if (/^[A-Za-z]:[\\/]/.test(norm)) {
    const drive = norm.slice(0, 2).toUpperCase(); // 如 "D:"
    return { rootKey: COMPUTER_ROOT, rel: path.join(drive, path.relative(drive + path.sep, norm)) };
  }
  // 非 Windows 绝对路径（如 /home/...）：允许作为此电脑根处理
  if (norm.startsWith(path.sep)) return { rootKey: COMPUTER_ROOT, rel: norm };
  return null;
}

function runPS(script, env, timeout) {
  return new Promise((resolve, reject) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: Object.assign({}, process.env, env || {}),
      timeout: timeout || 30000,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: stderr || '', stdout: stdout || '' }));
      resolve(stdout || '');
    });
  });
}

// 内嵌的 C# P/Invoke：调用 SHFileOperation 把文件送入回收站（静默、无确认框）
const SHFILEOP_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class RBSend {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]',
  '  public struct SHFILEOPSTRUCT { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public int fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }',
  '  [DllImport("shell32.dll", CharSet=CharSet.Auto, SetLastError=true)]',
  '  public static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);',
  '  public const uint FO_DELETE=0x0003;',
  '  public const ushort FOF_ALLOWUNDO=0x0040; public const ushort FOF_NOCONFIRMATION=0x0010; public const ushort FOF_NOERRORUI=0x0400; public const ushort FOF_SILENT=0x0004;',
  '  public static int Send(string p){ var op=new SHFILEOPSTRUCT(); op.wFunc=FO_DELETE; op.pFrom=p+"\\0"; op.fFlags=FOF_ALLOWUNDO|FOF_NOCONFIRMATION|FOF_NOERRORUI|FOF_SILENT; return SHFileOperation(ref op); }',
  '}'
].join('\n');

function deleteScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    SHFILEOP_CS,
    "'@",
    "[int]$rc=[RBSend]::Send($env:RB_PATH)",
    "exit $rc"
  ].join('\n');
}

function listScript() {
  // 列出「真实 Windows 回收站」里的全部文件（不限项目管理的目录），与资源管理器完全同步。
  return [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$shell=New-Object -ComObject Shell.Application",
    "$bin=$shell.NameSpace(10)",
    "if($bin -eq $null){exit 0}",
    "foreach($item in $bin.Items()){",
    "  $rpath=$item.Path",
    "  if(-not $rpath){continue}",
    "  $name=$item.Name",
    "  $orig=$bin.GetDetailsOf($item,1)",
    "  $line=($rpath+'|'+$name+'|'+$orig)",
    "  [Console]::Out.Write($line+[char]10)",
    "}"
  ].join('\n');
}

// 把文件/文件夹送入 Windows 回收站
async function doDelete(abs) {
  if (!fs.existsSync(abs)) return { ok: false, error: 'NOT_FOUND' };
  const loc = locateRoot(abs);
  if (!loc) return { ok: false, error: 'NOT_IN_ROOT' };
  if (loc.rel === '') return { ok: false, error: 'CANNOT_DELETE_ROOT' }; // 禁止删除根目录本身
  try {
    await runPS(deleteScript(), { RB_PATH: abs });
  } catch (e) {
    // SHFileOperation 在某些环境下会返回非零但已成功移动文件，以下用「源文件是否还在」做最终判据
  }
  if (fs.existsSync(abs)) {
    return { ok: false, error: 'RECYCLE_FAILED', detail: 'source still exists after recycle' };
  }
  return { ok: true };
}

// ---- 回收站列举：直接解析各盘 $RECYCLE.BIN，不再依赖 Shell.Application COM ----
// 背景（2026-11-19）：服务进程所在 session 里 New-Object -ComObject Shell.Application
// 会超时/缓冲溢出（ETIMEDOUT / ENOBUFS），listScript 完全读不到回收站。改为直接读物理目录。
// Windows 10+ 的 $I 元数据：偏移0=版本(u64,通常为2)，8=原大小(u64)，16=删除时间(FILETIME u64)，
// 24=原路径字符数(u32)，28 起为 UTF-16LE 原完整路径（含文件名，null 结尾）。
// 每个 $Ixxxx.ext 对应 $Rxxxx.ext（回收站里的实际内容）。
function parseInfoFile(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 28) return null;
    const size = Number(b.readBigUInt64LE(8)) || 0;
    const ft = b.readBigUInt64LE(16);
    const deletedAt = Number(ft / 10000n) - 11644473600000; // FILETIME(100ns since 1601) -> Unix ms
    let orig = b.slice(28).toString('utf16le').replace(/\0[\s\S]*$/, '');
    if (!orig) return null;
    return { size, deletedAt: isFinite(deletedAt) && deletedAt > 0 ? deletedAt : 0, orig };
  } catch (e) { return null; }
}

function rootKeyFor(orig) {
  for (const [k, r] of Object.entries(ROOTS)) {
    if (orig && orig.toLowerCase().startsWith(String(r).toLowerCase())) return k;
  }
  try {
    const home = USER_HOME_BASE ? path.resolve(USER_HOME_BASE) : '';
    if (home && path.resolve(orig).toLowerCase().startsWith(home.toLowerCase() + path.sep)) return HOME_ROOT;
  } catch (e) {}
  if (orig && /^[A-Za-z]:[\\/]/.test(orig)) return COMPUTER_ROOT;
  return '';
}

// 单个 SID 目录最多解析多少条（C 盘回收站实测有 33047 个 $I，全量解析会卡死服务）。
// 只取最近 MAX_LIST 条：先按文件名 mtime 粗筛，避免读全部元数据。
const MAX_LIST_PER_SID = 2000;

function listBinDir(dir, items, seenIds) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  const nameSet = new Set(names); // 用集合判断 $R 是否存在，避免逐项 stat
  const iNames = names.filter(n => n.startsWith('$I'));
  // 条目过多时，按文件 mtime 倒序只解析最近的一批（$I 的 mtime ≈ 删除时间）。
  // 关键：先一次性算出每个文件的 mtime（O(n) 次 stat），再排序；
  // 绝不能在 sort 比较器里 stat（O(n log n)×2 次，C 盘 3.3 万项会卡 19 秒）。
  if (iNames.length > MAX_LIST_PER_SID) {
    const decorated = iNames.map(n => {
      let m = 0;
      try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) {}
      return { n, m };
    });
    decorated.sort((a, b) => b.m - a.m);
    iNames.length = 0;
    for (let i = 0; i < Math.min(MAX_LIST_PER_SID, decorated.length); i++) iNames.push(decorated[i].n);
  }
  for (const name of iNames) {
    const meta = parseInfoFile(path.join(dir, name));
    if (!meta) continue;
    const rName = '$R' + name.slice(2);
    if (!nameSet.has(rName)) continue; // 只有 $I 没有 $R：已被清理的残留元数据
    const id = path.resolve(dir, rName);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({
      id,
      name: path.basename(meta.orig),
      root: rootKeyFor(meta.orig),
      originalPath: meta.orig,
      deletedAt: meta.deletedAt,
      size: meta.size
    });
  }
}

// 列举真实回收站中、原位置位于受管根目录下的条目（含其他来源，root 标记为空字符串）
async function doList() {
  const items = [];
  const seenIds = new Set();
  const roots = [];
  if (process.platform === 'win32') {
    // 直接遍历盘符找 $RECYCLE.BIN：不用 wmic（部分环境 wmic 已移除/会挂起），也不用 COM。
    // 逐个盘符 existsSync 很快（不存在的盘立即返回 false），覆盖固定盘 + 移动盘。
    for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = d + ':\\$RECYCLE.BIN';
      try { if (fs.existsSync(p)) roots.push(p); } catch (e) {}
    }
  } else {
    roots.push('/root/.local/share/Trash/files');
  }
  for (const binRoot of roots) {
    let sids;
    try { sids = fs.readdirSync(binRoot); } catch (e) { continue; }
    for (const sid of sids) {
      const sidDir = path.join(binRoot, sid);
      try { if (!fs.statSync(sidDir).isDirectory()) continue; } catch (e) { continue; }
      listBinDir(sidDir, items, seenIds);
    }
  }
  items.sort((a, b) => b.deletedAt - a.deletedAt);
  return items;
}

// 还原：把回收站里的 $R 条目移回原始位置
async function doRestore(binPath, originalPath, name) {
  if (!binPath) return { ok: false, error: 'MISSING_PATH' };
  // originalPath（来自 $I 元数据）已是含文件名的完整原路径，不能再拼一次 name，
  // 否则会还原成 "...\文件名\文件名"。仅在它不含文件名时才用 name 补全。
  let full = originalPath || name || '';
  if (full && name && path.basename(full) !== name && !fs.existsSync(path.dirname(full))) {
    full = path.join(full, name);
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    try { fs.renameSync(binPath, full); }
    catch (e) {
      fs.cpSync(binPath, full, { recursive: true });
      fs.rmSync(binPath, { recursive: true, force: true });
    }
    removeSiblingMeta(binPath); // 清理同名的 $I 元数据
    return { ok: true, restoredTo: full };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 永久删除回收站条目（同时清掉 $I 元数据）
async function doPurge(binPath) {
  if (!binPath) return { ok: false, error: 'MISSING_PATH' };
  try {
    fs.rmSync(binPath, { recursive: true, force: true });
    removeSiblingMeta(binPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function removeSiblingMeta(binPath) {
  try {
    const base = path.basename(binPath);
    if (base.startsWith('$R')) {
      const sibling = path.join(path.dirname(binPath), '$I' + base.slice(2));
      fs.rmSync(sibling, { force: true });
    }
  } catch (e) {}
}

async function doPurgeAll() {
  const items = await doList();
  let n = 0;
  for (const it of items) { const r = await doPurge(it.id); if (r.ok) n++; }
  return { ok: true, purged: n };
}

function run(action, extra, cb) {
  (async () => {
    try {
      let result;
      if (action === 'delete') result = await doDelete(extra);
      else if (action === 'list') result = await doList();
      else if (action === 'restore') result = await doRestore(extra && (extra.id || extra.binPath), extra && extra.originalPath, extra && extra.name);
      else if (action === 'purge') result = (extra) ? await doPurge(extra) : await doPurgeAll();
      else result = { ok: false, error: 'UNKNOWN_ACTION' };
      cb(null, result);
    } catch (e) { cb(e); }
  })();
}

// 仅清理“来自受管根目录、且删除时间超过 days 天”的回收站条目。
// 默认不调用（days<=0 直接跳过），需显式设置环境变量 RECYCLE_AUTOPURGE_DAYS>0 才启用，
// 避免误删用户在其他地方删除、但同样进了系统回收站的文件。
async function doPurgeOld(days) {
  if (!days || days <= 0) return { ok: true, purged: 0, skipped: true };
  const cutoff = Date.now() - days * 86400000;
  const items = await doList();
  let n = 0;
  for (const it of items) {
    if (it.root && it.deletedAt && it.deletedAt < cutoff) {
      const r = await doPurge(it.id);
      if (r.ok) n++;
    }
  }
  return { ok: true, purged: n };
}

module.exports = { run, doDelete, doList, doRestore, doPurge, doPurgeOld };
