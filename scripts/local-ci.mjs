#!/usr/bin/env node
// Mirrors .github/workflows/ci.yml's job graph exactly (same jobs, same
// commands, same `needs: concept-guard` dependency) so a green run here
// is the same evidence a green GitHub Actions run would be — for use
// when Actions itself is unavailable (rate/spend limited on a private
// repo, an outage, or Actions not yet enabled on a fork). This is a
// fallback, not a routine substitute: this runs under whichever
// account/session invokes it, not a third party GitHub sees
// independently, so treat a real green Actions run as the stronger
// signal whenever both are actually available — see AGENTS.md/this
// repo's own "CI/current-head evidence is not confused with AI
// self-report" discipline. Anyone (human or AI) reporting "local-ci
// passed" should say so explicitly, the same way they'd cite a real CI
// run, rather than silently presenting it as the same kind of evidence.
//
// Usage: node scripts/local-ci.mjs [--fresh] [--job=<name>]
//   --fresh        Force `npm install` in every job even if node_modules
//                   already exists (matches a clean CI checkout exactly;
//                   default only installs when node_modules is missing,
//                   for fast iterative local runs).
//   --job=<name>   Run only one job (concept-guard / app-build /
//                   worker-check / chatgpt-bridge-check) plus whatever
//                   it needs. Useful while iterating on one area.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const FRESH = process.argv.includes('--fresh');
const ONLY = process.argv.find((arg) => arg.startsWith('--job='))?.slice('--job='.length);
const SUMMARY_DIR = path.join(ROOT, '.local-ci');
const SUMMARY_FILE = path.join(SUMMARY_DIR, 'latest.json');

function needsInstall(dir) {
  return FRESH || !fs.existsSync(path.join(dir, 'node_modules'));
}

const JOBS = [
  {
    name: 'concept-guard',
    cwd: ROOT,
    needs: [],
    steps: [['node', ['scripts/concept-guard.mjs']]],
  },
  {
    name: 'app-build',
    cwd: ROOT,
    needs: ['concept-guard'],
    steps: [
      ...(needsInstall(ROOT) ? [['npm', ['install']]] : []),
      ['npm', ['run', 'build']],
      ['npm', ['run', 'bundle:budget']],
    ],
  },
  {
    name: 'worker-check',
    cwd: path.join(ROOT, 'worker'),
    needs: ['concept-guard'],
    steps: [
      ...(needsInstall(path.join(ROOT, 'worker')) ? [['npm', ['install']]] : []),
      ['npm', ['run', 'typecheck']],
      ['npm', ['test']],
      ['npm', ['run', 'dry-run']],
    ],
  },
  {
    name: 'chatgpt-bridge-check',
    cwd: path.join(ROOT, 'chatgpt-bridge'),
    needs: ['concept-guard'],
    steps: [
      ...(needsInstall(path.join(ROOT, 'chatgpt-bridge')) ? [['npm', ['install']]] : []),
      ['npm', ['run', 'check']],
    ],
  },
];

if (ONLY && !JOBS.some((job) => job.name === ONLY)) {
  console.error(`local-ci: unknown --job=${ONLY}. Known jobs: ${JOBS.map((job) => job.name).join(', ')}`);
  process.exit(1);
}
// --job=X runs X plus whatever it directly needs (this repo's job graph
// is only one level deep — nothing here needs a job that itself needs
// another — so a direct `needs` lookup is enough, no transitive walk).
const target = ONLY && JOBS.find((job) => job.name === ONLY);
const toRun = target ? JOBS.filter((job) => job.name === target.name || target.needs.includes(job.name)) : JOBS;

const results = [];
const passedJobs = new Set();

for (const job of toRun) {
  const blockedBy = job.needs.find((dep) => !passedJobs.has(dep));
  if (blockedBy) {
    console.log(`\n=== ${job.name} — SKIPPED (needs "${blockedBy}", which did not pass) ===`);
    results.push({ name: job.name, status: 'skipped', durationMs: 0 });
    continue;
  }

  console.log(`\n=== ${job.name} ===`);
  const start = Date.now();
  let failed = false;
  for (const [command, args] of job.steps) {
    console.log(`$ ${command} ${args.join(' ')}  (in ${path.relative(ROOT, job.cwd) || '.'})`);
    const result = spawnSync(command, args, { cwd: job.cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
      failed = true;
      break;
    }
  }
  const durationMs = Date.now() - start;
  results.push({ name: job.name, status: failed ? 'failed' : 'passed', durationMs });
  if (!failed) passedJobs.add(job.name);
  console.log(`=== ${job.name}: ${failed ? 'FAILED' : 'passed'} (${(durationMs / 1000).toFixed(1)}s) ===`);
}

fs.mkdirSync(SUMMARY_DIR, { recursive: true });
fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ ranAt: new Date().toISOString(), fresh: FRESH, results }, null, 2));

console.log('\n--- local-ci summary ---');
for (const result of results) {
  const icon = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '−';
  console.log(`${icon} ${result.name}: ${result.status}${result.durationMs ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : ''}`);
}
console.log(`Summary written to ${path.relative(ROOT, SUMMARY_FILE)}`);

const anyFailedOrSkipped = results.some((result) => result.status !== 'passed');
if (anyFailedOrSkipped) {
  console.error('\nlocal-ci: FAILED');
  process.exit(1);
}
console.log('\nlocal-ci: all jobs passed — equivalent to a green GitHub Actions run on this exact working tree.');
