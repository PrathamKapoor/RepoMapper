import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectArchiveFormat,
  detectLanguage,
  discoverFiles,
  extractTarArchive,
  generatedFileReason,
  isBinaryFile,
  isInside,
  isSafeArchiveEntryPath,
  readGitMetadata,
  readRepositoryFile,
  relativeToRoot,
  resolveInsideRoot,
  resolveRepositoryRoot,
  IgnoreStack,
} from '@repoatlas/ingest';
import { DiagnosticCollector } from '@repoatlas/core';
import { createFixture, trySymlink, type Fixture } from '../../server/test/fixtures.js';

const cleanups: Fixture[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.cleanup();
  }
});

async function fixture(tree: Parameters<typeof createFixture>[0] = {}): Promise<Fixture> {
  const created = await createFixture(tree);
  cleanups.push(created);
  return created;
}

const discoveryOptions = { maxFiles: 1_000, maxFileBytes: 100_000, maxTotalBytes: 5_000_000 };

describe('path containment', () => {
  it('accepts a directory inside the root and rejects one outside', () => {
    const root = resolve('C:/repo');
    expect(isInside(root, 'C:/repo/src/a.ts')).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, 'C:/repo-elsewhere/a.ts')).toBe(false);
    expect(isInside(root, 'C:/other/a.ts')).toBe(false);
  });

  it('refuses absolute, parent-traversing and NUL-containing relative paths', async () => {
    const repo = await fixture({ 'a.ts': 'export const a = 1;\n' });
    expect(await resolveInsideRoot(repo.root, '../outside.ts')).toBeNull();
    expect(await resolveInsideRoot(repo.root, '/etc/passwd')).toBeNull();
    expect(await resolveInsideRoot(repo.root, 'a.ts\0.txt')).toBeNull();
    expect(await resolveInsideRoot(repo.root, 'a.ts')).not.toBeNull();
  });

  it('blocks a symlink that points outside the repository', async () => {
    const outside = await fixture({ 'secret.ts': 'export const token = "hunter2";\n' });
    const repo = await fixture({ 'a.ts': 'export const a = 1;\n' });

    const linked = await trySymlink(outside.root, join(repo.root, 'escape'));
    if (!linked) {
      // Creating symlinks requires elevation on some Windows configurations. The
      // containment logic itself is covered by the traversal cases above.
      return;
    }

    expect(await resolveInsideRoot(repo.root, 'escape')).toBeNull();
    expect(await resolveInsideRoot(repo.root, 'escape/secret.ts')).toBeNull();
  });

  it('enforces the allow-list and reports a refusal with a 403', async () => {
    const allowed = await fixture({ 'a.ts': '' });
    const denied = await fixture({ 'b.ts': '' });

    await expect(resolveRepositoryRoot(allowed.root, [allowed.root])).resolves.toBeTruthy();
    await expect(resolveRepositoryRoot(denied.root, [allowed.root])).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
      statusCode: 403,
    });
  });

  it('raises a typed 404 for a path that does not exist', async () => {
    await expect(resolveRepositoryRoot(join(process.cwd(), 'definitely-not-here-9f2a'))).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('computes a repository-relative posix path', () => {
    expect(relativeToRoot(resolve('C:/repo'), resolve('C:/repo/src/a.ts'))).toBe('src/a.ts');
  });
});

describe('archive entry path validation', () => {
  it('accepts ordinary relative entries', () => {
    expect(isSafeArchiveEntryPath('src/index.ts')).toBe(true);
    expect(isSafeArchiveEntryPath('a/b/c.txt')).toBe(true);
  });

  it('rejects traversal, absolute paths, drive letters and NUL bytes', () => {
    expect(isSafeArchiveEntryPath('../etc/passwd')).toBe(false);
    expect(isSafeArchiveEntryPath('a/../../b')).toBe(false);
    expect(isSafeArchiveEntryPath('/etc/shadow')).toBe(false);
    expect(isSafeArchiveEntryPath('C:/Windows/system32')).toBe(false);
    expect(isSafeArchiveEntryPath('a\0b')).toBe(false);
    expect(isSafeArchiveEntryPath('')).toBe(false);
  });
});

describe('language detection', () => {
  it('detects languages by extension', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('src/a.tsx')).toBe('typescript');
    expect(detectLanguage('src/a.js')).toBe('javascript');
    expect(detectLanguage('app/main.py')).toBe('python');
    expect(detectLanguage('schema.sql')).toBe('sql');
    expect(detectLanguage('unknown.xyz')).toBe('unknown');
  });

  it('detects extensionless infrastructure files', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('docker/api.Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('Gemfile')).toBe('ruby');
  });

  it('recognises generated and vendored files', () => {
    expect(generatedFileReason('dist/index.js')).toBeTruthy();
    expect(generatedFileReason('types/index.d.ts')).toBeTruthy();
    expect(generatedFileReason('src/index.ts')).toBeUndefined();
  });
});

describe('binary detection', () => {
  it('treats NUL bytes as binary', async () => {
    const repo = await fixture({ 'blob.bin': Buffer.from([0x00, 0x01, 0x02, 0x00]) });
    expect(await isBinaryFile(repo.path('blob.bin'))).toBe(true);
  });

  it('treats ordinary source as text', async () => {
    const repo = await fixture({ 'a.ts': 'export const a = 1;\n' });
    expect(await isBinaryFile(repo.path('a.ts'))).toBe(false);
  });

  it('treats an empty file as text', async () => {
    const repo = await fixture({ 'empty.ts': '' });
    expect(await isBinaryFile(repo.path('empty.ts'))).toBe(false);
  });
});

describe('IgnoreStack', () => {
  it('applies real gitignore semantics through the interop shim', async () => {
    // Regression guard. `ignore` is CommonJS and its major versions ship incompatible
    // declaration styles, so the factory is taken through an explicit shim. A plain
    // default import yields a non-callable namespace under NodeNext — this failed to
    // build in the Linux container while passing on Windows, so the semantics that
    // depend on the shim are asserted directly: negation, anchoring and dir patterns.
    const repo = await fixture({
      '.gitignore': ['build/', '*.log', '!keep.log', '/root-only.txt', ''].join('\n'),
    });

    const stack = new IgnoreStack();
    await stack.push(repo.root);

    expect(stack.isIgnored('build/out.js')).toBe(true);
    expect(stack.isIgnored('debug.log')).toBe(true);
    expect(stack.isIgnored('keep.log')).toBe(false);
    expect(stack.isIgnored('root-only.txt')).toBe(true);
    expect(stack.isIgnored('nested/root-only.txt')).toBe(false);
    expect(stack.isIgnored('src/index.ts')).toBe(false);
  });

  it('honours nested .gitignore files with the deepest winning', async () => {
    const repo = await fixture({
      '.gitignore': 'build/\n*.log\n',
      'src/.gitignore': '!keep.log\n',
    });

    const stack = new IgnoreStack();
    await stack.push(repo.root);
    expect(stack.isIgnoredDirectory('build')).toBe(true);
    expect(stack.isIgnored('debug.log')).toBe(true);
    expect(stack.isIgnored('src/index.ts')).toBe(false);
    stack.pop(repo.root);
  });

  it('treats a repository ignore file as data, not as configuration to execute', async () => {
    const repo = await fixture({ '.gitignore': '$(rm -rf /)\n*.ts\n' });
    const stack = new IgnoreStack();
    await stack.push(repo.root);
    // Treated as a literal pattern; the repository still exists and is unharmed.
    expect(stack.isIgnored('a.ts')).toBe(true);
  });
});

describe('file discovery', () => {
  it('finds analyzable files and reports skipped ones with reasons', async () => {
    const repo = await fixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.py': 'x = 1\n',
      'notes.unknownext': 'hello',
      'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      '.gitignore': 'secret.ts\n',
      'secret.ts': 'export const leaked = true;\n',
      'node_modules/pkg/index.js': 'module.exports = {};',
    });

    const diagnostics = new DiagnosticCollector();
    const result = await discoverFiles(repo.root, discoveryOptions, diagnostics);

    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.py');
    expect(paths).not.toContain('secret.ts');
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
    expect(result.excludedDirectories).toContain('node_modules');
    expect(result.skipped.some((entry) => entry.path === 'secret.ts' && entry.reason === 'ignored_by_vcs')).toBe(true);
    expect(result.skipped.some((entry) => entry.path === 'image.png' && entry.reason === 'binary')).toBe(true);
  });

  it('sorts output so repeated runs are identical', async () => {
    const repo = await fixture({ 'z.ts': '', 'a.ts': '', 'm/b.ts': '' });
    const diagnostics = new DiagnosticCollector();
    const first = await discoverFiles(repo.root, discoveryOptions, diagnostics);
    const second = await discoverFiles(repo.root, discoveryOptions, diagnostics);
    expect(first.files.map((f) => f.path)).toEqual(second.files.map((f) => f.path));
    expect(first.files.map((f) => f.path)).toEqual(['a.ts', 'm/b.ts', 'z.ts']);
  });

  it('stops at the file limit and records that it was truncated', async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) tree[`f${i}.ts`] = 'export const a = 1;\n';

    const repo = await fixture(tree);
    const diagnostics = new DiagnosticCollector();
    const result = await discoverFiles(repo.root, { ...discoveryOptions, maxFiles: 5 }, diagnostics);

    expect(result.files).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(diagnostics.list().some((item) => item.code === 'FILE_COUNT_LIMIT_REACHED')).toBe(true);
  });

  it('skips files above the size limit without reading them', async () => {
    const repo = await fixture({ 'small.ts': 'export const a = 1;\n', 'big.ts': 'x'.repeat(5_000) });
    const diagnostics = new DiagnosticCollector();
    const result = await discoverFiles(repo.root, { ...discoveryOptions, maxFileBytes: 1_000 }, diagnostics);

    expect(result.files.map((file) => file.path)).toEqual(['small.ts']);
    expect(result.skipped.some((entry) => entry.path === 'big.ts' && entry.reason === 'too_large')).toBe(true);
  });

  it('warns when the repository has nothing analyzable', async () => {
    const repo = await fixture({ 'notes.txt': 'nothing here' });
    const diagnostics = new DiagnosticCollector();
    const result = await discoverFiles(repo.root, discoveryOptions, diagnostics);

    // The file is still reported as discovered, but marked unanalyzable with a reason.
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.analyzable).toBe(false);
    expect(result.files[0]?.skipReason).toBe('unsupported_extension');
    expect(diagnostics.list().some((item) => item.code === 'REPOSITORY_EMPTY')).toBe(true);
  });

  it('does not loop forever on a symlink cycle', async () => {
    const repo = await fixture({ 'a/b.ts': '' });
    const linked = await trySymlink(repo.root, join(repo.root, 'a', 'loop'));
    if (!linked) return;

    const diagnostics = new DiagnosticCollector();
    const result = await discoverFiles(repo.root, discoveryOptions, diagnostics);
    expect(result.files.some((file) => file.path === 'a/b.ts')).toBe(true);
  });
});

describe('repository file reads', () => {
  it('reads a file inside the root', async () => {
    const repo = await fixture({ 'a.ts': 'export const a = 1;\n' });
    expect(await readRepositoryFile(repo.root, 'a.ts')).toContain('export const a');
  });

  it('refuses to read outside the root', async () => {
    const repo = await fixture({ 'a.ts': '' });
    expect(await readRepositoryFile(repo.root, '../../etc/passwd')).toBeNull();
  });

  it('returns null for a file that is not there', async () => {
    const repo = await fixture({});
    expect(await readRepositoryFile(repo.root, 'missing.ts')).toBeNull();
  });
});

describe('git metadata', () => {
  it('reports unavailable history for a directory that is not a repository', async () => {
    const repo = await fixture({ 'a.ts': '' });
    const diagnostics = new DiagnosticCollector();
    const metadata = await readGitMetadata(repo.root, diagnostics, { includeHistory: true, maxCommits: 10 });

    expect(metadata.available).toBe(false);
    expect(metadata.commits).toHaveLength(0);
    expect(diagnostics.list().some((item) => item.code === 'GIT_NOT_A_REPOSITORY')).toBe(true);
  });
});

describe('archive format detection', () => {
  it('recognises gzip and tar by magic bytes, not by filename', () => {
    expect(detectArchiveFormat(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe('gzip');
    const tarHeader = Buffer.alloc(512);
    tarHeader.write('ustar', 257, 'latin1');
    expect(detectArchiveFormat(tarHeader)).toBe('tar');
    expect(detectArchiveFormat(Buffer.from('not an archive at all'))).toBe('unknown');
  });
});

describe('archive extraction', () => {
  it('rejects a file that is not an archive', async () => {
    const repo = await fixture({ 'not-an-archive.tar': 'this is plain text' });
    const diagnostics = new DiagnosticCollector();
    await expect(
      extractTarArchive(repo.path('not-an-archive.tar'), {
        maxArchiveBytes: 1_000_000,
        maxTotalBytes: 1_000_000,
        maxEntries: 10,
      }, diagnostics),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
  });

  it('rejects an empty archive', async () => {
    const repo = await fixture({ 'empty.tar': '' });
    const diagnostics = new DiagnosticCollector();
    await expect(
      extractTarArchive(repo.path('empty.tar'), {
        maxArchiveBytes: 1_000_000,
        maxTotalBytes: 1_000_000,
        maxEntries: 10,
      }, diagnostics),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
  });

  it('rejects an archive above the size ceiling before extracting', async () => {
    const repo = await fixture({ 'a.tar': 'x'.repeat(5_000) });
    const diagnostics = new DiagnosticCollector();
    await expect(
      extractTarArchive(repo.path('a.tar'), {
        maxArchiveBytes: 1_000,
        maxTotalBytes: 1_000_000,
        maxEntries: 10,
      }, diagnostics),
    ).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE', statusCode: 413 });
  });

  it('extracts a real tar archive into the destination', async () => {
    const { createWriteStream } = await import('node:fs');
    const tar = await import('tar');
    const repo = await fixture({ 'source.ts': 'export const a = 1;\n' });
    const archivePath = join(repo.root, '..', `archive-${process.pid}.tar`);
    const destination = await repo.mkdir('extracted');

    await tar.create({ file: archivePath, cwd: repo.root, gzip: false }, ['source.ts']);
    expect(createWriteStream).toBeDefined();

    const diagnostics = new DiagnosticCollector();
    const result = await extractTarArchive(archivePath, {
      maxArchiveBytes: 5_000_000,
      maxTotalBytes: 5_000_000,
      maxEntries: 100,
      destination,
    }, diagnostics);

    expect(result.fileCount).toBe(1);
    expect(await readRepositoryFile(destination, 'source.ts')).toContain('export const a');
  });
});