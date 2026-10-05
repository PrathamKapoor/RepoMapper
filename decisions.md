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

## Phase 2 — Drift detection and C4 architecture recovery

### D-026: A snapshot's identity is a content digest, not a timestamp

- **Date / phase / commit:** Phase 2
- **Context:** Phase 1 deferred drift detection because comparing two analyses needs a
  defensible notion of "the same state". The obvious identity — the analysis timestamp — is
  wrong in a way that only shows up later: re-analysing an unchanged repository produces a
  new timestamp, so "nothing changed" is indistinguishable from "analysed at a different
  moment", and every drift report would be a diff of noise.
- **Decision:** `createSnapshot()` (`packages/core/src/snapshot.ts`) derives
  `graphDigest = sha256(extractorVersion, graphSchemaVersion, sorted nodes, edges,
  evidence)` and the snapshot id from it. Provenance (analysis id, repository path, commit,
  branch, timestamp, truncation) is recorded **outside** the identity.
- **Why:** Content identity makes "identical" decidable, makes a report reproducible, and
  makes a snapshot idempotent: analysing the same content twice yields the same id, so the
  second analysis is visibly a re-run rather than a new state. Two extra inputs are folded
  in deliberately: the extractor version and the graph schema version. If extraction changes,
  every entity's facts change, and comparing across that change would otherwise report the
  whole repository as rewritten. Folding them in makes it *detectable* instead of silent,
  and `incomparabilityReason()` refuses the comparison outright with an explanation.
- **Alternatives considered:**
  - **Git commit as identity:** better as a *label* — it is recorded as `sourceRevision` —
    but it is not available. An exported archive, a copy without `.git`, or a dirty working
    tree all break it. Verified: a snapshot is created and compared for a repository with no
    Git history (`drift.test.ts`, "creates a snapshot for a repository with no git history").
  - **Hash the file tree rather than the graph:** would change when an extractor improves
    even when no fact changed, so drift would report noise on every parser upgrade.
  - **Timestamp + analysis id:** rejected; see above.
- **Consequences:** The digest covers every node, edge and evidence record, so the cost is
  O(graph) per analysis and the comparison itself is O(n + m) over indexed maps.
  `GRAPH_SCHEMA_VERSION` was bumped 1 → 2 because `GraphNode.digest` was added. A snapshot
  taken before the bump is reported incomparable rather than silently diffed.
- **Files:** `packages/core/src/snapshot.ts`, `packages/core/src/graph.ts`,
  `packages/server/src/store.ts`, `packages/server/src/service.ts`

### D-027: Drift runs on the canonical graph, indexed, and is sorted before it returns

- **Date / phase / commit:** Phase 2
- **Context:** "What changed between two states" can be computed many ways. The two that
  matter here are cost and determinism: a naive pairwise diff is O(n·m) on graphs that reach
  thousands of nodes, and an unsorted diff produces a different report on every run, which
  makes a drift report impossible to diff or to cache.
- **Decision:** `compareSnapshots()` (`packages/core/src/drift.ts`) indexes base and target
  by entity id (`indexById`), walks each index once, and sorts `changes` with a total order
  over `(category, entityId)` before returning.
- **Why:** Every entity in this graph already has a deterministic id (D-019), so the
  comparison is a map lookup rather than a similarity question. That is what makes the whole
  engine cheap and what removes any temptation to match by display name.
- **Consequences:** The same pair of snapshots always produces byte-identical JSON, asserted
  in `drift.test.ts` ("produces byte-identical reports for the same pair of snapshots").
  `maxChanges` bounds the record list; counts are always complete regardless, so a capped
  report never misstates how much changed.
- **Files:** `packages/core/src/drift.ts`, `packages/core/test/drift.test.ts`

### D-028: A removal is only asserted from a complete analysis

- **Date / phase / commit:** Phase 2
- **Context:** The single most damaging false statement this product could make is "X was
  removed". Absence of an observation is not evidence of absence: if the target analysis hit
  a file, node or edge limit, part of the repository was never walked, and every entity
  outside the walked part looks identical to a deleted one.
- **Decision:** A removal carries `claimConfidence` and `indeterminate`, distinct from the
  entity's own confidence. When the target snapshot's analysis was truncated, every removal —
  of nodes, of edges *and of evidence citations* — is reported with
  `claimConfidence: 'INDETERMINATE'`, `indeterminate: true`, and a `reason` stating that
  absence does not establish removal. The report carries `targetIncomplete` and
  `removalConfidence` at the top level.
- **Why:** It keeps the two questions separate. "Is this entity explicit?" is a property of
  the graph. "Can we assert it is gone?" is a property of *how completely we looked*. One
  confidence value cannot answer both, and conflating them is how a partial scan becomes a
  confident deletion list.
- **Enforcement:** `drift.test.ts` asserts that a truncated target produces indeterminate
  removals, and that evidence removals follow the same rule.
- **Alternatives considered:**
  - **Suppress removals entirely when truncated:** rejected. The reader would lose the signal
    that the two states differ in size, with no explanation of why the list is empty.
  - **Re-run with raised limits automatically:** out of scope, and it would change the
    snapshot under comparison.
- **Files:** `packages/core/src/drift.ts`, `packages/server/src/analyze.ts`

### D-029: Rename detection requires identical content, and nothing else

- **Date / phase / commit:** Phase 2
- **Context:** A renamed file changes its node id, so a naive diff reports one removal and one
  addition. Reporting that as "renamed" is more useful — but only if it is *true*. A
  similarity heuristic would produce confident, wrong renames, which is the exact failure this
  product exists to avoid.
- **Decision:** Extraction captures a `digest` on every module node: sha256 of the decoded
  file text with CRLF normalised to LF, computed during the single read each file already
  requires (`contentDigest()` in `packages/server/src/analyze.ts`), so hashing adds no I/O.
  `detectRenames()` pairs a removed node with an added node only when all of the following
  hold: same node kind, same language, equal digests, and the digest is **unique** on both
  sides. Renames are reported with `claimConfidence: 'STRONGLY_INFERRED'` and never also as
  a removal plus an addition.
- **Why:** Identical content under a different path is the same bytes, which is a proof
  rather than a resemblance. The uniqueness rule is what makes it a proof: two identical
  files could be paired either way, and a guess dressed as a proof is worse than two honest
  rows. CRLF normalisation matters because a Windows checkout and a Linux checkout of the
  same commit are the same source, and treating them as different would invent a change on
  every cross-platform run.
- **Alternatives considered:**
  - **Name similarity (edit distance, token overlap):** rejected outright. It cannot
    distinguish "renamed" from "deleted one file and added a similar one".
  - **Git rename detection (`git log --follow`, `git diff -M`):** stronger evidence when
    available, but it needs a Git history this analysis does not require, and it describes a
    commit range rather than two independent analyses. Recorded as a possible later
    corroboration, not a replacement.
  - **Symbol-level rename pairing (class moved between files):** deferred. It would need a
    second identity rule and its own ambiguity handling; the module-level rule already covers
    the common case honestly.
- **Consequences:** A rename that also changed content is reported as removed plus added. So
  is a rename when ingestion could not supply a digest. Both are tested
  (`refuses to call a rename when the content also changed`,
  `refuses to call a rename when the pairing would be ambiguous`).
- **Files:** `packages/core/src/graph-builder.ts`, `packages/core/src/drift.ts`,
  `packages/server/src/analyze.ts`, `packages/parsers/src/registry.ts`

### D-030: `EVIDENCE_MOVED` was removed; evidence movement is observed on the entity

- **Date / phase / commit:** Phase 2
- **Context:** The first draft of the drift model included an `EVIDENCE_MOVED` category that
  compared a stored evidence record against the same id in the target snapshot and reported a
  change of line.
- **Decision:** The category was deleted. It is unreachable by construction: an evidence id is
  `evidenceId(path, kind, startLine, producer)` (`packages/core/src/evidence.ts`), so two
  records sharing an id have the same path and the same line by definition. The category could
  only ever report zero, and a category that always reports zero is worse than no category.
- **What replaced it:** `EVIDENCE_CHANGED`, recorded on the entity that *cites* the evidence.
  A citation that moved becomes a different record, so the observable fact is "this entity is
  now cited elsewhere", which is compared by a set of `path:line:kind` fingerprints on the
  retained nodes and edges. Both views are kept: `EVIDENCE_REMOVED`/`EVIDENCE_ADDED` on the
  records themselves, `EVIDENCE_CHANGED` on the citing entity, carrying `evidenceBefore` and
  `evidenceAfter` so a reader can follow the citation to its old and new location.
- **Consequences:** Follows the repository's own rule (handoff §12.17): a check that cannot
  fail is deleted rather than kept to inflate a count.
- **Files:** `packages/core/src/drift.ts`, `packages/core/test/drift.test.ts`

### D-031: Bug — snapshot provenance reported an empty identity

- **Date / phase / commit:** Phase 2
- **Symptom:** `GET /api/analyses/:id/snapshot` returned `"snapshotId": ""` while
  `GET /api/analyses/:id/drift` reported a correct `base.snapshotId`.
- **Root cause:** `createSnapshot()` built a `provenance` object with placeholder empty
  `snapshotId` and `graphDigest` fields, then returned
  `{ ...provenance, snapshotId: '', graphDigest }` — the computed digest was written back but
  the id was left as the placeholder. The outer `snapshot.id` was correct, which is why the
  drift engine was unaffected: it reads `provenance.graphDigest`, not `provenance.snapshotId`.
- **Why it mattered:** Every consumer that serialises the *reference* rather than the
  snapshot — the API route, and any future cache keyed on it — would have seen an empty
  identity. Two different snapshots are indistinguishable by id.
- **Fix:** Compute `graphDigest` and `snapshotId` first and write both into `provenance`.
- **Regression test:** `drift.test.ts` — "carries the same identity on the snapshot and
  inside its provenance", plus the HTTP assertion in
  `packages/server/test/drift-api.test.ts` that the route returns `snap_<16 hex>`.
- **Files:** `packages/core/src/snapshot.ts`

### D-032: Bug — a failed analysis could be compared, reporting the whole system as removed

- **Date / phase / commit:** Phase 2
- **Symptom:** `GET /api/analyses/:id/drift?against=<failed-analysis>` returned 200 with a
  report in which every node, edge and citation of the real analysis was `NODE_REMOVED`,
  `EDGE_REMOVED` and `EVIDENCE_REMOVED`.
- **Root cause:** `AnalysisService.getSnapshot()` required only that a record and a graph
  existed. `Store.getGraph()` returns `{ nodes: [], edges: [], evidence: [] }` for an analysis
  with no entity rows, which is exactly the state a failed analysis is left in. An empty graph
  is a valid graph, so the comparison ran — and, worse, it ran with `truncated: false`, so the
  removals were reported as `EXPLICIT`.
- **Why it mattered:** This is the failure mode D-028 exists to prevent, arriving through a
  different door: the report claimed a total deletion with full confidence.
- **Fix:** `getSnapshot()` returns `null` unless the analysis `status === 'succeeded'` and the
  graph has at least one node. The route answers 404 with a message saying the analyses could
  not be loaded as snapshots.
- **Regression test:** `packages/server/test/drift-api.test.ts` — "will not compare a failed
  analysis, because it has no graph".
- **Files:** `packages/server/src/service.ts`, `packages/server/src/app.ts`

### D-033: C4 is a mapper over the graph, and an unsupported arrow is dropped rather than drawn

- **Date / phase / commit:** Phase 2
- **Context:** C4 models — system context, containers, components — are the diagrams teams ask
  for first, and they are also the easiest to fabricate. A diagram that draws a person, a
  database and a queue because they "look architectural" is worse than no diagram, because it
  is indistinguishable from a recovered one.
- **Decision:** `packages/artifacts/src/c4.ts` is a projection with no filesystem access and
  no independent discovery. It reads `SoftwareGraph` and maps graph facts onto C4 elements:

  | Level | Element | Graph source | Confidence |
  |---|---|---|---|
  | 1 context | software system | `repository` node | carried through |
  | 1 context | external system | `deployment_component` whose image matches a fixed list of datastore/broker families | `WEEKLY_INFERRED` |
  | 1 context | person | *none* | never emitted |
  | 2 container | container | `deployment_component` | carried through (`EXPLICIT`) |
  | 2 container | container dependency | `imports`/`calls` edges between modules placed in different containers | weakest support |
  | 3 component | component | `module` attributed to a container by a `deploys` edge | carried through |

  Every element carries `derivation` (the rule that produced it), `graphNodeIds`, `evidence`
  and `confidence`. Every relationship carries `supportingEdgeIds` and/or `supportingNodeIds`.
  `finish()` drops any relationship with neither, or whose endpoints are not in the same
  level, and records each drop in `omitted[]`.
- **Why:** `ArtifactNode`/`ArtifactEdge` already existed as the projection contract (D-020);
  C4 uses it rather than inventing a parallel model, so the UI, Mermaid export and omission
  reporting all work unchanged. The support fields are what make "why does RepoAtlas believe
  this exists?" answerable by data rather than by reading the source.
- **Deliberate non-mappings, each recorded in `omitted[]`:**
  - **A package is not a container.** Dependency packages are libraries. Treating them as
    runtime units asserts a boundary the repository never states.
  - **A human actor is not invented.** Nothing in the graph describes who uses the system.
    This is the most common fabrication in diagram tooling, so the omission is stated
    explicitly rather than left as a silent gap.
  - **A deployment file is not a component of the container it declares.** The compose file
    describes the service; it does not run inside it.
- **Alternatives considered:**
  - **LLM-generated architecture description:** rejected. It cannot cite a file and a line,
    which is the product's core promise.
  - **A fourth C4 level (code) from the module graph:** deferred. It adds nothing that the
    existing module-graph view does not already show with citations.
- **Files:** `packages/artifacts/src/c4.ts`, `packages/artifacts/src/contract.ts`,
  `packages/artifacts/src/index.ts`, `packages/artifacts/test/c4.test.ts`

### D-034: Code is attributed to a container by its declared build context, in extraction

- **Date / phase / commit:** Phase 2
- **Context:** With C4 defined, level 3 was empty for every real repository. The reason is in
  the graph: the only `deploys` edge the builder created ran from the *compose file's own
  module* to the service it declares, so exactly one module could ever be placed in a
  container, and it was the file describing the container. Without this decision there is no
  honest component view at all.
- **Decision:** `attributeBuildContext()` in `packages/core/src/graph-builder.ts` emits a
  `deploys` edge from every module whose path lies inside a compose service's declared
  `build:` context to that service's `deployment_component`, at `STRONGLY_INFERRED`, citing
  the compose marker and carrying `attributes.derivedFrom = 'compose.build_context'` plus the
  caveat that a build context says what is sent to the builder, not what a Dockerfile copies.
  The declaring file's own `EXPLICIT` edge is left untouched — re-adding it would merge and
  downgrade it (D-007), understating a fact the repository states directly.
- **Why extraction, not projection.** The relationship belongs in the canonical graph, where
  it is comparable across snapshots like any other fact and where a future drift report can
  show a container gaining or losing code. A heuristic inside the C4 mapper would be invisible
  to every other view and to drift. Confidence is `STRONGLY_INFERRED` rather than `EXPLICIT`
  because the mapping from build context to running code is an interpretation; the caveat
  travels with the edge so no consumer can read it as proof.
- **Security:** the context string is attacker-controlled. It is only ever compared against
  paths already inside the analysed repository — no filesystem access occurs — and a context
  that is absolute, URL-shaped, or resolves outside the repository (`../..`) is ignored,
  because honouring it would attribute code this analysis never read.
- **Alternatives considered:**
  - **Dockerfile `COPY` analysis:** would be stronger evidence, but it needs Dockerfile
    instruction modelling including multi-stage builds and `ARG`-interpolated paths. Deferred;
    noted as the natural next improvement.
  - **Infer from package name or directory name matching the service name:** rejected. It is
    exactly the kind of resemblance that produces confident nonsense.
- **Files:** `packages/core/src/graph-builder.ts`,
  `packages/core/test/graph-builder.test.ts`

### D-035: Tests resolve packages through `dist/`, so a build must precede them

- **Date / phase / commit:** Phase 2
- **Symptom:** Four Phase 2 tests failed against code that had already been fixed, with
  assertions contradicting the source that was sitting in front of me.
- **Root cause:** each package's `exports` points at `./dist/index.js`, and there is no vitest
  alias, so cross-package imports load the **built** output. `npm run verify` orders
  `build` before `test`, which hides this in the normal workflow. Running `npx vitest run` on
  its own after an edit tests the previous build.
- **Why it matters:** a stale `dist` produces failures that look like logic errors and passes
  that mean nothing. Both are worse than a red build.
- **Decision:** no tooling change — `npm run verify` already enforces the correct order, and
  changing resolution would diverge the test environment from the deployed one. Instead the
  gotcha is recorded in `handoff.md` §11 Critical Context and in the CI workflow, which
  already builds before testing.
- **Files:** `handoff.md`, `packages/*/package.json`, `vitest.config.ts`

### D-036: The UI's decisions live in testable functions, because no browser test exists

- **Date / phase / commit:** Phase 2
- **Context:** Phase 1 recorded honestly that browser rendering is **unverified**: there is no
  DOM test, no headless browser and no visual check in this repository. That is the state in
  which untested UI logic does most of its damage, because nothing exercises it until a person
  opens the page.
- **Decision:** The C4 and Drift views keep their decisions in `packages/web/src/presentation.ts`
  as pure functions — which analysis a drift change belongs to, how a report's state is
  classified, what justifies a projected relationship, which analysis to compare against by
  default — and the components call those functions. `packages/web/test/presentation.test.ts`
  covers them.
- **Why:** These are the decisions where a wrong answer *misleads* rather than merely looking
  wrong. Inspecting a removal in the target snapshot 404s and reads as a broken link. Rendering
  a failed request as "nothing changed" is the single most damaging thing a drift view can do.
  Both are testable without a browser; whether React draws the result is not.
- **Alternatives considered:**
  - **Add jsdom + testing-library and render the components:** rejected for now. It adds a DOM
    dependency and still does not verify layout, fonts or the React Flow canvas, so it would
    convert an honest "unverified" into a misleading "partially verified" while adding
    maintenance surface. Revisit when browser verification is on the table.
- **Consequences:** `packages/web/tsconfig.json` now includes `test`, so the type-aware linter
  covers the new file (D-024). The honest claim remains: **UI logic is unit-tested; UI rendering
  is not verified.**
- **Files:** `packages/web/src/presentation.ts`, `packages/web/test/presentation.test.ts`,
  `packages/web/src/c4.tsx`, `packages/web/src/drift.tsx`, `packages/web/tsconfig.json`

### D-037: C4 and drift are their own tabs, not extra buttons on existing ones

- **Date / phase / commit:** Phase 2
- **Context:** Drift needs a *second* analysis selected, which no existing tab has room for.
  C4 needs progressive disclosure across three levels, which the existing single-select
  `ProjectionTab` expresses as a flat row of buttons — fine for two views of the same kind, not
  for three levels of one model.
- **Decision:** `C4Tab` and `DriftTab` (`packages/web/src/c4.tsx`, `packages/web/src/drift.tsx`)
  are separate tabs. C4 uses a level selector that reads as a progression; Drift uses a
  base-analysis selector defaulting to the previous analysis. `EntityDrawer` now takes its own
  `analysisId` rather than inheriting the sidebar's.
- **Why:** Mixing three abstraction levels into the Architecture tab would invite reading a
  module as an architecture, and would make the omission reporting — the part that carries the
  honesty of these views — impossible to see. Giving the drawer an explicit analysis id is what
  lets a base-state removal be inspected at all.
- **Consequences:** Eight tabs. The sidebar is unchanged; the inspector is opened from C4 and
  from Drift as well as from the entity tables.
- **Files:** `packages/web/src/app.tsx`, `packages/web/src/c4.tsx`,
  `packages/web/src/drift.tsx`, `packages/web/src/entity-drawer.tsx`

### D-038: Bug — the store stamped rebuilt graphs with the database schema version

- **Date / phase / commit:** Phase 2
- **Symptom:** In the container, `GET /api/analyses/:id/snapshot` reported
  `graphSchemaVersion: 1` while the same analysis reported `2` at analysis time, and the
  content digest recomputed from the stored graph
  (`5eb90d4fc2411ae3…`) did **not** match the digest recorded during the analysis
  (`fd93acbaeb0b0c1e…`). `GET /graph` also reported `schemaVersion: 1`.
- **Root cause:** `Store.getGraph()` returned `{ schemaVersion: SCHEMA_VERSION, … }` where
  `SCHEMA_VERSION` is the **SQLite schema** version in `packages/server/src/store.ts`. Two
  different numbers, both called "schema", collided on the same field name. The collision was
  invisible until Phase 2 made the graph's version part of the content digest — the digest
  covers `schemaVersion`, so a graph that claimed a different version hashed differently from
  the very graph it was stored from.
- **Why it mattered:** The persisted `analyses.graph_digest` was unusable: it did not describe
  the graph that came back out of the database. Drift still worked, because both sides of a
  comparison are rebuilt the same way — but a stored digest that disagrees with a recomputed
  one is a trap for anything that later trusts it.
- **Fix:** `getGraph()` stamps `GRAPH_SCHEMA_VERSION` from `@repoatlas/core`. The two versions
  are now separate names for separate things.
- **Why the container and not the tests caught it:** the Phase 2 API tests use `:memory:`, where
  the round trip is fast enough to have passed while the assertion was absent — there simply
  was no assertion comparing the stored digest with the recomputed one.
- **Regression test:** `packages/server/test/drift-api.test.ts` — "recomputes the same identity
  from the stored graph as from the analysed one", which compares the stored digest, the
  recomputed digest and the `/graph` schema version against `GRAPH_SCHEMA_VERSION`.
- **Files:** `packages/server/src/store.ts`, `packages/server/test/drift-api.test.ts`

### D-039: Bug — compose volumes and Docker base images were reported as containers

- **Date / phase / commit:** Phase 2
- **Symptom:** Running C4 against this repository produced a container level containing four
  containers: `node:24-bookworm-slim` (a base image), `repoatlas` (the real service),
  `repoatlas-data` (a **named volume** from the `volumes:` block) and `unknown` (created from
  an `EXPOSE 4300` line, which names nothing). Component level was empty, because the compose
  file writes `build:` in its long mapping form and the parser only understood the short one.
- **Root cause:** three separate extraction faults, all in the same area.
  1. `parseCompose()` matched **any** two-space-indented `name:` in the file. `volumes:`,
     `networks:`, `configs:` and `secrets:` entries are indented identically to services.
  2. `parseCompose()` read `build:` only as a scalar (`build: ./api`). Compose's default form
     is a mapping (`build:\n  context: ./api`), which produced `build: null` — so no module
     could ever be attributed to a container, and C4 level 3 was empty for every real
     repository.
  3. `addDeploymentComponent()` created a `deployment_component` for every marker, so
     `docker.base_image` and `docker.expose` each became a component. An `EXPOSE` line carries
     no service name and no image, hence the node literally called `unknown`.
- **Fix:**
  - `parseCompose()` is scoped to the `services:` block and tracks the indentation services are
    written at, so top-level sections cannot contribute names. It accepts both `build:` forms
    and reads `context:` from the long one.
  - `docker.expose` creates no component. It states a port on an image, not a unit.
  - Every component records `attributes.declaredAs` — `'service'` or `'base_image'` — and the
    C4 projection draws only runtime units, recording the rest in `omitted[]`. `FROM x` is a
    build dependency; drawing it beside the system would place a dependency in the
    architecture as if it were part of the system.
  - Build-context attribution now runs only for `compose.service`, since a base image says
    nothing about which source is inside the image built from it.
- **Why it matters beyond cosmetics:** this is precisely the fabrication failure the product
  exists to prevent, and it was happening silently in our own repository. It was found by
  running C4 against a real repository, not by a test — no test asserted that a volume is not
  a container, because nobody had looked.
- **Regression tests:** `parsers.test.ts` — "does not report a named volume or network as a
  service", "reads the build context from both the short and the long form", "reports no build
  context when the mapping form omits it", "records the line each service is declared on";
  `graph-builder.test.ts` — "creates no component for an exposed port", "marks a base image as
  built-from rather than as a declared service"; `c4.test.ts` — three cases covering base-image
  exclusion at context and container level.
- **Files:** `packages/parsers/src/config.ts`, `packages/core/src/graph-builder.ts`,
  `packages/artifacts/src/c4.ts`

### D-040: Git's "dubious ownership" guard is not disabled

- **Date / phase / commit:** Phase 2
- **Symptom:** Analysing a bind-mounted repository from inside the container produced
  `headCommit: null` and a `GIT_UNAVAILABLE` diagnostic. `git -C /repos/fixture rev-parse HEAD`
  inside the container printed *"fatal: detected dubious ownership in repository"*.
- **Root cause:** git refuses a repository whose owner differs from the process user. The
  container runs as `node`; a bind mount from Windows is owned by root.
- **Decision:** do **not** pass `-c safe.directory=*`. The guard exists because a repository
  owned by another user is a known way to make a git client execute something it should not.
  RepoAtlas already neutralises hooks, credential helpers, external diff drivers and protocol
  allow-lists (`packages/ingest/src/git.ts`), and it reads only — but silently switching off a
  git safety check to make a number look better is exactly the kind of change that should be an
  operator's decision, not a default.
- **Consequences:** History is unavailable for repositories the container does not own. The
  analysis still succeeds, the diagnostic says why, and every other fact is unaffected — which
  is what was observed. The remedy is documented in `docs/deployment.md`: run the container
  with the repository owned by the same uid, or add a `safe.directory` entry in the image.
- **Files:** `packages/ingest/src/git.ts` (unchanged), `docs/deployment.md`,
  `docs/verification.md`

### D-041: Browser verification became possible, so the UI's status changed from unknown

- **Date / phase / commit:** Phase 2
- **Context:** Phase 1 carried an honest standing gap: *"browser rendering is unknown"*. The
  prompt for Phase 2 required re-testing that claim rather than preserving it. Re-reading the
  rule — do not change the claim unless actually verified — the honest next step was to look
  for a real browser capability rather than to keep writing "unknown" by habit.
- **What exists on this machine:** Microsoft Edge and Google Chrome are installed. Node 24 ships
  a global `WebSocket`, so the Chrome DevTools Protocol can be driven with **no dependency at
  all**. Headless `--dump-dom` was not sufficient: it proves a page renders on load, but not
  that clicking a C4 element opens its evidence or that a drift row drills through to the
  right snapshot.
- **Decision:** Add `scripts/verify-browser.mjs`, a CDP driver that launches a headless
  browser, attaches to a page target with flattened sessions, navigates by URL, waits on
  content rather than on a timer, dispatches clicks, and asserts on the resulting DOM. It
  exits non-zero on failure. Run with `npm run verify:browser -- <baseUrl> <browserPath>`.
  It is deliberately **not** part of `npm run verify`: it needs a running server holding at
  least two analyses of the same repository, and a browser binary.
- **Consequence for the product:** two deep-link affordances were added so that screens are
  reachable without a mouse — `#/drift`, `#/c4/container` and so on, with a `hashchange`
  listener so a fragment pasted into an open tab switches the view. Without them there is no
  way to verify a screen without clicking, and a deep link is worth having regardless: an
  architecture or drift view is exactly the thing a person wants to send to a colleague.
  **A real bug was found this way:** before the `hashchange` listener existed, a deep link
  worked on a fresh load and silently did nothing in an already-open application.
- **What is now verified:** `24/24` checks against this repository (which has one analysis, so
  the Drift empty state is what is exercised) and `27/27` against a fixture with two analyses
  and a real change between them. These include: the application mounts, all eight tabs
  render, health reaches the top bar, all three C4 levels draw and each reports what it could
  not draw, selecting a C4 element opens its derivation, its evidence and its relationships'
  graph support, the cited source file is reachable from the element, the drift report renders
  its identity table and summary and individual changes with evidence on both sides, a change
  row drills through to the entity inspector, every other tab renders its content, and there
  are **no uncaught exceptions or console errors**.
- **What remains unverified:** visual layout and styling, at any viewport; the React Flow
  canvas beyond the node count; mouse-wheel zoom and drag behaviour; and rendering in any
  browser other than the two Chromium builds on this machine. Those are recorded in
  `docs/verification.md` §5.
- **Files:** `scripts/verify-browser.mjs`, `package.json`, `packages/web/src/app.tsx`,
  `packages/web/src/c4.tsx`, `docs/verification.md`

---

## Phase 3 - Behaviour, data and traceability

### D-042 - An inline route handler is named after the registration that contains it

**Decision.** When a route registration passes an arrow function or function expression as its
handler (`app.get('/reports', async (request, response) => { … })`), the extractor records a
function entity named `<METHOD> <path> handler`, and the route marker names the same entity.

**Why.** An anonymous argument is not a declaration, so before this the calls inside the handler
were attributed to the enclosing module. On this repository that left all 22 endpoints with no
behaviour behind them: the sequence view reported insufficient evidence and no use case had a
step, even though the call graph was fully populated. An endpoint whose code cannot be reached is
not a recovered endpoint.

The name is derived from text the source already contains, so it is not an invention — but it is
still ours, and the entity records `routeHandler` so the graph can say why the name exists. The
source file is still parsed without parent pointers, so the registration registers the handler
node by identity during the walk rather than the arrow asking what call it belongs to.

### D-043 - Absence is never reported as a contradiction

**Decision.** The consistency engine has five classes, and `CONTRADICTION` is reserved for two
statements that cannot both be true: a projection asserting something the graph does not contain,
or a requirement citing an entity that does not exist. A missing relationship is always
`MISSING_EVIDENCE` or `PARTIAL_EVIDENCE`, and the finding states why absence is not a defect.

**Why.** The obvious failure mode of a consistency checker is to turn "this repository does not
say" into "this repository is wrong". A project with no database has not contradicted anything,
and a report that says so is worse than no report. The rule is enforced by tests that assert
`counts.CONTRADICTION === 0` across empty, partial and complete graphs, and that a
contradiction-class finding can only come from the projection-integrity rule.

The engine also records *agreement* as findings. A report listing only problems reads as an
accusation, and a reader cannot tell three problems out of three checks from three out of thirty.

### D-044 - A stated requirement with no implementation is kept, not dropped

**Decision.** A requirement read from a document is always returned. When nothing in the graph
implements it, its status is `PARTIAL` and its derivation says so.

**Why.** Dropping it converted the most interesting fact about a repository into an absence, and
the consistency rule that reports an unimplemented requirement could then never fire. This
reverses the Phase 2 decision recorded in `packages/core/test/requirements.test.ts`, and the test
that asserted the old behaviour now asserts the new one.

Requirement extraction is deliberately narrow: only a line that states an obligation
(`must`, `shall`, `should`, `is required to`, …) or an identifier (`REQ-001:`) becomes a
requirement. Prose is not mined, because writing requirements on a repository's behalf is not this
tool's job. An `implements_requirement` relationship is created only when the document names
something that resolves to a declared entity.

### D-045 - A use case is capped, and the cap is part of the answer

**Decision.** Steps per use case are capped at 40 and a reachability cap of 24 nodes per subject.
What was cut is reported in the use case's `missing[]` list, never dropped silently.

**Why.** The walk is breadth-first. On this repository a single endpoint reached 330 functions in
six hops, which produced a 2.2 MB payload for one table row and a "use case" that was a call graph
with a title. The cut is stated because the interaction genuinely continues past what is shown —
hiding the cap would let a reader conclude the endpoint does less than it does.

### D-046 - The traceability index builds its models once

**Decision.** `traceAll` builds the requirement and use-case models a single time and shares them
across every entry point.

**Why.** Each `traceSubject` call builds both models from scratch, and both walk the whole graph.
With 22 endpoints the index took 15.2 s per request; it now takes 2.9 s. The split into
`traceSubjectWith` exists for this reason and is noted at the function, because the obvious
refactor — building models per call — is what caused it.

### D-047 - Sequence messages are calls only; there is no return arrow

**Decision.** The sequence projection draws one message per `calls` relationship and states in
`omitted[]` that the graph records no return values or thrown errors.

**Why.** The alternative is a dashed return arrow labelled "assumed", which reads as a fact on a
diagram. A missing return is a property of the extraction, and it belongs where the diagram can be
checked against the repository.

### D-048 - Browser checks wait for content, not for controls

**Decision.** The CDP driver waits for panel content rather than for the label of the control that
opens it, scopes section clicks away from the tab bar, and matches evidence locations by shape
rather than by a fixed list of file extensions.

**Why.** Three separate failures during Phase 3 verification were the driver's, not the UI's: a
check that read the DOM before the data arrived reported a working view as empty; a check that
clicked the first button labelled "Traceability" clicked the *tab*, not the section, and then timed
out on content that was never going to appear; and a check pinned to `.ts/.js/.md` failed whenever
the only change happened to be in a file it had not thought of. A verification tool that reports
working views as broken is worse than none, because it trains the reader to ignore it.

---

## Phase 4 - Richer data access and return messages

### D-049 - A projected arrow's id must be unique within the view, not within a flow

**Decision.** Sequence arrow ids carry the flow they were drawn in: `seq:<entry>:<order>:<from>-><to>`.

**Why.** The order counter restarts at 1 for every entry point, so two endpoints that both reach
`service -> repository` produced two arrows with the same id. Nothing in the projection noticed,
because both arrows were genuinely there. The UI did: an arrow is selected by id, so the evidence
panel showed whichever of the two came first — the right evidence about the wrong interaction. On
self-analysis, 175 of 1205 sequence arrows shared an id with another arrow.

The id was always the projection's own construct; it was never a graph id. Making it unique costs
nothing and removes an entire class of "the UI showed me the wrong thing" report.

### D-050 - A join modifier is a step towards `JOIN`, never a place a table can start

**Decision.** `LEFT`, `RIGHT`, `INNER`, `OUTER`, `CROSS`, `NATURAL` and `LATERAL` are walked over
until the join keyword is found, and the table is read after `JOIN`. `STRAIGHT_JOIN` is treated as a
join keyword in its own right.

**Why.** Reading the table directly after the modifier produced a table named `JOIN` for
`LEFT OUTER JOIN b` and one named `ON` for `STRAIGHT_JOIN b ON 1`. Both are the worst kind of defect
for this product: a fabricated store in a data-flow diagram, with evidence pointing at a real line
of real SQL. The rule is now that a modifier never introduces a table, and the test suite covers the
modifier, the compound keyword and a chain mixing both forms.

### D-051 - A comma-separated table list steps over `AS` as well as the alias

**Decision.** `tableListAfter` steps over the table name, an optional `AS`, and an optional alias,
using the token index past the end of the name rather than assuming it is one token long.

**Why.** `FROM users AS u, orders AS o` reported one table instead of two. The alias is two tokens,
and the walk consumed the `AS`, treated the alias as the table, and stopped. The same
one-token-assumption bug hid behind a schema qualifier: `public.users u` consumed `public` as the
table and `users` as its alias.

An under-read is the more dangerous direction of error here. A missed table makes the data-flow view
look simpler than the repository is, and nothing in the view says a table was dropped — whereas a
surplus table is at least visible to a reader who knows the schema.

### D-052 - A CTE's identity is its defining scope, not its name

**Decision.** A query-expression node id is `cte:<enclosing function>::<name>`.

**Why.** Two functions that each defined `recent_orders` over a different table produced one node
with two `produces` edges pointing into it. The data-flow view then showed a single query result
produced from two stores at once, which no statement in the repository states. A CTE exists only
inside its own statement, so its identity has to include the scope that gives it meaning.

### D-053 - An unclassified statement is identified by where it is, not by what it says

**Decision.** An unclassified-statement node id is `statement:<path>:<line>:<summary>`.

**Why.** Same root cause as D-052 with a different symptom: the summary is a description, and two
different unreadable statements can share one exactly. Merging them made a reader counting unread
queries see one where the repository holds two — a count that is wrong in the direction that hides
a limit of the extractor.

### D-054 - Every parser that records a response must also emit the marker the graph reads

**Decision.** The Python extractor emits `http.response` markers alongside `ParsedFile.responses`,
as the TypeScript extractor already did.

**Why.** The graph builder pairs a response with the endpoint that asked for it by reading markers;
`ParsedFile.responses` is the extractor's own record and reaches nothing downstream. Python emitted
only the record, so a FastAPI handler's response was parsed, held in a field, and then dropped. The
failure mode is indistinguishable from a handler that returns nothing: the graph simply held no
fact that the endpoint answered.

The general rule this establishes: **an extracted record that no graph rule reads is dead weight,
and its absence is invisible.** A new `ParsedFile` field is not finished when the parser fills it;
it is finished when something consumes it, and a test asserts that something does.

### D-055 - `new Response(body)` is a response, and a guard that excludes it is a bug

**Decision.** The response recogniser accepts both `CallExpression` and `NewExpression`; only the
static `Response` / `NextResponse` constructors qualify, and `new URL(...)` remains not a response.

**Why.** The check for a response constructor was written and then made unreachable by an earlier
guard that returned for anything that was not a call. Dead code that reads as coverage is worse
than no code: the next reader believes `new Response(...)` is handled. The regression test now
asserts both directions — that `new Response(JSON.stringify(rows))` is recorded and that
`new URL(...)` is not.

### D-056 - A sequence walk is depth-first, because breadth-first draws returns before the calls that precede them

**Decision.** `sequenceMessages` walks depth-first: call, then everything the callee does, then the
return for that call.

**Why.** With a breadth-first walk, `handler -> service` is emitted, then `service -> database`, then
`service -> handler` returning — so the diagram shows a callee handing back a value before the work
that produced it. That is not a cosmetic ordering problem: it asserts a sequence the code does not
have, and this diagram's entire value is that its arrows can be checked against the source.

Returns are paired by `(callee, caller)` rather than by position, so a return can only ever appear
against the call it belongs to. The walk stays bounded by depth and a visited set, so a cyclic call
graph terminates as it did before.

### D-057 - A return is recorded from a return statement, never from the existence of a call

**Decision.** `returns` edges come from `return <callee>(…)`, from a single-assignment local binding
that the caller returns, or from a response call in a handler. Confidence is `STRONGLY_INFERRED` for
a direct return, `WEEKLY_INFERRED` for the binding inference, `EXPLICIT` for a response the handler
writes.

**Why.** The tempting alternative — a call implies a return — produces a complete-looking diagram of
pure invention. Every arrow has to name the line of source that says it, which is why `returns`
carries the return statement's evidence and not the call's.

The binding inference is deliberately weaker and labelled. `const rows = await findAll(); return rows;`
is the most common way a handler returns something, and the return statement names neither the callee
nor a type. It is recorded, `inferred: true`, with the variable named so a reader can check it. It
requires exactly one binding for that name: assigned twice, the value returned is not established,
and no edge is created.

### D-058 - A self-directed return or failure arrow is dropped

**Decision.** A `returns` or `throws` edge whose source and target are the same node is not created.

**Why.** A function does not hand its value to itself. This arises when a returned name resolves to
the declaration that encloses its use — `return list(...)` inside a method called `list`, or a
variable shadowing an imported name. The edge would put a loop in a sequence view that the code
never states, and it is exactly the kind of arrow a reader does not check.

### D-059 - HTTP responses are observed from the response object, never from the route

**Decision.** A response edge exists only where the handler's body contains a response-producing
call: `res.json`, `res.status(201).json(order)`, `reply.send(x)`, `return Response.json(data)`,
`return JSONResponse(..., status_code=201)`. Status and method come from that call.

**Why.** The alternative — deriving a response shape from `/users` — is how a sequence diagram ends
up asserting a response contract the repository never wrote. Naming a route says what the endpoint
is for; only the code says what it answers with.

The status chained from a configuring call (`res.status(201).json(x)`) is resolved after the walk,
because the producing call is visited before the configuring call it is built on. Doing it during
the walk would have missed every chained status.

### D-060 - Unclassified SQL is a fact, and it is reported rather than dropped

**Decision.** A statement the analyser recognises and declines to classify produces a node carrying
the reason, a consistency finding, and an entry in the data-flow view's `omitted[]`.

**Why.** "No database access here" and "there is a query here I could not read" are different facts,
and only one of them is a statement about the repository. The Phase 3 behaviour — a parser limitation
surfacing as silence — is the specific confusion D-012 warned about, so the distinction is carried
into three places: the graph, the artifact's omission log, and the consistency report.

### D-061 - ORM and query-builder extraction remains unsupported

**Decision.** No ORM or query-builder is supported. `reads` and `writes` come from table names in SQL
the extractor read.

**Why.** Each framework would need its own rules, and each set of rules is a set of guesses about
which call touches which table: `db.users.findMany()` does not name `users` as a store the way
`FROM users` does, and a rule that maps the first path segment to a table name produces data flow for
repositories that never declared it. The consistency engine already reports a declared table that
nothing reads or writes as `MISSING_EVIDENCE` with the reason, so the gap is visible and correctly
attributed to the extractor rather than to the repository.

This is recorded as a deliberate boundary, not an oversight. It is the largest remaining gap in the
data views, and it is the first item after Phase 4.

### D-062 - Python records no `constructor` return shape

**Decision.** A returned `User(1)` is recorded as `kind: 'call'`.

**Why.** Python writes a constructor exactly like a call and has no `new`. Distinguishing them
requires a naming convention, and a naming convention is not a statement in the source. The previous
code carried a `constructor` branch whose pattern was byte-identical to the `call` pattern above it,
so it could never fire — a test asserting constructor returns on the Python side would have been a
test that could not fail.

---
## Deferred, with reasons

Recorded so these are not mistaken for oversights.

| Item | Why deferred |
|---|---|
| C4 architecture, sequence, DFD, use-case, activity, deployment diagrams | **Partly resolved across Phases 2 and 3.** C4 levels 1-3 (D-033, D-034) plus the sequence, activity, data-flow, ER, use-case and traceability views are implemented as evidence-grounded projections. A dedicated deployment view remains deferred: a repository states containers and images, not the topology between them at runtime. |
| ORM and query-builder data access | **Unsupported by decision** (D-061). `reads` and `writes` come from table names in SQL the extractor read. Each framework would require guessing which call touches which store, and a declared table that nothing reads is already reported as missing evidence rather than as a finding against the repository. |
| Column-level data lineage | Not implemented. Every lineage hop is table-level, because that is what a SQL statement names. A column-level edge would have to be inferred from a projection list the extractor does not yet resolve. |
| Requirements and traceability | **Resolved in Phase 3** for what a repository can state: requirements read from documents, use cases over evidenced entry points, and the requirement -> use case -> implementation -> test chain (D-042, D-044, D-046). Business requirements held in an issue tracker, or implied by convention, remain out of reach and are reported as not recovered. |
| Consistency and drift engine | **Implemented in Phases 2 and 3** (D-026 - D-030, D-043). Drift answers what changed; the consistency engine answers what the views disagree about. Semantics-level contradiction detection - two documents describing the same entity differently - is still deferred: it needs an understanding of prose this product does not have. |
| Symbol-level and Git-corroborated rename detection | D-029 records the module-level content-identity rule in force and why the stronger sources are not used yet. |
| Dockerfile `COPY` analysis for container contents | D-034 records why build-context attribution is an inference, and how instruction modelling would strengthen it. |
| Authentication/authorisation relationships | No extractor produces them yet. Reported honestly as `NOT_FOUND` by the gap analysis (D-008). |
| Archive upload endpoint | Extraction, containment and limits are implemented and tested (`extractTarArchive`). The HTTP route is not built. |
| Languages beyond TypeScript/JavaScript and Python | D-003/D-004 explain the current coverage and the path to widening it. |
| Sequence-diagram renderer | D-022 explains why the current renderer cannot express one. The sequence *projection* exists and is verified; only the Mermaid rendering of lifelines and return arrows is outstanding. |
| API authentication and rate limiting | Absent so far. `REPOATLAS_ALLOWED_ROOTS` is the only boundary, and `/api/health` reports when it is not enforced. |
