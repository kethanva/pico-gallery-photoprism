import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKioskConfig, parseKioskTomlOverrides } from '../../scripts/kiosk-config.mjs';

describe('kiosk-config (host)', () => {
  it('parses [kiosk] overrides from config.toml', () => {
    const toml = `
[display]
slide_duration_secs = 15

[kiosk]
profile = "balanced"
preview_size = "fit_720"
max_grid_rows = 14
background_fill_target = 0
`;
    const overrides = parseKioskTomlOverrides(toml);
    assert.equal(overrides.profile, 'balanced');
    assert.equal(overrides.previewSize, 'fit_720');
    assert.equal(overrides.maxGridRows, 14);
    assert.equal(overrides.backgroundFillTarget, 0);
  });

  it('buildKioskConfig merges display slide duration and profile', () => {
    const cfg = buildKioskConfig({
      toml: '[kiosk]\nprofile = "pi_zero_2"\n',
      slideDurationSecs: 18,
    });
    assert.equal(cfg.profile, 'pi_zero_2');
    assert.equal(cfg.slideDuration, 18);
    assert.equal(cfg.previewSize, 'fit_720');
  });

  it('defaults to pi_zero_2 profile with no config or env', () => {
    const cfg = buildKioskConfig();
    assert.equal(cfg.profile, 'pi_zero_2');
    assert.equal(cfg.previewSize, 'fit_720');
    assert.equal(cfg.maxGridRows, 10);
    assert.equal(cfg.slideDuration, 12);
    assert.equal(cfg.thumbLoadConcurrency, 4);
  });

  it('supports single-quoted values in [kiosk] section', () => {
    const toml = `
[kiosk]
profile = 'pi_zero_2'
preview_size = 'fit_1280'
`;
    const overrides = parseKioskTomlOverrides(toml);
    assert.equal(overrides.profile, 'pi_zero_2');
    assert.equal(overrides.previewSize, 'fit_1280');
  });

  it('supports environment variable overrides for profile parameters', () => {
    const env = {
      PICO_KIOSK_PROFILE: 'quality',
      PICO_KIOSK_PREVIEW_SIZE: 'fit_1280',
      PICO_KIOSK_THUMB_SIZE: 'fit_720',
      PICO_KIOSK_MAX_GRID_ROWS: '16',
      PICO_KIOSK_BACKGROUND_FILL_TARGET: '50',
    };
    const cfg = buildKioskConfig({ env });
    assert.equal(cfg.profile, 'quality');
    assert.equal(cfg.previewSize, 'fit_1280');
    assert.equal(cfg.thumbSize, 'fit_720');
    assert.equal(cfg.maxGridRows, 16);
    assert.equal(cfg.backgroundFillTarget, 50);
  });

  it('clamps extreme and negative values to safe profile bounds', () => {
    const toml = `
[kiosk]
max_grid_rows = 999
slide_duration = 1
restore_row_batch = 0
thumb_load_concurrency = 99
`;
    const cfg = buildKioskConfig({ toml });
    assert.equal(cfg.maxGridRows, 24);
    assert.equal(cfg.slideDuration, 3);
    assert.equal(cfg.restoreRowBatch, 1);
    assert.equal(cfg.thumbLoadConcurrency, 8);
  });
});
