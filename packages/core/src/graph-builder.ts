import { basename, dirname, extname, posix } from 'node:path';
import type { DiagnosticCollector } from './diagnostics.js';
import type { EvidenceStore } from './evidence.js';
import { SoftwareGraphBuilder } from './graph.js';
import { nodeId, toPosixPath } from './ids.js';
import type {
  AttributeValue,
  CommitRecord,
  DiscoveredFile,
  EvidenceRef,
  ExtractedEntity,
  GraphNode,
  Marker,
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
  /**
   * Content digest per repository-relative path.
   *
   * Optional: a caller that does not hash files still gets a valid graph, but rename
   * detection in the drift engine will then be unable to establish a rename and will
   * report removed plus added instead.
   */
  digestByPath?: ReadonlyMap<string, string>;
}

/** A resolved symbol: the node it points at, where it was declared, and what it is. */
interface SymbolRef {
  id: string;
  filePath: string;
  kind: ExtractedEntity['kind'];
  /** Qualified name as declared, used in derivations and condition ids. */
  qualifiedName: string;
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
  const digestByPath = input.digestByPath ?? new Map<string, string>();
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
    const fileDigest = digestByPath.get(file.path);
    builder.addNode({
      kind: 'module',
      name: moduleName,
      qualifiedName: moduleName,
      language: file.language,
      path: file.path,
      // The content digest is what later lets a rename be established by proof rather
      // than by name similarity. Absent when ingestion could not supply one.
      ...(fileDigest ? { digest: fileDigest } : {}),
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
      indexSymbol(symbolIndex, entity.qualifiedName, id, file.path, entity.kind, entity.qualifiedName);
      indexSymbol(symbolIndex, entity.name, id, file.path, entity.kind, entity.qualifiedName);
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
          // Present whenever the source states it, in both directions. A behaviour projection
          // showing a synchronous call into an `async` function would be describing something
          // the code does not do, and "the source did not say" is a third, distinct state.
          ...(entity.isAsync === undefined ? {} : { isAsync: entity.isAsync }),
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
  addMarkerFacts(input, builder, moduleByPath, symbolIndex, counters);

  // ---------------------------------------------------------------- return facts
  addReturnFacts(builder, evidence, input.parsed, symbolIndex);

  // ---------------------------------------------------------------- test facts
  addTestFacts(builder);

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
  qualifiedName: string,
): void {
  if (symbol.length === 0) return;
  // First declaration wins. A symbol declared in two files is a duplicate to be
  // reported later, not a second node.
  if (!index.has(symbol)) {
    index.set(symbol, { id, filePath, kind, qualifiedName });
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
  symbolIndex: ReadonlyMap<string, SymbolRef>,
  counters: GraphBuildCounters,
): void {
  const { evidence } = input;

  for (const file of input.parsed) {
    const moduleId = moduleByPath.get(file.path);
    if (!moduleId) continue;

    for (const marker of file.markers) {
      switch (marker.name) {
        case 'http.route':
          addApiEndpoint(builder, evidence, file, moduleId, marker, counters, symbolIndex);
          break;
        case 'schema.table':
          addTable(builder, evidence, file, moduleId, marker, counters);
          break;
        case 'schema.column':
          addColumn(builder, evidence, file, marker);
          break;
        case 'schema.foreign_key':
          addForeignKey(builder, evidence, file, marker);
          break;
        case 'sql.query':
          addSqlQuery(builder, evidence, file, marker, moduleId, symbolIndex);
          break;
        case 'sql.cte':
          addCteQuery(builder, evidence, file, marker, symbolIndex);
          break;
        case 'sql.statement':
          // A statement the analyser recognised and declined to classify. It creates no data
          // relationship, and its evidence is recorded so the data projection can say a query is
          // present and unread rather than "no database access here".
          addUnclassifiedStatement(builder, evidence, file, marker, moduleId, symbolIndex);
          break;
        case 'control.branch':
        case 'control.loop':
        case 'control.handler':
          addControlFlow(builder, evidence, file, marker, symbolIndex);
          break;
        case 'manifest.dependency':
          addDeclaredDependency(builder, evidence, file, moduleId, marker);
          break;
        case 'doc.requirement':
          addDeclaredRequirement(builder, evidence, file, moduleId, marker, symbolIndex);
          break;
        case 'test.suite':
        case 'test.case':
          addTestEntity(builder, evidence, file, moduleId, marker, counters);
          break;
        case 'compose.service':
        case 'docker.base_image':
        case 'docker.expose':
          addDeploymentComponent(builder, evidence, file, moduleId, marker, moduleByPath);
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
  symbolIndex: ReadonlyMap<string, SymbolRef>,
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

  // The route registration names the handler. Resolving that name to a declaration links the
  // endpoint to the code that serves it, which is what makes a sequence and a use case
  // recoverable rather than a list of endpoints with nothing behind them.
  //
  // `STRONGLY_INFERRED`, because the handler name was resolved the same way any call is: by
  // name. When the name does not resolve, no edge is created — an endpoint with no identified
  // handler is a legitimate state, and the behaviour projections report it as partial.
  const handlerName = typeof marker.attributes.handler === 'string' ? marker.attributes.handler : undefined;
  if (!handlerName) return;
  const handler = symbolIndex.get(handlerName);
  if (!handler) return;
  builder.addEdge({
    from: endpointId,
    to: handler.id,
    kind: 'calls',
    confidence: 'STRONGLY_INFERRED',
    evidence: [markerEvidence],
    attributes: { derivedFrom: 'route.handler', handler: handlerName },
  });
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
    attributes: {
      table,
      dataType: marker.attributes.dataType ?? null,
      // What the DDL actually constrains. These are facts about the schema, not inferences
      // from a column's name, and the ER projection draws them because they are stated.
      primaryKey: marker.attributes.primaryKey === true,
      notNull: marker.attributes.notNull === true,
      unique: marker.attributes.unique === true,
      ...(marker.attributes.referencesTable ? { referencesTable: String(marker.attributes.referencesTable) } : {}),
    },
  });
  builder.addEdge({ from: tableId, to: columnId, kind: 'contains', confidence: 'EXPLICIT', evidence: [markerEvidence] });
}

/**
 * Records an explicit foreign key as a relationship between two tables.
 *
 * Created only from a `REFERENCES` clause or a table-level `FOREIGN KEY` constraint. A column
 * named `report_id` is not a foreign key because of its name, and the ER projection reports
 * that absence rather than inferring the relationship from naming.
 */
function addForeignKey(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
): void {
  const table = String(marker.attributes.table ?? '');
  const column = String(marker.attributes.column ?? '');
  const referencesTable = String(marker.attributes.referencesTable ?? '');
  if (table.length === 0 || column.length === 0 || referencesTable.length === 0) return;

  const fromId = nodeId('table', table);
  const toId = nodeId('table', referencesTable);
  // Both endpoints must exist: a relationship to a table this analysis never read is not
  // representable, and creating the target would assert a table the repository does not show.
  if (!builder.hasNode(fromId) || !builder.hasNode(toId)) return;

  const markerEvidence = evidence.add({
    kind: 'SCHEMA_DDL',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: `${table}.${column}`,
    excerpt: `FOREIGN KEY (${column}) REFERENCES ${referencesTable}${marker.attributes.referencesColumn ? `(${String(marker.attributes.referencesColumn)})` : ''}`,
    producer: file.producer,
  });

  builder.addEdge({
    from: fromId,
    to: toId,
    kind: 'references',
    confidence: 'EXPLICIT',
    evidence: [markerEvidence],
    attributes: { column, ...(marker.attributes.referencesColumn ? { referencesColumn: String(marker.attributes.referencesColumn) } : {}) },
  });
}

/**
 * Records a common table expression defined by a statement in code.
 *
 * A CTE is not a store. `WITH recent AS (SELECT * FROM orders) SELECT * FROM recent` reads
 * `orders` and produces a *query result* named `recent`. Creating a `table` node for `recent`
 * would put a physical store into the graph that does not exist in the database, and the ER
 * diagram would draw it.
 *
 * So the CTE becomes a `constant` node — the vocabulary the graph already has for a name bound
 * in source rather than declared as a structure — held by the function whose statement defined
 * it, with the statement's own evidence. The consuming query's reads are attributed to the
 * physical tables it actually names; the CTE is the path between them, not a store.
 */
function addCteQuery(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const names = String(marker.attributes.names ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return;

  const markerEvidence = evidence.add({
    kind: 'CALL_SITE',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: names.join(', '),
    excerpt: `query expression ${names.join(', ')}`,
    producer: file.producer,
  });

  const scopeName = typeof marker.attributes.scope === 'string' ? marker.attributes.scope : undefined;
  const scoped = scopeName ? symbolIndex.get(scopeName) : undefined;
  const fromId = scoped?.id ?? undefined;
  if (!fromId) return;

  for (const name of names) {
    const cteId = nodeId('constant', `cte:${name}`);
    if (!builder.hasNode(cteId)) {
      builder.addNode({
        kind: 'constant',
        name,
        qualifiedName: `cte:${name}`,
        path: file.path,
        startLine: marker.line,
        evidence: [markerEvidence],
        confidence: 'EXPLICIT',
        // Named as a query result so a reader never takes it for a declared structure.
        attributes: {
          queryExpression: true,
          ...(typeof marker.attributes.statement === 'string' ? { statement: marker.attributes.statement } : {}),
        },
      });
    }
    builder.addEdge({
      from: fromId,
      to: cteId,
      kind: 'produces',
      confidence: 'EXPLICIT',
      evidence: [markerEvidence],
      attributes: { queryExpression: true },
    });
  }
}

/**
 * Records a statement the analyser recognised but would not classify.
 *
 * No data relationship is created — an unread statement has no known table, so a `reads` edge
 * would name a table nobody evidenced. The statement itself becomes a `constant` node held by
 * the function that contains it, carrying the reason it was not classified.
 *
 * This is what makes the difference between "there is no database access here" and "there is a
 * query here that this analyser does not read" visible in the artifact rather than invisible.
 */
function addUnclassifiedStatement(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
  moduleId: string,
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const summary = String(marker.attributes.summary ?? 'statement').slice(0, 120);
  const reason = typeof marker.attributes.unsupported === 'string' ? marker.attributes.unsupported : null;

  const markerEvidence = evidence.add({
    kind: 'CALL_SITE',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: summary,
    excerpt: reason ? `${summary} — ${reason}` : summary,
    producer: file.producer,
  });

  const scopeName = typeof marker.attributes.scope === 'string' ? marker.attributes.scope : undefined;
  const scoped = scopeName ? symbolIndex.get(scopeName) : undefined;
  const fromId = scoped?.id ?? moduleId;
  const statementId = nodeId('constant', `statement:${summary}`);

  if (!builder.hasNode(statementId)) {
    builder.addNode({
      kind: 'constant',
      name: summary,
      qualifiedName: `statement:${summary}`,
      path: file.path,
      startLine: marker.line,
      evidence: [markerEvidence],
      // The statement is certainly there; what it touches is not established.
      confidence: 'UNKNOWN',
      attributes: { unclassifiedStatement: true, ...(reason ? { reason } : {}) },
    });
  }

  builder.addEdge({
    from: fromId,
    to: statementId,
    kind: 'contains',
    confidence: scoped ? 'EXPLICIT' : 'WEEKLY_INFERRED',
    evidence: [markerEvidence],
    attributes: { unclassifiedStatement: true },
  });
}

/**
 * Records a SQL statement found in code as a read from, or a write to, the table it names.
 *
 * The relationship is stated by the code: the literal query names the table. Attributed to
 * the enclosing function when the parser resolved one, because "this endpoint writes
 * reports" is a more useful claim than "this module writes reports" — and when no function
 * encloses the statement, the module is used and the edge is marked `WEEKLY_INFERRED`, since
 * that is a weaker claim about who does it.
 */
function addSqlQuery(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
  moduleId: string,
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const table = String(marker.attributes.table ?? '');
  const operation = String(marker.attributes.operation ?? 'read');
  if (table.length === 0) return;

  // The citation is created first because it is also the only evidence the referenced table
  // will ever have. A query names a table without declaring it, so the evidence points at the
  // query — "a statement referring to `analyses` appears here" — and the node is marked as
  // not declared in any DDL this analysis read.
  const markerEvidence = evidence.add({
    kind: 'CALL_SITE',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: table,
    excerpt: `${operation.toUpperCase()} ${table}`,
    producer: file.producer,
  });

  const tableId = nodeId('table', table);
  if (!builder.hasNode(tableId)) {
    // A query may name a table whose DDL this analysis did not read — an external or legacy
    // schema. Recording the reference is still correct; the data projection reports the store
    // as an unknown schema rather than inventing columns for it.
    builder.addNode({
      kind: 'table',
      name: table,
      qualifiedName: table,
      evidence: [markerEvidence],
      confidence: 'UNKNOWN',
      attributes: { declaredInDdl: false },
    });
  }

  const scopeName = typeof marker.attributes.scope === 'string' ? marker.attributes.scope : undefined;
  const scoped = scopeName ? symbolIndex.get(scopeName) : undefined;
  const fromId = scoped?.id ?? moduleId;

  builder.addEdge({
    from: fromId,
    to: tableId,
    kind: operation === 'write' ? 'writes' : 'reads',
    confidence: scoped ? 'EXPLICIT' : 'WEEKLY_INFERRED',
    evidence: [markerEvidence],
    attributes: {
      operation,
      // Phase 4: the role the name appeared in, and the statement it came from. Two tables in
      // one query produce two edges with different roles, which is what keeps a read of
      // `orders` from being reported as a write because it joined a written table.
      ...(typeof marker.attributes.role === 'string' ? { role: marker.attributes.role } : {}),
      ...(typeof marker.attributes.statement === 'string' ? { statement: marker.attributes.statement } : {}),
      ...(typeof marker.attributes.statementCount === 'number' ? { statementCount: marker.attributes.statementCount } : {}),
      ...(scoped ? {} : { scopeUnknown: true }),
    },
  });
}

/**
 * Records an explicit branch, loop or handler as a decision point owned by the function it
 * appears in.
 *
 * The edge kind distinguishes a loop from a branch, and the condition is stored verbatim as
 * written, because an activity diagram that paraphrases the repository's own condition is
 * showing something the repository does not say.
 */
function addControlFlow(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const scopeName = typeof marker.attributes.scope === 'string' ? marker.attributes.scope : undefined;
  const scope = scopeName ? symbolIndex.get(scopeName) : undefined;
  // A condition outside any named scope has no owner, and attaching it to the module would
  // make module-level setup look like a step of some function's workflow.
  if (!scope) return;

  const flow = String(marker.attributes.flow ?? 'branch');
  const condition = typeof marker.attributes.condition === 'string' ? marker.attributes.condition : undefined;

  const markerEvidence = evidence.add({
    kind: 'DECLARATION',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: scope.qualifiedName,
    excerpt: condition ? `${flow}: ${condition}` : flow,
    producer: file.producer,
  });

  // Keyed by owner, line and flow kind so two conditions on the same line stay distinct, so
  // the id is stable across runs, and so the node id and the edge target are computed from the
  // same string — computing them from different ones produces an edge that silently fails to
  // attach because its endpoint does not exist.
  const qualifiedName = `${scope.qualifiedName}#${marker.line}:${flow}`;
  const conditionId = nodeId('condition', qualifiedName);
  builder.addNode({
    id: conditionId,
    kind: 'condition',
    name: condition ?? flow,
    qualifiedName,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: {
      flow,
      ...(condition ? { condition } : {}),
      scope: scope.qualifiedName,
    },
  });

  builder.addEdge({
    from: scope.id,
    to: conditionId,
    kind: flow === 'loop' ? 'loops' : 'branches',
    confidence: 'EXPLICIT',
    evidence: [markerEvidence],
  });
}

/**
 * Links a test to the entry point it exercises.
 *
 * A `tests` edge is what makes a requirement traceable to a test: requirement → use case →
 * implementation → test. The link is drawn when a test calls a function that a route
 * registration names as its handler.
 *
 * Two limits are deliberate:
 *
 * - **One hop only.** A test that reaches the handler through a client helper is not linked.
 *   Walking helper chains would attribute a test to every endpoint the helper could reach, which
 *   is a guess dressed as a fact. The consistency engine reports the missing link instead.
 * - **The handler must be named by the route.** An endpoint with no identified handler has
 *   nothing to test against.
 *
 * `STRONGLY_INFERRED`: the test genuinely calls the handler, but "this test covers this
 * endpoint" is an inference about intent, and the evidence recorded is the call site.
 */
function addTestFacts(builder: SoftwareGraphBuilder): void {
  const nodes = builder.allNodes();
  const testIds = new Set(nodes.filter((node) => node.kind === 'test').map((node) => node.id));

  const handlerToEndpoints = new Map<string, string[]>();
  for (const edge of builder.allEdges()) {
    if (edge.kind !== 'calls' || edge.attributes?.derivedFrom !== 'route.handler') continue;
    const list = handlerToEndpoints.get(edge.to);
    if (list) list.push(edge.from);
    else handlerToEndpoints.set(edge.to, [edge.from]);
  }
  if (handlerToEndpoints.size === 0) return;

  for (const edge of builder.allEdges()) {
    if (edge.kind !== 'calls') continue;
    if (!testIds.has(edge.from) && !isInTestFile(nodes, edge.from)) continue;
    const endpoints = handlerToEndpoints.get(edge.to);
    if (!endpoints) continue;

    for (const endpoint of endpoints) {
      builder.addEdge({
        from: edge.from,
        to: endpoint,
        kind: 'tests',
        confidence: 'STRONGLY_INFERRED',
        evidence: edge.evidence,
        attributes: { viaHandler: edge.attributes?.callee ?? null, hops: 1 },
      });
    }
  }
}

/**
 * A function declared in a test file is treated as a test entity for attribution purposes.
 *
 * Naming convention only — a file matching `*.test.*`, `*.spec.*` or under `test/`/`tests/`.
 * It never creates a `test` node; it only widens which callers may hold a `tests` edge.
 */
function isInTestFile(nodes: readonly GraphNode[], id: string): boolean {
  const path = nodes.find((node) => node.id === id)?.path;
  if (!path) return false;
  return /(^|\/)(test|tests|__tests__)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path);
}

/**
 * Records a requirement stated in a document.
 *
 * This is the only path by which a *declared* requirement enters the graph, and it is
 * deliberately narrow:
 *
 * - The statement is copied from the document. Nothing is paraphrased, summarised or inferred.
 * - An `implements_requirement` relationship is created only when the document names
 *   something that resolves to a declared entity — a symbol name or a module path. A
 *   requirement that mentions nothing resolvable stays unlinked, and the requirement view
 *   reports it as having no implementation evidence rather than attaching it to whatever
 *   looked closest.
 *
 * `EXPLICIT` for both the requirement and the relationship it states: the document says so.
 */
function addDeclaredRequirement(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFileRef,
  moduleId: string,
  marker: ParsedFileRef['markers'][number],
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const statement = String(marker.attributes.statement ?? '').trim();
  if (statement.length === 0) return;

  const identifier = typeof marker.attributes.identifier === 'string' ? marker.attributes.identifier : undefined;
  // Identified requirements keep their identifier so `REQ-014` in prose and in the graph are
  // the same requirement. Unidentified ones are named after their position in their file.
  const qualifiedName = identifier ?? `${file.path}#${marker.line}`;

  const markerEvidence = evidence.add({
    kind: 'DECLARATION',
    path: file.path,
    startLine: marker.line,
    endLine: marker.line,
    symbol: identifier ?? statement.slice(0, 60),
    excerpt: statement,
    producer: file.producer,
  });

  const requirementId = nodeId('requirement', qualifiedName);
  builder.addNode({
    kind: 'requirement',
    name: identifier ?? statement.slice(0, 80),
    qualifiedName,
    path: file.path,
    startLine: marker.line,
    evidence: [markerEvidence],
    confidence: 'EXPLICIT',
    attributes: { statement, ...(identifier ? { identifier } : {}) },
  });
  builder.addEdge({ from: moduleId, to: requirementId, kind: 'declared_in', confidence: 'EXPLICIT', evidence: [markerEvidence] });

  const reference = typeof marker.attributes.implementsRef === 'string' ? marker.attributes.implementsRef : undefined;
  if (!reference) return;

  // A symbol name the document mentions, or an exact module path it points at. Nothing else
  // resolves, and an unlinked requirement is preferable to a link to the wrong code.
  const targetId = symbolIndex.get(reference)?.id ?? moduleByIdFromReference(builder, reference);
  if (!targetId) return;
  builder.addEdge({
    from: requirementId,
    to: targetId,
    kind: 'implements_requirement',
    confidence: 'EXPLICIT',
    evidence: [markerEvidence],
    attributes: { statedIn: file.path, reference },
  });
}

/**
 * Resolves a requirement's reference to a module node.
 *
 * Only an exact module path matches. A reference that merely resembles one — a directory, a
 * glob, a file the analysis did not read — resolves to nothing, and an unlinked requirement is
 * a better answer than a link to the wrong module.
 */
function moduleByIdFromReference(builder: SoftwareGraphBuilder, reference: string): string | undefined {
  const candidate = nodeId('module', toPosixPath(reference));
  return builder.hasNode(candidate) ? candidate : undefined;
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
  moduleByPath: ReadonlyMap<string, string>,
): void {
  // `EXPOSE 4300` states a port on an image, not a unit that runs. Creating a component for it
  // produced a deployment component literally named "unknown" in the architecture view.
  if (marker.name === 'docker.expose') return;

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
    attributes: {
      ...marker.attributes,
      // `FROM x` says what an image is built from; a compose service says what runs. The
      // distinction decides whether this belongs in a container view at all, so it is recorded
      // as a fact rather than re-derived by whichever projection needs it.
      declaredAs: marker.name === 'compose.service' ? 'service' : 'base_image',
    },
  });
  builder.addEdge({ from: moduleId, to: componentId, kind: 'deploys', confidence: 'EXPLICIT', evidence: [markerEvidence] });

  // Only a service states a build context. A base image says nothing about which source is
  // inside the image built from it.
  if (marker.name === 'compose.service') {
    attributeBuildContext(builder, file, marker, componentId, markerEvidence, moduleByPath);
  }
}

/**
 * Attributes the code inside a declared build context to the container built from it.
 *
 * A compose service that names `build: ./api` states that the image is built from the
 * `api` directory, which is the only statement in a repository that connects source code to
 * a runtime unit. Without this, no application module can be placed inside any container
 * and C4 level 3 has nothing to show. It is extraction rather than inference in the
 * projection, because the relationship belongs in the canonical graph where it can be
 * compared across snapshots like any other fact.
 *
 * Confidence is `STRONGLY_INFERRED`, not `EXPLICIT`: the build context says what is *sent*
 * to the builder, not what a Dockerfile ends up copying. The caveat travels with the edge
 * in its attributes, and the C4 projection carries the confidence through unchanged.
 *
 * Containment: the context path comes from an untrusted repository file. It is only ever
 * compared against paths already inside the analysed repository — no filesystem access
 * happens here — and a context that resolves outside the repository is ignored, because
 * honouring it would mean attributing code this analysis never read.
 */
function attributeBuildContext(
  builder: SoftwareGraphBuilder,
  file: ParsedFileRef,
  marker: ParsedFileRef['markers'][number],
  componentId: string,
  markerEvidence: EvidenceRef,
  moduleByPath: ReadonlyMap<string, string>,
): void {
  if (marker.name !== 'compose.service') return;

  const context = buildContextDirectory(file.path, marker.attributes.build);
  if (context === null) return;

  for (const [path, moduleId] of moduleByPath) {
    if (!isInsideDirectory(path, context)) continue;
    // The declaring file's own edge is already EXPLICIT; re-adding it here would merge and
    // downgrade it (D-007), which would understate a fact the repository states directly.
    if (path === file.path) continue;

    builder.addEdge({
      from: moduleId,
      to: componentId,
      kind: 'deploys',
      confidence: 'STRONGLY_INFERRED',
      evidence: [markerEvidence],
      attributes: {
        derivedFrom: 'compose.build_context',
        buildContext: context,
        caveat: 'The build context states what is sent to the image builder, not what the Dockerfile copies.',
      },
    });
  }
}

/**
 * Resolves a declared build context to a repository-relative directory.
 *
 * Returns `null` when the context is absent, absolute, or escapes the repository — all
 * cases where this analysis cannot know which code is involved.
 */
function buildContextDirectory(declaringPath: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const value = raw.trim();
  if (posix.isAbsolute(value) || /^[a-z]+:/i.test(value)) return null;

  const baseDir = posix.dirname(toPosixPath(declaringPath));
  const resolved = posix.normalize(posix.join(baseDir === '.' ? '' : baseDir, value));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved === '.' ? '' : resolved;
}

/** True when `path` is `directory` itself or inside it. An empty directory matches all. */
function isInsideDirectory(path: string, directory: string): boolean {
  if (directory.length === 0) return true;
  return path === directory || path.startsWith(`${directory}/`);
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
/**
 * Phase 4: what an interaction hands back.
 *
 * A call relationship says A invoked B. It does not say B handed anything back, and drawing a
 * return arrow from it would be the single easiest way to make a sequence diagram confident and
 * wrong. So returns and throws come from `return`, `await`, `throw` and response statements in
 * the source, recorded at the site that states them.
 *
 * Three relationship kinds are produced, and the direction is what makes them meaningful:
 *
 * - `returns`, callee → caller. At `return service.find(id)` the caller hands the callee's value
 *   to *its* caller, so the arrow points at the caller. It is created only when the callee
 *   resolves to a declared entity: an unresolved callee has no node to point from.
 * - `throws`, callee → caller. Created when the callee's body contains an explicit failure site.
 *   The evidence is the throw statement inside the callee, which is what establishes the claim.
 * - `http.response`, function → endpoint. The endpoint node is the requester side, so the arrow
 *   from the handler back to the endpoint is what a response is, in graph terms.
 */
function addReturnFacts(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  parsed: readonly ParsedFile[],
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const staged: StagedAttributes = new Map();

  for (const file of parsed) {
    addReturnStatements(builder, evidence, file, symbolIndex, staged);
    addBindingReturns(builder, evidence, file, symbolIndex);
    addThrowRelationships(builder, evidence, file, symbolIndex, staged);
    addHttpResponses(builder, evidence, file, symbolIndex, staged);
  }
  flushAttributes(builder, staged);
}

/**
 * Staged node-attribute updates, keyed by node id.
 *
 * `addNode` keeps whatever attributes a node already has, so a count written from two passes
 * silently keeps only the first value. Updates are collected here and written once per node, which
 * is also why the counts can be trusted to be counts.
 */
type StagedAttributes = Map<string, Record<string, AttributeValue>>;

function stageAttributes(staged: StagedAttributes, id: string, patch: Record<string, AttributeValue>): void {
  const existing = staged.get(id);
  staged.set(id, existing ? { ...existing, ...patch } : patch);
}

function flushAttributes(builder: SoftwareGraphBuilder, staged: StagedAttributes): void {
  for (const [id, patch] of staged) {
    const node = builder.getNode(id);
    if (!node) continue;
    builder.addNode({ ...node, attributes: { ...(node.attributes ?? {}), ...patch } });
  }
}

/**
 * Connects a returned local to the call its value came from.
 *
 * `const rows = await findAll(); return rows;` names neither the callee nor a type in the return
 * statement, so the connection is an inference rather than a stated return — and it is labelled
 * that way: `WEEKLY_INFERRED`, `inferred: true`, with the variable named so a reader can check
 * it. A direct `return findAll()` stays `STRONGLY_INFERRED` because the return statement names
 * the callee.
 *
 * Only a variable with exactly one binding is used. If `rows` is assigned twice, the value that
 * is returned is not established, and no relationship is created.
 */
function addBindingReturns(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFile,
  symbolIndex: ReadonlyMap<string, SymbolRef>,
): void {
  const bindingsByName = new Map<string, { callee: string; awaited: boolean; line: number; scope: string }[]>();
  for (const binding of file.bindings ?? []) {
    if (!binding.fromQualifiedName) continue;
    const key = `${binding.fromQualifiedName}::${binding.name}`;
    const list = bindingsByName.get(key);
    const entry = { callee: binding.callee, awaited: binding.awaited === true, line: binding.line, scope: binding.fromQualifiedName };
    if (list) list.push(entry);
    else bindingsByName.set(key, [entry]);
  }
  if (bindingsByName.size === 0) return;

  for (const returned of file.returns ?? []) {
    if (!returned.fromQualifiedName || returned.kind !== 'identifier' || !returned.name) continue;
    const candidates = bindingsByName.get(`${returned.fromQualifiedName}::${returned.name}`) ?? [];
    if (candidates.length !== 1) continue;

    const binding = candidates[0]!;
    const callee = resolveCallee(binding.callee, symbolIndex);
    const caller = symbolIndex.get(binding.scope);
    if (!callee || !caller) continue;

    const bindingEvidence = evidence.add({
      kind: 'CALL_SITE',
      path: file.path,
      startLine: binding.line,
      endLine: binding.line,
      symbol: returned.name,
      excerpt: `const ${returned.name} = ${binding.awaited ? 'await ' : ''}${binding.callee}(…)`,
      producer: file.producer,
    });

    builder.addEdge({
      from: callee.id,
      to: caller.id,
      kind: 'returns',
      // Weaker than a direct `return callee()`: the return statement names a variable, and the
      // link to this call runs through its assignment.
      confidence: 'WEEKLY_INFERRED',
      evidence: [bindingEvidence, ...(returned.line !== binding.line
        ? [
            evidence.add({
              kind: 'CALL_SITE',
              path: file.path,
              startLine: returned.line,
              endLine: returned.line,
              symbol: returned.name,
              excerpt: `return ${returned.expression ?? returned.name}`,
              producer: file.producer,
            }),
          ]
        : [])],
      attributes: {
        returnKind: 'identifier',
        inferred: true,
        via: returned.name,
        ...(binding.awaited || returned.awaited ? { awaited: true } : {}),
      },
    });
  }
}

/**
 * Records what each function returns, and the return relationship a `return <call>` establishes.
 *
 * `hasReturn` and `returnCount` are recorded on the function so "returns nothing" and "returns
 * something this extractor could not read" are different facts in the graph rather than the same
 * absence.
 */
function addReturnStatements(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFile,
  symbolIndex: ReadonlyMap<string, SymbolRef>,
  staged: StagedAttributes,
): void {
  // Caller → callee, so a `return callee(…)` can be turned into a callee → caller relationship.
  const calleesByCaller = new Map<string, Set<string>>();
  for (const call of file.calls) {
    if (!call.fromQualifiedName) continue;
    const caller = symbolIndex.get(call.fromQualifiedName);
    const callee = resolveCallee(call.callee, symbolIndex);
    if (!caller || !callee) continue;
    const set = calleesByCaller.get(call.fromQualifiedName);
    if (set) set.add(callee.id);
    else calleesByCaller.set(call.fromQualifiedName, new Set([callee.id]));
  }

  for (const returned of file.returns ?? []) {
    const scope = returned.fromQualifiedName ? symbolIndex.get(returned.fromQualifiedName) : undefined;
    if (!scope) continue;

    const returnEvidence = evidence.add({
      kind: 'CALL_SITE',
      path: file.path,
      startLine: returned.line,
      endLine: returned.line,
      symbol: returned.name ?? 'return',
      excerpt: `return ${returned.expression ?? returned.kind}`,
      producer: file.producer,
    });

// Function-level fact: this function has a return, and what shape it returned. Staged, so a
    // second return statement in the same function raises the count instead of being dropped.
    const stagedFor = staged.get(scope.id);
    stageAttributes(staged, scope.id, {
      hasReturn: true,
      returnCount: (Number(stagedFor?.returnCount ?? 0) || 0) + 1,
      returnsShape: returned.kind,
      ...(returned.awaited ? { returnsAwaited: true } : {}),
    });

// Return relationship: callee → caller, for a `return <call>`.
    if (!returned.name) continue;
    const callee = symbolIndex.get(returned.name);
    // A relationship from a function to itself asserts nothing: a function does not hand its
    // value to itself. It appears when a name resolves to the declaration that encloses the use,
    // which is what a builtin shadowed by a method name does - `return list(...)` inside a method
    // called `list`. Drawing it would put a loop in a sequence view that the code never states.
    if (callee && callee.id === scope.id) continue;
    const candidates = calleesByCaller.get(returned.fromQualifiedName!) ?? new Set<string>();
    // The returned call is the one whose result this statement returns. Matching by name is
    // resolved against declared entities, so a returned expression that names nothing declared
    // simply produces no relationship rather than a guessed one.
    if (callee && candidates.has(callee.id)) {
      builder.addEdge({
        from: callee.id,
        to: scope.id,
        kind: 'returns',
        // The return statement is explicit; which value it hands back is not resolved to a
        // type, so the relationship is strong inference rather than explicit.
        confidence: 'STRONGLY_INFERRED',
        evidence: [returnEvidence],
        attributes: {
          returnKind: returned.kind,
          ...(returned.awaited ? { awaited: true } : {}),
          ...(returned.expression ? { expression: returned.expression } : {}),
        },
      });
    }
  }
}

/**
 * Records that a function can fail, and links it to the callers that may see the failure.
 *
 * Only explicit failure sites count: `throw`, `reject`, `Promise.reject`, `raise`. A function
 * with no throw record is not asserted to be safe — it is only asserted to have no *recorded*
 * failure site, which is what the omission log says.
 */
function addThrowRelationships(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFile,
  symbolIndex: ReadonlyMap<string, SymbolRef>,
  staged: StagedAttributes,
): void {
  // Callers come from the call graph, not from this file's own calls. A callee that throws is
  // almost always called from somewhere else — reading callers from `file.calls` would find
  // nothing and silently drop the relationship.
  const callersByCallee = new Map<string, Set<string>>();
  for (const edge of builder.allEdges()) {
    if (edge.kind !== 'calls') continue;
    const set = callersByCallee.get(edge.to);
    if (set) set.add(edge.from);
    else callersByCallee.set(edge.to, new Set([edge.from]));
  }
  if (callersByCallee.size === 0) return;

  const throwSites = new Map<string, number>();

  for (const thrown of file.throws ?? []) {
    const scope = thrown.fromQualifiedName ? symbolIndex.get(thrown.fromQualifiedName) : undefined;
    if (!scope) continue;
    throwSites.set(scope.id, (throwSites.get(scope.id) ?? 0) + 1);

    const throwEvidence = evidence.add({
      kind: 'CALL_SITE',
      path: file.path,
      startLine: thrown.line,
      endLine: thrown.line,
      symbol: thrown.expression ?? thrown.via,
      excerpt: thrown.via === 'throw' ? `throw ${thrown.expression ?? ''}`.trim() : `reject ${thrown.expression ?? ''}`.trim(),
      producer: file.producer,
    });

for (const callerId of callersByCallee.get(scope.id) ?? []) {
      // A function cannot fail on itself; see the note on self-directed returns.
      if (callerId === scope.id) continue;
      builder.addEdge({
        from: scope.id,
        to: callerId,
        kind: 'throws',
        confidence: 'STRONGLY_INFERRED',
        evidence: [throwEvidence],
        attributes: {
          via: thrown.via,
          ...(thrown.inAsyncFunction ? { rejects: true } : {}),
          ...(thrown.expression ? { expression: thrown.expression } : {}),
        },
      });
    }
  }

// The count lives on the function so a reader can see how many failure sites were found
  // without traversing to every caller.
  for (const [functionId, count] of throwSites) {
    stageAttributes(staged, functionId, { throwSites: count });
  }
}

/**
 * Records an HTTP response as a fact about the handler that wrote it.
 *
 * The arrow points from the handler to the endpoint node when the handler is the one a route
 * names, because the endpoint is the requester side of the interaction. A response written by
 * a function no route names is recorded on the function alone, with no relationship, because
 * there is no requester in the graph to point at.
 */
function addHttpResponses(
  builder: SoftwareGraphBuilder,
  evidence: EvidenceStore,
  file: ParsedFile,
  symbolIndex: ReadonlyMap<string, SymbolRef>,
  staged: StagedAttributes,
): void {
  if ((file.responses?.length ?? 0) === 0) return;

  // Endpoint → handler, from the route.handler edges the marker pass already created.
  const handlerEndpoints = new Map<string, string[]>();
  for (const edge of builder.allEdges()) {
    if (edge.kind !== 'calls' || edge.attributes?.derivedFrom !== 'route.handler') continue;
    const list = handlerEndpoints.get(edge.to);
    if (list) list.push(edge.from);
    else handlerEndpoints.set(edge.to, [edge.from]);
  }

  const markersByScope = new Map<string, Marker[]>();
  for (const marker of file.markers) {
    if (marker.name !== 'http.response') continue;
    const scope = typeof marker.attributes.scope === 'string' ? marker.attributes.scope : undefined;
    if (!scope) continue;
    const list = markersByScope.get(scope);
    if (list) list.push(marker);
    else markersByScope.set(scope, [marker]);
  }

  for (const [scopeName, markers] of markersByScope) {
    const scope = symbolIndex.get(scopeName);
    if (!scope) continue;

    for (const marker of markers) {
      const responseEvidence = evidence.add({
        kind: 'ROUTE_DECLARATION',
        path: file.path,
        startLine: marker.line,
        endLine: marker.line,
        symbol: scopeName,
        excerpt: `${String(marker.attributes.method ?? 'response')}${marker.attributes.status ? ` ${String(marker.attributes.status)}` : ''}`,
        producer: file.producer,
      });

      const endpoints = handlerEndpoints.get(scope.id) ?? [];
      for (const endpoint of endpoints) {
        builder.addEdge({
          from: scope.id,
          to: endpoint,
          kind: 'returns',
          confidence: 'EXPLICIT',
          evidence: [responseEvidence],
          attributes: {
            httpResponse: true,
            method: marker.attributes.method ?? 'response',
            ...(marker.attributes.status ? { status: marker.attributes.status } : {}),
            ...(marker.attributes.payload ? { payload: marker.attributes.payload } : {}),
            ...(marker.attributes.payloadKind ? { payloadKind: marker.attributes.payloadKind } : {}),
          },
        });
      }

if (endpoints.length === 0) {
        // No route names this function, so there is no requester to point at. The response is
        // still a fact about the code and is counted on the function node - otherwise a response
        // written outside any route handler would leave no trace in the graph at all.
      }

      const stagedFor = staged.get(scope.id);
      const known = typeof stagedFor?.httpResponseStatuses === 'string' ? stagedFor.httpResponseStatuses : '';
      const status = marker.attributes.status;
      const statusText = status === undefined ? '' : String(status);
      stageAttributes(staged, scope.id, {
        httpResponses: (Number(stagedFor?.httpResponses ?? 0) || 0) + 1,
        ...(statusText && !known.split(',').includes(statusText)
          ? { httpResponseStatuses: known ? `${known},${statusText}` : statusText }
          : {}),
      });
    }
  }
}
