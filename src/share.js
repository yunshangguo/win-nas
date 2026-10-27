'use strict';
// 共享链接：免登录的临时访问令牌（可设密码 + 有效期），持久化于 DATA_DIR/shares.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DATA_DIR = '';
let file = '';
let cache = null;

function init(dataDir) {
  DATA_DIR = dataDir;
  file = path.join(DATA_DIR, 'shares.json');
  load();
}
function load() {
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { cache = { shares: [] }; }
  if (!cache.shares) cache.shares = [];
}
function persist() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache, null, 2)); } catch (e) {}
}
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const d = crypto.scryptSync(pw, salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + d.toString('hex');
}
function verifyPw(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return stored === pw;
  const [, salt, hash] = stored.split('$');
  const d = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return d.toString('hex') === hash;
}
function addShare({ root, itemPath, absBase, expiresInHours, password }) {
  const token = crypto.randomBytes(24).toString('hex');
  const rec = {
    token, root, itemPath, absBase: absBase || null,
    createdAt: Date.now(),
    expiresAt: expiresInHours ? Date.now() + expiresInHours * 3600 * 1000 : 0,
    password: password ? hashPw(password) : null,
    passwordText: password ? String(password) : null, // 明文保存，便于在分享管理中查看
    views: 0, downloads: 0
  };
  cache.shares.push(rec);
  persist();
  return rec;
}
function getShare(token) {
  return cache.shares.find(s => s.token === token) || null;
}
function revoke(token) {
  const i = cache.shares.findIndex(s => s.token === token);
  if (i >= 0) { cache.shares.splice(i, 1); persist(); return true; }
  return false;
}
function bump(token, field) {
  const s = getShare(token);
  if (s) { s[field] = (s[field] || 0) + 1; persist(); }
}
// 自动清理已过期链接（expiresAt>0 且早于当前时间）。返回被清理的数量。
function pruneExpired() {
  const now = Date.now();
  const before = cache.shares.length;
  cache.shares = cache.shares.filter(s => !(s.expiresAt && s.expiresAt > 0 && s.expiresAt < now));
  if (cache.shares.length !== before) persist();
  return before - cache.shares.length;
}
// 调整有效期：hours 为数字（相对延长 N 小时）；hours 为 0 表示设为永久有效。
function extend(token, hours) {
  const s = getShare(token);
  if (!s) return false;
  if (hours === 0) { s.expiresAt = 0; }
  else {
    const base = (s.expiresAt && s.expiresAt > Date.now()) ? s.expiresAt : Date.now();
    s.expiresAt = base + Number(hours) * 3600 * 1000;
  }
  persist();
  return true;
}
function listShares() {
  pruneExpired(); // 列举时顺手清理过期链接，使其自动从管理列表中消失
  return cache.shares.map(s => ({
    token: s.token, root: s.root, itemPath: s.itemPath || '',
    name: s.itemPath ? path.basename(s.itemPath) : (s.name || '(未知)'),
    createdAt: s.createdAt, expiresAt: s.expiresAt, hasPassword: !!s.password,
    passwordText: s.passwordText || null,
    views: s.views || 0, downloads: s.downloads || 0
  }));
}

module.exports = { init, addShare, getShare, revoke, listShares, verifyPw, bump, pruneExpired, extend };
