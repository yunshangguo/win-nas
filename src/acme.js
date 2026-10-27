'use strict';
// ============================================================================
//  Let's Encrypt / ACME 自动申请与续期（集成进 NasManager，无需独立部署）
// ----------------------------------------------------------------------------
//  使用 HTTP-01 挑战：在 ACME_HTTP_PORT（默认 80）上起一个极简 HTTP 服务器，
//  仅响应 /.well-known/acme-challenge/<token>；其余请求 301 跳转到 HTTPS。
//  证书私钥/链存放于 DATA_DIR/acme/，HTTPS 服务可直接 loadTls() 读取。
//  要求：本进程需对公网 80 端口可达（域名已 A/AAAA 解析到本机），且绑定 80/443
//  通常需要管理员/root 权限。
// ============================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const acme = require('acme-client');
const { DATA_DIR } = require('../config');

// 给 acme-client 内部复用的 axios 实例注入请求超时，避免网络不通时永久挂起。
// acme-client 自建 axios 实例且未设 timeout（默认 0 = 永不超时）；本文件与它的 http.js
// 解析到的是同一个 node_modules 实例，因此这里设置会直接生效于所有 ACME 请求。
try {
  const acmeAxios = require('acme-client/src/axios');
  acmeAxios.defaults.timeout = 20000;            // 单请求 20s 超时
  acmeAxios.defaults.timeoutErrorMessage = '连接 ACME 服务器超时（20s）';
} catch (e) {
  console.warn('[ACME] 无法为 acme-client 设置 axios 超时（不影响基本功能）: ' + e.message);
}

const ACME_DIR = path.join(DATA_DIR, 'acme');
const ACCOUNT_KEY = path.join(ACME_DIR, 'account.key');
const FULLCHAIN = path.join(ACME_DIR, 'fullchain.pem');
const PRIVKEY = path.join(ACME_DIR, 'privkey.pem');
const CHAIN = path.join(ACME_DIR, 'chain.pem');
const META = path.join(ACME_DIR, 'meta.json');

// token -> keyAuthorization（ACME HTTP-01 挑战响应）
const challengeStore = new Map();
let challengeServer = null;
let challengePort = 80;
let httpsPort = 443;
let httpsActive = false;
// 运行时状态（供前端轮询展示申请进度 / 结果）
let runtime = { state: 'idle', message: '', updatedAt: 0 };

function ensureDir() { try { fs.mkdirSync(ACME_DIR, { recursive: true }); } catch (e) {} }
function setRuntime(state, message) { runtime = { state, message: message || '', updatedAt: Date.now() }; }

// 启动 ACME HTTP-01 挑战服务器（仅响应挑战路径；其余 301 跳 HTTPS）。幂等。
function startChallengeServer(httpPort, httpsPortArg) {
  challengePort = httpPort || 80;
  httpsPort = (httpsPortArg == null ? 443 : httpsPortArg);
  if (challengeServer) return challengeServer;
  ensureDir();
  try {
    challengeServer = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      const m = url.match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9\-._~]+)$/);
      if (m) {
        const ka = challengeStore.get(m[1]);
        if (ka) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(ka); return; }
        res.writeHead(404); res.end('not found'); return;
      }
      if (httpsActive) {
        const host = req.headers.host ? String(req.headers.host).split(':')[0] : 'localhost';
        const loc = 'https://' + host + (httpsPort === 443 ? '' : ':' + httpsPort) + (req.url || '/');
        res.writeHead(301, { Location: loc }); res.end(); return;
      }
      res.writeHead(404); res.end('not found');
    });
    challengeServer.on('error', (e) => { console.error('[ACME] 挑战服务器错误: ' + e.message); });
    challengeServer.listen(challengePort, () => console.log('[ACME] HTTP-01 挑战服务器已启动，监听端口 ' + challengePort + '（仅响应 /.well-known/acme-challenge）'));
  } catch (e) {
    console.error('[ACME] 无法启动挑战服务器（端口 ' + challengePort + ' 可能被占用或需要管理员权限）: ' + e.message);
  }
  return challengeServer;
}

function setHttpsActive(v) { httpsActive = !!v; }

// 拆分 PEM 证书链为单个证书数组
function parsePemChain(pem) {
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  return pem.match(re) || [];
}

// 把 ACME / 网络错误翻译成对运维友好的中文说明，便于定位“卡在注册中”的真实原因
function describeAcmeError(e) {
  const m = (e && e.message) || String(e);
  const code = e && e.code;
  if (/timeout/i.test(m)) {
    return '连接 Let\'s Encrypt 超时：本机在限定时间内无法连通 LE 服务器。请排查：① Windows 防火墙 / 杀毒软件是否放行 node.exe 出站 443；② DNS 能否解析 acme-v02.api.letsencrypt.org（可改用公共 DNS 如 8.8.8.8）；③ 是否处于需代理的网络（公司 / 校园网需在启动前设置环境变量 HTTPS_PROXY / HTTP_PROXY）。';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|ENOTFOUND/i.test(m)) {
    return 'DNS 解析失败：无法解析 Let\'s Encrypt 域名，请检查 DNS 设置或改用公共 DNS（8.8.8.8 / 1.1.1.1）。';
  }
  if (code === 'ECONNREFUSED') {
    return '连接被拒绝（ECONNREFUSED）：目标不可达，可能是本地代理或防火墙拦截了到 LE 的出站连接。';
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return '网络连接中断 / 超时：到 Let\'s Encrypt 的链路不稳定或被中间设备丢弃，请检查出站网络。';
  }
  if (/proxy/i.test(m)) {
    return '代理相关错误：若网络需要代理，请在启动 NasManager 前设置环境变量 HTTPS_PROXY / HTTP_PROXY。';
  }
  return m;
}

// 申请（或续期）证书。domains: 字符串数组；email: 联系人；staging: 是否用测试环境。
async function requestCertificate(opts) {
  ensureDir();
  const domains = (opts.domains || []).filter(Boolean);
  const email = opts.email || '';
  const staging = !!opts.staging;
  if (!domains.length) { setRuntime('error', '未提供域名'); throw new Error('未提供域名'); }
  if (!email) { setRuntime('error', '未提供邮箱'); throw new Error('未提供邮箱'); }

  try {
    setRuntime('running', '正在连接 ACME 目录…');
    const directoryUrl = staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;

    let accountKey;
    if (fs.existsSync(ACCOUNT_KEY)) accountKey = fs.readFileSync(ACCOUNT_KEY, 'utf8');
    else accountKey = await acme.crypto.createPrivateKey();
    const client = new acme.Client({ directoryUrl, accountKey });

    setRuntime('running', '正在注册 / 获取 ACME 账户…');
    try {
      await client.createAccount({ termsOfServiceAgreed: true, contact: ['mailto:' + email] });
    } catch (e) {
      // 仅忽略“账户已存在”这类可继续的良性错误；网络 / 超时等真实错误必须抛出并上报，
      // 否则会像原来那样静默卡死在“注册中”
      if (!/already|exists|account/i.test(e.message || '')) {
        const msg = describeAcmeError(e);
        setRuntime('error', '注册 ACME 账户失败：' + msg);
        throw new Error(msg);
      }
    }
    if (!fs.existsSync(ACCOUNT_KEY)) fs.writeFileSync(ACCOUNT_KEY, accountKey);

    setRuntime('running', '正在生成 CSR 并提交订单…');
    const [key, csr] = await acme.crypto.createCsr({ commonName: domains[0], altNames: domains });

    setRuntime('running', '正在进行 HTTP-01 挑战（需域名解析到本机且公网 80 端口可达）…');
    const cert = await client.auto({
      csr,
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type === 'http-01') {
          challengeStore.set(challenge.token, keyAuthorization);
          if (!challengeServer) startChallengeServer(challengePort, httpsPort);
        }
      },
      challengeRemoveFn: async (authz, challenge) => {
        if (challenge.type === 'http-01') challengeStore.delete(challenge.token);
      }
    });

    setRuntime('running', '正在保存证书…');
    fs.writeFileSync(PRIVKEY, key);
    fs.writeFileSync(FULLCHAIN, cert);
    fs.writeFileSync(CHAIN, parsePemChain(cert).slice(1).join('\n') || '');
    fs.writeFileSync(META, JSON.stringify({ domains, email, staging, obtainedAt: Date.now() }, null, 2));

    setRuntime('success', '证书申请成功');
    return getStatus();
  } catch (e) {
    const msg = describeAcmeError(e);
    setRuntime('error', msg);
    console.error('[ACME] 证书申请失败: ' + msg);
    throw new Error(msg);
  }
}

// 解析已保存证书的基本信息（有效期 / 剩余天数 / SAN 域名 / 序列号）
function getCertInfo() {
  if (!fs.existsSync(FULLCHAIN) || !fs.existsSync(PRIVKEY)) return null;
  try {
    const full = fs.readFileSync(FULLCHAIN, 'utf8');
    const x = new crypto.X509Certificate(full);
    const san = x.subjectAltName || '';
    const domains = san.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^DNS:/i, ''));
    const nb = new Date(x.notBefore), na = new Date(x.notAfter);
    const daysLeft = Math.max(0, Math.ceil((na - Date.now()) / 86400000));
    return {
      domains, issuer: x.issuer, subject: x.subject,
      notBefore: nb.toISOString(), notAfter: na.toISOString(),
      serial: x.serialNumber, daysLeft
    };
  } catch (e) { return { error: e.message }; }
}

function getStatus() {
  const cert = getCertInfo();
  let meta = null;
  try { if (fs.existsSync(META)) meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch (e) {}
  return {
    hasCert: !!(cert && !cert.error),
    staging: !!(meta && meta.staging),
    cert,
    runtime,
    meta: meta ? { email: meta.email, obtainedAt: meta.obtainedAt } : null
  };
}

// 供 HTTPS 服务读取证书（无则返回 null）
function loadTls() {
  if (fs.existsSync(FULLCHAIN) && fs.existsSync(PRIVKEY)) {
    return { key: fs.readFileSync(PRIVKEY), cert: fs.readFileSync(FULLCHAIN) };
  }
  return null;
}

module.exports = {
  ACME_DIR, startChallengeServer, setHttpsActive, requestCertificate,
  getStatus, loadTls, setRuntime
};
