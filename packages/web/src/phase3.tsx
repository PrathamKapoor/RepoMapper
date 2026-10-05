import { useCallback, useEffect, useMemo, useState } from 'react';
import { GraphView } from './graph';
import {
  api,
  type Artifact,
  type ConsistencyFinding,
  type ConsistencyReport,
  type Lineage,
  type LineageHop,
  type Requirement,
  type RequirementModel,
  type Traceability,
  type TraceabilityIndex,
  type UseCase,
  type UseCaseModel,
  type UseCaseStatus,
} from './api';
import {
  chainCounts,
  consistencyHeadline,
  consistencyNeedsAttention,
  orderFindings,
  orderRequirements,
  requirementStatusLabel,
  traceView,
} from './presentation';
import { ConfidenceBadge, Empty, Notice, Stat, StatusBadge } from './ui';

/**
 * Behaviour and traceability views.
 *
 * Progressive disclosure is the organising principle: the lists come first, and a row opens the
 * detail that justifies it. Nothing here decides what the repository means — every panel reads
 * the API and shows the derivation the server sent with it.
 *
 * Where evidence is missing, the view says so in the same place it would have shown the fact.
 * A use case with no steps is listed as unrecovered rather than hidden, and a chain with a
 * broken joint names the joint, because the gap is the thing a reviewer needs.
 */

const USE_CASE_FILTERS: { id: UseCaseStatus | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'OBSERVED', label: 'Fully traced' },
  { id: 'PARTIAL', label: 'Partly traced' },
  { id: 'UNKNOWN', label: 'Not evidenced' },
];

export interface TraceabilityTabProps {
  analysisId: string;
  onSelectNode: (nodeId: string) => void;
}

export function TraceabilityTab({ analysisId, onSelectNode }: TraceabilityTabProps): React.ReactElement {
  const [section, setSection] = useState<'requirements' | 'use-cases' | 'chain' | 'consistency'>('requirements');
  const [requirements, setRequirements] = useState<RequirementModel | null>(null);
  const [useCases, setUseCases] = useState<(UseCaseModel & { filtered: boolean }) | null>(null);
  const [filter, setFilter] = useState<UseCaseStatus | 'ALL'>('ALL');
  const [index, setIndex] = useState<TraceabilityIndex | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<Traceability | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [requirementResult, useCaseResult, indexResult, consistencyResult] = await Promise.all([
        api.getRequirements(analysisId),
        api.getUseCases(analysisId),
        api.getTraceabilityIndex(analysisId),
        api.getConsistency(analysisId),
      ]);
      setRequirements(requirementResult);
      setUseCases(useCaseResult);
      setIndex(indexResult);
      setConsistency(consistencyResult);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [analysisId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Selecting an entry point follows its chain. A selection that no longer resolves leaves the
  // chain empty rather than showing the previous entity's chain.
  useEffect(() => {
    if (!selected) {
      setTrace(null);
      return;
    }
    let cancelled = false;
    api
      .getTraceability(analysisId, selected)
      .then((result) => {
        if (!cancelled) setTrace(result);
      })
      .catch(() => {
        if (!cancelled) setTrace(null);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, selected]);

  const visibleUseCases = useMemo(() => {
    if (!useCases) return [];
    if (filter === 'ALL') return useCases.useCases;
    return useCases.useCases.filter((useCase) => useCase.status === filter);
  }, [useCases, filter]);

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <button type="button" className={section === 'requirements' ? 'primary' : ''} onClick={() => setSection('requirements')}>
          Requirements
        </button>
        <button type="button" className={section === 'use-cases' ? 'primary' : ''} onClick={() => setSection('use-cases')}>
          Use cases
        </button>
        <button type="button" className={section === 'chain' ? 'primary' : ''} onClick={() => setSection('chain')}>
          Traceability
        </button>
        <button type="button" className={section === 'consistency' ? 'primary' : ''} onClick={() => setSection('consistency')}>
          Consistency
        </button>
        <div className="spacer" />
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {section === 'requirements' ? (
        <RequirementsPanel model={requirements} onSelectNode={onSelectNode} />
      ) : null}

      {section === 'use-cases' ? (
        <UseCasesPanel
          model={useCases}
          visible={visibleUseCases}
          filter={filter}
          onFilter={setFilter}
          onSelectNode={onSelectNode}
        />
      ) : null}

      {section === 'chain' ? (
        <ChainPanel index={index} selected={selected} trace={trace} onSelect={setSelected} onSelectNode={onSelectNode} />
      ) : null}

      {section === 'consistency' ? (
        <ConsistencyPanel report={consistency} loading={loading} onSelectNode={onSelectNode} />
      ) : null}
    </div>
  );
}

function RequirementsPanel({
  model,
  onSelectNode,
}: {
  model: RequirementModel | null;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  if (!model) return <Empty>Loading requirements…</Empty>;

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Stat label="Stated" value={model.summary.declared} note="a document says so" />
        <Stat label="Derived" value={model.summary.derived} note="read from the code by a fixed rule" />
        <Stat label="Documents read" value={model.documentsSearched} />
      </div>

      {model.summary.notRecovered.length > 0 ? (
        <Notice kind="info">
          <strong>Claims this view does not make.</strong>
          <ul>
            {model.summary.notRecovered.map((entry) => (
              <li key={entry.reason}>
                {entry.count > 0 ? `${entry.count} × ` : ''}
                {entry.reason}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {model.requirements.length === 0 ? (
        <Empty>This repository states no requirement and evidences none that this model derives.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th style={{ width: 190 }}>Status</th>
              <th style={{ width: 150 }}>Implemented by</th>
            </tr>
          </thead>
          <tbody>
            {orderRequirements(model.requirements).map((requirement) => (
              <RequirementRow key={requirement.id} requirement={requirement} onSelectNode={onSelectNode} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RequirementRow({
  requirement,
  onSelectNode,
}: {
  requirement: Requirement;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const evidence = requirement.evidence[0];
  return (
    <tr>
      <td>
        {requirement.statement}
        <div className="small dim">{requirement.derivation}</div>
        {evidence ? (
          <div className="small mono dim">
            {evidence.path}:{evidence.startLine}
          </div>
        ) : null}
      </td>
      <td>
        <span className="badge partially_evidenced">{requirementStatusLabel(requirement)}</span>
        <div style={{ marginTop: 4 }}>
          <ConfidenceBadge value={requirement.confidence} />
        </div>
      </td>
      <td>
        {requirement.supportedByNodeIds.length === 0 ? (
          <span className="small dim">nothing in this repository implements it</span>
        ) : (
          requirement.supportedByNodeIds.map((nodeId) => (
            <button key={nodeId} type="button" className="link" onClick={() => onSelectNode(nodeId)}>
              {nodeId}
            </button>
          ))
        )}
      </td>
    </tr>
  );
}

function UseCasesPanel({
  model,
  visible,
  filter,
  onFilter,
  onSelectNode,
}: {
  model: (UseCaseModel & { filtered: boolean }) | null;
  visible: UseCase[];
  filter: UseCaseStatus | 'ALL';
  onFilter: (status: UseCaseStatus | 'ALL') => void;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  if (!model) return <Empty>Loading use cases…</Empty>;

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {USE_CASE_FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === filter ? 'primary' : ''}
            onClick={() => onFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {model.actors.length === 0 ? (
        <p className="small dim">
          No actor is named: nothing in this repository states who or what invokes these entry points, and an actor
          is never inferred from the shape of a route.
        </p>
      ) : (
        <p className="small dim">Actors evidenced in the graph: {model.actors.map((actor) => actor.name).join(', ')}</p>
      )}

      {visible.length === 0 ? (
        <Empty>No use case has this status in this repository.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Use case</th>
              <th style={{ width: 150 }}>Status</th>
              <th style={{ width: 110 }}>Steps</th>
              <th>Not evidenced</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((useCase) => (
              <tr key={useCase.id}>
                <td>
                  {useCase.title}
                  <div className="small dim">{useCase.trigger}</div>
                  <button type="button" className="link small" onClick={() => onSelectNode(useCase.entryNodeId)}>
                    {useCase.entryNodeId}
                  </button>
                </td>
                <td>
                  <StatusBadge value={useCase.status} />
                </td>
                <td className="mono">{useCase.steps.length}</td>
                <td>
                  {useCase.missing.length === 0 ? (
                    <span className="small dim">nothing outstanding</span>
                  ) : (
                    <ul className="small">
                      {useCase.missing.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ChainPanel({
  index,
  selected,
  trace,
  onSelect,
  onSelectNode,
}: {
  index: TraceabilityIndex | null;
  selected: string | null;
  trace: Traceability | null;
  onSelect: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  if (!index) return <Empty>Loading traceability…</Empty>;

  const view = traceView(trace, false, null);

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Stat label="Entry points" value={index.totals.subjects} />
        <Stat label="Fully traced" value={index.totals.complete} note="every joint evidenced" />
        <Stat label="Partly traced" value={index.totals.incomplete} note="at least one joint unevidenced" />
      </div>

      <table>
        <thead>
          <tr>
            <th>Entry point</th>
            <th style={{ width: 110 }}>Requirements</th>
            <th style={{ width: 90 }}>Use cases</th>
            <th style={{ width: 120 }}>Implementation</th>
            <th style={{ width: 80 }}>Tests</th>
            <th style={{ width: 120 }}>Chain</th>
          </tr>
        </thead>
        <tbody>
          {index.rows.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <Empty>This repository states no entry point, so no chain starts anywhere.</Empty>
              </td>
            </tr>
          ) : (
            index.rows.map((row) => (
              <tr key={row.subjectId}>
                <td>
                  <button type="button" className="link" onClick={() => onSelect(row.subjectId)}>
                    {row.title}
                  </button>
                  <div className="small mono dim">{row.entryKind}</div>
                </td>
                <td className="mono">{row.requirements}</td>
                <td className="mono">{row.useCases}</td>
                <td className="mono">{row.implementation}</td>
                <td className="mono">{row.tests}</td>
                <td>{row.complete ? <StatusBadge value="complete" /> : <StatusBadge value="partial" />}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {selected ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{trace?.subject.name ?? selected}</h3>
          {/*
              A list inside a paragraph is invalid HTML: the browser closes the <p> before the
              <ul>, which React reports as a hydration mismatch. The browser check caught it.
              The text and the list are siblings here, so the nesting problem cannot recur.
            */}
            <p className="small dim">{view.text}</p>
            {view.kind === 'broken' ? (
              <ul className="small">
                {view.breaks.map((entry) => (
                  <li key={entry.kind}>
                    <strong>{entry.kind}</strong>: {entry.reason}
                  </li>
                ))}
              </ul>
            ) : null}

          <div className="row wrap" style={{ margin: '8px 0' }}>
            {chainCounts(trace).map((entry) => (
              <Stat key={entry.role} label={entry.role.replace('_', ' ')} value={entry.count} />
            ))}
          </div>

          {trace && trace.links.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Joint</th>
                  <th>Link</th>
                  <th style={{ width: 150 }}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {trace.links.map((link) => (
                  <tr key={`${link.role}:${link.id}`}>
                    <td className="small">{link.role.replace('_', ' ')}</td>
                    <td>
                      {link.label}
                      {link.note ? <div className="small dim">{link.note}</div> : null}
                      <div className="small mono dim">
                        {link.edgeIds.length} relationship(s), {link.evidence.length} evidence item(s)
                      </div>
                    </td>
                    <td>
                      <ConfidenceBadge value={link.confidence} />
                      {link.role === 'implementation' || link.role === 'test' ? (
                        <button type="button" className="link small" onClick={() => onSelectNode(link.id)}>
                          open entity
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConsistencyPanel({
  report,
  loading,
  onSelectNode,
}: {
  report: ConsistencyReport | null;
  loading: boolean;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const headline = consistencyHeadline(report, loading, null);
  const findings = report ? orderFindings(report.findings) : [];
  const needsAttention = consistencyNeedsAttention(report);

  return (
    <div>
      <Notice kind={needsAttention ? 'warning' : 'info'}>{headline}</Notice>

      {report ? (
        <p className="small dim">
          Compared: {report.compared.join(', ')}. A missing relationship is reported as missing evidence; a
          contradiction is reserved for two statements that cannot both be true.
        </p>
      ) : null}

      {findings.length === 0 && !loading ? (
        <Empty>No cross-artifact finding could be established from this repository.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 190 }}>Class</th>
              <th>Finding</th>
              <th style={{ width: 200 }}>Entities</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} onSelectNode={onSelectNode} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FindingRow({
  finding,
  onSelectNode,
}: {
  finding: ConsistencyFinding;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  return (
    <tr>
      <td>
        <StatusBadge value={finding.class} />
        <div className="small dim">{finding.artifacts.join(' + ')}</div>
      </td>
      <td>
        {finding.title}
        <div className="small">{finding.detail}</div>
        <div className="small dim">
          <strong>Expected:</strong> {finding.evidenceExpected} <strong>Found:</strong> {finding.evidenceFound}
        </div>
        <div className="small dim">{finding.derivation}</div>
      </td>
      <td>
        {finding.nodeIds.slice(0, 3).map((nodeId) => (
          <button key={nodeId} type="button" className="link small" onClick={() => onSelectNode(nodeId)}>
            {nodeId}
          </button>
        ))}
        {finding.nodeIds.length > 3 ? <div className="small dim">+{finding.nodeIds.length - 3} more</div> : null}
        {finding.nodeIds.length === 0 ? <span className="small dim">no entity — repository-wide</span> : null}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Behaviour: sequence, activity, data flow and lineage
// ---------------------------------------------------------------------------

const BEHAVIOUR_VIEWS = [
  { id: 'sequence', label: 'Sequence', question: 'Which call relationships connect the entry points to the code behind them?' },
  { id: 'activity', label: 'Activity', question: 'Where does the source state a decision point, and in what order?' },
  { id: 'data-flow', label: 'Data flow', question: 'Which data relationships move values between code and stores?' },
] as const;

/**
 * Behaviour views, with data lineage alongside them.
 *
 * The three projections answer different questions and are never shown together: a message
 * arrow, a decision point and a data flow are different kinds of claim, and mixing them invites
 * reading a call as a data movement. Lineage sits next to them because the natural follow-up
 * from "this store is written here" is "and where does that value come from".
 */
export function BehaviourTab({
  analysisId,
  onSelectNode,
}: {
  analysisId: string;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const [active, setActive] = useState<string>(BEHAVIOUR_VIEWS[0].id);
  const [artifact, setArtifact] = useState<Awaited<ReturnType<typeof api.getArtifact>> | undefined>(undefined);
  const [interaction, setInteraction] = useState<string | null>(null);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [store, setStore] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

  // Stores come from the graph, not from a hard-coded list, so the picker is empty on a
  // repository with no schema and says so.
  useEffect(() => {
    let cancelled = false;
    api
      .getGraph(analysisId, { kind: 'table', limit: 200 })
      .then((result) => {
        if (cancelled) return;
        const tables = result.nodes.map((node) => ({ id: node.id, name: node.name }));
        setStores(tables);
        setStore((current) => current || (tables[0]?.id ?? ''));
      })
      .catch(() => {
        if (!cancelled) setStores([]);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  const question = BEHAVIOUR_VIEWS.find((view) => view.id === active)?.question;

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {BEHAVIOUR_VIEWS.map((view) => (
          <button key={view.id} type="button" className={view.id === active ? 'primary' : ''} onClick={() => setActive(view.id)}>
            {view.label}
          </button>
        ))}
      </div>
      {question ? <p className="small dim">{question}</p> : null}

      <GraphView
        artifact={artifact}
        loading={loading}
        error={error}
        onSelectNode={onSelectNode}
        onSelectEdge={setInteraction}
      />

      {interaction ? (
        <InteractionPanel
          artifact={artifact}
          edgeId={interaction}
          onSelectNode={onSelectNode}
          onClose={() => setInteraction(null)}
        />
      ) : null}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Data lineage</h3>
        {stores.length === 0 ? (
          <p className="small dim">
            This repository declares no table in a schema this analysis read, so there is nothing to trace. A store
            referenced only in SQL would appear here as an unknown store rather than being omitted.
          </p>
        ) : (
          <>
            <div className="row wrap" style={{ marginBottom: 8 }}>
              {stores.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={entry.id === store ? 'primary' : ''}
                  onClick={() => setStore(entry.id)}
                >
                  {entry.name}
                </button>
              ))}
            </div>
            {store ? <LineagePanel analysisId={analysisId} nodeId={store} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interaction evidence
// ---------------------------------------------------------------------------

const MESSAGE_KINDS: Record<string, string> = {
  calls: 'call',
  returns: 'return',
  throws: 'error path',
};

/**
 * What one arrow in a behaviour view asserts, and why.
 *
 * An arrow is a claim about the repository, so it has to be inspectable on its own: which kind of
 * message it is, how it was established, where the source states it, and how confident the
 * extraction was. Selecting the two endpoints instead would show what exists, not what the
 * repository says happens between them, so the evidence lives here rather than in a node panel.
 *
 * Nothing is invented to fill a gap: a call with no recorded return says so, and an empty evidence
 * list is stated as empty rather than hidden.
 */
export function InteractionPanel({
  artifact,
  edgeId,
  onSelectNode,
  onClose,
}: {
  artifact: Artifact | undefined;
  edgeId: string;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}): React.ReactElement | null {
  const edge = artifact?.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;

  const label = (id: string): string => artifact?.nodes.find((node) => node.id === id)?.label ?? id;
  const name = (id: string): string => (label(id).split('::').pop() ?? label(id));

  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="interaction-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>
          {MESSAGE_KINDS[edge.kind] ?? edge.kind}: {name(edge.source)} to {name(edge.target)}
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="row wrap" style={{ margin: '8px 0' }}>
        <ConfidenceBadge value={edge.confidence} />
        <span className="small dim">
          {edge.kind === 'calls'
            ? 'Recorded from a call site in the source.'
            : edge.kind === 'returns'
              ? 'Recorded from a return statement, an awaited call, or a response call in the handler.'
              : edge.kind === 'throws'
                ? 'Recorded from an explicit throw, rejection or raise inside the callee.'
                : 'Recorded relationship.'}
        </span>
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

      <h4 style={{ marginBottom: 4 }}>Evidence ({edge.evidence.length})</h4>
      {edge.evidence.length === 0 ? (
        <p className="small dim">
          No source location is recorded for this arrow. The relationship exists in the graph, and this panel states
          that rather than implying a citation it does not have.
        </p>
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
            {edge.evidence.map((item) => (
              <tr key={item.evidenceId}>
                <td className="mono">
                  {item.path}:{item.startLine}
                  {item.endLine > item.startLine ? `-${item.endLine}` : ''}
                </td>
                <td className="mono small dim">{item.kind}</td>
                <td className="mono small dim">{item.producer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {edge.supportingEdgeIds && edge.supportingEdgeIds.length > 0 ? (
        <p className="small dim" style={{ marginTop: 8 }}>
          Justified by graph relationship: {edge.supportingEdgeIds.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export interface LineagePanelProps {
  analysisId: string;
  /** Store or entity to trace. */
  nodeId: string;
}

/** How a table name's role in a statement reads to a reader. */
const ROLE_PHRASES: Record<string, string> = {
  from: 'FROM',
  join: 'JOIN',
  insert_into: 'INSERT target',
  update_target: 'UPDATE target',
  delete_target: 'DELETE target',
  delete_using: 'USING',
};

/**
 * One hop in words, or an honest statement that the hop records no operation.
 *
 * The operation is the difference between "this is where a value is persisted" and "this is
 * where it is read", so it is never inferred from the direction of the hop. A relationship with
 * no operation says so rather than defaulting to a read.
 */
export function hopStatement(hop: LineageHop): string {
  const parts: string[] = [];
  if (hop.operation) parts.push(hop.operation === 'write' ? 'write' : 'read');
  if (hop.role) parts.push(`from the ${ROLE_PHRASES[hop.role] ?? hop.role} clause`);
  if (hop.statement) parts.push(`statement \`${hop.statement}\``);
  if (parts.length === 0) return 'no operation recorded for this relationship';
  return parts.join(', ');
}

/**
 * One sentence about how a store is used.
 *
 * Written rather than concatenated from counts so that "nothing states an operation" is
 * distinguishable from "nothing reads it" - the first is a limit of the extraction, the second
 * is a fact about the repository.
 */
export function describeUsage(usage: { read: number; write: number; unclassified: number }): string {
  const parts: string[] = [];
  if (usage.write > 0) parts.push(`written by ${usage.write} recorded operation(s)`);
  if (usage.read > 0) parts.push(`read by ${usage.read} recorded operation(s)`);
  const qualified = usage.unclassified > 0 ? `${usage.unclassified} relationship(ies) recording no operation` : '';
  if (parts.length === 0) {
    // No operation anywhere. Whether the store is touched at all is a different question, and
    // the unclassified count is the only thing the graph can say about it.
    return qualified.length > 0
      ? `${qualified}; the repository states no read or write for it`
      : 'not read or written by any recorded data relationship';
  }
  const sentence = parts.join(' and ');
  return qualified.length > 0 ? `${sentence}, with ${qualified}` : sentence;
}

/**
 * Where a value came from and where it goes.
 *
 * Both directions are shown because a lineage that only answers one way answers half the
 * question. An empty result is stated as empty: the graph holds no data relationship for this
 * store, which is a fact about the repository rather than a failure to trace.
 */
export function LineagePanel({ analysisId, nodeId }: LineagePanelProps): React.ReactElement {
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLineage(null);
    setError(null);
    api
      .getLineage(analysisId, nodeId)
      .then((result) => {
        if (!cancelled) setLineage(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, nodeId]);

  if (error) return <Notice kind="info">{error}</Notice>;
  if (!lineage) return <Empty>Following data lineage…</Empty>;

  const hops = [...lineage.upstream, ...lineage.downstream];
  if (hops.length === 0) {
    return (
      <Empty>
        No analysed code reads or writes <strong>{lineage.subjectName}</strong>. The store exists in the schema; nothing in
        the repository moves data to or from it.
      </Empty>
    );
  }

  return (
    <div>
<p className="small dim">
        {lineage.upstream.length} hop(s) upstream, {lineage.downstream.length} downstream
        {lineage.truncated ? ', truncated at the hop limit - this chain is longer than the view shows' : ''}.
      </p>

      {/*
        Read and write are counted separately because they answer different questions, and a
        merged number is how a reader ends up believing a store is persisted when it is only
        read. `unclassified` is shown too: a relationship that states no operation must not be
        reported as "no writes".
      */}
      <p className="small" style={{ margin: '6px 0' }}>
        <strong>{lineage.subjectName}</strong> is {describeUsage(lineage.usage)}.
      </p>

      <table>
        <thead>
          <tr>
            <th style={{ width: 110 }}>Direction</th>
            <th style={{ width: 120 }}>Relationship</th>
            <th>From → to</th>
            <th style={{ width: 130 }}>Confidence</th>
            <th style={{ width: 190 }}>Stated by</th>
          </tr>
        </thead>
        <tbody>
          {hops.map((hop) => (
            <tr key={`${hop.direction}:${hop.edgeId}:${hop.from}:${hop.to}`}>
              <td className="small">{hop.direction}</td>
              <td className="small">{hop.relation}</td>
              <td className="small mono">
                {hop.from} → {hop.to}
              </td>
              <td>
                <ConfidenceBadge value={hop.confidence} />
              </td>
              <td className="small dim">{hopStatement(hop)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}