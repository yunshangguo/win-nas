'use strict';
const fs = require('fs');
const path = require('path');

// ---- 读取 .env（极简，不引第三方依赖） ----
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}
loadEnv();

// 取盘符（如 "D:\Share" -> "D"）
function getDrive(p) {
  const r = path.resolve(p);
  const idx = r.indexOf(':');
  return idx >= 0 ? r.slice(0, idx).toUpperCase() : '';
}

const SYSTEM_DRIVES = (process.env.SYSTEM_DRIVES || 'C')
  .split(/[;,]/).map(s => s.trim().toUpperCase()).filter(Boolean);

// ===== 应用数据目录：默认放在「项目安装目录」下，与盘符彻底解耦 =====
// 这样无论项目装在 C: 还是 D:，或电脑只有 C 盘，都能正常工作。
// 如需自定义（例如改到独立数据盘），在 .env 设置 DATA_DIR= 绝对路径即可覆盖。
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const dataDrive = getDrive(DATA_DIR);

// ===== 系统盘提示（不再阻断启动） =====
// 历史上曾强制禁止把应用数据写到系统盘，但这会导致“只有 C 盘的机器无法启动”。
// 现改为仅警告：若 DATA_DIR 落在系统盘，会打印提示（索引/缩略图可能占用系统盘空间），
// 但服务照常启动。如仍需严格拒绝，可在 .env 设置 ALLOW_DATA_ON_SYSTEM=0。
if (SYSTEM_DRIVES.includes(dataDrive) && process.env.ALLOW_DATA_ON_SYSTEM === '0') {
  console.error('[FATAL] DATA_DIR 位于系统盘 (' + dataDrive + '): ' + DATA_DIR);
  console.error('已设置 ALLOW_DATA_ON_SYSTEM=0 强制禁止在系统盘写入应用数据。');
  console.error('请将 DATA_DIR 指向非系统盘，或移除该限制。');
  process.exit(1);
}
if (SYSTEM_DRIVES.includes(dataDrive)) {
  console.warn('[WARN] DATA_DIR 位于系统盘 (' + dataDrive + '): ' + DATA_DIR);
  console.warn('      索引 / 缩略图 / 临时文件等会占用系统盘空间；生产环境建议改用独立数据盘（.env 设置 DATA_DIR=）。');
}

// ===== 多根目录（用户文件存放区，可多盘） =====
const ROOTS = {};
const rootsRaw = process.env.ROOTS || '';
for (const part of rootsRaw.split(/[;,]/)) {
  const m = part.match(/^\s*([^:]+):(.*)$/);
  if (m) ROOTS[m[1].trim()] = path.resolve(m[2].trim());
}

// 用户个人主目录基地：每个账号在此基地下拥有 <基地>\<用户名> 独立空间。
// 默认位于「项目安装目录」下的 home/（即 <项目>/home/<用户名>），与盘符彻底解耦，
// 单 C 盘机器也能用；可用 .env 的 USER_HOME_BASE= 覆盖到任意目录。
const USER_HOME_BASE = path.resolve(process.env.USER_HOME_BASE || path.join(__dirname, 'home'));
console.log('[CONFIG] 用户个人主目录基地 USER_HOME_BASE = ' + USER_HOME_BASE);

const PORT = parseInt(process.env.PORT || '8080', 10);

// 自动创建应用数据子目录（全部在 DATA_DIR 内，绝不落系统盘）
const SUBDIRS = ['uploads', 'thumbnails', 'index', 'tmp', 'db'];
for (const d of SUBDIRS) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}

// 用户文件根目录若不存在则创建（属于用户数据区，只要非系统盘即可）
for (const [k, v] of Object.entries(ROOTS)) {
  if (!fs.existsSync(v)) {
    try { fs.mkdirSync(v, { recursive: true }); } catch (e) { /* 运行时再报 */ }
  }
}

module.exports = { DATA_DIR, dataDrive, SYSTEM_DRIVES, ROOTS, PORT, SUBDIRS, getDrive, USER_HOME_BASE };
