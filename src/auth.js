'use strict';
// ============================================================================
// 认证与多用户权限模块
// ----------------------------------------------------------------------------
//  - 强制登录 + 密码加盐哈希（scrypt(salt, SHA-256(password))）存储于 DATA_DIR
//  - 服务端会话（HttpOnly Cookie），落盘避免重启踢下线
//  - 多用户：管理员(admin)可分发子账号，为每个用户分配“可访问根目录”与权限位
//    （read 列目录/下载/预览、write 上传/新建/重命名/移动/复制、delete 删除）
//  - 角色：admin（拥有全部根 + 用户管理 + 全部权限）；user（仅被分配的根与权限）
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR, ROOTS } = require('../config');
const { COMPUTER_ROOT, HOME_ROOT, homePathFor } = require('./paths');

// 凭据与盐值全部落在 DATA_DIR（非系统盘），绝不写 C:
const SECRET_DIR = path.join(DATA_DIR, 'secrets');
fs.mkdirSync(SECRET_DIR, { recursive: true });

const SALT_FILE = path.join(SECRET_DIR, 'auth.salt');
const salt = (() => {
  if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE);
  const s = crypto.randomBytes(16);
  fs.writeFileSync(SALT_FILE, s); // 随机盐值持久化，重启后哈希保持一致
  return s;
})();

// 用户表（DATA_DIR/secrets/users.json）；首次运行自动播种管理员
const USERS_FILE = path.join(SECRET_DIR, 'users.json');
// 历史遗留：用户改过密码时落盘的覆盖哈希（仅用于迁移到管理员账户）
const PASSWORD_OVERRIDE = path.join(SECRET_DIR, 'password.override');

// 引导管理员用户名（来自 env，缺省 admin）
const ADMIN_USERNAME = (process.env.AUTH_USERNAME || 'admin').trim();

const USERNAME = ADMIN_USERNAME; // 向后兼容导出（= 引导管理员名）

// 会话有效期：12 小时，每次活动刷新（防长期挂机被复用）
const SESSION_TTL = 1000 * 60 * 60 * 12;
const sessions = new Map(); // sessionId -> { username, expiresAt }

// ---- 会话持久化 ----
const SESSIONS_FILE = path.join(SECRET_DIR, 'sessions.json');
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (s && s.id && s.username && typeof s.expiresAt === 'number' && s.expiresAt > now) {
            sessions.set(s.id, { username: s.username, expiresAt: s.expiresAt });
          }
        }
      }
    }
  } catch (e) { /* 文件损坏则忽略，重新建立会话 */ }
}
loadSessions();

let _persistTimer = null;
function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => { _persistTimer = null; persistSessions(); }, 2000);
}
function persistSessions() {
  try {
    const arr = [];
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.expiresAt > now) arr.push({ id, username: s.username, expiresAt: s.expiresAt });
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr));
  } catch (e) { /* 写盘失败忽略 */ }
}
setInterval(persistSessions, 30000);

// ---- 用户表 ----
let _users = {}; // username -> user record（含 passwordHash）

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
// 客户端传来的是 SHA-256(password) 的十六进制；服务端再用 scrypt 加盐
function derive(clientHashHex) { return crypto.scryptSync(Buffer.from(clientHashHex, 'hex'), salt, 64).toString('hex'); }
// 由明文密码得到存储哈希（管理员创建/重置子账号时使用；密码经 HTTPS 传输）
function hashPassword(plain) { return derive(sha256hex(plain)); }
// 兼容：password 既可是明文，也可是客户端预计算的 SHA-256(password) 十六进制（与登录一致）
function normalizePasswordInput(pw) {
  if (!pw) return null;
  pw = String(pw);
  if (/^[0-9a-f]{64}$/i.test(pw)) return derive(pw);
  return derive(sha256hex(pw));
}

function normalizeUser(u) {
  const role = u.role === 'admin' ? 'admin' : 'user';
  // 根目录白名单：静态 ROOTS 配置项 + 此电脑 + 个人主目录
  const roots = Array.isArray(u.roots)
    ? u.roots.filter(r => r === COMPUTER_ROOT || r === HOME_ROOT || Object.prototype.hasOwnProperty.call(ROOTS, r))
    : [];
  // 个人主目录是每个账号必有的独立空间，强制保留（不可被移除）
  if (roots.indexOf(HOME_ROOT) < 0) roots.push(HOME_ROOT);
  const perms = Object.assign({ read: true, write: true, delete: true }, u.perms || {});
  return {
    username: String(u.username || '').trim(),
    passwordHash: u.passwordHash || '',
    role,
    roots,
    perms,
    disabled: !!u.disabled,
    createdAt: u.createdAt || Date.now(),
    createdBy: u.createdBy || 'system'
  };
}

// 确保某账号的个人主目录（D:\<用户名>）存在；失败仅告警不致命
function ensureHome(u) {
  const h = homePathFor(u);
  if (!h) return;
  try { fs.mkdirSync(h, { recursive: true }); }
  catch (e) { console.error('[AUTH] 创建个人主目录失败 ' + h + ': ' + e.message); }
}

function persistUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(Object.values(_users), null, 2)); }
  catch (e) { console.error('[AUTH] 写入 users.json 失败: ' + e.message); }
}

// 启动时加载/播种用户表
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      _users = {};
      if (Array.isArray(arr)) for (const u of arr) if (u && u.username) _users[String(u.username).trim()] = normalizeUser(u);
      console.log('[AUTH] 已加载 ' + Object.keys(_users).length + ' 个用户');
      for (const u of Object.values(_users)) ensureHome(u); // 保证个人主目录存在
      return;
    } catch (e) { console.error('[AUTH] users.json 损坏，将重新播种: ' + e.message); }
  }
  // 首次运行：播种引导管理员
  let hash = null;
  if (fs.existsSync(PASSWORD_OVERRIDE)) { try { hash = fs.readFileSync(PASSWORD_OVERRIDE, 'utf8').trim(); } catch (e) {} }
  if (!hash) {
    let pw = (process.env.AUTH_PASSWORD || '').trim();
    if (!pw) {
      pw = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      const f = path.join(SECRET_DIR, 'initial_admin_password.txt');
      fs.writeFileSync(f,
        '首次运行且未设置 AUTH_PASSWORD，已自动生成管理员密码。\n' +
        '用户名: ' + ADMIN_USERNAME + '\n' +
        '密码:   ' + pw + '\n' +
        '请尽快在 .env 中设置 AUTH_PASSWORD 并删除本文件。\n');
      console.log('[AUTH] 未设置 AUTH_PASSWORD，已自动生成初始管理员密码 -> ' + f);
    }
    hash = derive(sha256hex(pw));
  }
  _users[ADMIN_USERNAME] = normalizeUser({
    username: ADMIN_USERNAME, passwordHash: hash, role: 'admin', roots: [],
    perms: { read: true, write: true, delete: true }, disabled: false, createdAt: Date.now(), createdBy: 'system'
  });
  persistUsers();
  ensureHome(_users[ADMIN_USERNAME]); // 管理员个人主目录
}

function init() { loadUsers(); }

// 校验登录凭据，成功返回用户记录（含 username），失败返回 null
function verifyLogin(body) {
  const username = body && body.username;
  const ph = body && body.passwordHash;
  const pw = body && body.password;
  if (!username) return null;
  const u = _users[String(username).trim()];
  if (!u || u.disabled) return null;
  let clientHash;
  if (ph && /^[0-9a-f]{64}$/i.test(ph)) clientHash = ph;
  else if (pw) clientHash = sha256hex(pw);
  else return null;
  const a = Buffer.from(derive(clientHash), 'hex');
  const b = Buffer.from(u.passwordHash, 'hex');
  if (a.length !== b.length || b.length === 0) return null;
  if (!crypto.timingSafeEqual(a, b)) return null; // 恒定时间比较，防时序攻击
  return u;
}

function createSession(username) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { username, expiresAt: Date.now() + SESSION_TTL });
  schedulePersist();
  return id;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(id); schedulePersist(); return null; }
  // 用户被删除/禁用则视为无效
  const u = _users[s.username];
  if (!u || u.disabled) { sessions.delete(id); schedulePersist(); return null; }
  s.expiresAt = Date.now() + SESSION_TTL; // 活动即续期
  schedulePersist();
  return s;
}

function destroySession(id) { if (id) { sessions.delete(id); schedulePersist(); } }

// 使某用户的所有会话失效（删除/禁用账户时调用）
function revokeUserSessions(username) {
  for (const [id, s] of sessions) if (s.username === username) sessions.delete(id);
  schedulePersist();
}

function getUser(username) { return _users[String(username).trim()] || null; }
// 对外安全副本（不含 passwordHash）
function publicUser(u) {
  if (!u) return null;
  return { username: u.username, role: u.role, roots: u.roots, perms: u.perms, disabled: u.disabled, createdAt: u.createdAt, createdBy: u.createdBy };
}

// 该用户可访问的根目录 key 列表（admin = 此电脑 + 个人空间；user = 被分配的根 + 个人空间）
function userRoots(user) {
  if (!user) return [];
  if (user.role === 'admin') return Object.keys(ROOTS).concat([COMPUTER_ROOT, HOME_ROOT]);
  const r = (user.roots || []).slice();
  if (r.indexOf(HOME_ROOT) < 0) r.push(HOME_ROOT);
  return r;
}
// 是否拥有某权限位（admin 恒为 true）
function hasPerm(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!(user.perms && user.perms[perm]);
}

function listUsers() { return Object.values(_users).map(publicUser); }

function isValidUsername(name) { return /^[a-zA-Z0-9_.@-]{2,32}$/.test(String(name || '').trim()); }

// 创建子账号（仅管理员调用）。opts: { username, password, role?, roots?, perms? }
function createUser(opts) {
  const username = String((opts && opts.username) || '').trim();
  const password = opts && opts.password;
  if (!isValidUsername(username)) return { error: 'BAD_USERNAME', message: '用户名需为 2-32 位字母/数字/._@-' };
  if (_users[username]) return { error: 'EXISTS', message: '用户名已存在' };
  if (!password || String(password).length < 6) return { error: 'BAD_PASSWORD', message: '密码至少 6 位' };
  const role = (opts.role === 'admin') ? 'admin' : 'user';
  // 仅接受合法根：静态 ROOTS 项 + 此电脑(__computer__) + 个人主目录(__home__)
  let roots = Array.isArray(opts.roots)
    ? opts.roots.filter(r => r === '__computer__' || r === HOME_ROOT || Object.prototype.hasOwnProperty.call(ROOTS, r))
    : [];
  if (roots.indexOf(HOME_ROOT) < 0) roots.push(HOME_ROOT); // 个人主目录必给
  // 新账号默认对其个人主目录拥有完全读写删能力；管理员可在面板收紧
  const perms = Object.assign({ read: true, write: true, delete: true }, opts.perms || {});
  const u = normalizeUser({ username, passwordHash: normalizePasswordInput(password), role, roots, perms, disabled: false, createdAt: Date.now(), createdBy: opts.createdBy || 'admin' });
  _users[username] = u;
  persistUsers();
  ensureHome(u); // 自动在 USER_HOME_BASE（项目安装盘根）下新建以账号命名的个人主目录
  return { user: publicUser(u) };
}

// 更新子账号（仅管理员）。opts: { roots?, perms?, disabled?, password? }
function updateUser(username, opts, operator) {
  username = String(username || '').trim();
  const u = _users[username];
  if (!u) return { error: 'NOT_FOUND', message: '用户不存在' };
  if (opts && Array.isArray(opts.roots)) {
    let r2 = opts.roots.filter(r => r === '__computer__' || r === HOME_ROOT || Object.prototype.hasOwnProperty.call(ROOTS, r));
    if (r2.indexOf(HOME_ROOT) < 0) r2.push(HOME_ROOT); // 个人主目录不可被移除
    u.roots = r2;
  }
  if (opts && opts.perms) u.perms = Object.assign({}, u.perms, opts.perms);
  if (opts && typeof opts.disabled === 'boolean') {
    // 禁止禁用/降权最后一个管理员
    if (u.role === 'admin' && opts.disabled) {
      if (countAdmins() <= 1) return { error: 'LAST_ADMIN', message: '不能禁用最后一个管理员' };
    }
    u.disabled = opts.disabled;
  }
  if (opts && opts.password) {
    if (String(opts.password).length < 6) return { error: 'BAD_PASSWORD', message: '密码至少 6 位' };
    u.passwordHash = normalizePasswordInput(opts.password);
  }
  _users[username] = normalizeUser(u);
  persistUsers();
  if (u.disabled) revokeUserSessions(username);
  return { user: publicUser(u) };
}

function deleteUser(username, operator) {
  username = String(username || '').trim();
  const u = _users[username];
  if (!u) return { error: 'NOT_FOUND', message: '用户不存在' };
  if (u.role === 'admin') {
    if (countAdmins() <= 1) return { error: 'LAST_ADMIN', message: '不能删除最后一个管理员' };
  }
  if (operator && operator === username) return { error: 'SELF_DELETE', message: '不能删除自己' };
  delete _users[username];
  persistUsers();
  revokeUserSessions(username);
  return { ok: true };
}

function countAdmins() { let n = 0; for (const u of Object.values(_users)) if (u.role === 'admin' && !u.disabled) n++; return n; }

// 修改自己的密码（先校验旧密码）。oldHash/newHash 可以是明文，或客户端预计算的 SHA-256(密码) 十六进制
function setOwnPassword(username, oldHash, newHash) {
  username = String(username || '').trim();
  const u = _users[username];
  if (!u) return { error: 'NOT_FOUND' };
  const a = Buffer.from(normalizePasswordInput(oldHash) || '', 'hex');
  const b = Buffer.from(u.passwordHash, 'hex');
  if (a.length !== b.length || b.length === 0 || !crypto.timingSafeEqual(a, b)) return { error: 'OLD_WRONG' };
  const newDerived = normalizePasswordInput(newHash);
  if (!newDerived) return { error: 'BAD_NEW' };
  u.passwordHash = newDerived;
  _users[username] = normalizeUser(u);
  persistUsers();
  revokeUserSessions(username); // 改密后其他会话失效
  return { ok: true };
}

module.exports = {
  USERNAME, SESSION_TTL, init, verifyLogin, createSession, getSession, destroySession,
  getUser, publicUser, userRoots, hasPerm, listUsers, createUser, updateUser, deleteUser,
  setOwnPassword, revokeUserSessions
};
