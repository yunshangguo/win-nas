'use strict';
// 收藏夹：持久化于 DATA_DIR/favorites.json，记录 root + relPath。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'favorites.json');
let list = [];
try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(list)) list = []; }
catch (e) { list = []; }

function persist() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); } catch (e) {}
}

function add(root, relPath) {
  const key = root + '::' + relPath;
  if (list.some(f => f.key === key)) return { ok: true, existed: true };
  const item = { key, root, relPath, addedAt: Date.now() };
  list.push(item); persist();
  return { ok: true, item };
}
function remove(root, relPath) {
  const key = root + '::' + relPath;
  const i = list.findIndex(f => f.key === key);
  if (i >= 0) { list.splice(i, 1); persist(); return { ok: true }; }
  return { ok: false };
}
function all() { return list.slice().sort((a, b) => b.addedAt - a.addedAt); }
function has(root, relPath) { return list.some(f => f.root === root && f.relPath === relPath); }

module.exports = { add, remove, all, has };
