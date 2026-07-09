#!/usr/bin/env node
//
// photoprism-host — serve the PhotoPrism Vue UI (frontend/) and reverse-proxy
// /api/v1 to a real backend (read-only GET/HEAD/OPTIONS by default).
//
// Backend resolution: CLI arg > PICO_PP_BACKEND > PICO_CONFIG [[sources]] url.

import { buildKioskConfig } from './kiosk-config.mjs';
import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FRONTEND = join(ROOT, 'frontend');
const INDEX_HTML = join(FRONTEND, 'index.html');
const STATIC = join(FRONTEND, 'static');
const DIST_BUILD = join(FRONTEND, 'dist/static/build');

const PORT = Number(process.env.PICO_PP_PORT || 8190);

// ── Read-only enforcement ────────────────────────────────────────────────────
const READ_ONLY = process.env.PICO_PP_READONLY !== '0';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readTomlBackend() {
  try {
    const configPath = process.env.PICO_CONFIG || '/etc/picogallery/config.toml';
    const toml = readFileSync(configPath, 'utf8');
    const urlMatch = toml.match(/url\s*=\s*"([^"]+)"/);
    return urlMatch ? urlMatch[1] : '';
  } catch {
    return '';
  }
}

const backendRaw =
  process.argv[2] || process.env.PICO_PP_BACKEND || readTomlBackend() || '';

if (!existsSync(INDEX_HTML)) {
  console.error(`ERROR: ${INDEX_HTML} not found.`);
  process.exit(1);
}
if (!existsSync(join(DIST_BUILD, 'assets.json'))) {
  console.error(`ERROR: ${join(DIST_BUILD, 'assets.json')} not found.`);
  console.error('Build the PhotoPrism UI first: cd frontend && npm run build');
  process.exit(1);
}
if (!backendRaw) {
  console.error('ERROR: no backend URL. Pass one as an argument:');
  console.error('  ./run.sh photoprism http://192.168.68.71:2342');
  process.exit(1);
}

const backend = new URL(backendRaw.replace(/\/+$/, ''));
const backendAgent = backend.protocol === 'https:' ? https : http;
const rejectUnauthorized = process.env.PICO_PP_INSECURE !== '1';

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
let slideDurationSecs;
let configToml = '';
try {
  const configPath = process.env.PICO_CONFIG || '/etc/picogallery/config.toml';
  configToml = readFileSync(configPath, 'utf8');
  const userMatch = configToml.match(/username\s*=\s*"([^"]+)"/);
  const passMatch = configToml.match(/password\s*=\s*"([^"]+)"/);
  if (userMatch) ppUser = userMatch[1];
  if (passMatch) ppPass = passMatch[1];

  const durationMatch = configToml.match(/slide_duration_secs\s*=\s*([0-9]+)/);
  if (durationMatch) {
    slideDurationSecs = parseInt(durationMatch[1], 10);
  }
} catch {
  // Ignore missing config
}

const kioskConfig = buildKioskConfig({ toml: configToml, slideDurationSecs });

let activeSessionId = null;
let isFetchingSession = false;
let sessionFetchQueue = [];

// Backend access mode, learned from the /api/v1/config probe (log/ready only).
let backendMode = null;

// When credentials are configured, the proxy authenticates upstream on behalf
// of the display and the browser never holds a session. The SPA must therefore
// believe it is talking to a public (no-auth) instance, or its router guards
// bounce every /library route to the login screen. Rewrite the auth-mode
// fields in config payloads; the real previewToken/downloadToken/settings from
// the authenticated response pass through untouched.
const MASQUERADE_PUBLIC = () => !!(ppUser && ppPass);

function forcePublicAuthFields(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  cfg.mode = 'public';
  cfg.public = true;
  cfg.authMode = 'public';
}

function rewriteAuthPayload(pathname, body) {
  const parsed = JSON.parse(body);
  if (pathname === '/api/v1/config') {
    forcePublicAuthFields(parsed);
  } else if (parsed && typeof parsed === 'object' && parsed.config) {
    // GET /api/v1/session embeds a config object that would otherwise
    // overwrite mode/public back to auth-required mid-session.
    forcePublicAuthFields(parsed.config);
  }
  return JSON.stringify(parsed);
}

function isRewritePath(pathname) {
  return pathname === '/api/v1/config' || pathname === '/api/v1/session';
}

function fetchSession() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ username: ppUser, password: ppPass });
    const req = backendAgent.request(new URL('/api/v1/session', backend), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        Host: backend.host,
      },
      agent: keepAliveAgent,
      rejectUnauthorized,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(body);
            resolve(data.id);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Failed to login: ${res.statusCode} ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('ETIMEDOUT')));
    req.write(postData);
    req.end();
  });
}

async function getSessionId() {
  if (!ppUser || !ppPass) return null;
  if (activeSessionId) return activeSessionId;

  if (isFetchingSession) {
    return new Promise((resolve) => sessionFetchQueue.push(resolve));
  }
  isFetchingSession = true;

  try {
    console.log('[proxy] authenticating as', ppUser, '...');
    const id = await fetchSession();
    activeSessionId = id;
    sessionFetchQueue.forEach((resolve) => resolve(id));
    return id;
  } catch (e) {
    console.error('[proxy] autologin failed:', e.message);
    sessionFetchQueue.forEach((resolve) => resolve(null));
    return null;
  } finally {
    isFetchingSession = false;
    sessionFetchQueue = [];
  }
}

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
  serverUrl: '',
  slideDuration: kioskConfig.slideDuration,
  kioskConfig,
  disableServiceWorker: true,
});

let backendSeen = false;

const SW_UNREGISTER = `self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((c) => c.navigate(c.url));
})()));
`;


function pickCompressedPath(filePath, acceptEncoding = '') {
  if (acceptEncoding.includes('zst') && existsSync(`${filePath}.zst`)) {
    return { filePath: `${filePath}.zst`, encoding: 'zstd' };
  }
  if (acceptEncoding.includes('gzip') && existsSync(`${filePath}.gz`)) {
    return { filePath: `${filePath}.gz`, encoding: 'gzip' };
  }
  return { filePath, encoding: null };
}

function sendFile(req, res, filePath, cacheControl = 'no-cache') {
  if (!filePath.startsWith(FRONTEND)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  const picked = pickCompressedPath(filePath, req.headers['accept-encoding'] || '');
  const baseName = picked.filePath.replace(/\.(gz|zst)$/, '');
  const type = MIME[extname(baseName)] || 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': cacheControl };
  if (picked.encoding) headers['content-encoding'] = picked.encoding;
  res.writeHead(200, headers);
  createReadStream(picked.filePath).pipe(res);
}

async function proxyRequest(req, res) {
  if (READ_ONLY && !SAFE_METHODS.has(req.method)) {
    console.warn(`[proxy] blocked ${req.method} ${req.url} (read-only host)`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'this host is display-only: modifications are disabled' }));
    return;
  }
  const target = new URL(req.url, backend);
  const headers = { ...req.headers, host: backend.host };
  delete headers['accept-encoding'];

  const sessionId = await getSessionId();
  if (sessionId) {
    headers['x-auth-token'] = sessionId;
  }

  const upstream = backendAgent.request(
    target,
    { method: req.method, headers, rejectUnauthorized, agent: keepAliveAgent },
    (up) => {
      backendSeen = true;
      if (sessionId && (up.statusCode === 401 || up.statusCode === 403)) {
        console.log(`[proxy] session expired (HTTP ${up.statusCode}), clearing active session`);
        activeSessionId = null;
      }

      const shouldRewrite =
        MASQUERADE_PUBLIC() &&
        req.method === 'GET' &&
        up.statusCode === 200 &&
        isRewritePath(target.pathname) &&
        (up.headers['content-type'] || '').includes('json');

      if (!shouldRewrite) {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        return;
      }

      let body = '';
      up.setEncoding('utf8');
      up.on('data', (chunk) => { body += chunk; });
      up.on('end', () => {
        let out = body;
        try {
          out = rewriteAuthPayload(target.pathname, body);
        } catch (e) {
          console.warn(`[proxy] config rewrite failed for ${target.pathname}: ${e.message}`);
        }
        const outHeaders = { ...up.headers };
        delete outHeaders['content-length'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = Buffer.byteLength(out);
        res.writeHead(up.statusCode || 502, outHeaders);
        res.end(out);
      });
    },
  );
  upstream.on('error', (err) => {
    const code = err.code || err.message;
    console.error(`[proxy] ${req.method} ${req.url} → ${backend.origin} FAILED: ${code}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Bad gateway: backend ${backend.origin} unreachable (${code})`);
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error('ETIMEDOUT')));
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/sw.js' || urlPath === '/static/build/sw.js') {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    res.end(SW_UNREGISTER);
    return;
  }

  if (urlPath === '/config.json') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(servedConfig);
    return;
  }

  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');

  if (rel.startsWith('/static/build/')) {
    sendFile(req, res, join(DIST_BUILD, rel.slice('/static/build/'.length)), 'public, max-age=31536000, immutable');
    return;
  }

  if (rel.startsWith('/static/')) {
    const localPath = join(STATIC, rel.slice('/static/'.length));
    if (existsSync(localPath) && !statSync(localPath).isDirectory()) {
      sendFile(req, res, localPath, 'public, max-age=86400');
    } else {
      // Not shipped with the UI bundle (avatars, wallpapers, …) — the backend
      // serves these under the same /static prefix.
      proxyRequest(req, res);
    }
    return;
  }

  const bare = rel.replace(/^\//, '');
  if (bare && extname(bare)) {
    const candidate = join(FRONTEND, bare);
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
      sendFile(req, res, candidate);
      return;
    }
  }

  // Vue-router history fallback — normal PhotoPrism UI (no kiosk slideshow boot).
  sendFile(req, res, INDEX_HTML, 'no-store');
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/api/v1/ready') {
    res.writeHead(backendSeen ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: backendSeen ? 'ok' : 'waiting for backend' }));
    return;
  }
  if ((req.url || '').startsWith('/api/')) {
    proxyRequest(req, res);
  } else {
    serveStatic(req, res);
  }
});

const PROBE_RETRY_MS = 15000;

function probeBackend() {
  const target = new URL('/api/v1/config', backend);
  const req = backendAgent.request(
    target,
    { method: 'GET', headers: { host: backend.host }, rejectUnauthorized, agent: keepAliveAgent },
    (up) => {
      backendSeen = true;
      let body = '';
      up.on('data', (chunk) => { body += chunk; });
      up.on('end', () => {
        if ((up.statusCode || 0) < 200 || (up.statusCode || 0) >= 300) {
          backendMode = null;
          console.error(`  probe:    GET ${target.href} → HTTP ${up.statusCode} ✗ (retry in ${PROBE_RETRY_MS / 1000}s)`);
          setTimeout(probeBackend, PROBE_RETRY_MS).unref();
          return;
        }
        try {
          backendMode = JSON.parse(body).mode || 'unknown';
        } catch {
          backendMode = 'unknown';
        }
        console.log(`  probe:    GET ${target.href} → HTTP ${up.statusCode} (mode: ${backendMode}) ✓`);
      });
    },
  );
  req.on('error', (err) => {
    console.error(`  probe:    GET ${target.href} → FAILED: ${err.code || err.message} ✗ (retry in ${PROBE_RETRY_MS / 1000}s)`);
    setTimeout(probeBackend, PROBE_RETRY_MS).unref();
  });
  req.setTimeout(8000, () => req.destroy(new Error('ETIMEDOUT')));
  req.end();
}

server.listen(PORT, () => {
  console.log('PicoGallery PhotoPrism UI host');
  console.log(`  serving:  ${FRONTEND} (built assets in ${DIST_BUILD})`);
  console.log(`  backend:  ${backend.origin}  (proxying /api/v1, read-only=${READ_ONLY})`);
  console.log(`  open:     http://localhost:${PORT}/library/photos`);
  console.log('Press Ctrl+C to stop.');
  probeBackend();
});
