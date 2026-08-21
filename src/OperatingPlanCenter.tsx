import { useEffect, useMemo, useState } from 'react';
import { DevProject, buildActionPrompt, loadProjects, quickActions } from './core';
import { loadWorkerConnection } from './backgroundWorker';
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

const runAction = quickActions.find((action) => action.id === 'manual-only') ?? quickActions[0];

export default function OperatingPlanCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [plan, setPlan] = useState<OperatingPlan>(() => defaultOperatingPlan());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [guardian, setGuardian] = useState<GuardianRun | null>(null);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );

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
    setMessage('');
    setOpen(true);
  }

  function changeProject(id: string) {
    setSelectedId(id);
    setPlan(getOperatingPlan(id));
    setGuardian(null);
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
    setMessage('Operating Planを保存しました。今後の標準指示・Background・GitHub Agent・Guardianに反映されます。');
  }

  async function copyChatPrompt() {
    if (!selected || !persistPlan()) return;
    setBusy('copy');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      await navigator.clipboard.writeText(prompt);
      setMessage('Planを保存し、ChatGPTへ貼る標準指示をコピーしました。API費用は発生しません。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '指示をコピーできませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function runGuardian() {
    if (!selected || !persistPlan()) return;
    if (!selected.githubUrl) {
      setMessage('Guardian実行には案件のGitHub URL登録が必要です。Chat用コピーはそのまま使えます。');
      return;
    }
    setBusy('guardian');
    setMessage('');
    try {
      const prompt = buildActionPrompt(selected, runAction);
      const run = await startGuardianRun(selected, prompt, { maxCycles: 3, maxToolTurns: 10, maxMinutes: 180 }, loadWorkerConnection());
      setGuardian(run);
      setMessage('Operating Planを標準設定（最大3 cycle / 3時間）でGuardianへ渡しました。端末を閉じてもWebhook/Cronが監督します。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Guardianを開始できませんでした。');
    } finally {
      setBusy('');
    }
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
              <span>標準はChat-first。Planは実行方針を共有しますが、API Background / Guardianへは明示ボタンを押した時だけ昇格します。</span>
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
                      <PlanToggle checked={plan.continueWithoutConfirmation} onChange={(value) => patch({ continueWithoutConfirmation: value })} title="途中確認で止まらない" detail="安全に進められる工程は連続実行" />
                      <PlanToggle checked={plan.validateAndTest} onChange={(value) => patch({ validateAndTest: value })} title="テスト・検証する" detail="完成判定を自己申告だけにしない" />
                      <PlanToggle checked={plan.recoverFromFailure} onChange={(value) => patch({ recoverFromFailure: value })} title="失敗時に復旧を試す" detail="原因を見て修正または別アプローチ" />
                      <PlanToggle checked={plan.selfReview} onChange={(value) => patch({ selfReview: value })} title="停止前に自己レビュー" detail="差分・副作用・未完了を確認" />
                      <PlanToggle checked={plan.finalReport} onChange={(value) => patch({ finalReport: value })} title="最後に短く報告" detail="実施内容・残作業・本人作業を整理" />
                    </div>

                    <label className="plan-field">案件固有ルール <small>任意</small>
                      <textarea rows={4} value={plan.customInstructions} onChange={(event) => patch({ customInstructions: event.target.value })} placeholder="例：UIはモバイル優先。無料枠を優先。既存機能を壊さない。" />
                    </label>

                    <details className="plan-preview">
                      <summary>AIへ渡るPlanを確認</summary>
                      <pre>{formatOperatingPlanPrompt(plan)}</pre>
                    </details>

                    <button className="plan-save" onClick={save}>この案件のPlanを保存</button>
                    <div className="plan-run-actions">
                      <button disabled={Boolean(busy)} onClick={copyChatPrompt}>{busy === 'copy' ? 'コピー中…' : '💬 Chat用指示をコピー'}</button>
                      <button className="guardian" disabled={Boolean(busy) || !selected.githubUrl} onClick={runGuardian}>{busy === 'guardian' ? '開始中…' : '🛡 GuardianでPlan実行'}</button>
                    </div>
                    <p className="plan-cost-note">ChatコピーはAPI費用なし。GuardianはOpenAI APIを利用し、最大3 cycle / 3時間で停止します。自動mergeはしません。</p>

                    {guardian && (
                      <article className={`plan-run-status ${guardian.status}`}>
                        <div><b>{guardian.status}</b><span>cycle {guardian.cycle}/{guardian.maxCycles}</span></div>
                        <p>{guardian.message || 'GuardianへPlanを引き継ぎました。'}</p>
                        {guardian.pullRequest && <button onClick={() => window.open(guardian.pullRequest!.url, '_blank', 'noopener,noreferrer')}>Draft PR #{guardian.pullRequest.number} ↗</button>}
                      </article>
                    )}
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

function PlanToggle({ checked, onChange, title, detail }: { checked: boolean; onChange: (value: boolean) => void; title: string; detail: string }) {
  return (
    <label className="plan-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span><b>{title}</b><small>{detail}</small></span>
    </label>
  );
}
