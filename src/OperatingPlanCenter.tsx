import { useEffect, useMemo, useState } from 'react';
import { DevProject, ProjectStatus, QuickAction, buildActionPrompt, loadProjects, saveProjects } from './core';
import {
  BackgroundJob,
  loadWorkerConnection,
  startBackgroundJob,
} from './backgroundWorker';
import { GuardianRun, startGuardianRun } from './guardianRunner';
import { pullRequestStatusLabel } from './developerAgent';
import { enqueueProjectChatCommand } from './chatControl';
import {
  OperatingPlan,
  OperatingPlanTarget,
  defaultOperatingPlan,
  effectiveWorkflow,
  formatOperatingPlanPrompt,
  getOperatingPlan,
  isAutopilotRouteWorkflow,
  isValidChatUrl,
  parseRoutePlan,
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

  // Multi Chat / Specialist Chat: binds one declared phase to a specific
  // already-open ChatGPT chat. An empty value clears the binding for that
  // phase (falls back to the project's default chatUrl — see
  // routePlan.ts's resolveRouteDispatchChatUrl on the Worker side).
  function patchPhaseChatUrl(nodeId: string, chatUrl: string) {
    setPlan((current) => {
      const next = { ...current.phaseChatUrls };
      if (chatUrl.trim()) next[nodeId] = chatUrl; else delete next[nodeId];
      return { ...current, phaseChatUrls: next };
    });
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
      const executionMode: DevProject['executionMode'] = 'CHAT';
      const automationLevel: DevProject['automationLevel'] = route === 'GUARDIAN' ? 'GUARDIAN' : route === 'BACKGROUND' ? 'AUTO' : 'ASSIST';
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
        humanBlockers: status === 'WAITING_USER' ? project.humanBlockers : [],
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
      setMessage('手動fallback用にPlan指示をコピーしました。通常はChat Control Busから送信してください。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '指示をコピーできませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function queueChatPlan() {
    if (!selected || !persistPlan()) return;
    setBusy('chat-queue');
    setMessage('');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      await enqueueProjectChatCommand(selected, prompt, loadWorkerConnection());
      markLocalExecution('CHAT', 'Operating Plan · Chat Control Bus配送待ち', new Date().toISOString(), 'WAITING_AI');
      setMessage('Operating Planを対象ChatGPTの送信キューへ追加しました。Bridge接続中ならPWAを離れず配送されます。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PlanをChat Control Busへ追加できませんでした。');
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
      if (!job.handoffPrompt) throw new Error('SupervisorがChatGPT handoffを返しませんでした。');
      await enqueueProjectChatCommand(selected, job.handoffPrompt, loadWorkerConnection());
      setBackground(job);
      setGuardian(null);
      markLocalExecution('BACKGROUND', 'Supervisor整理済み · ChatGPT Bridge配送待ち', job.updatedAt, 'WAITING_AI');
      setMessage('Supervisorが次手を整理し、その指示をChat Control Busへ自動投入しました。実作業は対象ChatGPTが行います。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Supervisor指示を準備・配送できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function runGuardian() {
    if (!selected || !persistPlan()) return;
    if (!selected.githubUrl) {
      setMessage('Guardian監督には案件のGitHub URL登録が必要です。非GitHub案件はSupervisor経由でChatGPTへ配送できます。');
      return;
    }
    if (!selected.chatUrl) {
      setMessage('Guardian自動運転には対象ChatGPT URLの登録が必要です。');
      return;
    }
    setBusy('guardian');
    setMessage('');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      const guardianPlan = getOperatingPlan(selected.id);
      const routePlan = parseRoutePlan(effectiveWorkflow(guardianPlan), guardianPlan.phaseChatUrls);
      const run = await startGuardianRun(selected, prompt, { maxCycles: 3, maxToolTurns: 10, maxMinutes: 180 }, loadWorkerConnection(), routePlan);
      setGuardian(run);
      setBackground(null);
      markLocalExecution('GUARDIAN', 'Guardian · ChatGPT Bridge配送 / 実行待ち', run.updatedAt, 'WAITING_AI');
      setMessage('Guardianを開始しました。初回指示・CI失敗時の復旧・Autopilot次工程はChat Control Busへ自動投入されます。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Guardianを開始できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function runRecommended() {
    if (recommendedRoute === 'CHAT') return queueChatPlan();
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

  function openChatControl() {
    if (!selected) return;
    window.dispatchEvent(new CustomEvent('devdeck:open-chat-control', { detail: { projectId: selected.id } }));
  }

  return (
    <>
      <button className="plan-fab" onClick={() => openCenter()} aria-label="進め方">☷</button>
      {open && (
        <div className="plan-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="plan-sheet">
            <header className="plan-header">
              <div><p className="eyebrow">PROJECT OPERATING CONTRACT</p><h2>Operating Plan</h2></div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            <div className="plan-note">
              <b>一度決めた「進め方」を毎回説明し直さない。</b>
              <span>実行者は常にChatGPT。Supervisor / Guardianは監督・復旧・CI確認と次手配送だけを補助します。</span>
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

                    {(() => {
                      const workflow = effectiveWorkflow(plan);
                      const phases = parseRoutePlan(workflow);
                      if (phases.length < 2) return null;
                      // The Worker only redispatches to a LATER phase's
                      // bound chat when the workflow is a recognized
                      // AUTOPILOT ROUTE (repeat-count/conditional-branch
                      // language — see isAutopilotRouteWorkflow and
                      // worker/src/developerAgent.ts's
                      // hasAutopilotRouteContract gate on job.prompt) —
                      // routePhaseIndex only ever advances past 0 inside
                      // that branch. But phase 1's own binding is NOT in
                      // the same boat: resolveRouteDispatchChatUrl
                      // (routePlan.ts) resolves routePlan[0].chatUrl for
                      // EVERY dispatch at phase index 0 — the initial
                      // handoff and every CI-failure recovery — for any
                      // workflow, autopilot or not (a single-shot
                      // workflow's one-and-only dispatch IS phase 1's
                      // dispatch). So phase 1 must stay visible/editable
                      // always; only phase 2+ is ever actually inert for
                      // a non-autopilot workflow, and even then the row
                      // stays visible+editable (not hidden, not
                      // disabled) so an existing stale binding from
                      // before the workflow text changed can still be
                      // seen and cleared, not just silently stranded.
                      const autopilot = isAutopilotRouteWorkflow(workflow);
                      return (
                        <div className="plan-field plan-specialist-chats">
                          <span>工程ごとのSpecialist Chat <small>任意・空欄は既定のChatGPT URLへ</small></span>
                          <small className="plan-specialist-chat-caution">
                            {autopilot
                              ? '標準手順の途中に工程を挿入/削除すると、下の割り当てが別の工程にずれることがあります。編集後は割り当てを見直してください。'
                              : 'この標準手順は自動運転ルート(回数指定や条件分岐を含む手順)として認識されていないため、1つ目の工程の割り当てのみ実際に使われます。2つ目以降は保存はされますが使われません(不要なら空欄にしてください)。'}
                          </small>
                          {phases.map((phase, index) => {
                            const inert = !autopilot && index > 0;
                            return (
                              <label key={phase.id} className="plan-specialist-chat-row">
                                <small>{phase.label}{inert ? ' (未使用)' : ''}</small>
                                <input
                                  value={plan.phaseChatUrls[phase.id] || ''}
                                  onChange={(event) => patchPhaseChatUrl(phase.id, event.target.value)}
                                  placeholder="https://chatgpt.com/c/..."
                                />
                                {plan.phaseChatUrls[phase.id] && !isValidChatUrl(plan.phaseChatUrls[phase.id]) && (
                                  <small className="plan-specialist-chat-warning">有効なChatGPT URLではありません(https://chatgpt.com/... など)</small>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      );
                    })()}

                    <div className="plan-rules">
                      <PlanToggle checked={plan.inspectBeforeWork} onChange={(value) => patch({ inspectBeforeWork: value })} title="最初に現状確認" detail="既完了を確認して重複を避ける" />
                      <PlanToggle checked={plan.continueWithoutConfirmation} onChange={(value) => patch({ continueWithoutConfirmation: value })} title="途中確認で止まらない" detail="ChatGPTで安全に進められる工程は連続実行" />
                      <PlanToggle checked={plan.validateAndTest} onChange={(value) => patch({ validateAndTest: value })} title="テスト・検証する" detail="完成判定を自己申告だけにしない" />
                      <PlanToggle checked={plan.recoverFromFailure} onChange={(value) => patch({ recoverFromFailure: value })} title="失敗時に復旧を試す" detail="Guardianが証拠を整理しChatGPTへ修正指示を自動配送" />
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
                        <div><b>実行・監督ルート</b><small>作業はChatGPT。必要な時だけSupervisor / Guardianを追加。</small></div>
                        <label className="execution-persist-toggle">
                          <input type="checkbox" checked={deviceIndependent} onChange={(event) => setDeviceIndependent(event.target.checked)} />
                          <span>端末を閉じても監督を残したい</span>
                        </label>
                      </div>

                      <div className="execution-route-grid">
                        <RouteCard route="CHAT" recommended={recommendedRoute === 'CHAT'} disabled={Boolean(busy) || !selected.chatUrl} title="💬 ChatGPT" detail="Planを対象ChatGPTのQueueへ直接送る。通常の第一ルート。" onClick={queueChatPlan} />
                        <RouteCard route="BACKGROUND" recommended={recommendedRoute === 'BACKGROUND'} disabled={Boolean(busy) || !selected.chatUrl} title="⚡ Supervisor" detail="低コストで次手整理し、その結果をChatGPT Queueへ自動配送。" onClick={runBackground} />
                        <RouteCard route="GUARDIAN" recommended={recommendedRoute === 'GUARDIAN'} disabled={Boolean(busy) || !selected.githubUrl || !selected.chatUrl} title="🛡 Guardian" detail={selected.githubUrl ? 'ChatGPT変更→CI監視→失敗/次工程を自動Queue。' : 'GitHub URL登録済み案件のみ。'} onClick={runGuardian} />
                      </div>

                      <button className={`execution-recommended ${recommendedRoute.toLowerCase()}`} disabled={Boolean(busy) || !selected.chatUrl} onClick={runRecommended}>{busy ? '準備中…' : `推奨: ${routeLabel(recommendedRoute)} でPlanを開始`}</button>
                      <button className="execution-copy-only" disabled={Boolean(busy)} onClick={copyChatPrompt}>手動fallback: 実行指示をコピー</button>
                      <p className="plan-cost-note">Supervisor / GuardianのLLM APIはオーケストレーション専用です。コード実装・GitHub編集を外部モデルへ委譲しません。</p>
                    </section>

                    {background && <article className="plan-run-status background completed"><div><b>Supervisor · QUEUED TO CHATGPT</b><span>{background.orchestratorProvider || 'deterministic'} / {background.model}</span></div><p>{background.checkpoint?.summary || background.report?.summary || 'ChatGPTへ渡すPlanを準備しQueueへ送信しました。'}</p><button onClick={openChatControl}>Chat Controlで確認</button></article>}

                    {guardian && <article className={`plan-run-status ${guardian.status}`}><div><b>Guardian · {guardian.status}</b><span>復旧 {guardian.recoveryCount || 0}回</span></div><p>{guardian.message || 'Guardian監督を開始しました。'}</p>{guardian.status !== 'completed' && <button onClick={openChatControl}>Chat Controlで確認</button>}{guardian.pullRequest && (() => {
                      const { label, note } = pullRequestStatusLabel(guardian.pullRequest);
                      return <>
                        <button onClick={() => openGitHub(guardian.pullRequest!.url)}>{label}</button>
                        {note && <small className="plan-pr-note">{note}</small>}
                      </>;
                    })()}</article>}
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

function openGitHub(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com') window.open(url.toString(), '_blank', 'noopener,noreferrer');
  } catch { /* ignore unsafe URL */ }
}
