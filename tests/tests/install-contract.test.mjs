import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const installer = readFileSync(join(ROOT, 'install.sh'), 'utf8');
const uninstaller = readFileSync(join(ROOT, 'uninstall.sh'), 'utf8');
const canary = readFileSync(join(ROOT, 'scripts/pi-canary.sh'), 'utf8');

describe('production installer contract', () => {
  it('runs a root-owned installed copy as the dedicated non-login account', () => {
    assert.match(installer, /readonly RUNTIME_DIR="\/opt\/picogallery"/);
    assert.match(installer, /useradd --system --user-group --home-dir \/nonexistent --shell \/usr\/sbin\/nologin/);
    assert.match(installer, /chown -R root:root "\$RUNTIME_DIR"/);
    assert.match(installer, /User=\$RUN_USER/);
    assert.match(installer, /ExecStart=\$node_bin \$RUNTIME_DIR\/scripts\/photoprism-host\.mjs/);
    assert.doesNotMatch(installer, /chown -R "\$RUN_USER:\$RUN_GROUP" "\$REPO_ROOT"/);
  });

  it('retains the required systemd containment controls', () => {
    for (const directive of [
      'NoNewPrivileges=true',
      'ProtectSystem=strict',
      'ProtectHome=read-only',
      'PrivateTmp=true',
      'PrivateDevices=true',
      'CapabilityBoundingSet=',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'MemoryMax=192M',
    ]) {
      assert.ok(installer.includes(directive), `missing systemd directive: ${directive}`);
    }
  });

  it('removes the installed runtime during both uninstall paths', () => {
    assert.match(installer, /rm -rf "\$CONFIG_DIR" "\$CACHE_DIR" "\$RUNTIME_DIR"/);
    assert.match(uninstaller, /readonly RUNTIME_DIR="\/opt\/picogallery"/);
    assert.match(uninstaller, /rm -rf "\$CONFIG_DIR" "\$CACHE_DIR" "\$STATE_DIR" "\$RUNTIME_DIR"/);
  });

  it('does not execute a mutable NodeSource setup script as root', () => {
    assert.doesNotMatch(installer, /setup_\$\{?NODE_MAJOR\}?\.x/);
    assert.match(installer, /signed-by=\/usr\/share\/keyrings\/nodesource\.gpg/);
  });

  it('fails the installation when a required verification check fails', () => {
    assert.match(installer, /if \[\[ "\$failures" -ne 0 \]\]; then/);
    assert.match(installer, /required verification check\(s\) failed/);
    assert.match(installer, /return 1/);
    assert.doesNotMatch(
      installer,
      /\[\[ "\$failures" -eq 0 \]\] \|\| warn[^\n]*\n\s*return 0/,
    );
  });

  it('ships a strict post-reboot Raspberry Pi canary', () => {
    for (const requiredCheck of [
      'picogallery-photoprism.service',
      '/api/v1/ready',
      '/library/photos',
      'picogallery-kiosk.service',
      'seatd.service',
      '$DEV_ROOT/dri/card*',
      '$PROC_ROOT/bus/input/devices',
      'CANARY FAILED',
    ]) {
      assert.ok(canary.includes(requiredCheck), `canary missing check: ${requiredCheck}`);
    }
    assert.match(canary, /if \[\[ "\$FAILURES" -ne 0 \]\]; then[\s\S]*exit 1/);
  });
});
