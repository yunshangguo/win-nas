'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config');

const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
fs.mkdirSync(THUMB_DIR, { recursive: true });

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.m4v', '.webm', '.wmv', '.flv']);

// sharp 为可选原生依赖：装了就用，没装图像缩略图降级为“无缩略图”（不影响其他功能）
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

function extOf(p) { return path.extname(p).toLowerCase(); }

// 以 rootKey + 子路径 作为缓存键，保证同文件跨会话命中且不与系统盘耦合
function keyFor(rootKey, sub) {
  return crypto.createHash('sha1').update(rootKey + ':' + (sub || '')).digest('hex');
}
function thumbPath(rootKey, sub) {
  return path.join(THUMB_DIR, keyFor(rootKey, sub) + '.jpg');
}

// 调用系统 ffmpeg 抽取视频帧（ffmpeg 不存在则安静跳过）。
// 依次尝试多个时间点，只要取到一张“有效（非空、非极小）”的帧即采用，提升抽帧成功率、避免黑屏/空帧被当成损坏图标。
function extractVideoFrame(input, out) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const offsets = ['00:00:01', '00:00:03', '00:00:08', '00:00:00'];
    let idx = 0;
    const tryNext = () => {
      if (idx >= offsets.length) return resolve(false);
      const off = offsets[idx++];
      execFile('ffmpeg', ['-y', '-ss', off, '-i', input, '-vframes', '1',
        '-vf', 'scale=220:-1', '-q:v', '3', out],
        { windowsHide: true, timeout: 30000 }, (err) => {
          if (err) return tryNext();
          try {
            const st = fs.statSync(out);
            if (!st.size || st.size < 1024) return tryNext(); // 空帧 / 极小 → 换时间点再试
            resolve(true);
          } catch (e) { tryNext(); }
        });
    };
    tryNext();
  });
}

/**
 * 取缩略图（命中缓存直接返回，否则生成并缓存）
 * 返回 Promise<{status, contentType?, buffer?}>  status: ok|noengine|unsupported|error
 */
function getThumbnail(rootKey, sub, absPath) {
  return new Promise((resolve) => {
    const ext = extOf(absPath);
    const cache = thumbPath(rootKey, sub);
    if (fs.existsSync(cache)) {
      return resolve({ status: 'ok', contentType: 'image/jpeg', buffer: fs.readFileSync(cache) });
    }
    if (IMAGE_EXT.has(ext)) {
      if (!sharp) return resolve({ status: 'noengine' });
      sharp(absPath, { failOn: 'none' })
        .resize(220, 220, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
        .then((buf) => {
          try { fs.writeFileSync(cache, buf); } catch (e) { /* 缓存失败不致命 */ }
          resolve({ status: 'ok', contentType: 'image/jpeg', buffer: buf });
        })
        .catch((e) => resolve({ status: 'error', error: e.message }));
      return;
    }
    if (VIDEO_EXT.has(ext)) {
      extractVideoFrame(absPath, cache).then((ok) => {
        if (ok && fs.existsSync(cache)) {
          resolve({ status: 'ok', contentType: 'image/jpeg', buffer: fs.readFileSync(cache) });
        } else {
          resolve({ status: 'unsupported' });
        }
      });
      return;
    }
    resolve({ status: 'unsupported' });
  });
}

// 并发限制队列：大目录首次加载会并发请求大量缩略图，sharp/ffmpeg 同时跑会吃满 CPU/进程数。
// 这里把生成收敛到固定并发（默认 6），其余排队，避免“首屏卡死”且不影响已缓存命中（命中走内存，不进队列）。
const THUMB_MAX_CONCURRENT = 6;
let thumbActive = 0;
const thumbWaiting = [];
function runThumb(task) {
  return new Promise((resolve) => {
    const run = () => {
      thumbActive++;
      Promise.resolve().then(task).then(
        (v) => { thumbActive--; resolve(v); pump(); },
        (e) => { thumbActive--; resolve({ status: 'error', error: String(e) }); pump(); }
      );
    };
    const pump = () => { if (thumbWaiting.length && thumbActive < THUMB_MAX_CONCURRENT) { const w = thumbWaiting.shift(); w(); } };
    if (thumbActive < THUMB_MAX_CONCURRENT) run(); else thumbWaiting.push(run);
  });
}

// 对外暴露的取缩略图入口：先查缓存（命中直接返回，不入队），未命中才进并发队列生成。
function getThumbnailQueued(rootKey, sub, absPath) {
  const cache = thumbPath(rootKey, sub);
  if (fs.existsSync(cache)) {
    return Promise.resolve({ status: 'ok', contentType: 'image/jpeg', buffer: fs.readFileSync(cache) });
  }
  return runThumb(() => getThumbnail(rootKey, sub, absPath));
}

module.exports = { getThumbnail: getThumbnailQueued, getThumbnailRaw: getThumbnail, hasSharp: !!sharp, IMAGE_EXT, VIDEO_EXT };
