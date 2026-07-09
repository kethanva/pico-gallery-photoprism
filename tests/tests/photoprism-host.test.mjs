/* global process, fetch, setTimeout */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
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
  const seenHeaders = {};

  before(async () => {
    // Stub PhotoPrism backend that requires auth (mode "user" once logged in).
    stub = createServer((req, res) => {
      seenHeaders[`${req.method} ${req.url}`] = { ...req.headers };
      if (req.method === 'POST' && req.url === '/api/v1/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub-session-id' }));
      } else if (req.method === 'GET' && req.url === '/api/v1/config') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ mode: 'user', public: false, authMode: 'password', previewToken: 'real-preview-token' }));
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
      `url      = "http://127.0.0.1:${stubPort}"`,
      'username = "admin"',
      'password = "secret"',
    ].join('\n'));

    port = 19000 + Math.floor(Math.random() * 1000);
    proc = spawn(process.execPath, [HOST, `http://127.0.0.1:${stubPort}`], {
      cwd: ROOT,
      env: { ...process.env, PICO_PP_PORT: String(port), PICO_PP_READONLY: '1', PICO_CONFIG: configPath },
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
    // Real tokens from the authenticated response must pass through.
    assert.equal(body.previewToken, 'real-preview-token');
  });

  it('rewrites the config embedded in GET /api/v1/session responses', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/session`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.mode, 'public');
    assert.equal(body.config.public, true);
    assert.equal(body.user.Name, 'admin');
  });

  it('injects the upstream session token into proxied API requests', async () => {
    await fetch(`http://127.0.0.1:${port}/api/v1/config`);
    assert.equal(seenHeaders['GET /api/v1/config']['x-auth-token'], 'stub-session-id');
  });

  it('falls back to the backend for /static files missing from the UI bundle', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/static/img/avatar/tile_50.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(await res.text(), 'stub-jpeg-bytes');
  });

  it('still blocks writes (read-only appliance)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/photos/abc`, { method: 'PUT', body: '{}' });
    assert.equal(res.status, 403);
  });
});
