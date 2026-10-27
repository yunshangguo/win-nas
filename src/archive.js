'use strict';
// 压缩 / 解压缩
//  - 非加密：archiver 写 + yauzl 读（流式，适合大文件）
//  - 加密（AES-256，archiver-zip-encrypted 写入）：用 Node 内置 crypto 自实现 WinZip-AES 读取
//    （yauzl 3.x 不再支持解密，故手写 PBKDF2 + AES-CTR + HMAC 校验）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const archiver = require('archiver');
const zipEncrypt = require('archiver-zip-encrypted');
archiver.registerFormat('zip-encrypted', zipEncrypt);
const yauzl = require('yauzl');

// items: [{ abs, entryName }]；写入 outPath（zip 文件）。password 可选 → AES-256 加密
function zipItems(items, outPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const useEnc = !!(opts.password && opts.password.length);
    const archive = archiver.create(useEnc ? 'zip-encrypted' : 'zip', {
      zlib: { level: opts.store ? 0 : 9 },
      ...(useEnc ? { encryptionMethod: 'aes256', password: opts.password } : {})
    });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.pipe(output);
    for (const it of items) {
      let st;
      try { st = fs.statSync(it.abs); } catch (e) { continue; }
      if (st.isDirectory()) archive.directory(it.abs, it.entryName);
      else archive.file(it.abs, { name: it.entryName });
    }
    archive.finalize();
  });
}

// 解压 abs 到 destDir；支持 .zip（含 AES 密码）/ .tar.gz / .tgz；password 错误时抛 "incorrect password"
function extractArchive(abs, destDir, opts = {}) {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return extractTar(abs, destDir);
  if (opts.password && opts.password.length) return extractAesArchive(abs, destDir, opts.password);
  return new Promise((resolve, reject) => {
    yauzl.open(abs, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      fs.mkdirSync(destDir, { recursive: true });
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(path.join(destDir, entry.fileName), { recursive: true });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const fp = path.join(destDir, entry.fileName);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          const ws = fs.createWriteStream(fp);
          stream.on('end', () => zip.readEntry());
          stream.on('error', reject);
          ws.on('error', reject);
          stream.pipe(ws);
        });
      });
      zip.on('end', () => resolve(true));
    });
  });
}

// 把文件夹打包成 zip 写入 outPath（用于“文件夹打包下载”，无加密，流式）
function zipFolder(folderAbs, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver.create('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(folderAbs, path.basename(folderAbs));
    archive.finalize();
  });
}

// ---- WinZip AES (AE-2) 读取 ----
// 从 central/local 的 extra 字段里找 0x9901 标记，取出真实压缩方法与强度
function parseAesExtra(raw) {
  if (!raw) return null;
  let o = 0;
  while (o + 4 <= raw.length) {
    const id = raw.readUInt16LE(o);
    const size = raw.readUInt16LE(o + 2);
    if (id === 0x9901) {
      const data = raw.slice(o + 4, o + 4 + size);
      if (data.length < 7) return null;
      const strength = data[4];           // 1→128(8B salt) 2→192(12B) 3→256(16B)
      const method = data.readUInt16LE(5); // 真实压缩方法：8=deflate 0=store
      return { strength, method };
    }
    o += 4 + size;
  }
  return null;
}

// AES-256-CTR 解密（与 archiver-zip-encrypted 完全对齐：counter 初值 01..00，小端进位）
function aesCtrDecrypt(ciphertext, aesKey) {
  const decipher = crypto.createCipheriv('aes-256-ecb', aesKey, null);
  decipher.setAutoPadding(false);
  const counter = Buffer.from('01000000000000000000000000000000', 'hex');
  const out = Buffer.alloc(ciphertext.length);
  for (let off = 0; off < ciphertext.length; off += 16) {
    const ks = decipher.update(counter); // ECB 加密 counter 得到 16B 密钥流
    const len = Math.min(16, ciphertext.length - off);
    for (let i = 0; i < len; i++) out[off + i] = ciphertext[off + i] ^ ks[i];
    // 小端进位（与 aes-js Counter.increment 一致）
    for (let i = 0; i < 16; i++) { if (++counter[i] === 0) continue; else break; }
  }
  return out;
}

// 解压单个 AES 条目到 fp；password 错误抛 "incorrect password"，完整性失败抛 "integrity check failed"
function extractAesEntry(abs, entry, fp, password) {
  return new Promise((resolve, reject) => {
    const aes = parseAesExtra(entry.extraFieldRaw);
    if (!aes) return reject(new Error('unsupported encryption (not WinZip-AES)'));
    const saltLen = aes.strength === 3 ? 16 : aes.strength === 2 ? 12 : 8;
    const overhead = saltLen + 2 + 10;                       // salt + 密码校验值 + HMAC 认证码
    const totalEnc = entry.compressedSize;                   // central 中的 compressedSize = 密文 + overhead
    const cipherLen = totalEnc - overhead;
    let fd;
    try { fd = fs.openSync(abs, 'r'); } catch (e) { return reject(e); }
    const lh = Buffer.alloc(30);
    try { fs.readSync(fd, lh, 0, 30, entry.relativeOffsetOfLocalHeader); }
    catch (e) { fs.closeSync(fd); return reject(e); }
    const fnLen = lh.readUInt16LE(26);
    const exLen = lh.readUInt16LE(28);
    const dataStart = entry.relativeOffsetOfLocalHeader + 30 + fnLen + exLen;
    const buf = Buffer.alloc(totalEnc);
    try { fs.readSync(fd, buf, 0, totalEnc, dataStart); }
    catch (e) { fs.closeSync(fd); return reject(e); }
    fs.closeSync(fd);

    const salt = buf.slice(0, saltLen);
    const pwdVerify = buf.slice(saltLen, saltLen + 2);
    const ciphertext = buf.slice(saltLen + 2, saltLen + 2 + cipherLen);
    const authCode = buf.slice(saltLen + 2 + cipherLen);

    const derived = crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), salt, 1000, 66, 'sha1');
    const aesKey = derived.slice(0, 32);
    const hmacKey = derived.slice(32, 64);
    const pwdVer = derived.slice(64, 66);
    if (!pwdVerify.equals(pwdVer)) return reject(new Error('incorrect password'));
    const mac = crypto.createHmac('sha1', hmacKey).update(ciphertext).digest().slice(0, 10);
    if (!mac.equals(authCode)) return reject(new Error('integrity check failed'));

    const dec = aesCtrDecrypt(ciphertext, aesKey);
    let plain;
    if (aes.method === 8) plain = zlib.inflateRawSync(dec);
    else if (aes.method === 0) plain = dec;
    else return reject(new Error('unsupported compression method: ' + aes.method));

    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, plain);
    resolve(true);
  });
}

// 解压整个 AES 加密 zip 到 destDir
function extractAesArchive(abs, destDir, password) {
  return new Promise((resolve, reject) => {
    yauzl.open(abs, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      fs.mkdirSync(destDir, { recursive: true });
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(path.join(destDir, entry.fileName), { recursive: true });
          return zip.readEntry();
        }
        const fp = path.join(destDir, entry.fileName);
        extractAesEntry(abs, entry, fp, password).then(() => zip.readEntry()).catch(reject);
      });
      zip.on('end', () => resolve(true));
    });
  });
}

// ---- 压缩包内容列表 / 单文件解压 / tar.gz 支持 ----

// 解析 tar（已解压为 buffer）条目；返回 { name, size, isDir, dataStart }
function parseTar(buf) {
  const entries = [];
  let off = 0;
  const n = buf.length;
  while (off + 512 <= n) {
    let name = '';
    for (let i = 0; i < 100 && buf[off + i] !== 0; i++) name += String.fromCharCode(buf[off + i]);
    if (!name) break; // 遇到全零块即结束
    const sizeStr = buf.toString('ascii', off + 124, off + 136).replace(/[^\0-7]/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(buf[off + 156] || 0);
    const isDir = typeFlag === '5' || name.endsWith('/');
    const dataStart = off + 512;
    entries.push({ name, size, isDir, dataStart });
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// 列出压缩包内容：zip 用 yauzl（含加密标记）；tar.gz 用 zlib + tar 解析；7z/rar 抛 UNSUPPORTED_FORMAT
function listArchive(abs) {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.zip')) return listZip(abs);
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return Promise.resolve(listTarGz(abs));
  const e = new Error('UNSUPPORTED_FORMAT');
  e.code = 'UNSUPPORTED_FORMAT';
  return Promise.reject(e);
}

function listZip(abs) {
  return new Promise((resolve, reject) => {
    yauzl.open(abs, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('error', reject);
      zip.readEntry();
      zip.on('entry', (entry) => {
        const isDir = /\/$/.test(entry.fileName);
        const aes = entry.extraFieldRaw ? parseAesExtra(entry.extraFieldRaw) : null;
        const encrypted = !!(aes || (entry.bitFlag & 1));
        entries.push({ name: entry.fileName, size: entry.uncompressedSize, isDir, encrypted });
        zip.readEntry();
      });
      zip.on('end', () => resolve({ format: 'zip', entries }));
    });
  });
}

function listTarGz(abs) {
  const buf = zlib.gunzipSync(fs.readFileSync(abs));
  const entries = parseTar(buf).map(e => ({ name: e.name, size: e.size, isDir: e.isDir, encrypted: false }));
  return { format: 'tar.gz', entries };
}

// 解压整个 tar.gz 到 destDir
function extractTar(abs, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(abs));
  const entries = parseTar(buf);
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    const fp = path.join(destDir, e.name);
    if (e.isDir) { fs.mkdirSync(fp, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, buf.slice(e.dataStart, e.dataStart + e.size));
  }
  return Promise.resolve(true);
}

// 解压单个条目（按 entryName）到 destDir；zip 支持 AES 密码，tar.gz 直接提取
function extractOne(abs, entryName, destDir, opts = {}) {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return extractOneTar(abs, entryName, destDir);
  return extractOneZip(abs, entryName, destDir, opts);
}

function extractOneZip(abs, entryName, destDir, opts) {
  return new Promise((resolve, reject) => {
    yauzl.open(abs, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      fs.mkdirSync(destDir, { recursive: true });
      let found = false;
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (found) return;
        if (entry.fileName !== entryName) return zip.readEntry();
        found = true;
        const fp = path.join(destDir, entry.fileName);
        const aes = entry.extraFieldRaw ? parseAesExtra(entry.extraFieldRaw) : null;
        if (aes) {
          extractAesEntry(abs, entry, fp, opts.password || '').then(() => { try { zip.close(); } catch (_) {} resolve(true); }).catch(reject);
        } else {
          zip.openReadStream(entry, (e2, stream) => {
            if (e2) { try { zip.close(); } catch (_) {} return reject(e2); }
            const ws = fs.createWriteStream(fp);
            stream.on('error', (e3) => { try { zip.close(); } catch (_) {} reject(e3); });
            ws.on('error', (e3) => { try { zip.close(); } catch (_) {} reject(e3); });
            ws.on('finish', () => { try { zip.close(); } catch (_) {} resolve(true); });
            stream.pipe(ws);
          });
        }
      });
      zip.on('end', () => { if (!found) reject(new Error('ENTRY_NOT_FOUND')); });
    });
  });
}

function extractOneTar(abs, entryName, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(abs));
  const e = parseTar(buf).find(x => x.name === entryName);
  if (!e || e.isDir) return Promise.reject(new Error('ENTRY_NOT_FOUND'));
  const fp = path.join(destDir, e.name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, buf.slice(e.dataStart, e.dataStart + e.size));
  return Promise.resolve(true);
}

module.exports = { zipItems, extractArchive, zipFolder, listArchive, extractOne, extractTar };
