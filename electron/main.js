'use strict';
// ============================================================================
// NasManager 桌面端入口（Electron）
// ----------------------------------------------------------------------------
// 设计要点：
//  - 后端 server.js 直接在本进程内 require 启动（无需额外的 node 子进程），
//    启动前通过环境变量注入端口 / 账户 / 数据目录等设置。
//  - 首次运行（无 settings.json）先只弹“设置”窗口，用户保存后才启动后端并进入主界面，无需重启。
//  - 运行中修改任意设置（端口 / 账户 / 密码 / 根目录 / 数据目录）一律“运行时热生效”，
//    进程不退出、窗口不关：端口热切换监听、账户密码即时更新、根目录原地替换、
//    数据目录在线迁移 + 各子系统重新挂载（auth/share/search/thumbnails/上传库），彻底免重启。
//  - 关闭后再打开：settings.json 已落盘，直接以保存的设置启动后端 + 主界面，仍是上次配置、直接可用。
//  - 唯一的“桌面窗口”即主窗口，加载 http://127.0.0.1:<port>/ （即 WebUI）；
//    另有独立“设置”窗口用于配置端口 / 账户 / 密码 / 数据目录 / 根目录。
// ============================================================================
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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
let backendModule = null; // 缓存 server.js 模块，供运行时热重载调用
function startBackend() {
  if (serverStarted) return;
  applyEnvFromSettings();
  try {
    backendModule = require(path.join(APP_DIR, 'server.js'));
    serverStarted = true;
    console.log('[NM] 后端已随桌面程序启动');
  } catch (e) {
    console.error('[NM] 启动后端失败:', (e && e.stack) || e);
    dialog.showErrorBox('NasManager 启动失败', String((e && e.message) || e));
  }
}

// 数据目录变更时，把旧目录下的全部内容递归拷贝到新目录。逐文件容错：个别被占用的文件
// （如进行中的上传临时文件、当前会话锁）跳过而不阻断整体迁移，避免新目录缺 users.json
// 而被迫重新播种、丢失账号。拷贝完成后由 server.setDataDir() 完成“重新挂载”，全程无需重启进程。
function copyTree(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name), d = path.join(dstDir, e.name);
    try {
      if (e.isDirectory()) copyTree(s, d);
      else fs.copyFileSync(s, d);
    } catch (err) { /* 个别被占用文件跳过，不阻断迁移 */ }
  }
}
function migrateDataDir(oldDir, newDir) {
  try { copyTree(oldDir, newDir); console.log('[NM] 已迁移数据目录内容: ' + oldDir + ' -> ' + newDir); }
  catch (e) { console.error('[NM] 数据目录迁移失败:', e.message); }
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
  // 改动前的数据目录（用于判断是否为结构性变更，需要重启）
  const prevDataDir = settings.dataDir;
  settings.port = parseInt(data.port, 10) || 8080;
  settings.authUsername = (data.authUsername || 'admin').trim() || 'admin';
  settings.dataDir = (data.dataDir || path.join(BASE, 'data')).trim();
  settings.roots = (data.roots || '').trim();
  persistSettings();
  const newPassword = (data.password && String(data.password).trim()) ? String(data.password).trim() : null;

  if (!serverStarted) {
    // 首次运行：后端尚未启动，直接以刚保存的设置启动后端并进入主界面——无需重启。
    // 新密码落一次性明文文件（password.plain），由 auth 模块在启动时哈希入库并删除。
    if (newPassword) writePendingPassword(newPassword);
    startBackend();
    createMainWindow();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return { ok: true, started: true };
  }

  // 运行中且数据目录未变更：热重载，进程不退出、窗口不关，立即生效。
  if (settings.dataDir === prevDataDir) {
    const res = backendModule.reconfigure({
      port: settings.port,
      roots: settings.roots,
      authUsername: settings.authUsername,
      password: newPassword // 直接交给 auth 模块更新哈希，不落明文文件
    });
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    // 端口变了则把主窗口重新加载到新端口（仅刷新页面，不重启进程）
    if (res && res.portChanged && mainWindow && !mainWindow.isDestroyed()) {
      waitServerThenLoad(mainWindow);
    }
    return { ok: true, applied: true, portChanged: !!(res && res.portChanged) };
  }

  // 数据目录变更：直接在线迁移 + 热切换，无需重启进程。
  // 先把旧目录的全部数据递归拷贝到新目录，再热切换各子系统（auth/share/search/thumbnails/tus 等），
  // 最后把本次保存的端口 / 账户 / 密码 / 根目录一并热应用，全程进程不退出、窗口不关。
  if (settings.dataDir !== prevDataDir) {
    migrateDataDir(prevDataDir, settings.dataDir);
    try { backendModule.setDataDir(settings.dataDir); } catch (e) { console.error('[NM] 数据目录热切换失败:', e.message); }
    try {
      backendModule.reconfigure({
        port: settings.port,
        roots: settings.roots,
        authUsername: settings.authUsername,
        password: newPassword
      });
    } catch (e) { console.error('[NM] 设置热应用失败:', e.message); }
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return { ok: true, applied: true, dataDirChanged: true };
  }
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.whenReady().then(() => {
  buildMenu();
  if (fs.existsSync(SETTINGS_PATH)) {
    // 已有设置：直接启动后端 + 主窗口
    startBackend();
    createMainWindow();
  } else {
    // 首次运行：先只弹设置窗口，等用户保存后才启动后端并进入主界面（无需重启）
    openSettings();
  }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  app.on('activate', () => {
    if (!mainWindow) { if (!fs.existsSync(SETTINGS_PATH)) openSettings(); else createMainWindow(); }
  });
});

app.on('window-all-closed', () => { app.quit(); });
