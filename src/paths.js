'use strict';
const path = require('path');
const { ROOTS, getDrive, SYSTEM_DRIVES, USER_HOME_BASE } = require('../config');
const userCtx = require('./userctx');

// 特殊根：代表“此电脑 / 全部磁盘”，其下一级为各分区（盘符），再下一级才是文件
const COMPUTER_ROOT = '__computer__';
// 哨兵：resolveWithin 在“此电脑”顶级（无子路径）时返回，调用方据此列出全部磁盘
const COMPUTER_SENTINEL = '__COMPUTER__';
// 特殊根：代表“个人主目录”——每个账号独立拥有的 D:\<用户名> 空间（仅本人可访问）
const HOME_ROOT = '__home__';

function isDriveKey(k) {
  return /^[A-Za-z]$/.test(String(k || '').trim());
}

// 取某用户的个人主目录绝对路径（<USER_HOME_BASE>\<用户名>）。user 可为用户记录或用户名字符串。
function homePathFor(user) {
  let name = user;
  if (user && typeof user === 'object') name = user.username;
  name = String(name || '').trim();
  if (!name) return null;
  return path.join(USER_HOME_BASE, name);
}

// 解析 rootKey + 子路径，防 ../ 越界。
// - 普通根：相对 ROOTS[rootKey] 解析，禁止越出该根。
// - 计算机根：sub 首段为盘符（如 'C' 或 'C:'），解析并锁定在该盘内；sub 为空 = 列出全部磁盘（返回哨兵）。
// - 个人根：解析到“当前用户”的 D:\<用户名>；user 可显式传入，否则从请求上下文（userCtx）取。
function resolveWithin(rootKey, sub, user) {
  if (rootKey === COMPUTER_ROOT) {
    const s = (sub || '').replace(/^\/+/, '').replace(/\\/g, '/');
    if (!s) return COMPUTER_SENTINEL; // 顶级：列出全部磁盘
    const m = s.match(/^([A-Za-z]):?([\/\\]?[\s\S]*)$/);
    if (!m) return null;
    const drive = m[1].toUpperCase();
    if (!/^[A-Z]$/.test(drive)) return null;
    const rest = (m[2] || '').replace(/^\/+/, '').replace(/\\/g, '/');
    const driveRoot = drive + ':\\';
    const target = path.resolve(driveRoot, rest || '.');
    // 锁定在当前盘：必须以该盘根为前缀，且其后不得再出现其它盘符
    // （防 'C:\D:\x' 之类畸形路径逃逸到其它盘或越过盘根）
    if (target !== driveRoot && !target.startsWith(driveRoot)) return null;
    if (/[A-Za-z]:/.test(target.slice(driveRoot.length))) return null;
    return target;
  }
  if (rootKey === HOME_ROOT) {
    const u = user || userCtx.getStore();
    const home = homePathFor(u);
    if (!home) return null;
    const target = path.resolve(home, sub || '.');
    const rel = path.relative(home, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 越出个人主目录
    return target;
  }
  const root = ROOTS[rootKey];
  if (!root) return null;
  const target = path.resolve(root, sub || '.');
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 越出根目录
  return target;
}

// 是否位于系统盘
function isSystemDrive(p) {
  return SYSTEM_DRIVES.includes(getDrive(p));
}

// 是否“系统盘根目录本身”（如 C:\ 或 C:）。仅用于上传兜底拦截：
// 禁止直接把文件写到系统盘根（避免污染 C:\），但允许写到其下任意子目录（含个人主目录）。
function isSystemDriveRoot(p) {
  if (!p) return false;
  const drive = getDrive(p);
  if (!SYSTEM_DRIVES.includes(drive)) return false;
  // 形如 "C" 或 "C:"（仅盘符，无路径）直接视为系统盘根目录本身
  if (/^[A-Za-z]:?$/.test(String(p))) return true;
  const resolved = path.resolve(p).toUpperCase();
  const rootA = (drive + ':\\').toUpperCase();
  return resolved === rootA;
}

// 是否触发“系统盘二次确认”：落在系统盘且请求未带确认标志
function needSystemConfirm(absPath, req) {
  if (!isSystemDrive(absPath)) return false;
  // 个人主目录是应用托管的用户专属空间（<USER_HOME_BASE>\<用户>），即便位于系统盘也免二次确认，
  // 否则“只有 C 盘”的机器访问自己的文件也要反复弹确认框，无法正常使用。
  if (USER_HOME_BASE && absPath &&
      path.resolve(absPath).toLowerCase().startsWith(path.resolve(USER_HOME_BASE).toLowerCase() + path.sep)) {
    return false;
  }
  const q = (req.query && req.query.confirmSystemDrive) || (req.body && req.body.confirmSystemDrive);
  return q !== '1' && q !== 1 && q !== true;
}

// 取文件名（防注入）
function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

module.exports = { resolveWithin, isSystemDrive, isSystemDriveRoot, getDrive, needSystemConfirm, safeName, COMPUTER_ROOT, COMPUTER_SENTINEL, HOME_ROOT, homePathFor };
