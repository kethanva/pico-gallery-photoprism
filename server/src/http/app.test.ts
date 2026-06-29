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
});
