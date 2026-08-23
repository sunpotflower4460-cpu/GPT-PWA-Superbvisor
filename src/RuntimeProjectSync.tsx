import { useEffect, useRef } from 'react';
import { BackgroundJob, getLatestBackgroundJob, loadWorkerConnection } from './backgroundWorker';
import { DevProject, ProjectStatus, TimelineEvent, loadProjects, saveProjects } from './core';
import { DeveloperJob, getLatestDeveloperJob } from './developerAgent';
import { GuardianRun, getLatestGuardianRun } from './guardianRunner';

const SYNC_INTERVAL_MS = 120_000;

type RuntimeSource =
  | { type: 'guardian'; value: GuardianRun }
  | { type: 'developer'; value: DeveloperJob }
  | { type: 'background'; value: BackgroundJob };

export default function RuntimeProjectSync() {
  const syncing = useRef(false);

  useEffect(() => {
    const sync = () => void syncProjects(syncing);
    const timer = window.setTimeout(sync, 1200);
    const interval = window.setInterval(sync, SYNC_INTERVAL_MS);
    const focus = () => sync();
    const visibility = () => { if (document.visibilityState === 'visible') sync(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  return null;
}

async function syncProjects(lock: { current: boolean }) {
  if (lock.current) return;
  const connection = loadWorkerConnection();
  if (!connection.baseUrl.trim() || !connection.token.trim()) return;
  const projects = loadProjects();
  if (!projects.length) return;

  lock.current = true;
  try {
    let changed = false;
    const next: DevProject[] = [];

    for (const project of projects) {
      const [guardianResult, developerResult, backgroundResult] = await Promise.allSettled([
        getLatestGuardianRun(project.id, connection),
        getLatestDeveloperJob(project.id, connection),
        getLatestBackgroundJob(project.id, connection),
      ]);
      const guardian = guardianResult.status === 'fulfilled' ? guardianResult.value : null;
      const developer = developerResult.status === 'fulfilled' ? developerResult.value : null;
      const background = backgroundResult.status === 'fulfilled' ? backgroundResult.value : null;
      const source = chooseLatest(guardian, developer, background);
      const updated = source?.type === 'guardian'
        ? applyGuardian(project, source.value)
        : source?.type === 'developer'
          ? applyDeveloper(project, source.value)
          : source?.type === 'background'
            ? applyBackground(project, source.value)
            : project;
      if (updated !== project) changed = true;
      next.push(updated);
    }

    if (changed) {
      saveProjects(next);
      window.dispatchEvent(new CustomEvent('devdeck:projects-changed'));
    }
  } finally {
    lock.current = false;
  }
}

function chooseLatest(guardian: GuardianRun | null, developer: DeveloperJob | null, background: BackgroundJob | null): RuntimeSource | null {
  const candidates: RuntimeSource[] = [];
  if (guardian) candidates.push({ type: 'guardian', value: guardian });
  if (developer) candidates.push({ type: 'developer', value: developer });
  if (background) candidates.push({ type: 'background', value: background });
  return candidates.sort((a, b) => +new Date(b.value.updatedAt) - +new Date(a.value.updatedAt))[0] ?? null;
}

function applyGuardian(project: DevProject, run: GuardianRun): DevProject {
  if (!isNewer(run.updatedAt, project.lastActivityAt)) return project;

  let status: ProjectStatus = 'RUNNING';
  let progress = project.progress;
  let phase = 'Guardian監督中';
  let blockers = project.humanBlockers;
  let kind: TimelineEvent['kind'] = 'info';

  if (run.status === 'running' || run.status === 'starting') {
    if (run.phase === 'handoff_ready' || run.phase === 'waiting_chatgpt') {
      status = 'WAITING_USER';
      progress = Math.max(progress, 35);
      phase = 'Guardian監督中 · ChatGPT実行待ち';
      blockers = unique(['ChatGPTでSupervisorの作業指示を実行']);
      kind = 'human';
    } else if (run.phase === 'recovery_ready') {
      status = 'WAITING_USER';
      progress = Math.max(progress, 65);
      phase = 'CI失敗を検出 · ChatGPT修正待ち';
      blockers = unique(['Guardianが生成した復旧指示をChatGPTで実行']);
      kind = 'warning';
    } else {
      progress = Math.max(progress, 45);
      phase = 'Guardian監督処理中';
      blockers = [];
    }
  } else if (run.status === 'waiting_ci') {
    status = 'WAITING_AI';
    progress = Math.max(progress, 78);
    phase = 'ChatGPT変更済み · CI監視中';
    blockers = [];
  } else if (run.status === 'review_ready') {
    status = 'WAITING_USER';
    progress = Math.max(progress, run.phase === 'human_required' ? 70 : 90);
    phase = run.phase === 'human_required' ? '人間操作が必要' : 'レビュー待ち';
    blockers = unique(run.phase === 'human_required'
      ? [run.message || '権限・承認など人間操作を確認']
      : [run.pullRequest ? `Draft PR #${run.pullRequest.number} をレビュー` : '成果物と証拠をレビュー']);
    kind = 'human';
  } else if (run.status === 'completed') {
    if (run.pullRequest) {
      status = 'WAITING_USER';
      progress = Math.max(progress, 95);
      phase = 'CI成功 · Draft PRの最終レビュー待ち';
      blockers = unique([`Draft PR #${run.pullRequest.number} を最終レビューしてマージ`]);
      kind = 'human';
    } else {
      status = 'COMPLETED';
      progress = 100;
      phase = 'ChatGPT作業・CI成功確認済み';
      blockers = [];
      kind = 'success';
    }
  } else if (run.status === 'expired') {
    status = 'WAITING_USER';
    phase = 'Guardian監視時間上限 · ChatGPTで再開可能';
    blockers = unique(['保存済み状態からChatGPTで作業を再開']);
    kind = 'warning';
  } else {
    status = 'ERROR';
    phase = 'Guardian設定エラー';
    kind = 'error';
  }

  return patchRuntime(project, {
    status,
    progress,
    currentPhase: phase,
    executionMode: 'CHAT',
    automationLevel: 'GUARDIAN',
    humanBlockers: blockers,
    lastActivityAt: run.updatedAt,
  }, {
    id: `runtime:guardian:${run.id}:${run.status}:${run.phase || ''}:${run.recoveryCount || 0}`,
    at: run.updatedAt,
    kind,
    message: runtimeGuardianMessage(run),
  });
}

function applyDeveloper(project: DevProject, job: DeveloperJob): DevProject {
  if (!isNewer(job.updatedAt, project.lastActivityAt)) return project;

  let status: ProjectStatus = 'WAITING_USER';
  let progress = project.progress;
  let phase = 'ChatGPT作業指示準備済み';
  let blockers = project.humanBlockers;
  let kind: TimelineEvent['kind'] = 'human';

  if (job.status === 'starting' || job.status === 'running') {
    if (job.phase === 'waiting_ci') {
      status = 'WAITING_AI';
      progress = Math.max(progress, 78);
      phase = 'ChatGPT変更済み · CI監視中';
      blockers = [];
      kind = 'info';
    } else if (job.phase === 'recovery_ready') {
      progress = Math.max(progress, 65);
      phase = 'CI失敗 · ChatGPT復旧指示あり';
      blockers = unique(['復旧指示をChatGPTで実行']);
      kind = 'warning';
    } else if (job.phase === 'human_required') {
      phase = '人間操作が必要';
      blockers = unique([job.error || '権限・承認など人間操作を確認']);
    } else {
      progress = Math.max(progress, 35);
      phase = 'ChatGPT実行待ち';
      blockers = unique(['Supervisorが準備した指示をChatGPTで実行']);
    }
  } else if (job.status === 'completed') {
    status = 'WAITING_USER';
    progress = Math.max(progress, job.pullRequest ? 95 : 90);
    phase = job.pullRequest ? `CI成功 · Draft PR #${job.pullRequest.number} レビュー待ち` : 'CI成功 · 最終確認待ち';
    blockers = unique([job.pullRequest ? `Draft PR #${job.pullRequest.number} をレビュー` : '実装結果と証拠を最終確認']);
  } else {
    status = 'ERROR';
    phase = 'ChatGPT Orchestrator設定エラー';
    kind = 'error';
  }

  return patchRuntime(project, {
    status,
    progress,
    currentPhase: phase,
    executionMode: 'CHAT',
    automationLevel: 'ASSIST',
    humanBlockers: blockers,
    lastActivityAt: job.updatedAt,
  }, {
    id: `runtime:developer:${job.id}:${job.status}:${job.phase || ''}:${job.recoveryCount ?? 0}`,
    at: job.updatedAt,
    kind,
    message: runtimeDeveloperMessage(job),
  });
}

function applyBackground(project: DevProject, job: BackgroundJob): DevProject {
  if (!isNewer(job.updatedAt, project.lastActivityAt)) return project;

  if (job.kind === 'orchestration_handoff') {
    return patchRuntime(project, {
      status: 'WAITING_USER',
      progress: Math.max(project.progress, 20),
      currentPhase: 'Supervisor整理完了 · ChatGPT実行待ち',
      executionMode: 'CHAT',
      automationLevel: 'ASSIST',
      humanBlockers: unique(['Supervisorが準備した指示をChatGPTで実行']),
      lastActivityAt: job.updatedAt,
    }, {
      id: `runtime:orchestration:${job.id}`,
      at: job.updatedAt,
      kind: 'human',
      message: `Supervisor: GPT引き継ぎ指示を準備${job.degradedOrchestration ? '（fallback使用）' : ''}`,
    });
  }

  // Legacy background-executor jobs remain readable, but are never treated as proof of new ChatGPT execution.
  let status: ProjectStatus = 'WAITING_USER';
  let progress = project.progress;
  let phase = '旧Background Job結果 · 確認待ち';
  let blockers = unique(['旧Background Jobの結果を確認し、必要ならChatGPTで再検証']);
  let kind: TimelineEvent['kind'] = 'warning';
  if (job.status === 'queued' || job.status === 'in_progress') {
    status = 'WAITING_AI';
    phase = '旧Background Job処理中';
    blockers = [];
    kind = 'info';
  }

  return patchRuntime(project, {
    status,
    progress,
    currentPhase: phase,
    executionMode: 'CHAT',
    automationLevel: 'ASSIST',
    humanBlockers: blockers,
    lastActivityAt: job.updatedAt,
  }, {
    id: `runtime:legacy-background:${job.id}:${job.status}`,
    at: job.updatedAt,
    kind,
    message: `旧Background Job ${job.status}: 新規の完成証拠には使用しません`,
  });
}

function patchRuntime(project: DevProject, patch: Partial<DevProject>, event: TimelineEvent) {
  const timeline = project.timeline.some((item) => item.id === event.id)
    ? project.timeline
    : [...project.timeline, event].slice(-100);
  return { ...project, ...patch, timeline };
}

function runtimeGuardianMessage(run: GuardianRun) {
  if (run.status === 'completed') return `Guardian: ChatGPT作業後のCI成功確認済み${run.pullRequest ? ` / Draft PR #${run.pullRequest.number}` : ''}`;
  if (run.status === 'review_ready') return `Guardian: ${run.phase === 'human_required' ? '人間操作が必要' : 'レビュー待ち'}`;
  if (run.status === 'waiting_ci') return 'Guardian: 現在headのGitHub Actionsを監視中';
  if (run.status === 'expired') return 'Guardian: 監視時間上限。状態保存済み、ChatGPTで再開可能';
  if (run.phase === 'recovery_ready') return `Guardian: CI失敗を検出しChatGPT復旧指示を準備（${run.recoveryCount || 0}回目）`;
  if (run.phase === 'handoff_ready' || run.phase === 'waiting_chatgpt') return 'Guardian: ChatGPT実行待ち。Workerは監督のみ継続';
  if (run.status === 'failed') return `Guardian設定エラー: ${run.message || run.error || 'unknown'}`;
  return 'Guardian: オーケストレーション監督中';
}

function runtimeDeveloperMessage(job: DeveloperJob) {
  if (job.status === 'completed') return job.pullRequest ? `ChatGPT作業後のCI成功: Draft PR #${job.pullRequest.number}` : 'ChatGPT作業後のCI成功確認済み';
  if (job.phase === 'recovery_ready') return `CI失敗: ChatGPT復旧指示を準備（${job.recoveryCount ?? 0}回目）`;
  if (job.phase === 'waiting_ci') return 'ChatGPT変更を検出: CI監視中';
  if (job.status === 'failed') return `Orchestrator設定エラー: ${job.error || 'unknown error'}`;
  return `ChatGPT実行待ち: ${job.workspace.branch}`;
}

function isNewer(candidate: string, current: string) {
  return +new Date(candidate) > +new Date(current);
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}
