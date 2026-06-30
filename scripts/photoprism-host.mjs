#!/usr/bin/env node
//
// photoprism-host — serve the vendored PhotoPrism SPA (frontend/dist) and
// reverse-proxy its API to a real PhotoPrism backend.
//
// Why this exists: frontend/dist is a complete PhotoPrism Vue build, but it is
// only a CLIENT. All data (config, photos, thumbnails, websocket) comes from a
// PhotoPrism Go backend. Serving the SPA same-origin and proxying /api/v1 to the
// backend avoids browser CORS/TLS blocks that a cross-origin build would hit.
//
// Usage:
//   node scripts/photoprism-host.mjs [backend-url]
// Env:
//   PICO_PP_PORT     listen port (default 8190)
//   PICO_PP_BACKEND  backend url (overridden by the CLI arg if given)
//
// Backend resolution order: CLI arg > PICO_PP_BACKEND > frontend/dist/config.json serverUrl.

import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'frontend', 'dist');
const CONFIG_FILE = join(DIST, 'config.json');

const PORT = Number(process.env.PICO_PP_PORT || 8190);

// ── Resolve backend URL ──────────────────────────────────────────────────────
function readDistConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const distConfig = readDistConfig();
const backendRaw =
  process.argv[2] || process.env.PICO_PP_BACKEND || distConfig.serverUrl || '';

if (!existsSync(DIST)) {
  console.error(`ERROR: ${DIST} not found. Build it first:`);
  console.error('  cd frontend && npm ci --ignore-scripts && npm run build');
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
const rejectUnauthorized = distConfig.ignoreCertificateErrors === false;

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

// config.json is served dynamically: force serverUrl:"" so the SPA calls the API
// same-origin (this host), and we proxy those calls to the real backend.
const servedConfig = JSON.stringify({
  ...distConfig,
  serverUrl: '',
});

// ── Proxy /api/v1/* → backend ────────────────────────────────────────────────
function proxyRequest(req, res) {
  const target = new URL(req.url, backend);
  const headers = { ...req.headers, host: backend.host };
  delete headers['accept-encoding']; // avoid double-compression surprises

  const upstream = backendAgent.request(
    target,
    { method: req.method, headers, rejectUnauthorized },
    (up) => {
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

  // Handle SPA relative path weirdness: if the browser is on /library/browse,
  // it might request /library/config.json or /library/static/build/assets.json.
  if (urlPath.endsWith('/config.json')) {
    urlPath = '/config.json';
  } else if (urlPath.includes('/static/')) {
    urlPath = urlPath.substring(urlPath.indexOf('/static/'));
  }

  if (urlPath === '/config.json') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(servedConfig);
    return;
  }

  // Resolve safely inside DIST (block path traversal).
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, rel);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat = existsSync(filePath) ? statSync(filePath) : null;
  if (stat?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    stat = existsSync(filePath) ? statSync(filePath) : null;
  }

  if (!stat) {
    // History-mode fallback: extensionless routes (e.g. /library) → index.html.
    if (extname(urlPath) === '') {
      filePath = join(DIST, 'index.html');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
  }

  const type = MIME[extname(filePath)] || 'application/octet-stream';
  const cache = filePath.includes(`${join('static', 'build')}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(filePath).pipe(res);
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    proxyRequest(req, res);
  } else {
    serveStatic(req, res);
  }
});

// Proxy websocket upgrades (PhotoPrism uses /api/v1/ws via sockette).
server.on('upgrade', (req, socket, head) => {
  if (!(req.url || '').startsWith('/api/')) {
    socket.destroy();
    return;
  }
  const target = new URL(req.url, backend);
  const headers = { ...req.headers, host: backend.host };
  const upstream = backendAgent.request(target, {
    method: req.method,
    headers,
    rejectUnauthorized,
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`,
      ...Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`),
      '\r\n',
    ];
    socket.write(lines.join('\r\n'));
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  upstream.on('error', () => socket.destroy());
  if (head?.length) upstream.write(head);
  upstream.end();
});

// One-shot backend reachability probe so failures surface at startup, not just
// as opaque 502s in the browser.
function probeBackend() {
  const target = new URL('/api/v1/config', backend);
  const req = backendAgent.request(
    target,
    { method: 'GET', headers: { host: backend.host }, rejectUnauthorized },
    (up) => {
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
  console.log(`PhotoPrism UI host`);
  console.log(`  serving:  ${DIST}`);
  console.log(`  backend:  ${backend.origin}  (proxying /api/v1)`);
  console.log(`  open:     http://localhost:${PORT}${distConfig.startupPage || '/'}`);
  console.log('Press Ctrl+C to stop.');
  probeBackend();
});
