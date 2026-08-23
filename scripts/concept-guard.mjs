import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const passes = [];

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relativePath}: required file is missing`);
    return '';
  }
  return fs.readFileSync(absolute, 'utf8');
}

function pass(message) {
  passes.push(message);
}

function assert(condition, message) {
  if (condition) pass(message);
  else failures.push(message);
}

function containsAll(file, phrases) {
  const content = read(file);
  for (const phrase of phrases) {
    assert(content.includes(phrase), `${file}: must retain concept phrase ${JSON.stringify(phrase)}`);
  }
  return content;
}

function noMatch(file, patterns) {
  const content = read(file);
  for (const pattern of patterns) {
    assert(!pattern.test(content), `${file}: forbidden concept-boundary pattern matched ${pattern}`);
  }
}

let manifest = null;
try {
  manifest = JSON.parse(read('product-concept.json'));
} catch (error) {
  failures.push(`product-concept.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
}

if (manifest) {
  assert(manifest.conceptId === 'multi-chat-remote-v1', 'manifest: conceptId remains multi-chat-remote-v1');
  assert(manifest.roles?.executor === 'chatgpt', 'manifest: ChatGPT remains executor');
  assert(manifest.roles?.pwa === 'multi-chat-control-plane', 'manifest: PWA remains the multi-chat control plane');
  assert(manifest.roles?.externalLlm === 'orchestration-only', 'manifest: external LLM remains orchestration-only');
  assert(manifest.safety?.externalLlmGithubWrite === false, 'manifest: external LLM GitHub write remains disabled');
  assert(manifest.safety?.automaticMerge === false, 'manifest: automatic merge remains disabled');
  assert(manifest.safety?.automaticProductionDeploy === false, 'manifest: automatic production deploy remains disabled');
  assert(manifest.safety?.chatSessionCookieAutomation === false, 'manifest: ChatGPT session-cookie automation remains disabled');
  assert(manifest.safety?.evidenceRequiredForCompletion === true, 'manifest: evidence remains required for completion');
  assert(Array.isArray(manifest.invariants) && manifest.invariants.length >= 9, 'manifest: product invariants remain explicit');
  assert(Array.isArray(manifest.antiGoals) && manifest.antiGoals.length >= 5, 'manifest: anti-goals remain explicit');

  for (const protectedFile of manifest.protectedArchitectureFiles ?? []) {
    assert(fs.existsSync(path.join(root, protectedFile)), `manifest: protected architecture file exists: ${protectedFile}`);
  }
}

containsAll('docs/PRODUCT_CONSTITUTION.md', [
  '複数のChatGPT開発チャット',
  'ChatGPT = executor',
  'PWA = multi-chat control plane',
  'External LLM = orchestration-only',
  'Multi Chat Remote first',
  'Evidence over self-report',
  'No implicit merge/deploy',
]);

containsAll('docs/ARCHITECTURE.md', [
  '複数チャット同時並行',
  'ここで使っているChatGPT開発チャットを、そのまま複数束ねて遠隔操作すること',
  'Multi Chat Remoteをより放置可能にするための補助層',
  'ChatGPT execution',
  'Supervisor自身はコードを実装しない',
]);

containsAll('README.md', [
  '実作業はChatGPT',
  'オーケストレーション専用',
]);

const workerIndex = containsAll('worker/src/index.ts', [
  "executor: 'chatgpt'",
  'orchestrationOnly: true',
  'deprecated_background_executor',
  'chatCommandBus: true',
]);
assert(/\/webhooks\/openai[\s\S]{0,500}deprecated_background_executor/.test(workerIndex), 'worker: deprecated external background executor stays disabled');

containsAll('worker/src/orchestratorPolicy.ts', [
  'ChatGPT',
]);

const bridge = containsAll('chatgpt-bridge/src/bridgeApp.ts', [
  'assertAllowedProject',
  'sendFollowUpMessage',
  'ai_dev_deck_bridge_claim',
  'ai_dev_deck_bridge_result',
]);
assert(/allowedProjectIds/.test(bridge), 'bridge: project allowlist remains part of runtime boundary');

noMatch('chatgpt-bridge/src/bridgeApp.ts', [
  /document\.cookie/i,
  /chatgpt[_-]?session[_-]?token/i,
  /authorization\s*:\s*[`'"]Bearer\s+[^$]/i,
]);

for (const file of [
  'worker/src/index.ts',
  'worker/src/developerAgent.ts',
  'worker/src/guardianRunner.ts',
]) {
  noMatch(file, [
    /merge_pull_request\s*\(/i,
    /mergePullRequest\s*\(/,
    /autoMerge\s*:\s*true/i,
    /productionDeploy\s*\(/i,
  ]);
}

console.log(`Concept Guard: ${passes.length} checks passed.`);
if (failures.length) {
  console.error(`Concept Guard: ${failures.length} violation(s) found:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nRead docs/PRODUCT_CONSTITUTION.md before changing protected architecture boundaries.');
  process.exit(1);
}
console.log('Concept Guard: product direction and safety boundaries are intact.');
