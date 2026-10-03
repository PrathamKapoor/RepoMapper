import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import * as tar from 'tar';
import { AnalysisError, type DiagnosticCollector } from '@repoatlas/core';
import { isSafeArchiveEntryPath } from './path-safety.js';

/**
 * Archive ingestion.
 *
 * Uploaded archives are the highest-risk input RepoAtlas handles: a single crafted
 * tarball can write outside the extraction directory, exhaust disk, or fill the
 * inode table. The defences applied here are layered:
 *
 *  1. a compressed-size ceiling, checked before extraction starts;
 *  2. a declared-size ceiling enforced per entry while streaming;
 *  3. an entry-count ceiling that aborts mid-stream;
 *  4. per-entry path validation rejecting absolute paths, `..` and NUL bytes;
 *  5. `preservePaths: false` and `strict: true` so node-tar itself refuses traversal;
 *  6. no device, FIFO or hardlink entries — only regular files and directories.
 *
 * Extraction happens in a fresh temporary directory which is removed afterwards,
 * so a failed or hostile archive leaves nothing behind.
 */

export interface ArchiveExtractionOptions {
  /** Maximum size of the compressed archive in bytes. */
  maxArchiveBytes: number;
  /** Maximum total uncompressed bytes written. */
  maxTotalBytes: number;
  /** Maximum number of entries (files + directories) accepted. */
  maxEntries: number;
  /** Maximum nesting depth of archive paths. */
  maxDepth?: number;
  /** Directory the archive is extracted into. A temp directory when omitted. */
  destination?: string;
}

export interface ArchiveExtractionResult {
  destination: string;
  /** True when the caller supplied `destination` and it was left in place. */
  callerOwned: boolean;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  /** Entries skipped or that triggered a diagnostic. */
  rejected: { path: string; reason: string }[];
}

const DEFAULT_ARCHIVE_OPTIONS: Required<Omit<ArchiveExtractionOptions, 'destination'>> = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxDepth: 64,
};

/** Detects the archive format from magic bytes rather than the filename. */
export function detectArchiveFormat(header: Buffer): 'tar' | 'gzip' | 'zip' | 'unknown' {
  if (header.length >= 3 && header[0] === 0x1f && header[1] === 0x8b && header[2] === 0x08) return 'gzip';
  if (header.length >= 262 && header.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  if (header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b) {
    const third = header[2];
    const fourth = header[3];
    // PK\x03\x04 (local file header) or PK\x05\x06 (end of central directory)
    if ((third === 0x03 && fourth === 0x04) || (third === 0x05 && fourth === 0x06) || (third === 0x07 && fourth === 0x08)) {
      return 'zip';
    }
  }
  return 'unknown';
}

/** Raises the appropriate typed error for a detected format. */
export function assertSupportedArchiveFormat(format: string): void {
  if (format === 'tar' || format === 'gzip') return;
  if (format === 'zip') {
    throw new AnalysisError(
      'ARCHIVE_INVALID',
      'ZIP archives are not supported in this phase. Provide a .tar or .tar.gz archive.',
      415,
    );
  }
  throw new AnalysisError('ARCHIVE_INVALID', 'Upload is not a recognised tar or gzip archive', 415);
}

/**
 * Extracts a tar (optionally gzipped) archive into a bounded directory.
 *
 * Throws `AnalysisError` for hostile or malformed archives. Individual entries that
 * are merely suspicious (depth, type) are recorded in `rejected` and skipped, which
 * lets a mostly-valid archive still be analysed.
 */
export async function extractTarArchive(
  archivePath: string,
  options: ArchiveExtractionOptions,
  diagnostics: DiagnosticCollector,
): Promise<ArchiveExtractionResult> {
  const resolved: Required<Omit<ArchiveExtractionOptions, 'destination'>> = {
    ...DEFAULT_ARCHIVE_OPTIONS,
    ...stripUndefined(options),
  };

  let archiveSize: number;
  try {
    archiveSize = (await stat(archivePath)).size;
  } catch (cause) {
    throw new AnalysisError('ARCHIVE_INVALID', 'Archive could not be read', 400, { cause });
  }
  if (archiveSize > resolved.maxArchiveBytes) {
    throw new AnalysisError(
      'ARCHIVE_TOO_LARGE',
      `Archive is ${archiveSize} bytes, exceeding the ${resolved.maxArchiveBytes} byte limit`,
      413,
    );
  }
  if (archiveSize === 0) {
    throw new AnalysisError('ARCHIVE_INVALID', 'Archive is empty', 400);
  }

  const destination = options.destination ?? (await mkdtemp(join(tmpdir(), 'repoatlas-extract-')));
  const callerOwned = options.destination !== undefined;
  await mkdir(destination, { recursive: true });

  const rejected: ArchiveExtractionResult['rejected'] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  try {
    await tar.extract({
      file: archivePath,
      cwd: destination,
      // node-tar's own traversal defences, kept on even though we validate above.
      preservePaths: false,
      preserveOwner: false,
      strict: true,
      noMtime: true,
      // `tar` performs gzip transparently when the file is gzip-compressed.
      gzip: true,
      unlink: true,
      filter: (entryPath: string, entry: unknown) => {
        const readEntry = entry as { type?: string; size?: number };
        if (!isSafeArchiveEntryPath(entryPath)) {
          rejected.push({ path: entryPath, reason: 'unsafe entry path' });
          diagnostics.error('ARCHIVE_ENTRY_UNSAFE', `Rejected archive entry with unsafe path: ${entryPath}`);
          return false;
        }

        const depth = entryPath.split('/').filter((segment) => segment.length > 0).length;
        if (depth > resolved.maxDepth) {
          rejected.push({ path: entryPath, reason: `depth ${depth} exceeds ${resolved.maxDepth}` });
          return false;
        }

        const type = readEntry.type ?? 'File';
        if (type !== 'File' && type !== 'Directory' && type !== 'OldFile' && type !== 'ContiguousFile') {
          // Devices, FIFOs, links and GNUTarSparse variants have no place in a
          // source repository and are classic privilege-escalation payloads.
          rejected.push({ path: entryPath, reason: `unsupported entry type ${type}` });
          diagnostics.warn('ARCHIVE_ENTRY_UNSAFE', `Skipped archive entry of unsupported type ${type}: ${entryPath}`);
          return false;
        }

        if (type === 'Directory') {
          directoryCount += 1;
        } else {
          fileCount += 1;
          totalBytes += Number(readEntry.size ?? 0);
        }

        if (fileCount + directoryCount > resolved.maxEntries) {
          throw new AnalysisError(
            'ARCHIVE_ENTRY_COUNT_EXCEEDED',
            `Archive contains more than ${resolved.maxEntries} entries`,
            413,
          );
        }
        if (totalBytes > resolved.maxTotalBytes) {
          throw new AnalysisError(
            'ARCHIVE_TOO_LARGE',
            `Uncompressed archive exceeds the ${resolved.maxTotalBytes} byte limit`,
            413,
          );
        }

        return true;
      },
    });
  } catch (cause) {
    if (!callerOwned) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    }
    if (cause instanceof AnalysisError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new AnalysisError('ARCHIVE_INVALID', `Archive extraction failed: ${message}`, 400, { cause });
  }

  if (fileCount === 0 && directoryCount === 0) {
    if (!callerOwned) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new AnalysisError('ARCHIVE_INVALID', 'Archive contained no usable entries', 400);
  }

  return { destination, callerOwned, fileCount, directoryCount, totalBytes, rejected };
}

/** Convenience wrapper used by the API: extracts to a temp dir and removes it afterwards. */
export async function withExtractedArchive<T>(
  archivePath: string,
  options: ArchiveExtractionOptions,
  diagnostics: DiagnosticCollector,
  use: (extractedPath: string) => Promise<T>,
): Promise<{ value: T; result: ArchiveExtractionResult }> {
  const result = await extractTarArchive(archivePath, options, diagnostics);
  try {
    const value = await use(result.destination);
    return { value, result };
  } finally {
    if (!result.callerOwned) {
      await rm(result.destination, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Streams the first bytes of a file for format sniffing. */
export async function readHeaderBytes(path: string, count: number): Promise<Buffer> {
  const stream = createReadStream(path, { start: 0, end: count - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
