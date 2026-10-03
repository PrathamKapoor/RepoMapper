# RepoAtlas — Engineering Decisions

Operational record of decisions taken while building RepoAtlas. Newest entries are
appended at the bottom of each phase section.

Format follows the project contract: context, decision, why, alternatives, consequences,
files. Package decisions additionally record the packages compared.

Rules for this file:

- Record only what actually happened. No planned-but-unbuilt work.
- If a root cause was not identified, say so rather than inventing one.
- Superseded decisions stay in the file with a pointer to their replacement.

---

## Phase 1 — Foundation

### D-001: Language and runtime — TypeScript on Node.js

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** The repository was empty apart from an initialized Git repository. The
  product needs a parser layer for several languages, a graph model, an HTTP API and a
  browser UI. The stack had to be chosen from what the environment could actually run.
- **Verified environment:** Node v24.19.0, npm 12.0.2, git 2.55.0, Python 3.13.2,
  Docker Desktop 4.93.0 (Engine 29.8.1), PowerShell 7.6.6, Windows 11 (10.0.26200),
  16 cores, ~25 GB RAM. No Go, Rust, Java or Bun toolchain present.
- **Decision:** TypeScript 5.9.3 on Node.js 24, in an npm-workspaces monorepo. Six
  packages: `@repoatlas/core`, `@repoatlas/ingest`, `@repoatlas/parsers`,
  `@repoatlas/artifacts`, `@repoatlas/server`, `@repoatlas/web`.
- **Why:**
  - One language across parser, server and UI means the canonical graph model
    (`SoftwareGraph`) is shared as source, not re-declared per layer. That is the
    mechanism that keeps projections from contradicting each other.
  - Node 24 ships `node:sqlite` in core, removing the only native-module dependency.
  - The TypeScript compiler is already a dependency for the TS parser, so the parser
    layer needs no grammar downloads and no native builds.
  - npm workspaces give per-package `package.json` with a single root lockfile, which is
    what makes `npm ci` reproducible in CI and Docker.
- **Alternatives considered:**
  - **Python** (available, 3.13.2): rejected because it would force a language boundary
    between parser and server, duplicating the graph model and its evidence contract.
    Python was also the weakest option for the browser UI.
  - **Go**: excellent for a single static binary and no runtime dependency, but rejected
    because no Go toolchain exists in this environment, and because the tree-sitter
    binding story for Go plus a React UI is a larger surface than the product needs now.
  - **Rust**: rejected for build time and because no toolchain is installed.
- **Consequences:** The build is `tsc` per package (no bundler for the backend), which is
  slower than an esbuild/rollup pipeline but produces readable output and plain `.d.ts`
  files with no extra tooling. Accepted.
- **Files:** `package.json`, `tsconfig.base.json`, `packages/*/package.json`,
  `packages/*/tsconfig.json`, `packages/*/tsconfig.build.json`

### D-002: Package boundaries and the dependency direction

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** The core idea is that the canonical graph is the centre and everything
  else is a projection. That is only enforceable if the dependency graph makes an
  independent diagram generator impossible to write by accident.
- **Decision:** A strict, acyclic dependency direction:

  ```
  core  <-  ingest  <-  parsers
    ^         ^           ^
    |         |           |
    +------ artifacts <---+
             ^
             |
           server  ->  web (HTTP only)
  ```

  - `@repoatlas/core` depends on nothing. It owns the domain types, the evidence store,
    the confidence model and `buildGraph()`.
  - `@repoatlas/ingest` depends only on core.
  - `@repoatlas/parsers` depends only on core. It produces `ParsedFile`, a core type.
  - `@repoatlas/artifacts` depends only on core. It reads `SoftwareGraph` and cannot
    create facts.
  - `@repoatlas/server` depends on all of them and owns persistence and HTTP.
  - `@repoatlas/web` has no build-time dependency on the backend; it talks HTTP only.
- **Why:** Because artifacts can only *read* the graph, a new diagram cannot invent a
  relationship. If a view needs a fact the graph lacks, the fix is to improve extraction
  — which is the intended pressure. The compiler enforces this rather than convention.
- **Alternatives considered:**
  - **One flat package:** rejected. It makes the "artifacts may not create facts" rule a
    matter of reviewer discipline rather than a type error.
  - **`CommitRecord` owned by ingest, with the graph builder in a package depending on
    ingest:** rejected. It would have made `core` depend on I/O, so the model could not be
    used without a filesystem. `CommitRecord` is a domain type and was moved to core
    (`packages/core/src/types.ts`) for exactly this reason.
- **Consequences:** `graph-builder.ts` lives in core rather than in `parsers`, which is
  slightly counter-intuitive for a reader who expects "parsing" to include "building".
  The alternative — a separate pipeline package — was judged not worth the extra node
  for the same guarantee.
- **Files:** `packages/core/src/graph-builder.ts`, `packages/core/src/types.ts`,
  `packages/*/package.json`

### D-003: TypeScript/JS parsing via the compiler API

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** Import statements and declarations are the most reliably extractable facts
  in any repository, and the dependency graph is the first artifact in the build order.
  Extraction has to be correct on real code, including comments, template literals and
  destructuring.
- **Decision:** Use `ts.createSourceFile` from the `typescript` package (already a
  dependency) with `setParentNodes: false`. `ts.ScriptTarget.Latest`. No module
  resolution, no type checking, no filesystem access during parsing.
- **Why:** It is a real AST for the exact languages it claims, it is first-party, and it
  needs no grammar download or native build. Critically, `createSourceFile` parses text
  without resolving imports or executing anything, so analysing a hostile repository
  cannot run its code.
- **Package:** `typescript@5.9.3`
- **Why this package:** first-party, zero transitive dependencies, already required for
  the build, and stable across Node versions.
- **Packages compared:**
  - `web-tree-sitter` + `tree-sitter-*` WASM grammars: broader language coverage from one
    engine, but requires downloading and pinning per-language `.wasm` artefacts, adds a
    non-JavaScript parsing model to learn, and does not give a TypeScript-aware AST.
    Deferred to a later phase if multi-language coverage becomes the bottleneck.
  - Regular expressions: rejected outright. `import` inside a comment or string, and
    `def` inside a Python docstring, are common enough that a regex graph would be wrong
    in ways that are hard to notice.
- **Consequences:** `setParentNodes: false` means `node.getText()` throws unless the
  source file is passed explicitly. This caused a real bug (D-009).
- **Files:** `packages/parsers/src/typescript.ts`, `packages/parsers/src/contract.ts`

### D-004: Python parsing as a structural extractor

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** No first-party Python parser exists in the Node toolchain, and Python is
  common in analysed repositories. Whatever is built must not pretend to be a full
  Python parser.
- **Decision:** A tokeniser over physical lines producing *logical lines*, with two
  views per logical line:
  - `code` — comments removed and string bodies blanked; used for detecting `def`,
    `class`, imports and calls, so a `def` inside a docstring is invisible.
  - `raw` — comments removed but string literals intact; used for marker extraction,
    because an HTTP route path is a string value.
- **Scope tracking** is derived from indentation, which is Python's block structure.
- **Why:** Indentation-based scope is the minimum needed to produce correct qualified
  names, and the dual view is what lets route detection read real string values without
  letting docstrings masquerade as code.
- **Consequences, stated honestly:** This is not a complete Python grammar. Decorators
  that build classes dynamically, `exec`-generated code and metaprogramming are not
  modelled. The tokenizer reports what it could not classify (unterminated literals,
  open brackets at EOF) as a `ParseProblem` instead of failing silently. Facts derived
  from it stay at or below `STRONGLY_INFERRED`.
- **Alternatives considered:**
  - **A Python parser ported to JS** (`filbert`, `@lezer/python`): better fidelity, but a
    large dependency and a second AST model to learn for one language.
  - **Shell out to a Python subprocess**: rejected. It would mean executing tooling
    derived from the analysis host against untrusted input, for less information than the
    structural extractor provides.
- **Files:** `packages/parsers/src/python.ts`

### D-005: Persistence with the Node built-in SQLite

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** Analyses must survive a restart. The data is one row per node, edge and
  evidence record.
- **Decision:** `node:sqlite` (`DatabaseSync`), enabled on Node >= 22.5. WAL journal mode.
  Entities stored one row per node/edge so they can be filtered by kind in SQL;
  `evidence_json` denormalised onto nodes and edges so an entity renders with its
  citations in one query.
- **Why:** It removes a compiled dependency from the install path, so Docker builds and
  CI need no toolchain beyond the Node base image. Verified working in the container
  image (D-013).
- **Alternatives considered:**
  - `better-sqlite3`: faster in benchmarks, but adds a native build step and a
    platform-specific failure mode to every install. Rejected for that reason alone.
  - PostgreSQL: correct for a multi-tenant deployment, but adds a service to run for a
    single-writer workload that fits comfortably in one file. Revisit if concurrent
    writers or shared state across replicas become real requirements.
  - Plain JSON files: rejected. Rewriting a multi-megabyte graph to answer one query, and
    concurrent read-during-write safety, are both poor fits.
- **Consequences:** Writes are serialised through a single connection. Fine for the
  current bounded concurrency (`REPOATLAS_CONCURRENCY`, default 2). Schema version is
  stored in `schema_meta` and bumped on breaking model changes.
- **Files:** `packages/server/src/store.ts`, `packages/server/package.json`

### D-006: Analyses run inline, not in a background queue

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** Analysis of a large repository takes seconds to minutes. A job queue with
  polling is the obvious production shape.
- **Decision:** Execute the analysis inside the request. Bound it with
  `REPOATLAS_CONCURRENCY` (over-capacity returns 429) and
  `REPOATLAS_ANALYSIS_TIMEOUT_MS` (exceeded returns 504 and the analysis is abandoned).
- **Why:** It makes every request deterministic and directly testable, and a failure is
  a real HTTP error rather than a job id nothing is watching. For the current product —
  a single operator or small team analysing repositories interactively — the queue buys
  nothing observable.
- **Alternatives considered:**
  - **In-process queue with polling** (`POST` returns 202 + id): rejected for now because
    it adds a status machine, a persistence requirement for queued work, and a client-side
    poll loop, all before the product needs them.
  - **External queue** (BullMQ/Redis): adds a service to deploy. Rejected as premature.
- **Consequences:** Documented as the first thing to revisit when analysis duration or
  concurrency makes inline execution user-visible. A long analysis holds an HTTP
  connection; proxies with short read timeouts will need raising.
- **Files:** `packages/server/src/service.ts`, `docs/deployment.md`

### D-007: Confidence is part of the data model, not a UI decoration

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** The product's central promise is that an inference is never presented as a
  fact. That is only credible if the distinction is impossible to lose.
- **Decision:** Every `GraphNode` and `GraphEdge` carries a `confidence` of `EXPLICIT`,
  `STRONGLY_INFERRED`, `WEEKLY_INFERRED` or `UNKNOWN`. Every node and edge also carries
  `EvidenceRef[]`; nothing is created without a citation. The builder *downgrades* on
  merge (`weakerConfidence`) so combining two observations can never upgrade a fact.
  Artifacts and Mermaid output propagate it; the UI renders inferred edges dashed and
  labelled.
- **Why:** Making it a required field means a new extractor cannot forget it — the
  compiler rejects the node. Downgrading on merge prevents the most subtle failure mode,
  where two weak observations combine into a falsely confident one.
- **Consequences:** Every projection has to decide what to do with confidence, and the
  graph cannot distinguish "known to be absent" from "not looked for". The second gap is
  handled separately by the `EvidenceStatus` vocabulary (D-008).
- **Files:** `packages/core/src/types.ts`, `packages/core/src/graph.ts`,
  `packages/artifacts/src/contract.ts`

### D-008: Gap analysis uses `EvidenceStatus`, and never claims absence

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** "No deployment architecture found" is a statement about a repository, and
  is very often false about the system. Requirements are frequently held in an issue
  tracker and tests outside the repository.
- **Decision:** Every gap reports one of `EXPLICIT`, `PARTIALLY_EVIDENCED`, `INFERRED`,
  `NOT_FOUND`, plus:
  - `checked` — what was searched, so a `NOT_FOUND` claim is auditable;
  - `whatWouldResolve` — what the repository would need to contain;
  - `observations` that must hedge where the capability may live elsewhere.
- **Why:** `NOT_FOUND` is the single most misleading word in this domain. Pairing it with
  the search performed and the missing input makes it checkable instead of rhetorical.
- **Enforcement:** Two tests in `packages/artifacts/test/artifacts.test.ts` assert that
  every `NOT_FOUND` gap lists what was searched, says what would resolve it, and hedges.
  A new gap that reads as an absence claim fails the build.
- **Files:** `packages/artifacts/src/gaps.ts`,
  `packages/artifacts/test/artifacts.test.ts`

### D-009: Bug — heritage clauses produced no relationships

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** Analysing this repository produced a class diagram with 89 types and **0**
  relationships, and 25 parser warnings.
- **Root cause:** `heritageNames()` called `type.expression.getText()` with no argument.
  With `setParentNodes: false` the node has no parent chain from which to find its source
  file, so `getText()` threw. The throw was caught by the per-file handler in
  `parseFiles`, which aborted the rest of that file's parse. Import extraction ran before
  the throw, so imports and calls looked healthy — the failure was silent apart from the
  warning count.
- **Why it mattered:** A partially-extracted file looks like a file with fewer facts. Only
  noticing that a whole relationship *class* was missing across every file exposed it.
- **Fix:** Pass `ctx.sourceFile` to every `getText()` call.
- **Regression test:** `packages/parsers/test/parsers.test.ts` — "extracts classes with
  their heritage clauses" asserts `extendsFrom`/`implementsFrom`, and
  `packages/core/test/graph-builder.test.ts` — "resolves an inheritance relationship
  regardless of file order" asserts the edge is created when the base class is declared
  in a later file.
- **Files:** `packages/parsers/src/typescript.ts`, `packages/core/src/graph-builder.ts`

### D-010: Bug — symbol index was built incrementally, making resolution order-dependent

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** A class extending a base class declared in a later file, or later in the
  same file, silently lost its `extends` edge.
- **Root cause:** `buildGraph()` indexed a symbol as it created each entity, so a
  relationship could only resolve if the target happened to be parsed first.
- **Why it mattered:** Order-dependent extraction means the graph changes when file order
  changes. That breaks determinism, which drift detection and before/after comparison
  both depend on.
- **Fix:** Split into passes: index every symbol first, then create entities, then resolve
  relationships. Also restricted inheritance edges to type kinds so a class cannot
  "extend" a same-named function.
- **Regression test:** "resolves an inheritance relationship regardless of file order" and
  "refuses to link inheritance to a non-type symbol".
- **Files:** `packages/core/src/graph-builder.ts`, `packages/core/test/graph-builder.test.ts`

### D-011: Bug — SQL columns were all dropped

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** Tables were detected but zero columns, on any repository.
- **Root cause:** `parseSql()` pushed `schema.column` markers as it walked a `CREATE
  TABLE` body and pushed the `schema.table` marker afterwards. The graph builder attaches
  a column to its table and skips a column with no owning table, so every column was
  discarded.
- **Fix:** Collect table and column markers separately and emit tables first.
- **Regression test:** `packages/server/test/analyze.test.ts` — "records tables and
  columns from SQL" asserts column qualified names and that each is contained by its own
  table.
- **Files:** `packages/parsers/src/config.ts`

### D-012: Bug — dynamic `import()` was never detected

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** `import('./lazy.js')` produced no import record.
- **Root cause:** The code compared `calleeName(node.expression) === 'import'`, but the
  expression of a dynamic import is a `ts.ImportKeyword` token, not an identifier, so
  `calleeName` returned `undefined`.
- **Fix:** Check `node.expression.kind === ts.SyntaxKind.ImportKeyword` structurally
  before any name-based handling, and do not record a dynamic import as a repository call.
- **Regression test:** "extracts every import form and classifies externality" asserts
  kind `dynamic` for `import('./lazy.js')`.
- **Files:** `packages/parsers/src/typescript.ts`

### D-013: Bug — the production container crashed at startup when the UI was enabled

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** `docker run` exited 1 with
  `Error: Not found handler already set for Fastify instance with prefix: '/'`.
- **Root cause:** `buildApp()` registered a not-found handler, and `registerStaticUi()`
  registered a second one to add the SPA fallback. Fastify permits exactly one per prefix
  and throws on a second. Only the production configuration sets `staticDir`, which is why
  local development runs never hit it.
- **Fix:** `buildApp()` owns the single not-found handler and delegates to a swappable
  implementation; `registerStaticUi()` installs static files and returns the SPA-fallback
  handler for `buildApp()` to adopt.
- **Regression test:** covered by the CI `image` job, which builds and starts the real
  image and asserts `/api/health` and the UI respond. It is not covered by a unit test
  because the failure requires the static plugin to be registered.
- **Files:** `packages/server/src/static.ts`, `packages/server/src/app.ts`,
  `.github/workflows/ci.yml`

### D-014: Bug — the Linux image could not resolve the `ignore` package

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** `docker build` failed with
  `ignore-stack.ts(27,20): error TS2349: This expression is not callable`, while the same
  build succeeded on Windows.
- **Root cause:** `ignore` is CommonJS and its two major lines ship incompatible
  declaration styles (v5 `export default ignore`, v7 `export = ignore`). Under NodeNext
  module resolution neither makes a plain default import reliably callable from ESM: the
  import yields the module namespace. npm hoists a different major to the root depending
  on the dependency graph, so the local tree and the container tree disagreed.
- **Fix:** Resolve the factory at runtime from whichever shape is provided
  (`resolveIgnoreFactory`), throwing a named error if neither is callable. Pinned `ignore`
  to `5.3.2` so the version is deterministic, but did not rely on that alone.
- **Regression test:** "applies real gitignore semantics through the interop shim" in
  `packages/ingest/test/ingest.test.ts` asserts negation, anchoring and directory
  patterns — the behaviour that depends on the shim.
- **Files:** `packages/ingest/src/ignore-stack.ts`, `packages/ingest/package.json`

### D-015: Bug — the container build dropped workspace-nested dependencies

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** `vite.config.ts(2,19): error TS2307: Cannot find module '@vitejs/plugin-react'`.
- **Root cause:** The build stage copied `/app/node_modules` from the deps stage but not
  `/app/packages`. npm nests conflicting versions under `packages/*/node_modules`, and
  `@vitejs/plugin-react` was one of them.
- **Fix:** Copy both trees from the deps stage before the build context.
- **Files:** `Dockerfile`

### D-016: Request validation failures returned HTTP 500

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** A POST with a missing or misspelled field returned 500.
- **Root cause:** `schema.parse()` throws `ZodError`, which has no `statusCode`, so
  Fastify's handler treated it as an unexpected server error.
- **Fix:** `parseOrThrow()` converts `ZodError` into an `AnalysisError` with code
  `BAD_REQUEST` and a message naming each offending field.
- **Why it matters:** A 500 blames the server for a caller's mistake and hides the actual
  problem, which in this case was a typo in a field name.
- **Files:** `packages/server/src/app.ts`, `packages/core/src/diagnostics.ts`

### D-017: One `kind` query parameter was ambiguous

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** `GET /api/analyses/:id/graph?kind=class` returned 400 with an error listing
  relationship kinds.
- **Root cause:** The route parsed the same query object against both a node-kind schema
  and an edge-kind schema, each with a field named `kind`.
- **Fix:** Separate `kind` (node kinds) from `edgeKind` (relationship kinds), and
  `limit` from `edgeLimit`.
- **Files:** `packages/server/src/app.ts`, `packages/web/src/api.ts`

### D-018: Artifact edges dropped the relationship kind

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** Found by a test asserting on `edge.kind` in an artifact projection.
- **Decision:** `ArtifactEdge` now carries `kind` alongside `source`, `target` and
  `confidence`.
- **Why:** Without it a consumer cannot distinguish an import from a call, so an edge in a
  diagram has no meaning. This is a projection losing information the graph already had,
  which is the exact class of defect the artifact contract exists to prevent.
- **Files:** `packages/artifacts/src/contract.ts`

### D-019: `slugify` did not collapse repeated path separators

- **Date / phase / commit:** Phase 1, initial commit
- **Symptom:** `slugify('src//a.ts')` differed from `slugify('src/a.ts')`, so two spellings
  of the same path produced two node ids.
- **Decision:** Collapse repeated `/` and strip leading/trailing separators.
- **Why:** Node id stability across analyses is what makes graph comparison and drift
  detection meaningful.
- **Files:** `packages/core/src/ids.ts`, `packages/core/test/core.test.ts`

### D-020: Artifact projections report what they could not draw

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** A projection that silently drops relationships is indistinguishable from
  one that found none.
- **Decision:** Every `Artifact` carries `omitted[]` (reason, count, examples),
  `insufficientEvidence`, and a `scope` string stating what the view does and does not
  cover. `OmissionLog` accumulates reasons and remembers a few examples;
  `recordCount()` records a total computed in one pass.
- **Why:** It makes incompleteness visible at the point of display, and it is the reason
  the ER view can honestly say it does not infer foreign keys.
- **Files:** `packages/artifacts/src/contract.ts`, `packages/artifacts/src/er-diagram.ts`,
  `packages/artifacts/src/class-diagram.ts`

### D-021: Deterministic graph layout in the UI

- **Date / phase / commit:** Phase 1, initial commit
- **Decision:** Render nodes on a deterministic grid derived from projection order, not a
  force simulation. Offer drag so a user can rearrange interactively.
- **Why:** A force layout re-randomises, so two engineers viewing the same analysis see
  different pictures and screenshots in a review do not match. Determinism is what makes
  before/after comparison of two analyses meaningful.
- **Consequences:** Large graphs are wide rather than compact. Acceptable for the
  entity-count range reached so far; a real layout engine is a later decision.
- **Files:** `packages/web/src/graph.tsx`

### D-022: Mermaid as the text projection format

- **Date / phase / commit:** Phase 1, initial commit
- **Decision:** Render artifact text projections as Mermaid. Confidence is encoded as a
  dashed arrow plus the confidence label, so an inferred relationship is visually
  distinct.
- **Package:** Mermaid via the UI's own rendering (no server-side renderer installed).
- **Why this package:** Renders in the browser with no server-side renderer and no
  headless browser, which keeps the deployment surface to a single Node process and
  removes a large native dependency.
- **Alternatives considered:**
  - **PlantUML / Kroki**: higher-fidelity diagram types (notably sequence and state
    diagrams), but needs a Java or remote service, so it would break the single-process
    deployment and add a network dependency for a core feature.
  - **D2**: good at graph-shaped output, weaker for UML-shaped output, and a separate
    render path from the interactive canvas.
- **Consequences:** Sequence, state and activity diagrams are not yet expressible. When
  those are built, the renderer choice is revisited and recorded as a new decision rather
  than changed silently.
- **Files:** `packages/artifacts/src/contract.ts`

### D-023: Vite 8 with `@vitejs/plugin-react` 6

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** `@vitejs/plugin-react@6.1.1` declares a peer dependency on `vite@^8`.
  Vite 7 could not be used with it without `--legacy-peer-deps`.
- **Decision:** Vite `8.3.2` with `@vitejs/plugin-react` `6.1.1`.
- **Alternatives considered:** `--legacy-peer-deps` with Vite 7 — rejected. Accepting a
  peer-dependency violation to hold an older major is worse than taking the current
  major that the plugin actually supports.
- **Consequences:** Web build output is ~424 kB (133 kB gzipped) before tree-shaking
  improvements. Vite 8 is recent; the UI is the only consumer.
- **Files:** `packages/web/package.json`, `packages/web/vite.config.ts`

### D-024: Type-aware ESLint with one tsconfig per package

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** Type-aware lint rules need every linted file to belong to a TypeScript
  project. Tests, fixtures and root config files initially failed with
  "not found by the project service".
- **Decision:** Each package has `tsconfig.json` (source + tests, `noEmit`) for editors
  and ESLint, and `tsconfig.build.json` (source only, emits) for the build. ESLint uses
  `projectService` with `allowDefaultProject` for `*.ts`, `*.mjs`, `scripts/*.mjs` and
  `e2e/*.ts`.
- **Alternatives considered:** a single flat root `tsconfig.eslint.json` — rejected
  because the web package needs DOM libraries and `jsx` while the server needs Node
  types, and one project cannot serve both correctly.
- **Files:** `packages/*/tsconfig.json`, `packages/*/tsconfig.build.json`,
  `eslint.config.mjs`

### D-025: Unverified-work reporting is enforced, not just intended

- **Date / phase / commit:** Phase 1, initial commit
- **Context:** The project contract requires that nothing be described as complete,
  verified or production-ready without evidence.
- **Decision:** `docs/verification.md` records each capability with the exact command run
  and its result, including the parts that are explicitly *not* verified (browser
  rendering, other languages, archive-upload UI). `STATUS: PARTIAL` is used where
  appropriate.
- **Consequences:** The document must be updated whenever verification state changes, or
  it becomes worse than useless.
- **Files:** `docs/verification.md`

---

## Deferred, with reasons

Recorded so these are not mistaken for oversights.

| Item | Why deferred |
|---|---|
| C4 architecture, sequence, DFD, use-case, activity, deployment diagrams | Each needs graph facts that do not exist yet. Building a projection before its facts are in the graph would produce a confident-looking diagram with invented content — the failure mode this product exists to avoid. |
| Requirements and traceability | Needs requirement extraction, which needs document-structure parsing. No facts to trace yet. |
| Consistency and drift engine | Needs two analyses of comparable graphs plus a diff over node and edge identity. Deterministic ids (D-019) are the prerequisite and are in place; the diff and rule set are not. |
| Authentication/authorisation relationships | No extractor produces them yet. Reported honestly as `NOT_FOUND` by the gap analysis (D-008). |
| Archive upload endpoint | Extraction, containment and limits are implemented and tested (`extractTarArchive`). The HTTP route is not built. |
| Languages beyond TypeScript/JavaScript and Python | D-003/D-004 explain the current coverage and the path to widening it. |
| Sequence-diagram renderer | D-022 explains why the current renderer cannot express one. |