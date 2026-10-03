import { basename, dirname, extname, posix } from 'node:path';
import type { DiagnosticCollector } from './diagnostics.js';
import type { EvidenceStore } from './evidence.js';
import { SoftwareGraphBuilder } from './graph.js';
import { nodeId, toPosixPath } from './ids.js';
import type {
  CommitRecord,
  DiscoveredFile,
  ExtractedEntity,
  ParsedFile,
  RepositoryRef,
  SoftwareGraph,
} from './types.js';

/**
 * Builds the canonical Software Knowledge Graph from extracted facts.
 *
 * This is the only place nodes and edges are created. Artifact generators, the API and
 * the UI all read what this produces, which is what keeps a class diagram, a
 * dependency graph and a sequence diagram from contradicting each other.
 *
 * Confidence policy applied here:
 *  - a declaration read directly from source is `EXPLICIT`;
 *  - a relationship whose *target* was resolved by matching a symbol name is
 *    `STRONGLY_INFERRED` — the call exists, the identity of the callee was not stated;
 *  - a relationship guessed only from a naming convention is `WEEKLY_INFERRED`;
 *  - anything unresolvable is not created at all.
 *
 * Nothing is created without an evidence citation.
 */

export interface GraphBuildInput {
  repository: RepositoryRef;
  files: readonly DiscoveredFile[];
  parsed: readonly ParsedFile[];
  commits: readonly CommitRecord[];
  headCommit: string | null;
  branch: string | null;
  evidence: EvidenceStore;
  diagnostics: DiagnosticCollector;
  limits: { maxNodes: number; maxEdges: number };
  includeGitHistory: boolean;
}

/** A resolved symbol: the node it points at, where it was declared, and what it is. */
interface SymbolRef {
  id: string;
  filePath: string;
  kind: ExtractedEntity['kind'];
}

/** Entity kinds that can participate in an inheritance relationship. */
const INHERITABLE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'type']);

export interface GraphBuildCounters {
  files: number;
  modules: number;
  entities: number;
  imports: number;
  resolvedInternalImports: number;
  externalDependencies: number;
  resolvedCalls: number;
  unresolvedCalls: number;
  apiEndpoints: number;
  tables: number;
  tests: number;
  commits: number;
  contributors: number;
}

export interface GraphBuildResult {
  graph: SoftwareGraph;
  counters: GraphBuildCounters;
  /** True when a node or edge limit stopped facts from being recorded. */
  truncated: boolean;
}

const EMPTY_COUNTERS: GraphBuildCounters = {
  files: 0,
  modules: 0,
  entities: 0,
  imports: 0,
  resolvedInternalImports: 0,
  externalDependencies: 0,
  resolvedCalls: 0,
  unresolvedCalls: 0,
  apiEndpoints: 0,
  tables: 0,
  tests: 0,
  commits: 0,
  contributors: 0,
};

export function buildGraph(input: GraphBuildInput): GraphBuildResult {
  const builder = new SoftwareGraphBuilder({
    maxNodes: input.limits.maxNodes,
    maxEdges: input.limits.maxEdges,
  });
  const { evidence, diagnostics } = input;
  const counters: GraphBuildCounters = { ...EMPTY_COUNTERS };

  // ---------------------------------------------------------------- repository
  const repositoryEvidence = evidence.add({
    kind: 'DECLARATION',
    path: '.',
    startLine: 0,
    producer: 'graph-builder',
    excerpt: `repository root: ${input.repository.absolutePath}`,
  });
  const repositoryNode = builder.addNode({
    kind: 'repository',
    name: input.repository.name,
    qualifiedName: input.repository.name,
    evidence: [repositoryEvidence],
    confidence: 'EXPLICIT',
    attributes: {
      headCommit: input.headCommit,
      branch: input.branch,
      analysedFileCount: input.files.length,
    },
  });

  // ------------------------------------------------------------------- modules
  // A module exists for every analyzable file. The module id is the extensionless
  // path, which is the name the language itself uses in an import specifier.
  const moduleByPath = new Map<string, string>();
  for (const file of input.files) {
    if (!file.analyzable) continue;
    counters.files += 1;

    const fileRef = evidence.add({
      kind: 'DECLARATION',
      path: file.path,
      startLine: 1,
      producer: 'graph-builder',
      excerpt: `${file.language} file, ${file.byteSize} bytes`,
    });

    const moduleName = moduleNameFor(file.path);
    const moduleId = nodeId('module', moduleName);
    builder.addNode({
      kind: 'module',
      name: moduleName,
      qualifiedName: moduleName,
      language: file.language,
      path: file.path,
      evidence: [fileRef],
      confidence: 'EXPLICIT',
    });
    moduleByPath.set(file.path, moduleId);
    counters.modules += 1;

    builder.addEdge({
      from: repositoryNode.id,
      to: moduleId,
      kind: 'contains',
      confidence: 'EXPLICIT',
      evidence: [fileRef],
    });
  }

  // -------------------------------------------------------- entities and edges
/**
   * Index of every declared entity, keyed by the name forms a call site, import or
   * heritage clause could use. First declaration wins: a repeated symbol is a
   * duplicate to be reported later, not a second node.
   *
   * Built in a *complete first pass* before any relationship is resolved. A single
   * pass would make resolution depend on file order — a class extending a class
   * declared later would silently lose its edge, which is exactly the kind of
   * order-dependent inconsistency this graph exists to eliminate.
   */
  const symbolIndex = new Map<string, SymbolRef>();

  for (const file of input.parsed) {
    for (const entity of file.entities) {
      const id = nodeId(entity.kind, entity.qualifiedName);
      indexSymbol(symbolIndex, entity.qualifiedName, id, file.path, entity.kind);
      indexSymbol(symbolIndex, entity.name, id, file.path, entity.kind);
    }
  }

  // ------------------------------------------------------------------ entities
  for (const file of input.parsed) {
    const moduleId = moduleByPath.get(file.path);
    if (!moduleId) continue;

    for (const entity of file.entities) {
      counters.entities += 1;
      const id = nodeId(entity.kind, entity.qualifiedName);

      const declEvidence = evidence.add({
        kind: 'DECLARATION',
        path: file.path,
        startLine: entity.startLine,
        endLine: entity.endLine,
        symbol: entity.qualifiedName,
        excerpt: `${entity.kind} ${entity.qualifiedName}`,
        producer: file.producer,
      });

      builder.addNode({
        kind: entity.kind,
        name: entity.name,
        qualifiedName: entity.qualifiedName,
        language: entity.language,
        path: file.path,
        startLine: entity.startLine,
        endLine: entity.endLine,
        evidence: [declEvidence],
        confidence: 'EXPLICIT',
        attributes: {
          ...(entity.signature ? { signature: entity.signature } : {}),
          ...(entity.modifiers ? { modifiers: entity.modifiers.join(' ') } : {}),
          ...(entity.attributes ?? {}),
        },
      });

      builder.addEdge({
        from: moduleId,
        to: id,
        kind: 'contains',
        confidence: 'EXPLICIT',
        evidence: [declEvidence],
      });
    }
  }

  // ------------------------------------------------------------- inheritance
  // Second pass: with the index complete, every heritage clause can be resolved
  // regardless of the order files were parsed in.
  for (const file of input.parsed) {
    for (const entity of file.entities) {
      const id = nodeId(entity.kind, entity.qualifiedName);
      const relations: { names: string[] | undefined; kind: 'extends' | 'implements' }[] = [
        { names: entity.extendsFrom, kind: 'extends' },
        { names: entity.implementsFrom, kind: 'implements' },
      ];

      for (const relation of relations) {
        for (const name of relation.names ?? []) {
          const target = symbolIndex.get(name);
          if (!target || target.id === id) continue;
          // Only connect types to types: a class extending a symbol that happens to be
          // a function would be nonsense.
          if (!INHERITABLE_KINDS.has(target.kind)) continue;

          const heritageEvidence = evidence.add({
            kind: 'DECLARATION',
            path: file.path,
            startLine: entity.startLine,
            endLine: entity.startLine,
            symbol: entity.qualifiedName,
            excerpt: `${relation.kind} ${name}`,
            producer: file.producer,
          });

          builder.addEdge({
            from: id,
            to: target.id,
            kind: relation.kind,
            // The source states the heritage clause explicitly; identifying *which*
            // in-repository symbol it names was done by us, hence the downgrade.
            confidence: 'STRONGLY_INFERRED',
            evidence: [heritageEvidence],
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------- imports
  for (const file of input.parsed) {
    const fromModuleId = moduleByPath.get(file.path);
    if (!fromModuleId) continue;

    for (const record of file.imports) {
      counters.imports += 1;
      const importEvidence = evidence.add({
        kind: 'IMPORT_STATEMENT',
        path: file.path,
        startLine: record.line,
        endLine: record.line,
        symbol: record.specifier,
        excerpt: `import '${record.specifier}'`,
        producer: file.producer,
      });

      const resolved = resolveImportPath(record.specifier, file.path, moduleByPath);

      if (resolved !== null) {
        const targetId = moduleByPath.get(resolved);
        if (targetId) {
          counters.resolvedInternalImports += 1;
          builder.addEdge({
            from: fromModuleId,
            to: targetId,
            kind: record.kind === 'reexport' ? 're_exports' : 'imports',
            confidence: 'EXPLICIT',
            evidence: [importEvidence],
            label: record.names.length > 0 ? record.names.join(', ') : undefined,
            attributes: { specifier: record.specifier, typeOnly: record.kind === 'type_only' },
          });
          continue;
        }
      }

      if (record.isExternal) {
        // A third-party dependency is recorded as a declared package. The manifest or
        // import statement is explicit evidence that the dependency is declared — not
        // that RepoAtlas analysed the package's behaviour.
        counters.externalDependencies += 1;
        const packageId = nodeId('package', record.specifier);
        builder.addNode({
          kind: 'package',
          name: record.specifier,
          qualifiedName: record.specifier,
          evidence: [importEvidence],
          confidence: 'EXPLICIT',
        });
        builder.addEdge({
          from: repositoryNode.id,
          to: packageId,
          kind: 'contains',
          confidence: 'EXPLICIT',
          evidence: [importEvidence],
          attributes: { external: true },
        });
        builder.addEdge({
          from: fromModuleId,
          to: packageId,
          kind: 'depends_on',
          confidence: 'EXPLICIT',
          evidence: [importEvidence],
          attributes: { specifier: record.specifier, external: true },
        });
        continue;
      }

      diagnostics.info('DANGLING_REFERENCE', `Unresolved relative import '${record.specifier}'`, {
        path: file.path,
      });
    }
  }

  // ---------------------------------------------------------------------- calls
  for (const file of input.parsed) {
    const fromModuleId = moduleByPath.get(file.path);
    if (!fromModuleId) continue;

    for (const call of file.calls) {
      const target = resolveCallee(call.callee, symbolIndex);
      const caller = call.fromQualifiedName ? symbolIndex.get(call.fromQualifiedName) : undefined;

      if (!target || target.id === caller?.id) {
        counters.unresolvedCalls += 1;
        continue;
      }

      counters.resolvedCalls += 1;
      const callEvidence = evidence.add({
        kind: 'CALL_SITE',
        path: file.path,
        startLine: call.line,
        endLine: call.line,
        symbol: call.fromQualifiedName,
        excerpt: `${call.callee}(…)`,
        producer: file.producer,
      });

      builder.addEdge({
        // When the enclosing function was identified the edge starts there;
        // otherwise it starts at the module, which is a weaker claim.
        from: caller?.id ?? fromModuleId,
        to: target.id,
        kind: 'calls',
        confidence: caller ? 'STRONGLY_INFERRED' : 'WEEKLY_INFERRED',
        evidence: [callEvidence],
        attributes: { callee: call.callee, sameModule: target.filePath === file.path },
      });
    }
  }

  // ------------------------------------------------------------------- markers
  addMarkerFacts(input, builder, moduleByPath, counters);

  // ------------------------------------------------------------------ git facts
  if (input.includeGitHistory && input.commits.length > 0) {
    addGitFacts(input, builder, repositoryNode.id, moduleByPath, counters);
  }

  if (builder.wasTruncated()) {
    diagnostics.warn(
      'NODE_LIMIT_REACHED',
      `Graph truncated at limits (nodes ${builder.nodeCount()}, edges ${builder.edgeCount()}); analysis is partial`,
    );
  }

  return { graph: builder.build(evidence), counters, truncated: builder.wasTruncated() };
}

function indexSymbol(
  index: Map<string, SymbolRef>,
  symbol: string,
  id: string,
  filePath: string,
  kind: ExtractedEntity['kind'],
): void {
  if (symbol.length === 0) return;
  // First declaration wins. A symbol declared in two files is a duplicate to be
  // reported later, not a second node.
  if (!index.has(symbol)) {
    index.set(symbol, { id, filePath, kind });
  }
}

/**
 * Resolves a call target from the callee text.
 *
 * Tried in order: the full dotted name, the trailing member name, and the leading
 * identifier. The member-name match is what turns `helper()` into a call to the
 * declared `helper`, and is why the resulting edge is labelled `STRONGLY_INFERRED`
 * rather than explicit.
 */
export function resolveCallee(
  callee: string,
  index: ReadonlyMap<string, SymbolRef>,
): SymbolRef | undefined {
  if (index.has(callee)) return index.get(callee);

  const withoutCall = callee.replace(/\(\)$/, '');
  if (index.has(withoutCall)) return index.get(withoutCall);

  const segments = withoutCall.split('.');
  const last = segments.at(-1);
  if (last && index.has(last)) return index.get(last);

  const first = segments[0];
  if (first && index.has(first)) return index.get(first);

  return undefined;
}

/** Extensionless module name, matching how a specifier refers to the module. */
export function moduleNameFor(path: string): string {
  return stripKnownExtension(path);
}

const KNOWN_EXTENSIONS = [
  '.d.ts', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.pyi',
  '.ts', '.js', '.py', '.go', '.java', '.cs', '.rb', '.php', '.rs',
  '.sql', '.yaml', '.yml', '.json', '.jsonc', '.toml', '.md', '.mdx', '.graphql', '.proto',
];

export function stripKnownExtension(path: string): string {
  for (const extension of KNOWN_EXTENSIONS) {
    if (path.endsWith(extension)) return path.slice(0, -extension.length);
  }
  return path;
}

/**
 * Resolves a relative import specifier against the importing file.
 *
 * Tries the literal path, the path with each known extension, the path as a directory
 * index file, and the TypeScript convention where `./foo.js` is written on disk but
 * `./foo.ts` is meant. This mirrors bundler resolution without executing anything.
 */
export function resolveImportPath(
  specifier: string,
  fromPath: string,
  known: ReadonlyMap<string, string>,
): string | null {
  if (!specifier.startsWith('.')) return null;

  const baseDir = dirname(fromPath);
  const candidate = toPosixPath(posix.normalize(posix.join(baseDir === '.' ? '' : baseDir, specifier)));

  const attempts: string[] = [candidate];
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.py']) {
    attempts.push(`${candidate}${extension}`);
    attempts.push(`${candidate}/index${extension}`);
  }
  if (candidate.endsWith('.js')) attempts.push(`${candidate.slice(0, -3)}.ts`);
  if (candidate.endsWith('.mjs')) attempts.push(`${candidate.slice(0, -4)}.mts`);

  for (const attempt of attempts) {
    if (known.has(attempt)) return attempt;
  }
  return null;
}

function addMarkerFacts(
  input: GraphBuildInput,
  builder: SoftwareGraphBuilder,
  moduleByPath: ReadonlyMap<string, string>,
  counters: GraphBuildCounters,
): void {
  const { evidence } = input;

  for (const file of input.parsed) {
    const moduleId = moduleByPath.get(file.path);
    if (!moduleId) continue;

    for (const marker of file.markers) {
      switch (marker.name) {
        case 'http.route':
          addApiEndpoint(builder, evidence, file, moduleId, marker, counters);
          break;
        case 'schema.table':
          addTable(builder, evidence, file, moduleId, marker, counters);
          break;
        case 'schema.column':
          addColumn(builder, evidence, file, marker);
          break;
        case 'manifest.dependency':
          addDeclaredDependency(builder, evidence, file, moduleId, marker);
          break;
        case 'test.suite':
        case 'test.case':
          addTestEntity(builder, evidence, file, moduleId, marker, counters);
          break;
        case 'compose.service':
        case 'docker.base_image':
        case 'docker.expose':
          addDeploymentComponent(builder, evidence, file, moduleId, marker);
          break;
        default:
          addConfiguration(builder, evidence, file, moduleId, marker);
          break;
      }
    }
  }
}

type ParsedFileRef = ParsedFile;

function addApiEndpoint(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
  counters: GraphBuildCounters,
): void {
  counters.apiEndpoints += 1;
  const method = String(marker.attributes.httpMethod ?? 'ANY');
  const route = String(marker.attributes.path ?? '/');
  const name = `${method} ${route}`;

  const markerEvidence = evidence.add({
    kind: 'ROUTE_DECLARATION',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: name,
    excerpt: marker.attributes.handler
      ? `${method}('${route}', ${String(marker.attributes.handler)})`
      : `${method}('${route}')`,
    producer: file.producer,
  });

  const endpointId = nodeId('api_endpoint', name);
  builder.addNode({
    kind: 'api_endpoint',
    name,
    qualifiedName: name,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { httpMethod: method, route, handler: marker.attributes.handler ?? null },
  });
  builder.addEdge({ from: moduleId, to: endpointId, kind: 'exposes', confidence: 'EXPLICIT', evidence: [markerEvidence] });
  builder.addEdge({ from: endpointId, to: moduleId, kind: 'declared_in', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

function addTable(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
  counters: GraphBuildCounters,
): void {
  counters.tables += 1;
  const table = String(marker.attributes.table ?? 'unknown');

  const markerEvidence = evidence.add({
    kind: 'SCHEMA_DDL',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: table,
    excerpt: `CREATE TABLE ${table}`,
    producer: file.producer,
  });

  const tableId = nodeId('table', table);
  builder.addNode({
    kind: 'table',
    name: table,
    qualifiedName: table,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { columnCount: marker.attributes.columnCount ?? null },
  });
  builder.addEdge({ from: moduleId, to: tableId, kind: 'declares_schema', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

function addColumn(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
): void {
  const table = String(marker.attributes.table ?? 'unknown');
  const column = String(marker.attributes.column ?? 'unknown');
  const tableId = nodeId('table', table);
  // A column marker can arrive before its table marker if the DDL is oddly ordered.
  if (!builder.hasNode(tableId)) return;

  const markerEvidence = evidence.add({
    kind: 'SCHEMA_DDL',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: `${table}.${column}`,
    excerpt: `${column} ${String(marker.attributes.dataType ?? '')}`.trim(),
    producer: file.producer,
  });

  const columnId = nodeId('column', `${table}.${column}`);
  builder.addNode({
    kind: 'column',
    name: column,
    qualifiedName: `${table}.${column}`,
    path: file.path,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { table, dataType: marker.attributes.dataType ?? null },
  });
  builder.addEdge({ from: tableId, to: columnId, kind: 'contains', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

/**
 * Records a test suite or test case as a `test` entity.
 *
 * Named after the literal title in the source. Two tests in different files may share a
 * title, so the entity id includes the file path — otherwise unrelated cases would
 * silently merge into one node.
 */
function addTestEntity(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
  counters: GraphBuildCounters,
): void {
  counters.tests += 1;
  const title = String(marker.attributes.title ?? 'untitled');
  const kindLabel = marker.name === 'test.suite' ? 'suite' : 'case';
  const qualifiedName = `${file.path}#${marker.line}:${kindLabel}:${title}`;

  const markerEvidence = evidence.add({
    kind: 'TEST_ASSERTION',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: title,
    excerpt: `${marker.name}('${title}')`,
    producer: file.producer,
  });

  const testId = nodeId('test', qualifiedName);
  builder.addNode({
    kind: 'test',
    name: title,
    qualifiedName,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { declaration: kindLabel, ...marker.attributes },
  });
  builder.addEdge({ from: moduleId, to: testId, kind: 'contains', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

function addDeclaredDependency(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
): void {
  const dependency = String(marker.attributes.dependency ?? '');
  if (dependency.length === 0) return;

  const markerEvidence = evidence.add({
    kind: 'MANIFEST_FIELD',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: dependency,
    excerpt: `"${dependency}": "${String(marker.attributes.range ?? '')}"`,
    producer: file.producer,
  });

  const packageId = nodeId('package', dependency);
  builder.addNode({
    kind: 'package',
    name: dependency,
    qualifiedName: dependency,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { range: marker.attributes.range ?? null, section: marker.attributes.section ?? null },
  });
  builder.addEdge({
    from: moduleId,
    to: packageId,
    kind: 'depends_on',
    // Explicit that the *manifest* declares it. Whether code imports it is a separate
    // fact, checked later by the consistency engine.
    confidence: 'EXPLICIT',
    evidence: [markerEvidence],
    attributes: { declaredIn: file.path, declared: true },
  });
}

function addDeploymentComponent(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
): void {
  const name = String(marker.attributes.service ?? marker.attributes.image ?? 'unknown');
  const markerEvidence = evidence.add({
    kind: 'INFRASTRUCTURE_FILE',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: name,
    excerpt: `${marker.name} ${name}`,
    producer: file.producer,
  });

  const componentId = nodeId('deployment_component', name);
  builder.addNode({
    kind: 'deployment_component',
    name,
    qualifiedName: name,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { ...marker.attributes },
  });
  builder.addEdge({ from: moduleId, to: componentId, kind: 'deploys', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

function addConfiguration(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
): void {
  const key = String(marker.attributes.key ?? marker.name);
  const markerEvidence = evidence.add({
    kind: 'CONFIG_KEY',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: key,
    excerpt: `${marker.name}: ${truncate(JSON.stringify(marker.attributes), 160)}`,
    producer: file.producer,
  });

  const configId = nodeId('configuration', `${file.path}#${marker.line}`);
  builder.addNode({
    kind: 'configuration',
    name: key,
    qualifiedName: `${file.path}#${marker.line}`,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { marker: marker.name, ...marker.attributes },
  });
  builder.addEdge({ from: moduleId, to: configId, kind: 'configures', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

function addGitFacts(
  input: GraphBuildInput,
  builder: SoftwareGraphBuilder,
  repositoryNodeId: string,
  moduleByPath: ReadonlyMap<string, string>,
  counters: GraphBuildCounters,
): void {
  const { evidence } = input;
  const seenContributors = new Set<string>();

  for (const commit of input.commits) {
    counters.commits += 1;
    const commitEvidence = evidence.add({
      kind: 'GIT_COMMIT',
      path: '.git',
      startLine: 0,
      endLine: 0,
      symbol: commit.shortHash,
      excerpt: commit.subject,
      producer: 'git',
    });

    const commitId = nodeId('commit', commit.hash);
    builder.addNode({
      kind: 'commit',
      name: commit.shortHash,
      qualifiedName: commit.hash,
      evidence: [commitEvidence],
      confidence: 'EXPLICIT',
      attributes: {
        hash: commit.hash,
        timestamp: commit.timestamp,
        subject: commit.subject,
        fileCount: commit.files.length,
      },
    });

    const emailKey = commit.authorEmail.toLowerCase();
    const contributorId = nodeId('contributor', emailKey);
    if (!seenContributors.has(emailKey)) {
      seenContributors.add(emailKey);
      counters.contributors += 1;
      builder.addNode({
        kind: 'contributor',
        name: commit.authorName,
        qualifiedName: emailKey,
        evidence: [commitEvidence],
        confidence: 'EXPLICIT',
        attributes: { email: emailKey },
      });
      builder.addEdge({
        from: repositoryNodeId,
        to: contributorId,
        kind: 'contains',
        confidence: 'EXPLICIT',
        evidence: [commitEvidence],
      });
    }

    builder.addEdge({
      from: contributorId,
      to: commitId,
      kind: 'authored_by',
      confidence: 'EXPLICIT',
      evidence: [commitEvidence],
    });

    for (const file of commit.files) {
      const moduleId = moduleByPath.get(file);
      if (!moduleId) continue;
      builder.addEdge({
        from: commitId,
        to: moduleId,
        kind: 'modifies',
        // Git states which paths the commit changed; that is explicit.
        confidence: 'EXPLICIT',
        evidence: [commitEvidence],
        attributes: { path: file },
      });
    }
  }
}

/** Short display label for a module, used by artifacts and the UI. */
export function moduleDisplayName(moduleQualifiedName: string): string {
  return basename(moduleQualifiedName) || moduleQualifiedName;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export { extname };