'use strict';
// 文件版本历史：每次通过 PUT 覆盖保存文本文件前，将当前内容快照到
// DATA_DIR/versions/<rootKey>/<safeRel>/<timestamp>。支持列出与还原。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, ROOTS } = require('../config');

const BASE = path.join(DATA_DIR, 'versions');
fs.mkdirSync(BASE, { recursive: true });

function safeRel(rel) { return rel.replace(/[\\/:*?"<>|]/g, '_'); }

function dirFor(rootKey, rel) {
  return path.join(BASE, rootKey, safeRel(rel));
}

function snapshot(rootKey, rel, buf) {
  try {
    const dir = dirFor(rootKey, rel);
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(path.join(dir, name), buf);
    // 限制每个文件最多保留 30 个版本
    let ents; try { ents = fs.readdirSync(dir).sort(); } catch (e) { return; }
    while (ents.length > 30) {
      try { fs.unlinkSync(path.join(dir, ents.shift())); } catch (e) {}
    }
  } catch (e) { /* 快照失败不致命 */ }
}

function list(rootKey, rel) {
  const dir = dirFor(rootKey, rel);
  let ents; try { ents = fs.readdirSync(dir).sort().reverse(); } catch (e) { return []; }
  return ents.map(n => {
    let st = { size: 0, mtimeMs: 0 };
    try { st = fs.statSync(path.join(dir, n)); } catch (e) {}
    const ts = parseInt(n.split('_')[0], 36);
    return { name: n, size: st.size, time: isNaN(ts) ? st.mtimeMs : ts };
  });
}

function getVersion(rootKey, rel, name) {
  return path.join(dirFor(rootKey, rel), name);
}

function restore(rootKey, rel, name) {
  const src = getVersion(rootKey, rel, name);
  const root = ROOTS[rootKey];
  if (!root) return { ok: false, error: 'ROOT_MISSING' };
  if (!fs.existsSync(src)) return { ok: false, error: 'NOT_FOUND' };
  const target = path.join(root, rel);
  try {
    const cur = fs.readFileSync(target);
    snapshot(rootKey, rel, cur); // 还原前先备份当前
    fs.copyFileSync(src, target);
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

function read(rootKey, rel, name) {
  const src = getVersion(rootKey, rel, name);
  if (!src || !fs.existsSync(src)) return null;
  return src;
}

function remove(rootKey, rel, name) {
  const src = getVersion(rootKey, rel, name);
  if (!src || !fs.existsSync(src)) return { ok: false, error: 'NOT_FOUND' };
  try { fs.unlinkSync(src); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

// 按年龄清理版本快照（默认保留 90 天），避免 versions 目录无限膨胀。
// 仅删除我们自己的快照数据，不影响任何源文件；返回清理掉的条目数。
function pruneOld(maxAgeMs) {
  const cutoff = Date.now() - (maxAgeMs || 90 * 86400000);
  let removed = 0;
  try {
    let rootDirs; try { rootDirs = fs.readdirSync(BASE); } catch (e) { return 0; }
    for (const rk of rootDirs) {
      const rdir = path.join(BASE, rk);
      let fileDirs; try { fileDirs = fs.readdirSync(rdir); } catch (e) { continue; }
      for (const fd of fileDirs) {
        const fdir = path.join(rdir, fd);
        let ents; try { ents = fs.readdirSync(fdir); } catch (e) { continue; }
        for (const n of ents) {
          const fp = path.join(fdir, n);
          let st; try { st = fs.statSync(fp); } catch (e) { continue; }
          const ts = parseInt(n.split('_')[0], 36);
          const age = isNaN(ts) ? st.mtimeMs : ts;
          if (age < cutoff) { try { fs.unlinkSync(fp); removed++; } catch (e) {} }
        }
        // 若该文件的所有版本都被清光，顺手删空目录
        try { const left = fs.readdirSync(fdir); if (left.length === 0) fs.rmdirSync(fdir); } catch (e) {}
      }
    }
  } catch (e) {}
  return removed;
}

module.exports = { snapshot, list, getVersion, read, remove, restore, pruneOld };
