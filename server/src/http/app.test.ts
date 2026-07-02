import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';
import { RootConfigSchema } from '../config/index.js';

describe('HTTP app', () => {
  it('GET /api/v1/health returns ok', async () => {
    const app = await buildApp(RootConfigSchema.parse({}));
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('GET /api/v1/ready is 503 before the engine starts', async () => {
    const app = await buildApp(RootConfigSchema.parse({}));
    const res = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  // API spec §8.1: display config is served at GET /config (not /config/display).
  it('GET /api/v1/config returns the display config; the old path is gone', async () => {
    const app = await buildApp(RootConfigSchema.parse({}));
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ transition: expect.any(String) });
    const stale = await app.inject({ method: 'GET', url: '/api/v1/config/display' });
    expect(stale.statusCode).toBe(404);
    await app.close();
  });

  // The frame reads photoprismUrl from the display config to know where Esc goes.
  it('serves display.photoprismUrl to the frame when configured', async () => {
    const app = await buildApp(
      RootConfigSchema.parse({ display: { photoprismUrl: 'http://frame.local:8190/' } })
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ photoprismUrl: 'http://frame.local:8190/' });
    await app.close();
  });

  describe('with an auth token configured', () => {
    const cfg = () => RootConfigSchema.parse({ http: { authToken: 'secret' } });

    it('rejects a protected route without the token (from a non-local client)', async () => {
      const app = await buildApp(cfg());
      // A remote IP so the localhost kiosk bypass doesn't apply.
      const res = await app.inject({ method: 'GET', url: '/api/v1/slideshow/state', remoteAddress: '198.51.100.10' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
      await app.close();
    });

    it('lets a protected route through with the token (not a 401)', async () => {
      const app = await buildApp(cfg());
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/slideshow/state',
        headers: { authorization: 'Bearer secret' },
        remoteAddress: '198.51.100.10',
      });
      // Engine isn't started here, so this is a 503 — the point is it is NOT 401.
      expect(res.statusCode).not.toBe(401);
      await app.close();
    });

    it('accepts the token via ?token= query (EventSource/img fallback)', async () => {
      const app = await buildApp(cfg());
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/slideshow/state?token=secret',
        remoteAddress: '198.51.100.10',
      });
      expect(res.statusCode).not.toBe(401);
      await app.close();
    });

    it('bypasses the token for the localhost kiosk', async () => {
      const app = await buildApp(cfg());
      // Fastify inject defaults the socket peer to 127.0.0.1 → same-origin kiosk.
      const res = await app.inject({ method: 'GET', url: '/api/v1/slideshow/state' });
      expect(res.statusCode).not.toBe(401);
      await app.close();
    });

    it('does not let a spoofed X-Forwarded-For bypass the token', async () => {
      const app = await buildApp(cfg());
      // Remote socket peer, but a forged XFF claiming localhost. trustProxy makes
      // req.ip trust the header; the bypass must ignore it and still require a token.
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/slideshow/state',
        remoteAddress: '198.51.100.10',
        headers: { 'x-forwarded-for': '127.0.0.1' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('keeps health and readiness probes public', async () => {
      const app = await buildApp(cfg());
      const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(health.statusCode).toBe(200);
      const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      expect(ready.statusCode).toBe(503); // 503 = engine not ready, but reachable (not 401)
      await app.close();
    });
  });
});
