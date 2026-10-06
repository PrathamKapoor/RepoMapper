import type { Artifact } from './api';
import { ConfidenceBadge } from './ui';
import { EvidenceDetails, type EvidenceRow } from './evidence-details';

/**
 * The shared evidence explorer.
 *
 * Every arrow in every view opens this panel, and the panel answers the same four questions in
 * the same order: what does this relationship claim, how was it established, where does the
 * source state it, and how confident was the extraction.
 *
 * It is shared rather than per-view for one reason. A reader who learns on the dependency graph
 * that clicking an arrow shows its derivation and its evidence should not have to relearn it on
 * the deployment view, and — more importantly — should not be able to reach a view where an
 * arrow shows *less*. A second panel with fewer fields would quietly reintroduce the problem this
 * product exists to fix: a relationship rendered with the visual authority of a cited fact and
 * none of the citation.
 *
 * Nothing is invented to fill a gap. An arrow with no recorded evidence says so explicitly, and
 * an empty evidence list is stated as empty rather than hidden.
 */

export interface EvidencePanelProps {
  artifact: Artifact | undefined;
  edgeId: string;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

/** How each relationship kind was established, in the words the extraction used. */
const ESTABLISHED_BY: Record<string, string> = {
  calls: 'Recorded from a call site in the source.',
  returns: 'Recorded from a return statement, an awaited call, or a response call in the handler.',
  throws: 'Recorded from an explicit throw, rejection or raise inside the callee.',
  responds: 'Recorded from the response a handler sends.',
  depends_on: 'Recorded from a declaration in a manifest, compose file or CI configuration.',
  joins_network: 'Recorded from a compose file listing this service on this network.',
  references_secret: 'Recorded from a file naming this variable. The value was never read.',
  imports: 'Recorded from an import statement.',
  configures: 'Recorded from a configuration key in the declaring file.',
  deploys: 'Recorded from a build context or an explicit service declaration.',
  reads: 'Recorded from a query against this table.',
  writes: 'Recorded from a statement that writes to this table.',
  exposes: 'Recorded from the route the module registers.',
  contains: 'Recorded from containment in the analysed repository.',
};

const KIND_TITLES: Record<string, string> = {
  calls: 'Call',
  returns: 'Return',
  throws: 'Throw',
  responds: 'HTTP response',
  depends_on: 'Declared dependency',
  joins_network: 'Network membership',
  references_secret: 'Secret reference',
  imports: 'Import',
  configures: 'Configuration',
  deploys: 'Deployment',
  reads: 'Reads',
  writes: 'Writes',
  exposes: 'Exposes',
  contains: 'Contains',
};

export function EvidencePanel({ artifact, edgeId, onSelectNode, onClose }: EvidencePanelProps): React.ReactElement | null {
  const edge = artifact?.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;

  const label = (id: string): string => artifact?.nodes.find((node) => node.id === id)?.label ?? id;
  const name = (id: string): string => label(id).split('::').pop() ?? label(id);

  const rows: EvidenceRow[] = edge.evidence.map((item) => ({
    evidenceId: item.evidenceId,
    location: `${item.path}:${item.startLine}${item.endLine > item.startLine ? `-${item.endLine}` : ''}`,
    kind: item.kind,
    producer: item.producer,
  }));

  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="interaction-panel" data-edge-id={edgeId}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>
          {KIND_TITLES[edge.kind] ?? edge.kind}: {name(edge.source)} to {name(edge.target)}
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="row wrap" style={{ margin: '8px 0' }}>
        <ConfidenceBadge value={edge.confidence} />
        <span className="small dim">{ESTABLISHED_BY[edge.kind] ?? 'Recorded relationship.'}</span>
      </div>

      {edge.derivation ? <p className="small">{edge.derivation}</p> : null}

      <div className="row wrap small dim" style={{ margin: '6px 0' }}>
        <button type="button" onClick={() => onSelectNode(edge.source)}>
          {name(edge.source)}
        </button>
        <span>to</span>
        <button type="button" onClick={() => onSelectNode(edge.target)}>
          {name(edge.target)}
        </button>
      </div>

      <EvidenceDetails rows={rows} />

      {edge.supportingEdgeIds && edge.supportingEdgeIds.length > 0 ? (
        <p className="small dim" style={{ marginTop: 8 }}>
          Justified by graph relationship: {edge.supportingEdgeIds.join(', ')}
        </p>
      ) : null}
    </div>
  );
}