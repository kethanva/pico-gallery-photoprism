#!/usr/bin/env node
//
// photoprism-host — serve the lightweight frame (frame/) and reverse-proxy
// PhotoPrism /api/v1 to a real backend (read-only GET/HEAD/OPTIONS).
//
// Backend resolution: CLI arg > PICO_PP_BACKEND > frame/config.json serverUrl.

import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactPhoto } from './frame-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FRAME = join(ROOT, 'frame');
const FRAME_CONFIG_FILE = join(FRAME, 'config.json');
const PLAYLIST_TTL_MS = 15 * 60 * 1000;

const PORT = Number(process.env.PICO_PP_PORT || 8190);

// ── Read-only enforcement ────────────────────────────────────────────────────
// The appliance is a *display*. The proxy signs every request with an admin
// session token, so without this gate anyone who can reach :8190 could delete or
// edit photos. Default ON; set PICO_PP_READONLY=0 only for a trusted manage box.
const READ_ONLY = process.env.PICO_PP_READONLY !== '0';

// Hard boundary: only side-effect-free HTTP methods may cross the proxy.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ── Resolve backend URL ──────────────────────────────────────────────────────
function readFrameConfig() {
  try {
    return JSON.parse(readFileSync(FRAME_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const frameConfig = readFrameConfig();
const backendRaw =
  process.argv[2] || process.env.PICO_PP_BACKEND || frameConfig.serverUrl || '';

if (!existsSync(FRAME)) {
  console.error(`ERROR: ${FRAME} not found.`);
  
  process.exit(1);
}
if (!backendRaw) {
  console.error('ERROR: no backend URL. Pass one as an argument:');
  console.error('  ./run.sh photoprism http://192.168.68.71:8188');
  process.exit(1);
}

const backend = new URL(backendRaw.replace(/\/+$/, ''));
const backendAgent = backend.protocol === 'https:' ? https : http;
// PhotoPrism instances on a LAN often use self-signed certs.
const rejectUnauthorized = frameConfig.ignoreCertificateErrors !== true;

// Re-use TCP connections to PhotoPrism (Keep-Alive). Saves per-request TCP setup
// on the Pi CPU; TLS handshakes only when the backend URL uses https:.
const keepAliveAgent = backend.protocol === 'https:'
  ? new https.Agent({
      keepAlive: true,
      maxSockets: 4,
      maxFreeSockets: 2,
      rejectUnauthorized,
    })
  : new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });

let ppUser = '';
let ppPass = '';
let slideDurationSecs = 10;
try {
  const configPath = process.env.PICO_CONFIG || '/etc/picogallery/config.toml';
  const toml = readFileSync(configPath, 'utf8');
  const userMatch = toml.match(/username\s*=\s*"([^"]+)"/);
  const passMatch = toml.match(/password\s*=\s*"([^"]+)"/);
  if (userMatch) ppUser = userMatch[1];
  if (passMatch) ppPass = passMatch[1];

  const durationMatch = toml.match(/slide_duration_secs\s*=\s*([0-9]+)/);
  if (durationMatch) {
    slideDurationSecs = parseInt(durationMatch[1], 10);
  }
} catch {
  // Ignore missing config
}

let activeSessionId = null;
let isFetchingSession = false;
let sessionFetchQueue = [];

function fetchSession() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ username: ppUser, password: ppPass });
    const req = backendAgent.request(new URL('/api/v1/session', backend), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Host': backend.host
      },
      agent: keepAliveAgent,
      rejectUnauthorized
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(body);
            resolve(data.id);
          } catch(e) { reject(e); }
        } else {
          reject(new Error(`Failed to login: ${res.statusCode} ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function getSessionId() {
  if (!ppUser || !ppPass) return null;
  if (activeSessionId) return activeSessionId;
  
  if (isFetchingSession) {
    return new Promise(resolve => sessionFetchQueue.push(resolve));
  }
  isFetchingSession = true;
  
  try {
    console.log('[proxy] authenticating as', ppUser, '...');
    const id = await fetchSession();
    activeSessionId = id;
    sessionFetchQueue.forEach(resolve => resolve(id));
    return id;
  } catch (e) {
    console.error('[proxy] autologin failed:', e.message);
    sessionFetchQueue.forEach(resolve => resolve(null));
    return null;
  } finally {
    isFetchingSession = false;
    sessionFetchQueue = [];
  }
}

// ── Static MIME types ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const servedConfig = JSON.stringify({
  ...frameConfig,
  serverUrl: '',
  slideDuration: slideDurationSecs,
  kioskConfig: { slideDuration: slideDurationSecs },
});

let playlistCache = { at: 0, body: '' };

// Flips on the first successful backend round-trip. /api/v1/ready reports it so
// the kiosk launcher can hold Cog until photos can actually be served — on a
// cold boot the Pi's Wi-Fi (and thus the backend) comes up AFTER this host.
let backendSeen = false;

function backendGet(pathname, sessionId) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, backend);
    const headers = { host: backend.host, accept: 'application/json' };
    if (sessionId) headers['x-auth-token'] = sessionId;
    const req = backendAgent.request(
      target,
      { method: 'GET', headers, rejectUnauthorized, agent: keepAliveAgent },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) activeSessionId = null;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GET ${pathname} → HTTP ${res.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('ETIMEDOUT')));
    req.end();
  });
}

function photosFromPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.photos)) return data.photos;
  return [];
}

async function buildPlaylistBody() {
  const sessionId = await getSessionId();
  const out = [];
  let offset = 0;
  const pageSize = 1000;
  for (;;) {
    const q = `/api/v1/photos?count=${pageSize}&offset=${offset}&merged=true`;
    const data = await backendGet(q, sessionId);
    const page = photosFromPayload(data);
    for (const photo of page) {
      const compact = compactPhoto(photo);
      if (compact) out.push(compact);
    }
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return JSON.stringify(out);
}

async function getPlaylistBody() {
  if (playlistCache.body && Date.now() - playlistCache.at < PLAYLIST_TTL_MS) return playlistCache.body;
  const body = await buildPlaylistBody();
  playlistCache = { at: Date.now(), body };
  backendSeen = true;
  console.log(`[playlist] cached ${JSON.parse(body).length} photos`);
  return body;
}


// ── Proxy /api/v1/* → backend ────────────────────────────────────────────────
async function proxyRequest(req, res) {
  if (READ_ONLY && !SAFE_METHODS.has(req.method)) {
    console.warn(`[proxy] blocked ${req.method} ${req.url} (read-only frame)`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'this frame is display-only: modifications are disabled' }));
    return;
  }
  const target = new URL(req.url, backend);
  const headers = { ...req.headers, host: backend.host };
  delete headers['accept-encoding']; // avoid double-compression surprises

  const sessionId = await getSessionId();
  if (sessionId) {
    // Lowercase key: req.headers is already lowercased by Node, so this OVERWRITES
    // any token the (public-mode) SPA sent instead of emitting a duplicate header
    // line — Go's Header.Get would otherwise read the empty first value.
    headers['x-auth-token'] = sessionId;
  }

  const upstream = backendAgent.request(
    target,
    { method: req.method, headers, rejectUnauthorized, agent: keepAliveAgent },
    (up) => {
      backendSeen = true; // any upstream response proves reachability
      if (sessionId && (up.statusCode === 401 || up.statusCode === 403)) {
        console.log(`[proxy] session expired (HTTP ${up.statusCode}), clearing active session`);
        activeSessionId = null;
      }

      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    const code = err.code || err.message;
    console.error(`[proxy] ${req.method} ${req.url} → ${backend.origin} FAILED: ${code}`);
    if (/ECONNRESET|EPROTO|ERR_SSL|wrong version number/i.test(code) && backend.protocol === 'http:') {
      console.error(`[proxy] HINT: backend may be HTTPS. Retry with: ./run.sh photoprism https://${backend.host}`);
    }
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Bad gateway: backend ${backend.origin} unreachable (${code})`);
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error('ETIMEDOUT')));
  req.pipe(upstream);
}

// ── Static file serving with SPA history fallback ────────────────────────────
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/config.json') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(servedConfig);
    return;
  }

  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const frameRel = rel.startsWith('/frame/') ? rel.slice('/frame/'.length) : rel.replace(/^\//, '');
  let filePath = join(FRAME, frameRel === '' || frameRel === '/' ? 'index.html' : frameRel);
  if (!filePath.startsWith(FRAME)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat = existsSync(filePath) ? statSync(filePath) : null;
  if (stat?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    stat = existsSync(filePath) ? statSync(filePath) : null;
  }

  if (!stat) {
    if (extname(urlPath) === '') {
      filePath = join(FRAME, 'index.html');
      stat = existsSync(filePath) ? statSync(filePath) : null;
    }
    if (!stat) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
  }

  const type = MIME[extname(filePath)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  createReadStream(filePath).pipe(res);
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Liveness: is this host process up. Used by install.sh verify.
  if (req.url === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  // Readiness: has the PhotoPrism backend answered at least once. The kiosk
  // launcher waits on this so Cog doesn't open a frame with no library.
  if (req.url === '/api/v1/ready') {
    res.writeHead(backendSeen ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: backendSeen ? 'ok' : 'waiting for backend' }));
    return;
  }
  const pathOnly = (req.url || '').split('?')[0];
  if (pathOnly === '/frame/playlist' && req.method === 'GET') {
    getPlaylistBody()
      .then((body) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=900',
        });
        res.end(body);
      })
      .catch((err) => {
        console.error('[playlist]', err.message);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }
  if ((req.url || '').startsWith('/api/')) {
    proxyRequest(req, res);
  } else {
    serveStatic(req, res);
  }
});


// One-shot backend reachability probe so failures surface at startup, not just
// as opaque 502s in the browser.
function probeBackend() {
  const target = new URL('/api/v1/config', backend);
  const req = backendAgent.request(
    target,
    { method: 'GET', headers: { host: backend.host }, rejectUnauthorized, agent: keepAliveAgent },
    (up) => {
      backendSeen = true;
      console.log(`  probe:    GET ${target.href} → HTTP ${up.statusCode} ✓`);
      up.resume();
    }
  );
  req.on('error', (err) => {
    const code = err.code || err.message;
    console.error(`  probe:    GET ${target.href} → FAILED: ${code} ✗`);
    if (/ECONNRESET|EPROTO|ERR_SSL|wrong version number/i.test(code) && backend.protocol === 'http:') {
      console.error(`  HINT:     backend may be HTTPS → ./run.sh photoprism https://${backend.host}`);
    } else if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/i.test(code)) {
      console.error(`  HINT:     can this machine reach ${backend.origin}? Try: curl -v ${backend.origin}/api/v1/config`);
    }
  });
  req.setTimeout(8000, () => req.destroy(new Error('ETIMEDOUT')));
  req.end();
}

server.listen(PORT, () => {
  console.log('PicoGallery lightweight frame host');
  console.log(`  serving:  ${FRAME}`);
  console.log(`  backend:  ${backend.origin}  (proxying /api/v1, read-only=${READ_ONLY})`);
  console.log(`  open:     http://localhost:${PORT}/`);
  console.log('Press Ctrl+C to stop.');
  probeBackend();
  warmPlaylist();
});

// Warm the playlist cache with backoff instead of one shot — on a cold boot the
// backend is often unreachable for the first seconds/minutes (Wi-Fi still
// associating), and a single failed warm used to leave the first client request
// paying the full build (or failing outright).
function warmPlaylist(attempt = 0) {
  getPlaylistBody()
    .then(() => console.log('[playlist] cache warmed'))
    .catch((e) => {
      const delay = Math.min(5000 * 2 ** attempt, 60000);
      console.warn(`[playlist] warm failed: ${e.message} — retrying in ${delay / 1000}s`);
      setTimeout(() => warmPlaylist(attempt + 1), delay);
    });
}
