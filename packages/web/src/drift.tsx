import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AnalysisListEntry,
  type DriftCategory,
  type DriftChange,
  type DriftReport,
} from './api';
import { ConfidenceBadge, Empty, Notice, Stat } from './ui';
import { analysisForChange, comparableAnalysisCount, defaultComparisonId, driftState } from './presentation';

/**
 * Drift view.
 *
 * Answers "what changed between these two states, and what proves it". Two rules govern what
 * is shown:
 *
 *  - **Unknown is not unchanged.** An identical pair, an incomparable pair and a truncated
 *    target each get their own explicit state. A view that rendered all three as an empty
 *    change list would be indistinguishable from "no changes".
 *  - **Every row traces.** A change can be opened in the analysis it belongs to — the target
 *    for something added or modified, the base for something removed — so a reader can walk
 *    drift item → changed entity → evidence → source location in both snapshots.
 */

const CATEGORY_LABELS: Record<DriftCategory, string> = {
  NODE_ADDED: 'entity added',
  NODE_REMOVED: 'entity removed',
  NODE_MODIFIED: 'entity modified',
  NODE_RENAMED: 'entity renamed',
  EDGE_ADDED: 'relationship added',
  EDGE_REMOVED: 'relationship removed',
  EDGE_MODIFIED: 'relationship modified',
  EVIDENCE_ADDED: 'citation added',
  EVIDENCE_REMOVED: 'citation removed',
  EVIDENCE_CHANGED: 'citation moved',
  CONFIDENCE_CHANGED: 'confidence changed',
};

const CATEGORY_GROUPS: { id: DriftCategory; field: keyof DriftReport['summary']; label: string }[] = [
  { id: 'NODE_ADDED', field: 'nodesAdded', label: 'Entities added' },
  { id: 'NODE_REMOVED', field: 'nodesRemoved', label: 'Entities removed' },
  { id: 'NODE_MODIFIED', field: 'nodesModified', label: 'Entities modified' },
  { id: 'NODE_RENAMED', field: 'nodesRenamed', label: 'Entities renamed' },
  { id: 'EDGE_ADDED', field: 'relationshipsAdded', label: 'Relationships added' },
  { id: 'EDGE_REMOVED', field: 'relationshipsRemoved', label: 'Relationships removed' },
  { id: 'EDGE_MODIFIED', field: 'relationshipsModified', label: 'Relationships modified' },
  { id: 'EVIDENCE_ADDED', field: 'evidenceAdded', label: 'Citations added' },
  { id: 'EVIDENCE_REMOVED', field: 'evidenceRemoved', label: 'Citations removed' },
  { id: 'EVIDENCE_CHANGED', field: 'evidenceChanged', label: 'Citations moved' },
  { id: 'CONFIDENCE_CHANGED', field: 'confidenceChanged', label: 'Confidence changed' },
];

const CHANGE_PAGE = 250;

export interface DriftTabProps {
  analyses: AnalysisListEntry[];
  /** The analysis currently selected in the sidebar. */
  analysisId: string;
  /** Opens the graph entity inspector for an entity in a specific analysis. */
  onInspectNode: (analysisId: string, nodeId: string) => void;
}

export function DriftTab({ analyses, analysisId, onInspectNode }: DriftTabProps): React.ReactElement {
  // Newest first, as the API returns them.
  const ordered = useMemo(
    () => [...analyses].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [analyses],
  );

  const [against, setAgainst] = useState('');
  const effectiveAgainst = against || defaultComparisonId(analyses, analysisId) || '';

  const [report, setReport] = useState<DriftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(CHANGE_PAGE);

  useEffect(() => {
    if (!effectiveAgainst) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLimit(CHANGE_PAGE);
    api
      .getDrift(analysisId, effectiveAgainst, { limit: 5_000 })
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) {
          setReport(null);
          setError(cause.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, effectiveAgainst]);

  // Snapshot identity for both sides arrives inside the drift report itself, so there is no
  // second request to keep in step with this one.

  const candidates = ordered.filter((entry) => entry.id !== analysisId && entry.status === 'succeeded');
  const comparableCount = comparableAnalysisCount(analyses);
  const state = driftState(report, loading, error);

  const visibleChanges = useMemo(() => {
    const list = report?.changes ?? [];
    const needle = filter.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? list
        : list.filter(
            (change) =>
              change.label.toLowerCase().includes(needle) ||
              change.category.toLowerCase().includes(needle) ||
              (change.changedFields ?? []).some((field) => field.toLowerCase().includes(needle)),
          );
    return filtered.slice(0, limit);
  }, [report, filter, limit]);

  const handleInspect = useCallback(
    (change: DriftChange) => {
      if (!report) return;
      // A removal is a fact about the base state; everything else describes the target.
      // Opening the wrong side would show the reader an entity that is not there.
      const analysis = analysisForChange(change, report);
      if (!analysis) return;
      onInspectNode(analysis, change.entityId);
    },
    [onInspectNode, report],
  );

  if (comparableCount < 2) {
    return (
      <Empty>
        Drift compares two analyses of the same repository. Run a second analysis — of the same path after a change,
        or of a different state — and this tab will show what moved between them.
      </Empty>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="row wrap">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label htmlFor="drift-against">Compare selected analysis against</label>
            <select id="drift-against" value={effectiveAgainst} onChange={(event) => setAgainst(event.target.value)}>
              {candidates.length === 0 ? <option value="">no other successful analysis</option> : null}
              {candidates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label ?? entry.repositoryName} · {new Date(entry.createdAt).toLocaleString()} ·{' '}
                  {entry.summary?.nodeCount ?? 0} nodes
                </option>
              ))}
            </select>
          </div>
        </div>

        {report ? <SnapshotComparison report={report} /> : null}
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {loading ? <Empty>Comparing snapshots…</Empty> : null}

      {/* The four states are rendered separately. Collapsing "unknown" into "nothing changed"
          would be the single most misleading thing this view could do. */}
      {state === 'unknown' && !loading && !error ? (
        <Notice kind="warning">
          No comparison could be made. Choose another analysis to compare against.
        </Notice>
      ) : null}

      {report && state === 'incomparable' ? (
        <Notice kind="warning">
          <strong>These two analyses cannot be compared.</strong>
          <div className="small muted" style={{ marginTop: 4 }}>
            {report.incomparabilityReason}
          </div>
        </Notice>
      ) : null}

      {report && state === 'identical' ? (
        <Notice kind="success">
          <strong>Nothing changed.</strong> Both analyses produced the same graph digest, so every entity,
          relationship and citation is identical. Only the run differs.
        </Notice>
      ) : null}

      {report && report.targetIncomplete ? (
        <Notice kind="warning">
          <strong>The newer analysis hit a limit.</strong> Removals are therefore reported as <em>indeterminate</em>:
          that analysis did not look at everything, so absence there does not establish that anything was deleted.
        </Notice>
      ) : null}

      {report && state === 'changed' ? (
        <>
              <div className="grid cols-4" style={{ margin: '14px 0' }}>
                <Stat label="Entities added" value={report.summary.nodesAdded} />
                <Stat label="Entities removed" value={report.summary.nodesRemoved} note={`${report.summary.nodesRenamed} proven renames`} />
                <Stat label="Entities modified" value={report.summary.nodesModified} />
                <Stat label="Relationships" value={report.summary.relationshipsAdded + report.summary.relationshipsRemoved + report.summary.relationshipsModified} note={`${report.summary.relationshipsAdded} added · ${report.summary.relationshipsRemoved} removed`} />
              </div>

              <div className="card">
                <h3>Change summary</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th style={{ width: 90 }}>Count</th>
                      <th style={{ width: 110 }}>Show</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CATEGORY_GROUPS.map((group) => (
                      <tr key={group.id}>
                        <td>{group.label}</td>
                        <td className="mono">{report.summary[group.field]}</td>
                        <td>
                          <CategoryFilter
                            label={group.label}
                            active={filter === group.id}
                            count={report.summary[group.field]}
                            onToggle={() => setFilter((current) => (current === group.id ? '' : group.id))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <h3>Changes ({report.changes.length})</h3>
                <div className="field">
                  <input
                    value={filter}
                    onChange={(event) => {
                      setFilter(event.target.value);
                      setLimit(CHANGE_PAGE);
                    }}
                    placeholder="Filter by name, category or field"
                    spellCheck={false}
                  />
                </div>

                {visibleChanges.length === 0 ? (
                  <Empty>No change matches this filter.</Empty>
                ) : (
                  <div className="scroll-y">
                    {visibleChanges.map((change) => (
                      <ChangeRow key={`${change.category}:${change.entityId}`} change={change} onInspect={handleInspect} />
                    ))}
                  </div>
                )}

                {report.changes.length > visibleChanges.length ? (
                  <button type="button" style={{ marginTop: 10 }} onClick={() => setLimit((current) => current + CHANGE_PAGE)}>
                    Show {Math.min(CHANGE_PAGE, report.changes.length - visibleChanges.length)} more
                  </button>
                ) : null}

                {report.changes.length === 0 && report.summary.totalChanges > 0 ? (
                  <p className="small dim" style={{ marginTop: 8 }}>
                    {report.summary.totalChanges} changes were counted; per-change records were suppressed by the
                    server.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
    </div>
  );
}

function CategoryFilter({
  label,
  active,
  count,
  onToggle,
}: {
  label: string;
  active: boolean;
  count: number;
  onToggle: () => void;
}): React.ReactElement {
  if (count === 0) return <span className="small dim">—</span>;
  return (
    <button type="button" className={active ? 'primary' : ''} onClick={onToggle} title={`Show only ${label.toLowerCase()}`}>
      {active ? 'filtering' : 'filter'}
    </button>
  );
}

/** Side-by-side identity of the two states being compared. */
function SnapshotComparison({ report }: { report: DriftReport }): React.ReactElement {
  const base = report.base;
  const target = report.target;
  const rows: [string, string, string][] = [
    ['Analysis', base.analysisId, target.analysisId],
    ['Analysed', new Date(base.createdAt).toLocaleString(), new Date(target.createdAt).toLocaleString()],
    ['Repository', base.repositoryName, target.repositoryName],
    ['Commit', base.sourceRevision ?? 'not available', target.sourceRevision ?? 'not available'],
    ['Branch', base.branch ?? 'not available', target.branch ?? 'not available'],
    ['Snapshot', base.snapshotId, target.snapshotId],
    ['Graph digest', base.graphDigest.slice(0, 16), target.graphDigest.slice(0, 16)],
    ['Extractor', base.extractorVersion, target.extractorVersion],
    ['Truncated', String(base.truncated), String(target.truncated)],
  ];

  return (
    <table style={{ marginTop: 10 }}>
      <thead>
        <tr>
          <th style={{ width: 120 }} />
          <th>Base state</th>
          <th>Target state</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, left, right]) => (
          <tr key={label}>
            <td className="small dim">{label}</td>
            <td className="mono small">{left}</td>
            <td className="mono small">{right}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One change, with both sides of its evidence.
 *
 * `evidenceBefore` and `evidenceAfter` are shown side by side because the whole point is to
 * see where the fact was cited in each state.
 */
function ChangeRow({ change, onInspect }: { change: DriftChange; onInspect: (change: DriftChange) => void }): React.ReactElement {
  const canInspect = change.entityKind === 'node';
  return (
    <div style={{ borderTop: '1px solid var(--line, #1e2936)', padding: '8px 0' }}>
      <div className="row wrap">
        <span className="chip">{CATEGORY_LABELS[change.category]}</span>
        <span className="mono small">{change.label}</span>
        <ConfidenceBadge value={change.confidence} />
        {change.claimConfidence !== 'EXPLICIT' ? <ConfidenceBadge value={change.claimConfidence} /> : null}
        {canInspect ? (
          <button type="button" onClick={() => onInspect(change)}>
            inspect entity
          </button>
        ) : null}
      </div>

      {change.changedFields && change.changedFields.length > 0 ? (
        <div className="small dim mono" style={{ marginTop: 4 }}>
          fields: {change.changedFields.join(', ')}
        </div>
      ) : null}

      {change.reason ? (
        <div className="small" style={{ marginTop: 4, color: 'var(--weak, #d29922)' }}>
          {change.reason}
        </div>
      ) : null}

      {change.evidenceBefore.length > 0 || change.evidenceAfter.length > 0 ? (
        <div className="row wrap small dim" style={{ marginTop: 4 }}>
          <span>base:</span>
          {change.evidenceBefore.length === 0 ? (
            <span className="dim">no citation</span>
          ) : (
            change.evidenceBefore.map((ref) => (
              <span key={`b-${ref.evidenceId}`} className="mono">
                {ref.path}:{ref.startLine}
              </span>
            ))
          )}
          <span>target:</span>
          {change.evidenceAfter.length === 0 ? (
            <span className="dim">no citation</span>
          ) : (
            change.evidenceAfter.map((ref) => (
              <span key={`a-${ref.evidenceId}`} className="mono">
                {ref.path}:{ref.startLine}
              </span>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
