import { open } from 'node:fs/promises';

/**
 * Binary detection.
 *
 * A repository legitimately contains images, archives, fonts and compiled
 * artefacts. We never read them as text: a NUL byte in the first block, or a high
 * proportion of non-printable bytes, marks the file binary and it is recorded as
 * skipped with a reason instead of being parsed.
 */

const SNIFF_BYTES = 8_192;

/** Extensions we treat as binary without opening the file. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war', '.wasm', '.pyc', '.pyo',
  '.o', '.obj', '.a', '.lib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.avi', '.mov', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

export function hasBinaryExtension(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Reads at most `SNIFF_BYTES` from the file and decides whether it is binary.
 * Returns `true` for binary, `false` for text, and `true` when the file cannot be
 * read (safer to skip than to parse garbage).
 */
export async function isBinaryFile(absolutePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absolutePath, 'r');
  } catch {
    return true;
  }
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    if (bytesRead === 0) return false;

    const slice = buffer.subarray(0, bytesRead);

    // A NUL byte is the classic binary marker and is decisive.
    if (slice.includes(0)) return true;

    // Heuristic for files with a long run of high bytes and no control characters.
    let suspicious = 0;
    for (const byte of slice) {
      const isPrintable =
        (byte >= 0x20 && byte <= 0x7e) ||
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0d ||
        byte === 0x0c ||
        byte === 0x1b; // ANSI escape, common in logs
      if (!isPrintable) suspicious += 1;
    }
    return suspicious / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}
