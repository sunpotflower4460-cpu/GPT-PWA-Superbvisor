import { useEffect, useMemo, useState } from 'react';
import { DevProject, ProjectStatus, QuickAction, buildActionPrompt, loadProjects, saveProjects } from './core';
import {
  BackgroundJob,
  loadWorkerConnection,
  startBackgroundJob,
} from './backgroundWorker';
import { GuardianRun, startGuardianRun } from './guardianRunner';
import {
  OperatingPlan,
  OperatingPlanTarget,
  defaultOperatingPlan,
  formatOperatingPlanPrompt,
  getOperatingPlan,
  saveOperatingPlan,
  targetLabels,
} from './operatingPlan';

type ExecutionRoute = 'CHAT' | 'BACKGROUND' | 'GUARDIAN';

const runAction: QuickAction = {
  id: 'operating-plan-run',
  label: 'Operating Planどおりに進める',
  intent: '保存済みOperating Planの到達地点・標準手順・実行ルールに従い、その範囲で安全に前進する',
};

export default function OperatingPlanCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [plan, setPlan] = useState<OperatingPlan>(() => defaultOperatingPlan());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [guardian, setGuardian] = useState<GuardianRun | null>(null);
  const [background, setBackground] = useState<BackgroundJob | null>(null);
  const [deviceIndependent, setDeviceIndependent] = useState(false);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );

  const recommendedRoute: ExecutionRoute = useMemo(() => {
    if (!deviceIndependent) return 'CHAT';
    return selected?.githubUrl ? 'GUARDIAN' : 'BACKGROUND';
  }, [deviceIndependent, selected?.githubUrl]);

  useEffect(() => {
    const handler = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      openCenter(projectId);
    };
    window.addEventListener('devdeck:open-operating-plan', handler);
    return () => window.removeEventListener('devdeck:open-operating-plan', handler);
  }, []);

  function openCenter(preferredProjectId?: string) {
    const nextProjects = loadProjects();
    const nextId = preferredProjectId && nextProjects.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : selectedId && nextProjects.some((project) => project.id === selectedId)
        ? selectedId
        : nextProjects[0]?.id ?? '';
    setProjects(nextProjects);
    setSelectedId(nextId);
    setPlan(nextId ? getOperatingPlan(nextId) : defaultOperatingPlan());
    setGuardian(null);
    setBackground(null);
    setDeviceIndependent(false);
    setMessage('');
    setOpen(true);
  }

  function changeProject(id: string) {
    setSelectedId(id);
    setPlan(getOperatingPlan(id));
    setGuardian(null);
    setBackground(null);
    setDeviceIndependent(false);
    setMessage('');
  }

  function patch(patchValue: Partial<OperatingPlan>) {
    setPlan((current) => ({ ...current, ...patchValue }));
    setMessage('');
  }

  function persistPlan() {
    if (!selected) return false;
    saveOperatingPlan(selected.id, plan);
    setPlan(getOperatingPlan(selected.id));
    window.dispatchEvent(new CustomEvent('devdeck:operating-plan-changed', { detail: { projectId: selected.id } }));
    return true;
  }

  function save() {
    if (!persistPlan()) return;
    setMessage('Operating Planを保存しました。ChatGPT実行とSupervisor / Guardian監督の両方に反映されます。');
  }

  function markLocalExecution(route: ExecutionRoute, phase: string, at = new Date().toISOString(), status?: ProjectStatus) {
    if (!selected) return;
    const next = loadProjects().map((project) => {
      if (project.id !== selected.id) return project;
      // Actual work always belongs to ChatGPT. The route only changes the orchestration level.
      const executionMode: DevProject['executionMode'] = 'CHAT';
      const automationLevel: DevProject['automationLevel'] = route === 'GUARDIAN' ? 'GUARDIAN' : 'ASSIST';
      const event = {
        id: `execution-route:${route}:${at}`,
        at,
        kind: 'info' as const,
        message: `ChatGPT実行 + ${routeLabel(route)}監督: ${phase}`,
      };
      return {
        ...project,
        executionMode,
        automationLevel,
        status: status ?? project.status,
        currentPhase: phase,
        lastActivityAt: at,
        timeline: project.timeline.some((item) => item.id === event.id) ? project.timeline : [...project.timeline, event].slice(-100),
      };
    });
    saveProjects(next);
    setProjects(next);
    window.dispatchEvent(new CustomEvent('devdeck:projects-changed'));
  }

  async function copyChatPrompt() {
    if (!selected || !persistPlan()) return;
    setBusy('copy');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      await navigator.clipboard.writeText(prompt);
      setMessage('Planを保存し、ChatGPTへ貼る実行指示をコピーしました。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '指示をコピーできませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function copyAndOpenChat() {
    if (!selected || !persistPlan()) return;
    const target = safeChatUrl(selected.chatUrl) || 'https://chatgpt.com/';
    const nextWindow = window.open(target, '_blank', 'noopener,noreferrer');
    setBusy('chat-open');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      await navigator.clipboard.writeText(prompt);
      markLocalExecution('CHAT', 'Operating Plan · ChatGPT実行指示を準備');
      setMessage(nextWindow
        ? 'Plan指示をコピーしてChatGPTを開きました。開いたチャットへ貼り付けて送信してください。'
        : 'Plan指示はコピーしました。ポップアップがブロックされたためChatGPTは手動で開いてください。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Chat用指示を準備できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function runBackground() {
    if (!selected || !persistPlan()) return;
    setBusy('background');
    setMessage('');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      const job = await startBackgroundJob(selected, prompt, loadWorkerConnection());
      setBackground(job);
      setGuardian(null);
      markLocalExecution('BACKGROUND', 'Supervisor · ChatGPT引き継ぎ指示準備済み', job.updatedAt, 'WAITING_USER');
      setMessage('Supervisor APIが現在地点を整理し、ChatGPT用の次手を準備しました。APIは実作業を実行していません。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Supervisor指示を準備できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function runGuardian() {
    if (!selected || !persistPlan()) return;
    if (!selected.githubUrl) {
      setMessage('Guardian監督には案件のGitHub URL登録が必要です。非GitHub案件はSupervisorでChatGPT指示を準備できます。');
      return;
    }
    setBusy('guardian');
    setMessage('');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      const run = await startGuardianRun(selected, prompt, { maxCycles: 3, maxToolTurns: 10, maxMinutes: 180 }, loadWorkerConnection());
      setGuardian(run);
      setBackground(null);
      markLocalExecution('GUARDIAN', 'Guardian · ChatGPT実行待ち', run.updatedAt, 'WAITING_USER');
      setMessage('Guardianが安全な作業branchとChatGPT指示を準備しました。以後はChatGPTの変更→現在headのCI→失敗時の復旧指示を監視します。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Guardianを開始できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function runRecommended() {
    if (recommendedRoute === 'CHAT') return copyAndOpenChat();
    if (recommendedRoute === 'GUARDIAN') return runGuardian();
    return runBackground();
  }

  function preset(target: OperatingPlanTarget) {
    const base = defaultOperatingPlan();
    patch({
      ...base,
      target,
      workflow: target === 'IMPLEMENTED'
        ? '現状確認 → 実装・修正 → 最低限の動作確認 → 実装結果を報告'
        : target === 'CI_GREEN'
          ? '現状確認 → 実装・修正 → テスト/型チェック/ビルド → CI確認 → 失敗時修正 → CI成功まで'
          : target === 'REVIEW_READY'
            ? '現状確認 → 実装・修正 → テスト/CI → 自己レビュー → Draft PRまたはレビュー可能状態まで'
            : base.workflow,
    });
  }

  return (
    <>
      <button className="plan-fab" onClick={() => openCenter()} aria-label="Operating Plan">☷</button>
      {open && (
        <div className="plan-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="plan-sheet">
            <header className="plan-header">
              <div><p className="eyebrow">PROJECT OPERATING CONTRACT</p><h2>Operating Plan</h2></div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            <div className="plan-note">
              <b>一度決めた「進め方」を毎回説明し直さない。</b>
              <span>実行者は常にChatGPT。Supervisor / Guardianは外部APIで監督・復旧・CI確認を補助します。</span>
            </div>

            {projects.length === 0 ? (
              <div className="empty-state compact"><div>☷</div><h2>案件がありません</h2><p>先にプロジェクトを登録してください。</p></div>
            ) : (
              <>
                <div className="plan-tabs">
                  {projects.map((project) => (
                    <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => changeProject(project.id)}>{project.name}</button>
                  ))}
                </div>

                {selected && (
                  <div className="plan-body">
                    <article className="plan-project-card">
                      <div><strong>{selected.name}</strong><b>{plan.target === 'CUSTOM' ? plan.customTarget || targetLabels.CUSTOM : targetLabels[plan.target]}</b></div>
                      <span>{selected.goal}</span>
                    </article>

                    <div className="plan-presets">
                      <button onClick={() => preset('IMPLEMENTED')}>実装まで</button>
                      <button onClick={() => preset('CI_GREEN')}>CI成功まで</button>
                      <button onClick={() => preset('REVIEW_READY')}>レビューまで</button>
                      <button onClick={() => preset('MANUAL_ONLY')}>手動だけまで</button>
                    </div>

                    <label className="plan-field">到達地点
                      <select value={plan.target} onChange={(event) => patch({ target: event.target.value as OperatingPlanTarget })}>
                        {(Object.keys(targetLabels) as OperatingPlanTarget[]).map((target) => <option key={target} value={target}>{targetLabels[target]}</option>)}
                      </select>
                    </label>

                    {plan.target === 'CUSTOM' && (
                      <label className="plan-field">カスタム到達地点
                        <input value={plan.customTarget} onChange={(event) => patch({ customTarget: event.target.value })} placeholder="例：App Store提出直前、本人の証明書操作だけの状態まで" />
                      </label>
                    )}

                    <label className="plan-field">標準手順
                      <textarea rows={4} value={plan.workflow} onChange={(event) => patch({ workflow: event.target.value })} placeholder="現状確認 → 実装 → テスト → レビュー..." />
                    </label>

                    <div className="plan-rules">
                      <PlanToggle checked={plan.inspectBeforeWork} onChange={(value) => patch({ inspectBeforeWork: value })} title="最初に現状確認" detail="既完了を確認して重複を避ける" />
                      <PlanToggle checked={plan.continueWithoutConfirmation} onChange={(value) => patch({ continueWithoutConfirmation: value })} title="途中確認で止まらない" detail="ChatGPTで安全に進められる工程は連続実行" />
                      <PlanToggle checked={plan.validateAndTest} onChange={(value) => patch({ validateAndTest: value })} title="テスト・検証する" detail="完成判定を自己申告だけにしない" />
                      <PlanToggle checked={plan.recoverFromFailure} onChange={(value) => patch({ recoverFromFailure: value })} title="失敗時に復旧を試す" detail="Guardianが証拠を整理しChatGPTへ修正指示" />
                      <PlanToggle checked={plan.selfReview} onChange={(value) => patch({ selfReview: value })} title="停止前に自己レビュー" detail="差分・副作用・未完了を確認" />
                      <PlanToggle checked={plan.finalReport} onChange={(value) => patch({ finalReport: value })} title="最後に短く報告" detail="実施内容・残作業・本人作業を整理" />
                    </div>

                    <label className="plan-field">案件固有ルール <small>任意</small>
                      <textarea rows={4} value={plan.customInstructions} onChange={(event) => patch({ customInstructions: event.target.value })} placeholder="例：UIはモバイル優先。無料枠を優先。既存機能を壊さない。" />
                    </label>

                    <details className="plan-preview">
                      <summary>ChatGPTへ渡るPlanを確認</summary>
                      <pre>{formatOperatingPlanPrompt(plan)}</pre>
                    </details>

                    <button className="plan-save" onClick={save}>この案件のPlanを保存</button>

                    <section className="execution-router">
                      <div className="execution-router-head">
                        <div><b>実行・監督ルート</b><small>作業はChatGPT。必要な時だけ外部Supervisorを追加。</small></div>
                        <label className="execution-persist-toggle">
                          <input type="checkbox" checked={deviceIndependent} onChange={(event) => setDeviceIndependent(event.target.checked)} />
                          <span>端末を閉じても監督を残したい</span>
                        </label>
                      </div>

                      <div className="execution-route-grid">
                        <RouteCard route="CHAT" recommended={recommendedRoute === 'CHAT'} disabled={Boolean(busy)} title="💬 ChatGPT" detail="実装・デバッグ・レビューを実際に行う本体。追加API費用なし。" onClick={copyAndOpenChat} />
                        <RouteCard route="BACKGROUND" recommended={recommendedRoute === 'BACKGROUND'} disabled={Boolean(busy)} title="⚡ Supervisor" detail="DeepSeek/MiniMax等で低コストに状態整理・次手生成。実作業はChatGPT。" onClick={runBackground} />
                        <RouteCard route="GUARDIAN" recommended={recommendedRoute === 'GUARDIAN'} disabled={Boolean(busy) || !selected.githubUrl} title="🛡 Guardian" detail={selected.githubUrl ? 'ChatGPT変更→CI監視→失敗時復旧指示を継続。' : 'GitHub URL登録済み案件のみ。'} onClick={runGuardian} />
                      </div>

                      <button className={`execution-recommended ${recommendedRoute.toLowerCase()}`} disabled={Boolean(busy)} onClick={runRecommended}>{busy ? '準備中…' : `推奨: ${routeLabel(recommendedRoute)} でPlanを開始`}</button>
                      <button className="execution-copy-only" disabled={Boolean(busy)} onClick={copyChatPrompt}>ChatGPT実行指示だけコピー</button>
                      <p className="plan-cost-note">Supervisor / GuardianのLLM APIはオーケストレーション専用です。コード実装・GitHub編集を外部モデルへ委譲しません。</p>
                    </section>

                    {background && <article className="plan-run-status background completed"><div><b>Supervisor · GPT HANDOFF READY</b><span>{background.orchestratorProvider || 'deterministic'} / {background.model}</span></div><p>{background.checkpoint?.summary || background.report?.summary || 'ChatGPTへ渡すPlanを準備しました。'}</p>{background.handoffPrompt && <button onClick={() => void copyAndOpenSpecificChat(background.handoffPrompt!, selected.chatUrl)}>ChatGPTで実行 ↗</button>}</article>}

                    {guardian && <article className={`plan-run-status ${guardian.status}`}><div><b>Guardian · {guardian.status}</b><span>復旧 {guardian.recoveryCount || 0}回</span></div><p>{guardian.message || 'Guardian監督を開始しました。'}</p>{guardian.handoffPrompt && guardian.status !== 'completed' && <button onClick={() => void copyAndOpenSpecificChat(guardian.handoffPrompt!, selected.chatUrl)}>ChatGPTで続ける ↗</button>}{guardian.pullRequest && <button onClick={() => openGitHub(guardian.pullRequest!.url)}>Draft PR #{guardian.pullRequest.number} ↗</button>}</article>}
                    {message && <div className="plan-message">{message}</div>}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function RouteCard({ route, recommended, disabled, title, detail, onClick }: { route: ExecutionRoute; recommended: boolean; disabled: boolean; title: string; detail: string; onClick: () => void | Promise<void>; }) {
  return <button className={`execution-route ${route.toLowerCase()} ${recommended ? 'recommended' : ''}`} disabled={disabled} onClick={onClick}><span>{recommended ? '推奨' : '選択'}</span><b>{title}</b><small>{detail}</small></button>;
}

function PlanToggle({ checked, onChange, title, detail }: { checked: boolean; onChange: (value: boolean) => void; title: string; detail: string }) {
  return <label className="plan-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><b>{title}</b><small>{detail}</small></span></label>;
}

function routeLabel(route: ExecutionRoute) {
  if (route === 'GUARDIAN') return 'ChatGPT + Guardian';
  if (route === 'BACKGROUND') return 'ChatGPT + Supervisor';
  return 'ChatGPT';
}

async function copyAndOpenSpecificChat(prompt: string, value?: string) {
  try { await navigator.clipboard.writeText(prompt); } catch { /* opening Chat still helps */ }
  window.open(safeChatUrl(value) || 'https://chatgpt.com/', '_blank', 'noopener,noreferrer');
}

function safeChatUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function openGitHub(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com') window.open(url.toString(), '_blank', 'noopener,noreferrer');
  } catch { /* ignore unsafe URL */ }
}
