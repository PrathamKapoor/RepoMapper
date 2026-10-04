# RepoAtlas — Execution Flow

Real code names, real call order. Each stage explains **why it exists**, what it receives,
what it emits, and how it fails.

Entry points:

```
HTTP   POST /api/analyses       packages/server/src/app.ts
CLI    node packages/server/dist/cli.js   packages/server/src/cli.ts
```

Both call the same function, so a CLI result and an API result for the same repository are
identical by construction (D-006).

---

## 1. The whole pipeline

```
runAnalysis()                          packages/server/src/analyze.ts
 │
 ├─ resolveRepositoryRoot()            packages/ingest/src/path-safety.ts
 │    Why: decides, in one place, what may be read. Everything downstream trusts it.
 │
 ├─ discoverFiles()                    packages/ingest/src/discover.ts
 │    Why: produces the bounded, sorted, deterministic file list.
 │
 ├─ readGitMetadata()                  packages/ingest/src/git.ts
 │    Why: commits, contributors and ownership are facts the repository states.
 │
  ├─ parseFiles()                       packages/parsers/src/registry.ts
  │    └─ TypeScriptSourceParser.parse()   packages/parsers/src/typescript.ts
  │    └─ PythonSourceParser.parse()       packages/parsers/src/python.ts
  │    └─ ConfigSourceParser.parse()       packages/parsers/src/config.ts
  │    Why: deterministic extraction only. A parser reports what a file states.
  │         Each read also yields a content digest (§6a).
  │
  ├─ buildGraph()                       packages/core/src/graph-builder.ts
  │    Why: the single place nodes and edges are created.
  │
  ├─ createSnapshot()                   packages/core/src/snapshot.ts
  │    Why: the repository state a later analysis will be compared against (§7).
  │
  ├─ projectAtlas()                     packages/artifacts/src/index.ts
  │    ├─ buildDependencyGraph()        packages/artifacts/src/dependency-graph.ts
  │    ├─ buildModuleGraph()            packages/artifacts/src/dependency-graph.ts
  │    ├─ buildClassDiagram()           packages/artifacts/src/class-diagram.ts
  │    ├─ buildErDiagram()              packages/artifacts/src/er-diagram.ts
  │    ├─ buildC4(context)              packages/artifacts/src/c4.ts
  │    ├─ buildC4(container)
  │    ├─ buildC4(component)
  │    └─ analyseGaps()                 packages/artifacts/src/gaps.ts
  │         Why: projections read the graph. They cannot create facts.

  compareSnapshots(base, target)        packages/core/src/drift.ts
       ├─ createSnapshot()                    both sides already exist as stored graphs
       ├─ indexById(nodes) / indexById(edges) / indexById(evidence)
       ├─ detectRenames(removed, added)       content digest, not name similarity
       └─ changes.sort(compareChanges)        byte-identical output for the same pair
```

Input: an absolute repository path.
Output: `RunAnalysisOutput` — the analysis record, the graph, statistics, artifact
projections, the gap report, diagnostics, per-file parse results and the skip list.

---

## 6a. Content digests

```
runAnalysis()                                        packages/server/src/analyze.ts
  └─ parseFiles(..., readFile: (absolutePath, path) => …)
       └─ contentDigest(text)               packages/server/src/analyze.ts
            └─ buildGraph({ digestByPath })  packages/core/src/graph-builder.ts
                 └─ GraphNode.digest on every module node
```

`parseFiles()` passes the repository-relative path alongside the absolute one
(`packages/parsers/src/registry.ts`) so the caller can key derived data by path. The digest
is `sha256` of the decoded text with `\r\n` normalised to `\n`, computed inside the read each
file already requires, so hashing adds no I/O.

**Why it exists.** It is what makes a rename provable rather than guessed (D-029): two module
nodes with the same digest under different paths are the same bytes. It is also what makes
"the file did not change" decidable, so a whitespace-only edit elsewhere in a repository does
not report every module as modified.

**Absence is normal.** A caller that cannot supply digests still gets a valid graph; those
modules simply have no `digest`, and the drift engine then reports removed plus added rather
than claiming a rename.

---

## 2. Path containment

```
resolveRepositoryRoot(inputPath, allowedRoots)      packages/ingest/src/path-safety.ts
 ├─ resolveRealPath()                     realpath() — follows every symlink
 └─ isInside(root, candidate)              relative() on resolved paths
```

**Why this runs first.** A repository is untrusted and may contain symlinks pointing
anywhere on the host. Resolving before comparing means the check is on the real target,
not on the string a caller supplied.

- Rejects paths outside `REPOATLAS_ALLOWED_ROOTS` with `PATH_NOT_ALLOWED` (403).
- Raises `PATH_NOT_FOUND` (404) for a missing path.
- When `allowedRoots` is empty, no allow-list is enforced. This is reported by
  `/api/health` as `pathAllowListEnforced: false` so the exposure is visible.

Per-file containment:

```
discoverFiles()
 └─ resolveInsideRoot(root, relativePath)           packages/ingest/src/path-safety.ts
      Why: a symlink inside the repo may point outside it. Returns null → recorded as
           skipped with reason 'symlink_escape'.
```

---

## 3. File discovery

```
discoverFiles(root, options, diagnostics)            packages/ingest/src/discover.ts
 │
 ├─ IgnoreStack.push(dir)                            packages/ingest/src/ignore-stack.ts
 │    Why: .gitignore can exist at any level; nested files override parents. Layers are
 │         pushed on entry and popped on exit.
 │
 ├─ realpath(dir) → visitedRealDirs                  cycle guard
 │    Why: a symlink loop would otherwise walk forever.
 │
 └─ per entry, in sorted order:
      ├─ resolveInsideRoot()                        containment (above)
      ├─ excludedDirectories.has(name)               → excludedDirectories[]
      ├─ isIgnoredDirectory()                        → prune the subtree
      ├─ hasBinaryExtension()                        → skipped 'binary'
      ├─ excludePatterns                             → skipped 'ignored_by_default'
      ├─ isBinaryFile()                              content sniff → skipped 'binary'
      │     packages/ingest/src/binary.ts
      ├─ ignoreStack.isIgnored()                     → skipped 'ignored_by_vcs'
      ├─ size > maxFileBytes                         → skipped 'too_large'
      ├─ files.length >= maxFiles                    → truncated, diagnostic
      └─ totalBytes + size > maxTotalBytes           → truncated, diagnostic
```

**Output ordering is guaranteed.** Entries are sorted per directory and results are sorted
before return, so two runs over the same tree produce identical input. Determinism is a
precondition for graph comparison (D-010).

**Binary is classified before "unsupported extension"** so an image is reported as
`binary` — the more informative reason — rather than as an unknown file type.

---

## 4. Git metadata

```
readGitMetadata(root, diagnostics, { includeHistory, maxCommits })
                                                        packages/ingest/src/git.ts
 ├─ looksLikeGitRepository()                  .git present?
 ├─ runGit(['rev-parse', 'HEAD'])             execFile, fixed argv, no shell
 ├─ runGit(['rev-parse', '--abbrev-ref','HEAD'])
 ├─ runGit(['ls-files', '-z'])
 └─ readCommits()
      └─ runGit(['log', '--pretty=format:...'])
```

**Security posture.** No command found inside a repository is ever executed.

- `execFile` with a fixed argv — never a shell, so no metacharacter interpretation.
- Repository-provided git config is neutralised with `-c` overrides:
  `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.pager=cat`,
  `protocol.ext.allow=never`, `protocol.file.allow=never`, `credential.helper=`,
  `diff.external=`, `GIT_CONFIG_NOSYSTEM=1`.
- Scrubbed environment; fixed 20 s timeout; output capped at 32 MB.
- History is parsed from a control-character-delimited machine format, because author
  names and subjects contain newlines and any separator we chose.

**Failure path.** A missing git binary, a non-repository, or a corrupt object store all
yield `available: false` plus an `info` diagnostic. Analysis proceeds without history.
This is the expected result for an exported archive.

---

## 5. Parsing

```
parseFiles(files, registry, options, diagnostics)   packages/parsers/src/registry.ts
 └─ ParserRegistry.select(context)                   packages/parsers/src/registry.ts
      └─ parser.parse(source, context) → ParsedFile
```

Selection is by language detected from the extension during ingestion. Order matters:
specific parsers are tried before the catch-all configuration scanner, so `tsconfig.json`
is never handed to a source parser.

`ParsedFile` contains `imports`, `entities`, `calls`, `markers`, `problems`, `durationMs`.

### 5a. TypeScript / JavaScript

```
TypeScriptSourceParser.parse(source, context)       packages/parsers/src/typescript.ts
 ├─ ts.createSourceFile(..., setParentNodes: false)
 ├─ read parseDiagnostics                          syntax errors recorded, not thrown
 └─ visit(statement, ctx)
      ├─ import/export/require declarations        → imports[]
      ├─ describeDeclaration(node)                 → entities[]
      │    └─ opensScope only for callable containers
      ├─ handleCallExpression(node)
      │    ├─ ImportKeyword                        → dynamic import
      │    ├─ calleeName()                        → calls[]
      │    ├─ routeMarker()                        → http.route marker
      │    ├─ middlewareMarker()                   → middleware.mount marker
      │    └─ testMarker()                         → test.case / test.suite marker
      └─ push/pop ctx.stack around scoped bodies
```

**Why `opensScope` is explicit.** Only callable containers own the code inside them. A
`const value = compute(x)` does not make `compute` a call made *by* `value`; treating it
as a scope produced nonsense qualified names like `handler.value` and a wrong call graph.

**`getText()` always receives `ctx.sourceFile`.** With `setParentNodes: false` a node
cannot find its source file by walking parents, and an argument-less `getText()` throws
— which previously aborted the rest of each file's parse (D-009).

### 5b. Python

```
PythonSourceParser.parse(source, context)           packages/parsers/src/python.ts
 ├─ tokenize(source) → LogicalLine[]
 │    ├─ stripLine()  per physical line
 │    │    ├─ code view: comments removed, string bodies blanked
 │    │    └─ raw  view: comments removed, strings intact
 │    └─ bracket + triple-quote + backslash continuation handling
 ├─ report PY_UNTERMINATED_LITERAL if a literal is left open
 └─ per logical line:
      ├─ from/import statements      → imports[]
      ├─ def / class                 → entities[]  (indent stack → qualified names)
      ├─ UPPER_CASE assignment        → constants
      ├─ collectCalls()               → calls[]
      └─ pythonMarker(line.raw)      → http.route / async.task markers
```

**Why two views.** Definitions are detected on `code` so a `def` inside a docstring is
invisible. Markers are detected on `raw` because a route path is a string value — reading
it from the blanked view made route detection impossible (fixed in this phase).

Scope comes from indentation, which is Python's block structure. This is not a complete
Python grammar; anything requiring evaluation is reported as a marker or a problem rather
than guessed at.

### 5c. Configuration, manifest and infrastructure

```
ConfigSourceParser.parse(source, context)           packages/parsers/src/config.ts
 ├─ package.json          → manifest.dependency / manifest.script / manifest.entrypoint
 ├─ docker-compose.yml    → compose.service
 ├─ Dockerfile            → docker.base_image / docker.expose / docker.build_stage
 ├─ *.sql                 → schema.table + schema.column  (tables emitted first)
 └─ other JSON / YAML     → config.key
```

---

## 6. Graph construction

```
buildGraph(input)                                     packages/core/src/graph-builder.ts
 │
 ├─ PASS 1: repository node                          EXPLICIT
 │
 ├─ PASS 2: one module node per analyzable file
 │    └─ repository --contains--> module
 │
 ├─ PASS 3: index every symbol                       ← complete before any resolution
 │    └─ symbolIndex: qualifiedName, name → { id, filePath, kind }
 │
 ├─ PASS 4: entities + module --contains--> entity   EXPLICIT
 │
 ├─ PASS 5: inheritance
 │    └─ extends / implements, restricted to type kinds, STRONGLY_INFERRED
 │
 ├─ PASS 6: imports
 │    ├─ resolveImportPath()  → imports edge (EXPLICIT) for in-repo targets
 │    ├─ external             → package node + depends_on (EXPLICIT)
 │    └─ unresolved           → DANGLING_REFERENCE diagnostic
 │
 ├─ PASS 7: calls
 │    └─ resolveCallee() → calls edge, STRONGLY_INFERRED (caller known)
 │                                     WEEKLY_INFERRED (module-level)
 │
  ├─ PASS 8: markers → endpoints, tables, columns, tests, deployment components, config
  │    └─ addDeploymentComponent()                 EXPLICIT deploys edge
  │         └─ attributeBuildContext()              modules inside a compose `build:` context
  │                                              → deploys edge, STRONGLY_INFERRED
  │
  └─ PASS 9: git facts → commit, contributor, authored_by, modifies
```

**Pass 3 is why inheritance works at all.** Indexing during entity creation made
resolution depend on file order, so a class extending a later-declared base silently lost
its edge (D-010).

**`attributeBuildContext()` is the only rule that connects source code to a runtime unit.**
A compose service declaring `build: ./api` states that the image is built from `api/`, so
every module under that directory gets a `deploys` edge to the service at
`STRONGLY_INFERRED`, citing the compose marker. The declaring compose file's own `EXPLICIT`
edge is skipped, because re-adding it would merge and downgrade it (D-007). An absolute
context, or one that resolves outside the repository, is ignored: the value is untrusted text
and no filesystem access happens (D-034).

Confidence assignment:

| Relation | Confidence | Reason |
|---|---|---|
| declaration, import statement, route, manifest field, schema DDL, commit | `EXPLICIT` | the file literally states it |
| inheritance, call with a resolved callee | `STRONGLY_INFERRED` | the statement exists; the target identity was resolved by us |
| module inside a declared build context | `STRONGLY_INFERRED` | the context says what is sent to the builder, not what is copied |
| call from a module with no identified caller | `WEEKLY_INFERRED` | weaker claim about the origin |
| unresolvable | *not created* | no edge rather than a guessed one |

Nothing is created without an evidence citation. Deduplication is by deterministic id
(D-019); merging keeps the weaker confidence.

---

## 7. Projection and gap analysis

```
projectAtlas(graph)                                   packages/artifacts/src/index.ts
  ├─ computeStats(graph)                              packages/core/src/graph.ts
  ├─ buildDependencyGraph()      imports | re_exports | depends_on, module→module/package
  ├─ buildModuleGraph()          contains | declared_in, module→entity
  ├─ buildClassDiagram()         class | interface | type, extends | implements
  ├─ buildErDiagram()            table (+ columns), explicit inter-table edges only
  ├─ buildC4(context)            repository → software_system;
  │                                 deployment_component + known image family → external_system
  ├─ buildC4(container)          deployment_component → container;
  │                                 cross-container imports/calls → depends_on
  ├─ buildC4(component)          module + deploys → component; module→module → depends_on
  └─ analyseGaps(graph)
  → buildSequence()           api_endpoint | cli_command | event_consumer, `calls`; messages only, no returns
  → buildActivity()           function | test, `branches` | `loops` edges; ordered by source line
  → buildDataFlow()           `reads` | `writes` | `communicates_with` only
  → checkConsistency()        compares every artifact above over one graph
       → projectionIntegrity        unsupported inference, per artifact
       → c4WithoutCode             container with no attributed module
       → requirementImplementation  declared requirement with no implementation
       → useCaseReachability       entry point with no reachable step
       → dataCoverage              table no analysed code reads or writes
       → behaviourCoverage         entry point with no tests relationship
       → crossArtefactAgreement    recorded agreement, so problems have context
       ├─ deploymentArchitecture   compose services, base images, deploys edges
       ├─ apiSurface               api_endpoint count
       ├─ dataStorage              tables, columns, reads/writes edges
      ├─ authentication           authenticates/authorizes edges, actors
      ├─ testCoverage             test nodes and tests edges
      ├─ documentationLinks       documents edges
      ├─ ownership                contributors, commits, authored_by
      ├─ requirements             requirement / use_case nodes, implements_requirement
      ├─ dependencyHygiene        declared-but-unimported, imported-but-undeclared
      └─ parseHealth              non-repository node count
```

Every artifact reports `omitted[]`, `insufficientEvidence` and a `scope` string, so an
incomplete view is never mistaken for a complete one (D-020).

Every `NOT_FOUND` gap reports `checked` and `whatWouldResolve`, and hedges where the
capability may live outside the repository (D-008). Two tests enforce this.

### 7a. C4 mapping rules

`buildC4()` (`packages/artifacts/src/c4.ts`) opens no file and re-derives nothing. Each level
reads the graph and decides which facts are C4 elements:

| Level | Element | Read from | Confidence | `supporting*` |
|---|---|---|---|---|
| context | `software_system` | `repository` node | carried through | node id |
| context | `external_system` | `deployment_component` + `detectInfrastructureFamily()` match on `attributes.image` | `WEEKLY_INFERRED` | node ids |
| context | `person` | — never emitted | — | — |
| container | `container` | `deployment_component` | carried through | node id |
| container | `depends_on` | `imports`/`calls` between modules in different containers | `weakestConfidence(supporting)` | edge ids |
| component | `component` | `module` in `attributeModulesToContainers()` | carried through | edge ids (`deploys`) |
| component | `depends_on` | `imports`/`calls` between two attributed modules | carried through | edge ids |

Two filters in `attributeModulesToContainers()` decide what may be placed inside a container:
the `deploys` source must be a module, and the module must not be the deployment file that
declares the container (a compose file is not part of the service it describes).

`finish()` is the integrity gate, and it runs before anything reaches a renderer:

1. drop any relationship with no `supportingEdgeIds` and no `supportingNodeIds`;
2. drop any relationship whose endpoints are not both nodes of this level;
3. record each drop in `omitted[]`, sorted by id for reproducibility.

Both gates are asserted for every level in `packages/artifacts/test/c4.test.ts`
("never emits a relationship with no graph fact behind it", "never emits a relationship whose
endpoints are not in the same level").

---

## 7b. Snapshots and drift

```
createSnapshot(input)                                  packages/core/src/snapshot.ts
  ├─ computeGraphDigest(graph, extractorVersion)
  │    └─ sha256 over: extractorVersion, schemaVersion,
  │                     every node, edge and evidence record (sorted),
  │                     attributes via stableStringify()
  └─ snapshotIdFrom(graphDigest, schemaVersion) → snap_<16 hex>

incomparabilityReason(a, b)                            packages/core/src/snapshot.ts
  └─ null | "Extractor versions differ …" | "Graph schema versions differ …"

compareSnapshots(base, target, options)                 packages/core/src/drift.ts
  ├─ incomparable → report with comparable: false, no changes
  ├─ identical digest → report with identical: true, no changes
  ├─ NODES    indexById ×2 → modified / added / removed, then detectRenames()
  ├─ EDGES    indexById ×2 → modified / added / removed
  ├─ EVIDENCE indexById ×2 → added / removed   (claimConfidence follows target completeness)
  ├─ CONFIDENCE_CHANGED per retained node and per retained edge
  └─ changes.sort(compareChanges)      category, then entityId
```

`detectRenames(removed, added)` pairs nodes only when kind, language and content digest all
match **and** the digest is unique on both sides. Anything else stays removed plus added
(D-029).

`indeterminate` and `claimConfidence` are separate from the entity's own confidence: they
describe the *claim that it is gone*, which is only assertable when the target analysis was
complete (D-028). A truncated target sets `removalConfidence: 'INDETERMINATE'` and attaches a
`reason` to every removal.

---

## 8. Persistence and API

```
AnalysisService.analyse(request)                     packages/server/src/service.ts
  ├─ admission control: concurrency (429), stored limit (507)
  ├─ runAnalysis()  with a hard timeout (504)
  ├─ createSnapshot()                            content identity for this state
  ├─ Store.saveAnalysis()            packages/server/src/store.ts   one transaction
  │    BEGIN → analyses → nodes → edges → evidence → diagnostics → artifacts → COMMIT
  │    analyses.graph_digest / extractor_version / graph_schema_version
  │    nodes.digest
  └─ on failure: Store.saveFailure() so failures stay visible

AnalysisService.getSnapshot(id)                       packages/server/src/service.ts
  ├─ record.status must be 'succeeded'      a failed analysis has no graph (D-032)
  ├─ Store.getGraph(id) → SoftwareGraph      rebuilt from rows, never cached
  └─ createSnapshot()                        identity recomputed, never stored stale

AnalysisService.compareAnalyses(a, b, options)       packages/server/src/service.ts
  ├─ getSnapshot() both sides
  ├─ order by createdAt          a caller cannot invert the report by swapping arguments
  └─ compareSnapshots(older, newer, { includeChanges, maxChanges })

buildApp()                                           packages/server/src/app.ts
  ├─ GET    /api/health
  ├─ GET    /api/meta
  ├─ GET    /api/analyses
  ├─ POST   /api/analyses                    → runAnalysis() → 201
  ├─ GET    /api/analyses/:id                → store + projectAtlas(stored graph)
  ├─ GET    /api/analyses/:id/graph           → filtered, no dangling edges
  ├─ GET    /api/analyses/:id/nodes/:nodeId   → node + neighbourhood + evidence
  ├─ GET    /api/analyses/:id/evidence
  ├─ GET    /api/analyses/:id/artifacts[/:kind]
  ├─ GET    /api/analyses/:id/snapshot        → provenance + stats, no graph
  ├─ GET    /api/analyses/:id/drift?against=<analysisId>
  │                                          → DriftReport; 400 without `against`
  ├─ GET    /api/analyses/:id/gaps
  → GET    /api/analyses/:id/requirements      → buildRequirements(stored graph)
  → GET    /api/analyses/:id/use-cases[/:useCaseId]
  → GET    /api/analyses/:id/consistency       → checkConsistency(stored graph)
  → GET    /api/analyses/:id/traceability[/:nodeId]
  → GET    /api/analyses/:id/lineage/:nodeId  → traceLineage(stored graph)
  ├─ GET    /api/analyses/:id/diagnostics
  └─ DELETE /api/analyses/:id
```

Notes that matter:

- `GET /api/analyses/:id` and `/gaps` and `/artifacts` **re-derive** from the stored graph
  rather than replaying a cached blob, so a projection change is visible without
  re-analysing. The same is true of `/snapshot`: its identity is recomputed from the stored
  graph, so an extractor or schema change cannot leave a stale identity behind.
- `GET /graph` filters nodes and then returns only edges whose endpoints survived, so the
  client never receives a dangling reference. It reports `truncated` and `totals` when a
  limit was hit.
- `/drift` requires `against`. A report with one side has no meaning, and defaulting to "the
  previous analysis" would silently pick whichever row happened to sort first.
- `/drift` reads no filesystem. It takes two analysis ids and nothing else, so the
  `REPOATLAS_ALLOWED_ROOTS` boundary is untouched by it.
- Request validation goes through `parseOrThrow()`, converting `ZodError` into a 400
  naming each offending field (D-016).
- The single not-found handler is owned by `buildApp()` and delegated, because Fastify
  permits one per prefix and throws on a second (D-013).

---

## 9. Web UI

```
main.tsx → App                                        packages/web/src/app.tsx
  ├─ api.ts          every fetch, typed against the server contract
  ├─ Tabs
  │    Overview        stats, languages, view availability, evidence coverage
  │    Architecture    dependency-graph and er-diagram
  │    C4              c4-context → c4-container → c4-component, progressive disclosure
  │    Structure       module-graph and class-diagram
  │    Drift           drift report for two selected analyses
  │    Evidence        entity index + evidence records
  │    Gaps            gap report with status, observations, checked list
  │    Diagnostics     every diagnostic from the run
  ├─ EntityDrawer                                     packages/web/src/entity-drawer.tsx
  │      Any entity, anywhere → node + relationships + evidence + confidence
  ├─ c4.tsx                                          packages/web/src/c4.tsx
  │      level selector → GraphView → C4ElementPanel (derivation, evidence, relationships)
  ├─ drift.tsx                                       packages/web/src/drift.tsx
  │      base/target selectors → summary → ChangeRow (evidence before | after)
  └─ presentation.ts                                 packages/web/src/presentation.ts
         analysisForChange() · driftState() · describeSupport() · defaultComparisonId()
```

`graph.tsx` renders an artifact deterministically (D-021) with confidence encoded as
solid versus dashed edges. Clicking a node opens the inspector, which is where a selected
entity connects across representations.

### 9a. The chain the UI must preserve

```
C4 element  ──derivation, graphNodeIds──▶  graph entity  ──▶  relationships
                                                            ──▶  evidence  ──▶  file:line

drift item  ──entityId──▶  entity in the snapshot it belongs to  ──▶  evidence before / after
```

Two rules make that chain honest:

- **The inspector carries its own analysis id.** A drift row that is a removal belongs to the
  *base* snapshot, whose entity does not exist in the analysis selected in the sidebar.
  `analysisForChange()` picks the side; opening the wrong one would 404 and read as a broken
  link rather than a correct answer.
- **Unknown is never rendered as unchanged.** `driftState()` returns `identical`,
  `incomparable`, `changed` or `unknown`, and the four render differently. A failed request and
  a report with no differences must not look the same.

`presentation.ts` holds these decisions as pure functions so they can be tested without a DOM.
There is no browser test in this repository, so nothing verifies that React renders these
screens — see `docs/verification.md`.

---

## 10. Storage schema

```
schema_meta     key, value                        schema_version
analyses        id, repository_path, label, status, timings, head_commit, branch,
                error_json, summary_json, warnings_json,
                graph_digest, extractor_version, graph_schema_version
nodes           (analysis_id, id) PK, kind, name, qualified_name, language, path,
                start_line, end_line, digest, confidence, attributes_json, evidence_json
edges           (analysis_id, id) PK, from_id, to_id, kind, confidence, label,
                attributes_json, evidence_json
evidence        (analysis_id, id) PK, kind, path, start_line, end_line, symbol,
                excerpt, producer
diagnostics     (analysis_id, seq) PK, code, severity, message, path, detail_json
artifacts       (analysis_id, kind) PK, title, format, body_json
```

`analyses.graph_digest` and `extractor_version` are stored so identity is queryable without
re-reading the graph. They are still **recomputed** on read by `getSnapshot()`; the stored
copy is a convenience and an audit trail, not the authority (D-026).

Indexes: `analyses(created_at)`, `analyses(repository_path, created_at)`,
`nodes(analysis_id, kind)`, `nodes(analysis_id, path)`, `edges(analysis_id, kind)`,
`edges(analysis_id, from_id)`, `edges(analysis_id, to_id)`, `evidence(analysis_id, path)`.

---

## Error paths, summarised

| Condition | Code | HTTP | Behaviour |
|---|---|---|---|
| Path does not exist | `PATH_NOT_FOUND` | 404 | analysis aborted |
| Path outside allow-list | `PATH_NOT_ALLOWED` | 403 | analysis aborted |
| Not a directory | `PATH_NOT_A_DIRECTORY` | 400 | analysis aborted |
| Malformed request body | `BAD_REQUEST` | 400 | field-level message |
| No analyzable files | `REPOSITORY_EMPTY` | 201 | analysis succeeds, graph has only the repository node, gap analysis explains |
| Malformed `package.json` | `CONFIG_INVALID_JSON` | 201 | recorded as a warning; the run continues |
| Syntax error in a file | `PARSE_FAILED` | 201 | recorded; whatever parsed before the error is kept |
| Binary / oversized file | — | 201 | skipped with a reason; never read as text |
| Symlink escaping the root | — | 201 | skipped as `symlink_escape` |
| Unresolvable relative import | `DANGLING_REFERENCE` | 201 | no edge created; recorded |
| File / byte / node / edge limit | `*_LIMIT_REACHED` | 201 | analysis marked `truncated: true` |
| Analysis exceeded timeout | `INTERNAL_ERROR` | 504 | abandoned; failure recorded |
| Server at concurrency limit | `INTERNAL_ERROR` | 429 | retry shortly |
| Stored-analysis limit reached | `INTERNAL_ERROR` | 507 | delete an analysis first |
| Uploaded archive malformed | `ARCHIVE_INVALID` | 400/415 | extraction refused |
| Archive entry escapes destination | `ARCHIVE_ENTRY_UNSAFE` | 201 | entry skipped, diagnostic recorded |
| Archive too large / too many entries | `ARCHIVE_TOO_LARGE`, `ARCHIVE_ENTRY_COUNT_EXCEEDED` | 413 | extraction aborted |
| `/drift` without `against`, or a malformed id | `BAD_REQUEST` | 400 | field-level message |
| `/drift` against an unknown analysis | `NOT_FOUND` | 404 | no report invented |
| `/drift` against a failed analysis | `NOT_FOUND` | 404 | "could not be loaded as snapshots" (D-032) |
| Snapshots from different extractor/schema versions | — | 200 | `comparable: false` + `incomparabilityReason`, zero changes |

**Every row above was exercised by a test or a container verification.** See
`docs/verification.md`.

---

## What is not wired up yet

Stated so this document is not read as a claim of completeness:

- No route calls `extractTarArchive()`. Archive handling is implemented and tested but
  has no HTTP entry point.
- No CORS, rate limiting or authentication middleware. `REPOATLAS_CORS_ORIGIN` exists but
  is not yet wired into the Fastify instance.
- No requirement, sequence, DFD, use-case, activity or deployment projection. They are
  absent because the graph does not yet hold their facts.
- No in-graph **consistency** checker. Drift compares two states; it does not look for
  contradictions inside one graph.
- C4 recovers only what the graph holds: no human actors, no package-as-container, and no
  components for a container that declares an image but no build context. Each is recorded
  in the level's `omitted[]` rather than drawn.
