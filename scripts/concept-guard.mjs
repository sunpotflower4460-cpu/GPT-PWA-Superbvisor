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
  return content;
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
  assert(manifest.roles?.coordinator === 'strongly-consistent-multi-device-control', 'manifest: coordinator remains the strong-consistency boundary');
  assert(manifest.experience?.primarySendPath === 'pwa-to-chat-control-bus-to-chatgpt-bridge', 'manifest: normal send path remains PWA -> Control Bus -> ChatGPT Bridge');
  assert(manifest.experience?.clipboardIsFallbackOnly === true, 'manifest: clipboard remains fallback-only');
  assert(manifest.experience?.routineChatWaitingIsHumanRequired === false, 'manifest: routine ChatGPT waiting is not human-required');
  assert(manifest.experience?.chatCanAutoContinue === true, 'manifest: CHAT can auto-continue in automation modes');
  assert(manifest.experience?.autopilotNextTurnAutoQueue === true, 'manifest: Autopilot next turns auto-queue');
  assert(manifest.experience?.recoveryNextTurnAutoQueue === true, 'manifest: recoverable next turns auto-queue');
  assert(manifest.experience?.legacyApiWorkerExecutorVisible === false, 'manifest: legacy API worker executor remains hidden/removed');
  assert(manifest.experience?.responseMirrorRequiresOfficialTransport === true, 'manifest: response mirroring requires supported transport');
  assert(manifest.experience?.atomicCoordinatorRequiredForMultiDevice === true, 'manifest: multi-device control requires atomic coordination');
  assert(manifest.experience?.singleClaimOwnerRequired === true, 'manifest: one active command claim owner is required');
  assert(manifest.experience?.deliveryRetryPreservesCommandIdentity === true, 'manifest: delivery retries preserve command identity');
  assert(manifest.experience?.multiChatOverviewRequired === true, 'manifest: all managed ChatGPT projects remain visible in the primary overview');
  assert(manifest.experience?.overviewUsesBatchTransport === true, 'manifest: multi-chat overview remains batch-oriented');
  assert(manifest.experience?.overviewPollingAvoidsCommandBodyReads === true, 'manifest: overview polling stays summary-only');
  assert(manifest.experience?.mobileJsGzipBudgetKiB === 130, 'manifest: JavaScript mobile budget remains 130 KiB gzip');
  assert(manifest.experience?.mobileCssGzipBudgetKiB === 20, 'manifest: CSS mobile budget remains 20 KiB gzip');
  assert(manifest.safety?.externalLlmGithubWrite === false, 'manifest: external LLM GitHub write remains disabled');
  assert(manifest.safety?.automaticMerge === false, 'manifest: automatic merge remains disabled');
  assert(manifest.safety?.automaticProductionDeploy === false, 'manifest: automatic production deploy remains disabled');
  assert(manifest.safety?.chatSessionCookieAutomation === false, 'manifest: ChatGPT session-cookie automation remains disabled');
  assert(manifest.safety?.evidenceRequiredForCompletion === true, 'manifest: evidence remains required for completion');
  assert(Array.isArray(manifest.invariants) && manifest.invariants.length >= 15, 'manifest: product invariants remain explicit');
  assert(Array.isArray(manifest.antiGoals) && manifest.antiGoals.length >= 14, 'manifest: anti-goals remain explicit');

  for (const protectedFile of manifest.protectedArchitectureFiles ?? []) {
    assert(fs.existsSync(path.join(root, protectedFile)), `manifest: protected architecture file exists: ${protectedFile}`);
  }
}

containsAll('docs/PRODUCT_CONSTITUTION.md', [
  '複数のChatGPT開発チャット',
  'ChatGPT = executor',
  'PWA = multi-chat control plane',
  'Project Coordinator = strong consistency boundary',
  'External LLM = orchestration-only',
  'Multi Chat Remote first',
  'Evidence over self-report',
  'No implicit merge/deploy',
  'Control Bus first, clipboard fallback second',
  'AUTO means ChatGPT can continue',
  'Platform limitations must be represented honestly',
  'Multi-device coordination must be strongly consistent',
  'One command, one active claim owner',
  'All managed chats stay visible from the primary control view',
  'compact batch transport',
]);

containsAll('docs/ARCHITECTURE.md', [
  '複数チャット同時並行',
  'ここで使っているChatGPT開発チャットを、そのまま複数束ねて遠隔操作すること',
  'Multi Chat Remoteをより放置可能にするための補助層',
  'Project Coordinator / strong consistency boundary',
  'SQLite-backed Cloudflare Durable Object',
  'Guardian runの短期execution lease取得 / renew / release',
  'ChatGPT execution',
  'Supervisor自身はコードを実装しない',
  '通常の送信経路は `PWA → Chat Control Bus → ChatGPT Bridge → 対象ChatGPT`',
  'ChatGPT返答本文を外部PWAへ読み戻す公式transport',
]);

containsAll('README.md', [
  '実作業はChatGPT',
  'オーケストレーション専用',
]);

const app = containsAll('src/App.tsx', [
  'enqueueProjectChatCommand',
  'Chat Controlを開く',
  '実行者はChatGPT固定',
]);
assert(!app.includes("'API_WORKER'"), 'app: legacy API_WORKER executor is not exposed in the primary UI');
assert(!app.includes('タップでコピー'), 'app: primary quick actions are not clipboard-first');

const chatControlUi = containsAll('src/ChatControlCenter.tsx', [
  'getChatControlOverview',
  'overviewSummary',
  'chat-project-remote',
  '全体:',
  '8000',
  'OVERVIEW_ERROR',
  'cancelProjectChatCommand',
  '自動Queueを止めて手動送信',
  "document.addEventListener('visibilitychange'",
  "window.addEventListener('online'",
  "window.addEventListener('focus'",
]);
assert(chatControlUi.includes('chatProjectActivityLabel'), 'chat control: every project can surface live remote activity in the rail');
assert(chatControlUi.includes('Object.fromEntries'), 'chat control: batch overview is mapped across all visible projects');
assert((chatControlUi.match(/let refreshing = false;/g) ?? []).length >= 2, 'chat control: selected-detail and all-chat polling prevent overlapping refresh races');
assert((chatControlUi.match(/visibilitychange/g) ?? []).length >= 4, 'chat control: both polling layers subscribe and unsubscribe foreground wake refresh');
assert((chatControlUi.match(/addEventListener\('online'/g) ?? []).length >= 2, 'chat control: both polling layers refresh immediately after network recovery');
assert((chatControlUi.match(/addEventListener\('focus'/g) ?? []).length >= 2, 'chat control: both polling layers refresh immediately when the PWA regains focus');
assert(
  /manualFallback[\s\S]{0,2000}window\.open\('about:blank'[\s\S]{0,2200}navigator\.clipboard\.writeText\(command\.prompt\)[\s\S]{0,2200}cancelProjectChatCommand[\s\S]{0,1800}popup\.location\.replace/.test(chatControlUi),
  'chat control: manual fallback reserves a tab, copies the prompt, cancels the durable command, then navigates to ChatGPT',
);
assert(
  /if \(!popup\)[\s\S]{0,500}Queueは取消していません/.test(chatControlUi),
  'chat control: popup-block failure leaves the automatic queue intact',
);
assert(
  /Clipboardへコピーできなかった[\s\S]{0,300}Queueは取消していません/.test(chatControlUi),
  'chat control: clipboard failure leaves the automatic queue intact',
);
assert(/catch \(error\)[\s\S]{0,500}popup\.close\(\)/.test(chatControlUi), 'chat control: cancel failure closes the reserved blank tab');
assert(/connectBridge[\s\S]{0,1200}window\.open\('about:blank'/.test(chatControlUi), 'chat control: Bridge setup reserves its tab before async clipboard work on mobile');

const chatControlClient = containsAll('src/chatControl.ts', [
  'getChatControlOverview',
  'OVERVIEW_BATCH_SIZE = 30',
  '/api/chat-control/overview',
  'Promise.allSettled',
  'OVERVIEW_ERROR',
  'flatMap',
  'cancelProjectChatCommand',
  '/cancel',
  'WORKER_REQUEST_TIMEOUT_MS = 12_000',
  'IDEMPOTENT_TRANSPORT_ATTEMPTS = 2',
  'WorkerRequestError',
  'AbortController',
  'retryIdempotentTransport',
  'createClientCommandDedupeKey',
  'dedupeKey',
]);
assert(!chatControlClient.includes('unique.slice(0, 30)'), 'chat control: projects beyond the first batch are not silently dropped');
assert(chatControlClient.includes("result.status === 'fulfilled'"), 'chat control: one failed overview batch does not discard successful batches');
assert(/enqueueProjectChatCommand[\s\S]{0,900}const dedupeKey = createClientCommandDedupeKey[\s\S]{0,900}retryIdempotentTransport/.test(chatControlClient), 'chat control: PWA enqueue retries reuse one per-action dedupe key');
assert(/cancelProjectChatCommand[\s\S]{0,700}retryIdempotentTransport/.test(chatControlClient), 'chat control: idempotent cancel can recover from lost transport responses');
assert(/retryProjectChatCommand[\s\S]{0,700}return workerFetch/.test(chatControlClient), 'chat control: non-idempotent failed-command retry is not blindly transport-retried');
assert(/setTimeout\([\s\S]{0,220}controller\.abort\(\)[\s\S]{0,120}WORKER_REQUEST_TIMEOUT_MS/.test(chatControlClient), 'chat control: stalled mobile Worker requests have a bounded timeout');

const operatingPlan = containsAll('src/OperatingPlanCenter.tsx', [
  'enqueueProjectChatCommand',
  '手動fallback: 実行指示をコピー',
  'Chat Control Busへ自動投入',
]);
assert(!operatingPlan.includes('copyAndOpenChat'), 'operating plan: primary path does not copy and open ChatGPT');

const core = containsAll('src/core.ts', [
  "export type ExecutionMode = 'CHAT' | 'WORK'",
  "executionMode: stored.executionMode === 'WORK' ? 'WORK' : 'CHAT'",
]);
assert(!core.includes('API_WORKER'), 'core: legacy API_WORKER executor mode is migrated away');

const runtimeSync = containsAll('src/RuntimeProjectSync.tsx', [
  'ChatGPT Bridge配送 / 実行待ち',
  "job.phase === 'human_required'",
]);
assert(!runtimeSync.includes("blockers = unique(['復旧指示をChatGPTで実行'])"), 'runtime: routine recovery is not mislabeled as human-only');
assert(!runtimeSync.includes("blockers = unique(['Supervisorが準備した指示をChatGPTで実行'])"), 'runtime: routine ChatGPT handoff is not mislabeled as human-only');

const supervisor = containsAll('src/supervisor.ts', [
  'function automationEnabled',
  "project.automationLevel === 'AUTO' || project.automationLevel === 'GUARDIAN'",
]);
assert(!supervisor.includes("project.executionMode !== 'CHAT'"), 'supervisor: CHAT execution can auto-continue when automation is enabled');

const workerIndex = containsAll('worker/src/index.ts', [
  "executor: 'chatgpt'",
  'orchestrationOnly: true',
  'deprecated_background_executor',
  'chatCommandBus: true',
  'atomicCoordinator: Boolean(env.PROJECT_COORDINATOR)',
  'ChatCommandConflictError',
  '/api/chat-control/overview',
  'MAX_OVERVIEW_PROJECTS = 30',
  '/cancel',
  'cancelPendingChatCommand',
  'dedupeKey?: string',
  'dedupeKey: body?.dedupeKey',
]);
assert(/\/webhooks\/openai[\s\S]{0,500}deprecated_background_executor/.test(workerIndex), 'worker: deprecated external background executor stays disabled');
assert(/createChatCommand[\s\S]{0,1000}dedupeKey: body\?\.dedupeKey/.test(workerIndex), 'worker: PWA retry dedupe key reaches the authoritative command queue');

const commandQueue = containsAll('worker/src/chatCommandQueue.ts', [
  'dedupeKey',
  'DEDUPE_PREFIX',
  'isClaimableCommand',
  'hasAtomicCoordinator',
  'getProjectChatCommand',
  'getProjectChatCommandOverview',
  "'/commands/overview'",
  'retryChatCommand',
  'cancelChatCommand',
  "'/commands/cancel'",
  'claim_owner_mismatch',
]);
assert(commandQueue.includes('dedupeStorageKey'), 'worker: auto-dispatched commands retain KV-compatible dedupe storage');
assert(commandQueue.includes('coordinatorFetch'), 'worker: production queue can route through the atomic coordinator');
assert(commandQueue.includes('only_queued_or_failed_commands_can_cancel'), 'worker: PWA cancellation cannot steal an actively claimed command');

const chatOverview = containsAll('worker/src/chatControlOverview.ts', [
  'getProjectChatCommandOverview',
  'getChatBridgeStatus',
  'RETRY_SCHEDULED',
  'WAITING_BRIDGE',
  'NEEDS_ATTENTION',
  'OVERVIEW_ERROR',
]);
assert(!chatOverview.includes('listProjectChatCommands('), 'multi-chat overview: frequent polling does not fetch full command bodies or trigger list mirror writes');
assert(/catch \(error\)[\s\S]{0,500}activity: 'OVERVIEW_ERROR'/.test(chatOverview), 'multi-chat overview: transport/storage failures are not mislabeled as Bridge offline');

const chatControlCss = containsAll('src/chat-control.css', [
  '.chat-project-remote.overview-error',
]);
assert(chatControlCss.includes('#fee2e2'), 'chat control: overview acquisition failures remain visually distinct');

const coordinator = containsAll('worker/src/projectCoordinator.ts', [
  'export class ProjectCoordinator',
  'blockConcurrencyWhile',
  '/commands/enqueue',
  '/commands/overview',
  'summarizeCoordinatorCommands',
  '/commands/claim',
  '/commands/result',
  '/commands/retry',
  '/commands/cancel',
  'only_queued_or_failed_commands_can_cancel',
  '/state/save',
  '/lease/acquire',
  '/lease/renew',
  '/lease/release',
  'claim_owner_mismatch',
  'deliveryFailures',
]);
assert(coordinator.includes('COMMANDS_MIGRATED_KEY'), 'coordinator: legacy queue migration remains explicit');
assert(coordinator.includes('STATE_MIGRATED_KEY'), 'coordinator: legacy state migration remains explicit');
assert(coordinator.includes('lease_owner_mismatch'), 'coordinator: stale/non-owner lease changes remain rejected');
assert(coordinator.includes('bridgeId: undefined'), 'coordinator: requeued/cancelled commands release stale Bridge ownership');

const stateSync = containsAll('worker/src/stateSync.ts', [
  'hasAtomicCoordinator',
  'coordinatorFetch',
  'revision_conflict',
  'ensureCoordinatorStateMigrated',
]);
assert(stateSync.includes("STATE_SCOPE = 'state-sync:v1'"), 'state sync: one strongly-consistent coordinator scope owns cloud revision decisions');

const setupDoctor = containsAll('src/SetupDoctorCenter.tsx', [
  'Atomic Multi-device Coordinator',
  'PROJECT_COORDINATOR binding',
  'atomicCoordinator',
]);
assert(setupDoctor.includes('複数端末競合耐性は完全ではありません'), 'setup doctor: non-atomic fallback is represented honestly');

const developerAgent = containsAll('worker/src/developerAgent.ts', [
  'enqueueChatCommand',
  'autoDispatch',
  'queueHandoffIfEnabled',
  'Chat Control Busへ次のChatGPT指示を自動投入しました',
]);
assert(/recovery_ready[\s\S]{0,5000}queueHandoffIfEnabled/.test(developerAgent), 'worker: recoverable ChatGPT handoffs can be routed back into the durable command bus');

const guardianRunner = containsAll('worker/src/guardianRunner.ts', [
  'acquireCoordinatorLease',
  'renewCoordinatorLease',
  'releaseCoordinatorLease',
  'GUARDIAN_ADVANCE_LEASE_NAME',
  "const scope = `guardian:${id}`",
]);
assert(guardianRunner.includes('hasAtomicCoordinator'), 'guardian: atomic coordinator gates concurrent advance protection');
assert(guardianRunner.includes('guardian_advance_lease_lost'), 'guardian: lost execution lease is detected instead of silently continuing');

containsAll('worker/src/orchestratorPolicy.ts', [
  'ChatGPT',
]);

const bridge = containsAll('chatgpt-bridge/src/bridgeApp.ts', [
  'assertAllowedProject',
  'sendFollowUpMessage',
  'ai_dev_deck_bridge_claim',
  'ai_dev_deck_bridge_result',
  'ai_dev_deck_bridge_retry',
  'delivery-receipt',
  'AI DEV DECK COMMAND ID',
  'cachedBridgeProjectId',
  'cachedBridgeId',
  "document.addEventListener('visibilitychange'",
  "window.addEventListener('online'",
  "window.addEventListener('pageshow'",
]);
assert(/allowedProjectIds/.test(bridge), 'bridge: project allowlist remains part of runtime boundary');
assert(bridge.includes('saveReceipt'), 'bridge: successful ChatGPT sends persist a delivery receipt before ack sync');
assert(bridge.includes('flushReceipt'), 'bridge: ack recovery is attempted before claiming another command');
assert(/catch \{[\s\S]{0,200}cachedBridgeId = createBridgeId\(pid\)/.test(bridge), 'bridge: storage failure keeps one stable in-memory claim owner instead of generating a new id per call');
assert(/visibilityState === 'visible'[\s\S]{0,120}tick\(false\)/.test(bridge), 'bridge: foreground resume immediately re-enters polling without bypassing command cooldown');
assert(/addEventListener\('online'[\s\S]{0,100}tick\(false\)/.test(bridge), 'bridge: network recovery immediately re-enters polling');

for (const configFile of ['worker/wrangler.example.jsonc', 'worker/wrangler.ci.jsonc']) {
  const config = containsAll(configFile, [
    'PROJECT_COORDINATOR',
    'ProjectCoordinator',
    '"type": "durable-object"',
    '"storage": "sqlite"',
  ]);
  assert(config.includes('"exports"'), `${configFile}: declarative Durable Object export remains configured`);
}

const workflow = containsAll('.github/workflows/ci.yml', [
  'Dry-run Worker + SQLite Durable Object bundle',
  'npm run dry-run',
]);
assert(workflow.includes('Enforce mobile bundle budget'), 'ci: mobile bundle budget remains enforced');

const bundleBudget = containsAll('scripts/check-bundle-size.mjs', [
  'JS_GZIP_BUDGET',
  'CSS_GZIP_BUDGET',
  'Mobile-first bundle budget failed',
]);
assert(bundleBudget.includes('130 * 1024'), 'performance: JS gzip budget matches the product manifest');
assert(bundleBudget.includes('20 * 1024'), 'performance: CSS gzip budget matches the product manifest');

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
console.log('Concept Guard: product direction, primary multi-chat UX, atomic control and safety boundaries are intact.');
