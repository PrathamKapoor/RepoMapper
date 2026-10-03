import { useEffect, useState } from 'react';
import { api, type GraphEdge, type GraphNode, type NodeDetail } from './api';
import { ConfidenceBadge, Empty, Notice } from './ui';

/**
 * Entity inspector.
 *
 * Selecting an entity anywhere in the atlas opens this drawer, which answers the
 * question "what do we actually know about this, and how do we know it". It shows the
 * entity's own evidence, the relationships in and out, and — critically — the
 * confidence of each, so a viewer can tell a cited fact from a reconstruction without
 * leaving the view.
 */
export function EntityDrawer({
  analysisId,
  nodeId,
  onClose,
}: {
  analysisId: string;
  nodeId: string | null;
  onClose: () => void;
}): React.ReactElement | null {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getNode(analysisId, nodeId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, nodeId]);

  useEffect(() => {
    if (!nodeId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodeId, onClose]);

  if (!nodeId) return null;

  return (
    <aside className="drawer" role="dialog" aria-label="Entity details">
      <header>
        <h3 className="mono">{nodeId}</h3>
        <button type="button" onClick={onClose} aria-label="Close entity details">
          ✕
        </button>
      </header>

      {loading ? <Empty>Loading…</Empty> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      {detail ? <EntityBody detail={detail} /> : null}
    </aside>
  );
}

function EntityBody({ detail }: { detail: NodeDetail }): React.ReactElement {
  const { node, outgoing, incoming, related, evidence } = detail;
  const relatedById = new Map(related.map((item) => [item.id, item]));

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <span className="chip">{node.kind}</span>
        <ConfidenceBadge value={node.confidence} />
        {node.language ? <span className="chip">{node.language}</span> : null}
      </div>

      <dl className="kv">
        <dt>Name</dt>
        <dd className="mono">{node.name}</dd>
        {node.qualifiedName && node.qualifiedName !== node.name ? (
          <>
            <dt>Qualified</dt>
            <dd className="mono">{node.qualifiedName}</dd>
          </>
        ) : null}
        {node.path ? (
          <>
            <dt>Path</dt>
            <dd className="mono">
              {node.path}
              {node.startLine ? `:${node.startLine}` : ''}
            </dd>
          </>
        ) : null}
        {typeof node.attributes?.signature === 'string' ? (
          <>
            <dt>Signature</dt>
            <dd className="mono small">{node.attributes.signature}</dd>
          </>
        ) : null}
      </dl>

      {node.attributes && Object.keys(node.attributes).length > 0 ? (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Attributes</h3>
          <dl className="kv">
            {Object.entries(node.attributes)
              .filter(([, value]) => value !== null && value !== undefined && value !== '')
              .map(([key, value]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <dt>{key}</dt>
                  <dd className="mono small">{String(value)}</dd>
                </div>
              ))}
          </dl>
        </div>
      ) : null}

      <RelationshipTable title="Outgoing" edges={outgoing} relatedById={relatedById} direction="to" />
      <RelationshipTable title="Incoming" edges={incoming} relatedById={relatedById} direction="from" />

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Evidence ({evidence.length})</h3>
        {evidence.length === 0 ? (
          <Empty>No evidence recorded for this entity.</Empty>
        ) : (
          evidence.map((item) => (
            <div className="evidence" key={item.id}>
              <div className="loc">
                {item.path}
                {item.startLine > 0 ? `:${item.startLine}` : ''}
                {item.endLine > item.startLine ? `-${item.endLine}` : ''}
              </div>
              <div className="small dim">
                {item.kind} · produced by {item.producer}
                {item.symbol ? ` · ${item.symbol}` : ''}
              </div>
              {item.excerpt ? <div className="excerpt">{item.excerpt}</div> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RelationshipTable({
  title,
  edges,
  relatedById,
  direction,
}: {
  title: string;
  edges: GraphEdge[];
  relatedById: Map<string, GraphNode>;
  direction: 'to' | 'from';
}): React.ReactElement | null {
  if (edges.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>
        {title} ({edges.length})
      </h3>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Target</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => {
            const otherId = direction === 'to' ? edge.to : edge.from;
            const other = relatedById.get(otherId);
            return (
              <tr key={edge.id}>
                <td className="mono">{edge.kind}</td>
                <td className="mono small">{other ? `${other.kind}: ${other.name}` : otherId}</td>
                <td>
                  <ConfidenceBadge value={edge.confidence} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}