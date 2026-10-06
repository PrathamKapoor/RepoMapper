import { useCallback, useMemo } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Artifact, Confidence, GraphNode } from './api';
import { ConfidenceLegend, Empty, Notice } from './ui';

/**
 * Graph renderer.
 *
 * Nodes are laid out on a deterministic grid derived from the projection order rather
 * than by a force simulation. That choice is deliberate: a force layout re-randomises
 * on every render, so two engineers looking at the same analysis would see different
 * pictures, and screenshots in a review would not match. A deterministic layout also
 * means the same repository always produces the same picture, which is what makes
 * before/after comparison meaningful.
 *
 * Confidence is encoded visually: explicit relationships are solid, inferred ones are
 * dashed. Colour encodes entity kind.
 */

const KIND_COLOURS: Record<string, string> = {
  repository: '#4da3ff',
  module: '#58a6ff',
  package: '#8b949e',
  class: '#3fb950',
  interface: '#2ea043',
  type: '#238636',
  function: '#d29922',
  test: '#a371f7',
  api_endpoint: '#f0883e',
  table: '#db61a2',
  column: '#c9a0dc',
  configuration: '#6e7681',
deployment_component: '#f85149',
  network: '#7ee787',
  secret: '#ff7b72',
  secret_reference: '#ff7b72',
  base_image: '#ffa657',
  ci_workflow: '#d2a8ff',
};

function colourFor(kind: string): string {
  return KIND_COLOURS[kind] ?? '#8b949e';
}

export interface AtlasGraphProps {
  nodes: { id: string; label: string; kind: string; confidence: Confidence; detail?: string; path?: string }[];
  edges: { id: string; source: string; target: string; confidence: Confidence; label?: string; kind?: string }[];
/** Invoked when a node is clicked, to open the entity inspector. */
  onSelectNode?: (nodeId: string) => void;
  /**
   * Invoked when an arrow is clicked, to open the evidence explorer.
   *
   * Every view wires this to the same panel. A relationship must be inspectable wherever it is
   * drawn — a reader who can click an arrow in one view and not in another would reasonably
   * conclude the other view is showing something it cannot support.
   */
  onSelectEdge?: (edgeId: string) => void;
  height?: number;
  /** Cap on rendered nodes; the UI states when it is truncated rather than silently cutting. */
  maxNodes?: number;
}

interface AtlasInnerProps extends AtlasGraphProps {
  onNodeClick: NodeMouseHandler<Node>;
  onEdgeClick: EdgeMouseHandler;
}

function AtlasInner({ nodes, edges, onNodeClick, onEdgeClick, height = 520, maxNodes = 220 }: AtlasInnerProps): React.ReactElement {
  const visible = useMemo(() => nodes.slice(0, maxNodes), [nodes, maxNodes]);
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);

  const layouted = useMemo<Node[]>(() => {
    // Column-major placement: related nodes land near each other because the graph
    // builder emits them in module order.
    const columns = Math.max(1, Math.ceil(Math.sqrt(visible.length)));
    return visible.map((node, index) => ({
      id: node.id,
      position: { x: (index % columns) * 210, y: Math.floor(index / columns) * 74 },
      data: { label: node.label, kind: node.kind, confidence: node.confidence, detail: node.detail },
      style: {
        background: '#111823',
        color: '#dbe4ee',
        border: `1px solid ${colourFor(node.kind)}`,
        borderRadius: 6,
        fontSize: 11,
        padding: '6px 9px',
        width: 186,
        opacity: node.confidence === 'UNKNOWN' ? 0.6 : 1,
      },
    }));
  }, [visible]);

  const layoutedEdges = useMemo<Edge[]>(
    () =>
      edges
        .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          animated: false,
          style: {
            stroke: edge.confidence === 'EXPLICIT' ? '#3fb950' : edge.confidence === 'UNKNOWN' ? '#6e7681' : '#d29922',
            strokeWidth: edge.confidence === 'EXPLICIT' ? 1.3 : 1,
            strokeDasharray: edge.confidence === 'EXPLICIT' ? undefined : '4 3',
            opacity: 0.75,
          },
          labelStyle: { fill: '#8b9cb0', fontSize: 9 },
          labelBgStyle: { fill: '#0b0f14' },
        })),
    [edges, visibleIds],
  );

  if (visible.length === 0) {
    return (
      <div className="graph-frame" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty>No entities to display for this view.</Empty>
      </div>
    );
  }

  return (
    <div>
      <div className="graph-frame" style={{ height }}>
        <ReactFlow
          nodes={layouted}
          edges={layoutedEdges}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          fitView
          minZoom={0.05}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#1e2936" gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            style={{ background: '#0b0f14', border: '1px solid #1e2936' }}
            nodeColor={(node) => colourFor(String((node.data as { kind?: string }).kind ?? ''))}
          />
        </ReactFlow>
      </div>
      <ConfidenceLegend />
      {nodes.length > maxNodes ? (
        <p className="small dim" style={{ marginTop: 6 }}>
          Showing {maxNodes} of {nodes.length} entities. Filter by kind or search to narrow the view.
        </p>
      ) : null}
    </div>
  );
}

export function AtlasGraph(props: AtlasGraphProps): React.ReactElement {
  const handleNodeClick = useCallback<NodeMouseHandler<Node>>(
    (_event, node) => {
      props.onSelectNode?.(node.id);
    },
    [props],
  );

  // An arrow is a claim, so it is selectable: which call it came from, what confidence it was
  // recorded at and where the source states it. Selecting the two participants instead would
  // show what exists, not what the repository says happens between them.
  const handleEdgeClick = useCallback<EdgeMouseHandler>(
    (_event, edge) => {
      props.onSelectEdge?.(edge.id);
    },
    [props],
  );

  return (
    <ReactFlowProvider>
      <AtlasInner {...props} onNodeClick={handleNodeClick} onEdgeClick={handleEdgeClick} />
    </ReactFlowProvider>
  );
}

export interface GraphViewProps {
  artifact: Artifact | undefined;
  loading: boolean;
  error: string | null;
  onSelectNode: (nodeId: string) => void;
  /** Invoked when an arrow is clicked. Kept optional so a caller that only reads the shape can ignore it. */
  onSelectEdge?: (edgeId: string) => void;
}

/**
 * Renders one artifact projection.
 *
 * When the graph did not contain enough to draw the view, this says so explicitly and
 * explains what would be needed — instead of rendering an empty canvas that reads as a
 * successful result.
 */
export function GraphView({ artifact, loading, error, onSelectNode, onSelectEdge }: GraphViewProps): React.ReactElement {
  if (loading) return <Empty>Loading projection…</Empty>;
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!artifact) return <Notice kind="warning">This projection is not available for the selected analysis.</Notice>;

  return (
    <div>
      <p className="small muted">{artifact.scope}</p>

      {artifact.insufficientEvidence ? (
        <Notice kind="warning">
          <strong>Not enough evidence in this repository to draw this view.</strong>
          <div className="small muted" style={{ marginTop: 4 }}>
            The graph contains {artifact.stats.graphNodes} entities and {artifact.stats.graphEdges} relationships, but
            none of the kind this projection needs. This is a statement about the repository, not a failure.
          </div>
        </Notice>
      ) : null}

      <AtlasGraph
        nodes={artifact.nodes}
        edges={artifact.edges}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
      />

      {artifact.omitted.length > 0 ? (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>Not represented in this view</h3>
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th style={{ width: 70 }}>Count</th>
                <th>Examples</th>
              </tr>
            </thead>
            <tbody>
              {artifact.omitted.map((entry) => (
                <tr key={entry.reason}>
                  <td>{entry.reason}</td>
                  <td className="mono">{entry.count}</td>
                  <td className="mono small dim">{entry.examples.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export { colourFor };
export type { GraphNode };