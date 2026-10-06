import type { ReactElement } from 'react';

/**
 * The evidence list, shared by every panel that shows evidence.
 *
 * One table, one empty state, one set of columns. The reason is not tidiness: if each view
 * renders evidence its own way, a reader cannot compare two relationships by looking at the same
 * row, and an empty list in one view can look meaningfully different from an empty list in
 * another. Both would then read as different facts when they are the same fact.
 */

export interface EvidenceRow {
  evidenceId: string;
  location: string;
  kind: string;
  producer: string;
}

export function EvidenceDetails({ rows }: { rows: EvidenceRow[] }): ReactElement {
  return (
    <>
      <h4 style={{ marginBottom: 4 }}>Evidence ({rows.length})</h4>
      {rows.length === 0 ? (
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
            {rows.map((row) => (
              <tr key={row.evidenceId}>
                <td className="mono">{row.location}</td>
                <td className="mono small dim">{row.kind}</td>
                <td className="mono small dim">{row.producer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}