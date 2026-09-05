import { useEffect, useState } from 'react';
import { loadProjects } from './core';
import { getLatestBackgroundJob, loadWorkerConnection } from './backgroundWorker';
import { DeveloperJob, getLatestDeveloperJob, pullRequestPhrase } from './developerAgent';
import { GuardianRun, getLatestGuardianRun } from './guardianRunner';
import {
  SupervisorNotification,
  addNotification,
  clearReadNotifications,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  showSystemNotification,
} from './notifications';
import {
  PushState,
  disablePushNotifications,
  enablePushNotifications,
  getPushState,
  sendTestPush,
} from './pushNotifications';

const initialPushState: PushState = { supported: false, permission: 'unsupported', subscribed: false };
type NotificationInput = Omit<SupervisorNotification, 'id' | 'createdAt'>;

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SupervisorNotification[]>(() => loadNotifications());
  const [focusProjectId, setFocusProjectId] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [pushState, setPushState] = useState<PushState>(initialPushState);
  const [pushBusy, setPushBusy] = useState('');
  const [pushMessage, setPushMessage] = useState('');
  const unread = items.filter((item) => !item.readAt).length;
  const visibleItems = focusProjectId
    ? [...items].sort((a, b) => Number(b.projectId === focusProjectId) - Number(a.projectId === focusProjectId) || +new Date(b.createdAt) - +new Date(a.createdAt))
    : items;

  useEffect(() => {
    const reload = () => setItems(loadNotifications());
    const openFromEvent = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      void openCenter(projectId);
    };
    window.addEventListener('devdeck:notifications-changed', reload);
    window.addEventListener('devdeck:open-notifications', openFromEvent);

    const params = new URLSearchParams(window.location.search);
    if (params.get('supervisor') === 'inbox') {
      const projectId = params.get('projectId') || undefined;
      window.setTimeout(() => void openCenter(projectId), 0);
      params.delete('supervisor');
      params.delete('projectId');
      params.delete('kind');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }

    return () => {
      window.removeEventListener('devdeck:notifications-changed', reload);
      window.removeEventListener('devdeck:open-notifications', openFromEvent);
    };
  }, []);

  async function openCenter(preferredProjectId?: string) {
    setOpen(true);
    setFocusProjectId(preferredProjectId);
    setItems(loadNotifications());
    setActionMessage('');
    await Promise.all([syncStatus(), refreshPushState()]);
    setItems(loadNotifications());
  }

  async function refreshPushState() {
    try { setPushState(await getPushState()); }
    catch { setPushState(initialPushState); }
  }

  async function enablePush() {
    setPushBusy('enable'); setPushMessage('');
    try {
      await enablePushNotifications(loadWorkerConnection());
      await refreshPushState();
      setPushMessage('Push通知を有効にしました。PWAを閉じていてもBackground/Guardianの重要な状態を受け取れます。');
    } catch (error) { setPushMessage(error instanceof Error ? error.message : 'Push通知を有効にできませんでした。'); }
    finally { setPushBusy(''); }
  }

  async function disablePush() {
    setPushBusy('disable'); setPushMessage('');
    try {
      await disablePushNotifications(loadWorkerConnection());
      await refreshPushState();
      setPushMessage('Push通知を解除しました。');
    } catch (error) { setPushMessage(error instanceof Error ? error.message : 'Push通知を解除できませんでした。'); }
    finally { setPushBusy(''); }
  }

  async function testPush() {
    setPushBusy('test'); setPushMessage('');
    try {
      const result = await sendTestPush(loadWorkerConnection());
      setPushMessage(result.disabled ? 'Worker側のVAPID設定がまだありません。' : `テスト送信: ${result.sent}端末へ送信 / ${result.failed}件失敗`);
    } catch (error) { setPushMessage(error instanceof Error ? error.message : 'テストPushに失敗しました。'); }
    finally { setPushBusy(''); }
  }

  async function syncStatus() {
    setSyncing(true); setMessage('');
    const projects = loadProjects();
    const connection = loadWorkerConnection();
    let added = 0;

    for (const project of projects) {
      const localInputs: NotificationInput[] = [];
      if (project.status === 'CONTEXT_LIMIT') localInputs.push({ dedupeKey: `project:${project.id}:handoff:${project.lastActivityAt}`, projectId: project.id, projectName: project.name, kind: 'handoff', title: `${project.name}: 引き継ぎ推奨`, detail: '会話が長くなっています。Checkpointを作成して新しいChatへ移る準備ができます。', action: 'OPEN_HANDOFF', actionLabel: '引き継ぎを開く' });
      if (project.humanBlockers.length) localInputs.push({ dedupeKey: `project:${project.id}:human:${project.humanBlockers.join('|')}`, projectId: project.id, projectName: project.name, kind: 'human', title: `${project.name}: あなたが必要`, detail: project.humanBlockers.join(' / ') });
      if (project.status === 'ERROR' || project.status === 'STALLED') localInputs.push({ dedupeKey: `project:${project.id}:attention:${project.status}:${project.lastActivityAt}`, projectId: project.id, projectName: project.name, kind: 'error', title: `${project.name}: ${project.status === 'ERROR' ? 'エラー' : '停止疑い'}`, detail: `${project.currentPhase} でSupervisorの確認が必要です。` });
      for (const input of localInputs) added += persist(input);

      if (!connection.baseUrl || !connection.token) continue;
      const [backgroundResult, guardianResult, developerResult] = await Promise.allSettled([
        getLatestBackgroundJob(project.id, connection), getLatestGuardianRun(project.id, connection), getLatestDeveloperJob(project.id, connection),
      ]);

      if (backgroundResult.status === 'fulfilled') {
        const job = backgroundResult.value;
        if (job.status === 'completed') added += persist({ dedupeKey: `job:${job.id}:completed`, projectId: project.id, projectName: project.name, kind: job.report?.humanRequired.length ? 'human' : 'complete', title: `${project.name}: Background完了`, detail: job.report?.summary || job.checkpoint?.summary || 'Background処理が完了しました。' });
        if (job.status === 'failed' || job.status === 'incomplete' || job.status === 'cancelled') added += persist({ dedupeKey: `job:${job.id}:${job.status}`, projectId: project.id, projectName: project.name, kind: 'error', title: `${project.name}: Background ${job.status}`, detail: job.error || job.checkpoint?.summary || 'Background処理を確認してください。' });
        if (job.report?.humanRequired.length) added += persist({ dedupeKey: `job:${job.id}:human`, projectId: project.id, projectName: project.name, kind: 'human', title: `${project.name}: あなたが必要`, detail: job.report.humanRequired.join(' / ') });
      }

      const guardian = guardianResult.status === 'fulfilled' ? guardianResult.value : null;
      if (guardian) added += persistGuardian(project.id, project.name, guardian);
      if (developerResult.status === 'fulfilled') {
        const developer = developerResult.value;
        const coveredByGuardian = guardian && (guardian.currentDeveloperJobId === developer.id || +new Date(guardian.updatedAt) >= +new Date(developer.updatedAt));
        if (!coveredByGuardian) added += persistDeveloper(project.id, project.name, developer);
      }
    }

    setItems(loadNotifications());
    setMessage(added ? `${added}件の新しい状態を取り込みました。` : '新しい通知はありません。');
    setSyncing(false);
  }

  function read(item: SupervisorNotification) { markNotificationRead(item.id); setItems(loadNotifications()); }

  async function runItemAction(item: SupervisorNotification) {
    setActionMessage('');
    if (!item.action) return;
    if (item.action === 'OPEN_HANDOFF') {
      markNotificationRead(item.id); setItems(loadNotifications()); setOpen(false);
      window.dispatchEvent(new CustomEvent('devdeck:open-handoff', { detail: { projectId: item.projectId } })); return;
    }
    if (item.action === 'OPEN_URL') {
      const safeUrl = safeExternalUrl(item.actionUrl);
      if (!safeUrl) { setActionMessage('安全に開けるリンクを確認できませんでした。'); return; }
      markNotificationRead(item.id); setItems(loadNotifications()); window.open(safeUrl, '_blank', 'noopener,noreferrer'); return;
    }
    if (item.action === 'RECOVER_CHAT') {
      if (!item.actionPrompt) { setActionMessage('再開指示が保存されていません。Smart Supervisorから再生成してください。'); return; }
      const project = loadProjects().find((candidate) => candidate.id === item.projectId);
      const nextWindow = window.open(safeChatUrl(project?.chatUrl) || 'https://chatgpt.com/', '_blank', 'noopener,noreferrer');
      try {
        await navigator.clipboard.writeText(item.actionPrompt); markNotificationRead(item.id); setItems(loadNotifications());
        setActionMessage(nextWindow ? '再開指示をコピーしてChatを開きました。貼り付けて送信してください。' : '再開指示をコピーしました。ポップアップがブロックされたためChatは手動で開いてください。');
      } catch (error) { setActionMessage(error instanceof Error ? error.message : '再開指示をコピーできませんでした。'); }
    }
  }

  function readAll() { markAllNotificationsRead(); setItems(loadNotifications()); }
  function clearRead() { clearReadNotifications(); setItems(loadNotifications()); }

  return <>
    <button className="notification-fab" onClick={() => openCenter()} aria-label="通知">🔔{unread > 0 && <span>{unread > 99 ? '99+' : unread}</span>}</button>
    {open && <div className="notice-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section className="notice-sheet">
      <header className="notice-header"><div><p className="eyebrow">SUPERVISOR INBOX</p><h2>通知</h2></div><button className="icon-button" onClick={() => setOpen(false)}>×</button></header>
      <div className="push-card"><div><b>📲 Supervisor Push</b><small>{!pushState.supported ? 'この環境では未対応' : pushState.subscribed ? '有効・PWAを閉じても受信' : `未登録・権限 ${pushState.permission}`}</small></div><div className="push-actions">{!pushState.subscribed ? <button onClick={enablePush} disabled={pushBusy === 'enable' || !pushState.supported}>{pushBusy === 'enable' ? '設定中…' : 'Pushを有効化'}</button> : <><button onClick={testPush} disabled={pushBusy === 'test'}>{pushBusy === 'test' ? '送信中…' : 'テスト'}</button><button onClick={disablePush} disabled={pushBusy === 'disable'}>{pushBusy === 'disable' ? '解除中…' : '解除'}</button></>}</div></div>
      {pushMessage && <div className="notice-message">{pushMessage}</div>}
      {focusProjectId && <div className="notice-message">📍 Push対象案件を先頭表示しています。Workerの最新状態も再同期しました。</div>}
      <div className="notice-actions"><button onClick={syncStatus} disabled={syncing}>{syncing ? '同期中…' : '↻ 全実行状態を同期'}</button><button onClick={readAll}>すべて既読</button><button onClick={clearRead}>既読を消す</button></div>
      {message && <div className="notice-message">{message}</div>}{actionMessage && <div className="notice-message notice-action-message">{actionMessage}</div>}
      <div className="notice-list">{visibleItems.length === 0 ? <div className="empty-state compact"><div>🌿</div><h2>通知はありません</h2><p>完了・停止・本人待ちなど重要なものだけここに残します。</p></div> : visibleItems.map((item) => <article key={item.id} className={`notice-item ${item.kind} ${item.readAt ? 'read' : ''}`}><button className="notice-item-main" onClick={() => read(item)}><span className="notice-icon">{icon(item.kind)}</span><div><strong>{item.title}</strong><p>{item.detail}</p><time>{new Date(item.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>{!item.readAt && <i />}</button>{item.action && <button className={`notice-item-action ${item.action.toLowerCase()}`} onClick={() => runItemAction(item)}>{item.actionLabel || '開く'}</button>}</article>)}</div>
    </section></div>}
  </>;
}

function persist(input: NotificationInput) { const created = addNotification(input); if (!created) return 0; showSystemNotification(created); return 1; }
function persistGuardian(projectId: string, projectName: string, run: GuardianRun) {
  if (run.status === 'review_ready') return persist({ dedupeKey: `guardian:${run.id}:review_ready:${run.cycle}`, projectId, projectName, kind: 'human', title: `${projectName}: Guardianレビュー待ち`, detail: run.message || run.finalSummary || 'コード作業は終了しましたが、CIを確認できないためレビューが必要です。', ...(run.pullRequest ? { action: 'OPEN_URL' as const, actionLabel: `${pullRequestPhrase(run.pullRequest)} を開く`, actionUrl: run.pullRequest.url } : {}) });
  if (run.status === 'completed') return persist({ dedupeKey: `guardian:${run.id}:completed`, projectId, projectName, kind: run.pullRequest ? 'human' : 'complete', title: run.pullRequest ? `${projectName}: CI成功・最終レビュー待ち` : `${projectName}: Guardian完了`, detail: run.message || run.finalSummary || 'Guardianが設定した工程を完了しました。', ...(run.pullRequest ? { action: 'OPEN_URL' as const, actionLabel: `${pullRequestPhrase(run.pullRequest)} を開く`, actionUrl: run.pullRequest.url } : {}) });
  if (run.status === 'failed' || run.status === 'expired') return persist({ dedupeKey: `guardian:${run.id}:${run.status}:${run.cycle}`, projectId, projectName, kind: 'error', title: `${projectName}: Guardian ${run.status === 'expired' ? '時間上限' : '停止'}`, detail: run.error || run.message || 'Guardianが上限または復旧不能エラーで停止しました。', ...(run.pullRequest ? { action: 'OPEN_URL' as const, actionLabel: `${pullRequestPhrase(run.pullRequest)} を確認`, actionUrl: run.pullRequest.url } : {}) });
  return 0;
}
function persistDeveloper(projectId: string, projectName: string, job: DeveloperJob) {
  if (job.status === 'completed') return persist({ dedupeKey: `developer:${job.id}:completed`, projectId, projectName, kind: 'human', title: `${projectName}: GitHub Agent完了`, detail: job.outputText || (job.pullRequest ? `${pullRequestPhrase(job.pullRequest)} を作成しました。` : 'Developer Agentの結果を確認してください。'), ...(job.pullRequest ? { action: 'OPEN_URL' as const, actionLabel: `${pullRequestPhrase(job.pullRequest)} を開く`, actionUrl: job.pullRequest.url } : {}) });
  if (job.status === 'failed') return persist({ dedupeKey: `developer:${job.id}:failed`, projectId, projectName, kind: 'error', title: `${projectName}: GitHub Agent停止`, detail: job.error || job.outputText || 'Developer Agentが停止しました。', ...(job.pullRequest ? { action: 'OPEN_URL' as const, actionLabel: `${pullRequestPhrase(job.pullRequest)} を確認`, actionUrl: job.pullRequest.url } : {}) });
  return 0;
}
function safeChatUrl(value?: string) { if (!value) return null; try { const url = new URL(value); const host = url.hostname.toLowerCase(); if (url.protocol !== 'https:' || (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com')) return null; return url.toString(); } catch { return null; } }
function safeExternalUrl(value?: string) { if (!value) return null; try { const url = new URL(value); if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null; return url.toString(); } catch { return null; } }
function icon(kind: SupervisorNotification['kind']) { if (kind === 'complete') return '✓'; if (kind === 'human') return '👤'; if (kind === 'error') return '!'; if (kind === 'handoff') return '↗'; return '•'; }
