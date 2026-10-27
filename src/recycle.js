'use strict';
// 回收站：直接对接 Windows 系统回收站（与桌面回收站完全同步）。
// 删除 = SHFileOperation(FO_DELETE | FOF_ALLOWUNDO)；列举/还原/清空 = 读取真实回收站。
// 这样在 NasManager 里删除的文件，和你在资源管理器里删除的文件进同一个回收站，可互相还原。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ROOTS } = require('../config');

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// 判断 abs 是否落在某个受管根目录内，并返回根 key 与相对路径
function locateRoot(abs) {
  for (const [k, r] of Object.entries(ROOTS)) {
    const rel = path.relative(r, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { rootKey: k, rel };
  }
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

// 列举真实回收站中、原位置位于受管根目录下的条目（含其他来源，root 标记为空字符串）
async function doList() {
  let out;
  try { out = await runPS(listScript(), { RB_ROOTS: Object.values(ROOTS).join('|') }); }
  catch (e) { return []; }
  const items = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [rpath, name, orig] = parts;
    let rootKey = '';
    for (const [k, r] of Object.entries(ROOTS)) {
      if (orig && orig.toLowerCase().startsWith(r.toLowerCase())) { rootKey = k; break; }
    }
    let deletedAtMs = 0;
    try { const st = fs.statSync(rpath); deletedAtMs = st.birthtimeMs || st.ctimeMs || 0; } catch (e) {}
    let size = 0;
    try {
      (function walk(x) {
        let st; try { st = fs.statSync(x); } catch (e) { return; }
        if (st.isDirectory()) { try { for (const d of fs.readdirSync(x)) walk(path.join(x, d)); } catch (e) {} }
        else size += st.size;
      })(rpath);
    } catch (e) {}
    items.push({ id: rpath, name, root: rootKey, originalPath: orig || '', deletedAt: deletedAtMs, size });
  }
  items.sort((a, b) => b.deletedAt - a.deletedAt);
  return items;
}

// 还原：把回收站里的 $R 条目移回原始位置
async function doRestore(binPath, originalPath, name) {
  if (!binPath) return { ok: false, error: 'MISSING_PATH' };
  const full = originalPath ? path.join(originalPath, name) : name;
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
