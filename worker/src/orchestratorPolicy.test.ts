import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_ROUTE_COMPLETE_MARKER,
  AUTOPILOT_ROUTE_HEADER,
  applyHumanApprovalOverride,
  assessCi,
  buildAutopilotRouteContinuationPrompt,
  buildChatGptHandoff,
  buildGenericChatGptHandoff,
  buildRecoveryPrompt,
  failureFingerprint,
  hasAutopilotRouteCompletionMarker,
  hasAutopilotRouteContract,
  isRetryableProviderStatus,
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
  // "failure" — never "action_required" — while the JOB/check-run-level
  // view (getCommitCheckRuns) reports the actual job name,
  // "check-approval", which is what the Kernel's checks[].name declares.
  // Passing only the workflow-run-level data to assessCi() alone
  // classifies this as CODE_FAILURE — a real bug, not a hypothetical one.
  const workflowRunLevelCheck = { ...base, name: 'require-human-approval', conclusion: 'failure' };
  const jobLevelCheckApproval = { ...base, id: 2, name: 'check-approval', conclusion: 'failure' };
  const humanRequiredCheckNames = new Set(['check-approval']);

  it('demonstrates the bug: workflow-run-level data alone misclassifies this as CODE_FAILURE', () => {
    expect(assessCi([workflowRunLevelCheck], humanRequiredCheckNames).state).toBe('CODE_FAILURE');
  });

  it('reclassifies to HUMAN_REQUIRED once given the real job/check-run-level data', () => {
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

describe('recovery safety', () => {
  it('creates stable fingerprints for the same head/check state', () => {
    const a = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    const b = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    expect(a).toBe(b);
  });

  it('changes fingerprint when the head changes', () => {
    expect(failureFingerprint('abc', [base])).not.toBe(failureFingerprint('def', [base]));
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
});
