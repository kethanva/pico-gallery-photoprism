#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BRACE_GHSA = 'https://github.com/advisories/GHSA-mh99-v99m-4gvg';
const SEVERITY = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function versionParts(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function isPatchedBraceExpansion(version) {
  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor, patch] = parts;
  if (major === 1) return minor > 1 || (minor === 1 && patch >= 17);
  if (major === 2) return minor > 1 || (minor === 1 && patch >= 3);
  if (major === 3) return minor > 0 || (minor === 0 && patch >= 3);
  if (major === 4) return false;
  return major > 5 || (major === 5 && (minor > 0 || patch >= 8));
}

export function lockedBraceVersions(lock) {
  return Object.entries(lock?.packages || {})
    .filter(([path, pkg]) => path.endsWith('node_modules/brace-expansion') || pkg?.name === 'brace-expansion')
    .map(([, pkg]) => pkg.version)
    .filter(Boolean);
}

function advisoryIsOnlyBraceGhsa(vulnerability) {
  return vulnerability?.name === 'brace-expansion' &&
    Array.isArray(vulnerability.via) && vulnerability.via.length > 0 &&
    vulnerability.via.every((via) => typeof via === 'object' && via.url === BRACE_GHSA);
}

export function unwaivedVulnerabilities(report, braceVersions, minimumSeverity = 'high') {
  const vulnerabilities = report?.vulnerabilities || {};
  const waived = new Set();
  if (braceVersions.length > 0 && braceVersions.every(isPatchedBraceExpansion)) {
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      if (advisoryIsOnlyBraceGhsa(vulnerability)) waived.add(name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      if (waived.has(name) || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) continue;
      // Propagate only through named dependency edges. Direct advisory objects
      // must be independently evaluated above so an unpatched package can
      // never waive itself merely because its advisory URL is recognized.
      const allWaived = vulnerability.via.every((via) => typeof via === 'string' && waived.has(via));
      if (allWaived) {
        waived.add(name);
        changed = true;
      }
    }
  }

  const threshold = SEVERITY[minimumSeverity] ?? SEVERITY.high;
  return Object.entries(vulnerabilities)
    .filter(([name, vulnerability]) => !waived.has(name) && (SEVERITY[vulnerability.severity] ?? 0) >= threshold)
    .map(([name, vulnerability]) => ({ name, severity: vulnerability.severity }));
}

function auditDirectory(directory) {
  const cwd = resolve(directory);
  const lock = JSON.parse(readFileSync(resolve(cwd, 'package-lock.json'), 'utf8'));
  const braceVersions = lockedBraceVersions(lock);
  const audit = spawnSync('npm', ['audit', '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    throw new Error(`npm audit did not return valid JSON for ${directory}: ${audit.stderr.trim() || 'unknown error'}`);
  }
  const remaining = unwaivedVulnerabilities(report, braceVersions);
  if (remaining.length > 0) {
    throw new Error(`${directory}: unpatched high/critical advisories: ${remaining.map((item) => `${item.name} (${item.severity})`).join(', ')}`);
  }
  const braceNote = braceVersions.length > 0
    ? `; brace-expansion compatibility lines patched: ${[...new Set(braceVersions)].sort().join(', ')}`
    : '';
  console.log(`${directory}: dependency audit passed${braceNote}`);
}

async function main() {
  const directories = process.argv.slice(2);
  for (const directory of directories.length > 0 ? directories : ['.', 'frontend']) {
    auditDirectory(directory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
