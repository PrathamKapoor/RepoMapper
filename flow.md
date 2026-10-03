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
 │
 ├─ buildGraph()                       packages/core/src/graph-builder.ts
 │    Why: the single place nodes and edges are created.
 │
 └─ projectAtlas()                     packages/artifacts/src/index.ts
      ├─ buildDependencyGraph()        packages/artifacts/src/dependency-graph.ts
      ├─ buildModuleGraph()            packages/artifacts/src/dependency-graph.ts
      ├─ buildClassDiagram()           packages/artifacts/src/class-diagram.ts
      ├─ buildErDiagram()              packages/artifacts/src/er-diagram.ts
      └─ analyseGaps()                 packages/artifacts/src/gaps.ts
           Why: projections read the graph. They cannot create facts.
```

Input: an absolute repository path.
Output: `RunAnalysisOutput` — the analysis record, the graph, statistics, artifact
projections, the gap report, diagnostics, per-file parse results and the skip list.

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
 │
 └─ PASS 9: git facts → commit, contributor, authored_by, modifies
```

**Pass 3 is why inheritance works at all.** Indexing during entity creation made
resolution depend on file order, so a class extending a later-declared base silently lost
its edge (D-010).

Confidence assignment:

| Relation | Confidence | Reason |
|---|---|---|
| declaration, import statement, route, manifest field, schema DDL, commit | `EXPLICIT` | the file literally states it |
| inheritance, call with a resolved callee | `STRONGLY_INFERRED` | the statement exists; the target identity was resolved by us |
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
 │    └─ toMermaid(artifact)                        text projection
 └─ analyseGaps(graph)
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

---

## 8. Persistence and API

```
AnalysisService.analyse(request)                     packages/server/src/service.ts
 ├─ admission control: concurrency (429), stored limit (507)
 ├─ runAnalysis()  with a hard timeout (504)
 ├─ Store.saveAnalysis()            packages/server/src/store.ts   one transaction
 │    BEGIN → analyses → nodes → edges → evidence → diagnostics → artifacts → COMMIT
 └─ on failure: Store.saveFailure() so failures stay visible

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
 ├─ GET    /api/analyses/:id/gaps
 ├─ GET    /api/analyses/:id/diagnostics
 └─ DELETE /api/analyses/:id
```

Notes that matter:

- `GET /api/analyses/:id` and `/gaps` and `/artifacts` **re-derive** from the stored graph
  rather than replaying a cached blob, so a projection change is visible without
  re-analysing.
- `GET /graph` filters nodes and then returns only edges whose endpoints survived, so the
  client never receives a dangling reference. It reports `truncated` and `totals` when a
  limit was hit.
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
 │    Structure       module-graph and class-diagram
 │    Evidence        entity index + evidence records
 │    Gaps            gap report with status, observations, checked list
 │    Diagnostics     every diagnostic from the run
 └─ EntityDrawer                                     packages/web/src/entity-drawer.tsx
      Any entity, anywhere → node + relationships + evidence + confidence
```

`graph.tsx` renders an artifact deterministically (D-021) with confidence encoded as
solid versus dashed edges. Clicking a node opens the inspector, which is where a selected
entity connects across representations.

---

## 10. Storage schema

```
schema_meta     key, value                        schema_version
analyses        id, repository_path, label, status, timings, head_commit, branch,
                error_json, summary_json, warnings_json
nodes           (analysis_id, id) PK, kind, name, qualified_name, language, path,
                start_line, end_line, confidence, attributes_json, evidence_json
edges           (analysis_id, id) PK, from_id, to_id, kind, confidence, label,
                attributes_json, evidence_json
evidence        (analysis_id, id) PK, kind, path, start_line, end_line, symbol,
                excerpt, producer
diagnostics     (analysis_id, seq) PK, code, severity, message, path, detail_json
artifacts       (analysis_id, kind) PK, title, format, body_json
```

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
- No consistency or drift engine. See `decisions.md`, "Deferred, with reasons".