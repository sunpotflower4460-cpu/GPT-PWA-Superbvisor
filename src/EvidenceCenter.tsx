import { useMemo, useState } from 'react';
import { DevProject, loadProjects } from './core';
import {
  GitHubProjectSnapshot,
  PublicGitHubSnapshotProvider,
  parseGitHubRepositoryUrl,
  repositoryFullName,
} from './integrations/github';
import { evaluateProject } from './supervisor';

const provider = new PublicGitHubSnapshotProvider();

interface EvidenceState {
  loading?: boolean;
  snapshot?: GitHubProjectSnapshot;
  error?: string;
}

export default function EvidenceCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [evidence, setEvidence] = useState<Record<string, EvidenceState>>({});

  const githubProjects = useMemo(() => projects.filter((project) => project.githubUrl), [projects]);

  function openCenter() {
    setProjects(loadProjects());
    setOpen(true);
  }

  async function refresh(project: DevProject) {
    if (!project.githubUrl) return;
    const repository = parseGitHubRepositoryUrl(project.githubUrl);
    if (!repository) {
      setEvidence((items) => ({ ...items, [project.id]: { error: 'GitHub URLを確認してください。' } }));
      return;
    }

    setEvidence((items) => ({ ...items, [project.id]: { ...items[project.id], loading: true, error: undefined } }));

    try {
      const snapshot = await provider.fetchSnapshot(repository);
      setEvidence((items) => ({ ...items, [project.id]: { loading: false, snapshot } }));
    } catch (error) {
      setEvidence((items) => ({
        ...items,
        [project.id]: {
          loading: false,
          error: error instanceof Error ? error.message : 'GitHub状態の取得に失敗しました。',
        },
      }));
    }
  }

  return (
    <>
      <button className="evidence-fab" onClick={openCenter} aria-label="証拠">
        ◈
      </button>

      {open && (
        <div className="evidence-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="evidence-sheet">
            <header className="evidence-header">
              <div>
                <p className="eyebrow">REALITY CHECK</p>
                <h2>GitHub 証拠センター</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            <p className="muted evidence-intro">
              AIの「完成しました」だけではなく、公開GitHubの最新commit・CI・PR・issueを直接確認します。private repoは後段の安全なbackend/connectorから接続します。
            </p>

            <div className="evidence-projects">
              {githubProjects.map((project) => (
                <EvidenceCard
                  key={project.id}
                  project={project}
                  state={evidence[project.id]}
                  onRefresh={() => refresh(project)}
                />
              ))}

              {githubProjects.length === 0 && (
                <div className="empty-state compact">
                  <div>🔎</div>
                  <h2>GitHub URLを登録してください</h2>
                  <p>案件画面でGitHubリポジトリを登録すると、ここから成果物を直接確認できます。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function EvidenceCard({
  project,
  state,
  onRefresh,
}: {
  project: DevProject;
  state?: EvidenceState;
  onRefresh: () => void;
}) {
  const snapshot = state?.snapshot;
  const repository = project.githubUrl ? parseGitHubRepositoryUrl(project.githubUrl) : null;
  const ciObserved = snapshot?.ciState === 'SUCCESS' || snapshot?.ciState === 'FAILURE';
  const decision = snapshot && ciObserved
    ? evaluateProject(project, {
        ciPassing: snapshot.ciState === 'SUCCESS',
        latestCommitAt: snapshot.latestCommitAt,
        // snapshot.openIssues is already fetched and shown as the "Issues"
        // metric below — feed it into the actual completion decision too,
        // instead of only displaying it.
        openBlockingIssues: snapshot.openIssues,
      })
    : null;

  return (
    <article className="evidence-card">
      <div className="section-heading">
        <div>
          <strong>{project.name}</strong>
          <div className="repo-name">{repository ? repositoryFullName(repository) : 'Invalid GitHub URL'}</div>
        </div>
        <button className="evidence-refresh" disabled={state?.loading} onClick={onRefresh}>
          {state?.loading ? '確認中…' : snapshot ? '再確認' : '状態取得'}
        </button>
      </div>

      {state?.error && <div className="evidence-error">⚠ {state.error}</div>}

      {snapshot && (
        <>
          <div className="evidence-grid">
            <EvidenceMetric label="Branch" value={snapshot.defaultBranch ?? '—'} />
            <EvidenceMetric label="CI" value={snapshot.ciState ?? 'UNKNOWN'} tone={snapshot.ciState?.toLowerCase()} />
            <EvidenceMetric label="Open PR" value={String(snapshot.openPullRequests ?? '—')} />
            <EvidenceMetric label="Issues" value={String(snapshot.openIssues ?? '—')} />
          </div>

          <div className="evidence-commit">
            <span>Latest commit</span>
            <b>{snapshot.latestCommitSha?.slice(0, 8) ?? '—'}</b>
            <small>{snapshot.latestCommitAt ? new Date(snapshot.latestCommitAt).toLocaleString('ja-JP') : '日時不明'}</small>
          </div>

          {decision ? (
            <div className="judge-row">
              <div>
                <span>Completion Judge</span>
                <strong>{decision.completionScore}%</strong>
              </div>
              <p>{decision.reason}</p>
            </div>
          ) : (
            <div className="judge-row">
              <div>
                <span>Completion Judge</span>
                <strong>保留</strong>
              </div>
              <p>最新commitに対応するCI結果を確認できないため、GitHub証拠からの完成判定は行いません。</p>
            </div>
          )}

          <div className="evidence-footer">
            <span>API残量: {snapshot.rateLimitRemaining ?? '—'}</span>
            <span>取得: {new Date(snapshot.fetchedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </>
      )}
    </article>
  );
}

function EvidenceMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`evidence-metric ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
