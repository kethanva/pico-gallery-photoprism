/* global process, fetch, setTimeout */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const ASSETS = join(ROOT, 'frontend/dist/static/build/assets.json');
const HOST = join(ROOT, 'scripts/photoprism-host.mjs');

const BACKEND = process.env.PICO_TEST_BACKEND || 'http://127.0.0.1:9'; // unreachable — static-only smoke

describe('photoprism-host — PhotoPrism UI static serving', { skip: !existsSync(ASSETS) ? 'frontend/dist not built' : false }, () => {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let proc;
  let port;

  before(async () => {
    port = 18000 + Math.floor(Math.random() * 1000);
    proc = spawn(process.execPath, [HOST, BACKEND], {
      cwd: ROOT,
      env: { ...process.env, PICO_PP_PORT: String(port), PICO_PP_READONLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (res.ok) return;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('photoprism-host did not start');
  });

  after(() => {
    proc?.kill('SIGTERM');
  });

  it('serves /api/v1/health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('reports not ready while the backend is unreachable', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
    assert.equal(res.status, 503);
  });

  it('returns security headers on static responses', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/library/photos`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  });

  it('rejects malformed URL encoding without terminating the host', async () => {
    const raw = await new Promise((resolve, reject) => {
      const call = request({ host: '127.0.0.1', port, path: '/bad/%ZZ' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      call.on('error', reject);
      call.end();
    });
    assert.equal(raw, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
  });

  it('serves config.json for the SPA boot', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.serverUrl, '');
    assert.ok(body.kioskConfig);
    assert.equal(body.kioskConfig.virtualFullscreenOnly, true);
    assert.equal(body.kioskConfig.profile, 'pi_zero_2');
    assert.equal(body.kioskConfig.previewSize, 'fit_720');
  });

  it('serves webpack assets.json', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/static/build/assets.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body['app.js']);
    assert.ok(body['app.css']);
  });

  it('SPA history fallback returns index.html for /library/photos', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/library/photos`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html/i);
    assert.match(html, /id="app"/);
    assert.match(html, /assets\.json/);
  });

  it('serves sw.js as an unregister stub with no-store', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/i);
    const body = await res.text();
    assert.match(body, /unregister/);
  });

  it('index.html boots with absolute URLs (survives deep routes like /library/photos)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/library/photos`);
    const html = await res.text();
    // Relative "config.json"/"static/build/..." resolve to /library/… on deep
    // routes, where the history fallback answers with index.html — parsing
    // that HTML as JSON killed the boot script (blank screen on the frame).
    assert.match(html, /'\/config\.json'/);
    assert.match(html, /'\/static\/build\/assets\.json'/);
    assert.match(html, /'\/static\/build\/' \+ manifest/);
    assert.doesNotMatch(html, /open\('GET', 'config\.json'/);
    assert.doesNotMatch(html, /open\('GET', 'static\/build/);
  });
});

describe('photoprism-host — auth masquerade proxy (credentials configured)', { skip: !existsSync(ASSETS) ? 'frontend/dist not built' : false }, () => {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let proc;
  let port;
  let stub;
  let stubPort;
  let configPath;
  let stubMode = 'healthy';
  const seenHeaders = {};

  before(async () => {
    // Stub PhotoPrism backend that requires auth (mode "user" once logged in).
    stub = createServer((req, res) => {
      seenHeaders[`${req.method} ${req.url}`] = { ...req.headers };
      if (req.method === 'POST' && req.url === '/api/v1/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub-session-id' }));
      } else if (req.method === 'GET' && req.url === '/api/v1/config') {
        if (stubMode === 'unhealthy') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (stubMode === 'invalid') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{invalid');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ mode: 'user', public: false, authMode: 'password', previewToken: 'real-preview-token', downloadToken: 'must-not-leak', settings: { admin: true } }));
      } else if (req.method === 'GET' && req.url === '/api/v1/session') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id: 'stub-session-id', config: { mode: 'user', public: false }, user: { Name: 'admin' } }));
      } else if (req.method === 'GET' && req.url === '/static/img/avatar/tile_50.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end('stub-jpeg-bytes');
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = stub.address().port;

    configPath = join(tmpdir(), `pico-host-test-${process.pid}.toml`);
    writeFileSync(configPath, [
      '[[sources]]',
      'name     = "photoprism"',
      `url      = "http://127.0.0.1:${stubPort}"`,
      'username = "admin"',
      'password = "secret"',
    ].join('\n'));

    port = 19000 + Math.floor(Math.random() * 1000);
    proc = spawn(process.execPath, [HOST, `http://127.0.0.1:${stubPort}`], {
      cwd: ROOT,
      env: { ...process.env, PICO_PP_PORT: String(port), PICO_PP_READONLY: '1', PICO_PP_PROBE_MS: '100', PICO_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (res.ok) return;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('photoprism-host did not start');
  });

  after(() => {
    proc?.kill('SIGTERM');
    stub?.close();
    try {
      rmSync(configPath);
    } catch {
      // best effort
    }
  });

  it('rewrites /api/v1/config to public mode so the SPA skips its login redirect', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'public');
    assert.equal(body.public, true);
    assert.equal(body.authMode, 'public');
    // Only the preview token needed to render thumbnails may pass through.
    assert.equal(body.previewToken, 'real-preview-token');
    assert.equal(body.downloadToken, undefined);
    assert.equal(body.settings, undefined);
  });

  it('does not expose the privileged upstream session endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/session`);
    assert.equal(res.status, 403);
  });

  it('injects the upstream session token into proxied API requests', async () => {
    await fetch(`http://127.0.0.1:${port}/api/v1/config`);
    assert.equal(seenHeaders['GET /api/v1/config']['x-auth-token'], 'stub-session-id');
  });

  it('never honors an attacker-controlled absolute-form request origin', async () => {
    const status = await new Promise((resolve, reject) => {
      const call = request({
        host: '127.0.0.1', port, method: 'GET',
        path: 'http://attacker.invalid/api/v1/config',
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      call.on('error', reject);
      call.end();
    });
    assert.equal(status, 200);
    assert.equal(seenHeaders['GET /api/v1/config'].host, `127.0.0.1:${stubPort}`);
  });

  it('does not expose arbitrary backend static files', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/static/img/avatar/tile_50.jpg`);
    assert.equal(res.status, 404);
  });

  it('still blocks writes (read-only appliance)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/photos/abc`, { method: 'PUT', body: '{}' });
    assert.equal(res.status, 403);
  });

  it('blocks unneeded read-only API routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/users`);
    assert.equal(res.status, 403);
  });

  it('becomes ready only after the authenticated backend probe succeeds', async () => {
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
        if (res.status === 200) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('host did not become ready');
    });
  });

  it('returns to not-ready when a later authenticated probe fails', async () => {
    stubMode = 'unhealthy';
    try {
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
        if (res.status === 503) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('host remained ready after backend failure');
    } finally {
      stubMode = 'healthy';
    }
  });

  it('does not report ready for a malformed upstream config response', async () => {
    stubMode = 'invalid';
    try {
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
        if (res.status === 503) {
          const body = await res.json();
          if (body.reason === 'invalid_upstream_config') return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('host accepted malformed upstream config as ready');
    } finally {
      stubMode = 'healthy';
    }
  });
});

describe('photoprism-host — gateway authentication', { skip: !existsSync(ASSETS) ? 'frontend/dist not built' : false }, () => {
  let proc;
  let port;
  const token = 'test-gateway-token-with-32-characters';

  before(async () => {
    port = 20000 + Math.floor(Math.random() * 1000);
    proc = spawn(process.execPath, [HOST, BACKEND], {
      cwd: ROOT,
      env: { ...process.env, PICO_PP_HOST: '127.0.0.1', PICO_PP_PORT: String(port), PICO_PP_AUTH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 40; i += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) return;
      } catch {
        // Host is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('authenticated host did not start');
  });

  after(() => proc?.kill('SIGTERM'));

  it('rejects an unauthenticated display request', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/library/photos`)).status, 401);
  });

  it('exchanges a query token for a protected cookie and removes it from the URL', async () => {
    const exchange = await fetch(`http://127.0.0.1:${port}/library/photos?token=${token}`, { redirect: 'manual' });
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get('location'), '/library/photos');
    const cookie = exchange.headers.get('set-cookie');
    assert.match(cookie || '', /HttpOnly/);
    assert.match(cookie || '', /SameSite=Strict/);
    const res = await fetch(`http://127.0.0.1:${port}/library/photos`, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(res.status, 200);
  });

  it('accepts a Bearer token for non-browser clients', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/library/photos`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it('protects operational metrics with the gateway token', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/metrics`)).status, 401);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.requests >= 1);
    assert.ok(body.rssBytes > 0);
  });

  it('handles HEAD request for token exchange with 303 redirect and set-cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/library/photos?token=${token}`, {
      method: 'HEAD',
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.ok(res.headers.get('set-cookie')?.includes('pico_auth='));
  });

  it('gracefully handles malformed percent-encoded cookie without crashing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/library/photos`, {
      headers: { cookie: 'pico_auth=%ZZmalformed' },
    });
    assert.equal(res.status, 401);
  });

  it('strictly enforces ALLOWED_API_ROUTES regex pinned thumbnail sizes', async () => {
    const fit720 = await fetch(`http://127.0.0.1:${port}/api/v1/t/abc123/token/fit_720`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.notEqual(fit720.status, 403);
    const fit1280 = await fetch(`http://127.0.0.1:${port}/api/v1/t/abc123/token/fit_1280`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.notEqual(fit1280.status, 403);

    const fit2048 = await fetch(`http://127.0.0.1:${port}/api/v1/t/abc123/token/fit_2048`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(fit2048.status, 403);
  });
});

describe('photoprism-host — unsafe external startup', () => {
  for (const host of ['0.0.0.0', '192.0.2.10']) it(`refuses external bind ${host} without a strong gateway token`, async () => {
    const proc = spawn(process.execPath, [HOST, BACKEND], {
      cwd: ROOT,
      env: { ...process.env, PICO_PP_HOST: host, PICO_PP_AUTH_TOKEN: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => proc.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /external bind requires/);
  });

  it('reports a malformed backend URL without an uncaught exception', async () => {
    const proc = spawn(process.execPath, [HOST, 'not a url'], {
      cwd: ROOT,
      env: { ...process.env, PICO_PP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => proc.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /invalid PhotoPrism backend URL/);
    assert.doesNotMatch(stderr, /at new URL/);
  });
});
