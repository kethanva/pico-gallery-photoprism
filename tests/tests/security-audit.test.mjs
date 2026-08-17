import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPatchedBraceExpansion,
  lockedBraceVersions,
  unwaivedVulnerabilities,
} from '../../scripts/security-audit.mjs';

const braceVia = [{ url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg' }];

describe('dependency audit exception', () => {
  it('recognizes patched compatibility backports and rejects vulnerable releases', () => {
    for (const version of ['1.1.17', '1.1.18', '2.1.3', '2.1.4', '3.0.3', '5.0.8', '5.0.9']) {
      assert.equal(isPatchedBraceExpansion(version), true, version);
    }
    for (const version of ['1.1.16', '2.1.2', '3.0.2', '4.0.1', '5.0.7', 'invalid']) {
      assert.equal(isPatchedBraceExpansion(version), false, version);
    }
  });

  it('extracts every locked brace-expansion copy', () => {
    assert.deepEqual(lockedBraceVersions({ packages: {
      '': { name: 'app' },
      'node_modules/brace-expansion': { version: '1.1.18' },
      'node_modules/a/node_modules/brace-expansion': { version: '5.0.9' },
    } }), ['1.1.18', '5.0.9']);
  });

  it('waives only the exact brace advisory and vulnerabilities derived solely from it', () => {
    const report = { vulnerabilities: {
      'brace-expansion': { name: 'brace-expansion', severity: 'high', via: braceVia },
      minimatch: { name: 'minimatch', severity: 'high', via: ['brace-expansion'] },
      eslint: { name: 'eslint', severity: 'high', via: ['minimatch'] },
      unrelated: { name: 'unrelated', severity: 'critical', via: [{ url: 'https://example.test/other' }] },
    } };
    assert.deepEqual(unwaivedVulnerabilities(report, ['1.1.18', '5.0.9']), [
      { name: 'unrelated', severity: 'critical' },
    ]);
    assert.equal(unwaivedVulnerabilities(report, ['1.1.16']).some((item) => item.name === 'brace-expansion'), true);
  });
});
