import { loadConfig } from './config/index.js';
import { buildSources } from './sources/registry.js';
import { SlideshowEngine, setEngine } from './engine/index.js';
import { buildApp } from './http/app.js';
import { tuneSharpForHost } from './images/service.js';
import { logger } from './telemetry/logger.js';

async function main(): Promise<void> {
  logger.info('pico-gallery v2 starting');
  tuneSharpForHost();

  const cfg = await loadConfig();
  logger.info({ port: cfg.http.port, sources: cfg.sources.length }, 'Config loaded');

  // Start HTTP server immediately so Vite proxy and health checks work during source loading
  const app = await buildApp(cfg);
  await app.listen({ host: cfg.http.host, port: cfg.http.port });
  logger.info({ url: `http://${cfg.http.host}:${cfg.http.port}` }, 'Server listening');

  // Load sources and build playlist in background — /ready returns 503 until done
  const sources = await buildSources(cfg.sources);
  const engine = new SlideshowEngine(sources, cfg);
  setEngine(engine);
  await engine.start();
  logger.info({ total: engine.getState().total }, 'Engine ready');

  const shutdown = async () => {
    logger.info('Shutting down');
    engine.stop();
    for (const source of sources.values()) await source.dispose();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
