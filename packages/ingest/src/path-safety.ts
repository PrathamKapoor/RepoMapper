import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AnalysisError, toPosixPath } from '@repoatlas/core';

/**
 * Path containment.
 *
 * Repositories are untrusted input and a repository can contain symlinks that point
 * anywhere on the host filesystem. Every filesystem access in RepoAtlas goes
 * through this module: we resolve the real path first (following symlinks), then
 * assert it is still inside the repository root. Comparisons happen on the resolved
 * paths, never on the user-supplied string.
 */

/** True when `candidate` is `root` itself or lives underneath it. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  // `relative` yields `..` when candidate is outside; on Windows it can also yield
  // an absolute path when the two are on different drives.
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}

/**
 * Resolves a real (symlink-free) absolute path, following symlinks on every
 * intermediate segment. Throws a typed error when the path does not exist.
 */
export async function resolveRealPath(inputPath: string): Promise<string> {
  const absolute = resolve(inputPath);
  try {
    return await realpath(absolute);
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new AnalysisError('PATH_NOT_FOUND', `Path does not exist: ${inputPath}`, 404, { cause });
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new AnalysisError('PERMISSION_DENIED', `Permission denied reading path: ${inputPath}`, 403, { cause });
    }
    throw new AnalysisError('PATH_NOT_FOUND', `Cannot resolve path: ${inputPath}`, 400, { cause });
  }
}

/**
 * Resolves a repository root and asserts it is inside the configured allow-list.
 *
 * `allowedRoots` is an explicit operator-controlled boundary. When it is empty the
 * check is skipped and the operator's filesystem permissions are the only boundary
 * — this is documented in deployment.md and surfaced in the server health payload.
 */
export async function resolveRepositoryRoot(
  inputPath: string,
  allowedRoots: readonly string[] = [],
): Promise<string> {
  const real = await resolveRealPath(inputPath);

  if (allowedRoots.length === 0) {
    return real;
  }

  const normalisedAllowList = allowedRoots.map((root) => resolve(root));
  const permitted = normalisedAllowList.some((root) => isInside(root, real));
  if (!permitted) {
    throw new AnalysisError(
      'PATH_NOT_ALLOWED',
      `Repository path is outside the configured allow-list: ${toPosixPath(real)}`,
      403,
    );
  }
  return real;
}

/**
 * Resolves a repository-relative path to an absolute path, refusing anything that
 * escapes the root (including via `..`, absolute paths, or symlink targets).
 *
 * Returns `null` when the path escapes — callers record a diagnostic instead of
 * reading the file.
 */
export async function resolveInsideRoot(
  root: string,
  relativePath: string,
  knownRealRoot = root,
): Promise<string | null> {
  if (relativePath.includes('\0')) return null;

  const posix = toPosixPath(relativePath);
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) return null;

  const candidate = resolve(knownRealRoot, ...posix.split('/'));
  if (!isInside(knownRealRoot, candidate)) return null;

  // Follow symlinks and re-check: a link inside the repo may point outside it.
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    // Non-existent paths are legitimate during discovery (race with deletion);
    // lexical containment above is sufficient for those.
    return candidate;
  }

  if (!isInside(knownRealRoot, real)) return null;
  return real;
}

/** Repository-relative POSIX path for an absolute path inside `root`. */
export function relativeToRoot(root: string, absolutePath: string): string {
  return toPosixPath(relative(root, absolutePath));
}

/**
 * Rejects archive entry paths that would escape an extraction directory.
 * Used for uploaded archives, which are the most common path-traversal vector.
 */
export function isSafeArchiveEntryPath(entryPath: string): boolean {
  if (entryPath.length === 0) return false;
  if (entryPath.includes('\0')) return false;
  const normalised = toPosixPath(entryPath);
  if (normalised.startsWith('/')) return false;
  if (/^[A-Za-z]:\//.test(normalised)) return false;
  const segments = normalised.split('/');
  if (segments.includes('..')) return false;
  return true;
}

/** True when the host path separator is a backslash (used in test assertions). */
export function isWindowsHost(): boolean {
  return sep === '\\';
}
