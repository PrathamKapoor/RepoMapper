import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type Artifact,
  type ArtifactEdge,
  type ArtifactNode,
  type C4ElementKind,
  type C4Level,
} from './api';
import { GraphView } from './graph';
import { describeSupport, isExistenceOnly } from './presentation';
import { ConfidenceBadge, Empty, Notice } from './ui';

/**
 * C4 architecture view.
 *
 * Progressive disclosure: context first, then containers, then components. Each level is
 * only reachable from the one above it, because the levels answer different questions and
 * showing them together invites reading a module as an architecture.
 *
 * Selecting an element answers "why does RepoAtlas believe this exists?" without leaving the
 * view: the rule that produced it, the evidence locations, the confidence, the relationships
 * with the graph facts behind them, and a link through to the graph entity itself. The UI
 * never renders uncertainty as if it were confirmation — inferred elements are dashed, and the
 * derivation is stated in words.
 */

const LEVELS: { id: C4Level; label: string; artifact: string; question: string }[] = [
  {
    id: 'context',
    label: '1 · Context',
    artifact: 'c4-context',
    question: 'What is this system, and what outside it does the repository place alongside it?',
  },
  {
    id: 'container',
    label: '2 · Containers',
    artifact: 'c4-container',
    question: 'Which runtime units does the repository declare, and how are they coupled?',
  },
  {
    id: 'component',
    label: '3 · Components',
    artifact: 'c4-component',
    question: 'Which code does the repository place inside each of those units?',
  },
];

const ELEMENT_LABELS: Record<C4ElementKind, string> = {
  software_system: 'software system',
  container: 'container',
  component: 'component',
  external_system: 'external system',
  person: 'person',
};

export interface C4TabProps {
  analysisId: string;
  /** Opens the graph entity inspector for a graph node id. */
  onSelectNode: (nodeId: string) => void;
  /** Level requested through the URL fragment, e.g. `#/c4/container`. */
  initialLevel?: C4Level;
}

export function C4Tab({ analysisId, onSelectNode, initialLevel }: C4TabProps): React.ReactElement {
  const [level, setLevel] = useState<C4Level>(initialLevel ?? 'context');
  const [artifact, setArtifact] = useState<Artifact | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const descriptor = LEVELS.find((entry) => entry.id === level) ?? LEVELS[0]!;

  // The level is part of the deep link, so a container or component view can be shared and
  // reloaded rather than only reached by clicking through from context.
  const chooseLevel = useCallback((next: C4Level) => {
    setLevel(next);
    if (window.location.hash !== `#/c4/${next}`) window.location.hash = `#/c4/${next}`;
  }, []);

  useEffect(() => {
    if (initialLevel) setLevel(initialLevel);
  }, [initialLevel]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    api
      .getArtifact(analysisId, descriptor.artifact)
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
  }, [analysisId, descriptor.artifact]);

  const selected = useMemo(
    () => artifact?.nodes.find((node) => node.id === selectedId) ?? null,
    [artifact, selectedId],
  );

  const handleSelect = useCallback(
    (nodeId: string) => {
      setSelectedId(nodeId);
      // A C4 element is a projection of graph entities, so the graph inspector is reachable
      // from every element. This is the C4 → graph → evidence → source chain.
      onSelectNode(nodeId);
    },
    [onSelectNode],
  );

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        {LEVELS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === level ? 'primary' : ''}
            onClick={() => chooseLevel(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <p className="small muted">{descriptor.question}</p>

      <GraphView artifact={artifact} loading={loading} error={error} onSelectNode={handleSelect} />

      {selected && artifact ? <C4ElementPanel node={selected} artifact={artifact} analysisId={analysisId} /> : null}
    </div>
  );
}

/**
 * Everything known about one C4 element.
 *
 * The order is deliberate: what it is, how strongly we claim it, why we claim it, where the
 * evidence is, and which relationships it has with the graph facts that justify them.
 */
function C4ElementPanel({
  node,
  artifact,
  analysisId,
}: {
  node: ArtifactNode;
  artifact: Artifact;
  analysisId: string;
}): React.ReactElement {
  const relationships = artifact.edges.filter(
    (edge) => edge.source === node.id || edge.target === node.id,
  );

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="spread">
        <h3 style={{ margin: 0 }}>{node.label}</h3>
        <div className="row">
          {node.c4Kind ? <span className="chip">{ELEMENT_LABELS[node.c4Kind]}</span> : null}
          <ConfidenceBadge value={node.confidence} />
        </div>
      </div>

      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Element id</dt>
        <dd className="mono small">{node.id}</dd>
        {node.technology ? (
          <>
            <dt>Technology</dt>
            <dd className="mono small">{node.technology}</dd>
          </>
        ) : null}
        {node.path ? (
          <>
            <dt>Declared in</dt>
            <dd className="mono small">{node.path}</dd>
          </>
        ) : null}
        <dt>Why RepoAtlas believes this</dt>
        <dd className="small">{node.derivation ?? 'Not stated.'}</dd>
      </dl>

      <h4 style={{ marginTop: 14 }}>Evidence ({node.evidence.length})</h4>
      {node.evidence.length === 0 ? (
        <Empty>No citation is attached to this element.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Kind</th>
              <th>Producer</th>
            </tr>
          </thead>
          <tbody>
            {node.evidence.map((ref) => (
              <tr key={ref.evidenceId}>
                <td className="mono small">
                  {ref.path}
                  {ref.startLine > 0 ? `:${ref.startLine}` : ''}
                </td>
                <td className="small">{ref.kind}</td>
                <td className="small dim">{ref.producer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 style={{ marginTop: 14 }}>Relationships ({relationships.length})</h4>
      {relationships.length === 0 ? (
        <Empty>No relationship to another element of this level was evidenced.</Empty>
      ) : (
        relationships.map((edge) => <RelationshipRow key={edge.id} edge={edge} self={node.id} />)
      )}

      {node.graphNodeIds && node.graphNodeIds.length > 0 ? (
        <p className="small dim" style={{ marginTop: 12 }}>
          Graph entities behind this element:{' '}
          {node.graphNodeIds.map((id) => (
            <span key={id} className="mono" style={{ marginRight: 8 }}>
              {id}
            </span>
          ))}
          . Selecting the element opens the entity inspector for analysis {analysisId.slice(0, 8)}.
        </p>
      ) : null}
    </div>
  );
}

/** One architectural relationship, with the graph facts that justify it. */
function RelationshipRow({ edge, self }: { edge: ArtifactEdge; self: string }): React.ReactElement {
  const direction = edge.source === self ? '→' : '←';
  const support = describeSupport(edge);

  return (
    <div style={{ borderTop: '1px solid var(--line, #1e2936)', padding: '8px 0' }}>
      <div className="row wrap">
        <span className="mono small">
          {direction} {edge.kind}
        </span>
        <span className="mono small dim">{edge.source === self ? edge.target : edge.source}</span>
        <ConfidenceBadge value={edge.confidence} />
        {isExistenceOnly(edge) ? (
          // Supported by the existence of elements rather than by a graph relationship. Shown
          // explicitly so it cannot be read as a code-level dependency.
          <span className="badge partially_evidenced" title="Justified by the existence of a declared element, not by a code path">
            co-declared
          </span>
        ) : null}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {edge.derivation ?? 'No derivation recorded.'}
      </div>
      {support !== null ? (
        <div className="small dim mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>
          justified by {support}
        </div>
      ) : (
        // Unreachable through the projection's integrity gate; shown anyway so that a
        // violation is visible in the product rather than only in a test.
        <Notice kind="warning">
          <span className="small">This relationship carries no graph support and should not have been drawn.</span>
        </Notice>
      )}
    </div>
  );
}
