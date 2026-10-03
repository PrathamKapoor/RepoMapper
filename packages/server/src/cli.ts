import { AnalysisError } from '@repoatlas/core';
import { runAnalysis } from './analyze.js';
import { loadConfig } from './config.js';

/**
 * Command-line analysis.
 *
 * Exists so the analysis pipeline is usable without the HTTP layer: in CI, in a
 * pre-merge check, or on a machine with no browser. It prints a summary and, with
 * `--json`, the full graph, using the same code path as the API — so a CLI result and
 * an API result for the same repository are identical by construction.
 */

interface CliOptions {
  repositoryPath: string;
  json: boolean;
  label: string | undefined;
  includeGit: boolean;
  maxCommits: number;
  help: boolean;
}

const USAGE = `repoatlas analyse <repository-path> [options]

Options:
  --json              Print the full graph and gap report as JSON
  --label <text>      Attach a label to the analysis record
  --no-git            Skip git history extraction
  --max-commits <n>   Maximum commits to read (default 2000)
  -h, --help          Show this message

Environment:
  REPOATLAS_ALLOWED_ROOTS   Semicolon-separated roots the repository must be inside.
                            Unset means no allow-list is enforced.
`;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    repositoryPath: '',
    json: false,
    label: undefined,
    includeGit: true,
    maxCommits: 2_000,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--no-git':
        options.includeGit = false;
        break;
      case '--label':
        options.label = argv[index + 1];
        index += 1;
        break;
      case '--max-commits':
        options.maxCommits = Number.parseInt(argv[index + 1] ?? '2000', 10);
        index += 1;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        options.repositoryPath = arg;
        break;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.repositoryPath.length === 0) {
    console.log(USAGE);
    process.exitCode = options.help ? 0 : 64; // EX_USAGE
    return;
  }

  const config = loadConfig();

  try {
    const output = await runAnalysis({
      repositoryPath: options.repositoryPath,
      label: options.label,
      allowedRoots: config.allowedRoots,
      includeGitHistory: options.includeGit && config.includeGitHistory,
      options: { maxCommits: options.maxCommits },
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            analysis: output.analysis,
            stats: output.stats,
            graph: output.graph,
            artifacts: output.projection.artifacts,
            gaps: output.projection.gaps,
            diagnostics: output.diagnostics,
          },
          null,
          2,
        ),
      );
      return;
    }

    const summary = output.analysis.summary;
    console.log(`Repository       ${output.analysis.repositoryName}  (${output.analysis.repositoryPath})`);
    console.log(`Commit           ${output.analysis.headCommit ?? 'none'}  branch=${output.analysis.branch ?? 'none'}`);
    console.log(`Files            ${summary?.fileCount ?? 0} discovered, ${summary?.analyzableFileCount ?? 0} analyzable, ${summary?.skippedFileCount ?? 0} skipped`);
    console.log(`Languages        ${formatCounts(summary?.languageCounts ?? {})}`);
    console.log(`Graph            ${output.stats.nodeCount} nodes, ${output.stats.edgeCount} edges, ${output.stats.evidenceCount} evidence records`);
    console.log(`Explicit share   nodes ${(output.stats.explicitShare.nodes * 100).toFixed(1)}%, edges ${(output.stats.explicitShare.edges * 100).toFixed(1)}%`);
    console.log(`Duration         ${summary?.durationMs ?? 0} ms${summary?.truncated ? '  (TRUNCATED: limits were reached)' : ''}`);
    console.log('');
    console.log('Node kinds       ' + formatCounts(output.stats.nodesByKind));
    console.log('Edge kinds       ' + formatCounts(output.stats.edgesByKind));
    console.log('');

    console.log('Artifacts');
    for (const artifact of output.projection.artifacts) {
      const state = artifact.insufficientEvidence ? 'INSUFFICIENT EVIDENCE' : `${artifact.nodes.length} nodes / ${artifact.edges.length} edges`;
      console.log(`  ${artifact.kind.padEnd(18)} ${state}`);
      for (const omitted of artifact.omitted.slice(0, 3)) {
        console.log(`      ! ${omitted.reason} (${omitted.count})`);
      }
    }

    console.log('');
    console.log('Gaps (no evidence found ≠ does not exist)');
    for (const gap of output.projection.gaps.gaps) {
      console.log(`  [${gap.status.padEnd(19)}] ${gap.title}`);
      for (const observation of gap.observations.slice(0, 2)) {
        console.log(`      ${observation}`);
      }
    }

    const errors = output.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    const warnings = output.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
    console.log('');
    console.log(`Diagnostics      ${errors.length} error(s), ${warnings.length} warning(s), ${output.diagnostics.length - errors.length - warnings.length} info`);
    for (const diagnostic of errors.slice(0, 10)) {
      console.log(`  ERROR ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ''}: ${diagnostic.message}`);
    }
  } catch (error) {
    if (error instanceof AnalysisError) {
      console.error(`[repoatlas] ${error.code}: ${error.message}`);
    } else {
      console.error(`[repoatlas] unexpected failure: ${(error as Error).message}`);
    }
    process.exitCode = 1;
  }
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

await main();