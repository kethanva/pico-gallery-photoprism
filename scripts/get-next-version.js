#!/usr/bin/env node

/* global require */

/**
 * determine-version.js
 * Analyzes git history to find the latest tag reachable from the current commit
 * and determines the next semantic version bump based on commit messages.
 * 
 * Outputs are written to GITHUB_OUTPUT for use in GitHub Actions.
 */

const { execSync } = require('child_process');
const fs = require('fs');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}

function main() {
  // 1. Get the latest tag by semver sorting all tags in the repository
  const allTags = run('git tag --list --sort=-v:refname').split('\n').map(t => t.trim()).filter(Boolean);
  let latestTag = allTags.length > 0 ? allTags[0] : '';

  // No tags at all (fresh repo, or the tags were deleted from the remote): base
  // the next version on package.json and treat the FULL history as unreleased.
  // The previous hardcoded fallback ("v2.7.3") named a tag that did not exist,
  // which made `git log <tag>..HEAD` below fail silently, so the release step
  // skipped on every push — no tarball was ever published and the appliance
  // had nothing to download.
  let baselineOnly = false;
  if (!latestTag) {
    let pkgVersion = '0.0.0';
    try {
      pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version || pkgVersion;
    } catch {
      // keep default
    }
    latestTag = `v${pkgVersion}`;
    baselineOnly = true;
    console.log(`No tags found in repository. Using package.json baseline ${latestTag}.`);
  }

  console.log(`Latest tag found: ${latestTag}`);

  // 2. Check if the current HEAD is already tagged with this latest tag
  const headTags = run('git tag --points-at HEAD').split('\n').map(t => t.trim()).filter(Boolean);
  if (headTags.includes(latestTag)) {
    console.log('HEAD is already tagged with the latest tag. Skipping release.');
    setOutput('skip', 'true');
    setOutput('tag', latestTag);
    setOutput('version', latestTag.replace(/^v/, ''));
    return;
  }

  // 3. Get the unreleased commits. Only use a `<tag>..HEAD` range when the tag
  // actually resolves — with a baseline "tag" (or a deleted ref) that range
  // errors out and would be indistinguishable from "no new commits".
  const tagExists = !baselineOnly && run(`git rev-parse -q --verify refs/tags/${latestTag}`) !== '';
  const commitsStr = tagExists ? run(`git log ${latestTag}..HEAD --format=%s`) : run('git log --format=%s');
  if (!commitsStr) {
    console.log('No new commits found since the latest tag. Skipping release.');
    setOutput('skip', 'true');
    setOutput('tag', latestTag);
    setOutput('version', latestTag.replace(/^v/, ''));
    return;
  }

  const commitMessages = commitsStr.split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`Found ${commitMessages.length} commits since ${latestTag}:`);
  commitMessages.forEach(msg => console.log(`  - ${msg}`));

  // 4. Analyze commit messages for semver bumps
  let major = false;
  let minor = false;
  let patch = false;

  for (const msg of commitMessages) {
    // Check for breaking changes:
    // - Contains "BREAKING CHANGE:" or "BREAKING CHANGES:"
    // - Conventional commit format with `!` before the colon: e.g. "feat!(scope): message" or "fix!:"
    const isBreaking = msg.includes('BREAKING CHANGE') || /^[a-z]+(\([a-z0-9_-]+\))?!:/.test(msg);
    if (isBreaking) {
      major = true;
    } else if (msg.startsWith('feat')) {
      minor = true;
    } else {
      patch = true; // default fallback for any commit (fix, chore, docs, refactor, style, etc.)
    }
  }

  // 5. Calculate next version
  const match = latestTag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    console.log(`Latest tag "${latestTag}" does not match semver format. Defaulting to minor bump of v2.7.3.`);
    setOutput('skip', 'false');
    setOutput('tag', 'v2.8.0');
    setOutput('version', '2.8.0');
    return;
  }

  let x = parseInt(match[1], 10);
  let y = parseInt(match[2], 10);
  let z = parseInt(match[3], 10);

  if (major) {
    x += 1;
    y = 0;
    z = 0;
  } else if (minor) {
    y += 1;
    z = 0;
  } else if (patch) {
    z += 1;
  } else {
    // If no changes, skip
    console.log('No semantic changes detected. Skipping release.');
    setOutput('skip', 'true');
    setOutput('tag', latestTag);
    setOutput('version', latestTag.replace(/^v/, ''));
    return;
  }

  const nextVersion = `${x}.${y}.${z}`;
  const nextTag = `v${nextVersion}`;

  console.log(`Calculated next version: ${nextTag} (Major: ${major}, Minor: ${minor}, Patch: ${patch})`);
  setOutput('skip', 'false');
  setOutput('tag', nextTag);
  setOutput('version', nextVersion);
}

main();
