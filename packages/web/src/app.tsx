import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type AnalysisDetail,
  type AnalysisListEntry,
  type Artifact,
  type Diagnostic,
  type Evidence,
  type GapReport,
  type GraphResponse,
  type HealthResponse,
} from './api';
import { C4Tab } from './c4';
import { DriftTab } from './drift';
import { EntityDrawer } from './entity-drawer';
import { GraphView } from './graph';
import { BehaviourTab, TraceabilityTab } from './phase3';
import {
  ConfidenceBadge,
  CountChips,
  Empty,
  formatDuration,
  formatPercent,
  Notice,
  Stat,
  StatusBadge,
} from './ui';

/**
 * RepoAtlas application shell.
 *
 * Every screen reads from the API — there is no sample data anywhere in this UI. If the
 * API is unreachable the application says so instead of rendering an empty atlas, which
 * would be indistinguishable from "this repository has no structure".
 *
 * The UI is a reader, not a source of truth. It shows the canonical graph, the architecture
 * projected from it, and what changed between two of its states; every one of those views can
 * be followed back to a file and a line.
 */

type TabId =
  | 'overview'
  | 'architecture'
  | 'c4'
  | 'structure'
  | 'behaviour'
  | 'traceability'
  | 'drift'
  | 'evidence'
  | 'gaps'
  | 'diagnostics';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'c4', label: 'C4' },
  { id: 'structure', label: 'Structure' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'traceability', label: 'Traceability' },
  { id: 'drift', label: 'Drift' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'gaps', label: 'Gaps' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

const TAB_IDS = new Set<string>(TABS.map((entry) => entry.id));

/** C4 levels, used to resolve a `#/c4/<level>` deep link. */
const C4_LEVELS_LOCAL = new Set(['context', 'container', 'component']);

/**
 * Reads the tab from the URL fragment, e.g. `#/drift` or `#/c4/container`.
 *
 * Deep links are worth having on their own: an architecture or drift view is the thing a
 * person wants to send to a colleague, and a link that always lands on Overview cannot be.
 * They also make every screen reachable without a mouse, which is what lets each one be
 * verified by loading a URL rather than by clicking — the only way this repository can check
 * that the views render, since it has no browser test harness.
 */
function tabFromHash(): TabId {
  // Only the first segment names the tab; a second segment is a view within it (`c4/container`).
  const [candidate] = window.location.hash.replace(/^#\/?/, '').split('/');
  return candidate !== undefined && TAB_IDS.has(candidate) ? (candidate as TabId) : 'overview';
}

/** Reads the C4 level from `#/c4/<level>`, defaulting to the first level. */
export function c4LevelFromHash(): 'context' | 'container' | 'component' {
  const [, level] = window.location.hash.replace(/^#\/?/, '').split('/');
  return C4_LEVELS_LOCAL.has(level ?? '') ? (level as 'context' | 'container' | 'component') : 'context';
}

export function App(): React.ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisListEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [tab, setTab] = useState<TabId>(tabFromHash);
  // The inspector carries its own analysis id: a drift row can be a fact about the *base*
  // snapshot, whose entity does not exist in the analysis currently selected in the sidebar.
  const [inspect, setInspect] = useState<{ analysisId: string; nodeId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectNode = useCallback(
    (nodeId: string) => {
      if (selectedId) setInspect({ analysisId: selectedId, nodeId });
    },
    [selectedId],
  );

  // Keeps the fragment in step with the tab, so the current view can be copied or reloaded.
  // A tab with its own levels keeps the level segment.
  const selectTab = useCallback((next: TabId) => {
    setTab(next);
    const hash = next === 'c4' ? `#/c4/${c4LevelFromHash()}` : `#/${next}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  // A fragment change made outside React — pasted into the address bar, or a link opened in
  // the same tab — must switch the view too. Without this, a deep link works on a fresh load
  // and silently does nothing in an already-open application.
  useEffect(() => {
    const onHashChange = (): void => {
      setTab(tabFromHash());
      setInspect(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const refreshAnalyses = useCallback(async () => {
    try {
      const result = await api.listAnalyses();
      setAnalyses(result.analyses);
      setSelectedId((current) => current ?? result.analyses[0]?.id ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void api
      .health()
      .then(setHealth)
      .catch((cause: Error) => setHealthError(cause.message));
    void refreshAnalyses();
  }, [refreshAnalyses]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .getAnalysis(selectedId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="app">
      <TopBar health={health} healthError={healthError} />

      <div className="main">
        {error ? (
          <Notice kind="error">
            {error}
            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          </Notice>
        ) : null}

        <div className="split">
          <aside className="sidebar">
            <NewAnalysisForm
              busy={busy}
              disabled={!health}
              onSubmit={async (repositoryPath, label) => {
                setBusy(true);
                setError(null);
                try {
                  const result = await api.createAnalysis({ repositoryPath, ...(label ? { label } : {}) });
                  await refreshAnalyses();
                  setSelectedId(result.analysis.id);
                  selectTab('overview');
                } catch (cause) {
                  setError(describeApiError(cause));
                } finally {
                  setBusy(false);
                }
              }}
            />

            <h2 style={{ marginTop: 16 }}>Analyses</h2>
            <ul className="list">
              {analyses.length === 0 ? (
                <li>
                  <div className="row small dim" style={{ padding: '9px 10px' }}>
                    No analyses yet.
                  </div>
                </li>
              ) : (
                analyses.map((analysis) => (
                  <li key={analysis.id}>
                    <button
                      type="button"
                      className={analysis.id === selectedId ? 'active' : ''}
                      onClick={() => {
                        setSelectedId(analysis.id);
                        setInspect(null);
                      }}
                    >
                      <div className="spread">
                        <strong className="small">{analysis.label ?? analysis.repositoryName}</strong>
                        <span className={`badge ${analysis.status === 'succeeded' ? 'explicit' : analysis.status === 'failed' ? 'not_found' : 'unknown'}`}>
                          {analysis.status}
                        </span>
                      </div>
                      <div className="small dim mono" style={{ wordBreak: 'break-all' }}>
                        {analysis.repositoryPath}
                      </div>
                      <div className="small dim">
                        {analysis.summary ? `${analysis.summary.nodeCount} nodes · ${formatDuration(analysis.durationMs)}` : '—'}
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </aside>

          <main className="content">
            {!selectedId ? (
              <Empty>
                Run an analysis to build the atlas. Point RepoAtlas at a repository path on the server host.
              </Empty>
            ) : !detail ? (
              <Empty>Loading analysis…</Empty>
            ) : (
              <>
                <nav className="tabs">
                  {TABS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={tab === entry.id ? 'active' : ''}
                      onClick={() => selectTab(entry.id)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </nav>

                {tab === 'overview' ? <OverviewTab detail={detail} /> : null}
                {tab === 'architecture' ? (
                  <ProjectionTab analysisId={selectedId} artifactKinds={['dependency-graph', 'er-diagram']} onSelectNode={selectNode} />
                ) : null}
                {tab === 'c4' ? <C4Tab analysisId={selectedId} onSelectNode={selectNode} initialLevel={c4LevelFromHash()} /> : null}
                {tab === 'structure' ? (
                  <ProjectionTab analysisId={selectedId} artifactKinds={['module-graph', 'class-diagram']} onSelectNode={selectNode} />
                ) : null}
                {tab === 'behaviour' ? <BehaviourTab analysisId={selectedId} onSelectNode={selectNode} /> : null}
                {tab === 'traceability' ? <TraceabilityTab analysisId={selectedId} onSelectNode={selectNode} /> : null}
                {tab === 'drift' ? (
                  <DriftTab analyses={analyses} analysisId={selectedId} onInspectNode={(id, nodeId) => setInspect({ analysisId: id, nodeId })} />
                ) : null}
                {tab === 'evidence' ? <EvidenceTab analysisId={selectedId} onSelectNode={selectNode} /> : null}
                {tab === 'gaps' ? <GapsTab gaps={detail.gaps} /> : null}
                {tab === 'diagnostics' ? <DiagnosticsTab analysisId={selectedId} /> : null}
              </>
            )}
          </main>
        </div>
      </div>

      {inspect ? (
        <EntityDrawer analysisId={inspect.analysisId} nodeId={inspect.nodeId} onClose={() => setInspect(null)} />
      ) : null}
    </div>
  );
}

function describeApiError(cause: unknown): string {
  if (cause instanceof ApiError) {
    return `${cause.code}: ${cause.message}`;
  }
  return (cause as Error).message;
}

function TopBar({ health, healthError }: { health: HealthResponse | null; healthError: string | null }): React.ReactElement {
  return (
    <header className="topbar">
      <h1>RepoAtlas</h1>
      <span className="small dim">software knowledge graph</span>
      <div className="spacer" />
      <div className="status">
        {health ? (
          <>
            <span className={`dot ${health.status === 'ok' ? 'ok' : 'bad'}`} />
            <span>
              API v{health.version} · {health.environment} · {health.analysesStored} stored
            </span>
          </>
        ) : healthError ? (
          <>
            <span className="dot bad" />
            <span style={{ color: 'var(--notfound)' }}>API unreachable</span>
          </>
        ) : (
          <>
            <span className="dot" />
            <span>connecting…</span>
          </>
        )}
      </div>
      {health && !health.pathAllowListEnforced ? (
        <span className="badge partially_evidenced" title="Set REPOATLAS_ALLOWED_ROOTS to restrict which paths may be analysed">
          no path allow-list
        </span>
      ) : null}
    </header>
  );
}

function NewAnalysisForm({
  onSubmit,
  busy,
  disabled,
}: {
  onSubmit: (repositoryPath: string, label: string) => Promise<void>;
  busy: boolean;
  disabled: boolean;
}): React.ReactElement {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [label, setLabel] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (repositoryPath.trim().length === 0) return;
        void onSubmit(repositoryPath.trim(), label.trim());
      }}
    >
      <h2>New analysis</h2>
      <div className="field">
        <label htmlFor="repo-path">Repository path on the server host</label>
        <input
          id="repo-path"
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          placeholder="C:\\Projects\\MyRepo"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor="repo-label">Label (optional)</label>
        <input
          id="repo-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="release candidate"
        />
      </div>
      <button type="submit" className="primary" disabled={busy || disabled || repositoryPath.trim().length === 0}>
        {busy ? 'Analysing…' : 'Analyse'}
      </button>
      <p className="small dim" style={{ marginTop: 8 }}>
        The path is read by the server, not the browser.
      </p>
    </form>
  );
}

function OverviewTab({ detail }: { detail: AnalysisDetail }): React.ReactElement {
  const { analysis, stats, gaps, artifacts } = detail;
  const summary = analysis.summary;

  return (
    <div>
      <div className="card">
        <div className="spread">
          <div>
            <h2 style={{ marginBottom: 4 }}>{analysis.repositoryName}</h2>
            <div className="small mono dim" style={{ wordBreak: 'break-all' }}>
              {analysis.repositoryPath}
            </div>
          </div>
          <span className={`badge ${analysis.status === 'succeeded' ? 'explicit' : 'not_found'}`}>{analysis.status}</span>
        </div>

        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Commit</dt>
          <dd className="mono small">{analysis.headCommit ?? 'not available'}</dd>
          <dt>Branch</dt>
          <dd className="mono small">{analysis.branch ?? 'not available'}</dd>
          <dt>Analysed</dt>
          <dd className="small">{new Date(analysis.createdAt).toLocaleString()}</dd>
          <dt>Duration</dt>
          <dd className="small">{formatDuration(analysis.durationMs)}</dd>
        </dl>

        {summary?.truncated ? (
          <Notice kind="warning">
            Limits were reached during analysis, so this graph is partial. Reduce the repository size or raise the
            limits to get complete results.
          </Notice>
        ) : null}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Entities" value={stats.nodeCount} note={`${summary?.analyzableFileCount ?? 0} analyzable files`} />
        <Stat label="Relationships" value={stats.edgeCount} note={`${stats.evidenceCount} evidence records`} />
        <Stat
          label="Explicit"
          value={formatPercent(stats.explicitShare.nodes)}
          note={`edges ${formatPercent(stats.explicitShare.edges)}`}
        />
        <Stat label="Duration" value={formatDuration(summary?.durationMs ?? null)} note={`${summary?.parserCount ?? 0} parsers used`} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Entity kinds</h3>
          <CountChips counts={stats.nodesByKind} />
          <h3 style={{ marginTop: 14 }}>Relationship kinds</h3>
          <CountChips counts={stats.edgesByKind} />
        </div>

        <div className="card">
          <h3>Languages</h3>
          <CountChips counts={summary?.languageCounts ?? {}} />
          <h3 style={{ marginTop: 14 }}>Files</h3>
          <dl className="kv">
            <dt>Discovered</dt>
            <dd>{summary?.fileCount ?? 0}</dd>
            <dt>Analyzable</dt>
            <dd>{summary?.analyzableFileCount ?? 0}</dd>
            <dt>Skipped</dt>
            <dd>{summary?.skippedFileCount ?? 0}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h3>Views available</h3>
        <table>
          <thead>
            <tr>
              <th>View</th>
              <th>Status</th>
              <th style={{ width: 90 }}>Entities</th>
              <th style={{ width: 110 }}>Relations</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((artifact) => (
              <tr key={artifact.kind}>
                <td>
                  {artifact.title}
                  <div className="small dim">{artifact.scope}</div>
                </td>
                <td>
                  {artifact.insufficientEvidence ? (
                    <span className="badge not_found">insufficient evidence</span>
                  ) : (
                    <span className="badge explicit">projected</span>
                  )}
                </td>
                <td className="mono">{artifact.nodeCount}</td>
                <td className="mono">{artifact.edgeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Evidence coverage</h3>
        <p className="small muted">
          {gaps.counts.EXPLICIT} explicitly evidenced · {gaps.counts.PARTIALLY_EVIDENCED} partially evidenced ·{' '}
          {gaps.counts.INFERRED} inferred · {gaps.counts.NOT_FOUND} with no evidence found
        </p>
        <p className="small dim">
          A status of “no evidence found” describes what this repository contains. It never asserts that a capability
          does not exist.
        </p>
      </div>
    </div>
  );
}

function ProjectionTab({
  analysisId,
  artifactKinds,
  onSelectNode,
}: {
  analysisId: string;
  artifactKinds: string[];
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const [active, setActive] = useState(artifactKinds[0] ?? '');
  const [artifact, setArtifact] = useState<Artifact | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getArtifact(analysisId, active)
      .then((result) => {
        if (!cancelled) setArtifact(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) {
          setArtifact(undefined);
          setError(cause.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, active]);

  return (
    <div>
      {artifactKinds.length > 1 ? (
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {artifactKinds.map((kind) => (
            <button key={kind} type="button" className={kind === active ? 'primary' : ''} onClick={() => setActive(kind)}>
              {kind}
            </button>
          ))}
        </div>
      ) : null}
      <GraphView artifact={artifact} loading={loading} error={error} onSelectNode={onSelectNode} />
    </div>
  );
}

function EvidenceTab({
  analysisId,
  onSelectNode,
}: {
  analysisId: string;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getEvidence(analysisId)
      .then((result) => setEvidence(result.evidence))
      .catch((cause: Error) => setError(cause.message));
    void api
      .getGraph(analysisId, { limit: 400, edgeLimit: 1_500 })
      .then(setGraph)
      .catch(() => undefined);
  }, [analysisId]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle.length === 0
      ? evidence
      : evidence.filter(
          (item) =>
            item.path.toLowerCase().includes(needle) ||
            (item.symbol ?? '').toLowerCase().includes(needle) ||
            (item.excerpt ?? '').toLowerCase().includes(needle),
        );
    return list.slice(0, 300);
  }, [evidence, filter]);

  if (error) return <Notice kind="error">{error}</Notice>;

  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Entity index</h3>
        <div className="field">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or path"
            spellCheck={false}
          />
        </div>
        <div className="scroll-y">
          {graph === null ? (
            <Empty>Loading…</Empty>
          ) : graph.nodes.length === 0 ? (
            <Empty>No entities.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Kind</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {graph.nodes.slice(0, 200).map((node) => (
                  <tr key={node.id}>
                    <td>
                      <button
                        type="button"
                        className="small mono"
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)' }}
                        onClick={() => onSelectNode(node.id)}
                      >
                        {node.name}
                      </button>
                      <div className="small dim mono">{node.path ?? ''}</div>
                    </td>
                    <td className="small">{node.kind}</td>
                    <td>
                      <ConfidenceBadge value={node.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {graph?.truncated ? (
            <p className="small dim" style={{ marginTop: 8 }}>
              Index truncated: {graph.totals.matching} of {graph.totals.nodes} entities matched.
            </p>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h3>Evidence records ({evidence.length})</h3>
        <p className="small dim">
          Every fact in the graph cites a location. Excerpts are redacted before they are stored.
        </p>
        <div className="scroll-y">
          {filtered.length === 0 ? (
            <Empty>No evidence matches this filter.</Empty>
          ) : (
            filtered.map((item) => (
              <div className="evidence" key={item.id}>
                <div className="loc">
                  {item.path}
                  {item.startLine > 0 ? `:${item.startLine}` : ''}
                </div>
                <div className="small dim">
                  {item.kind} · {item.producer}
                  {item.symbol ? ` · ${item.symbol}` : ''}
                </div>
                {item.excerpt ? <div className="excerpt">{item.excerpt}</div> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function GapsTab({ gaps }: { gaps: GapReport }): React.ReactElement {
  return (
    <div>
      <Notice kind="info">
        Each item states how much support the repository provides. <strong>No evidence found</strong> means the analysed
        repository contains nothing supporting the claim — not that the capability is absent.
      </Notice>

      {gaps.gaps.map((gap) => (
        <div className="card" key={gap.id}>
          <div className="spread">
            <h3 style={{ margin: 0 }}>{gap.title}</h3>
            <div className="row">
              <StatusBadge value={gap.status} />
              {gap.severity === 'warning' ? <span className="badge partially_evidenced">attention</span> : null}
            </div>
          </div>

          <ul className="small" style={{ margin: '8px 0', paddingLeft: 18 }}>
            {gap.observations.map((observation) => (
              <li key={observation}>{observation}</li>
            ))}
          </ul>

          <div className="small dim">
            <strong>Would be resolved by:</strong> {gap.whatWouldResolve}
          </div>
          <details style={{ marginTop: 6 }}>
            <summary className="small dim" style={{ cursor: 'pointer' }}>
              What was searched ({gap.checked.length})
            </summary>
            <ul className="small dim" style={{ paddingLeft: 18 }}>
              {gap.checked.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </details>
        </div>
      ))}
    </div>
  );
}

function DiagnosticsTab({ analysisId }: { analysisId: string }): React.ReactElement {
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getDiagnostics(analysisId)
      .then((result) => setDiagnostics(result.diagnostics))
      .catch((cause: Error) => setError(cause.message));
  }, [analysisId]);

  if (error) return <Notice kind="error">{error}</Notice>;

  const errors = diagnostics.filter((item) => item.severity === 'error');
  const warnings = diagnostics.filter((item) => item.severity === 'warning');
  const infos = diagnostics.filter((item) => item.severity === 'info');

  return (
    <div>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Errors" value={errors.length} />
        <Stat label="Warnings" value={warnings.length} />
        <Stat label="Info" value={infos.length} />
        <Stat label="Total" value={diagnostics.length} />
      </div>

      {diagnostics.length === 0 ? (
        <Empty>No diagnostics were recorded for this analysis.</Empty>
      ) : (
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Severity</th>
                <th style={{ width: 200 }}>Code</th>
                <th style={{ width: 200 }}>Path</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.map((diagnostic, index) => (
                <tr key={`${diagnostic.code}-${index}`}>
                  <td>
                    <span
                      className={`badge ${
                        diagnostic.severity === 'error'
                          ? 'not_found'
                          : diagnostic.severity === 'warning'
                            ? 'partially_evidenced'
                            : 'unknown'
                      }`}
                    >
                      {diagnostic.severity}
                    </span>
                  </td>
                  <td className="mono small">{diagnostic.code}</td>
                  <td className="mono small dim">{diagnostic.path ?? ''}</td>
                  <td className="small">{diagnostic.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}