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
  });
});
