import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { loadWorkerConnection } from './backgroundWorker';
import {
  CloudStateRecord,
  deleteCloudState as deleteRemoteCloudState,
  getCloudState,
  pushCloudState,
} from './cloudStateSync';
import { DevProject, loadProjects, saveProjects } from './core';
import { HandoffCheckpoint, loadHandoffCheckpoints } from './handoff';
import { SupervisorNotification, addNotification, loadNotifications, saveNotifications } from './notifications';
import { OperatingPlan, loadOperatingPlans } from './operatingPlan';
import { WatchdogState, loadWatchdogStates, saveWatchdogStates } from './watchdog';

const BACKUP_SCHEMA = 'gpt-pwa-supervisor.backup';
const BACKUP_VERSION = 1;
const AUTO_SYNC_KEY = 'gpt-pwa-supervisor.cloud-auto-sync.v1';
const AUTO_SYNC_LAST_KEY = 'gpt-pwa-supervisor.cloud-auto-sync-last.v1';
const AUTO_SYNC_INTERVAL_MS = 5 * 60_000;
const AUTO_SYNC_DEBOUNCE_MS = 45_000;
const STORAGE_KEYS = {
  plans: 'gpt-pwa-supervisor.operating-plans.v1',
  handoffs: 'gpt-pwa-supervisor.handoffs.v1',
};

type BackupMode = 'MERGE' | 'REPLACE';
type CloudBusy = '' | 'check' | 'push' | 'pull' | 'force' | 'delete';
type AutoSyncStatus = 'idle' | 'syncing' | 'ok' | 'conflict' | 'error';

interface BackupEnvelope {
  schema: typeof BACKUP_SCHEMA;
  version: number;
  createdAt: string;
  sourceOrigin: string;
  data: {
    projects: DevProject[];
    operatingPlans: Record<string, OperatingPlan>;
    handoffs: HandoffCheckpoint[];
    notifications: SupervisorNotification[];
    watchdog: Record<string, WatchdogState>;
  };
}

export default function DataBackupCenter() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<BackupEnvelope | null>(null);
  const [fileName, setFileName] = useState('');
  const [cloudState, setCloudState] = useState<CloudStateRecord<BackupEnvelope> | null>(null);
  const [cloudBusy, setCloudBusy] = useState<CloudBusy>('');
  const [cloudMessage, setCloudMessage] = useState('');
  const [cloudError, setCloudError] = useState('');
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(() => localStorage.getItem(AUTO_SYNC_KEY) === 'true');
  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus>('idle');
  const [lastAutoSyncAt, setLastAutoSyncAt] = useState(() => localStorage.getItem(AUTO_SYNC_LAST_KEY) || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const autoSyncRunning = useRef(false);

  useEffect(() => {
    const handler = () => openCenter();
    window.addEventListener('devdeck:open-backup', handler);
    return () => window.removeEventListener('devdeck:open-backup', handler);
  }, []);

  useEffect(() => {
    if (!autoSyncEnabled) return;
    let debounceTimer = 0;
    const configured = () => {
      const value = loadWorkerConnection();
      return Boolean(value.baseUrl.trim() && value.token.trim());
    };
    const runSoon = () => {
      if (autoSyncRunning.current || document.visibilityState === 'hidden' || !configured()) return;
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void autoSyncOnce(), AUTO_SYNC_DEBOUNCE_MS);
    };
    const runOnVisible = () => {
      if (document.visibilityState === 'visible') runSoon();
    };

    const startup = window.setTimeout(() => {
      if (configured()) void autoSyncOnce();
    }, 2500);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && configured()) void autoSyncOnce();
    }, AUTO_SYNC_INTERVAL_MS);

    window.addEventListener('devdeck:projects-changed', runSoon);
    window.addEventListener('devdeck:operating-plan-changed', runSoon);
    window.addEventListener('focus', runSoon);
    document.addEventListener('visibilitychange', runOnVisible);

    return () => {
      window.clearTimeout(startup);
      window.clearTimeout(debounceTimer);
      window.clearInterval(interval);
      window.removeEventListener('devdeck:projects-changed', runSoon);
      window.removeEventListener('devdeck:operating-plan-changed', runSoon);
      window.removeEventListener('focus', runSoon);
      document.removeEventListener('visibilitychange', runOnVisible);
    };
  }, [autoSyncEnabled]);

  const currentCounts = useMemo(() => snapshotCounts(createBackup()), [open]);
  const connection = loadWorkerConnection();
  const cloudAvailable = Boolean(connection.baseUrl.trim() && connection.token.trim());

  function openCenter() {
    setOpen(true);
    setMessage('');
    setError('');
    setPending(null);
    setFileName('');
    setCloudMessage('');
    setCloudError('');
    if (loadWorkerConnection().baseUrl.trim() && loadWorkerConnection().token.trim()) {
      window.setTimeout(() => void refreshCloudState(false), 0);
    }
  }

  function exportBackup() {
    const backup = createBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ai-dev-deck-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setMessage(`バックアップを書き出しました（案件 ${backup.data.projects.length}件）。`);
    setError('');
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMessage('');
    setError('');
    try {
      const backup = parseBackup(await file.text());
      setPending(backup);
      setFileName(file.name);
    } catch (reason) {
      setPending(null);
      setFileName('');
      setError(reason instanceof Error ? reason.message : 'バックアップを読み込めませんでした。');
    }
  }

  function restore(mode: BackupMode) {
    if (!pending) return;
    if (mode === 'REPLACE') {
      const ok = window.confirm('この端末の案件・Plan・Handoff・通知・Watchdog履歴をバックアップ内容で置き換えます。Worker接続設定は変更されません。続けますか？');
      if (!ok) return;
    }

    const restored = mode === 'MERGE' ? mergeBackup(createBackup(), pending) : pending;
    writeBackup(restored);
    setPending(null);
    setFileName('');
    setMessage(mode === 'MERGE'
      ? `バックアップをマージしました。案件は現在 ${restored.data.projects.length}件です。`
      : `バックアップへ置き換えました。案件は現在 ${restored.data.projects.length}件です。`);
    setError('');
  }

  async function refreshCloudState(showMessage = true) {
    setCloudBusy('check');
    setCloudError('');
    if (showMessage) setCloudMessage('');
    try {
      const state = await getCloudState<BackupEnvelope>();
      if (!state) {
        setCloudState(null);
        if (showMessage) setCloudMessage('Cloudにはまだ同期データがありません。');
        return null;
      }
      const validated = parseBackup(JSON.stringify(state.data));
      const next = { ...state, data: validated };
      setCloudState(next);
      if (showMessage) setCloudMessage(`Cloud状態を確認しました。案件 ${validated.data.projects.length}件。`);
      return next;
    } catch (reason) {
      setCloudError(reason instanceof Error ? reason.message : 'Cloud状態を確認できませんでした。');
      return null;
    } finally {
      setCloudBusy('');
    }
  }

  async function saveCurrentToCloud(force = false) {
    if (force) {
      const ok = window.confirm('Cloud側で別端末が更新した内容があっても、この端末の状態で上書きします。必要な場合だけ使ってください。続けますか？');
      if (!ok) return;
    }
    setCloudBusy(force ? 'force' : 'push');
    setCloudMessage('');
    setCloudError('');
    try {
      const backup = createBackup();
      const result = await pushCloudState(backup, { force });
      if (!result.ok) {
        const current = result.current;
        setCloudError(current
          ? `Cloudは別端末で ${new Date(current.updatedAt).toLocaleString('ja-JP')} に更新されています。先にCloudから安全にマージしてから保存してください。`
          : 'Cloudが別端末で更新されています。先にCloud状態を確認・マージしてください。');
        await refreshCloudState(false);
        return;
      }
      setCloudState(result.state);
      setCloudMessage(`この端末の状態をCloudへ保存しました。案件 ${backup.data.projects.length}件。`);
    } catch (reason) {
      setCloudError(reason instanceof Error ? reason.message : 'Cloudへ保存できませんでした。');
    } finally {
      setCloudBusy('');
    }
  }

  async function mergeCloudIntoDevice() {
    setCloudBusy('pull');
    setCloudMessage('');
    setCloudError('');
    try {
      const remote = await getCloudState<BackupEnvelope>();
      if (!remote) {
        setCloudState(null);
        setCloudMessage('Cloudにはまだ同期データがありません。');
        return;
      }
      const incoming = parseBackup(JSON.stringify(remote.data));
      const merged = mergeBackup(createBackup(), incoming);
      writeBackup(merged);
      setCloudState({ ...remote, data: incoming });
      setCloudMessage(`Cloudから安全にマージしました。案件は現在 ${merged.data.projects.length}件です。`);
    } catch (reason) {
      setCloudError(reason instanceof Error ? reason.message : 'Cloudから復元できませんでした。');
    } finally {
      setCloudBusy('');
    }
  }

  async function deleteCloudCopy() {
    const ok = window.confirm('Cloudflare KV上の同期コピーだけを削除します。この端末の案件データは消えません。続けますか？');
    if (!ok) return;
    setAutoSyncPreference(false);
    setCloudBusy('delete');
    setCloudMessage('');
    setCloudError('');
    try {
      await deleteRemoteCloudState();
      setCloudState(null);
      setCloudMessage('Cloud同期コピーを削除しました。この端末のデータは残っています。Auto SyncもOFFにしました。');
    } catch (reason) {
      setCloudError(reason instanceof Error ? reason.message : 'Cloud同期コピーを削除できませんでした。');
    } finally {
      setCloudBusy('');
    }
  }

  function changeAutoSync(enabled: boolean) {
    if (enabled) {
      const currentConnection = loadWorkerConnection();
      if (!currentConnection.baseUrl.trim() || !currentConnection.token.trim()) {
        setCloudError('Auto Syncを使うには先にBackground Worker接続を保存してください。');
        return;
      }
      const ok = window.confirm('Auto Syncを有効にすると、PWAを開いている間に案件・Plan・履歴などの非秘密データをCloudflare KVと同期します。Chat URLや履歴も含まれます。続けますか？');
      if (!ok) return;
    }
    setAutoSyncPreference(enabled);
    setCloudError('');
    setCloudMessage(enabled ? 'Auto Syncを有効にしました。PWA起動中・復帰時・約5分ごとに安全同期します。' : 'Auto SyncをOFFにしました。');
    if (enabled) window.setTimeout(() => void autoSyncOnce(), 0);
  }

  function setAutoSyncPreference(enabled: boolean) {
    localStorage.setItem(AUTO_SYNC_KEY, enabled ? 'true' : 'false');
    setAutoSyncEnabled(enabled);
    if (!enabled) setAutoSyncStatus('idle');
  }

  async function autoSyncOnce() {
    if (autoSyncRunning.current) return;
    const currentConnection = loadWorkerConnection();
    if (!currentConnection.baseUrl.trim() || !currentConnection.token.trim()) return;

    autoSyncRunning.current = true;
    setAutoSyncStatus('syncing');
    try {
      const local = createBackup();
      const remote = await getCloudState<BackupEnvelope>();

      if (!remote) {
        const first = await pushCloudState(local, { baseRevision: null });
        if (!first.ok) {
          recordAutoSyncConflict(first.current?.revision, first.current?.updatedAt);
          return;
        }
        setCloudState(first.state);
        recordAutoSyncSuccess();
        return;
      }

      const incoming = parseBackup(JSON.stringify(remote.data));
      const merged = mergeNewestBackup(local, incoming);
      if (!sameBackupData(local, merged)) writeBackup(merged);

      const saved = await pushCloudState(merged, { baseRevision: remote.revision });
      if (!saved.ok) {
        recordAutoSyncConflict(saved.current?.revision, saved.current?.updatedAt);
        return;
      }
      setCloudState(saved.state);
      recordAutoSyncSuccess();
    } catch (reason) {
      setAutoSyncStatus('error');
      if (open) setCloudError(reason instanceof Error ? reason.message : 'Auto Syncに失敗しました。');
    } finally {
      autoSyncRunning.current = false;
    }
  }

  function recordAutoSyncSuccess() {
    const at = new Date().toISOString();
    localStorage.setItem(AUTO_SYNC_LAST_KEY, at);
    setLastAutoSyncAt(at);
    setAutoSyncStatus('ok');
  }

  function recordAutoSyncConflict(revision?: string, updatedAt?: string) {
    setAutoSyncStatus('conflict');
    const detail = updatedAt
      ? `別端末が ${new Date(updatedAt).toLocaleString('ja-JP')} にCloudを更新しました。自動上書きはせず停止しました。設定 → データバックアップでCloudから安全にマージしてください。`
      : '別端末のCloud更新と競合しました。自動上書きはせず停止しました。設定 → データバックアップで確認してください。';
    addNotification({
      dedupeKey: `cloud-sync-conflict:${revision || updatedAt || 'unknown'}`,
      kind: 'error',
      title: 'Cloud Sync: 競合を検出',
      detail,
    });
    if (open) setCloudError(detail);
  }

  const preview = pending ? snapshotCounts(pending) : null;
  const cloudCounts = cloudState ? snapshotCounts(cloudState.data) : null;

  return (
    <>
      <button className="backup-settings-launcher" onClick={openCenter}>
        <span>↧</span>
        <div><b>データバックアップ</b><small>案件・Plan・履歴をJSON保存 / Cloud同期</small></div>
        <i>›</i>
      </button>

      {open && (
        <div className="backup-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="backup-sheet">
            <header className="backup-header">
              <div><p className="eyebrow">LOCAL DATA SAFETY</p><h2>バックアップ / 同期</h2></div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            <div className="backup-note">
              <b>案件状態を失わないためのバックアップです。</b>
              <span>Worker接続トークン、APIキー、Push subscriptionなどの秘密・認証情報はJSONにもCloudにも保存しません。</span>
            </div>

            <article className="backup-summary">
              <div><b>{currentCounts.projects}</b><span>案件</span></div>
              <div><b>{currentCounts.plans}</b><span>Plan</span></div>
              <div><b>{currentCounts.handoffs}</b><span>Handoff</span></div>
              <div><b>{currentCounts.notifications}</b><span>通知</span></div>
            </article>

            <section className="backup-cloud">
              <div className="backup-cloud-head">
                <div><b>☁ Cloud Sync</b><span>revision競合検知あり</span></div>
                <i className={cloudAvailable ? 'ready' : 'off'}>{cloudAvailable ? 'Worker接続あり' : 'Worker未設定'}</i>
              </div>
              {!cloudAvailable ? (
                <p>Cloud Syncは任意です。利用する場合は先に⚡ Background Workerで接続設定を保存してください。Chat-only利用には不要です。</p>
              ) : (
                <>
                  <label className="backup-auto-sync">
                    <input type="checkbox" checked={autoSyncEnabled} onChange={(event) => changeAutoSync(event.target.checked)} />
                    <span><b>Auto Sync</b><small>初期OFF。PWA起動中・復帰時・約5分ごとに新しい側を安全マージ。OpenAI APIは使いません。</small></span>
                    <i className={autoSyncStatus}>{autoSyncStatus === 'syncing' ? '同期中' : autoSyncStatus === 'conflict' ? '競合' : autoSyncEnabled ? 'ON' : 'OFF'}</i>
                  </label>
                  {lastAutoSyncAt && <p className="backup-auto-sync-last">最終Auto Sync: {new Date(lastAutoSyncAt).toLocaleString('ja-JP')}</p>}
                  {cloudState ? (
                    <div className="backup-cloud-state">
                      <div><strong>Cloud更新</strong><span>{new Date(cloudState.updatedAt).toLocaleString('ja-JP')}</span></div>
                      <div><strong>Cloud案件</strong><span>{cloudCounts?.projects ?? 0}件</span></div>
                      <div><strong>更新端末</strong><span>{cloudState.deviceId.slice(0, 8)}…</span></div>
                    </div>
                  ) : <p>Cloud上の同期コピーはまだ確認できていません。</p>}
                  <div className="backup-cloud-actions">
                    <button disabled={Boolean(cloudBusy)} onClick={() => refreshCloudState()}>{cloudBusy === 'check' ? '確認中…' : 'Cloud状態を確認'}</button>
                    <button className="backup-primary" disabled={Boolean(cloudBusy)} onClick={() => saveCurrentToCloud(false)}>{cloudBusy === 'push' ? '保存中…' : 'この端末 → Cloudへ保存'}</button>
                    <button className="backup-primary" disabled={Boolean(cloudBusy)} onClick={mergeCloudIntoDevice}>{cloudBusy === 'pull' ? 'マージ中…' : 'Cloud → 安全にマージ'}</button>
                  </div>
                  <details className="backup-cloud-advanced">
                    <summary>高度な操作</summary>
                    <div>
                      <button disabled={Boolean(cloudBusy)} onClick={() => saveCurrentToCloud(true)}>{cloudBusy === 'force' ? '上書き中…' : 'この端末でCloudを強制上書き'}</button>
                      <button className="backup-danger" disabled={Boolean(cloudBusy)} onClick={deleteCloudCopy}>{cloudBusy === 'delete' ? '削除中…' : 'Cloud同期コピーを削除'}</button>
                    </div>
                  </details>
                </>
              )}
              {cloudMessage && <div className="backup-message success">{cloudMessage}</div>}
              {cloudError && <div className="backup-message error">{cloudError}</div>}
              <small>CloudにはローカルJSONバックアップと同じ非秘密データをCloudflare KVへ保存します。Chat URLや履歴を含むため、任意機能として扱ってください。</small>
            </section>

            <section className="backup-section">
              <div><b>JSON書き出し</b><span>この端末の非秘密データを1ファイルに保存</span></div>
              <button className="backup-primary" onClick={exportBackup}>JSONバックアップを保存</button>
            </section>

            <section className="backup-section">
              <div><b>JSON復元</b><span>以前のバックアップ、または別端末から移行</span></div>
              <input ref={inputRef} className="backup-file-input" type="file" accept="application/json,.json" onChange={selectFile} />
              <button onClick={() => inputRef.current?.click()}>バックアップを選ぶ</button>
            </section>

            {pending && preview && (
              <article className="backup-preview">
                <div><b>{fileName}</b><span>{new Date(pending.createdAt).toLocaleString('ja-JP')}</span></div>
                <div className="backup-preview-counts">
                  <span>案件 {preview.projects}</span><span>Plan {preview.plans}</span><span>Handoff {preview.handoffs}</span><span>通知 {preview.notifications}</span>
                </div>
                <p>通常は「安全にマージ」がおすすめです。同じ案件IDはバックアップ側で更新し、この端末だけにある案件は残します。</p>
                <div className="backup-restore-actions">
                  <button className="backup-primary" onClick={() => restore('MERGE')}>安全にマージ</button>
                  <button className="backup-danger" onClick={() => restore('REPLACE')}>全データを置き換え</button>
                </div>
              </article>
            )}

            {message && <div className="backup-message success">{message}</div>}
            {error && <div className="backup-message error">{error}</div>}

            <p className="backup-footnote">バックアップにはChatGPT URL、GitHub URL、案件名、履歴、通知文などが含まれます。認証トークンは除外していますが、JSONファイルとCloud同期コピーは私的データとして扱ってください。</p>
          </section>
        </div>
      )}
    </>
  );
}

function createBackup(): BackupEnvelope {
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    sourceOrigin: window.location.origin,
    data: {
      projects: loadProjects(),
      operatingPlans: loadOperatingPlans(),
      handoffs: loadHandoffCheckpoints(),
      notifications: loadNotifications(),
      watchdog: loadWatchdogStates(),
    },
  };
}

function parseBackup(raw: string): BackupEnvelope {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('JSONとして読み込めないファイルです。'); }

  if (!parsed || typeof parsed !== 'object') throw new Error('バックアップ形式を確認できません。');
  const value = parsed as Partial<BackupEnvelope>;
  if (value.schema !== BACKUP_SCHEMA) throw new Error('AI DEV DECKのバックアップではありません。');
  if (value.version !== BACKUP_VERSION) throw new Error(`未対応のバックアップversionです（${String(value.version)}）。`);
  if (!value.data || typeof value.data !== 'object') throw new Error('バックアップdataがありません。');

  const data = value.data as BackupEnvelope['data'];
  const projects = Array.isArray(data.projects) ? data.projects.filter(isDevProject) : [];
  if (projects.length !== (Array.isArray(data.projects) ? data.projects.length : 0)) throw new Error('案件データに不正な項目があります。');

  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    sourceOrigin: typeof value.sourceOrigin === 'string' ? value.sourceOrigin : '',
    data: {
      projects,
      operatingPlans: normalizeObject<OperatingPlan>(data.operatingPlans),
      handoffs: Array.isArray(data.handoffs) ? data.handoffs.filter(isHandoff) : [],
      notifications: Array.isArray(data.notifications) ? data.notifications.filter(isNotification) : [],
      watchdog: normalizeWatchdog(data.watchdog),
    },
  };
}

function writeBackup(backup: BackupEnvelope) {
  saveProjects(backup.data.projects);
  localStorage.setItem(STORAGE_KEYS.plans, JSON.stringify(backup.data.operatingPlans));
  localStorage.setItem(STORAGE_KEYS.handoffs, JSON.stringify(backup.data.handoffs.slice(0, 40)));
  saveNotifications(backup.data.notifications.slice(0, 100));
  saveWatchdogStates(backup.data.watchdog);
  window.dispatchEvent(new CustomEvent('devdeck:projects-changed'));
  window.dispatchEvent(new CustomEvent('devdeck:operating-plan-changed'));
  window.dispatchEvent(new CustomEvent('devdeck:watchdog-scan'));
}

function mergeBackup(current: BackupEnvelope, incoming: BackupEnvelope): BackupEnvelope {
  return {
    ...incoming,
    createdAt: new Date().toISOString(),
    sourceOrigin: window.location.origin,
    data: {
      projects: mergeByKey(current.data.projects, incoming.data.projects, (item) => item.id),
      operatingPlans: { ...current.data.operatingPlans, ...incoming.data.operatingPlans },
      handoffs: mergeByKey(current.data.handoffs, incoming.data.handoffs, (item) => item.id)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, 40),
      notifications: mergeByKey(current.data.notifications, incoming.data.notifications, (item) => item.dedupeKey || item.id)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, 100),
      watchdog: { ...current.data.watchdog, ...incoming.data.watchdog },
    },
  };
}

function mergeNewestBackup(current: BackupEnvelope, incoming: BackupEnvelope): BackupEnvelope {
  const projectMap = new Map(current.data.projects.map((item) => [item.id, item]));
  for (const item of incoming.data.projects) {
    const existing = projectMap.get(item.id);
    if (!existing || timestamp(item.lastActivityAt) > timestamp(existing.lastActivityAt)) projectMap.set(item.id, item);
  }

  const planKeys = new Set([...Object.keys(current.data.operatingPlans), ...Object.keys(incoming.data.operatingPlans)]);
  const operatingPlans: Record<string, OperatingPlan> = {};
  for (const key of planKeys) {
    const local = current.data.operatingPlans[key];
    const remote = incoming.data.operatingPlans[key];
    operatingPlans[key] = !local ? remote : !remote ? local : timestamp(remote.updatedAt) > timestamp(local.updatedAt) ? remote : local;
  }

  const notifications = mergeNotifications(current.data.notifications, incoming.data.notifications);
  const watchdogKeys = new Set([...Object.keys(current.data.watchdog), ...Object.keys(incoming.data.watchdog)]);
  const watchdog: Record<string, WatchdogState> = {};
  for (const key of watchdogKeys) {
    const local = current.data.watchdog[key];
    const remote = incoming.data.watchdog[key];
    watchdog[key] = !local ? remote : !remote ? local : timestamp(remote.lastObservedAt) > timestamp(local.lastObservedAt) ? remote : local;
  }

  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    sourceOrigin: window.location.origin,
    data: {
      projects: Array.from(projectMap.values()),
      operatingPlans,
      handoffs: mergeByKey(current.data.handoffs, incoming.data.handoffs, (item) => item.id)
        .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)).slice(0, 40),
      notifications,
      watchdog,
    },
  };
}

function mergeNotifications(current: SupervisorNotification[], incoming: SupervisorNotification[]) {
  const items = new Map(current.map((item) => [item.dedupeKey || item.id, item]));
  for (const remote of incoming) {
    const key = remote.dedupeKey || remote.id;
    const local = items.get(key);
    if (!local) {
      items.set(key, remote);
      continue;
    }
    const newer = timestamp(remote.createdAt) > timestamp(local.createdAt) ? remote : local;
    const readAt = latestDate(local.readAt, remote.readAt);
    items.set(key, readAt ? { ...newer, readAt } : newer);
  }
  return Array.from(items.values()).sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)).slice(0, 100);
}

function latestDate(a?: string, b?: string) {
  if (!a) return b;
  if (!b) return a;
  return timestamp(b) > timestamp(a) ? b : a;
}

function timestamp(value?: string) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameBackupData(a: BackupEnvelope, b: BackupEnvelope) {
  return JSON.stringify(a.data) === JSON.stringify(b.data);
}

function mergeByKey<T>(current: T[], incoming: T[], key: (item: T) => string) {
  const items = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) items.set(key(item), item);
  return Array.from(items.values());
}

function snapshotCounts(backup: BackupEnvelope) {
  return {
    projects: backup.data.projects.length,
    plans: Object.keys(backup.data.operatingPlans).length,
    handoffs: backup.data.handoffs.length,
    notifications: backup.data.notifications.length,
  };
}

function normalizeObject<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {};
}

function normalizeWatchdog(value: unknown): Record<string, WatchdogState> {
  const input = normalizeObject<WatchdogState>(value);
  return Object.fromEntries(Object.entries(input).filter(([, item]) => isWatchdog(item)));
}

function isDevProject(value: unknown): value is DevProject {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DevProject>;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.goal === 'string'
    && typeof item.currentPhase === 'string' && typeof item.lastActivityAt === 'string'
    && typeof item.progress === 'number' && Array.isArray(item.definitionOfDone)
    && Array.isArray(item.humanBlockers) && Array.isArray(item.milestones) && Array.isArray(item.timeline)
    && ['RUNNING','WAITING_AI','WAITING_USER','STALLED','ERROR','RATE_LIMITED','CONTEXT_LIMIT','COMPLETED'].includes(String(item.status))
    && ['CHAT','WORK','API_WORKER'].includes(String(item.executionMode))
    && ['OFF','ASSIST','AUTO','GUARDIAN'].includes(String(item.automationLevel));
}

function isHandoff(value: unknown): value is HandoffCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<HandoffCheckpoint>;
  return typeof item.id === 'string' && typeof item.projectId === 'string' && typeof item.projectName === 'string'
    && typeof item.createdAt === 'string' && typeof item.packet === 'string'
    && ['MANUAL','CONTEXT_LIMIT','STALL_RECOVERY'].includes(String(item.reason));
}

function isNotification(value: unknown): value is SupervisorNotification {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SupervisorNotification>;
  return typeof item.id === 'string' && typeof item.dedupeKey === 'string' && typeof item.title === 'string'
    && typeof item.detail === 'string' && typeof item.createdAt === 'string'
    && ['complete','human','error','handoff','info'].includes(String(item.kind));
}

function isWatchdog(value: unknown): value is WatchdogState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WatchdogState>;
  return typeof item.projectId === 'string' && typeof item.retryCount === 'number'
    && typeof item.alternativeCount === 'number' && typeof item.lastObservedAt === 'string';
}
