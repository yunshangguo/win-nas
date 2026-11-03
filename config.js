'use strict';
const fs = require('fs');
const path = require('path');

// pkg 单文件打包环境下，__dirname 指向只读虚拟快照（/snapshot/...），
// 不能作为“安装目录”写入数据；数据目录 / 用户主目录 / .env 必须落在 exe 实际所在目录。
// 故引入 BASE_DIR：pkg 用 process.execPath 所在目录，否则退回源码 __dirname。
const IS_PKG = (typeof process.pkg !== 'undefined');
// APP_BASE_DIR：Electron 桌面端等“打包后 __dirname 只读”场景下，用来把数据目录/配置落到可写位置。
// 未设置时回退到原逻辑（pkg 用 exe 目录，否则用源码目录）。
const BASE_DIR = process.env.APP_BASE_DIR || (IS_PKG ? path.dirname(process.execPath) : __dirname);

// ---- 读取 .env（极简，不引第三方依赖） ----
function loadEnv() {
  const envPath = path.join(BASE_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    if (IS_PKG) {
      // 打包环境首次运行：从内嵌样板 (.env.example) 复制出一份可编辑的 .env
      try {
        const tpl = path.join(__dirname, '.env.example');
        if (fs.existsSync(tpl)) fs.copyFileSync(tpl, envPath);
      } catch (e) { /* 样板缺失则使用纯内置默认 */ }
    }
  }
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
// 数据目录默认落在 BASE_DIR/data（BASE_DIR 在 Electron 下为可写基目录），与盘符彻底解耦。
// 应用数据目录：运行时可变。桌面端“设置”修改数据目录时，由 config.setDataDir() 在线切换（无需重启进程）。
let _dataDir = path.resolve(process.env.DATA_DIR || path.join(BASE_DIR, 'data'));
let dataDrive = getDrive(_dataDir); // 本地副本，供下方系统盘告警使用

// ===== 系统盘提示（不再阻断启动） =====
// 历史上曾强制禁止把应用数据写到系统盘，但这会导致“只有 C 盘的机器无法启动”。
// 现改为仅警告：若 DATA_DIR 落在系统盘，会打印提示（索引/缩略图可能占用系统盘空间），
// 但服务照常启动。如仍需严格拒绝，可在 .env 设置 ALLOW_DATA_ON_SYSTEM=0。
if (SYSTEM_DRIVES.includes(dataDrive) && process.env.ALLOW_DATA_ON_SYSTEM === '0') {
  console.error('[FATAL] DATA_DIR 位于系统盘 (' + dataDrive + '): ' + _dataDir);
  console.error('已设置 ALLOW_DATA_ON_SYSTEM=0 强制禁止在系统盘写入应用数据。');
  console.error('请将 DATA_DIR 指向非系统盘，或移除该限制。');
  process.exit(1);
}
if (SYSTEM_DRIVES.includes(dataDrive)) {
  console.warn('[WARN] DATA_DIR 位于系统盘 (' + dataDrive + '): ' + _dataDir);
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
const USER_HOME_BASE = path.resolve(process.env.USER_HOME_BASE || path.join(BASE_DIR, 'home'));
console.log('[CONFIG] 用户个人主目录基地 USER_HOME_BASE = ' + USER_HOME_BASE);

const PORT = parseInt(process.env.PORT || '8080', 10);

// 自动创建应用数据子目录（全部在 _dataDir 内，绝不落系统盘）
const SUBDIRS = ['uploads', 'thumbnails', 'index', 'tmp', 'db'];
function _ensureDataSubdirs(dir) {
  for (const d of SUBDIRS) { try { fs.mkdirSync(path.join(dir, d), { recursive: true }); } catch (e) {} }
}
_ensureDataSubdirs(_dataDir);

// 运行时热切换数据目录（Electron 桌面端“设置”保存数据目录变更时调用，无需重启进程）。
// 仅更新路径并新建子目录；旧目录下的数据由调用方负责迁移（拷贝）到新目录后再调用本函数。
function setDataDir(dir) {
  dir = path.resolve(dir || _dataDir);
  if (dir === _dataDir) return;
  _dataDir = dir;
  dataDrive = getDrive(_dataDir);
  _ensureDataSubdirs(_dataDir);
}

// 用户文件根目录若不存在则创建（属于用户数据区，只要非系统盘即可）
for (const [k, v] of Object.entries(ROOTS)) {
  if (!fs.existsSync(v)) {
    try { fs.mkdirSync(v, { recursive: true }); } catch (e) { /* 运行时再报 */ }
  }
}

// 运行时热更新根目录（Electron 桌面端“设置”保存后调用，无需重启进程）。
// ROOTS 是已导出的对象，这里原地清空再重新填充，使所有已捕获该引用的模块即时生效。
function setRoots(str) {
  for (const k of Object.keys(ROOTS)) delete ROOTS[k];
  const rootsRaw = str || '';
  for (const part of rootsRaw.split(/[;,]/)) {
    const m = part.match(/^\s*([^:]+):(.*)$/);
    if (m) ROOTS[m[1].trim()] = path.resolve(m[2].trim());
  }
  for (const [k, v] of Object.entries(ROOTS)) {
    if (!fs.existsSync(v)) { try { fs.mkdirSync(v, { recursive: true }); } catch (e) { /* 运行时再报 */ } }
  }
}

module.exports = { SYSTEM_DRIVES, ROOTS, PORT, SUBDIRS, getDrive, USER_HOME_BASE, setRoots, setDataDir };
// 数据目录 / 盘符 运行时可变：用 getter 暴露，保证外部（auth/search/thumbnails/server）读取即时生效
Object.defineProperty(module.exports, 'dataDir', { enumerable: true, get: () => _dataDir });
Object.defineProperty(module.exports, 'DATA_DIR', { enumerable: true, get: () => _dataDir });
Object.defineProperty(module.exports, 'dataDrive', { enumerable: true, get: () => dataDrive });
