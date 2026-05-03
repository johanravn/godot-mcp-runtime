#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const snapshotPath = resolve(repoRoot, 'scripts', 'cross-platform-lockfile-entries.json');

const LOG_PREFIX = '[pre-commit]';

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

let stagedFiles;
try {
  stagedFiles = git(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean);
} catch (err) {
  console.error(`${LOG_PREFIX} failed to list staged files: ${err.message}`);
  process.exit(0);
}

if (!stagedFiles.includes('package-lock.json')) {
  process.exit(0);
}

if (!existsSync(snapshotPath)) {
  console.warn(`${LOG_PREFIX} snapshot file missing; skipping lockfile guard`);
  process.exit(0);
}

let stagedLockfile;
try {
  stagedLockfile = JSON.parse(git(['show', ':package-lock.json']));
} catch (err) {
  console.error(`${LOG_PREFIX} failed to read staged package-lock.json: ${err.message}`);
  process.exit(0);
}

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
} catch (err) {
  console.error(`${LOG_PREFIX} snapshot file is malformed: ${err.message}`);
  process.exit(1);
}

const required = Object.keys(snapshot.entries ?? {});
const missing = required.filter(
  (key) => !Object.prototype.hasOwnProperty.call(stagedLockfile.packages ?? {}, key),
);

if (missing.length === 0) {
  process.exit(0);
}

console.error('');
console.error(
  `${LOG_PREFIX} package-lock.json is missing cross-platform entries that CI requires:`,
);
for (const key of missing) console.error(`  - ${key}`);
console.error('');
console.error(`${LOG_PREFIX} fix:`);
console.error(`  npm run safe-install      # restores from snapshot, then re-stage and retry`);
console.error('');
console.error(`${LOG_PREFIX} or copy the missing blocks from the last good lockfile:`);
console.error(`  git log --oneline -- scripts/cross-platform-lockfile-entries.json`);
console.error('');
process.exit(1);
