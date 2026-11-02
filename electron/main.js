'use strict';
// ============================================================================
// NasManager 桌面端入口（Electron）
// ----------------------------------------------------------------------------
// 设计要点：
//  - 后端 server.js 直接在本进程内 require 启动（无需额外的 node 子进程），
//    启动前通过环境变量注入端口 / 账户 / 数据目录等设置。
//  - 设置变更（端口 / 账户 / 密码 / 数据目录 / 根目录）通过 app.relaunch()
//    重启整个应用来生效，简单且可靠。
//  - 唯一的“桌面窗口”即主窗口，加载 http://127.0.0.1:<port>/ （即 WebUI）；
//    另有独立“设置”窗口用于配置端口 / 账户 / 密码。
// ============================================================================
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
// 应用目录：开发态=项目根；打包态=app.asar 根（server.js / src / public 都在此）
const APP_DIR = app.getAppPath();

// ---- 可写基目录（存放 settings.json 与默认 data 目录） ----
function isWritable(dir) {
  try {
    const t = path.join(dir, '.nm_writable_test_' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(t, '1');
    fs.unlinkSync(t);
    return true;
  } catch (e) {
    return false;
  }
}
function resolveBaseDir() {
  if (isDev) return app.getAppPath(); // 开发态：项目根（data/ 与 settings.json 落在项目内）
  const exeDir = path.dirname(process.execPath);
  if (isWritable(exeDir)) return exeDir; // 便携版：exe 所在目录可写则用其同目录
  return app.getPath('userData');         // 否则落到用户数据目录（始终可写）
}
const BASE = resolveBaseDir();
const SETTINGS_PATH = path.join(BASE, 'settings.json');

// ---- 设置读写 ----
function loadSettings() {
  const def = { port: 8080, authUsername: 'admin', dataDir: path.join(BASE, 'data'), roots: '' };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return Object.assign(def, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
    }
  } catch (e) { /* 损坏则回落默认 */ }
  return def;
}
let settings = loadSettings();

function persistSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[NM] 保存设置失败:', e.message);
  }
}

// 在 require server.js 之前注入环境变量
function applyEnvFromSettings() {
  process.env.APP_BASE_DIR = BASE;
  process.env.DATA_DIR = settings.dataDir || path.join(BASE, 'data');
  process.env.PORT = String(settings.port || 8080);
  if (settings.authUsername) process.env.AUTH_USERNAME = String(settings.authUsername);
  if (settings.roots) process.env.ROOTS = String(settings.roots);
}

// 若本次保存带了新密码，立即写入一次性明文文件，由 auth 模块在下次启动时哈希入库并删除
function writePendingPassword(pwd) {
  if (!pwd) return;
  pwd = String(pwd).trim();
  if (!pwd) return;
  const SECRET_DIR = path.join(settings.dataDir || path.join(BASE, 'data'), 'secrets');
  fs.mkdirSync(SECRET_DIR, { recursive: true });
  fs.writeFileSync(path.join(SECRET_DIR, 'password.plain'), pwd);
}

// ---- 启动后端（主进程内 require server.js） ----
let serverStarted = false;
function startBackend() {
  if (serverStarted) return;
  applyEnvFromSettings();
  try {
    require(path.join(APP_DIR, 'server.js'));
    serverStarted = true;
    console.log('[NM] 后端已随桌面程序启动');
  } catch (e) {
    console.error('[NM] 启动后端失败:', (e && e.stack) || e);
    dialog.showErrorBox('NasManager 启动失败', String((e && e.message) || e));
  }
}

// ---- 窗口 ----
let mainWindow = null;
let settingsWindow = null;

// 轮询后端就绪后再加载 WebUI，避免白屏
function waitServerThenLoad(win) {
  const port = settings.port || 8080;
  const url = 'http://127.0.0.1:' + port + '/';
  let attempt = 0;
  const tryLoad = () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.destroy();
      if (win && !win.isDestroyed()) win.loadURL(url);
    });
    req.on('error', () => {
      if (attempt < 80) { attempt++; setTimeout(tryLoad, 500); }
      else if (win && !win.isDestroyed()) {
        win.loadURL('data:text/html,<meta charset=utf-8><h2 style="font-family:sans-serif;padding:24px">' +
          '服务启动失败，请检查“设置”中的端口是否被占用，或数据目录是否可写。</h2>');
      }
    });
    req.on('timeout', () => {
      req.destroy();
      if (attempt < 80) { attempt++; setTimeout(tryLoad, 500); }
      else if (win && !win.isDestroyed()) {
        win.loadURL('data:text/html,<meta charset=utf-8><h2 style="font-family:sans-serif;padding:24px">服务启动超时，请检查设置。</h2>');
      }
    });
  };
  tryLoad();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    title: 'NasManager', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  waitServerThenLoad(mainWindow);
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 480, height: 580, resizable: false, title: 'NasManager 设置',
    parent: mainWindow || undefined, modal: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---- IPC ----
ipcMain.handle('get-settings', () => ({
  port: settings.port,
  authUsername: settings.authUsername,
  dataDir: settings.dataDir,
  roots: settings.roots
}));

ipcMain.handle('save-settings', (e, data) => {
  settings.port = parseInt(data.port, 10) || 8080;
  settings.authUsername = (data.authUsername || 'admin').trim() || 'admin';
  settings.dataDir = (data.dataDir || path.join(BASE, 'data')).trim();
  settings.roots = (data.roots || '').trim();
  persistSettings();
  // 新密码必须立即落盘为一次性明文文件（password.plain），由 auth 模块在“下次启动”时哈希入库并删除。
  // 注意：必须在重启“之前”写盘——startBackend() 在应用启动时已运行，重启后才是全新进程去读它。
  if (data.password && String(data.password).trim()) writePendingPassword(String(data.password).trim());
  // 端口 / 账户 / 密码 / 数据目录变更需要重启后端：重启整个应用以重新加载 server.js。
  // 用 Electron 官方 app.relaunch() 重启——它会“在旧实例完全退出后，用正确的启动命令拉起新实例”，
  // 因此：① 避开了便携版单文件下 process.execPath 指向临时解压目录、spawn 出来静默失败的问题；
  // ② 新实例在旧实例释放单实例锁之后才启动，从根上消除了“关掉却不重启”的竞态。
  // 仍带 --relaunch 标记作为兜底：万一新实例在锁释放前抢跑，也不会因拿不到锁而自杀。
  setTimeout(() => {
    const args = process.argv.slice(1).filter(a => a !== '--relaunch').concat(['--relaunch']);
    app.relaunch({ args });
    app.exit(0);
  }, 200);
  return { ok: true, restarting: true };
});

// ---- 菜单（替代托盘，避免缺图标崩溃） ----
// Windows 上模板第一项会被当作应用菜单名，必须是带子菜单的结构。
function buildMenu() {
  const template = [
    {
      label: 'NasManager',
      submenu: [
        { label: '设置', click: () => openSettings() },
        { label: '重新加载界面', click: () => { if (mainWindow && !mainWindow.isDestroyed()) waitServerThenLoad(mainWindow); } },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- 单实例 ----
// 普通双击启动若已有实例则退出（避免重复开窗口）。
// 但“设置后重启”(app.relaunch) 会带 --relaunch 标记：此时旧实例尚未释放锁，新实例若直接
// 退出会导致“关掉却不重启”。因此 --relaunch 时放行，由旧实例退出后新实例正常接管。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !process.argv.includes('--relaunch')) { app.quit(); }

app.whenReady().then(() => {
  buildMenu();
  startBackend();
  createMainWindow();
  // 首次运行（无设置文件）自动弹出设置，方便配置端口 / 账户 / 密码
  if (!fs.existsSync(SETTINGS_PATH)) setTimeout(openSettings, 1200);
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  app.on('activate', () => { if (!mainWindow) createMainWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
