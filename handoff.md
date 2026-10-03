# RepoAtlas — Session Handoff

Read this file first, then `decisions.md` and `flow.md`, before starting work.

---

## 1. Current Phase

**Phase 1 — Foundation: complete and committed.**

The first milestone is delivered and verified: a real repository goes in, and a real,
fully-cited Software Knowledge Graph plus artifact projections and a gap report come out,
reachable through an HTTP API and a browser UI.

The product is **usable and deployable for its stated scope** and **explicitly partial**
beyond it. See `docs/verification.md` for the per-capability status.

---

## 2. Work Completed

- Empty repository inspected; environment verified (Node 24.19.0, npm 12.0.2, git 2.55.0,
  Docker Engine 29.8.1, Windows 11, 16 cores).
- Stack chosen, documented (D-001) and initialised as an npm-workspaces monorepo.
- Six packages implemented: `core`, `ingest`, `parsers`, `artifacts`, `server`, `web`.
- Ingestion: real-path containment with symlink escape blocking, allow-list enforcement,
  layered `.gitignore` evaluation, binary sniffing, bounded walk, read-only git metadata,
  hardened archive extraction.
- Parsers: TypeScript/JavaScript via the compiler API, Python structural extractor with
  dual string views, configuration/manifest/schema scanner.
- Canonical graph: deterministic ids, evidence on every node and edge, four-level
  confidence that downgrades on merge, limits with truncation reporting.
- Four artifact projections plus Mermaid text rendering, each reporting what it could not
  draw.
- Gap analysis with `EvidenceStatus`, an auditable search list, and hedging enforced by
  tests.
- SQLite persistence via `node:sqlite`, WAL enabled, one transaction per analysis.
- Fastify API with typed validation, correct status codes, health and meta endpoints.
- React UI with six tabs and an entity inspector showing evidence and confidence.
- 215 tests across unit, integration, API and end-to-end levels.
- Docker multi-stage image, built and run; container verified against a real repository.
- GitHub Actions CI: lint, typecheck, test, build, plus a container job that builds the
  image, starts it, checks health, analyses a real repository and asserts the allow-list
  refuses a path outside it.
- Operational documentation: `decisions.md` (25 entries), `flow.md`, this file,
  `docs/architecture.md`, `docs/deployment.md`, `docs/verification.md`.

### Bugs found and fixed during this phase

All recorded with symptom, root cause and regression test in `decisions.md`:
D-009 heritage clauses silently lost, D-010 order-dependent symbol resolution, D-011 SQL
columns dropped, D-012 dynamic imports undetected, D-013 production container crash,
D-014 Linux-only module resolution failure, D-015 dropped workspace dependencies in the
image, D-016 validation returning 500, D-017 ambiguous query parameter, D-018 artifacts
dropping edge kind, D-019 unstable ids from repeated path separators.

---

## 3. Files Changed

Everything in the repository. There was no pre-existing code.

```
package.json  package-lock.json  tsconfig.base.json  vitest.config.ts
eslint.config.mjs  .gitignore  .editorconfig  .env.example  .dockerignore
Dockerfile  docker-compose.yml  README.md  decisions.md  flow.md  handoff.md
.github/workflows/ci.yml  scripts/clean.mjs
docs/{architecture,deployment,verification}.md
packages/core/{package.json,tsconfig.json,tsconfig.build.json,src/*,test/*}
packages/ingest/{package.json,tsconfig.json,tsconfig.build.json,src/*,test/*}
packages/parsers/{package.json,tsconfig.json,tsconfig.build.json,src/*,test/*}
packages/artifacts/{package.json,tsconfig.json,tsconfig.build.json,src/*,test/*}
packages/server/{package.json,tsconfig.json,tsconfig.build.json,src/*,test/*}
packages/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/*}
e2e/self-analysis.test.ts
```

---

## 4. Current Architecture / State

```
Repository path
   │
   ▼
resolveRepositoryRoot()      packages/ingest/src/path-safety.ts   containment + allow-list
   │
   ▼
discoverFiles()              packages/ingest/src/discover.ts      bounded, sorted, deterministic
   │
   ├─ readGitMetadata()      packages/ingest/src/git.ts           read-only, hardened argv
   │
   ▼
parseFiles()                 packages/parsers/src/registry.ts     deterministic extraction
   │
   ▼
buildGraph()                 packages/core/src/graph-builder.ts   THE canonical graph
   │
   ▼
projectAtlas()               packages/artifacts/src/index.ts      projections + gap analysis
   │
   ├─ AnalysisService        packages/server/src/service.ts
   ├─ Store (node:sqlite)    packages/server/src/store.ts
   └─ Fastify API            packages/server/src/app.ts
          │
          ▼
     React UI                packages/web/src/
```

Two invariants hold the design together:

1. **Artifacts can only read the graph.** They cannot create a fact, so a diagram can
   never disagree with the model it came from.
2. **Nothing exists without evidence.** Every node and edge cites a file and line, and
   carries a confidence that downgrades on merge.

---

## 5. Decisions Made

25 entries in `decisions.md`. The ones a new contributor must know:

| Decision | Summary |
|---|---|
| D-001 | TypeScript 5.9.3 on Node 24, npm workspaces monorepo |
| D-002 | Strict acyclic package direction; artifacts may not create facts |
| D-003 | TypeScript parsing via the compiler API, offline, no module resolution |
| D-004 | Python as a structural extractor with dual string views; not a full grammar |
| D-005 | `node:sqlite` instead of a native driver, to keep installs toolchain-free |
| D-006 | Analyses run inline with concurrency and timeout bounds; no queue yet |
| D-007 | Confidence is a required field, downgraded on merge |
| D-008 | Gap analysis uses `EvidenceStatus`; never claims absence; tests enforce it |
| D-020 | Every artifact reports what it could not draw |
| D-021 | Deterministic UI layout so the same repository always draws the same picture |
| D-025 | Verification state is recorded explicitly, including what is not verified |

---

## 6. Requirements and Constraints

- **Authorship:** all commits and pushes are solely **PrathamKapoor
  \<prathamkapoor027@gmail.com\>**. No co-authors, no AI or tool attribution, no
  collaborators added. Verify with `git config user.name` / `user.email` before committing.
- **Remote:** `https://github.com/PrathamKapoor/RepoMapper.git`, branch `main`.
- **Do not commit** `paper/`, `research/` or `*.tex` unless explicitly asked.
- **Honesty:** never write "complete", "verified", "production-ready" or "tests passing"
  without having run the check. Use `STATUS: PARTIAL` or `unknown` where true.
- **Never guess facts.** If a root cause was not identified, say so.
- **Security:** never execute repository-provided commands; never expose secrets in
  logs, UI, commits or documentation.
- **Documentation contract:** `decisions.md`, `flow.md` and this file are mandatory and
  must be updated in the same change as the code they describe.

---

## 7. Testing and Verification

Commands, all run from the repository root:

```bash
npm ci                # reproducible install from the lockfile
npm run lint          # eslint, type-aware
npm run typecheck     # tsc --noEmit per package, source + tests
npm run test          # vitest, 215 tests
npm run build         # all packages + web bundle
npm run verify        # lint + typecheck + build + test, in that order
```

Additional verification performed, recorded with output in `docs/verification.md`:

- `node packages/server/dist/cli.js .` against this repository.
- HTTP verification of a running server: health, meta, POST analysis, graph, entity,
  evidence, artifacts, gaps, diagnostics, delete, allow-list refusal.
- `docker build` and `docker run` of the published image; container healthy; UI served;
  1642 nodes and 2795 edges extracted from this repository through the container;
  `/etc` refused with 403 `PATH_NOT_ALLOWED`; SPA fallback returns HTML while unknown API
  routes return JSON.

**Not verified** — see `docs/verification.md` for the full list. Chiefly: browser
rendering was not visually confirmed, and no benchmark numbers are claimed.

---

## 8. Known Issues / Risks

| Issue | Impact | Status |
|---|---|---|
| The UI was never opened in a real browser | A runtime React error would not be caught by any current check | Known gap. `npm run dev:web` and open `localhost:5173` |
| Analyses run inline; long runs hold an HTTP connection | Proxies with short read timeouts need raising | Accepted, documented, D-006 |
| No authentication on the API | Anyone who can reach the port can analyse paths the process can read | Mitigated by `REPOATLAS_ALLOWED_ROOTS`; bound to `127.0.0.1` in compose |
| Python extraction is structural, not a full grammar | Dynamic/metaprogrammed code is not modelled | Documented, D-004. Facts stay ≤ `STRONGLY_INFERRED` |
| Call resolution matches by name | A same-named symbol in another file can be chosen | Labelled `STRONGLY_INFERRED`/`WEEKLY_INFERRED`, never `EXPLICIT` |
| `constant` nodes dominate counts (783 of 1642 here) | Enum members are recorded individually | Cosmetic; consider filtering in projections |
| No CORS/rate-limit middleware | `REPOATLAS_CORS_ORIGIN` is parsed but not applied | Known gap |
| Coverage not yet measured | Unknown blind spots | `npm run test:coverage` available |

---

## 9. Unfinished Work

Ordered by what unblocks the most downstream value. None of these are started.

1. **Consistency and drift engine.** Diff two analyses by node and edge identity; report
   added/removed relationships. Deterministic ids (D-019) are the prerequisite and are in
   place.
2. **Data-flow lineage.** Requires `reads`/`writes` edges from code to tables, which
   requires ORM and query-pattern extraction.
3. **Requirement extraction and traceability**, then requirements-vs-implementation.
4. **Further artifacts** in the documented order: C4, sequence, DFD, use-case, activity,
   deployment — each only once the graph holds its facts.
5. **Archive upload endpoint.** `extractTarArchive()` is implemented and tested; the HTTP
   route is missing.
6. **Wider language coverage** via `web-tree-sitter`, per D-003.
7. **API auth and rate limiting** if the service is ever exposed beyond localhost.
8. **Coverage measurement** and closing any gaps it reveals.

---

## 10. Next Subphase

**Phase 2 — Consistency and drift, plus C4 architecture.**

Why this order:

- Drift is the first feature that needs *two* analyses, and it validates that the graph
  is stable and comparable — which is the assumption every later artifact rests on.
- C4 is the next artifact whose facts are already in the graph: systems, containers and
  components map onto `module`, `package` and `deployment_component`. It needs no new
  extraction, only a projection.

Concrete first steps:

1. Add `diffGraphs(previous, current)` to `@repoatlas/core`, keyed on the deterministic
   node and edge ids, reporting added, removed and changed relationships.
2. Add a `GET /api/analyses/:id/diff?against=<analysisId>` route.
3. Add the C4 projection in `@repoatlas/artifacts`, deriving containers from `package`
   nodes and components from `module` nodes, with every edge carrying its existing
   confidence.
4. Add the diff surface to the UI (a "Drift" tab comparing against a selected analysis).
5. Tests for each, including the case where ids shift because a file was renamed.
6. Update `decisions.md`, `flow.md` and this file in the same change.

---

## 11. Critical Context

Things that are not obvious from the code and cost time to rediscover:

- **`getText()` requires an explicit source file.** The parse tree is built with
  `setParentNodes: false`, so `node.getText()` throws and silently aborts the rest of that
  file's parse. This caused D-009.
- **The symbol index must be complete before relationships resolve**, or extraction
  becomes order-dependent (D-010). Do not "optimise" the two passes into one.
- **SQL markers must emit tables before columns**, or every column is discarded (D-011).
- **`import(...)` is an `ImportKeyword`, not an identifier** (D-012).
- **Fastify permits one not-found handler per prefix** (D-013). `buildApp()` owns it and
  delegates.
- **`ignore` is CommonJS with version-dependent export shapes.** Use
  `resolveIgnoreFactory()`, not a bare default import (D-014).
- **The Docker build must copy `/app/packages` from the deps stage**, not just
  `/app/node_modules`, or workspace-nested dependencies vanish (D-015).
- **The graph route filters nodes before edges**, so responses never contain dangling
  references; do not reorder those two steps.
- **The PostgreSQL `?kind=` parameter is node kinds; edge kinds use `?edgeKind=`** (D-017).
- **Analysis fixtures are built on disk in temp directories**, not committed as a tree, so
  awkward cases (symlink escapes, binary files, unterminated strings) can be constructed
  portably.
- **Symlink tests silently pass on Windows without elevation.** They early-return rather
  than fail. The traversal logic is covered by non-symlink cases, but re-run them on Linux
  CI for real coverage.
- **`REPOATLAS_ALLOWED_ROOTS` empty means no allow-list.** `/api/health` reports it as
  `pathAllowListEnforced: false`. Do not treat that as a safe default.

---

## 12. Agent Instructions

Before any change:

1. Read this file, then `decisions.md`, then `flow.md`.
2. `git status`, `git branch --show-current`, `git log -5 --oneline`,
   `git config user.name`, `git config user.email`. The last two must be exactly
   `PrathamKapoor` and `prathamkapoor027@gmail.com`.
3. `npm run verify` to confirm the tree is green before you change anything. If it is
   already red, say so rather than attributing it to your change.

While changing:

4. Deterministic extraction before inference. If a view needs a fact the graph lacks,
   improve extraction — do not let the view guess.
5. No fact without evidence. No edge without confidence.
6. New node or edge kind: add it to the `NODE_KINDS` / `EDGE_KINDS` union in
   `packages/core/src/types.ts` and to `/api/meta`.
7. Any `NOT_FOUND` gap must list `checked`, state `whatWouldResolve`, and hedge. Tests
   enforce this.
8. Any parser or discovery change needs a test in the same commit.
9. Record the decision, update the flow, update this file — in the same change.

Before committing:

10. `npm run verify` green. If something cannot be verified, say which and why.
11. `git status`, `git diff`, `git diff --cached`. Stage only intended files.
12. Confirm no secrets, no absolute machine paths in committed config, no AI attribution.
13. Commit message in the imperative, describing what changed and why.
14. After committing: `git status` clean, `git log -1 --oneline`, then push to
    `origin main`.

Honesty requirements:

15. Never write "working", "verified", "production-ready" or "tests passing" unless you
    ran the check in this session.
16. Record failed attempts in `decisions.md`, including the symptom and the workaround,
    even when the root cause was not identified (see D-014).
17. If a test asserts something trivial, delete it. A test that cannot fail is worse than
    no test, because it inflates the count and hides the gap.