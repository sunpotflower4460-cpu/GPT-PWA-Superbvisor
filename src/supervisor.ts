import { DevProject, ProjectStatus, isLikelyStalled } from './core';

export type RecoveryAction =
  | 'NONE'
  | 'NUDGE_CHAT'
  | 'RETRY'
  | 'TRY_ALTERNATIVE'
  | 'CREATE_HANDOFF'
  | 'ASK_HUMAN'
  | 'MARK_COMPLETE';

export interface SupervisorEvidence {
  testsPassing?: boolean;
  ciPassing?: boolean;
  openBlockingIssues?: number;
  unresolvedTodos?: number;
  latestCommitAt?: string;
  workerFailed?: boolean;
  workerIncomplete?: boolean;
  retryCount?: number;
  contextPressure?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface SupervisorDecision {
  derivedStatus: ProjectStatus;
  action: RecoveryAction;
  reason: string;
  completionScore: number;
  canAutoContinue: boolean;
}

function completionScore(project: DevProject, evidence: SupervisorEvidence) {
  let score = Math.max(0, Math.min(100, project.progress));

  const completedMilestones = project.milestones.filter((item) => item.state === 'DONE').length;
  if (project.milestones.length) {
    score = Math.max(score, Math.round((completedMilestones / project.milestones.length) * 85));
  }

  if (evidence.testsPassing) score += 4;
  if (evidence.ciPassing) score += 4;
  if (evidence.openBlockingIssues === 0) score += 3;
  if (evidence.unresolvedTodos === 0) score += 2;
  if (project.humanBlockers.length > 0) score = Math.min(score, 95);

  return Math.max(0, Math.min(100, score));
}

export function evaluateProject(project: DevProject, evidence: SupervisorEvidence = {}): SupervisorDecision {
  const score = completionScore(project, evidence);
  const retryCount = evidence.retryCount ?? 0;

  if (project.status === 'WAITING_USER' || project.humanBlockers.length > 0) {
    return {
      derivedStatus: 'WAITING_USER',
      action: 'ASK_HUMAN',
      reason: '本人しか実行できない作業または判断が登録されています。',
      completionScore: score,
      canAutoContinue: false,
    };
  }

  if (project.status === 'CONTEXT_LIMIT' || evidence.contextPressure === 'HIGH') {
    return {
      derivedStatus: 'CONTEXT_LIMIT',
      action: 'CREATE_HANDOFF',
      reason: '会話コンテキストの引き継ぎを行ってから継続するのが安全です。',
      completionScore: score,
      canAutoContinue: project.executionMode !== 'CHAT',
    };
  }

  if (project.status === 'RATE_LIMITED') {
    return {
      derivedStatus: 'RATE_LIMITED',
      action: 'NONE',
      reason: '利用上限またはレート制限の解除待ちです。',
      completionScore: score,
      canAutoContinue: false,
    };
  }

  if (project.status === 'ERROR' || evidence.workerFailed) {
    const action: RecoveryAction = retryCount < 2 ? 'RETRY' : retryCount < 5 ? 'TRY_ALTERNATIVE' : 'ASK_HUMAN';
    return {
      derivedStatus: 'ERROR',
      action,
      reason:
        action === 'RETRY'
          ? '失敗を検出しました。原因確認後の再試行対象です。'
          : action === 'TRY_ALTERNATIVE'
            ? '同系統の再試行が続いたため、別アプローチへ切り替えます。'
            : '複数方式で復旧できず、人間の判断が必要です。',
      completionScore: score,
      canAutoContinue: action !== 'ASK_HUMAN',
    };
  }

  if (isLikelyStalled(project) || evidence.workerIncomplete) {
    return {
      derivedStatus: 'STALLED',
      action: project.executionMode === 'CHAT' ? 'NUDGE_CHAT' : 'RETRY',
      reason: '進捗更新が止まっている可能性があります。完了済みを確認して未完了地点から再開します。',
      completionScore: score,
      canAutoContinue: project.executionMode !== 'CHAT',
    };
  }

  const allMilestonesDone = project.milestones.length > 0 && project.milestones.every((item) => item.state === 'DONE');
  const evidenceClean =
    evidence.testsPassing !== false &&
    evidence.ciPassing !== false &&
    (evidence.openBlockingIssues ?? 0) === 0 &&
    (evidence.unresolvedTodos ?? 0) === 0;

  if ((project.status === 'COMPLETED' || allMilestonesDone) && evidenceClean) {
    return {
      derivedStatus: 'COMPLETED',
      action: 'MARK_COMPLETE',
      reason: '工程完了と検証条件を満たしています。',
      completionScore: 100,
      canAutoContinue: false,
    };
  }

  return {
    derivedStatus: project.status === 'WAITING_AI' ? 'WAITING_AI' : 'RUNNING',
    action: 'NONE',
    reason: '通常進行中です。',
    completionScore: score,
    canAutoContinue: project.automationLevel === 'AUTO' || project.automationLevel === 'GUARDIAN',
  };
}

export function buildRecoveryPrompt(project: DevProject, decision: SupervisorDecision) {
  return `Supervisorが作業停止または異常を検出しました。\n\nプロジェクト: ${project.name}\n最終目標: ${project.goal}\n現在地点: ${project.currentPhase}\n判定: ${decision.derivedStatus}\n理由: ${decision.reason}\n\n指示:\n- まず現在の成果物と直前までに完了した内容を確認してください。\n- 完了済み作業を重複せず、未完了地点から再開してください。\n- エラーの場合は原因を確認し、同じ失敗を繰り返すだけにならないよう修正または別手法を試してください。\n- AIだけで安全に進められる範囲では、単なる継続確認で停止しないでください。\n- 本人しかできない操作・課金・秘密情報・不可逆操作・大きな仕様判断に到達した場合だけ停止し、必要事項を明確にしてください。\n- 最後に、実施した手順・現在地点・残作業を短く報告してください。`;
}

export function buildHandoffPacket(project: DevProject) {
  const done = project.milestones.filter((item) => item.state === 'DONE').map((item) => `- ${item.title}`).join('\n') || '- なし';
  const remaining = project.milestones.filter((item) => item.state !== 'DONE').map((item) => `- ${item.title} (${item.state})`).join('\n') || '- なし';
  const timeline = project.timeline.slice(-8).map((item) => `- ${item.at}: ${item.message}`).join('\n') || '- なし';

  return `# HANDOFF PACKET\n\nPROJECT: ${project.name}\nGOAL: ${project.goal}\nCURRENT PHASE: ${project.currentPhase}\nPROGRESS: ${project.progress}%\nMODE: ${project.executionMode}\nAUTOMATION: ${project.automationLevel}\n\n## COMPLETED\n${done}\n\n## REMAINING\n${remaining}\n\n## HUMAN BLOCKERS\n${project.humanBlockers.map((item) => `- ${item}`).join('\n') || '- なし'}\n\n## RECENT HISTORY\n${timeline}\n\n## CONTINUE RULES\n完了済みを重複せず、成果物を確認して未完了地点から続行する。AIだけで安全に可能な作業は連続して進め、本人しかできない操作または重要判断だけ質問する。`;
}
