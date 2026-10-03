# RepoAtlas — Verification Record

What was actually executed, what it produced, and what remains unverified.

**Rules for this file**

- A capability is only marked verified if the command below was run and its output seen.
- Anything not run is listed under §5 with the reason. "Unknown" means unknown.
- Numbers are from the runs recorded here, on the machine described in §1. They are not
  benchmarks.

Run everything with:

```bash
npm run verify     # lint -> typecheck -> build -> test
```

---

## 1. Environment used for these results

| | |
|---|---|
| OS | Windows 11 (10.0.26200) |
| Shell | PowerShell 7.6.6 |
| Node.js | v24.19.0 (container: v24.21.0) |
| npm | 12.0.2 |
| git | 2.55.0.windows.2 |
| Docker | Desktop 4.93.0, Engine 29.8.1, Linux containers |
| CPUs / RAM | 16 cores / ~25 GB |

---

## 2. Automated checks — VERIFIED

`npm run verify` executed end to end. All four stages passed.

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 problems.** Type-aware ESLint 9 with `typescript-eslint` 8 |
| Typecheck | `npm run typecheck` | **0 errors.** `tsc --noEmit` over source *and* tests in all 6 packages |
| Build | `npm run build` | **Success.** 5 backend packages via `tsc`; web bundled by Vite in ~3.8 s |
| Tests | `npm run test` | **215 passed, 8 files, 0 failed** |

### Test breakdown

| File | Tests | Covers |
|---|---|---|
| `packages/core/test/core.test.ts` | 42 | Confidence algebra, id stability, limits, redaction, evidence store, graph builder, diagnostics |
| `packages/core/test/graph-builder.test.ts` | 23 | Module naming, import and callee resolution, every graph relationship kind, determinism, limits |
| `packages/ingest/test/ingest.test.ts` | 32 | Path containment, symlink escapes, allow-list, archive entries, language detection, binary sniffing, ignore stack, discovery limits |
| `packages/parsers/test/parsers.test.ts` | 33 | TS entities, imports, calls, routes, tests, syntax errors; Python entities, imports, continuations, docstrings; config, manifests, SQL, compose, Dockerfile |
| `packages/artifacts/test/artifacts.test.ts` | 27 | All four projections, mermaid rendering, cycle detection, omission log, gap analysis invariants |
| `packages/server/test/analyze.test.ts` | 26 | Full pipeline on TS and Python fixtures, error paths, truncation, secret redaction, determinism, configuration |
| `packages/server/test/api.test.ts` | 25 | Every endpoint, status codes, validation, graph integrity, persistence round trip, stored-analysis limit |
| `e2e/self-analysis.test.ts` | 7 | This repository analysed for real; invariants only |

### Tests that found real defects

Recorded because a test suite that has never caught anything is not evidence of quality.

| Defect | Caught by |
|---|---|
| D-009 heritage clauses silently dropped | `parsers.test.ts` heritage assertion |
| D-010 order-dependent symbol resolution | `graph-builder.test.ts` "regardless of file order" |
| D-011 SQL columns dropped by marker order | `analyze.test.ts` "records tables and columns from SQL" |
| D-012 dynamic `import()` undetected | `parsers.test.ts` import-form assertion |
| D-016 validation returning HTTP 500 | `api.test.ts` "rejects a request with no repository path" |
| D-017 ambiguous `kind` parameter | `api.test.ts` "filters the graph by node kind" |
| D-018 artifacts dropping edge kind | `artifacts.test.ts` dependency-graph assertion |
| D-019 unstable ids from repeated separators | `core.test.ts` slugify assertion |
| `.tsx` missing from the language map | `ingest.test.ts` language detection |
| `REPOSITORY_EMPTY` firing on unanalyzable files | `ingest.test.ts` "warns when the repository has nothing analyzable" |
| Binary files misclassified as unsupported | `ingest.test.ts` skip-reason assertions |

Two further defects were found **only** by building and running the container, and are
covered by the CI `image` job rather than a unit test:

| Defect | Symptom |
|---|---|
| D-013 | Container exited 1: `Not found handler already set` — only when `staticDir` was configured, which only happens in production |
| D-014 | Linux image failed to build: `ignore` not callable under NodeNext, while Windows succeeded |

---

## 3. Real repository analysis — VERIFIED

### 3a. Command line

```bash
node packages/server/dist/cli.js .
```

Output against this repository:

```
Repository       RepoMapper  (C:\Projects\RepoMapper)
Commit           <none>      branch=<none>
Files            91 discovered, 85 analyzable, 8 skipped
Languages        typescript=55, json=19, unknown=6, markdown=6, yaml=2,
                 javascript=2, dockerfile=1
Graph            1686 nodes, 2839 edges, 3791 evidence records
Explicit share   nodes 100.0%, edges 67.9%
Duration         5526 ms

Node kinds  constant=783, function=285, test=259, configuration=126, module=85,
            interface=73, package=25, type=18, class=14, api_endpoint=13,
            deployment_component=4, repository=1
Edge kinds  contains=1609, calls=904, configures=126, depends_on=71, imports=63,
            re_exports=30, exposes=13, declared_in=13, deploys=4,
            extends=3, implements=3

Artifacts
  dependency-graph   82 nodes / 164 edges
  module-graph       1482 nodes / 1502 edges
  class-diagram      105 nodes / 6 edges
      ! types with no in-repository heritage relationship (95)
  er-diagram         INSUFFICIENT EVIDENCE
```

Findings that demonstrate real extraction rather than hard-coded output:

- **13 API endpoints** recovered from Fastify route registrations in `packages/server/src/app.ts`,
  including `DELETE /api/analyses/:id`.
- **259 test entities** recovered from `describe`/`it` calls across the test suites.
- **4 deployment components** from `docker-compose.yml` and `Dockerfile`, with `deploys`
  edges — which is why the deployment gap is now `EXPLICIT`.
- **A genuine inconsistency reported**: the dependency-hygiene gap names `typescript`,
  `vitest`, `eslint` and `@types/node` as declared-but-never-imported, and
  `@repoatlas/core` and friends as imported-but-not-declared in the root manifest. Both are
  correct: they are workspace-resolved, and the dev tooling is invoked through npm scripts
  rather than imported.
- **ER diagram honestly insufficient**: no SQL DDL exists in this repository, so no table
  is drawn, rather than inventing one.

**Honest note on `Commit none / branch=none`:** at the time of this run the repository had
no commits, so there was no history to read. Git-backed facts (contributors, commits,
ownership) are therefore **not verified by that run**. See §5.

### 3b. End-to-end test — VERIFIED

`npx vitest run e2e` → **7 passed**. This test analyses this repository through the real
pipeline and asserts invariants, not counts:

- every node cites at least one evidence record, and every reference resolves;
- every edge's endpoints exist (no dangling references);
- named entities that demonstrably exist are present (`SoftwareGraphBuilder`,
  `EvidenceStore`, `buildGraph`, `discoverFiles`, `TypeScriptSourceParser`,
  `PythonSourceParser`, `ParserRegistry`, `analyseGaps`, `buildDependencyGraph`,
  `AnalysisService`, `Store`, `runAnalysis`, `buildApp`);
- `GET /api/health` is recovered as an endpoint;
- dependency and class projections are non-empty and class edges exist;
- two consecutive runs produce identical node ids, counts and ordering.

### 3c. Determinism — VERIFIED

Analysing the same repository twice produces byte-identical node id lists, node counts and
edge counts. Asserted both in the e2e test and in `analyze.test.ts` ("is deterministic
across repeated runs of the same repository").

---

## 4. HTTP API and container — VERIFIED

### 4a. Native server

A server was started and driven with HTTP requests. All of the following returned the
stated results:

| Request | Result |
|---|---|
| `GET /api/health` | 200 — status `ok`, `pathAllowListEnforced:false`, `analysesStored:0` |
| `GET /api/meta` | 200 — 25 node kinds, 29 edge kinds, 4 confidence levels, 4 artifacts |
| `POST /api/analyses` (real repo) | **201** — 1094 nodes, 1991 edges, 10 gaps |
| `GET /api/analyses/:id` | 200 — stats, gaps, artifact availability with scope strings |
| `GET /api/analyses/:id/graph` | 200 — **zero dangling edges** verified programmatically |
| `GET .../graph?kind=class` | 200 — only class nodes |
| `GET .../graph?q=ReportService` | 200 — matched |
| `GET .../graph?limit=2` | 200 — `truncated:true`, `totals.matching` > 2 |
| `GET .../nodes/:nodeId` | 200 — node, relationships, neighbours, evidence |
| `GET .../evidence` | 200 — excerpts present, **no secrets** |
| `GET .../artifacts/dependency-graph` | 200 — contains `flowchart` |
| `GET .../artifacts/does-not-exist` | 404 — message lists the valid kinds |
| `GET .../gaps` | 200 — all four statuses present |
| `GET .../diagnostics` | 200 |
| `DELETE /api/analyses/:id` | 204, then 404 on re-read |
| `POST` with missing field | **400** `BAD_REQUEST` (D-016) |
| `POST` with unknown field | **400** — strict schema |
| `POST` non-existent path | **404** `PATH_NOT_FOUND` |
| `POST` outside allow-list | **403** `PATH_NOT_ALLOWED` |
| `GET /api/analyses/not-a-uuid` | 400 — malformed id, no crash |
| `GET /api/nope` | 404 — JSON, not HTML |

### 4b. Container

```bash
docker build -t repoatlas:0.1.0 .
docker run -d --name repoatlas-verify -p 127.0.0.1:4321:4300 \
  -e REPOATLAS_ALLOWED_ROOTS=/repos \
  -v "C:\Projects\RepoMapper:/repos/target:ro" \
  -v repoatlas-verify-data:/data repoatlas:0.1.0
```

| Check | Result |
|---|---|
| `docker build` | **Success** (three stages: deps → build → runtime) |
| Container status | **Up (healthy)** — the image health check passed |
| `GET /api/health` | 200 — `"status":"ok"`, `"environment":"production"`, `"pathAllowListEnforced":true`, `"allowedRootCount":1` |
| `GET /` | 200, `text/html`, contains `id="root"` — **UI is served** |
| `POST /api/analyses` `{"/repos/target"}` | **201** — **1642 nodes, 2795 edges, 3747 evidence records** |
| `GET .../graph` on that analysis | 200 — 1642 nodes, 2795 edges, **0 dangling edges**; node kinds include 259 `test`, 285 `function`, 25 `package`; endpoints include `GET /api/analyses/:id` |
| `POST` `{"/etc"}` | **403** `PATH_NOT_ALLOWED` — allow-list enforced in the container |
| `GET /some/client/route` (Accept: text/html) | 200 `text/html` — SPA fallback works |
| `GET /api/does-not-exist` | **404 JSON**, not HTML |
| SQLite row counts in `/data` | analyses 2, nodes 1642, edges 2795, evidence 3747, artifacts 4, diagnostics 44 |

The database row counts matching the API response confirms persistence round-trips
correctly through the container's volume.

---

## 5. Not verified — read this

Stated plainly. None of these are claimed as working.

| Item | Status | Why |
|---|---|---|
| **Browser rendering of the UI** | **Unknown** | The API and the built bundle were verified, and the HTML shell is served, but the UI was never opened in a real browser. A React runtime error would not be caught by any current check. Run `npm run dev:web` and open `localhost:5173`. |
| **Git-backed facts** (commits, contributors, ownership) | **Unknown at time of writing** | The CLI run in §3a executed on a repository with no commits, so the history path produced nothing. The code path is covered by unit tests with synthetic commits and by a test asserting `NOT_FOUND` for a non-repository, but it has **not** been observed against real history. |
| **C4, sequence, DFD, use-case, activity, deployment diagrams** | **Not implemented** | Each needs graph facts that do not exist yet. Deliberately absent rather than drawn from guesses. |
| **Requirements extraction and traceability** | **Not implemented** | Needs document-structure parsing. |
| **Consistency and drift engine** | **Not implemented** | Needs two comparable analyses. Deterministic ids are the prerequisite and are in place. |
| **Archive upload over HTTP** | **Not implemented** | `extractTarArchive()` is implemented and unit-tested (unsafe paths, empty archive, size ceiling, real tarball). No route reaches it. |
| **CORS** | **Parsed but not applied** | `REPOATLAS_CORS_ORIGIN` is validated by configuration but never wired into the Fastify instance. Cross-origin browser clients will be blocked. |
| **Rate limiting / API authentication** | **Not implemented** | Known gap. Documented in `docs/deployment.md`. |
| **Performance characteristics at scale** | **Not measured** | No benchmark suite. One observed data point: 91 files / 5 500 ms on this machine. That is a single observation, not a benchmark, and says nothing about a 40 000-file monorepo. |
| **Memory profile** | **Not measured** | No instrumentation. |
| **Symlink tests on Windows** | **Partially covered** | Creating symlinks needs elevation, so those two tests early-return. The traversal logic is covered by non-symlink cases; real symlink coverage happens in Linux CI. |
| **Code coverage percentage** | **Not measured** | `npm run test:coverage` is available but was not run, so no percentage is claimed. |
| **Node versions other than 24** | **Not verified** | `engines` requires >= 22.5 because of `node:sqlite`. Only 24.19.0 and the container's 24.21.0 were exercised. |
| **Non-Windows, non-Linux hosts** | **Not verified** | Path handling is written to be platform-neutral and is exercised on Windows and in Linux containers, but no macOS run was performed. |
| **Large-repository limits in practice** | **Not verified** | Limits are unit-tested at small values. Whether 20 000 files / 512 MB completes acceptably in wall-clock time is unknown. |

---

## 6. Performance observation — NOT a benchmark

One run, on the machine in §1, warm filesystem cache, `includeGitHistory: false`:

| Metric | Value |
|---|---|
| Files discovered / analyzable | 91 / 85 |
| Nodes / edges / evidence records | 1686 / 2839 / 3791 |
| Wall clock | 5526 ms |

This is reported because it is the one number that was actually observed. It is **not** a
benchmark: it was not repeated, variance was not measured, and it was not taken on a cold
cache or under concurrent load. Treat it as an existence proof that the pipeline completes
in seconds on a small repository, and nothing more.

Breakdown by stage was not instrumented. If stage-level timings are needed, they must be
added before any claim about where time is spent.

---

## 7. Honest summary

**Working and verified:** the pipeline from a repository path to a fully-cited knowledge
graph; evidence and confidence on every fact; four artifact projections with honest
omission reporting; gap analysis with auditable `NOT_FOUND` claims; SQLite persistence; the
HTTP API with correct status codes and containment; the built web bundle and its served
shell; a working container image; 215 passing tests; clean lint and typecheck.

**Partial and labelled as such:** language coverage (TS/JS solid, Python structural);
call resolution (name-based, never labelled explicit); inline analysis (holds a
connection); persistence (single-writer).

**Not built:** the artifact types listed in §5, requirements, consistency and drift, the
archive-upload endpoint, CORS, rate limiting, API authentication.

**Unknown:** browser rendering, real git history, performance at scale, memory profile,
coverage percentage.