import { evidenceId, toPosixPath } from './ids.js';
import { redactSecrets } from './redact.js';
import type { Evidence, EvidenceKind, EvidenceRef } from './types.js';
import { toEvidenceRef } from './types.js';

export interface EvidenceInput {
  kind: EvidenceKind;
  path: string;
  startLine: number;
  endLine?: number;
  symbol?: string;
  excerpt?: string;
  producer: string;
}

/**
 * Collects evidence records for one analysis run.
 *
 * Evidence is deduplicated by deterministic id so that N import statements of the
 * same module at the same line collapse into one citable fact, while genuinely
 * distinct statements each keep their own citation.
 */
export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  private readonly maxExcerptChars: number;

  constructor(options: { maxExcerptChars: number }) {
    this.maxExcerptChars = options.maxExcerptChars;
  }

  /** Records evidence and returns the stable reference to attach to a node or edge. */
  add(input: EvidenceInput): EvidenceRef {
    const path = toPosixPath(input.path);
    const startLine = Math.max(0, Math.trunc(input.startLine));
    const endLine = Math.max(startLine, Math.trunc(input.endLine ?? input.startLine));
    const id = evidenceId(path, input.kind, startLine, input.producer);

    const existing = this.byId.get(id);
    if (existing) {
      return toEvidenceRef(existing);
    }

    const evidence: Evidence = {
      id,
      kind: input.kind,
      path,
      startLine,
      endLine,
      producer: input.producer,
      ...(input.symbol ? { symbol: input.symbol } : {}),
      ...(input.excerpt ? { excerpt: this.prepareExcerpt(input.excerpt) } : {}),
    };
    this.byId.set(id, evidence);
    return toEvidenceRef(evidence);
  }

  /** Normalises an excerpt: collapses whitespace, redacts secrets, truncates. */
  prepareExcerpt(raw: string): string {
    const flattened = raw.replace(/\s+/g, ' ').trim();
    const redacted = redactSecrets(flattened);
    if (redacted.length <= this.maxExcerptChars) return redacted;
    return `${redacted.slice(0, this.maxExcerptChars - 1)}…`;
  }

  get size(): number {
    return this.byId.size;
  }

  /** All evidence, ordered by path then line for stable diffs. */
  list(): Evidence[] {
    return [...this.byId.values()].sort(
      (a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id),
    );
  }

  /** Evidence for a specific file, used by the "show evidence" UI panel. */
  forPath(path: string): Evidence[] {
    const target = toPosixPath(path);
    return this.list().filter((item) => item.path === target);
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }
}
