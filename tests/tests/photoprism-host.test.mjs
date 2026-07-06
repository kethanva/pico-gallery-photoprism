/* global process, fetch, setTimeout */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
});
