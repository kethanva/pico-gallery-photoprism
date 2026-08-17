#!/usr/bin/env node
//
// photoprism-host — serve the PhotoPrism Vue UI (frontend/) and reverse-proxy
// /api/v1 to a real backend through a strict display-only GET/HEAD allowlist.
//
// Backend resolution: CLI arg > PICO_PP_BACKEND > PICO_CONFIG [[sources]] url.

import { buildKioskConfig } from './kiosk-config.mjs';
import { loadPicoConfig, selectPhotoPrismSource } from './config-loader.mjs';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize, extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FRONTEND = join(ROOT, 'frontend');
const INDEX_HTML = join(FRONTEND, 'index.html');
const STATIC = join(FRONTEND, 'static');
const DIST_BUILD = join(FRONTEND, 'dist/static/build');

const CONFIG_PATH = process.env.PICO_CONFIG || '/etc/picogallery/config.toml';
let loadedConfig;
try {
  loadedConfig = loadPicoConfig(CONFIG_PATH);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
let photoPrismSource;
try {
  photoPrismSource = selectPhotoPrismSource(loadedConfig.config);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
const PORT = Number(process.env.PICO_PP_PORT || loadedConfig.config?.http?.port || 8190);
const HOST = process.env.PICO_PP_HOST || loadedConfig.config?.http?.host || '127.0.0.1';
const GATEWAY_TOKEN = process.env.PICO_PP_AUTH_TOKEN || loadedConfig.config?.http?.auth_token || '';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`ERROR: invalid listen port: ${PORT}`);
  process.exit(1);
}
if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase()) && GATEWAY_TOKEN.length < 24) {
  console.error('ERROR: an external bind requires PICO_PP_AUTH_TOKEN or [http].auth_token with at least 24 characters.');
  process.exit(1);
}

const backendRaw =
  process.argv[2] || process.env.PICO_PP_BACKEND || photoPrismSource?.url || '';

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
  console.error('  ./run.sh photoprism http://photoprism.local:2342');
  process.exit(1);
}

let backend;
try {
  backend = new URL(backendRaw.replace(/\/+$/, ''));
} catch {
  console.error('ERROR: invalid PhotoPrism backend URL.');
  process.exit(1);
}
if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password) {
  console.error('ERROR: PhotoPrism backend must be an http(s) URL without embedded credentials.');
  process.exit(1);
}
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

const ppUser = String(photoPrismSource?.username || '');
const ppPass = String(photoPrismSource?.app_password || photoPrismSource?.password || '');
const slideDurationSecs = loadedConfig.config?.display?.slide_duration_secs;
const configToml = loadedConfig.raw;

const kioskConfig = buildKioskConfig({ toml: configToml, slideDurationSecs });

let activeSessionId = null;
let sessionPromise = null;
let authFailures = 0;
let nextAuthAttemptAt = 0;

// Backend access mode, learned from the /api/v1/config probe (log/ready only).
let backendMode = null;
let readiness = { ok: false, checkedAt: 0, reason: 'not checked' };
const metrics = {
  startedAt: Date.now(),
  requests: 0,
  responses4xx: 0,
  responses5xx: 0,
  upstreamErrors: 0,
  authFailures: 0,
};

function log(level, event, fields = {}) {
  const record = { ts: new Date().toISOString(), level, event, ...fields };
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

// When credentials are configured, the proxy authenticates upstream on behalf
// of the display and the browser never holds a session. The SPA must therefore
// believe it is talking to a public (no-auth) instance, or its router guards
// bounce every /library route to the login screen. Rewrite the auth-mode
// fields in config payloads. Only the preview token needed for image requests
// is retained; privileged settings and download tokens are discarded.
const MASQUERADE_PUBLIC = () => !!(ppUser && ppPass);

function rewriteAuthPayload(pathname, body) {
  const parsed = JSON.parse(body);
  if (pathname === '/api/v1/config') {
    return JSON.stringify({
      mode: 'public',
      public: true,
      authMode: 'public',
      previewToken: typeof parsed?.previewToken === 'string' ? parsed.previewToken : 'public',
    });
  }
  throw new Error(`unsupported rewrite path: ${pathname}`);
}

function isRewritePath(pathname) {
  return pathname === '/api/v1/config';
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
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          req.destroy(new Error('authentication response exceeds 1 MiB'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(body);
            if (typeof data.id !== 'string' || !data.id) throw new Error('login response has no session id');
            resolve(data.id);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`PhotoPrism login failed with HTTP ${res.statusCode}`));
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
  if (sessionPromise) return sessionPromise;
  if (Date.now() < nextAuthAttemptAt) throw new Error('upstream authentication backoff is active');

  sessionPromise = (async () => {
    try {
      console.log('[proxy] authenticating upstream');
      const id = await fetchSession();
      activeSessionId = id;
      authFailures = 0;
      nextAuthAttemptAt = 0;
      return id;
    } catch (error) {
      authFailures += 1;
      metrics.authFailures += 1;
      const backoff = Math.min(30_000, 1000 * (2 ** Math.min(authFailures - 1, 5)));
      nextAuthAttemptAt = Date.now() + backoff;
      log('error', 'upstream_auth_failed', { retryMs: backoff, message: error.message });
      throw error;
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
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

const SW_UNREGISTER = `self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((c) => c.navigate(c.url));
})()));
`;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};
const ALLOWED_API_ROUTES = [
  /^\/api\/v1\/config$/,
  /^\/api\/v1\/photos$/,
  /^\/api\/v1\/t\/[A-Za-z0-9]+\/[A-Za-z0-9._~-]+\/fit_(720|1280)$/,
];

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function requestToken(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('pico_auth='));
  if (!cookie) return '';
  try {
    return decodeURIComponent(cookie.slice('pico_auth='.length));
  } catch {
    return '';
  }
}

function authorizeGateway(req, res, parsedUrl) {
  if (!GATEWAY_TOKEN) return true;
  const queryToken = parsedUrl.searchParams.get('token');
  if (safeEqual(queryToken, GATEWAY_TOKEN) && (req.method === 'GET' || req.method === 'HEAD')) {
    parsedUrl.searchParams.delete('token');
    res.writeHead(303, {
      location: `${parsedUrl.pathname}${parsedUrl.search}`,
      'set-cookie': `pico_auth=${encodeURIComponent(GATEWAY_TOKEN)}; Path=/; HttpOnly; SameSite=Strict${process.env.PICO_PP_COOKIE_SECURE === '1' ? '; Secure' : ''}`,
      'cache-control': 'no-store',
    });
    res.end();
    return false;
  }
  if (safeEqual(requestToken(req), GATEWAY_TOKEN)) return true;
  res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'authentication required' }));
  return false;
}

function apiRouteAllowed(method, pathname) {
  return (method === 'GET' || method === 'HEAD') && ALLOWED_API_ROUTES.some((route) => route.test(pathname));
}

function stripHopByHop(headers) {
  const clean = { ...headers };
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    delete clean[name];
  }
  delete clean['set-cookie'];
  return clean;
}


const compressionAvailability = new Map();

function pickCompressedPath(filePath, acceptEncoding = '') {
  let available = compressionAvailability.get(filePath);
  if (!available) {
    available = { zstd: existsSync(`${filePath}.zst`), gzip: existsSync(`${filePath}.gz`) };
    compressionAvailability.set(filePath, available);
  }
  if (acceptEncoding.includes('zstd') && available.zstd) {
    return { filePath: `${filePath}.zst`, encoding: 'zstd' };
  }
  if (acceptEncoding.includes('gzip') && available.gzip) {
    return { filePath: `${filePath}.gz`, encoding: 'gzip' };
  }
  return { filePath, encoding: null };
}

function sendFile(req, res, filePath, cacheControl = 'no-cache') {
  const candidate = resolve(filePath);
  const contained = relative(resolve(FRONTEND), candidate);
  if (contained.startsWith('..') || isAbsolute(contained)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(candidate)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const stat = statSync(candidate);
  if (stat.isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  const picked = pickCompressedPath(candidate, req.headers['accept-encoding'] || '');
  const baseName = picked.filePath.replace(/\.(gz|zst)$/, '');
  const type = MIME[extname(baseName)] || 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': cacheControl, vary: 'Accept-Encoding' };
  if (picked.encoding) headers['content-encoding'] = picked.encoding;
  res.writeHead(200, headers);
  const stream = createReadStream(picked.filePath);
  stream.on('error', (error) => {
    log('error', 'static_read_failed', { path: picked.filePath, message: error.message });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.destroy(error);
  });
  stream.pipe(res);
}

async function proxyRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    console.warn(`[proxy] blocked ${req.method} ${req.url} (display-only host)`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'this host is display-only: modifications are disabled' }));
    return;
  }
  if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'request bodies are not accepted' }));
    return;
  }
  // Rebuild from origin-form path/query so an absolute-form request target can
  // never turn this service into an open proxy to an attacker-chosen origin.
  const incoming = new URL(req.url || '/', 'http://localhost');
  const target = new URL(`${incoming.pathname}${incoming.search}`, backend);
  if (!apiRouteAllowed(req.method, target.pathname)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'route is not available on the display-only host' }));
    return;
  }
  const headers = { ...stripHopByHop(req.headers), host: backend.host };
  delete headers['accept-encoding'];
  delete headers.authorization;
  delete headers.cookie;
  delete headers['x-auth-token'];

  let sessionId;
  try {
    sessionId = await getSessionId();
  } catch {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
    res.end(JSON.stringify({ error: 'upstream authentication unavailable' }));
    return;
  }
  if (sessionId) {
    headers['x-auth-token'] = sessionId;
  }

  const upstream = backendAgent.request(
    target,
    { method: req.method, headers, rejectUnauthorized, agent: keepAliveAgent },
    (up) => {
      if (sessionId && (up.statusCode === 401 || up.statusCode === 403)) {
        if (activeSessionId === sessionId) {
          console.log(`[proxy] session expired (HTTP ${up.statusCode}), clearing active session`);
          activeSessionId = null;
          readiness = { ok: false, checkedAt: Date.now(), reason: `upstream_http_${up.statusCode}` };
        }
      }

      const shouldRewrite =
        MASQUERADE_PUBLIC() &&
        req.method === 'GET' &&
        up.statusCode === 200 &&
        isRewritePath(target.pathname) &&
        (up.headers['content-type'] || '').includes('json');

      if (!shouldRewrite) {
        res.writeHead(up.statusCode || 502, stripHopByHop(up.headers));
        up.pipe(res);
        return;
      }

      let body = '';
      let bytes = 0;
      up.setEncoding('utf8');
      up.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) {
          upstream.destroy(new Error('rewritten response exceeds 2 MiB'));
          return;
        }
        body += chunk;
      });
      up.on('end', () => {
        let out = body;
        try {
          out = rewriteAuthPayload(target.pathname, body);
        } catch (e) {
          console.warn(`[proxy] config rewrite failed for ${target.pathname}: ${e.message}`);
        }
        const outHeaders = stripHopByHop(up.headers);
        delete outHeaders['content-length'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = Buffer.byteLength(out);
        res.writeHead(up.statusCode || 502, outHeaders);
        res.end(out);
      });
    },
  );
  upstream.on('error', (err) => {
    metrics.upstreamErrors += 1;
    const code = err.code || err.message;
    console.error(`[proxy] ${req.method} ${req.url} → ${backend.origin} FAILED: ${code}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad gateway');
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error('ETIMEDOUT')));
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const urlPath = req.safePath;

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
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
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
  const requestId = randomUUID();
  const startedAt = Date.now();
  metrics.requests += 1;
  res.setHeader('x-request-id', requestId);
  res.once('finish', () => {
    if (res.statusCode >= 500) metrics.responses5xx += 1;
    else if (res.statusCode >= 400) metrics.responses4xx += 1;
    log('info', 'http_request', {
      requestId, method: req.method, path: String(req.url || '').split('?')[0],
      status: res.statusCode, durationMs: Date.now() - startedAt,
    });
  });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', 'http://localhost');
    req.safePath = decodeURIComponent(parsedUrl.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'malformed request URL' }));
    return;
  }
  if (parsedUrl.pathname === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptimeSecs: Math.floor(process.uptime()) }));
    return;
  }
  if (parsedUrl.pathname === '/api/v1/ready') {
    const ready = readiness.ok && Date.now() - readiness.checkedAt < PROBE_RETRY_MS * 3;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: ready ? 'ok' : 'unavailable', reason: readiness.reason, checkedAt: readiness.checkedAt || null }));
    return;
  }
  if (!authorizeGateway(req, res, parsedUrl)) return;
  if (parsedUrl.pathname === '/api/v1/metrics') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ...metrics,
      uptimeSecs: Math.floor(process.uptime()),
      rssBytes: process.memoryUsage().rss,
      readiness,
    }));
    return;
  }
  if (parsedUrl.pathname.startsWith('/api/')) {
    proxyRequest(req, res);
  } else {
    serveStatic(req, res);
  }
});

const configuredProbeMs = Number(process.env.PICO_PP_PROBE_MS || 15000);
const PROBE_RETRY_MS = Number.isFinite(configuredProbeMs) && configuredProbeMs >= 50 ? configuredProbeMs : 15000;

async function probeBackend() {
  const target = new URL('/api/v1/config', backend);
  let sessionId;
  try {
    sessionId = await getSessionId();
  } catch {
    readiness = { ok: false, checkedAt: Date.now(), reason: 'authentication_failed' };
    setTimeout(probeBackend, PROBE_RETRY_MS).unref();
    return;
  }
  const headers = { host: backend.host };
  if (sessionId) headers['x-auth-token'] = sessionId;
  const req = backendAgent.request(
    target,
    { method: 'GET', headers, rejectUnauthorized, agent: keepAliveAgent },
    (up) => {
      let body = '';
      let bytes = 0;
      let tooLarge = false;
      up.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          tooLarge = true;
          up.destroy(new Error('probe response exceeds 1 MiB'));
          return;
        }
        body += chunk;
      });
      up.on('error', (error) => {
        readiness = { ok: false, checkedAt: Date.now(), reason: tooLarge ? 'upstream_response_too_large' : 'upstream_response_error' };
        log('warn', 'readiness_probe_failed', { message: error.message });
        setTimeout(probeBackend, PROBE_RETRY_MS).unref();
      });
      up.on('end', () => {
        if ((up.statusCode || 0) < 200 || (up.statusCode || 0) >= 300) {
          backendMode = null;
          readiness = { ok: false, checkedAt: Date.now(), reason: `upstream_http_${up.statusCode}` };
          console.error(`  probe:    GET ${target.href} → HTTP ${up.statusCode} ✗ (retry in ${PROBE_RETRY_MS / 1000}s)`);
          setTimeout(probeBackend, PROBE_RETRY_MS).unref();
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          backendMode = null;
          readiness = { ok: false, checkedAt: Date.now(), reason: 'invalid_upstream_config' };
          setTimeout(probeBackend, PROBE_RETRY_MS).unref();
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          backendMode = null;
          readiness = { ok: false, checkedAt: Date.now(), reason: 'invalid_upstream_config' };
          setTimeout(probeBackend, PROBE_RETRY_MS).unref();
          return;
        }
        backendMode = typeof parsed.mode === 'string' && parsed.mode ? parsed.mode : 'unknown';
        readiness = { ok: true, checkedAt: Date.now(), reason: `upstream mode ${backendMode}` };
        console.log(`  probe:    GET ${target.href} → HTTP ${up.statusCode} (mode: ${backendMode}) ✓`);
        setTimeout(probeBackend, PROBE_RETRY_MS).unref();
      });
    },
  );
  req.on('error', (err) => {
    readiness = { ok: false, checkedAt: Date.now(), reason: 'upstream_unreachable' };
    console.error(`  probe:    GET ${target.href} → FAILED: ${err.code || err.message} ✗ (retry in ${PROBE_RETRY_MS / 1000}s)`);
    setTimeout(probeBackend, PROBE_RETRY_MS).unref();
  });
  req.setTimeout(8000, () => req.destroy(new Error('ETIMEDOUT')));
  req.end();
}

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;
server.maxRequestsPerSocket = 1000;
server.maxConnections = 32;
server.on('error', (error) => {
  log('error', 'server_failed', { code: error.code, message: error.message });
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log('PicoGallery PhotoPrism UI host');
  console.log(`  serving:  ${FRONTEND} (built assets in ${DIST_BUILD})`);
  console.log(`  backend:  ${backend.origin}  (display-only API allowlist)`);
  console.log(`  listen:   http://${HOST}:${PORT} (gateway-auth=${!!GATEWAY_TOKEN})`);
  console.log(`  open:     http://localhost:${PORT}/library/photos`);
  console.log('Press Ctrl+C to stop.');
  probeBackend();
});

function shutdown(signal) {
  console.log(`[host] ${signal} received; draining connections`);
  server.closeIdleConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
