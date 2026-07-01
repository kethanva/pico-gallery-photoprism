import type { PhotoSource } from './source.js';
import type { SourceConfig } from '../config/index.js';
import { PhotoPrismSource } from './photoprism.js';
import { WebDavSource } from './webdav.js';
import { logger } from '../telemetry/logger.js';

export async function buildSources(configs: SourceConfig[]): Promise<Map<string, PhotoSource>> {
  const sources = new Map<string, PhotoSource>();
  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    let source: PhotoSource;
    switch (cfg.name) {
      case 'photoprism': source = new PhotoPrismSource(); break;
      case 'webdav': source = new WebDavSource(); break;
      default: {
        logger.warn({ name: (cfg as { name: string }).name }, 'Unknown source');
        continue;
      }
    }
    try {
      await source.init(cfg);
      sources.set(cfg.name, source);
      logger.info({ name: cfg.name }, 'Source initialized');
    } catch (err) {
      logger.error({ name: cfg.name, err }, 'Source init failed');
    }
  }
  return sources;
}
