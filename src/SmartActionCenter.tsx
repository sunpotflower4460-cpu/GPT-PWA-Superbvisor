import { useMemo, useState } from 'react';
import { DevProject, loadProjects } from './core';
import { suggestReplies } from './smartReply';
import {
  WatchdogFinding,
  WatchdogState,
  inspectProject,
  loadWatchdogStates,
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

  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const suggestions = useMemo(
    () => selected ? suggestReplies(selected, { lastAssistantMessage: lastMessage }) : [],
    [selected, lastMessage],
  );
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

  return (
    <>
      <button className="smart-fab" onClick={openCenter} aria-label="Smart reply center">
        ✦
        {attentionCount > 0 && <span>{attentionCount}</span>}
      </button>

      {open && (
        <div className="smart-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="smart-sheet">
            <header className="smart-header">
              <div>
                <p className="eyebrow">SMART SUPERVISOR</p>
                <h2>次の一手</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            {projects.length === 0 ? (
              <div className="empty-state compact">
                <div>✦</div>
                <h2>案件を登録すると使えます</h2>
                <p>プロジェクト状態から、次にGPTへ返す指示を自動で順位付けします。</p>
              </div>
            ) : (
              <>
                <div className="smart-project-tabs">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      className={project.id === selected?.id ? 'active' : ''}
                      onClick={() => {
                        setSelectedId(project.id);
                        setLastMessage('');
                      }}
                    >
                      {findings[project.id]?.needsAttention && <span className="attention-dot" />}
                      {project.name}
                    </button>
                  ))}
                </div>

                {selected && (
                  <SmartProject
                    project={selected}
                    finding={findings[selected.id]}
                    lastMessage={lastMessage}
                    onLastMessage={setLastMessage}
                    copiedId={copiedId}
                    onCopy={copy}
                    suggestions={suggestions}
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
  project,
  finding,
  lastMessage,
  onLastMessage,
  copiedId,
  onCopy,
  suggestions,
}: {
  project: DevProject;
  finding?: WatchdogFinding;
  lastMessage: string;
  onLastMessage: (value: string) => void;
  copiedId: string;
  onCopy: (id: string, text: string) => Promise<void>;
  suggestions: ReturnType<typeof suggestReplies>;
}) {
  return (
    <div className="smart-project">
      <article className="smart-status-card">
        <div className="section-heading">
          <div>
            <strong>{project.currentPhase}</strong>
            <div className="smart-goal">Goal: {project.goal}</div>
          </div>
          <span className="smart-progress">{project.progress}%</span>
        </div>

        {finding?.needsAttention && (
          <div className={`watchdog-alert ${finding.severity.toLowerCase()}`}>
            <div>
              <b>{finding.title}</b>
              <p>{finding.detail}</p>
            </div>
            {finding.prompt && (
              <button onClick={() => onCopy(`watchdog-${project.id}`, finding.prompt!)}>
                {copiedId === `watchdog-${project.id}` ? '✓ コピー済み' : '再開指示をコピー'}
              </button>
            )}
          </div>
        )}
      </article>

      <label className="assistant-message-field">
        <span>GPTの最後の返答 <small>任意</small></span>
        <textarea
          value={lastMessage}
          onChange={(event) => onLastMessage(event.target.value)}
          rows={5}
          placeholder="例：E2Eテストを追加できます。続けますか？"
        />
      </label>

      <div className="smart-suggestions">
        <div className="section-heading"><span>おすすめ返答</span><span>上ほど推奨</span></div>
        {suggestions.map((suggestion, index) => (
          <button
            key={`${suggestion.id}-${index}`}
            className={`smart-suggestion ${index === 0 ? 'recommended' : ''}`}
            onClick={() => onCopy(`reply-${index}`, suggestion.prompt)}
          >
            <div>
              <span className="smart-rank">{index + 1}</span>
              <strong>{copiedId === `reply-${index}` ? '✓ コピーしました' : suggestion.label}</strong>
              <small>{suggestion.reason}</small>
            </div>
            <span className="confidence">{Math.round(suggestion.confidence * 100)}%</span>
          </button>
        ))}
      </div>

      <div className="smart-launch-row">
        {project.chatUrl ? (
          <button className="launch-button" onClick={() => window.open(project.chatUrl, '_blank', 'noopener,noreferrer')}>
            ChatGPTを開く ↗
          </button>
        ) : (
          <span className="muted">ChatGPT URL未登録</span>
        )}
      </div>

      <p className="smart-footnote">
        通常Chatは外部PWAから公式に自動投稿できないため、ここでは「判断＋指示生成＋1タップコピー」まで自動化します。完全自動は後段のAPI Workerで担当します。
      </p>
    </div>
  );
}
