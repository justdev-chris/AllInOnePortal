// imageprobe.js
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  return false;
}

async function assertPublicHost(hostname) {
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addrs.length) throw new Error('dns: no addresses');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('dns: private address');
  }
}

function requestOnce(url, method, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('bad proto'));

    assertPublicHost(u.hostname).then(() => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'user-agent': 'chatroom-image-probe/1.0',
          'accept': 'image/*,*/*;q=0.1',
          ...(method === 'GET' ? { range: `bytes=0-${MAX_BYTES - 1}` } : {}),
        },
        timeout: TIMEOUT_MS,
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const next = new URL(res.headers.location, url).toString();
          return requestOnce(next, method, redirectsLeft - 1).then(resolve, reject);
        }
        resolve(res);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

async function probeImage(rawUrl) {
  const cached = cache.get(rawUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ok;

  let ok = false;
  try {
    let res = await requestOnce(rawUrl, 'HEAD', MAX_REDIRECTS);
    let ct = String(res.headers['content-type'] || '').toLowerCase();
    let len = Number(res.headers['content-length'] || 0);
    res.resume();

    if (!ct.startsWith('image/')) {
      res = await requestOnce(rawUrl, 'GET', MAX_REDIRECTS);
      ct = String(res.headers['content-type'] || '').toLowerCase();
      len = Number(res.headers['content-length'] || 0);
      res.resume();
    }

    if (ct.startsWith('image/') && !ct.includes('svg')) {
      if (len && len > MAX_BYTES) throw new Error('too big');
      ok = true;
    }
  } catch {
    ok = false;
  }

  cache.set(rawUrl, { ok, ts: Date.now() });
  return ok;
}

async function findImageUrl(text) {
  const matches = text.match(URL_RE);
  if (!matches) return null;
  for (const url of matches) {
    if (await probeImage(url)) return url;
  }
  return null;
}

module.exports = { findImageUrl, probeImage };
