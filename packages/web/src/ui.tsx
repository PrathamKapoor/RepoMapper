
/** Maps a confidence value to its CSS class. Kept in one place so colours stay consistent. */
export function confidenceClass(confidence: string): string {
  return confidence.toLowerCase();
}

export function ConfidenceBadge({ value }: { value: string }): React.ReactElement {
  return <span className={`badge ${confidenceClass(value)}`}>{value.replace(/_/g, ' ')}</span>;
}

export function StatusBadge({ value }: { value: string }): React.ReactElement {
  return <span className={`badge ${confidenceClass(value)}`}>{value.replace(/_/g, ' ')}</span>;
}

/**
 * Explains, in the UI, what a confidence level means.
 *
 * This exists so a viewer never has to guess whether a dashed edge is a fact or a
 * guess. It is rendered next to every graph and every evidence panel.
 */
export function ConfidenceLegend(): React.ReactElement {
  return (
    <div className="legend">
      <span style={{ color: 'var(--explicit)' }}>solid = explicitly stated in source</span>
      <span style={{ color: 'var(--strong)' }}>dashed = strongly inferred (symbol resolved by name)</span>
      <span style={{ color: 'var(--weak)' }}>dotted = weakly inferred</span>
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}): React.ReactElement {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

export function Notice({
  kind,
  children,
}: {
  kind: 'info' | 'warning' | 'error' | 'success';
  children: React.ReactNode;
}): React.ReactElement {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="empty">{children}</div>;
}

/** Formats a byte or millisecond count for display. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Renders a count map as a compact chip list, largest first. */
export function CountChips({ counts, limit = 12 }: { counts: Record<string, number>; limit?: number }): React.ReactElement {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <Empty>none</Empty>;
  return (
    <div>
      {entries.slice(0, limit).map(([key, value]) => (
        <span className="chip" key={key}>
          {key} <strong>{value}</strong>
        </span>
      ))}
      {entries.length > limit ? <span className="dim small">+{entries.length - limit} more</span> : null}
    </div>
  );
}