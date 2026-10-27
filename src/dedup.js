'use strict';
// 文件去重：扫描指定 root（或全量），按 大小→SHA256 分组，返回重复组。
// 删除由调用方走回收站（/delete）以保证可恢复。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOTS } = require('../config');

const MAX_FILES = 200000;
const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

function sha256File(p) {
  try {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(p));
    return h.digest('hex');
  } catch (e) { return null; }
}

function scan(rootKey, root, groups, count) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const d of ents) {
    if (count.n >= MAX_FILES) return;
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue;
      scan(rootKey, path.join(root, d.name), groups, count);
      continue;
    }
    if (!d.isFile()) continue;
    count.n++;
    const full = path.join(root, d.name);
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.size === 0) continue;
    const key = st.size + ':' + (function () {
      // 仅对 <=50MB 的文件算哈希，大文件仅按大小分组（近似）
      if (st.size > 50 * 1024 * 1024) return 'BIG';
      return sha256File(full) || ('ERR' + count.n);
    })();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ root: rootKey, rel: path.relative(ROOTS[rootKey], full), size: st.size });
  }
}

function findDuplicates(rootKey) {
  const groups = new Map();
  const count = { n: 0 };
  if (rootKey && ROOTS[rootKey]) scan(rootKey, ROOTS[rootKey], groups, count);
  else for (const [k, r] of Object.entries(ROOTS)) scan(k, r, groups, count);
  const dupes = [];
  for (const [, items] of groups) {
    if (items.length > 1) {
      const size = items[0].size;
      dupes.push({ size, count: items.length, items, waste: size * (items.length - 1) });
    }
  }
  dupes.sort((a, b) => b.waste - a.waste);
  let totalWaste = 0; for (const g of dupes) totalWaste += g.waste;
  return { scanned: count.n, groups: dupes.length, totalWaste, dupes: dupes.slice(0, 500) };
}

module.exports = { findDuplicates };
