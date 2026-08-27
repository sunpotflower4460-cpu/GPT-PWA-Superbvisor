import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_ROUTE_COMPLETE_MARKER,
  AUTOPILOT_ROUTE_HEADER,
  applyDeclaredCategoryOverride,
  applyHumanApprovalOverride,
  assessCi,
  buildAutopilotRouteContinuationPrompt,
  buildChatGptHandoff,
  buildGenericChatGptHandoff,
  buildRecoveryPrompt,
  extractAutopilotRouteStep,
  failureFingerprint,
  hasAutopilotRouteCompletionMarker,
  hasAutopilotRouteContract,
  isRetryableProviderStatus,
  markAutopilotRouteCompleted,
  recordAutopilotRouteCheckpoint,
} from './orchestratorPolicy';

const base = {
  id: 1,
  name: 'CI',
  status: 'completed',
  conclusion: 'success' as string | null,
  url: 'https://github.com/example/repo/actions/runs/1',
  headSha: 'abc123',
};

describe('assessCi', () => {
  it('does not assume success when no run exists', () => {
    expect(assessCi([]).state).toBe('NO_RUN');
  });

  it('keeps running while a check is pending', () => {
    expect(assessCi([{ ...base, status: 'in_progress', conclusion: null }]).state).toBe('PENDING');
  });

  it('treats ordinary failures as code failures', () => {
    expect(assessCi([{ ...base, conclusion: 'failure' }]).state).toBe('CODE_FAILURE');
  });

  it('separates transient infrastructure-like conclusions', () => {
    expect(assessCi([{ ...base, conclusion: 'timed_out' }]).state).toBe('TRANSIENT_FAILURE');
    expect(assessCi([{ ...base, conclusion: 'cancelled' }]).state).toBe('TRANSIENT_FAILURE');
  });

  it('requires human action when GitHub says action_required', () => {
    expect(assessCi([{ ...base, conclusion: 'action_required' }]).state).toBe('HUMAN_REQUIRED');
  });

  it('accepts success/neutral/skipped as non-blocking completed checks', () => {
    expect(assessCi([
      base,
      { ...base, id: 2, name: 'Lint', conclusion: 'neutral' },
      { ...base, id: 3, name: 'Optional', conclusion: 'skipped' },
    ]).state).toBe('SUCCESS');
  });

  it('treats a plain failure as human-required when the check name (as assessCi sees it) matches the Kernel override directly', () => {
    // assessCi() only ever sees whatever `name` its caller passes in. This
    // covers the coincidental case where that name already matches the
    // Kernel-declared check name (e.g. a workflow with a single job sharing
    // its name, like GPT-template's "guard" workflow/job). The realistic
    // case — a workflow-run name that does NOT match its job/check name,
    // e.g. "require-human-approval" (workflow) containing "check-approval"
    // (job) — is covered by applyHumanApprovalOverride below, which is what
    // developerAgent.ts actually relies on for that reconciliation.
    const humanRequiredCheckNames = new Set(['check-approval']);
    expect(assessCi([{ ...base, name: 'check-approval', conclusion: 'failure' }], humanRequiredCheckNames).state)
      .toBe('HUMAN_REQUIRED');
  });

  it('does not widen the override to other checks by name', () => {
    const humanRequiredCheckNames = new Set(['check-approval']);
    expect(assessCi([{ ...base, name: 'guard', conclusion: 'failure' }], humanRequiredCheckNames).state)
      .toBe('CODE_FAILURE');
  });
});

describe('applyHumanApprovalOverride', () => {
  // Reproduces the actual GitHub API shape for GPT-template's PR #3, where
  // require-human-approval.yml's check-approval job fails: the WORKFLOW-
  // run-level view (what assessCi/getBranchWorkflowRuns sees) reports the
  // workflow's own name, "require-human-approval", with conclusion
  // "failure" — never "action_required" — while the JOB-level view
  // (getWorkflowRunJobs, GitHub's /actions/runs/{run_id}/jobs) reports the
  // actual job name, "check-approval", which is what the Kernel's
  // checks[].name declares. Passing only the workflow-run-level data to
  // assessCi() alone classifies this as CODE_FAILURE — a real bug, not a
  // hypothetical one.
  const workflowRunLevelCheck = { ...base, name: 'require-human-approval', conclusion: 'failure' };
  const jobLevelCheckApproval = { ...base, id: 2, name: 'check-approval', conclusion: 'failure' };
  const humanRequiredCheckNames = new Set(['check-approval']);

  it('demonstrates the bug: workflow-run-level data alone misclassifies this as CODE_FAILURE', () => {
    expect(assessCi([workflowRunLevelCheck], humanRequiredCheckNames).state).toBe('CODE_FAILURE');
  });

  it('reclassifies to HUMAN_REQUIRED once given the real job-level data', () => {
    const workflowLevelAssessment = assessCi([workflowRunLevelCheck], humanRequiredCheckNames);
    const reconciled = applyHumanApprovalOverride(workflowLevelAssessment, [jobLevelCheckApproval], humanRequiredCheckNames);
    expect(reconciled.state).toBe('HUMAN_REQUIRED');
    expect(reconciled.humanRequired.map((check) => check.name)).toContain('check-approval');
  });

  it('is a no-op when no job/check-run matches a declared human-approval name', () => {
    const workflowLevelAssessment = assessCi([workflowRunLevelCheck], humanRequiredCheckNames);
    const otherJobCheck = { ...base, id: 3, name: 'guard', conclusion: 'failure' };
    const reconciled = applyHumanApprovalOverride(workflowLevelAssessment, [otherJobCheck], humanRequiredCheckNames);
    expect(reconciled).toEqual(workflowLevelAssessment);
  });

  it('does not override PENDING, SUCCESS, or NO_RUN even if a matching check exists', () => {
    expect(applyHumanApprovalOverride(assessCi([]), [jobLevelCheckApproval], humanRequiredCheckNames).state).toBe('NO_RUN');
    expect(applyHumanApprovalOverride(assessCi([{ ...base, status: 'in_progress', conclusion: null }]), [jobLevelCheckApproval], humanRequiredCheckNames).state).toBe('PENDING');
    expect(applyHumanApprovalOverride(assessCi([base]), [jobLevelCheckApproval], humanRequiredCheckNames).state).toBe('SUCCESS');
  });

  it('merges with, rather than replaces, human-required checks assessCi already found via action_required', () => {
    const actionRequiredCheck = { ...base, id: 4, name: 'deploy-approval', conclusion: 'action_required' };
    const workflowLevelAssessment = assessCi([actionRequiredCheck], humanRequiredCheckNames);
    expect(workflowLevelAssessment.state).toBe('HUMAN_REQUIRED');
    const reconciled = applyHumanApprovalOverride(workflowLevelAssessment, [jobLevelCheckApproval], humanRequiredCheckNames);
    const names = reconciled.humanRequired.map((check) => check.name).sort();
    expect(names).toEqual(['check-approval', 'deploy-approval']);
  });

  it('is a no-op when the Kernel declares no human-approval checks at all (GENERIC_REPO-equivalent)', () => {
    const workflowLevelAssessment = assessCi([workflowRunLevelCheck]);
    const reconciled = applyHumanApprovalOverride(workflowLevelAssessment, [jobLevelCheckApproval], new Set());
    expect(reconciled).toEqual(workflowLevelAssessment);
  });
});

describe('applyDeclaredCategoryOverride', () => {
  // Same job-level-vs-workflow-run-level gap as applyHumanApprovalOverride
  // above, but for any other declared category: a workflow named "ci"
  // containing a job named "lint" labeled GUARD_FAILURE reports as "ci" at
  // the run level assessCi() alone sees.
  const workflowRunLevelCheck = { ...base, name: 'ci', conclusion: 'failure' };
  const jobLevelLintCheck = { ...base, id: 2, name: 'lint', conclusion: 'failure' };
  const checkCategories = new Map([['lint', 'GUARD_FAILURE']]);

  it('enriches a plain CODE_FAILURE with the declared category once given job-level data', () => {
    const assessment = assessCi([workflowRunLevelCheck]);
    expect(assessment.state).toBe('CODE_FAILURE');
    expect(assessment.declaredCategories).toBeUndefined();

    const enriched = applyDeclaredCategoryOverride(assessment, [jobLevelLintCheck], checkCategories);
    expect(enriched.state).toBe('CODE_FAILURE');
    expect(enriched.declaredCategories).toEqual(['GUARD_FAILURE']);
  });

  it('is a no-op when no job-level check matches a declared category', () => {
    const assessment = assessCi([workflowRunLevelCheck]);
    const otherJobCheck = { ...base, id: 3, name: 'typecheck', conclusion: 'failure' };
    expect(applyDeclaredCategoryOverride(assessment, [otherJobCheck], checkCategories)).toEqual(assessment);
  });

  it('is a no-op when the Kernel declares no categories at all (GENERIC_REPO-equivalent)', () => {
    const assessment = assessCi([workflowRunLevelCheck]);
    expect(applyDeclaredCategoryOverride(assessment, [jobLevelLintCheck], new Map())).toEqual(assessment);
  });

  it('never overrides HUMAN_REQUIRED, TRANSIENT_FAILURE, PENDING, SUCCESS, or NO_RUN', () => {
    const humanRequired = assessCi([{ ...base, conclusion: 'action_required' }]);
    expect(applyDeclaredCategoryOverride(humanRequired, [jobLevelLintCheck], checkCategories)).toEqual(humanRequired);

    const transient = assessCi([{ ...base, conclusion: 'timed_out' }]);
    expect(applyDeclaredCategoryOverride(transient, [jobLevelLintCheck], checkCategories)).toEqual(transient);

    expect(applyDeclaredCategoryOverride(assessCi([]), [jobLevelLintCheck], checkCategories).state).toBe('NO_RUN');
    expect(applyDeclaredCategoryOverride(assessCi([base]), [jobLevelLintCheck], checkCategories).state).toBe('SUCCESS');
  });

  it('excludes a transient check from category selection, even when a real failure exists in the same CODE_FAILURE run', () => {
    // assessCi only escalates to TRANSIENT_FAILURE when EVERY failing check
    // is transient — a run with one cancelled check and one real failure is
    // still CODE_FAILURE overall. The cancelled check's category (if any)
    // must never be mistaken for the actionable failure's own.
    const runWithMixedFailures = { ...base, name: 'ci', conclusion: 'failure' };
    const assessment = assessCi([runWithMixedFailures]);
    expect(assessment.state).toBe('CODE_FAILURE');

    const cancelledJobCheck = { ...base, id: 5, name: 'flaky-e2e', conclusion: 'cancelled' };
    const realFailureJobCheck = { ...base, id: 6, name: 'lint', conclusion: 'failure' };
    const categories = new Map([
      ['flaky-e2e', 'INFRA_FAILURE'],
      ['lint', 'GUARD_FAILURE'],
    ]);

    const enriched = applyDeclaredCategoryOverride(assessment, [cancelledJobCheck, realFailureJobCheck], categories);
    expect(enriched.declaredCategories).toEqual(['GUARD_FAILURE']);
  });

  it('collects every distinct category when multiple independently-categorized checks fail at once', () => {
    // Two real, non-transient failures in the same run — picking only the
    // first (e.g. via .find()) would silently drop the other's evidence.
    const assessment = assessCi([{ ...base, name: 'ci', conclusion: 'failure' }]);
    const lintFailure = { ...base, id: 5, name: 'lint', conclusion: 'failure' };
    const terraformFailure = { ...base, id: 6, name: 'terraform-plan', conclusion: 'failure' };
    const categories = new Map([
      ['lint', 'GUARD_FAILURE'],
      ['terraform-plan', 'INFRA_FAILURE'],
    ]);

    const enriched = applyDeclaredCategoryOverride(assessment, [lintFailure, terraformFailure], categories);
    expect(enriched.declaredCategories).toEqual(['GUARD_FAILURE', 'INFRA_FAILURE']);
  });

  it('deduplicates when multiple failing checks share the same declared category', () => {
    const assessment = assessCi([{ ...base, name: 'ci', conclusion: 'failure' }]);
    const lintFailure = { ...base, id: 5, name: 'lint', conclusion: 'failure' };
    const formatFailure = { ...base, id: 6, name: 'format', conclusion: 'failure' };
    const categories = new Map([
      ['lint', 'GUARD_FAILURE'],
      ['format', 'GUARD_FAILURE'],
    ]);

    const enriched = applyDeclaredCategoryOverride(assessment, [lintFailure, formatFailure], categories);
    expect(enriched.declaredCategories).toEqual(['GUARD_FAILURE']);
  });

  it('finds no category when every job-level check with one is transient', () => {
    const assessment = assessCi([{ ...base, name: 'ci', conclusion: 'failure' }]);
    const cancelledJobCheck = { ...base, id: 5, name: 'flaky-e2e', conclusion: 'cancelled' };
    const categories = new Map([['flaky-e2e', 'INFRA_FAILURE']]);
    expect(applyDeclaredCategoryOverride(assessment, [cancelledJobCheck], categories)).toEqual(assessment);
  });

  it('never re-labels a HUMAN_APPROVAL_REQUIRED-categorized check as a generic declared category', () => {
    // A CODE_FAILURE assessment (not yet reconciled to HUMAN_REQUIRED) whose
    // only matching job-level check happens to be the human-approval one —
    // applyDeclaredCategoryOverride must leave that to
    // applyHumanApprovalOverride, never surface it as declaredCategory.
    const assessment = assessCi([workflowRunLevelCheck]);
    const jobLevelApprovalCheck = { ...base, id: 4, name: 'check-approval', conclusion: 'failure' };
    const categoriesWithHumanApproval = new Map([['check-approval', 'HUMAN_APPROVAL_REQUIRED']]);
    expect(applyDeclaredCategoryOverride(assessment, [jobLevelApprovalCheck], categoriesWithHumanApproval)).toEqual(assessment);
  });
});

describe('recovery safety', () => {
  it('creates stable fingerprints for the same head/check state', () => {
    const a = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    const b = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    expect(a).toBe(b);
  });

  it('changes fingerprint when the head changes', () => {
    expect(failureFingerprint('abc', [base])).not.toBe(failureFingerprint('def', [base]));
  });

  it('changes fingerprint when a declared category is newly discovered, given the same head/checks', () => {
    // Otherwise: getWorkflowRunJobs is best-effort, so an earlier refresh
    // can cache a handoffPrompt against a category-less fingerprint, and a
    // later refresh where the category becomes known — same head, same
    // checks — would reuse that stale prompt forever instead of
    // regenerating with the newly discovered category.
    const withoutCategory = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    const withCategory = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }], ['GUARD_FAILURE']);
    expect(withCategory).not.toBe(withoutCategory);
  });

  it('fingerprints the same category set identically regardless of discovery order', () => {
    const a = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }], ['GUARD_FAILURE', 'INFRA_FAILURE']);
    const b = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }], ['INFRA_FAILURE', 'GUARD_FAILURE']);
    expect(a).toBe(b);
  });

  it('is unaffected by a declaredCategory of undefined (existing 2-argument callers stay identical)', () => {
    expect(failureFingerprint('abc', [{ ...base, conclusion: 'failure' }], undefined))
      .toBe(failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]));
  });

  it('only retries provider statuses that are plausibly transient', () => {
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(503)).toBe(true);
    expect(isRetryableProviderStatus(400)).toBe(false);
    expect(isRetryableProviderStatus(401)).toBe(false);
  });

  it('makes the ChatGPT executor boundary explicit in GitHub initial and recovery prompts', () => {
    const initial = buildChatGptHandoff({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', defaultBranch: 'main', goal: 'Ship safely', task: 'Fix CI',
    });
    const recovery = buildRecoveryPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Ship safely', originalTask: 'Fix CI', headSha: 'abc', checks: [{ ...base, conclusion: 'failure' }],
    });
    expect(initial).toContain('実装担当は、このChatGPTチャット');
    expect(initial).toContain('外部APIは実装を行いません');
    expect(recovery).toContain('実装修正担当は、このChatGPTチャット');
  });

  it('includes the declared category in the deterministic recovery prompt (not only the LLM-orchestrated one)', () => {
    // runOrchestrationModel falls back to this exact prompt verbatim
    // whenever no provider is configured or every one fails — the declared
    // category has to reach ChatGPT on that path too, not only via the
    // LLM-visible `evidence` string built separately in developerAgent.ts.
    const withCategory = buildRecoveryPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Ship safely', originalTask: 'Fix CI',
      headSha: 'abc', checks: [{ ...base, conclusion: 'failure' }], declaredCategories: ['GUARD_FAILURE', 'INFRA_FAILURE'],
    });
    expect(withCategory).toContain('宣言されたカテゴリ: GUARD_FAILURE, INFRA_FAILURE');

    const withoutCategory = buildRecoveryPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Ship safely', originalTask: 'Fix CI',
      headSha: 'abc', checks: [{ ...base, conclusion: 'failure' }],
    });
    expect(withoutCategory).not.toContain('宣言されたカテゴリ');
  });

  it('makes generic non-GitHub handoffs orchestration-only too', () => {
    const prompt = buildGenericChatGptHandoff({
      projectName: 'Research', goal: 'Finish safely', currentPhase: 'analysis', task: 'Continue', definitionOfDone: ['Evidence checked'],
    });
    expect(prompt).toContain('実行主体は、このChatGPTチャット');
    expect(prompt).toContain('監督・整理・次手生成だけを担当');
    expect(prompt).toContain('外部APIの要約だけを根拠に完成扱いせず');
  });
});

describe('autopilot route contract', () => {
  const routeTask = `Plan\n${AUTOPILOT_ROUTE_HEADER}\n3回デバッグ → 問題があれば追加 → 機能追加 → 3回補強 → UIUXを3回`;

  it('detects route contracts and completion markers explicitly', () => {
    expect(hasAutopilotRouteContract(routeTask)).toBe(true);
    expect(hasAutopilotRouteContract('ordinary task')).toBe(false);
    expect(hasAutopilotRouteCompletionMarker(`feat: final ${AUTOPILOT_ROUTE_COMPLETE_MARKER}`)).toBe(true);
    expect(hasAutopilotRouteCompletionMarker('feat: intermediate')).toBe(false);
  });

  it('keeps later route stages alive after an intermediate green CI', () => {
    const prompt = buildAutopilotRouteContinuationPrompt({
      repository: 'owner/repo',
      branch: 'ai-dev-deck/task',
      goal: 'Finish route',
      originalTask: routeTask,
      headSha: 'abc123',
      checks: [base],
    });
    expect(prompt).toContain('CI成功だけでは完了扱いにしません');
    expect(prompt).toContain('最初の未完了工程/未完了パスから続行');
    expect(prompt).toContain(AUTOPILOT_ROUTE_COMPLETE_MARKER);
  });

  it('preserves route progress rules through recovery prompts', () => {
    const prompt = buildRecoveryPrompt({
      repository: 'owner/repo',
      branch: 'ai-dev-deck/task',
      goal: 'Finish route',
      originalTask: routeTask,
      headSha: 'abc123',
      checks: [{ ...base, conclusion: 'failure' }],
    });
    expect(prompt).toContain('完了済み工程を最初から再実行せず');
    expect(prompt).toContain('後続工程が残っている限り最終完了ではありません');
  });

  it('extracts a verbatim self-reported route step without interpreting it', () => {
    expect(extractAutopilotRouteStep('feat: fix bug [AUTOPILOT_ROUTE_STEP: 3回デバッグ 2/3回目]')).toBe('3回デバッグ 2/3回目');
    expect(extractAutopilotRouteStep('feat: fix bug')).toBeUndefined();
    expect(extractAutopilotRouteStep(undefined)).toBeUndefined();
    expect(extractAutopilotRouteStep('feat: fix [AUTOPILOT_ROUTE_STEP:   ]')).toBeUndefined();
  });

  it('records a checkpoint per distinct head, independent of any chat text', () => {
    const first = recordAutopilotRouteCheckpoint(undefined, 'sha1', '2026-01-01T00:00:00Z', 'step 1');
    expect(first.checkpoints).toEqual([{ headSha: 'sha1', reachedAt: '2026-01-01T00:00:00Z', step: 'step 1' }]);

    const second = recordAutopilotRouteCheckpoint(first, 'sha2', '2026-01-01T01:00:00Z', undefined);
    expect(second.checkpoints).toHaveLength(2);
    expect(second.checkpoints[1]).toEqual({ headSha: 'sha2', reachedAt: '2026-01-01T01:00:00Z', step: undefined });
  });

  it('does not pad the checkpoint list when the same head is observed again', () => {
    const first = recordAutopilotRouteCheckpoint(undefined, 'sha1', '2026-01-01T00:00:00Z', 'step 1');
    const again = recordAutopilotRouteCheckpoint(first, 'sha1', '2026-01-01T00:05:00Z', 'step 1 (re-observed)');
    expect(again).toBe(first);
    expect(again.checkpoints).toHaveLength(1);
  });

  it('caps checkpoint history to the most recent 20 entries', () => {
    let state = recordAutopilotRouteCheckpoint(undefined, 'sha0', '2026-01-01T00:00:00Z', undefined);
    for (let i = 1; i <= 25; i += 1) {
      state = recordAutopilotRouteCheckpoint(state, `sha${i}`, `2026-01-01T00:${i}:00Z`, undefined);
    }
    expect(state.checkpoints).toHaveLength(20);
    expect(state.checkpoints[0].headSha).toBe('sha6');
    expect(state.checkpoints[19].headSha).toBe('sha25');
  });

  it('marks a route completed once and keeps the first completion time on later calls', () => {
    const withCheckpoints = recordAutopilotRouteCheckpoint(undefined, 'sha1', '2026-01-01T00:00:00Z', undefined);
    const completed = markAutopilotRouteCompleted(withCheckpoints, '2026-01-02T00:00:00Z');
    expect(completed.completedAt).toBe('2026-01-02T00:00:00Z');
    expect(completed.checkpoints).toBe(withCheckpoints.checkpoints);

    const stillCompleted = markAutopilotRouteCompleted(completed, '2026-01-03T00:00:00Z');
    expect(stillCompleted.completedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('threads persisted checkpoint history into the continuation and recovery prompts', () => {
    const routeState = recordAutopilotRouteCheckpoint(undefined, 'sha1', '2026-01-01T00:00:00Z', '3回デバッグ 1/3回目');
    const continuation = buildAutopilotRouteContinuationPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Finish route', originalTask: routeTask, headSha: 'sha2', checks: [base], routeState,
    });
    expect(continuation).toContain('過去に記録されたルートチェックポイント');
    expect(continuation).toContain('3回デバッグ 1/3回目');

    const recovery = buildRecoveryPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Finish route', originalTask: routeTask, headSha: 'sha2', checks: [{ ...base, conclusion: 'failure' }], routeState,
    });
    expect(recovery).toContain('3回デバッグ 1/3回目');
  });

  it('omits the checkpoint history section entirely when there is none yet', () => {
    const continuation = buildAutopilotRouteContinuationPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Finish route', originalTask: routeTask, headSha: 'sha1', checks: [base],
    });
    expect(continuation).not.toContain('過去に記録されたルートチェックポイント');
  });
});
