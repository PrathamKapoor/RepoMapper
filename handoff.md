# RepoAtlas — Session Handoff

Read this file first, then `decisions.md` and `flow.md`, before starting work.

---

## 1. Current Phase

**Phase 4 — richer data access and return messages: complete, verified and committed.**

The graph now carries what a sequence diagram needs to be more than a call graph. Data access
reads every table a SQL statement touches — joins, comma lists, subqueries, CTEs,
`UPDATE … FROM`, `DELETE … USING`, several statements in one literal — with reads and writes kept
apart and each edge naming the clause it came from. Sequence views draw return, failure and HTTP
response arrows, every one citing the statement that established it. A statement the analyser will
not read is reported as unread rather than ignored.

The product is **usable and deployable for its stated scope** and **explicitly partial** beyond
it. Rendering is verified by CDP assertions (43/43 with two identical analyses, 45/45 with a real
change between them, both against the container build), not by pixels; visual layout, zoom, drag,
non-Chromium browsers and the per-arrow evidence panel remain unverified (D-041, D-048).
Per-capability status is in `docs/verification.md`.

---

## 2. Work Completed

Carried over from Phase 1: the pipeline, six packages, containment, extraction, the canonical
graph, gap analysis, persistence, the API, the UI, the container image and CI. Carried over
from Phase 2: snapshots and drift, content digests, the C4 projections at three levels,
deployment attribution by build context, and the Snapshot and Drift views.

Carried over from Phase 3: explicit control flow, SQL data access, schema constraints, declared
requirements, requirement → use case → implementation → test traceability, the behaviour and
data projections, and the cross-artifact consistency engine.

Phase 4 added, in dependency order:

- **A SQL statement analyser** (`parsers/src/sql.ts`) replacing Phase 3's single-table regular
  expressions. A tokeniser plus a clause walker, not a grammar: it reads joins in every modifier
  form, comma lists with `AS` aliases, schema-qualified names, subqueries at any depth, `EXISTS`
  and `IN` subqueries, derived tables, `UPDATE … FROM`, `DELETE … USING`, `INSERT … SELECT` and
  several statements in one literal. Comments and string bodies are dropped during tokenisation,
  which is what stops `SELECT * FROM x -- FROM y` reporting a read of `y`. Anything it cannot
  classify returns a reason.
- **Read and write kept apart, per table.** One `reads` or `writes` edge per table, carrying the
  clause the name appeared in and the statement it came from. A table in a `WHERE` is not a store
  this statement writes; a joined table is not a write target. A statement that both reads and
  writes is recorded as both, on different tables.
- **CTEs as query expressions, never as stores.** `WITH recent AS (…) SELECT … FROM recent`
  produces a query-expression node held by the function whose statement defined it, plus the
  physical tables its body reads. A CTE name never reaches a table node, and the consistency
  engine contradicts it if one ever does.
- **Unclassified SQL is reported.** A statement recognised and declined produces a node with the
  reason, a consistency finding, and an entry in the data-flow omission log — so "a query is here
  that I could not read" never reads as "no database access here".
- **Return, failure and response facts** (`returns` and `throws` edges, `hasReturn`,
  `returnCount`, `throwSites`). Recovered from `return`/`await`/`throw`/`reject`/`raise` and
  response calls. Never inferred from the existence of a call, which is the one thing that would
  have made the diagram look complete and be wrong.
- **A Python route decorator names the function below it.** Before this, Flask produced 128
  endpoints and none connected to a handler, so the sequence view reported no interaction for the
  whole repository (D-066).
- **A depth-first sequence walk that always closes its calls.** A return is drawn after the work
  that produced it, and the budget bounds new calls rather than messages, so a drawn call can
  never lose its hand-back (D-056, D-065).
- **Lineage says how a store is used** — reads, writes and unclassified counted separately, each
  hop carrying its operation, clause and statement.
- **Four new consistency rules**, checking that returns and failures are backed by calls, that a
  response is paired with an endpoint, that a query expression is not a stored table, and that
  unclassified statements are reported.
- **An evidence panel for a single arrow** in the behaviour view, and read/write usage wording in
  the lineage panel.
- **Graph schema version 4** and **extractor version 1.1.0**, so a version 3 snapshot is
  reported incomparable rather than reinterpreted.
- **165 new tests** (489 → 654), including fourteen defects found by running the new code against
  real repositories.
- **Verification**: real self-analysis (5568 nodes, 8532 edges; 19 HTTP responses, 78 returns,
  49 throws, 18 reads), a second real repository (`pallets/flask`: 2534 nodes, 128 endpoints all
  resolving to handlers, 240 failure sites), every endpoint exercised in a Linux container, and
  the browser driver at 43/43 and 45/45 against the container build.

### Phase 3 added, in dependency order:

- **The facts behaviour views need.** Explicit control flow (`branches`, `loops` edges to
  `condition` nodes) for TypeScript and Python; `isAsync` where the declaration states it;
  SQL `reads` and `writes` from single-table statements in string literals; DDL primary keys,
  foreign keys, nullability and uniqueness, including foreign keys added by `ALTER TABLE`;
  `references` edges between declarations.
- **Inline route handlers are named** (D-042). `app.get('/x', async (req, res) => { … })` is
  the most common handler shape in Express, Fastify and Hono code, and an anonymous argument
  is not a declaration. Without a name, every endpoint in this repository had no behaviour
  behind it: the sequence view reported insufficient evidence and no use case had a step.
- **Requirement and use-case models** (`requirements.ts`, `use-cases.ts`). Declared
  requirements are read from Markdown lines that state an obligation, never from prose; a
  stated requirement with no implementation is kept and marked `PARTIAL` (D-044). Use cases
  start from evidenced entry points, bound their traversal, and list what is not evidenced.
- **Sequence, activity, data-flow and lineage projections** (`behaviour.ts`, `data-flow.ts`),
  each with its own rule and its own `omitted[]`. No return arrow is drawn, because the graph
  records no return (D-047).
- **A cross-artifact consistency engine** (`consistency.ts`) with five classes, where
  `CONTRADICTION` is reserved for two statements that cannot both be true and a missing
  relationship is always missing *evidence* (D-043). Agreement is recorded too, so problems
  have context.
- **Traceability** (`traceability.ts`): the requirement → use case → implementation → test
  chain, with each broken joint named and the index building its models once (D-046).
- **A `tests` edge** from a test to the endpoint whose handler it calls, which is what makes
  the last joint of the chain recoverable.
- **Five HTTP endpoints**: `/requirements`, `/use-cases[/:useCaseId]`, `/consistency`,
  `/traceability[/:nodeId]`, `/lineage/:nodeId`.
- **Two new UI tabs** (Behaviour, Traceability), progressive disclosure throughout, with the
  decision logic in `presentation.ts` under test rather than inside components.
- **Graph schema version 3**, because the shape of the graph changed.
- **160 new tests** (329 → 489), including the defects below.
- **Verification**: real self-analysis of this repository (4582 nodes, 6983 edges, sequence
  257/1205), every Phase 3 endpoint exercised in a Linux container, and the browser driver at
  38/38 and 41/41.

### Bugs found and fixed during Phase 4

Every one was found by running the new code against real repositories or adversarial input, not by
reading it. Four presented as a working feature: the code ran, the tests passed, and the artifact
looked plausible.

| | Symptom | Root cause |
|---|---|---|
| D-050 | `LEFT OUTER JOIN b` reported a table named `JOIN`; `STRAIGHT_JOIN b ON 1` reported one named `ON` | A join modifier was treated as introducing the table instead of stepping towards `JOIN` |
| D-051 | `FROM users AS u, orders AS o` read one table | The alias is two tokens; the walk consumed the `AS`. Same bug hid behind `public.users u` |
| D-052 | Two same-named CTEs became one node with two producers, reading as one query result fed by two stores | Node id keyed by the CTE's name, which means nothing outside its statement |
| D-053 | Two identical unclassified statements counted as one | Node id keyed by the statement's summary, which is a description |
| D-054 | A FastAPI response was extracted and then dropped — the graph held no fact the endpoint answered | Python emitted `ParsedFile.responses` but not the `http.response` marker the graph builder reads |
| D-055 | `new Response(body)` unreachable | A guard returned for anything that was not a call, ahead of the check written to accept it |
| D-058 | A self-directed return put a loop in the sequence view | A returned name resolving to the declaration enclosing its use |
| D-063 | All 19 HTTP responses on this repository's own API were in the graph and none were drawn | `reply.status(404); return { … }` is Fastify's way of answering and was not recognised |
| D-064 | `addHttpResponses` gated on one field and read another | The mechanism behind D-054; found by a test written after the fix |
| D-065 | Every response landed past the 60-message cap and was cut | Returns come after the callee's subtree; bounding messages orphaned the hand-back of work already drawn |
| D-066 | Flask: 128 endpoints, 0 handlers, sequence reported no interaction | A decorator sits above the function it serves and cannot name it |
| D-067 | React reported a duplicate key `deployment_component:repoatlas` | A C4 element lists its own id in `graphNodeIds`, and the rule prefixed `node.id` to that |

The question that found most of them: **which facts in the graph reached the picture?** Comparing
that count against the count in the graph is what turned "the feature works" into "the feature
runs and is invisible".

### Bugs found and fixed during Phase 3

| | Symptom | Root cause |
|---|---|---|
| D-042 | Sequence reported insufficient evidence on every real repository | Inline route callbacks were not entities, so endpoint → handler resolution had nothing to resolve |
| D-044 | A declared requirement with no implementation vanished from the report | The model filtered orphans out instead of marking them `PARTIAL` |
| D-045 | A use case was 2.2 MB of JSON with 330 steps | Breadth-first walk of a dense call graph, unbounded in width |
| D-046 | `/traceability` took 15.2 s per request | Models rebuilt per entry point instead of once |
| D-048 | The browser driver reported working views as broken, and a broken view as working | It waited on control labels rather than content, and clicked a tab where it meant a section |
| — | The activity projection reported a limit count of **-650** | Node count used for the unit count included decision nodes |
| — | An endpoint named its handler with the arrow's source text | An anonymous handler has no name to resolve; it now gets one derived from the registration |

## 3. Files Changed

Phase 4 (this phase):

```
packages/parsers/src/sql.ts             NEW   SQL tokeniser + clause walker: joins, subqueries,
                                                 CTEs, multi-statement literals, read/write roles
packages/parsers/src/typescript.ts              await/return/throw/binding/HTTP-response records;
                                                 chained status resolution after the walk
packages/parsers/src/python.ts                 return / raise / response records; route decorator
                                                 attached to the definition below it
packages/parsers/src/contract.ts               the four new ParsedFile fields, initialised
packages/parsers/test/sql.test.ts       NEW   52 statement-analysis tests
packages/parsers/test/returns.test.ts   NEW   38 return, throw and response tests
packages/core/src/types.ts                     returns/throws edge kinds; ThrowRecord,
                                                 ReturnRecord, BindingRecord, CallResult,
                                                 HttpResponseRecord
packages/core/src/graph.ts                     GRAPH_SCHEMA_VERSION 3 -> 4
packages/core/src/snapshot.ts                  EXTRACTOR_VERSION 1.0.0 -> 1.1.0
packages/core/src/graph-builder.ts             addReturnFacts (statements, bindings, throws,
                                                 HTTP responses), query expressions, unclassified
                                                 statements; scoped node ids
packages/core/test/graph-builder.test.ts       CTE and statement identity, return facts
packages/artifacts/src/behaviour.ts            depth-first walk, return/error/response arrows,
                                                 call-bounded budget, per-flow arrow ids
packages/artifacts/src/data-flow.ts            query-expression and unclassified omission entries;
                                                 lineage operation, role, statement, usage
packages/artifacts/src/consistency.ts          return support, response pairing, query-expression
                                                 scope, unclassified statements; deduped ids
packages/artifacts/test/behaviour.test.ts      return ordering, response labels, arrow-id uniqueness
packages/artifacts/test/data-flow-multi.test.ts NEW  13 multi-table flow and lineage tests
packages/artifacts/test/consistency.test.ts    the four new rules; entity-id uniqueness
packages/server/test/phase4-pipeline.test.ts NEW  17 end-to-end tests over the real pipeline
packages/web/src/phase3.tsx                    interaction evidence panel; lineage usage wording
packages/web/src/graph.tsx                     selectable arrows
packages/web/src/api.ts                        LineageHop.operation/role/statement, Lineage.usage
packages/web/test/phase3-presentation.test.ts  lineage wording tests
scripts/verify-browser.mjs                     return, failure and omission checks
```

Phase 3 (previous phase):

```
packages/core/src/types.ts                  condition nodes; branches/loops/references/tests edge kinds; isAsync
packages/core/src/graph.ts                  GRAPH_SCHEMA_VERSION 2 -> 3; allNodes()/allEdges()
packages/core/src/graph-builder.ts          condition facts, SQL reads/writes, DDL keys and FKs,
                                           endpoint -> handler, declared requirements, tests edges
packages/core/src/requirements.ts           declared requirements kept when unimplemented; PARTIAL status
packages/core/src/use-cases.ts              bounded steps (40), step-support matching, cut reported
packages/core/src/traceability.ts     NEW   requirement -> use case -> implementation -> test chain
packages/core/test/requirements.test.ts    requirement and use-case model tests
packages/core/test/traceability.test.ts NEW  chain, broken joints, cycle safety
packages/parsers/src/typescript.ts         control flow, isAsync, inline route handler naming, shared SQL reader
packages/parsers/src/python.ts             control flow and isAsync for Python
packages/parsers/src/config.ts              Markdown requirements, DDL constraints, ALTER TABLE foreign keys
packages/parsers/test/parsers.test.ts       inline handlers, Markdown requirements, ALTER TABLE FKs
packages/artifacts/src/behaviour.ts    NEW  sequence and activity projections
packages/artifacts/src/data-flow.ts    NEW  data flow and lineage
packages/artifacts/src/consistency.ts  NEW  cross-artifact consistency engine
packages/artifacts/src/er-diagram.ts        explicit keys, foreign keys, constraint notes
packages/artifacts/src/gaps.ts              requirement and use-case counts from the models
packages/artifacts/src/index.ts             sequence, activity, data-flow registered; consistency in projectAtlas
packages/artifacts/src/contract.ts          non-C4 `view` field
packages/artifacts/test/behaviour.test.ts NEW  28 behaviour, data-flow and lineage tests
packages/artifacts/test/consistency.test.ts NEW 19 consistency tests
packages/server/src/app.ts                  5 new endpoints
packages/server/src/service.ts              requirements, use cases, consistency, traceability, lineage
packages/server/test/phase3-api.test.ts NEW 22 endpoint tests
packages/web/src/phase3.tsx            NEW  Behaviour and Traceability tabs, lineage panel
packages/web/src/api.ts                    Phase 3 types and client methods
packages/web/src/app.tsx                   two new tabs, ten in total
packages/web/src/presentation.ts           requirement wording, consistency headline, chain view
packages/web/test/phase3-presentation.test.ts NEW 21 wording and ordering tests
scripts/verify-browser.mjs                 Phase 3 checks; waits for content, not controls
```

Carried over from Phase 2 (for orientation):

```
packages/core/src/snapshot.ts        NEW   content-addressed snapshot identity
packages/core/src/drift.ts           NEW   drift engine
packages/core/src/graph-builder.ts         build-context attribution, declaredAs, digests
packages/core/src/graph.ts                 GRAPH_SCHEMA_VERSION 1 -> 2
packages/core/src/types.ts                 GraphNode.digest, AnalysisRecord snapshot fields
packages/core/test/drift.test.ts      NEW   34 snapshot and drift tests
packages/core/test/graph-builder.test.ts   deployment attribution, base images, digests
packages/parsers/src/config.ts             compose scoped to `services:`, both build: forms
packages/parsers/src/registry.ts            readFile receives the repository-relative path
packages/artifacts/src/c4.ts          NEW   C4 context, container and component projections
packages/artifacts/test/c4.test.ts    NEW   32 C4 tests
packages/server/src/app.ts                  snapshot and drift routes
packages/server/src/service.ts              compareAnalyses, getSnapshot
packages/server/test/drift-api.test.ts NEW   15 drift endpoint tests
packages/web/src/c4.tsx              NEW   C4 tab with element panel
packages/web/src/drift.tsx           NEW   Drift tab
```
## 4. Current Architecture / State

```
Repository path
   │
   ▼
resolveRepositoryRoot()      packages/ingest/src/path-safety.ts   containment + allow-list
   │
   ▼
discoverFiles()              packages/ingest/src/discover.ts      bounded, sorted, deterministic
   ├─ readGitMetadata()      packages/ingest/src/git.ts           read-only, hardened argv
   │
   ▼
parseFiles()                 packages/parsers/src/registry.ts     deterministic extraction
   │                         └─ contentDigest() per file, no extra I/O
   ▼
buildGraph()                 packages/core/src/graph-builder.ts   THE canonical graph
    │                         ├─ attributeBuildContext(): deploys edges from compose `build:`
    │                         └─ addReturnFacts(): returns, throws, HTTP responses
    ▼
createSnapshot()             packages/core/src/snapshot.ts        content-addressed identity
    │                         extractor 1.1.0, graph schema 4
   │
   ├─ Store.saveAnalysis()   packages/server/src/store.ts
   │
   ▼
projectAtlas()               packages/artifacts/src/index.ts      10 projections + gaps + consistency
   |                         → buildSequence(), buildActivity(), buildDataFlow()
   |                         → checkConsistency(), buildRequirements(), buildUseCases()
   │                         └─ buildC4() × 3 levels
   │
   ▼
compareSnapshots(a, b)       packages/core/src/drift.ts           what changed, and how well
   │
   ▼
AnalysisService              packages/server/src/service.ts
Store (node:sqlite)          packages/server/src/store.ts
Fastify API                  packages/server/src/app.ts
   │
   ▼
React UI                     packages/web/src/    10 tabs
```

Three invariants now hold the design together:

1. **Artifacts can only read the graph.** They cannot create a fact, so a diagram can never
   disagree with the model it came from.
2. **Nothing exists without evidence.** Every node and edge cites a file and a line and
   carries a confidence that downgrades on merge.
3. **A claim about absence is separate from a claim about existence.** `removalConfidence`
   and `indeterminate` say how well *we looked*; `confidence` says how well *the repository
   states it*. One value cannot answer both.
4. **An arrow must name the statement that drew it.** A return is not implied by a call, a
   response is not implied by a route, and a store is not implied by a query mentioning it. Every
   relationship cites the line that established it, and what cannot be cited is reported unread.

---

## 5. Decisions Made

67 entries in `decisions.md`. The ones a new contributor must know:

| Decision | Summary |
|---|---|
| D-002 | Strict acyclic package direction; artifacts may not create facts |
| D-007 | Confidence is a required field, downgraded on merge |
| D-008 | Gap analysis uses `EvidenceStatus`; never claims absence; tests enforce it |
| D-020 | Every artifact reports what it could not draw |
| D-021 | Deterministic UI layout so the same repository always draws the same picture |
| D-026 | A snapshot's identity is a content digest, never a timestamp |
| D-027 | Drift is indexed and sorted, so the same pair always produces the same bytes |
| D-028 | A removal is asserted only from a complete analysis |
| D-029 | Rename requires identical content digest, kind, language and uniqueness |
| D-030 | `EVIDENCE_MOVED` deleted as unreachable; replaced by `EVIDENCE_CHANGED` |
| D-033 | C4 is a mapper over the graph; an unsupported arrow is dropped, not drawn |
| D-034 | Code is attributed to a container by its build context, **in extraction** |
| D-036 | UI decisions live in testable functions, so they can be tested without a DOM |
| D-041 | Browser verification driven over CDP with no dependency; the UI moved from unknown to partially verified |
| D-039 | Compose volumes and base images are not containers (bug found by real C4) |
| D-040 | Git's dubious-ownership guard is not disabled |
| D-042 | An inline route handler is named after the registration that contains it, so an endpoint resolves to its code |
| D-043 | Absence is never a contradiction; the consistency engine records agreement too |
| D-044 | A stated requirement with no implementation is kept and marked partial, not dropped |
| D-045 | A use case is capped at 40 steps and the cap is reported |
| D-046 | The traceability index builds its models once; per-row model building was a 15 s request |
| D-047 | Sequence messages are calls only; no return arrow is drawn — **superseded by D-057** |
| D-048 | Browser checks wait for content, not for controls |
| D-050 | A join modifier steps towards `JOIN`; it never introduces a table |
| D-051 | A comma-list steps over `AS` as well as the alias |
| D-052 | A CTE's identity is its defining scope, not its name |
| D-054 | A parser that records a response must also emit the marker the graph reads |
| D-056 | The sequence walk is depth-first, because breadth-first drew returns first |
| D-057 | A return comes from a `return` statement, never from the existence of a call |
| D-060 | SQL this analyser will not read is reported as unread, not ignored |
| D-061 | **ORM and query-builder extraction stays unsupported** |
| D-063 | A status set on a response object is a response — and carries `statusOnly` |
| D-065 | The sequence budget bounds calls, not messages |
| D-066 | A Python route decorator names the function below it |
| D-067 | A finding names each entity once |

---

## 6. Requirements and Constraints

- **Authorship:** all commits and pushes are solely **PrathamKapoor
  \<prathamkapoor027@gmail.com\>**. No co-authors, no AI or tool attribution, no
  collaborators added. Verify with `git config user.name` / `user.email` before committing.
- **Remote:** `https://github.com/PrathamKapoor/RepoMapper.git`, branch `main`.
- **Do not commit** `paper/`, `research/` or `*.tex` unless explicitly asked.
- **Honesty:** never write "complete", "verified", "production-ready" or "tests passing"
  without having run the check. Use explicit statuses — `verified`, `partially verified`,
  `inferred`, `unknown`, `unsupported`, `not implemented`.
- **Never guess facts.** If a root cause was not identified, say so.
- **Security:** never execute repository-provided commands; never expose secrets in
  logs, UI, commits or documentation; do not weaken `REPOATLAS_ALLOWED_ROOTS`.
- **Documentation contract:** `decisions.md`, `flow.md` and this file are mandatory and
  must be updated in the same change as the code they describe.

---

## 7. Testing and Verification

Commands, all run from the repository root:

```bash
npm ci                # reproducible install from the lockfile
npm run lint          # eslint, type-aware
npm run typecheck     # tsc --noEmit per package, source + tests
npm run build         # all packages + web bundle
npm run test          # vitest, 654 tests
npm run verify        # lint + typecheck + build + test, in that order
```

**Run `npm run verify`, not `npx vitest` alone.** Packages resolve through `dist/`, so a test
run without a build silently exercises the previous build (D-035).

Verification, recorded with output in `docs/verification.md`:

- **Real self-analysis.** This repository analysed at commit `88d87c2`: 5568 nodes, 8532 edges,
  11858 evidence records. Sequence 224 participants / 1265 messages — 1205 calls, **32 returns,
  19 HTTP responses, 9 error paths**; data flow 23 nodes / 29 relationships; 18 `reads` (5 from a
  join) and 11 `writes`; 78 `returns` and 49 `throws`; 28 unclassified SQL statements, each with
  its reason.
- **A second real repository.** `pallets/flask`: 2534 nodes, 8131 edges. **128 endpoints, all
  resolving to a handler** (169 `route.handler` edges, was 0); sequence 40 flows with **176 calls,
  23 returns and 5 error paths** (was 0 messages); **240 `throws` edges** from `raise`. Flask's own
  queries are single-table, so this run verified the Python paths rather than multi-table SQL —
  stated as such rather than counted as evidence for a claim it did not exercise.
- **Container.** Rebuilt from the Phase 4 tree on Node 24.21.0; every endpoint exercised against
  an isolated read-only fixture, including a `LEFT OUTER JOIN` reading two tables, a CTE recorded as
  a query expression rather than a store, a lineage hop reporting `usage: { read: 3, write: 0 }`,
  an ER diagram whose foreign key came from `ALTER TABLE`, and the three traversal probes still
  returning 403.
- **Browser.** Real headless Chromium over the DevTools Protocol, no added dependency, against
  the **container** build: **43/43** with two identical analyses, **45/45** after a real change.
  Covers all ten tabs, the three behaviour views, return and failure messages reaching the
  sequence view, lineage, traceability, consistency and drift.
- **Performance, observed rather than benchmarked:** `/traceability` went from 15.2 s to
  2.9 s after D-046; the `/use-cases` payload for this repository is 538 KB for 37 use cases.

**Not verified:** visual layout, styling and responsive behaviour at any viewport; React Flow
zoom, pan and drag; any browser other than the Chromium builds installed here; the per-arrow
evidence panel's rendered contents; multi-table SQL on a third-party application repository. No
benchmark numbers are claimed. See `docs/verification.md` §5 for the full list.

---

## 8. Known Issues / Risks

| Issue | Impact | Status |
|---|---|---|
| Visual layout, zoom, drag and non-Chromium browsers | The browser driver asserts on DOM content and node counts, not on appearance; a visual regression would not be caught | Known gap. Open `localhost:5173` by eye, or extend the driver with a screenshot comparison |
| A deep link pasted into an already-open tab did nothing | Found by browser verification: the tab was initialised once and ignored `hashchange` | Fixed in `app.tsx`. Deep links now work in an open application |
| C4 component boundaries come from a declared build context | A build context says what is sent to the builder, not what the image runs | Accepted and labelled `STRONGLY_INFERRED`; the caveat travels on the edge (D-034) |
| Rename detection is whole-file and content-exact | A moved class, or a rename whose content changed, is removed + added | Deliberate. Proved rather than guessed (D-029) |
| A container with an image but no build context gets no components | Level 3 is empty for such repositories | Recorded in `omitted[]`. Dockerfile `COPY` analysis would fix it |
| Git history is unavailable inside the container for foreign-owned repositories | Commit, contributor and ownership facts are absent there | `GIT_UNAVAILABLE` diagnostic, analysis still succeeds. The guard is not disabled by default (D-040) |
| Analyses run inline; long runs hold an HTTP connection | Proxies with short read timeouts need raising | Accepted, documented, D-006 |
| **No ORM or query-builder extraction** | A repository behind Prisma, SQLAlchemy, Knex or Drizzle shows stores it never evidences, and the DFD is sparse for it | **Unsupported by decision** (D-061). Mapping `db.users.findMany()` to a `users` table is a guess about which call touches which store. A declared table nothing touches is reported as `MISSING_EVIDENCE` with the reason, so the gap is visible and attributed to the extractor. Largest remaining gap in the data views |
| **Table-level lineage only** | A reader wanting "which column becomes which" gets nothing | Not implemented. Every hop is table-level because that is what a statement names; a column-level edge would be inferred from a projection list the analyser does not resolve |
| **Most calls in this repository draw no return** | 1154 of 1205 calls have no return arrow, so the sequence looks call-heavy | Correct and reported in `omitted[]`. Most calls here have their result discarded or bound without returning it. The alternative — drawing an arrow because a call happened — is the invention Phase 4 removed |
| **A return records that a value comes back, not what it is** | `return user;` does not establish a `User` | Deliberate (D-057). Resolving a value to a type is inferring from the value, which the source does not state |
| **A status-set response is a framework inference** | `reply.status(404); return {…}` is drawn as a response | `STRONGLY_INFERRED`, labelled `statusOnly`, and the arrow says the body came from the return (D-063). The status is in the code; that Fastify sends the returned body is framework behaviour |
| **A sequence flow is capped at 60 calls** | A long endpoint shows its first 60 calls and says so | Deliberate, and the budget bounds *calls* so a drawn call always keeps its hand-back (D-065). The cut is reported in `omitted[]` |
| **Python has no constructor return shape** | `return User(1)` is recorded as a call | Deliberate (D-062). Python writes it exactly like a call; distinguishing them needs a naming convention |
| **Reads and writes are counted separately, but not derived** | Lineage says a store is read 3 times and written 0 — it does not say what the reads produce | Correct. Column-level lineage is not implemented |
| Requirement status is `PARTIAL` for most stated requirements in a code-only repository | A document states an obligation nothing implements | Correct and reported. Not a defect in the repository |
| No authentication on the API | Anyone who can reach the port can analyse paths the process can read | Mitigated by `REPOATLAS_ALLOWED_ROOTS`; bound to `127.0.0.1` in compose |
| Python extraction is structural, not a full grammar | Dynamic/metaprogrammed code is not modelled | Documented, D-004. Facts stay ≤ `STRONGLY_INFERRED` |
| Call resolution matches by name | A same-named symbol in another file can be chosen | Labelled `STRONGLY_INFERRED`/`WEEKLY_INFERRED`, never `EXPLICIT` |
| `constant` nodes dominate counts | Enum members are recorded individually | Cosmetic |
| No CORS/rate-limit middleware | `REPOATLAS_CORS_ORIGIN` is parsed but not applied | Known gap |
| Coverage not measured | Unknown blind spots | `npm run test:coverage` available |

---

## 9. Unfinished Work

Ordered by what unblocks the most downstream value. None of these are started.

1. **ORM and query-builder extraction.** `reads`/`writes` come only from table names in SQL the
   analyser read, so a repository behind Prisma, SQLAlchemy, Knex or Drizzle evidences no store at
   all. This is the largest remaining gap in the data views and the lineage answer. Phase 4 declined
   it deliberately (D-061) rather than shipping a mapping that guesses which call touches which
   table — so whoever takes this on must start by agreeing what *evidence* names a store in each
   framework, not by mapping path segments.
2. **Column-level lineage.** Every hop is table-level. A `SELECT` list names columns, so column
   lineage is derivable in principle, but resolving a projection list to real edges needs its own
   extraction pass and its own evidence rule.
3. **`communicates_with` for HTTP clients.** No extractor produces it, so a data flow always stops
   at an unknown store rather than crossing the system boundary. The data-flow view already
   reports the absence.
4. **State models.** 1582 condition nodes here name states but the graph holds no transition
   relationship, so no state diagram is drawn. Transitions need an explicit representation.
5. **Dockerfile `COPY` analysis.** Would replace the build-context inference with a real
   statement of which source is in the image, strengthening every C4 component boundary (D-034).
6. **Stronger rename detection.** `git log --follow` as corroboration where history exists;
   symbol-level pairing for a class moved between files. Both must keep D-029's refusal to guess.
7. **Return *values*, not just return *relationships*.** A return records that a value comes back
   and where it goes; it does not record what the value is. Resolving a returned identifier to a
   type would need data flow within a function, which is a different extraction problem from the
   one Phase 4 solved.
8. **Requirements from an issue tracker.** Out of reach by design; the tool reports them as not
   recovered rather than guessing.
9. **Screenshot comparison in the browser driver.** Layout is still verified by DOM assertions
   only, so a visual regression would not be caught. The driver also does not click an individual
   arrow to assert the evidence panel's contents.
10. **Archive-upload endpoint, CORS, rate limiting, API authentication.** Unchanged from Phase 1;
    `extractTarArchive` exists and is tested but unreachable.

---

## 10. Next Subphase

**Phase 5 — to be chosen.**

Phase 4's two objectives are done: data access reads more than one table per statement, and
sequence views draw returns, failures and responses with evidence. What that work exposed is a
better guide to the next phase than the list above:

- **The honest question to ask of the next feature is "which facts in the graph reached the
  picture?"** Phase 4's most serious defects — all 19 HTTP responses present but undrawn, Flask's
  128 endpoints with no handlers — presented as working features. The tests passed and the
  artifact looked plausible. Any new projection should be checked the same way: count the facts,
  count the arrows, and account for the difference.
- **A recorded fact nothing consumes is invisible.** Two of Phase 4's defects were a record
  extracted and then dropped, and a rule that gated on one field while reading another. When a new
  `ParsedFile` field or edge kind is added, name the consumer in the same commit, and test that it
  reads it.
- **Bounded projections need their budget spent on new work, never on closing work already
  shown.** The message cap that orphaned every return arrow was a reasonable-looking limit doing
  something subtly wrong.

Concrete first steps if Phase 5 continues the data thread:

1. Decide the evidence rule for one query builder — Prisma or SQLAlchemy — and write it down before
   writing the extractor. If no rule can be stated that a reader would accept as evidence, that is
   the answer, and the tool should keep saying "unsupported".
2. Add a `communicates_with` extractor for HTTP clients, so a data flow can cross the boundary.
3. Extend the browser driver to click an individual arrow and assert the evidence panel's contents,
   which is the one Phase 4 UI feature the driver does not check.
4. Extend the browser driver with a screenshot comparison, so layout stops being unverified.

## 11. Critical Context

Things that are not obvious from the code and cost time to rediscover:

- **Tests resolve packages through `dist/`.** No alias exists, so `npx vitest run` after an
  edit tests the *previous* build. Use `npm run verify` (D-035).
- **`scripts/verify-browser.mjs` needs a running server and two analyses.** It polls on content,
  never on a timer. If a check fails, read the reported URL and the DOM text it saw before
  concluding the product is broken — the driver's own URL handling has already caused two false
  failures (a query appended after the fragment, and a too-weak readiness check).
- **`getText()` requires an explicit source file.** `setParentNodes: false` means
  `node.getText()` throws and silently aborts the rest of that file's parse (D-009).
- **The symbol index must be complete before relationships resolve**, or extraction becomes
  order-dependent (D-010). Do not merge the two passes.
- **SQL markers must emit tables before columns**, or every column is discarded (D-011).
- **`import(...)` is an `ImportKeyword`, not an identifier** (D-012).
- **Fastify permits one not-found handler per prefix** (D-013).
- **`ignore` is CommonJS with version-dependent export shapes.** Use `resolveIgnoreFactory()`
  (D-014).
- **The Docker build must copy `/app/packages` from the deps stage** (D-015).
- **`?kind=` is node kinds; edge kinds use `?edgeKind=`** (D-017).
- **An evidence id encodes path, kind and line.** Two records sharing an id are identical by
  construction, which is why `EVIDENCE_MOVED` was deleted as unreachable (D-030).
- **Snapshot identity is a content digest.** Do not add a timestamp, an analysis id or a path
  to it, or "nothing changed" becomes undecidable again (D-026).
- **A truncated target analysis makes every removal indeterminate.** Do not "fix" this by
  comparing only entities present in both snapshots — that is the bug it prevents (D-028).
- **`supportingEdgeIds` must name real graph edges.** The first draft fabricated
  `deploys:<id>` strings; `hasGraphSupport()` and two tests now guard it (D-033).
- **A compose `build:` context is untrusted text.** It is only compared against paths already
  inside the analysed repository, and an absolute or repository-escaping context is ignored
  (D-034).
- **`SCHEMA_VERSION` in `store.ts` is the database version; `GRAPH_SCHEMA_VERSION` is the
  model version.** They collided once already (D-038). Do not use the same name twice.
  `GRAPH_SCHEMA_VERSION` is **4** and `EXTRACTOR_VERSION` is **1.1.0**; both are inside the
  snapshot digest, so a Phase 3 snapshot reports `comparable: false` rather than being read under
  Phase 4 semantics.
- **The return pass stages node attributes and flushes them once.** `addNode` keeps whatever
  attributes a node already has, so a count written from two passes silently keeps the first value.
  `StagedAttributes` exists so the counts can be trusted to be counts.
- **A join modifier is not a table introducer.** `LEFT`, `OUTER`, `INNER` and friends step towards
  `JOIN`; `STRAIGHT_JOIN` is the join keyword itself. Treating a modifier as introducing the table
  put a table named `ON` in the graph (D-050).
- **A comma list steps over `AS` as well as the alias, and over a schema qualifier.** Both are
  multi-token, and assuming one token is how a table goes missing (D-051).
- **A CTE or an unclassified statement must be keyed by its scope or its location, never by its
  name.** Two statements can share a summary; two query expressions can share a name (D-052,
  D-053).
- **A Python route marker is held until the definition it decorates.** It cannot name its own
  handler, and emitting it immediately left every Flask endpoint unattached (D-066).
- **A chained status resolves after the walk.** `res.status(201).json(x)` visits the producer
  before the configuring call, so the status is unknown during the walk (D-063).
- **The sequence budget bounds calls, not messages.** A limit on new work can never orphan the
  hand-back of work already shown; a limit on messages did exactly that (D-065).
- **A rule that reads field X must gate on field X.** `addHttpResponses` gated on
  `file.responses` and read the `http.response` marker, which is the mechanism behind two of
  Phase 4's defects (D-054, D-064).
- **A projected arrow id must be unique in the view, not in one flow.** The order counter restarts
  per entry point, so two flows reaching the same call produced two arrows with one id, and a
  view selecting arrows by id showed the wrong evidence (D-049).
- **A finding's `nodeIds` must be deduplicated.** A C4 element lists its own id in `graphNodeIds`,
  and prefixing `node.id` made every `container-without-code` finding name the same entity twice
  (D-067).
- **Analysis fixtures are built on disk in temp directories**, not committed as a tree.
- **Symlink tests silently pass on Windows without elevation.** They early-return. Re-run on
  Linux CI for real coverage.
- **`REPOATLAS_ALLOWED_ROOTS` empty means no allow-list.** `/api/health` reports it. Do not
  treat that as a safe default.

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
   improve extraction — do not let the view guess. Phase 2's C4 component level is the
   worked example: it was empty until extraction learned what a build context states.
5. No fact without evidence. No edge without confidence.
6. New node or edge kind: add it to the `NODE_KINDS` / `EDGE_KINDS` union in
   `packages/core/src/types.ts` and to `/api/meta`.
7. Any `NOT_FOUND` gap must list `checked`, state `whatWouldResolve`, and hedge. Tests
   enforce this.
8. Any parser, extraction or projection change needs a test in the same commit.
9. Any new UI decision that could mislead — which snapshot a row belongs to, whether a state
   is "identical" or merely unknown — belongs in `packages/web/src/presentation.ts` with a
   test, not inline in a component.
10. Record the decision, update the flow, update this file — in the same change.
11. **A new `ParsedFile` field is not finished when the parser fills it.** Name the consumer in
    the same commit, and test that the consumer reads *that* field rather than a parallel one.
    Two of Phase 4's defects were exactly this (D-054, D-064).
12. **After a feature works, ask which facts in the graph reached the picture** and account for
    the difference. Phase 4's most serious defects all presented as working features; the tests
    passed and the output looked plausible.

Before committing:

13. `npm run verify` green. If something cannot be verified, say which and why.
14. `git status`, `git diff`, `git diff --cached`. Stage only intended files.
15. Confirm no secrets, no absolute machine paths in committed config, no AI attribution.
16. Commit message in the imperative, describing what changed and why.
17. After committing: `git status` clean, `git log -1 --oneline`, then push to
    `origin main`.

Honesty requirements:

18. Never write "working", "verified", "production-ready" or "tests passing" unless you
    ran the check in this session.
19. Record failed attempts in `decisions.md`, including the symptom and the workaround,
    even when the root cause was not identified (see D-014, D-035).
20. If a test asserts something trivial, delete it. A test that cannot fail is worse than
    no test, because it inflates the count and hides the gap. D-030 is the worked example:
    a category that could only ever report zero was removed rather than kept.
    Phase 4 added a Python `constructor` branch whose pattern was byte-identical to the
    `call` branch above it; it could never fire, and a test asserting it would have been a
    test that could not fail (D-062).
21. Run the thing against a real repository. Phase 2's best-found bug — compose volumes drawn
    as containers — was invisible to every test and obvious the moment C4 was run against
    this repository. Phase 4's were the same shape: all 19 HTTP responses present in the
    graph and none drawn; Flask's 128 endpoints with no handlers.
22. State what a verification run did **not** exercise. The Flask run proved the Python
    extraction paths; it did not prove multi-table SQL, because Flask's own queries are
    single-table. Saying otherwise would be a claim the run does not support.
