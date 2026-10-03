import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CommitRecord, DiagnosticCollector, GitMetadata } from '@repoatlas/core';
import { resolveInsideRoot } from './path-safety.js';

const execFileAsync = promisify(execFile);

/**
 * Read-only Git metadata.
 *
 * Security posture: we never run a command found inside a repository. Every call
 * uses `execFile` with a fixed argv (no shell), a fixed timeout, a scrubbed
 * environment and `cwd` pinned inside the repository. Git config in the repository
 * is neutralised with `-c` overrides so a malicious `.git/config` cannot alias
 * commands, add hooks or redirect `core.pager` at us.
 */

const EMPTY: GitMetadata = {
  available: false,
  headCommit: null,
  branch: null,
  trackedFiles: [],
  commits: [],
  contributorCount: 0,
};

/** Config overrides applied to every invocation to neutralise repository-provided config. */
const HARDENING_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'pager.log=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'credential.helper=',
  '-c',
  'diff.external=',
  '-c',
  'diff.pager=',
  '-c',
  'log.showSignature=false',
  '-c',
  'i18n.logOutputEncoding=UTF-8',
];

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 32 * 1024 * 1024;

async function runGit(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...HARDENING_ARGS, ...args], {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        // Force a stable, non-interactive, non-localising git.
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PAGER: 'cat',
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
        LANG: 'C',
        LC_ALL: 'C',
      },
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Cheap check for a `.git` directory or file (worktrees use a file). */
export async function looksLikeGitRepository(root: string): Promise<boolean> {
  try {
    await access(join(root, '.git'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects git metadata for a repository.
 *
 * Never throws: a missing git binary, a non-repository, or a corrupt object store
 * all yield `available: false` plus a diagnostic, so analysis proceeds without
 * history rather than failing.
 */
export async function readGitMetadata(
  root: string,
  diagnostics: DiagnosticCollector,
  options: { includeHistory: boolean; maxCommits: number },
): Promise<GitMetadata> {
  if (!(await looksLikeGitRepository(root))) {
    diagnostics.info('GIT_NOT_A_REPOSITORY', 'Directory has no .git; continuing without history');
    return EMPTY;
  }

  const headOut = await runGit(['rev-parse', 'HEAD'], root);
  if (headOut === null) {
    diagnostics.info('GIT_UNAVAILABLE', 'git binary unavailable or repository unreadable; continuing without history');
    return EMPTY;
  }
  const headCommit = headOut.trim().split('\n')[0] ?? null;

  const branchOut = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const branch = branchOut?.trim() ?? null;

  const trackedOut = await runGit(['ls-files', '-z'], root);
  const trackedFiles = trackedOut ? trackedOut.split('\0').filter((entry) => entry.length > 0) : [];

  let commits: CommitRecord[] = [];
  if (options.includeHistory) {
    commits = await readCommits(root, diagnostics, options.maxCommits);
  }

  const contributors = new Set(commits.map((commit) => commit.authorEmail.toLowerCase()));

  return {
    available: true,
    headCommit,
    branch: branch === 'HEAD' ? null : branch,
    trackedFiles,
    commits,
    contributorCount: contributors.size,
  };
}

/**
 * Reads commit history in a single pass using a field-delimited format.
 *
 * A custom `%x00`-delimited format is used instead of parsing human-readable output:
 * author names contain arbitrary characters including newlines and the separators
 * we choose, so a stable machine format avoids mis-parsing real repositories.
 */
async function readCommits(
  root: string,
  diagnostics: DiagnosticCollector,
  maxCommits: number,
): Promise<CommitRecord[]> {
  // Field and record separators are control characters: unambiguous in git output
  // and impossible to confuse with commit subject text.
  const RECORD = '';
  const FIELD = '';

  const format = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join(FIELD) + RECORD;

  // Args use string concatenation rather than template literals: an array literal
  // containing several template literals in this shape failed to parse under the
  // pinned TypeScript version, and this form is equally readable.
  const args: string[] = [
    'log',
    '--max-count=' + Math.max(1, maxCommits),
    '--no-merges',
    '--name-only',
    '--no-renames',
    '--pretty=format:' + format,
  ];

  const out = await runGit(args, root);
  if (out === null) {
    diagnostics.info('GIT_UNAVAILABLE', 'Unable to read git history; continuing without commits');
    return [];
  }

  const commits: CommitRecord[] = [];
  for (const rawRecord of out.split(RECORD)) {
    const record = rawRecord.replace(/^[\r\n]+/, '');
    if (record.trim().length === 0) continue;

    const newlineIndex = record.indexOf('\n');
    const header = newlineIndex === -1 ? record : record.slice(0, newlineIndex);
    const body = newlineIndex === -1 ? '' : record.slice(newlineIndex + 1);

    const fields = header.split(FIELD);
    const hash = fields[0];
    const shortHash = fields[1];
    if (!hash || !shortHash) continue;

    commits.push({
      hash,
      shortHash,
      authorName: fields[2] ?? 'unknown',
      authorEmail: fields[3] ?? 'unknown',
      timestamp: fields[4] ?? '',
      subject: fields[5] ?? '',
      files: body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    });
  }
  return commits;
}

/** Best-effort `git blame` line ownership for a single file, used by ownership maps. */
export async function readFileOwnership(
  root: string,
  relativePath: string,
  diagnostics: DiagnosticCollector,
): Promise<Map<number, { authorEmail: string; commitHash: string }>> {
  const absolute = await resolveInsideRoot(root, relativePath);
  if (absolute === null) return new Map();

  const out = await runGit(['blame', '--line-porcelain', '--', relativePath], root);
  if (out === null) {
    diagnostics.info('GIT_UNAVAILABLE', `Unable to read blame for ${relativePath}`);
    return new Map();
  }

  const result = new Map<number, { authorEmail: string; commitHash: string }>();
  let line = 0;
  let authorEmail = 'unknown';
  let commitHash = '';
  for (const raw of out.split('\n')) {
    const header = raw.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
    if (header?.[1] && header[2]) {
      line = Number.parseInt(header[2], 10);
      commitHash = header[1];
      authorEmail = 'unknown';
      continue;
    }
    if (raw.startsWith('author-mail ')) {
      authorEmail = raw.slice('author-mail '.length).replace(/^<|>$/g, '');
      continue;
    }
    // Porcelain emits the source line last for each block; commit the record there.
    if (line > 0 && raw.startsWith('\t')) {
      result.set(line, { authorEmail, commitHash });
    }
  }
  return result;
}
