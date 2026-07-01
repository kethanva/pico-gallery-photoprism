import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from './loader.js';

const created: string[] = [];

async function writeConfig(toml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-cfg-'));
  created.push(dir);
  const path = join(dir, 'config.toml');
  await writeFile(path, toml);
  return path;
}

afterEach(async () => {
  delete process.env['PICO_CONFIG'];
  delete process.env['PICO_HTTP_PORT'];
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('applies schema defaults for an empty config', async () => {
    process.env['PICO_CONFIG'] = await writeConfig('');
    const cfg = await loadConfig();
    expect(cfg.http.port).toBe(8188);
    expect(cfg.sources).toEqual([]);
  });

  it('lets PICO_* env vars override file values', async () => {
    process.env['PICO_CONFIG'] = await writeConfig('[http]\nport = 8188\n');
    process.env['PICO_HTTP_PORT'] = '9999';
    const cfg = await loadConfig();
    expect(cfg.http.port).toBe(9999);
  });

  it('applies PICO_* overrides even when the file omits that section', async () => {
    process.env['PICO_CONFIG'] = await writeConfig(''); // no [http] table
    process.env['PICO_HTTP_PORT'] = '9999';
    const cfg = await loadConfig();
    expect(cfg.http.port).toBe(9999);
  });

  it('normalizes snake_case source keys to the camelCase schema', async () => {
    process.env['PICO_CONFIG'] = await writeConfig(
      [
        '[[sources]]',
        'name = "photoprism"',
        'url = "http://pp.local:2342"',
        'username = "admin"',
        'include_private = true',
        'skip_tls_verify = true',
      ].join('\n')
    );
    const cfg = await loadConfig();
    const src = cfg.sources[0];
    expect(src?.name).toBe('photoprism');
    if (src?.name === 'photoprism') {
      expect(src.includePrivate).toBe(true);
      expect(src.skipTlsVerify).toBe(true);
    }
  });

  it('fails fast with a clear message on invalid config', async () => {
    process.env['PICO_CONFIG'] = await writeConfig('[http]\nport = -1\n');
    await expect(loadConfig()).rejects.toThrow(/Invalid configuration/);
  });
});
