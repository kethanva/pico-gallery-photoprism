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

  describe('with an auth token configured', () => {
    const cfg = () => RootConfigSchema.parse({ http: { authToken: 'secret' } });

    it('rejects a protected route without the token', async () => {
      const app = await buildApp(cfg());
      const res = await app.inject({ method: 'GET', url: '/api/v1/slideshow/state' });
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
      });
      // Engine isn't started here, so this is a 503 — the point is it is NOT 401.
      expect(res.statusCode).not.toBe(401);
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
