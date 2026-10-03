import { createHash } from 'node:crypto';
import type { EdgeKind, NodeKind } from './types.js';

/**
 * Deterministic identifier construction.
 *
 * Ids must be stable across runs so that re-analysing a repository produces a
 * comparable graph — drift detection and consistency analysis depend on it.
 */

/**
 * Normalises a name into an id-safe slug.
 *
 * Word characters, `.`, `_`, `-` and `/` are kept so a path keeps its shape; everything
 * else becomes `-`. Repeated separators are collapsed so that `src//a.ts` and
 * `src/a.ts` produce the same id — important because ids must be stable for the same
 * entity regardless of how the path was written.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

/** Builds a stable node id from its kind and distinguishing name. */
export function nodeId(kind: NodeKind, name: string): string {
  return `${kind}:${slugify(name)}`;
}

/** Builds a stable edge id from endpoints and kind. */
export function edgeId(from: string, kind: EdgeKind, to: string): string {
  return `${from}|${kind}|${to}`;
}

/** Builds a stable evidence id from its location and kind. */
export function evidenceId(path: string, kind: string, startLine: number, producer: string): string {
  const raw = `${path}:${kind}:${startLine}:${producer}`;
  // 16 hex chars is enough to avoid collisions at repository scale while keeping
  // ids short enough to read in the UI and in URLs.
  return `ev_${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/** Converts any repository path to POSIX separators, relative to the repository root. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
