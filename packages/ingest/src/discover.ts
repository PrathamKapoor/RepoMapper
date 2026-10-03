import { opendir, realpath, stat } from 'node:fs/promises';

import {
  type DiagnosticCollector,
  type DiscoveredFile,
  type IngestResult,
  toPosixPath,
} from '@repoatlas/core';
import { hasBinaryExtension, isBinaryFile } from './binary.js';
import { IgnoreStack } from './ignore-stack.js';
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  DEFAULT_EXCLUDED_FILE_PATTERNS,
  detectLanguage,
  isKnownExtension,
} from './language.js';
import { isInside, relativeToRoot, resolveInsideRoot } from './path-safety.js';

export interface DiscoveryOptions {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Excluded directory basenames. Replaces the defaults when provided. */
  excludedDirectories?: readonly string[];
  /** Additional excluded path patterns applied on top of the defaults. */
  extraExcludePatterns?: readonly RegExp[];
  /** Honour `.gitignore` files. Disable to analyse ignored files too. */
  respectGitignore?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<DiscoveryOptions, 'excludedDirectories' | 'extraExcludePatterns'>> = {
  maxFiles: 20_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 512_000_000,
  respectGitignore: true,
};

/**
 * Walks a repository and produces the bounded, deterministic file list the rest of
 * the pipeline analyses.
 *
 * Guarantees:
 *  - output is sorted, so two runs over the same tree produce identical input;
 *  - every reported path is inside the repository root (symlinks included);
 *  - limits stop the walk and are recorded, never silently applied;
 *  - binary and oversized files are reported with a reason instead of being read.
 */
export async function discoverFiles(
  root: string,
  options: DiscoveryOptions,
  diagnostics: DiagnosticCollector,
): Promise<{ files: DiscoveredFile[]; skipped: IngestResult['skipped']; excludedDirectories: string[]; truncated: boolean }> {
  const resolved: Required<Omit<DiscoveryOptions, 'excludedDirectories' | 'extraExcludePatterns'>> = {
    ...DEFAULT_OPTIONS,
    ...stripUndefined(options),
  };
  const excludedDirs = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const extraPatterns = options.extraExcludePatterns ?? [];
  const excludePatterns = [...DEFAULT_EXCLUDED_FILE_PATTERNS, ...extraPatterns];

  const ignoreStack = new IgnoreStack();
  const files: DiscoveredFile[] = [];
  const skipped: IngestResult['skipped'] = [];
  const excludedDirectories: string[] = [];
  const visitedRealDirs = new Set<string>();

  let totalBytes = 0;
  let truncated = false;

  const walk = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > 64) {
      diagnostics.warn('FILE_UNREADABLE', `Directory nesting deeper than 64 levels at ${dirRel || '.'}`, {
        path: dirRel || '.',
      });
      return;
    }

    if (resolved.respectGitignore) {
      await ignoreStack.push(dirAbs);
    }

    try {
      // Guard against symlink cycles by tracking resolved directory identity.
      const realDir = await realpath(dirAbs);
      if (visitedRealDirs.has(realDir)) {
        ignoreStack.pop(dirAbs);
        return;
      }
      visitedRealDirs.add(realDir);

      const dir = await opendir(dirAbs);
      const entries: { name: string; isDir: boolean; isFile: boolean; isSymlink: boolean }[] = [];
      for await (const entry of dir) {
        entries.push({
          name: entry.name,
          isDir: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymlink: entry.isSymbolicLink(),
        });
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (truncated) break;
        const childRel = toPosixPath(dirRel === '' ? entry.name : `${dirRel}/${entry.name}`);

        // Resolve through the root so symlinks can never widen the analysed tree.
        const safeAbs = await resolveInsideRoot(root, childRel);
        if (safeAbs === null) {
          skipped.push({ path: childRel, reason: 'symlink_escape' });
          continue;
        }

        const isDirectory = entry.isDir || (entry.isSymlink && (await statIsDirectory(safeAbs)));
        const isRegularFile = !isDirectory && (entry.isFile || entry.isSymlink);

        if (isDirectory) {
          if (excludedDirs.has(entry.name)) {
            excludedDirectories.push(childRel);
            continue;
          }
          if (resolved.respectGitignore && ignoreStack.isIgnoredDirectory(childRel)) continue;
          if (excludePatterns.some((pattern) => pattern.test(childRel))) continue;
          await walk(safeAbs, childRel, depth + 1);
          continue;
        }

        if (!isRegularFile) {
          skipped.push({ path: childRel, reason: 'unreadable' });
          continue;
        }

        if (resolved.respectGitignore && ignoreStack.isIgnored(childRel)) {
          skipped.push({ path: childRel, reason: 'ignored_by_vcs' });
          continue;
        }
        // Binary classification is checked before the generic pattern filter so the
        // reported reason is the informative one (`binary`) rather than the generic
        // `ignored_by_default`, and so the content sniff below is not repeated.
        const binaryByExtension = hasBinaryExtension(childRel);
        if (!binaryByExtension && excludePatterns.some((pattern) => pattern.test(childRel))) {
          skipped.push({ path: childRel, reason: 'ignored_by_default' });
          continue;
        }

        let size: number;
        try {
          const info = await stat(safeAbs);
          if (!info.isFile()) {
            skipped.push({ path: childRel, reason: 'unreadable' });
            continue;
          }
          size = info.size;
        } catch {
          skipped.push({ path: childRel, reason: 'unreadable' });
          continue;
        }

        if (size > resolved.maxFileBytes) {
          skipped.push({ path: childRel, reason: 'too_large', byteSize: size });
          continue;
        }
        if (files.length >= resolved.maxFiles) {
          truncated = true;
          diagnostics.warn('FILE_COUNT_LIMIT_REACHED', `Stopped after ${resolved.maxFiles} files`, {
            detail: { maxFiles: resolved.maxFiles },
          });
          break;
        }
        if (totalBytes + size > resolved.maxTotalBytes) {
          truncated = true;
          diagnostics.warn('TOTAL_BYTES_LIMIT_REACHED', `Stopped at ${totalBytes} bytes of source`, {
            detail: { maxTotalBytes: resolved.maxTotalBytes },
          });
          break;
        }
        totalBytes += size;

        const language = detectLanguage(childRel);
        const known = isKnownExtension(childRel);

        // Binary classification comes first: an image or font is unanalyzable because of what
        // it *is*, which is more useful to report than "unsupported extension".
        if (binaryByExtension || (await isBinaryFile(safeAbs))) {
          skipped.push({ path: childRel, reason: 'binary', byteSize: size });
          files.push({ path: childRel, byteSize: size, language, analyzable: false, skipReason: 'binary' });
          continue;
        }

        if (!known) {
          skipped.push({ path: childRel, reason: 'unsupported_extension', byteSize: size });
          files.push({ path: childRel, byteSize: size, language, analyzable: false, skipReason: 'unsupported_extension' });
          continue;
        }

        files.push({ path: childRel, byteSize: size, language, analyzable: true });
      }
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      diagnostics.warn('FILE_UNREADABLE', `Cannot read directory ${dirRel || '.'}: ${err.code ?? 'unknown'}`, {
        path: dirRel || '.',
      });
    } finally {
      if (resolved.respectGitignore) {
        ignoreStack.pop(dirAbs);
      }
    }
  };

  await walk(root, '', 0);

  // A directory can be reachable both directly and via a symlink; keep the first.
  const seen = new Set<string>();
  const deduped: DiscoveredFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    deduped.push(file);
  }

  deduped.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  // "Empty" means nothing *analyzable*, not nothing discovered. A repository holding
  // only .txt files is discovered but yields no entities, and must say so.
  if (!deduped.some((file) => file.analyzable)) {
    diagnostics.warn(
      'REPOSITORY_EMPTY',
      `No analyzable files found. ${deduped.length} file(s) were discovered but none use a supported language or passed the limits.`,
      { detail: { discovered: deduped.length, analyzable: 0 } },
    );
  }

  return {
    files: deduped,
    skipped,
    excludedDirectories: [...new Set(excludedDirectories)].sort(),
    truncated,
  };
}

/** Reads a repository-relative file as UTF-8, refusing to escape the root. */
export async function readRepositoryFile(root: string, relativePath: string): Promise<string | null> {
  const absolute = await resolveInsideRoot(root, relativePath);
  if (absolute === null) return null;
  if (!isInside(root, absolute)) return null;
  try {
    return await readFileSafe(absolute);
  } catch {
    return null;
  }
}

async function readFileSafe(absolutePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(absolutePath, 'utf8');
}

async function statIsDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export { relativeToRoot };
