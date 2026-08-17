import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CANARY = join(ROOT, 'scripts/pi-canary.sh');
const fixtures = [];

function executable(path, contents) {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pico-canary-'));
  fixtures.push(root);
  const runtime = join(root, 'runtime');
  const assets = join(runtime, 'frontend/dist/static/build');
  const bin = join(root, 'bin');
  const proc = join(root, 'proc');
  const dev = join(root, 'dev');
  const etc = join(root, 'etc');
  for (const path of [assets, bin, join(proc, 'device-tree'), join(proc, 'bus/input'), join(dev, 'dri'), join(etc, 'systemd/system')]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(proc, 'device-tree/model'), 'Raspberry Pi Zero 2 W\0');
  writeFileSync(join(proc, 'bus/input/devices'), 'H: Handlers=sysrq kbd event0\n');
  writeFileSync(join(dev, 'dri/card0'), '');
  writeFileSync(join(assets, 'assets.json'), JSON.stringify({ 'app.js': 'app.js', 'app.css': 'app.css' }));
  writeFileSync(join(assets, 'app.js'), '');
  writeFileSync(join(assets, 'app.css'), '');

  executable(join(bin, 'systemctl'), `#!/usr/bin/env bash
unit="\${!#}"
[[ "\${PICO_TEST_FAIL_UNIT:-}" == "$unit" ]] && exit 1
exit 0
`);
  executable(join(bin, 'journalctl'), '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'curl'), `#!/usr/bin/env bash
out=""
url="\${!#}"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
case "$url" in
  */api/v1/config) printf '{"mode":"public"}' >"$out" ;;
  */library/photos) printf "<script src='/static/build/assets.json'></script>" >"$out" ;;
  *) printf '{}' >"$out" ;;
esac
printf '200'
`);
  return { root, runtime, bin, proc, dev, etc };
}

function runCanary(f, extraEnv = {}, args = []) {
  return spawnSync(CANARY, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      PICO_CANARY_ROOT: f.runtime,
      PICO_CANARY_PROC_ROOT: f.proc,
      PICO_CANARY_DEV_ROOT: f.dev,
      PICO_CANARY_ETC_ROOT: f.etc,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe('Raspberry Pi post-reboot canary', () => {
  it('returns success only when all appliance invariants pass', () => {
    const result = runCanary(fixture());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CANARY PASSED/);
  });

  it('returns failure when a required service is inactive', () => {
    const result = runCanary(fixture(), { PICO_TEST_FAIL_UNIT: 'picogallery-kiosk.service' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /picogallery-kiosk\.service is not active/);
    assert.match(result.stderr, /CANARY FAILED/);
  });

  it('supports --server-only flag to bypass display/input checks', () => {
    const f = fixture();
    rmSync(join(f.dev, 'dri/card0'));
    writeFileSync(join(f.proc, 'bus/input/devices'), '');

    const result = runCanary(f, {}, ['--server-only']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CANARY PASSED/);
  });

  it('fails when conflicting legacy systemd services exist in /etc', () => {
    const f = fixture();
    writeFileSync(join(f.etc, 'systemd/system/photoprism-kiosk.service'), '');
    const result = runCanary(f);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicting legacy kiosk unit exists: photoprism-kiosk\.service/);
  });
});
