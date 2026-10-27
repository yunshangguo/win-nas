'use strict';
// 后台任务中心：维护异步任务（上传 / 复制 / 移动 / 删除等），支持进度上报、查询、持久化。
// 任务记录落盘到 DATA_DIR/jobs.json，重启不丢失；超过 TTL（默认 7 天）自动清理；
// 也支持用户手动删除（removeJob）。
const fs = require('fs');
const path = require('path');
const { ROOTS, DATA_DIR } = require('../config');

const TTL_MS = 7 * 24 * 3600 * 1000; // 任务记录保留 7 天
const MAX_LIST = 500;                // 列表返回上限（足够覆盖 7 天历史）
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const PERSIST_DEBOUNCE = 400;

const jobs = new Map();
let persistTimer = null;
let persistPending = false;

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    for (const j of arr) {
      if (!j || !j.id) continue;
      if (now - (j.time || 0) > TTL_MS) continue; // 启动即清理过期
      jobs.set(j.id, j);
    }
  } catch (e) { /* 损坏则忽略，重新累积 */ }
}

function writeToDisk() {
  persistPending = false;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    ensureDataDir();
    const arr = Array.from(jobs.values());
    fs.writeFileSync(JOBS_FILE, JSON.stringify(arr), 'utf8');
  } catch (e) { /* 持久化失败不致命 */ }
}

function schedulePersist() {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; if (persistPending) writeToDisk(); }, PERSIST_DEBOUNCE);
}

// 立即落盘（用于完成 / 删除等关键节点，保证不丢）
function flushPersist() { writeToDisk(); }

function createJob(type, name, meta, extra) {
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = Object.assign({
    id, type, name, status: 'running', percent: 0,
    total: 0, done: 0, error: null, time: Date.now(), meta: meta || {}
  }, extra || {});
  jobs.set(id, job);
  schedulePersist();
  return job;
}

function updateProgress(id, done, total) {
  const j = jobs.get(id); if (!j) return;
  j.done = done; j.total = total;
  j.percent = total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : (j.percent || 0);
  schedulePersist();
}

function setProgress(id, percent) {
  const j = jobs.get(id); if (!j) return;
  j.percent = Math.max(0, Math.min(99, Math.floor(percent)));
  schedulePersist();
}

function finishJob(id, err) {
  const j = jobs.get(id); if (!j) return;
  if (err) { j.status = 'failed'; j.error = err.message || String(err); }
  else { j.status = 'done'; j.percent = 100; }
  j.doneTime = Date.now();
  flushPersist();
}

function getJob(id) { return jobs.get(id) || null; }

function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.time - a.time).slice(0, MAX_LIST);
}

function removeJob(id) {
  const had = jobs.delete(id);
  if (had) flushPersist();
  return had;
}

function cleanupExpired() {
  const now = Date.now();
  let changed = false;
  for (const [id, j] of jobs) {
    if (now - (j.time || 0) > TTL_MS) { jobs.delete(id); changed = true; }
  }
  if (changed) flushPersist();
  return changed;
}

function countItems(p) {
  let n = 0;
  (function walk(x) {
    let ents; try { ents = fs.readdirSync(x); } catch (e) { return; }
    for (const d of ents) {
      n++;
      const full = path.join(x, d);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) walk(full);
    }
  })(p);
  return n;
}

function moveItemSafe(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (e) {
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// 异步复制（带进度）。src 可以是文件或文件夹：
// - 文件：直接 copyFileSync（此前误走目录分支，mkdirSync(dest) 会把目标文件名建成同名空文件夹）
// - 文件夹：递归复制内容
function copyAsync(src, dest, jobId) {
  const run = () => {
    try {
      const st = fs.statSync(src);
      if (st.isFile()) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        updateProgress(jobId, 1, 1);
        finishJob(jobId);
        return;
      }
      const total = countItems(src) || 1;
      let done = 0;
      const step = (sp, dp) => {
        let ents; try { ents = fs.readdirSync(sp); } catch (e) { return; }
        fs.mkdirSync(dp, { recursive: true });
        for (const d of ents) {
          const s = path.join(sp, d), t = path.join(dp, d);
          let cst; try { cst = fs.statSync(s); } catch (e) { continue; }
          if (cst.isDirectory()) step(s, t);
          else { fs.copyFileSync(s, t); }
          done++; updateProgress(jobId, done, total);
        }
      };
      step(src, dest);
      finishJob(jobId);
    } catch (e) { finishJob(jobId, e); }
  };
  setImmediate(run);
}

// 异步移动（带进度）。src 可以是文件或文件夹：
// - 文件：直接 rename / 跨盘 cp+rm（此前误走目录分支：mkdirSync 把目标建成同名空文件夹后还把源文件删了）
// - 文件夹：优先整体 rename（同盘瞬间完成），失败再逐项移动
function moveAsync(src, dest, jobId) {
  const run = () => {
    try {
      const st = fs.statSync(src);
      if (st.isFile()) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        moveItemSafe(src, dest);
        updateProgress(jobId, 1, 1);
        finishJob(jobId);
        return;
      }
      // 文件夹：同盘（rename 可用）直接整体改名，避免逐项移动慢且误删
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
        updateProgress(jobId, 1, 1);
        finishJob(jobId);
        return;
      } catch (e) { /* 跨盘 rename 失败（EXDEV 等），走逐项移动 */ }
      const total = countItems(src) || 1;
      let done = 0;
      const step = (sp, dp) => {
        fs.mkdirSync(dp, { recursive: true });
        let ents; try { ents = fs.readdirSync(sp); } catch (e) { return; }
        for (const d of ents) {
          const s = path.join(sp, d), t = path.join(dp, d);
          let cst; try { cst = fs.statSync(s); } catch (e) { continue; }
          if (cst.isDirectory()) step(s, t);
          else { moveItemSafe(s, t); }
          done++; updateProgress(jobId, done, total);
        }
      };
      step(src, dest);
      // 删除已移动空的源目录
      try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) {}
      finishJob(jobId);
    } catch (e) { finishJob(jobId, e); }
  };
  setImmediate(run);
}

// 启动时加载持久化任务并清理过期，之后每小时巡检一次
loadFromDisk();
setInterval(cleanupExpired, 3600 * 1000);

module.exports = {
  createJob, updateProgress, setProgress, finishJob, getJob, listJobs,
  removeJob, cleanupExpired, copyAsync, moveAsync, TTL_MS
};
