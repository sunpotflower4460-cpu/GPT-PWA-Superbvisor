import { useEffect, useMemo, useState } from 'react';
import { buildActionPrompt, loadProjects, quickActions, type DevProject } from './core';
import { getOperatingPlan, formatOperatingPlanPrompt } from './operatingPlan';
import {
  ChatBridgeStatus,
  ChatCommand,
  ChatProjectOverview,
  cancelProjectChatCommand,
  chatCommandStatusLabel,
  chatProjectActivityLabel,
  enqueueProjectChatCommand,
  getChatBridgeStatus,
  getChatControlOverview,
  listProjectChatCommands,
  retryProjectChatCommand,
} from './chatControl';

const continueAction = quickActions.find((item) => item.id === 'continue')!;

export default function ChatControlCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [bridge, setBridge] = useState<ChatBridgeStatus>({ connected: false, capabilities: [] });
  const [overviews, setOverviews] = useState<Record<string, ChatProjectOverview>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );
  const overviewProjectIds = useMemo(
    () => projects.filter((project) => Boolean(project.chatUrl)).map((project) => project.id),
    [projects],
  );
  const overviewKey = overviewProjectIds.join('|');
  const overviewSummary = useMemo(() => {
    const values = Object.values(overviews);
    return {
      connected: values.filter((item) => item.bridgeConnected).length,
      active: values.filter((item) => ['DELIVERING', 'RETRY_SCHEDULED', 'QUEUED', 'WAITING_BRIDGE'].includes(item.activity)).length,
      attention: values.filter((item) => item.activity === 'NEEDS_ATTENTION').length,
    };
  }, [overviews]);

  useEffect(() => {
    const handler = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      openCenter(projectId);
    };
    window.addEventListener('devdeck:open-chat-control', handler);
    return () => window.removeEventListener('devdeck:open-chat-control', handler);
  }, []);

  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [commandResult, bridgeResult] = await Promise.all([
          listProjectChatCommands(selected.id),
          getChatBridgeStatus(selected.id),
        ]);
        if (!cancelled) {
          setCommands(commandResult.commands);
          setBridge(bridgeResult);
        }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Chat Control状態を取得できませんでした。');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 6000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, selected?.id]);

  useEffect(() => {
    if (!open || !overviewProjectIds.length) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await getChatControlOverview(overviewProjectIds);
        if (!cancelled) {
          setOverviews(Object.fromEntries(result.projects.map((item) => [item.projectId, item])));
        }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : '複数ChatGPTの状態一覧を更新できませんでした。');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  // overviewKey gives this polling effect a stable dependency across project-array reloads.
  }, [open, overviewKey]);

  function openCenter(preferredProjectId?: string) {
    const next = loadProjects();
    const nextId = preferredProjectId && next.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : next.find((project) => project.chatUrl)?.id ?? next[0]?.id ?? '';
    setProjects(next);
    setSelectedId(nextId);
    setPrompt('');
    setCommands([]);
    setBridge({ connected: false, capabilities: [] });
    setOverviews({});
    setMessage('');
    setOpen(true);
  }

  async function refreshCommands(project = selected) {
    if (!project) return;
    const [commandResult, bridgeResult] = await Promise.all([
      listProjectChatCommands(project.id),
      getChatBridgeStatus(project.id),
    ]);
    setCommands(commandResult.commands);
    setBridge(bridgeResult);
  }

  async function refreshProjectOverview(projectId: string) {
    const result = await getChatControlOverview([projectId]);
    const item = result.projects[0];
    if (item) setOverviews((current) => ({ ...current, [item.projectId]: item }));
    return item;
  }

  async function queue(project: DevProject, value: string, source: string) {
    const text = value.trim();
    if (!text) return;
    setBusy(`${project.id}:${source}`);
    setMessage('');
    try {
      await enqueueProjectChatCommand(project, text);
      const [, freshOverview] = await Promise.all([
        project.id === selected?.id ? refreshCommands(project) : Promise.resolve(),
        refreshProjectOverview(project.id),
      ]);
      setMessage(freshOverview?.bridgeConnected
        ? `${project.name} の送信キューへ追加しました。接続中Bridgeが取得して対象ChatGPTへ配送します。`
        : `${project.name} の送信キューへ追加しました。PWAを閉じてもWorker側に残り、この案件のBridge接続後に配送できます。`);
      if (source === 'free') setPrompt('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ChatGPT指示をキューへ追加できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function retryFailed(command: ChatCommand) {
    setBusy(`${command.projectId}:retry:${command.id}`);
    setMessage('');
    try {
      await retryProjectChatCommand(command.projectId, command.id);
      await Promise.all([refreshCommands(), refreshProjectOverview(command.projectId)]);
      setMessage('送信失敗commandを同じIDのまま再キューしました。Bridge接続後に再配送します。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'commandを再試行できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function queueContinue(project: DevProject) {
    return queue(project, buildActionPrompt(project, continueAction), 'continue');
  }

  function useQuickAction(actionId: string) {
    if (!selected) return;
    const action = quickActions.find((item) => item.id === actionId);
    if (!action) return;
    setPrompt(buildActionPrompt(selected, action));
  }

  function useAutopilotPlan() {
    if (!selected) return;
    const plan = getOperatingPlan(selected.id);
    setPrompt(`この案件を保存済みAutopilot Routeに従って継続してください。\n\n${formatOperatingPlanPrompt(plan)}\n\n完了済み工程を再実行せず、未完了地点から再開してください。途中の成功を最終完了と誤認せず、指定ルート全体の到達地点まで進めてください。`);
  }

  async function connectBridge(project: DevProject) {
    const chatUrl = safeChatUrl(project.chatUrl);
    if (!chatUrl) {
      setMessage('安全なChatGPT URLが登録されていないためBridge接続を開始できません。');
      return;
    }
    const instruction = `この開発チャットをAI DEV DECKから遠隔操作できるように、接続済みのAI DEV DECK ChatGPT Bridgeアプリを使ってBridgeを接続してください。\n\nprojectId: ${project.id}\nprojectName: ${project.name}\n\n利用するtool: connect_ai_dev_deck_bridge\nこのチャット自体を実装・デバッグ・GitHub編集の実行主体として維持し、BridgeはPWAから届く次ターン指示の中継だけに使ってください。`;
    try {
      await navigator.clipboard.writeText(instruction);
      setMessage('Bridge接続指示をコピーしました。開いたChatGPTへ一度だけ貼り付けて送信してください。接続後はPWA側から指示できます。');
    } catch {
      setMessage('ChatGPTを開きます。Bridge toolへこの案件のprojectIdを指定して接続してください。');
    }
    window.open(chatUrl, '_blank', 'noopener,noreferrer');
  }

  async function manualFallback(command: ChatCommand) {
    const chatUrl = safeChatUrl(command.chatUrl);
    if (!chatUrl) {
      setMessage('安全なChatGPT URLではないため手動fallbackを開始できません。');
      return;
    }

    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setMessage('ブラウザに新しいタブをブロックされたため、Queueは取消していません。ポップアップを許可してから再度お試しください。');
      return;
    }
    popup.opener = null;
    setBusy(`${command.projectId}:manual:${command.id}`);
    setMessage('手動送信用の指示を準備しています…');
    try {
      try {
        await navigator.clipboard.writeText(command.prompt);
      } catch {
        popup.close();
        setMessage('指示をClipboardへコピーできなかったため、Queueは取消していません。Clipboard権限を許可してから再度お試しください。');
        return;
      }

      setMessage('指示をコピーしました。自動配送を停止してから手動ChatGPTへ切り替えています…');
      await cancelProjectChatCommand(command.projectId, command.id);
      await Promise.all([refreshCommands(), refreshProjectOverview(command.projectId)]);
      popup.location.replace(chatUrl);
      setMessage('指示をコピーし、自動Queueを取消してからChatGPTを開きました。同じ指示がBridgeから後で重複配送されることはありません。');
    } catch (error) {
      popup.close();
      setMessage(`${error instanceof Error ? error.message : 'commandを安全に取消できませんでした。'} 自動配送が残っている可能性があるため、手動送信は開始していません。`);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <button className="chat-control-fab" onClick={() => openCenter()} aria-label="Multi Chat Control">💬</button>
      {open && (
        <div className="chat-control-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="chat-control-sheet">
            <header className="chat-control-header">
              <div><p className="eyebrow">MULTI CHAT REMOTE</p><h2>Chat Control</h2></div>
              <div className="chat-control-header-actions">
                <span className={`bridge-live ${bridge.connected ? 'connected' : 'offline'}`}>{bridge.connected ? '● このChatGPTに接続中' : '○ このChatGPTはBridge待ち'}</span>
                <button className="icon-button" onClick={() => setOpen(false)}>×</button>
              </div>
            </header>

            <div className="chat-control-note">
              <b>複数の開発ChatGPTを、このPWAからまとめて動かす。</b>
              <span>指示はWorkerへ永続キュー保存。案件ごとのChatGPT Bridgeが接続されると、PWAを離れずその既存チャットへ配送します。</span>
              {overviewProjectIds.length > 0 && (
                <small>全体: {overviewSummary.connected}/{overviewProjectIds.length}接続 ・ {overviewSummary.active}進行/待機 ・ {overviewSummary.attention}要確認</small>
              )}
              {bridge.lastSeenAt && <small>選択中Bridge: {bridge.bridgeId || 'unknown'} ・ 最終heartbeat {new Date(bridge.lastSeenAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>}
            </div>

            {!projects.length ? (
              <div className="empty-state compact"><div>💬</div><h2>案件がありません</h2><p>先に開発プロジェクトとChatGPT URLを登録してください。</p></div>
            ) : (
              <div className="chat-control-layout">
                <aside className="chat-project-rail">
                  {projects.map((project) => {
                    const projectOverview = overviews[project.id];
                    const remoteClass = projectOverview ? activityClass(projectOverview.activity) : 'loading';
                    const countLabel = projectOverview
                      ? `${projectOverview.approximate ? '直近 ' : ''}${projectOverview.pendingRecentCount ? `${projectOverview.pendingRecentCount}待機` : ''}${projectOverview.failedRecentCount ? `${projectOverview.pendingRecentCount ? ' ・ ' : ''}${projectOverview.failedRecentCount}失敗` : ''}`
                      : '';
                    return (
                      <div className={`chat-project-row ${project.id === selected?.id ? 'active' : ''}`} key={project.id}>
                        <button className="chat-project-select" onClick={() => { setSelectedId(project.id); setCommands([]); setBridge({ connected: false, capabilities: [] }); setMessage(''); }}>
                          <span className={`chat-project-dot ${project.status.toLowerCase()}`} />
                          <span className="chat-project-copy">
                            <b>{project.name}</b>
                            <small>{project.currentPhase}</small>
                            {project.chatUrl ? (
                              <span className={`chat-project-remote ${remoteClass}`} title={projectOverview?.error || undefined}>
                                <i />{projectOverview ? chatProjectActivityLabel(projectOverview.activity) : '状態確認中'}
                                {countLabel && <em>{countLabel}</em>}
                              </span>
                            ) : (
                              <span className="chat-project-remote no-url"><i />Chat URL未登録</span>
                            )}
                          </span>
                        </button>
                        <button
                          className="chat-project-continue"
                          disabled={!project.chatUrl || Boolean(busy)}
                          onClick={() => void queueContinue(project)}
                          title="このChatGPTへ続行指示をキュー"
                        >▶</button>
                      </div>
                    );
                  })}
                </aside>

                {selected && (
                  <div className="chat-control-main">
                    <section className="chat-session-head">
                      <div><span>選択中</span><h3>{selected.name}</h3><p>{selected.currentPhase}</p></div>
                      <div className="chat-session-actions">
                        <div className={`bridge-badge ${selected.chatUrl ? 'ready' : 'missing'}`}>{selected.chatUrl ? 'Chat URL ✓' : 'URL未登録'}</div>
                        {!bridge.connected && selected.chatUrl && <button className="bridge-connect-button" onClick={() => void connectBridge(selected)}>Bridgeを接続 ↗</button>}
                      </div>
                    </section>

                    <div className="chat-control-quick">
                      <button onClick={() => useQuickAction('continue')}>そのまま続ける</button>
                      <button onClick={() => useQuickAction('inspect-first')}>問題点も確認</button>
                      <button onClick={() => useQuickAction('manual-only')}>手動だけまで</button>
                      <button onClick={useAutopilotPlan}>Autopilot Route</button>
                    </div>

                    <label className="chat-command-compose">このChatGPTへ送る指示
                      <textarea
                        rows={7}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder="例：まず3回デバッグ。問題が残れば追加で数回。問題なければ次の機能を追加し、その後3回補強→3回デバッグ→UI/UX改善を3回。"
                      />
                    </label>
                    <button
                      className="chat-command-send"
                      disabled={!selected.chatUrl || !prompt.trim() || Boolean(busy)}
                      onClick={() => void queue(selected, prompt, 'free')}
                    >
                      {busy ? 'キューへ追加中…' : bridge.connected ? 'このChatGPTへ送る ▶' : '送信キューへ保存 ▶'}
                    </button>

                    <section className="chat-command-queue">
                      <div className="section-heading"><span>送信キュー</span><b>{commands.filter((item) => item.status === 'queued' || item.status === 'claimed').length}待機</b></div>
                      {!commands.length && <p className="muted">この案件の送信履歴はまだありません。</p>}
                      {commands.slice(0, 12).map((command) => (
                        <article className={`chat-command-row ${command.status}`} key={command.id}>
                          <div>
                            <span>{chatCommandStatusLabel(command.status)}</span>
                            <time>{new Date(command.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                          </div>
                          <p>{command.prompt}</p>
                          {command.status === 'queued' && Boolean(command.deliveryFailures) && (
                            <small>自動再試行 {Math.min((command.deliveryFailures || 0) + 1, command.maxDeliveryAttempts || 3)}/{command.maxDeliveryAttempts || 3}
                              {command.nextAttemptAt ? ` ・ ${new Date(command.nextAttemptAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}以降` : ''}
                            </small>
                          )}
                          {command.bridgeId && <small>Bridge: {command.bridgeId}</small>}
                          {command.detail && <small>{command.detail}</small>}
                          {command.status === 'failed' && (
                            <button className="chat-manual-fallback" disabled={Boolean(busy)} onClick={() => void retryFailed(command)}>同じcommandを再試行 ↻</button>
                          )}
                          {(command.status === 'queued' || command.status === 'failed') && (
                            <button className="chat-manual-fallback" disabled={Boolean(busy)} onClick={() => void manualFallback(command)}>自動Queueを止めて手動送信 ↗</button>
                          )}
                        </article>
                      ))}
                    </section>
                    {message && <div className="chat-control-message">{message}</div>}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function activityClass(activity: ChatProjectOverview['activity']) {
  return activity.toLowerCase().replace(/_/g, '-');
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