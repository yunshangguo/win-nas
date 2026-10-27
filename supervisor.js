'use strict';
// NasManager 守护进程：拉起 server.js，并在其退出或“假死”（能连 TCP 但不回 HTTP）时自动重启。
// 这样即便进程崩溃或被环境回收，文件管理器也能自愈，避免“网页/文件夹打不开”反复出现。
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SERVER = path.join(DIR, 'server.js');
const NODE = process.execPath; // 复用当前 node 二进制
const LOG = path.join(DIR, 'supervisor.log');

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  console.log(line);
}

// 单实例选举：用“协调端口 5001”的 OS 级互斥来选 leader，比 PID/文件锁在 Windows 上可靠得多。
// 避免 process.kill / tasklist 跨会话误判导致多个 supervisor 同时接管、互相 freePort5000 抢 5000 造成“假死/抖动”。
const COORD_PORT = 5001;
let leader = false;
const coord = net.createServer();
coord.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') { log('另一 supervisor 已占用协调端口 ' + COORD_PORT + '，本进程退出'); process.exit(0); }
  log('协调端口异常: ' + (err && err.message)); process.exit(1);
});
coord.listen(COORD_PORT, () => {
  leader = true;
  log('获得协调锁（端口 ' + COORD_PORT + '），成为 leader，开始管理 server');
  start();
  setInterval(healthCheck, 15000);
});

let child = null;
let restarting = false;
let failCount = 0;

// 释放 5000 端口上残留的（僵尸 / 上次未正常退出的）server 进程，避免新进程 EADDRINUSE
// 或健康检查命中已假死的旧进程而陷入“假死→重启→EADDRINUSE”死循环。
function freePort5000() {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 5000 });
    const pids = out.split('\n')
      .filter(l => /[:.]5000\s/.test(l) && /LISTENING/.test(l))
      .map(l => { const m = l.trim().split(/\s+/); return m[m.length - 1]; })
      .filter(Boolean);
    const uniq = [...new Set(pids)];
    for (const pid of uniq) {
      try {
        execSync('taskkill /PID ' + pid + ' /F /T', { timeout: 5000 });
        log('释放 5000 端口：已结束残留进程 PID ' + pid);
      } catch (e) { log('释放 5000 端口失败 PID ' + pid + ': ' + e.message); }
    }
  } catch (e) { log('释放 5000 端口出错: ' + e.message); }
}

function start() {
  if (restarting) return;
  restarting = true;
  freePort5000();
  // 等端口真正释放后再拉起，避免与尚未退出的旧进程抢端口
  setTimeout(() => {
    log('启动 server.js ...');
    child = spawn(NODE, [SERVER], { cwd: DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { try { fs.appendFileSync(path.join(DIR, 'nas.log'), d); } catch (e) {} });
    child.stderr.on('data', d => { try { fs.appendFileSync(path.join(DIR, 'nas.log'), d); } catch (e) {} });
    child.on('exit', (code, signal) => {
      log('server.js 退出 code=' + code + ' signal=' + signal);
      child = null;
      restarting = false;
      failCount = 0;
      setTimeout(start, 1000); // 退出即重启
    });
    child.on('error', e => log('spawn error: ' + e.message));
    restarting = false;
  }, 1000);
}

// 健康检查：只要 HTTP 层有响应（即使是 302/401 登录页）即视为存活；
// 只有“连不上 / 超时 / 连接被重置”才记为失败。/api/roots 需要登录会返回 401，属正常响应。
function healthCheck() {
  if (!child || child.killed) return;
  const req = http.get({ host: '127.0.0.1', port: 5000, path: '/', timeout: 4000 }, res => {
    // 收到任何状态码都说明服务在响应
    res.resume();
    failCount = 0;
  });
  req.on('timeout', () => { req.destroy(); onFail('TIMEOUT'); });
  req.on('error', e => onFail('ERR ' + e.message));
}
function onFail(reason) {
  failCount++;
  log('健康检查失败 (' + failCount + '): ' + reason);
  if (failCount >= 2) {
    log('疑似假死，强制重启 server.js');
    failCount = 0;
    try { if (child) child.kill('SIGKILL'); } catch (e) {}
  }
}

// 注意：start() 与健康巡检只在“成为 leader（成功绑定协调端口 5001）”后才启动，见上方 coord.listen 回调。
// 非 leader 的 supervisor 已在 coord 的 error 处理中直接退出，不会执行到这里。
log('supervisor 已就绪，等待协调端口选举结果');
