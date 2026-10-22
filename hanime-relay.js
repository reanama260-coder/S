'use strict';
/*
 * Hanime relay (v2.5.13)
 *
 * Kenapa ada: URL media Hanime.red di-resolve oleh SERVER addon (dengan PoW, cookie, header
 * Referer/Origin), tapi diputar oleh PLAYER di HP/PC/TV, yang IP-nya beda dan tidak ikut
 * membawa cookie/header itu. Kalau CDN mengikat token ke IP/cookie/header, hasilnya:
 * segmen ditolak atau sangat lambat -> buffering terus.
 *
 * Relay ini membuat SERVER yang mengambil media dengan identitas yang sama dengan saat resolve,
 * lalu mengalirkannya ke player (mendukung Range untuk MP4, dan menulis ulang playlist HLS
 * supaya semua segmen/key juga lewat relay). Hanya Node core modules, tanpa dependency.
 */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const crypto = require('node:crypto');

const PREFIX = '/hr/';
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 20000;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true;
    if (l.startsWith('::ffff:')) { const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); return m ? isPrivateIp(m[1]) : true; }
    return false;
  }
  return true;
}

// Blok DNS yang mengarah ke alamat privat (SSRF), dicek saat koneksi sebenarnya.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some(item => isPrivateIp(item.address))) return cb(Object.assign(new Error('blocked address'), { status: 403 }));
    return cb(null, address, family);
  });
}

function createRelay(opts = {}) {
  const publicUrl = String(opts.publicUrl || '').replace(/\/+$/, '');
  const secret = String(opts.secret || '') || crypto.randomBytes(32).toString('hex');
  const ttlMs = Number(opts.ttlMs) || 6 * 3600 * 1000;
  const allowPrivate = Boolean(opts.allowPrivate); // hanya untuk test lokal
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 48 });
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 48 });

  const relay = { enabled: Boolean(publicUrl), attached: false, PREFIX };

  const sign = payload => crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);

  function makeUrl(upstream, headers, { name = 'media', playlist = false } = {}) {
    const payload = Buffer.from(JSON.stringify({ u: upstream, h: headers || {}, p: playlist ? 1 : 0, e: Date.now() + ttlMs })).toString('base64url');
    let ext = '';
    try { const m = /\.(m3u8|mp4|m4v|webm|ts|m4s|aac|vtt|key|mpd)$/i.exec(new URL(upstream).pathname); ext = m ? m[0].toLowerCase() : ''; } catch { /* no extension */ }
    if (playlist && ext !== '.m3u8') ext = '.m3u8';
    return `${publicUrl}${PREFIX}${sign(payload)}.${payload}/${name}${ext}`;
  }

  function parseToken(pathname) {
    const seg = pathname.slice(PREFIX.length).split('/')[0] || '';
    const dot = seg.indexOf('.');
    if (dot < 1) return null;
    const sig = seg.slice(0, dot);
    const payload = seg.slice(dot + 1);
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data || typeof data.u !== 'string' || (data.e && data.e < Date.now())) return null;
      return data;
    } catch { return null; }
  }

  function openUpstream(rawUrl, headers, hop = 0) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(rawUrl); } catch { return reject(Object.assign(new Error('bad url'), { status: 400 })); }
      if (!/^https?:$/.test(u.protocol)) return reject(Object.assign(new Error('bad protocol'), { status: 400 }));
      const bare = u.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivate && net.isIP(bare) && isPrivateIp(bare)) return reject(Object.assign(new Error('blocked address'), { status: 403 }));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method: 'GET', headers, timeout: UPSTREAM_TIMEOUT_MS,
        agent: u.protocol === 'https:' ? httpsAgent : httpAgent,
        ...(allowPrivate ? {} : { lookup: safeLookup }),
      }, res => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (hop >= MAX_REDIRECTS) return reject(Object.assign(new Error('too many redirects'), { status: 502 }));
          let next;
          try { next = new URL(res.headers.location, u); } catch { return reject(Object.assign(new Error('bad redirect'), { status: 502 })); }
          const nextHeaders = { ...headers };
          if (next.host !== u.host) delete nextHeaders.Cookie; // jangan bocorkan cookie lintas host
          return resolve(openUpstream(next.href, nextHeaders, hop + 1));
        }
        resolve({ res, url: u.href });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('upstream timeout'), { status: 504 })));
      req.on('error', err => reject(err));
      req.end();
    });
  }

  function readBody(stream, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { stream.destroy(); return reject(Object.assign(new Error('playlist too large'), { status: 502 })); }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  // Tulis ulang playlist HLS: setiap segmen/key/map/playlist anak lewat relay lagi.
  function rewritePlaylist(text, baseUrl, headers) {
    const child = (value, isPlaylist, name) => {
      // URL absolut dipertahankan persis (jangan dinormalisasi: bisa mengandung tanda tangan).
      const absolute = /^https?:\/\//i.test(value) ? value : new URL(value, baseUrl).href;
      return makeUrl(absolute, headers, { name, playlist: isPlaylist });
    };
    let nextIsVariant = false;
    return text.split(/\r?\n/).map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        const variantTag = /^#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF)/i.test(t);
        const mediaTag = /^#EXT-X-MEDIA:/i.test(t);
        if (/^#EXT-X-STREAM-INF/i.test(t)) nextIsVariant = true;
        return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
          if (!uri || /^data:/i.test(uri)) return whole;
          try { return `URI="${child(uri, variantTag || mediaTag, variantTag || mediaTag ? 'variant' : 'key')}"`; } catch { return whole; }
        });
      }
      const isVariant = nextIsVariant;
      nextIsVariant = false;
      try { return child(t, isVariant, isVariant ? 'variant' : 'seg'); } catch { return line; }
    }).join('\n');
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  }
  function fail(res, status, message) {
    if (res.headersSent) { res.destroy(); return; }
    cors(res);
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  }

  async function handle(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
    const pathname = String(req.url || '').split('?')[0];
    const data = parseToken(pathname);
    if (!data) return fail(res, 403, 'invalid or expired relay token');

    const headers = { 'Accept': '*/*', 'Accept-Encoding': 'identity', ...data.h };
    if (req.headers.range) headers.Range = req.headers.range;

    let upstream;
    try { upstream = await openUpstream(data.u, headers); } catch (error) {
      log(`[relay] upstream connect failed host=${hostOf(data.u)} (${error.code || error.message})`);
      return fail(res, error.status || 502, 'upstream unreachable');
    }
    const { res: up, url: finalUrl } = upstream;
    const code = up.statusCode || 502;
    const contentType = String(up.headers['content-type'] || '');
    let finalPath = '';
    try { finalPath = new URL(finalUrl).pathname; } catch { /* ignore */ }
    const isPlaylist = Boolean(data.p) || /\.m3u8$/i.test(finalPath) || /mpegurl/i.test(contentType);

    if (code >= 400) {
      log(`[relay] upstream HTTP ${code} host=${hostOf(finalUrl)} path=${finalPath.slice(0, 60)}`);
      up.resume();
      return fail(res, code, `upstream HTTP ${code}`);
    }
    req.on('close', () => { if (!up.destroyed) up.destroy(); });

    try {
      if (isPlaylist && code < 300) {
        const body = await readBody(up, MAX_PLAYLIST_BYTES);
        if (!/^\s*#EXTM3U/.test(body)) {
          log(`[relay] expected playlist but got non-HLS body host=${hostOf(finalUrl)} type=${contentType}`);
        }
        const rewritten = rewritePlaylist(body, finalUrl, data.h || {});
        const buf = Buffer.from(rewritten, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', buf.length);
        if (req.method === 'HEAD') return res.end();
        return res.end(buf);
      }
      res.statusCode = code;
      for (const name of PASS_HEADERS) if (up.headers[name]) res.setHeader(name, up.headers[name]);
      if (req.method === 'HEAD') { up.destroy(); return res.end(); }
      up.on('error', () => res.destroy());
      return up.pipe(res);
    } catch (error) {
      log(`[relay] stream failed host=${hostOf(finalUrl)} (${error.code || error.message})`);
      return fail(res, error.status || 502, 'relay error');
    }
  }

  function hostOf(value) { try { return new URL(value).host; } catch { return '?'; } }

  // Ubah stream Hanime (url + proxyHeaders) menjadi URL relay bersih tanpa header khusus.
  relay.wrapStream = function wrapStream(stream) {
    if (!relay.enabled || !relay.attached || !stream || !stream.url) return stream;
    let pathname = '';
    try { pathname = new URL(stream.url).pathname; } catch { return stream; }
    const isHls = /\.m3u8$/i.test(pathname);
    const headers = { ...(stream.behaviorHints?.proxyHeaders?.request || {}) };
    if (!headers['User-Agent']) headers['User-Agent'] = opts.userAgent || 'Mozilla/5.0';
    const behaviorHints = { ...(stream.behaviorHints || {}) };
    delete behaviorHints.proxyHeaders;
    behaviorHints.notWebReady = false; // URL https publik biasa; tidak perlu lewat proxy/transcode Stremio server
    return { ...stream, url: makeUrl(stream.url, headers, { name: isHls ? 'master' : 'video', playlist: isHls }), behaviorHints };
  };

  relay.matches = url => String(url || '').startsWith(PREFIX);
  relay.handle = handle;
  relay.makeUrl = makeUrl;

  // Pasang ke http.Server yang sudah ada (mis. hasil serveHTTP) tanpa mengganggu route SDK.
  relay.attach = function attach(server) {
    if (!server || typeof server.listeners !== 'function' || relay.attached) return false;
    const original = server.listeners('request');
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (relay.matches(req.url)) {
        handle(req, res).catch(error => { log(`[relay] unexpected ${error.message}`); fail(res, 500, 'relay error'); });
        return;
      }
      for (const listener of original) listener.call(server, req, res);
    });
    relay.attached = true;
    return true;
  };

  return relay;
}

module.exports = { createRelay, isPrivateIp };
