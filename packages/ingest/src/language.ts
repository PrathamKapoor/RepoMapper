import { extname } from 'node:path';

/**
 * Language detection and default ignore rules.
 *
 * Detection is by file extension only — deliberately. Content sniffing on
 * untrusted files produces surprising results (a shell script with a `.md`
 * extension, a minified bundle with a `.js` extension) and would make the analysis
 * non-deterministic.
 */

export interface LanguageDefinition {
  id: string;
  extensions: string[];
  /** Ecosystem label used for grouping in the UI. */
  ecosystem: string;
}

export const LANGUAGES: readonly LanguageDefinition[] = [
  { id: 'typescript', extensions: ['.ts', '.mts', '.cts', '.tsx'], ecosystem: 'javascript' },
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], ecosystem: 'javascript' },
  { id: 'python', extensions: ['.py', '.pyi'], ecosystem: 'python' },
  { id: 'go', extensions: ['.go'], ecosystem: 'go' },
  { id: 'java', extensions: ['.java'], ecosystem: 'jvm' },
  { id: 'csharp', extensions: ['.cs'], ecosystem: 'dotnet' },
  { id: 'ruby', extensions: ['.rb'], ecosystem: 'ruby' },
  { id: 'php', extensions: ['.php'], ecosystem: 'php' },
  { id: 'rust', extensions: ['.rs'], ecosystem: 'rust' },
  { id: 'sql', extensions: ['.sql'], ecosystem: 'data' },
  { id: 'yaml', extensions: ['.yml', '.yaml'], ecosystem: 'config' },
  { id: 'json', extensions: ['.json', '.jsonc'], ecosystem: 'config' },
  { id: 'toml', extensions: ['.toml'], ecosystem: 'config' },
  { id: 'markdown', extensions: ['.md', '.markdown', '.mdx'], ecosystem: 'docs' },
  { id: 'dockerfile', extensions: ['.dockerfile'], ecosystem: 'infra' },
  { id: 'graphql', extensions: ['.graphql', '.gql'], ecosystem: 'api' },
  { id: 'proto', extensions: ['.proto'], ecosystem: 'api' },
  { id: 'shell', extensions: ['.sh', '.bash'], ecosystem: 'infra' },
];

const EXTENSION_TO_LANGUAGE = new Map<string, string>();
for (const language of LANGUAGES) {
  for (const ext of language.extensions) {
    if (!EXTENSION_TO_LANGUAGE.has(ext)) EXTENSION_TO_LANGUAGE.set(ext, language.id);
  }
}

/** Filenames that carry language information without a useful extension. */
const FILENAME_TO_LANGUAGE = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gemfile', 'ruby'],
  ['rakefile', 'ruby'],
]);

/** Returns the language id for a repository-relative path, or `unknown`. */
export function detectLanguage(relativePath: string): string {
  const basename = (relativePath.split('/').pop() ?? '').toLowerCase();
  const byName = FILENAME_TO_LANGUAGE.get(basename);
  if (byName) return byName;

  // `Dockerfile.dev`, `app.dockerfile`
  if (basename.startsWith('dockerfile') || basename.endsWith('.dockerfile')) return 'dockerfile';

  const ext = extname(basename).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(ext) ?? 'unknown';
}

export function isKnownExtension(relativePath: string): boolean {
  return detectLanguage(relativePath) !== 'unknown';
}

/**
 * Directories excluded before walking.
 *
 * These hold vendored code, build output or VCS internals. Excluding them by name
 * is both a performance measure and an accuracy one: analysing `node_modules` would
 * bury the repository's own structure under thousands of third-party packages.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.gradle',
  '.idea',
  '.vscode-test',
  'coverage',
  'htmlcov',
  '.nyc_output',
  '.terraform',
  'Pods',
  'DerivedData',
  'site-packages',
  '.serverless',
  '.aws-sam',
];

/** File patterns excluded regardless of location. */
export const DEFAULT_EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.snap$/,
  /\.snap\.new$/,
  /\.pyc$/,
  /\.pyo$/,
  /\.o$/,
  /\.obj$/,
  /\.class$/,
  /\.jar$/,
  /\.wasm$/,
  /\.exe$/,
  /\.dll$/,
  /\.so$/,
  /\.dylib$/,
  /\.zip$/,
  /\.tar$/,
  /\.tgz$/,
  /\.gz$/,
  /\.rar$/,
  /\.7z$/,
  /\.pdf$/,
  /\.png$/,
  /\.jpe?g$/,
  /\.gif$/,
  /\.webp$/,
  /\.ico$/,
  /\.mp[34]$/,
  /\.mov$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
  /\.mp3$/,
  /\.wav$/,
  /\.sqlite3?$/,
  /\.db$/,
];

/** Heuristic detection of generated or vendored files that should not become graph entities. */
const GENERATED_MARKERS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)(dist|build|out|lib-esm|esm|cjs)\//, reason: 'build output directory' },
  { pattern: /\.d\.ts$/, reason: 'declaration file' },
  { pattern: /\.generated\.[a-z]+$/, reason: 'generated file suffix' },
  { pattern: /(^|\/)generated\//, reason: 'generated directory' },
  { pattern: /_pb2\.py$/, reason: 'protobuf output' },
  { pattern: /\.pb\.go$/, reason: 'protobuf output' },
  { pattern: /\.g\.dart$/, reason: 'generated dart output' },
  { pattern: /(^|\/)__generated__\//, reason: 'generated directory' },
];

export function generatedFileReason(relativePath: string): string | undefined {
  return GENERATED_MARKERS.find((marker) => marker.pattern.test(relativePath))?.reason;
}
