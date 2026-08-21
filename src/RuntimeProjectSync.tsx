import { useEffect, useRef } from 'react';
import { BackgroundJob, getLatestBackgroundJob, loadWorkerConnection } from './backgroundWorker';
import { DevProject, ProjectStatus, TimelineEvent, loadProjects, saveProjects } from './core';
import { GuardianRun, getLatestGuardianRun } from './guardianRunner';

const SYNC_INTERVAL_MS = 120_000;

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
      const [guardianResult, backgroundResult] = await Promise.allSettled([
        getLatestGuardianRun(project.id, connection),
        getLatestBackgroundJob(project.id, connection),
      ]);
      const guardian = guardianResult.status === 'fulfilled' ? guardianResult.value : null;
      const background = backgroundResult.status === 'fulfilled' ? backgroundResult.value : null;
      const source = chooseLatest(guardian, background);
      const updated = source?.type === 'guardian'
        ? applyGuardian(project, source.value)
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

function chooseLatest(guardian: GuardianRun | null, background: BackgroundJob | null) {
  if (!guardian && !background) return null;
  if (guardian && !background) return { type: 'guardian' as const, value: guardian };
  if (!guardian && background) return { type: 'background' as const, value: background };
  return +new Date(guardian!.updatedAt) >= +new Date(background!.updatedAt)
    ? { type: 'guardian' as const, value: guardian! }
    : { type: 'background' as const, value: background! };
}

function applyGuardian(project: DevProject, run: GuardianRun): DevProject {
  if (!isNewer(run.updatedAt, project.lastActivityAt)) return project;

  let status: ProjectStatus = 'RUNNING';
  let progress = project.progress;
  let phase = `Guardian cycle ${run.cycle}/${run.maxCycles}`;
  let blockers = project.humanBlockers;
  let kind: TimelineEvent['kind'] = 'info';

  if (run.status === 'running' || run.status === 'starting') {
    progress = Math.max(progress, Math.min(70, 35 + run.cycle * 10));
    phase = `Guardian cycle ${run.cycle}/${run.maxCycles} · 実装中`;
    blockers = [];
  } else if (run.status === 'waiting_ci') {
    status = 'WAITING_AI';
    progress = Math.max(progress, 78);
    phase = `Guardian cycle ${run.cycle}/${run.maxCycles} · CI確認中`;
    blockers = [];
  } else if (run.status === 'review_ready') {
    status = 'WAITING_USER';
    progress = Math.max(progress, 90);
    phase = 'コード作業完了 · CI未確認のためレビュー待ち';
    blockers = unique([
      run.pullRequest ? `Draft PR #${run.pullRequest.number} をレビュー` : '成果物をレビュー',
      'CIが確認できないため、完了扱い前に検証する',
    ]);
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
      phase = 'Guardian完了 · CI成功確認済み';
      blockers = [];
      kind = 'success';
    }
  } else {
    status = 'ERROR';
    phase = run.status === 'expired' ? 'Guardian時間上限で停止' : 'Guardianが復旧上限で停止';
    kind = 'error';
  }

  return patchRuntime(project, {
    status,
    progress,
    currentPhase: phase,
    executionMode: 'API_WORKER',
    automationLevel: 'GUARDIAN',
    humanBlockers: blockers,
    lastActivityAt: run.updatedAt,
  }, {
    id: `runtime:guardian:${run.id}:${run.status}:${run.cycle}`,
    at: run.updatedAt,
    kind,
    message: runtimeGuardianMessage(run),
  });
}

function applyBackground(project: DevProject, job: BackgroundJob): DevProject {
  if (!isNewer(job.updatedAt, project.lastActivityAt)) return project;

  let status: ProjectStatus = 'RUNNING';
  let progress = project.progress;
  let phase = job.currentPhase || 'Background処理中';
  let blockers = project.humanBlockers;
  let kind: TimelineEvent['kind'] = 'info';

  if (job.status === 'queued' || job.status === 'in_progress') {
    progress = Math.max(progress, 35);
    phase = job.currentPhase ? `Background · ${job.currentPhase}` : 'Background処理中';
    blockers = [];
  } else if (job.status === 'completed') {
    const human = job.report?.humanRequired ?? [];
    if (human.length) {
      status = 'WAITING_USER';
      progress = Math.max(progress, 90);
      phase = job.report?.reachedStage || 'Background完了 · あなた待ち';
      blockers = unique(human);
      kind = 'human';
    } else if (job.report?.done) {
      status = 'COMPLETED';
      progress = 100;
      phase = job.report.reachedStage || 'Background目標完了';
      blockers = [];
      kind = 'success';
    } else {
      status = 'WAITING_AI';
      phase = job.report?.reachedStage || 'Background処理完了 · 次工程確認';
      blockers = [];
      kind = 'success';
    }
  } else {
    status = 'ERROR';
    phase = `Background ${job.status}`;
    kind = 'error';
  }

  return patchRuntime(project, {
    status,
    progress,
    currentPhase: phase,
    executionMode: 'API_WORKER',
    humanBlockers: blockers,
    lastActivityAt: job.updatedAt,
  }, {
    id: `runtime:background:${job.id}:${job.status}:${job.retryCount ?? 0}`,
    at: job.updatedAt,
    kind,
    message: runtimeBackgroundMessage(job),
  });
}

function patchRuntime(project: DevProject, patch: Partial<DevProject>, event: TimelineEvent) {
  const timeline = project.timeline.some((item) => item.id === event.id)
    ? project.timeline
    : [...project.timeline, event].slice(-100);
  return { ...project, ...patch, timeline };
}

function runtimeGuardianMessage(run: GuardianRun) {
  if (run.status === 'completed') return `Guardian: CI成功確認済み${run.pullRequest ? ` / Draft PR #${run.pullRequest.number}` : ''}`;
  if (run.status === 'review_ready') return 'Guardian: コード作業完了。CI未確認のため人間レビュー待ち';
  if (run.status === 'waiting_ci') return `Guardian cycle ${run.cycle}/${run.maxCycles}: GitHub Actions待ち`;
  if (run.status === 'failed' || run.status === 'expired') return `Guardian停止: ${run.message || run.error || run.status}`;
  return `Guardian cycle ${run.cycle}/${run.maxCycles}: 実装・復旧を継続中`;
}

function runtimeBackgroundMessage(job: BackgroundJob) {
  if (job.status === 'completed') return `Background完了: ${job.report?.summary || job.checkpoint?.summary || '処理完了'}`;
  if (job.status === 'failed' || job.status === 'incomplete' || job.status === 'cancelled') return `Background停止: ${job.error || job.status}`;
  return `Background ${job.status}${job.retryCount ? ` · retry ${job.retryCount}` : ''}`;
}

function isNewer(candidate: string, current: string) {
  return +new Date(candidate) > +new Date(current);
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}
