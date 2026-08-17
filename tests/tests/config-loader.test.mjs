import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePicoConfig, selectPhotoPrismSource } from '../../scripts/config-loader.mjs';

describe('structural PicoGallery config loader', () => {
  it('keeps credentials paired with the selected PhotoPrism source', () => {
    const config = parsePicoConfig(`
      [[sources]]
      name = "webdav"
      url = "https://dav.example.test/photos"
      username = "dav-user"
      password = "dav-password"

      [[sources]]
      name = "photoprism"
      enabled = true
      url = "https://photos.example.test"
      username = "viewer"
      app_password = "viewer-app-password"
    `);
    assert.deepEqual(selectPhotoPrismSource(config), {
      name: 'photoprism', enabled: true, url: 'https://photos.example.test',
      username: 'viewer', app_password: 'viewer-app-password',
    });
  });

  it('ignores commented secrets and supports inline comments', () => {
    const config = parsePicoConfig(`
      [http]
      host = "127.0.0.1" # safe default
      # auth_token = "must-not-match"
    `);
    assert.deepEqual(config.http, { host: '127.0.0.1' });
  });

  it('parses escaped strings and nested scalar tables', () => {
    const config = parsePicoConfig('[display]\nslide_duration_secs = 12\nratio = 1.5\n[display.night]\nstart = "21:00"\npeople = ["Alice", "Bob"]');
    assert.equal(config.display.slide_duration_secs, 12);
    assert.equal(config.display.ratio, 1.5);
    assert.equal(config.display.night.start, '21:00');
    assert.deepEqual(config.display.night.people, ['Alice', 'Bob']);
  });

  it('fails closed on invalid syntax and ambiguous PhotoPrism sources', () => {
    assert.throws(() => parsePicoConfig('[http]\nhost = unquoted'), /unsupported TOML value/);
    assert.throws(() => parsePicoConfig('[http]\nport = 8190\nport = 9000'), /duplicate key port/);
    assert.throws(() => selectPhotoPrismSource(parsePicoConfig(`
      [[sources]]
      name = "photoprism"
      [[sources]]
      name = "photoprism"
    `)), /multiple enabled/);
  });

  it('rejects prototype pollution vectors across tables and keys', () => {
    assert.throws(() => parsePicoConfig('__proto__ = "polluted"'), /prototype pollution vector blocked/);
    assert.throws(() => parsePicoConfig('prototype = "polluted"'), /prototype pollution vector blocked/);
    assert.throws(() => parsePicoConfig('constructor = "polluted"'), /prototype pollution vector blocked/);
    assert.throws(() => parsePicoConfig('[__proto__]\npolluted = true'), /prototype pollution vector blocked/);
    assert.throws(() => parsePicoConfig('[safe.__proto__]\npolluted = true'), /prototype pollution vector blocked/);
    assert.throws(() => parsePicoConfig('[[__proto__]]\npolluted = true'), /prototype pollution vector blocked/);
  });

  it('parses single-quoted strings and preserves literal hashes inside quotes', () => {
    const config = parsePicoConfig(`
      [http]
      auth_token = 'secret-token-with-single-quotes-24chars'
      host = '127.0.0.1' # inline comment

      [[sources]]
      name = 'photoprism'
      url = 'https://photos.example.test/app#gallery' # comment with hash
      username = 'single-user'
      password = 'p@ss#word!'
    `);
    assert.equal(config.http.auth_token, 'secret-token-with-single-quotes-24chars');
    assert.equal(config.http.host, '127.0.0.1');
    const source = selectPhotoPrismSource(config);
    assert.equal(source.url, 'https://photos.example.test/app#gallery');
    assert.equal(source.password, 'p@ss#word!');
  });

  it('selectPhotoPrismSource ignores sources with enabled = false', () => {
    const config = parsePicoConfig(`
      [[sources]]
      name = "photoprism"
      enabled = false
      url = "https://disabled.example.test"

      [[sources]]
      name = "photoprism"
      enabled = true
      url = "https://active.example.test"
    `);
    assert.equal(selectPhotoPrismSource(config).url, 'https://active.example.test');
  });

  it('rejects nested array tables with an explicit error', () => {
    assert.throws(
      () => parsePicoConfig('[[sources.nested]]\nname = "invalid"'),
      /nested array tables are not supported/,
    );
  });
});
