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
| Build | `npm run build` | **Success.** 5 backend packages via `tsc`; web bundled by Vite |
"| Tests | `npm run test` | **654 passed, 22 files, 0 failed** |

### Test breakdown

| File | Tests | Covers |
|---|---|---|
| `packages/core/test/core.test.ts` | 42 | Confidence algebra, id stability, limits, redaction, evidence store, graph builder, diagnostics |
| `packages/core/test/graph-builder.test.ts` | 59 | Module naming, import and callee resolution, every graph relationship kind, deployment attribution, base-image classification, test-to-endpoint attribution, query-expression and unclassified-statement identity, digests, determinism, limits |
| `packages/core/test/requirements.test.ts` | 28 | Requirement and use-case models: declared versus derived, status, evidence, step limits, determinism |
| `packages/core/test/traceability.test.ts` | 15 | The requirement to use case to implementation to test chain, broken joints, cycle safety, determinism |
| `packages/core/test/drift.test.ts` | 36 | Snapshot identity and serialisation, node/edge/evidence/confidence drift, truncation, rename rules, schema and extractor version incomparability, determinism |
| `packages/ingest/test/ingest.test.ts` | 32 | Path containment, symlink escapes, allow-list, archive entries, language detection, binary sniffing, ignore stack, discovery limits |
| `packages/parsers/test/parsers.test.ts` | 64 | TS entities, imports, calls, routes, inline route handlers, tests, control flow, syntax errors; Python entities, imports, continuations, docstrings, route decorators naming their handler; config, manifests, Markdown requirements, SQL including `ALTER TABLE` foreign keys, compose scoping and both `build:` forms, Dockerfile |
| `packages/parsers/test/sql.test.ts` | 52 | The statement analyser: single and multi-table reads, joins in every modifier form, comma lists with `AS` aliases, schema qualification, subqueries, `EXISTS`, derived tables, CTEs, read/write classification, unparseable and unsupported input, determinism |
| `packages/parsers/test/returns.test.ts` | 38 | Return, throw, binding and HTTP-response records for TypeScript and Python: shapes, awaited calls, status chaining, status-only responses, constructors, `new Response`, unresolved returns |
| `packages/artifacts/test/artifacts.test.ts` | 27 | Dependency, module, class and ER projections, mermaid rendering, cycle detection, omission log, gap analysis invariants |
| `packages/artifacts/test/behaviour.test.ts` | 35 | Sequence and activity projections, data flow, data lineage: call/return/error/response arrows, source ordering, declared asynchrony, arrow-id uniqueness, budget behaviour, limits, determinism |
| `packages/artifacts/test/data-flow-multi.test.ts` | 13 | Multi-table data flow: one flow per table, reads kept distinct from writes, unclassified queries reported as queries, CTEs as query results, lineage read/write counts |
| `packages/artifacts/test/consistency.test.ts` | 27 | Cross-artifact consistency: projection integrity, absence never reported as contradiction, return and response support, query expressions never stored as tables, entity-id uniqueness, entry-point and data coverage, recorded agreement |
| `packages/artifacts/test/c4.test.ts` | 32 | C4 context/container/component mapping, evidence and confidence, base-image exclusion, relationship integrity, determinism, cross-artifact consistency |
| `packages/server/test/analyze.test.ts` | 26 | Full pipeline on TS and Python fixtures, error paths, truncation, secret redaction, determinism, configuration |
| `packages/server/test/api.test.ts` | 25 | Every Phase 1 endpoint, status codes, validation, graph integrity, persistence round trip, stored-analysis limit |
| `packages/server/test/phase3-api.test.ts` | 22 | Requirements, use cases, consistency, traceability and lineage over HTTP: origins, statuses, validation, and the difference between a missing subject and a broken chain |
| `packages/server/test/phase4-pipeline.test.ts` | 17 | Phase 4 end to end through the real pipeline: multi-table access reaching the graph, returns and responses reaching the sequence, lineage read/write separation, consistency over the new facts |
| `packages/server/test/drift-api.test.ts` | 15 | Snapshot identity over HTTP, drift detection through the real store, rename, ordering, validation, failed-analysis refusal, reproducibility |
| `packages/web/test/presentation.test.ts` | 17 | The decisions behind the C4 and Drift views: which snapshot a change belongs to, report state classification, relationship support, default comparison |
| `packages/web/test/phase3-presentation.test.ts` | 25 | The decisions behind the Phase 3 views: stated versus derived wording, requirement order, consistency headline and ordering, chain completeness, lineage hop and usage wording |
| `e2e/self-analysis.test.ts` | 7 | This repository analysed for real; invariants only |

**What the web tests do not cover.** There is no DOM or browser test in this repository.
`presentation.test.ts` covers the logic those views make, not their rendering. The CDP driver in
§4c exercises the real UI in a real browser; it asserts on DOM content, not on appearance. See §5.

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
| D-031 snapshot provenance reported an empty id | `drift-api.test.ts` snapshot-route assertion |
| D-032 a failed analysis compared as a deletion | `drift-api.test.ts` "will not compare a failed analysis" |
| `.tsx` missing from the language map | `ingest.test.ts` language detection |
| `REPOSITORY_EMPTY` firing on unanalyzable files | `ingest.test.ts` "warns when the repository has nothing analyzable" |
| Binary files misclassified as unsupported | `ingest.test.ts` skip-reason assertions |

Defects found by **real repository and container verification** rather than by a unit test:

| Defect | Symptom |
|---|---|
| D-013 | Container exited 1: `Not found handler already set` — only when `staticDir` was configured, which only happens in production |
| D-014 | Linux image failed to build: `ignore` not callable under NodeNext, while Windows succeeded |
| D-038 | Container reported `schemaVersion: 1` and a digest that did not match the one recorded at analysis time — the store stamped rebuilt graphs with the *database* schema version |
| D-039 | C4 container level of this repository contained a named compose **volume** and a Docker **base image**, plus a component literally named `unknown` from `EXPOSE` |

### Phase 4 defects found by probing the new code against real repositories

All seven were found in this session by running the new extraction and projection code against this
repository, Flask, and purpose-built fixtures — not by reading it. Each has a regression test.

| Defect | Symptom as observed | Found by |
|---|---|---|
| D-050 | `LEFT OUTER JOIN b` reported a table named **`JOIN`**; `STRAIGHT_JOIN b ON 1` reported a table named **`ON`** | probing `analyzeSql` with adversarial input |
| D-051 | `FROM users AS u, orders AS o` read **one** table; `public.users u, public.orders o` read one | same probe, after D-050 |
| D-052 | Two same-named CTEs in two functions became **one** node with two producers, reading as one query result fed by two stores | a fixture with two `WITH recent AS` statements |
| D-053 | Two identical unclassified statements counted as **one** | same fixture |
| D-049 | **175 of 1205** sequence arrows shared an id with another arrow, so the evidence panel showed whichever came first | self-analysis of the sequence artifact |
| D-054 | A FastAPI handler's response was extracted into `ParsedFile.responses` and then **dropped** — the graph held no fact that the endpoint answered | parsing a FastAPI fixture |
| D-055 | `new Response(body)` was unreachable behind a guard that returned for anything not a call | reading the guard against the constructor check it preceded |
| D-056 | A breadth-first walk would draw `service -> handler` returning **before** `service -> database` | reading the walk order |
| D-058 | A self-directed `returns` edge put a **loop** in the sequence view | reading the resolution path |
| D-063 | All **19** HTTP responses on this repository's own API were in the graph and **none** were drawn; the diagram showed requests going out with nothing coming back | asking which graph facts reached the diagram |
| D-064 | `addHttpResponses` gated on `file.responses` while reading the `http.response` marker | a test written after D-054 |
| D-065 | Every HTTP response landed past the 60-message cap (positions 93–825) and was cut | the same query as D-063 |
| D-066 | Flask: **128** endpoints, **0** connected to a handler, sequence reported no interaction at all | analysing Flask as a second real repository |
| D-067 | React reported a duplicate key `deployment_component:repoatlas` — every `container-without-code` finding named the same entity twice | the CDP browser check, over a container build |

The pattern worth naming: **D-063, D-064, D-065 and D-066 all presented as a working feature.** In
each case the code ran, the tests passed, and the artifact looked plausible. They were found by
asking a question of the output that the code was not designed to answer — *which facts in the graph
reached the picture?* — and comparing the count to the count in the graph.

---

## 3. Real repository analysis — VERIFIED

### 3a. Command line

```bash
node packages/server/dist/cli.js .
```

Output against this repository, run **after the initial commit** so that git history was
available (Phase 1 figures, retained for comparison):

```
Repository       RepoMapper  (C:\Projects\RepoMapper)
Commit           23301a072c125e6c39a011a3f268d39db48186f2  branch=main
Files            92 discovered, 86 analyzable, 8 skipped
Languages        typescript=55, json=19, markdown=7, unknown=6, yaml=2,
                  javascript=2, dockerfile=1
Graph            1689 nodes, 2842 edges, 3793 evidence records
Explicit share   nodes 100.0%, edges 68.0%
Duration         6571 ms

Node kinds  constant=783, function=285, test=259, configuration=126, module=86,
            interface=73, package=25, type=18, class=14, api_endpoint=13,
            deployment_component=4, repository=1, commit=1, contributor=1
Edge kinds  contains=1611, calls=904, configures=126, depends_on=71, imports=63,
            re_exports=30, exposes=13, declared_in=13, deploys=4,
            extends=3, implements=3, authored_by=1
```

The same command re-run in **Phase 3** against the Phase 3 tree:

```
Repository       RepoMapper  (C:\Projects\RepoMapper)
Commit           954f3d7317ee49cb3bdc1a8a7f557bbfb94a6ba5  branch=main
Files            116 discovered, 110 analyzable, 8 skipped
Languages        typescript=78, json=19, markdown=7, unknown=6, javascript=3,
                  yaml=2, dockerfile=1
Graph            4582 nodes, 6983 edges, 9144 evidence records
Explicit share   nodes 99.9%, edges 72.5%

Node kinds  constant=1491, condition=1480, test=608, function=513,
            configuration=127, interface=115, module=110, type=35,
            requirement=31, package=25, api_endpoint=22, class=14, table=6,
            deployment_component=2, repository=1, commit=1, contributor=1
Edge kinds  contains=3121, calls=1801, branches=1276, loops=204,
            configures=127, imports=117, deploys=111, depends_on=98,
            declared_in=53, re_exports=39, exposes=22, reads=6, extends=3,
            implements=3, writes=1, authored_by=1
```

The same command re-run in **Phase 4** against the Phase 4 tree:

```
Repository       RepoMapper  (C:\Projects\RepoMapper)
Commit           88d87c2                                     branch=main
Graph            5568 nodes, 8532 edges, 11858 evidence records

Node kinds  constant, condition, test, function, configuration, interface, module,
            type, requirement, package, api_endpoint, class, table,
            deployment_component, repository
Edge kinds  contains=3700, calls=2170, branches=1582, loops=256, configures=197,
            imports=126, deploys=116, depends_on=104, re_exports=40, throws=49,
            returns=78, exposes=22, reads=18, writes=11, declared_in=57,
            extends=3, implements=3
```

Projections built from that graph, same run:

| Artifact | Nodes | Edges | Notes |
|---|---|---|---|
| sequence | 224 | 1265 | 1205 calls, **32 returns**, **19 HTTP responses**, 9 error paths, 22 flows |
| activity | 2209 | 3239 | decision points in source order |
| data-flow | 23 | 29 | `reads` 18 / `writes` 11; two stores from DDL plus references from SQL |
| er-diagram | 21 | 0 | no declared relationship between the tables in this repository's schema |
| c4-component | 115 | 240 | |
| dependency-graph | 110 | 270 | |

Phase 4's own facts are visible in those numbers:

| Observation | Why it is evidence of extraction rather than configuration |
|---|---|
| **19 `returns` edges carrying `httpResponse`**, all 19 drawn in the sequence view | Recovered from `reply.status(201)` / `reply.status(404)` in this repository's own Fastify handlers. Asking *which graph facts reached the picture* is what showed all 19 were in the graph and none were drawn (D-063, D-065). |
| **78 `returns` and 49 `throws` edges** | Every one carries the `return`/`throw` statement as evidence, and `returns` is never created from the existence of a call (D-057). |
| **`reads` 18 with 5 from `join` role** | The join reads come from multi-table statements in this repository's own test fixtures; each edge names the clause it came from, and a read is never recorded as a write. |
| **28 unclassified SQL statements**, each carrying its reason | A `CALL` in a test fixture, a `select` with no resolvable table, an `insert` with no target. Each is reported rather than guessed at (D-060). |
| **`data-flow` shows 23 nodes for 2 declared tables** | The extra nodes are code units and query expressions, not fabricated stores. No store appears that no statement or schema names. |
| **Sequence 1205 calls with 1154 having no return drawn** | The ratio is the honest answer: most calls in this repository have their result discarded or bound without returning it. The view states it rather than drawing an empty arrow. |

Phase 3's own facts are visible in that count and in the projections built from it:

| Observation | Why it is evidence of extraction rather than configuration |
|---|---|
| 1480 `condition` nodes, 1276 `branches` and 204 `loops` | Control flow read from source constructs. No artifact infers a branch from a call graph (D-047). |
| 22 `api_endpoint` nodes and 1801 `calls` | Every endpoint resolves to a handler 
—
 including the inline arrows 
—
 so the sequence view has 257 participants and 1205 messages instead of reporting insufficient evidence (D-042). |
| 31 `requirement` nodes | Requirements read from the 7 Markdown documents in this repository, kept even where no code implements them (D-044). |
| 6 `table` nodes, 6 `reads` and 1 `writes` | Schema and SQL data access read from `schema.sql` and from string-literal statements in code. |
| Sequence 257/1205, activity 1809/2565, data flow 7/7 | Drawn only from the relationships above; each projection lists what it could not evidence. |

The same command in **Phase 2** produced **2173 nodes, 3769 edges, 5280 evidence records**.
The growth since then is Phase 2's own code plus the `deploys` edges from build-context
attribution (D-034) and Phase 3's control-flow, data-access and requirement facts.
The same command re-run in Phase 2 against the grown tree produced **2173 nodes, 3769 edges,
5280 evidence records**. The growth is from Phase 2's own code plus the `deploys` edges
created by build-context attribution (D-034).

Findings that demonstrate real extraction rather than hard-coded output:

- **13 API endpoints** recovered from Fastify route registrations in
  `packages/server/src/app.ts`, including `DELETE /api/analyses/:id`.
- **259 test entities** recovered from `describe`/`it` calls across the test suites.
- **4 deployment components** from `docker-compose.yml` and `Dockerfile`, with `deploys`
  edges — which is why the deployment gap is now `EXPLICIT`.
- **Git-backed facts confirmed against real history**: `branch=main`, the HEAD commit
  resolved, and a `commit` node, a `contributor` node and an `authored_by` edge were
  produced. The commit's changed paths resolved to module nodes, producing `modifies`
  edges once more than one commit exists.
- **A genuine inconsistency reported**: the dependency-hygiene gap names `typescript`,
  `vitest`, `eslint` and `@types/node` as declared-but-never-imported, and
  `@repoatlas/core` and friends as imported-but-not-declared in the root manifest. Both are
  correct: they are workspace-resolved, and the dev tooling is invoked through npm scripts
  rather than imported.
- **ER diagram honestly insufficient**: no SQL DDL exists in this repository, so no table
  is drawn, rather than inventing one.

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

### 3d. Snapshots and drift — VERIFIED

Two consecutive analyses of an unchanged repository, then a real change, then a third
analysis. The change set was introduced deliberately: a **new module**, a **pure rename**
with content untouched, and a **comment-only edit** to a third file. Performed against an
isolated copy of this repository under a temporary directory, with its own Git history, so
nothing in the working tree was disturbed.

**Unchanged content → one identity.**

```
state A   snap_ea4aa18150f22ff8   2045 nodes, 3502 edges, 5018 evidence
state A'  snap_ea4aa18150f22ff8   identical
GET /api/analyses/:id/drift → identical: true, comparable: true, totalChanges: 0
```

**After the change set:**

```
state A   snap_990760c77824bfea   commit 56152651
state B   snap_48c9d2b5c3d15ad4   commit 56152651
identical false | comparable true | targetIncomplete false | removalConfidence EXPLICIT

nodesAdded 5   nodesRemoved 0   nodesModified 20   nodesRenamed 1
relationshipsAdded 27   relationshipsRemoved 21   relationshipsModified 0
evidenceAdded 33  evidenceRemoved 25  evidenceChanged 25  confidenceChanged 0
totalChanges 157      change records 157      reproducible true
```

Observed change records, each traced back to a real location:

| Category | Entity | Claim | Evidence before | Evidence after |
|---|---|---|---|---|
| `NODE_RENAMED` | `module:packages/core/src/diagnostics` → `…/diagnostic-log` | `STRONGLY_INFERRED` | `packages/core/src/diagnostics.ts:1` | `packages/core/src/diagnostic-log.ts:1` |
| `NODE_ADDED` | `class:snapshotledger` | `EXPLICIT` | — | `packages/core/src/snapshot-extra/helper.ts:6` |
| `NODE_ADDED` | `function:digestof` | `EXPLICIT` | — | `packages/core/src/snapshot-extra/helper.ts:2` |
| `NODE_MODIFIED` | `class:analysiserror` | `EXPLICIT` | `…/diagnostics.ts:106` | `…/diagnostic-log.ts:106` |
| `EDGE_ADDED` | `function:digestof\|calls\|constant:detailfortype.parts` | `EXPLICIT` | — | `…/snapshot-extra/helper.ts:3` |
| `EVIDENCE_CHANGED` | `class:analysiserror` | `EXPLICIT` | `…/diagnostics.ts:106` | `…/diagnostic-log.ts:106` |

Observations:

- The rename was reported **once**, as a rename. The same file did not also appear as a
  removal and an addition — the rename pairing consumed both.
- Entities declared in the renamed file are reported as modified, with their citations on both
  sides, which is how a reader follows a moved declaration.
- `nodesRemoved 0` is correct: the class and constant nodes declared in the renamed file kept
  their identity because their qualified names did not change. Only the containing module
  changed identity, and that was the rename.
- The commit hash is the same on both sides because the change was made in the working tree
  without committing. This is the documented behaviour: `headCommit` is `HEAD`, not a dirty
  tree hash.

### 3e. C4 architecture recovery — VERIFIED

`GET /api/analyses/:id/artifacts/c4-*` against **this repository** (2173 nodes, 3769 edges):

| Level | Nodes | Relationships | Honest state |
|---|---|---|---|
| `c4-context` | 1 (the software system) | 0 | `insufficientEvidence: true`. No external system recovered: the one declared service image is this project's own image. Records the omission for the unrecognised image, for the base image, and for human actors. |
| `c4-container` | 2 (software system + `repoatlas`) | 1 | One container, `EXPLICIT`, image `repoatlas:0.1.0`, cited to `docker-compose.yml:7`. 25 third-party packages excluded with the reason recorded. |
| `c4-component` | 96 | 181 | Every module the compose build context (`context: .`) places in the image, plus the container for context. Each `contains` relationship carries the real `deploys` graph edge id at `STRONGLY_INFERRED` and cites `docker-compose.yml`. |

Sample relationships, showing that each one names the graph edge behind it:

```
contains repository:repomapper -> deployment_component:repoatlas  EXPLICIT
        support: node deployment_component:repoatlas   evidence: docker-compose.yml:7
contains deployment_component:repoatlas -> module:decisions  STRONGLY_INFERRED
        support: edge module:decisions|deploys|deployment_component:repoatlas
depends_on module:packages/web/src/app -> module:packages/web/src/drift  EXPLICIT
        support: edge module:packages/web/src/app|imports|module:packages/web/src/drift
        evidence: packages/web/src/app.tsx:15
```

**Not recovered, and recorded as omitted rather than invented:** human actors (nothing in the
graph describes who uses the system), external systems (no datastore or broker image is
declared), third-party packages as containers, and any component for a container that declares
no build context.

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

### 4c. Phase 2 in the container — VERIFIED

Container rebuilt from the Phase 2 tree and re-run. Both the read-only self-analysis mount
and a writable isolated fixture were used, the second so a real change could be introduced
between two analyses from the host.

| Check | Result |
|---|---|
| `docker build` | **Success** |
| `GET /api/health` | 200 — `ok`, `pathAllowListEnforced: true`, `allowedRootCount: 1` |
| `GET /api/meta` | 200 — **7 artifacts**, now including `c4-context`, `c4-container`, `c4-component` |
| `GET /` | 200 `text/html` |
| `GET /some/spa/route` (`Accept: text/html`) | 200 `text/html` — SPA fallback |
| `GET /api/nope` | **404 JSON** |
| `POST {"/etc"}` | **403** `PATH_NOT_ALLOWED` |
| `POST {"/repos/fixture/../.."}` | **403** `PATH_NOT_ALLOWED` — traversal refused |
| `POST {"/repos/RepoMapper"}` | **201** — 2172 nodes, 3772 edges, 5280 evidence |
| `GET .../snapshot` | 200 — `snap_fe95c5da68e5a259`, `graphSchemaVersion: 2`, `extractorVersion: 1.0.0` |
| `GET .../graph` | 200 — `schemaVersion: 2` (D-038 fixed; was `1`) |
| `GET .../artifacts/c4-container` | 200 — 2 nodes, 1 relationship, cited to `docker-compose.yml:7` |
| `GET .../artifacts/c4-component` | 200 — 96 nodes, 181 relationships |
| Two analyses of unchanged content | `identical: true`, `totalChanges: 0`, same snapshot id |
| Analysis after a new module was added | `totalChanges: 15`; `class:ledger` added at `packages/core/src/extra/ledger.ts:1` |
| Analysis after a real rename | `nodesRenamed: 1` — `module:core/src/diagnostics` → `module:core/src/diagnostics-renamed`, `claimConfidence: STRONGLY_INFERRED`, evidence on both sides, **0 removals and 0 additions for the same file** |
| Drift of an analysis against itself | 200, `identical: true` |
| Container logs | No errors; warnings only |

One environment-specific observation, reported rather than worked around: the writable fixture
and the read-only self-analysis mount are owned by the host user, so `git` refuses them inside
the container with *"detected dubious ownership in repository"*. RepoAtlas recorded
`GIT_UNAVAILABLE`, left `headCommit` empty and continued — the documented degradation path.
See D-040 for why this is not silently disabled.

### 4c-bis. Phase 3 in the container - VERIFIED

Container rebuilt from the Phase 3 tree and re-run against a small isolated fixture mounted
read-only at `/repos/fixture`: a package manifest, a two-table schema, an inline Express route, a
service, a database wrapper, and a Markdown document stating one requirement.

| Check | Result |
|---|---|
| `docker build` | **Success** (image `repoatlas:p3`) |
| `GET /api/health` | 200 - `ok`, `environment: production`, `pathAllowListEnforced: true` |
| `POST /api/analyses` `{"/repos/fixture"}` | **201** |
| `GET .../requirements` | 200 - 3 requirements: 1 **declared** (`REQ-001`, `OBSERVED`, linked to 1 entity), 1 interface behaviour (`OBSERVED`), 1 persistence (`PARTIAL`) |
| `GET .../use-cases` | 200 - 1 use case for `GET /api/reports`, **3 steps**, actor **not named** because the fixture states none |
| `GET .../consistency` | 200 - findings carrying `evidenceExpected` and `evidenceFound`, **0 contradictions** |
| `GET .../traceability` | 200 - index over the recovered entry point |
| `GET .../artifacts` | 200 - 10 artifacts; `sequence` 4 nodes / 3 edges, `data-flow` 2 / 1, `er-diagram` 2 / 0 |
| `GET .../artifacts/er-diagram` | 200 - both tables; the foreign key declared by `ALTER TABLE` is drawn |
| `GET /` | 200 `text/html` - UI served from the image |

Every Phase 3 endpoint therefore works inside the Linux container on Node 24.21.0, a different
runtime from the host it was developed on.

### 4c-ter. Phase 4 in the container — VERIFIED

Container rebuilt from the Phase 4 tree (image `repoatlas:phase4`) and re-run on Node **v24.21.0**,
against a read-only fixture mounted at `/repos/fixture`. The fixture was written to contain exactly
what Phase 4 claims: a `LEFT OUTER JOIN`, a CTE, a chained status with a returned body, a local
binding returned by its caller, a two-table schema with an `ALTER TABLE` foreign key, and three
routes.

| Check | Result |
|---|---|
| `docker build` | **Success** |
| Container startup and logs | `repoatlas listening`, bound to `127.0.0.1:4300` and `172.17.0.2:4300`; no errors |
| `GET /api/health` | 200 — `ok`, `environment: production`, `pathAllowListEnforced: true`, `allowedRootCount: 1`, `node: v24.21.0` |
| `GET /api/meta` | 200 — **10 artifacts**; `edgeKinds` now includes **`returns`** and **`throws`** |
| `POST /api/analyses` `{"/repos/fixture"}` | **201** — 25 nodes, 41 edges, 35 evidence records; `sql: 1, typescript: 1` |
| `GET .../artifacts/sequence` | 200 — **6 calls, 1 return, 1 HTTP response**, 3 flows. The response arrow reads `responds 404 (status set, body returned from the handler)` and points at the endpoint, not out of it |
| `GET .../artifacts/data-flow` | 200 — `loadUsers` reads **both** `users` (FROM) and `orders` (JOIN); `findUser` reads `users`; `saveOrder` reads `orders`; `recentOrders` **produces** the query expression and reads `orders`. Two omission entries: unclassified statements and query expressions |
| `GET .../lineage/table:orders` | 200 — **3 inbound hops, `usage: { read: 3, write: 0, unclassified: 0 }`**, each hop carrying `operation`, `role` and `statement`, cited to `src/service.ts:2`, `:10`, `:14` |
| `GET .../lineage/table:users` | 200 — `usage: { read: 2, write: 0 }` — reads counted separately from writes |
| `GET .../artifacts/er-diagram` | 200 — both tables with their columns; the foreign key from `ALTER TABLE` present in the `orders.user_id` detail |
| `GET .../requirements` | 200 — 4 stated requirements |
| `GET .../use-cases` | 200 — 3 use cases; the first has **2 steps** |
| `GET .../traceability` | 200 — index over the 3 recovered entry points |
| `GET .../consistency` | 200 — `CONTRADICTION: 0`, 3 `MISSING_EVIDENCE` (entry points with no test relationship), 2 `CONSISTENT` |
| `GET /` | 200 `text/html`, contains `id="root"` |
| `GET /assets/index-*.js` | 200 — 716 169 bytes, the web bundle from the image |
| `POST /api/analyses` `{"/etc"}` | **403** `PATH_NOT_ALLOWED` |
| `POST /api/analyses` `{"/repos/fixture/../../../etc"}` | **403** `PATH_NOT_ALLOWED` — the escaping path resolved and was refused, not sanitised |
| `GET .../lineage/..%2F..%2Fetc%2Fpasswd` | **404** with the message that no data relationship traces to it — no file read attempted |
| Write inside the mounted fixture | **Refused** — `Read-only file system` |
| Container user | `uid=1000(node)`, not root |

**Containment was re-checked, not assumed.** The three traversal probes above are the Phase 1
security checks (D-034, D-040) re-run against the Phase 4 image; all three still refuse.

### 4d-bis. Second real repository — Flask — VERIFIED

`pallets/flask` cloned at depth 1 and analysed through the real pipeline, as a check that Phase 4's
claims are not specific to this repository's own dialect of Fastify.

| | |
|---|---|
| Graph | 2534 nodes, 8131 edges, 6932 evidence records |
| Python entity coverage | 2253 `calls`, 470 `branches`, 61 `loops`, 47 `extends`, 387 `depends_on`, 169 `exposes` |
| Entry points | **128** API endpoints recognised, **all now resolving to a handler** |
| `route.handler` edges | **169** (was **0** before D-066) |
| Sequence | 40 flows — **176 calls, 23 returns, 5 error paths** (was 40 flows with **0 messages**) |
| Failure sites | **240** `throws` edges from explicit `raise` statements |
| Data access | 6 `reads`, 5 `writes` across `insert_into`, `update_target` and `delete_target` roles |
| Lineage | `user`: read 3, write 1 · `post`: read 3, write 4 |
| Data flow | 11 edges over 2 tables, `insufficientEvidence: false` |
| Consistency | `CONTRADICTION: 0`, 7 `MISSING_EVIDENCE`, 1 `PARTIAL_EVIDENCE`, 2 `CONSISTENT` — down from **131** missing-evidence findings before the decorator fix |
| SQL not read | 19 unclassified statements, each carrying its reason rather than producing a guessed read |

**What Flask did and did not exercise.** It is a Python web framework, so it proved the Python
extraction paths: route decorators naming handlers, `raise` producing failure sites, `return`
producing returns, and the same SQL analyser reading Python string literals. It is **not** a
multi-table-SQL repository — its 6 reads and 5 writes all come from documentation examples and test
fixtures, so this run does **not** demonstrate richer data access on a third-party codebase. The
multi-table, subquery and CTE claims rest on the `sql.test.ts` fixtures and on the Phase 4 fixture
repository, and that is stated rather than papered over.

### 4d. Browser — PARTIALLY VERIFIED

Phase 1 recorded browser rendering as *unknown*. It is no longer unknown: a real headless
Chromium was driven over the DevTools Protocol with **no added dependency**, because Node 24
ships a global `WebSocket` (`scripts/verify-browser.mjs`, D-041).

```
npm run verify:browser -- http://127.0.0.1:4300 "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

The driver navigates by URL, **waits on content rather than on a timer** — a fixed sleep would
let a check pass against a page whose data had not arrived, which is how a broken view gets
reported as a working one — dispatches real clicks, and reads the resulting DOM.

**Run 1 — this repository, one analysis: 38/38 passed.** Phase 2 recorded 24/24 for the same shape of run; the extra checks are the Phase 3 tabs.

| Check | Result |
|---|---|
| Application loads, React mounts | pass |
| All ten tabs render | pass - `Overview Architecture C4 Structure Behaviour Traceability Drift Evidence Gaps Diagnostics` |
| Stored analyses listed, health in the top bar | pass |
| No allow-list warning shown while one is enforced | pass |
| C4 context / container / component render, each with its omission table | pass — 2, 3 and 97 canvas nodes |
| Selecting a C4 element opens the panel with its derivation, evidence and relationship support | pass |
| The graph entity inspector opens for the same element; the cited file is reachable | pass |
| **Drift with only one analysis** explains that it needs two, and does **not** say "nothing changed" | pass |
| Architecture, Structure, Evidence, Gaps, Diagnostics render their content | pass |
| Behaviour views: sequence, activity and data flow each render on demand, with data lineage beside them | pass |
| Lineage either traces a store or says the repository moves no data to one | pass |
| Traceability renders requirements, distinguishing stated from derived wording | pass |
| Traceability renders the use-case list, and a use case states what is not evidenced about it | pass |
| Traceability renders the chain index; selecting an entry point opens its requirement-to-test chain with all four joints, zeros included | pass |
| The consistency view names the representations it compared and states that absence is not a contradiction | pass |
| No uncaught exceptions and no console errors | pass |

**Run 2 — two analyses of this repository with a real source change between them: 41/41 passed.** Phase 2 recorded 27/27 against a fixture.

| Check | Result |
|---|---|
| Drift renders the base/target identity table | pass |
| Drift renders the change summary | pass |
| Drift renders individual changes with evidence on both sides (`path:line` for each) | pass |
| A change row offers an inspect action and drills through to the entity inspector | pass |

**A real defect was found by this work.** Before it, a deep link worked on a fresh page load
and silently did nothing in an already-open application, because the tab was initialised once
and never reacted to `hashchange`. Fixed, with the `hashchange` listener now in
`packages/web/src/app.tsx` — and deep links are worth having on their own, since an
architecture or drift view is what a person wants to send to a colleague.

### 4d-ter. Phase 4 in the browser — VERIFIED for function, not for appearance

Run against the **container** build with two analyses of the Phase 4 fixture, so the driver, the
server and the image are all the ones being shipped.

**Run 1 — two analyses of unchanged content: 43/43 passed.**

| Check | Result |
|---|---|
| All ten tabs render | pass |
| Behaviour: sequence renders | pass |
| Sequence draws the participants the artifact names | pass — **9 participants, 8 messages** |
| **A return message in the graph is drawn in the sequence view** | pass — the artifact carries **2 return messages** and the view is not truncated |
| A failure message in the graph is drawn | pass — 0 failure messages in this fixture, reported as such rather than asserted |
| The sequence view states what it could not read | pass |
| Lineage traces a store or says the repository moves no data to one | pass |
| Traceability: requirements, use cases, chain index, and a chain with all four joints | pass |
| Consistency names what it compared and says absence is not a contradiction | pass |
| Drift reports no change between two identical analyses and says the digests match | pass |
| Architecture, Structure, Evidence, Gaps, Diagnostics render their content | pass |
| **No uncaught exceptions and no console errors** | pass |

**Run 2 — after a real change (a new multi-table function was added to the fixture): 45/45 passed.**
The two extra checks are the drift rows: the change summary, the individual changes with evidence on
both sides, the inspect action, and the drill-through to the entity inspector.

**This run found a real defect (D-067).** The first attempt failed one check: React reported a
duplicate key `deployment_component:repoatlas`. Every `container-without-code` consistency finding
listed the same entity twice, because a C4 element projected from one graph entity carries its own
id in `graphNodeIds` and the rule prefixed `node.id` to that list. No test caught it — the
projection's integrity gate checks *support*, not uniqueness — and the artifact itself was correct;
the damage was entirely in the consumers. `nodeIds` is now deduplicated, and a test asserts across
every fixture graph that no finding repeats an entity, a relationship, or an id.

**The evidence panel for a single arrow is not browser-verified.** The driver checks that returns
and failures are drawn and that omissions are stated; it does not click an individual arrow and
assert the panel's contents. That panel is covered by the projection tests and by rendering
inspection, not by the CDP driver.

**Still not verified, and deliberately not claimed:** visual layout, styling and responsive
behaviour at any viewport; React Flow zoom, pan and drag; and any browser other than the
Chromium builds installed here. The driver asserts on DOM content and node counts, not on
appearance, so a visual regression would not be caught.

---

## 5. Not verified — read this

Stated plainly. None of these are claimed as working.

| Item | Status | Why |
|---|---|---|
| **Browser rendering of the UI** | **Partially verified** | Driven in real headless Chromium via the DevTools Protocol (`scripts/verify-browser.mjs`): **45/45** checks pass against the container build with two analyses and a real change between them, **43/43** with unchanged content. Rendering *and* the click paths are covered, including that return and failure messages present in the artifact reach the sequence view. **Still unverified:** visual layout and styling at any viewport, React Flow zoom and drag, any non-Chromium browser, and the per-arrow evidence panel's contents. See §4d-ter. |
| **Return messages in a browser** | **Partially verified** | The sequence view is asserted to draw every return and failure message the artifact carries, and to state what it could not read. The evidence panel opened by clicking a single arrow is **not** asserted by the driver. Covered by projection tests only. |
| **C4 rendering in a browser** | **Verified** | All three levels draw (1, 2 and 43 canvas nodes on the fixture; 2, 3 and 97 on this repository), each shows its omission table, and selecting an element opens its derivation, its evidence locations and the graph support of each relationship. |
| **Drift rendering in a browser** | **Verified** | Identity table, change summary and individual changes with evidence on both sides render; a change row drills through to the entity inspector; the single-analysis empty state explains itself and is not presented as "nothing changed". |
| **Git-backed facts** (commits, contributors, ownership) | **Verified** | Confirmed against real history: `branch=main`, HEAD resolved, and `commit`, `contributor` and `authored_by` entities produced. `modifies` edges from multi-commit history are covered by unit tests. **Exception:** inside the container, a bind-mounted repository owned by another user is refused by `git` as dubious ownership, so no history is read there (D-040). |
| **Deployment diagram** | **Not implemented** | A repository states containers and images, not the topology between them at runtime. The C4 container and component levels are the closest honest substitute and are verified. |
| **Business requirements and traceability** | **Partially verified** | Requirements stated in documents, use cases over evidenced entry points, and the requirement-to-use-case-to-implementation-to-test chain are implemented and verified (§4c-bis, §4d). **Not recovered:** requirements held in an issue tracker, and any requirement implied rather than stated. Both are reported as not recovered. |
| **In-graph consistency checking** | **Partially verified** | The consistency engine compares every view built from one graph and reports unsupported inference, missing evidence, partial evidence and recorded agreement, with a class reserved for genuine contradiction (D-043). Verified by tests, over HTTP, in the browser and in the container. **Not implemented:** semantics-level contradiction detection, where two documents describe the same entity differently. |
| **Symbol-level rename detection** | **Not implemented** | A class moved between files is reported as removed plus added. Only whole-file renames with unchanged content are proved (D-029). |
| **Git-corroborated rename detection** | **Not implemented** | `git log --follow` would corroborate a rename where history exists; not used, because a snapshot must be comparable without Git. |
| **Archive upload over HTTP** | **Not implemented** | `extractTarArchive()` is implemented and unit-tested (unsafe paths, empty archive, size ceiling, real tarball). No route reaches it. |
| **CORS** | **Parsed but not applied** | `REPOATLAS_CORS_ORIGIN` is validated by configuration but never wired into the Fastify instance. Cross-origin browser clients will be blocked. |
| **Rate limiting / API authentication** | **Not implemented** | Known gap. Documented in `docs/deployment.md`. The service must not be described as production-secure. |
| **ORM and query-builder data access** | **Unsupported by decision** | `reads` and `writes` come only from table names in SQL the analyser read. Prisma, SQLAlchemy, Knex, Drizzle, Sequelize and Django ORM produce no data relationship. A declared table nothing touches is reported as `MISSING_EVIDENCE` with the reason, so the gap is visible and attributed to the extractor (D-061). **This is the largest remaining gap in the data views**, and it is not a bug to be fixed by guessing: mapping `db.users.findMany()` to a `users` table is a guess about which call touches which store. |
| **Column-level data lineage** | **Not implemented** | Every lineage hop is table-level, because that is what a SQL statement names. A column-level edge would have to be inferred from a projection list the analyser does not resolve. |
| **Multi-table SQL on a third-party repository** | **Partially verified** | Richer access is verified by 52 analyser tests and by the Phase 4 fixture, and this repository's own SQL extracts 18 reads including 5 from a join. The Flask run (§4d-bis) did **not** exercise it — Flask's queries are all single-table documentation examples. No third-party application repository with real multi-table SQL was analysed. |
| **Return-value resolution** | **Not implemented, deliberately** | A return records that the caller hands a value back, not what type. `return user;` is not resolved to `User`. Resolving it would mean inferring a type from a value, which the source does not state (D-057). |
| **Performance characteristics at scale** | **Not measured** | No benchmark suite. The observations in §6 are single runs, not benchmarks, and say nothing about a 40 000-file monorepo. |
| **Memory profile** | **Not measured** | No instrumentation. |
| **Symlink tests on Windows** | **Partially covered** | Creating symlinks needs elevation, so those two tests early-return. The traversal logic is covered by non-symlink cases; real symlink coverage happens in Linux CI. |
| **Code coverage percentage** | **Not measured** | `npm run test:coverage` is available but was not run, so no percentage is claimed. |
| **Node versions other than 24** | **Not verified** | `engines` requires >= 22.5 because of `node:sqlite`. Only 24.19.0 and the container's version were exercised. |
| **Non-Windows, non-Linux hosts** | **Not verified** | Path handling is written to be platform-neutral and is exercised on Windows and in Linux containers, but no macOS run was performed. |
| **Large-repository limits in practice** | **Not verified** | Limits are unit-tested at small values. Whether 20 000 files / 512 MB completes acceptably in wall-clock time is unknown. |
| **Drift across an extractor or schema change** | **Implemented, deliberately not diffed** | Two snapshots whose extractor or schema versions differ return `comparable: false` with an explanation and zero changes. Covered by tests; no real cross-version pair exists to compare. |
| **Responsive layout, theming, zoom and drag** | **Not verified** | The browser driver asserts on DOM content and node counts, not on appearance. A visual regression would not be caught. |

---

## 6. Performance observation — NOT a benchmark

Single runs on the machine in §1, warm filesystem cache. Every number below is **one
observation**. None was repeated, variance was not measured, and none was taken on a cold
cache or under load. They are existence proofs that the pipeline completes, nothing more.

| Metric | Phase 1 run | Phase 2 run |
|---|---|---|
| Files discovered / analyzable | 92 / 86 | 96 / 90 |
| Nodes / edges / evidence records | 1689 / 2842 / 3793 | 2173 / 3769 / 5280 |
| Wall clock, CLI | 6571 ms | — |
| Wall clock, `POST /api/analyses` (in process) | — | 1.7–1.9 s |
| `GET /api/analyses/:id/drift` over 2173 nodes / 3769 edges | — | 245–305 ms |

The drift figure covers loading both graphs from SQLite, recomputing both content digests
(O(nodes + edges + evidence)) and comparing them. It is one measurement on one machine and
must not be quoted as a throughput characteristic.

Breakdown by stage was not instrumented. If stage-level timings are needed, they must be
added before any claim about where time is spent.

---

## 7. Honest summary

**Working and verified:** the pipeline from a repository path to a fully-cited knowledge
graph; evidence and confidence on every fact; **ten artifact projections** — dependency,
module, class and ER diagrams, three C4 levels, sequence, activity and data flow — each with
honest omission reporting; **multi-table data access** with joins, subqueries, CTEs and correct
read/write separation, and SQL this analyser cannot read reported as such rather than guessed;
**return, failure and HTTP-response messages** in the sequence, each citing the statement that
established it; requirements and use cases read from the repository, with a
requirement-to-use-case-to-implementation-to-test chain; a cross-artifact consistency engine
that reports absence as absence; gap analysis with auditable `NOT_FOUND` claims;
immutable, content-addressed snapshots; deterministic drift detection over nodes, edges,
citations and confidence, with rename proved rather than guessed and removals withheld when
the target analysis was incomplete; SQLite persistence; the HTTP API with correct status
codes and containment; the built web bundle and its served shell; a working container image
verified through Phase 4; **654 passing tests**; clean lint and typecheck.

Verified against two real repositories: **this one** (5568 nodes, 8532 edges; 19 HTTP responses,
78 returns, 49 throws, 18 reads across 11 writes) and **`pallets/flask`** (2534 nodes, 8131 edges;
128 endpoints all resolving to handlers, 240 failure sites, 23 returns).

**Partial and labelled as such:** language coverage (TS/JS solid, Python structural);
call resolution (name-based, never labelled explicit); C4 component boundaries (derived from
a declared build context, which is an inference); rename detection (whole-file, content-
identical only); inline analysis (holds a connection); persistence (single-writer); the web
UI (logic tested, rendering verified by CDP assertions rather than by pixels).

**Not built:** the deployment diagram; business requirements held outside the repository;
semantics-level contradiction detection; symbol-level and Git-corroborated renames; the
archive-upload endpoint; CORS; rate limiting; API authentication; **ORM and query-builder
data access** (unsupported by decision, D-061); **column-level lineage**.

**Unknown:** visual layout, styling, zoom and drag in the browser, and non-Chromium browsers; the
per-arrow evidence panel's rendered contents; multi-table SQL on a third-party application
repository; performance at scale; memory profile; coverage percentage.
