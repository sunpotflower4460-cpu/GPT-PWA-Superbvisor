import { useMemo, useState } from 'react';
import { DevProject, loadProjects } from './core';
import { SmartReplySuggestion, suggestReplies } from './smartReply';
import { generateWorkerSmartReplies, loadWorkerConnection } from './backgroundWorker';
import {
  WatchdogFinding,
  WatchdogState,
  inspectProject,
  loadWatchdogStates,
  recordWatchdogAction,
  saveWatchdogStates,
} from './watchdog';

type FindingMap = Record<string, WatchdogFinding>;

export default function SmartActionCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [lastMessage, setLastMessage] = useState('');
  const [findings, setFindings] = useState<FindingMap>({});
  const [copiedId, setCopiedId] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState<SmartReplySuggestion[]>([]);
  const [aiModel, setAiModel] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');

  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const ruleSuggestions = useMemo(
    () => selected ? suggestReplies(selected, { lastAssistantMessage: lastMessage }) : [],
    [selected, lastMessage],
  );
  const suggestions = aiSuggestions.length ? aiSuggestions : ruleSuggestions;
  const attentionCount = Object.values(findings).filter((finding) => finding.needsAttention).length;

  function openCenter() {
    const nextProjects = loadProjects();
    const states = loadWatchdogStates();
    const nextStates: Record<string, WatchdogState> = { ...states };
    const nextFindings: FindingMap = {};

    for (const project of nextProjects) {
      const finding = inspectProject(project, states[project.id]);
      nextFindings[project.id] = finding;
      nextStates[project.id] = finding.nextState;
    }

    saveWatchdogStates(nextStates);
    setProjects(nextProjects);
    setFindings(nextFindings);
    setSelectedId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? '');
    setOpen(true);
  }

  async function copy(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(''), 1600);
  }

  async function copyRecovery(project: DevProject, finding: WatchdogFinding) {
    if (!finding.prompt) return;
    await copy(`watchdog-${project.id}`, finding.prompt);
    const states = loadWatchdogStates();
    const current = states[project.id] ?? finding.nextState;
    states[project.id] = recordWatchdogAction(current, finding.recommendedAction);
    saveWatchdogStates(states);
  }

  function changeProject(id: string) {
    setSelectedId(id);
    setLastMessage('');
    resetAI();
  }

  function changeMessage(value: string) {
    setLastMessage(value);
    resetAI();
  }

  function resetAI() {
    setAiSuggestions([]);
    setAiModel('');
    setAiError('');
  }

  async function generateAIReplies() {
    if (!selected) return;
    setAiBusy(true);
    setAiError('');
    try {
      const result = await generateWorkerSmartReplies(selected, lastMessage, loadWorkerConnection());
      setAiSuggestions(result.suggestions.map((item, index) => ({ ...item, id: `ai-${index}` })));
      setAiModel(result.model);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'AI候補の生成に失敗しました。');
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <>
      <button className="smart-fab" onClick={openCenter} aria-label="Smart reply center">
        ✦{attentionCount > 0 && <span>{attentionCount}</span>}
      </button>

      {open && (
        <div className="smart-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="smart-sheet">
            <header className="smart-header">
              <div><p className="eyebrow">SMART SUPERVISOR</p><h2>次の一手</h2></div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            {projects.length === 0 ? (
              <div className="empty-state compact"><div>✦</div><h2>案件を登録すると使えます</h2><p>プロジェクト状態から、次にGPTへ返す指示を自動で順位付けします。</p></div>
            ) : (
              <>
                <div className="smart-project-tabs">
                  {projects.map((project) => (
                    <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => changeProject(project.id)}>
                      {findings[project.id]?.needsAttention && <span className="attention-dot" />}{project.name}
                    </button>
                  ))}
                </div>

                {selected && (
                  <SmartProject
                    project={selected}
                    finding={findings[selected.id]}
                    lastMessage={lastMessage}
                    onLastMessage={changeMessage}
                    copiedId={copiedId}
                    onCopy={copy}
                    onRecoveryCopy={copyRecovery}
                    suggestions={suggestions}
                    aiModel={aiModel}
                    aiBusy={aiBusy}
                    aiError={aiError}
                    usingAI={aiSuggestions.length > 0}
                    onGenerateAI={generateAIReplies}
                    onUseFree={resetAI}
                  />
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function SmartProject({
  project, finding, lastMessage, onLastMessage, copiedId, onCopy, onRecoveryCopy, suggestions,
  aiModel, aiBusy, aiError, usingAI, onGenerateAI, onUseFree,
}: {
  project: DevProject;
  finding?: WatchdogFinding;
  lastMessage: string;
  onLastMessage: (value: string) => void;
  copiedId: string;
  onCopy: (id: string, text: string) => Promise<void>;
  onRecoveryCopy: (project: DevProject, finding: WatchdogFinding) => Promise<void>;
  suggestions: SmartReplySuggestion[];
  aiModel: string;
  aiBusy: boolean;
  aiError: string;
  usingAI: boolean;
  onGenerateAI: () => Promise<void>;
  onUseFree: () => void;
}) {
  const chatUrl = safeChatUrl(project.chatUrl);

  return (
    <div className="smart-project">
      <article className="smart-status-card">
        <div className="section-heading">
          <div><strong>{project.currentPhase}</strong><div className="smart-goal">Goal: {project.goal}</div></div>
          <span className="smart-progress">{project.progress}%</span>
        </div>
        {finding?.needsAttention && (
          <div className={`watchdog-alert ${finding.severity.toLowerCase()}`}>
            <div><b>{finding.title}</b><p>{finding.detail}</p></div>
            {finding.prompt && <button onClick={() => onRecoveryCopy(project, finding)}>{copiedId === `watchdog-${project.id}` ? '✓ コピー済み' : '再開指示をコピー'}</button>}
          </div>
        )}
      </article>

      <label className="assistant-message-field">
        <span>GPTの最後の返答 <small>任意</small></span>
        <textarea value={lastMessage} onChange={(event) => onLastMessage(event.target.value)} rows={5} placeholder="例：E2Eテストを追加できます。続けますか？" />
      </label>

      <div className="reply-engine-row">
        <div>
          <b>{usingAI ? 'AI Smart Reply' : '無料 Smart Reply'}</b>
          <small>{usingAI ? `${aiModel} が文脈から候補を生成` : '端末内ルールで生成・API料金なし'}</small>
        </div>
        {usingAI
          ? <button onClick={onUseFree}>無料候補へ戻す</button>
          : <button onClick={onGenerateAI} disabled={aiBusy}>{aiBusy ? '生成中…' : '◇ AIで候補を作る'}</button>}
      </div>
      {aiError && <div className="smart-ai-error">⚠ {aiError}</div>}

      <div className="smart-suggestions">
        <div className="section-heading"><span>おすすめ返答</span><span>上ほど推奨</span></div>
        {suggestions.map((suggestion, index) => (
          <button key={`${suggestion.id}-${index}`} className={`smart-suggestion ${index === 0 ? 'recommended' : ''}`} onClick={() => onCopy(`reply-${index}`, suggestion.prompt)}>
            <div><span className="smart-rank">{index + 1}</span><strong>{copiedId === `reply-${index}` ? '✓ コピーしました' : suggestion.label}</strong><small>{suggestion.reason}</small></div>
            <span className="confidence">{Math.round(suggestion.confidence * 100)}%</span>
          </button>
        ))}
      </div>

      <div className="smart-launch-row">
        {chatUrl ? <button className="launch-button" onClick={() => window.open(chatUrl, '_blank', 'noopener,noreferrer')}>ChatGPTを開く ↗</button> : <span className="muted">{project.chatUrl ? 'ChatGPT URLを確認してください' : 'ChatGPT URL未登録'}</span>}
      </div>

      <p className="smart-footnote">通常は無料候補で十分です。判断が微妙な時だけAI候補を使い、通常Chatへの送信自体は1タップコピーで行います。</p>
    </div>
  );
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
