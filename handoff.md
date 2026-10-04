# RepoAtlas — Session Handoff

Read this file first, then `decisions.md` and `flow.md`, before starting work.

---

## 1. Current Phase

**Phase 3 — behaviour, data and traceability: complete, verified and committed.**

The graph now carries the facts behaviour and data views need: explicit control flow, SQL data
access, schema keys and constraints, declared requirements, and a test-to-endpoint link. On top
of them the product projects sequence, activity and data-flow views, recovers requirements and
use cases, follows any entry point through to the code and test that serve it, and compares
every view against the others.

The product is **usable and deployable for its stated scope** and **explicitly partial** beyond
it. Rendering is verified by CDP assertions (38/38 with one analysis, 41/41 with two and a real
change), not by pixels; visual layout, zoom, drag and non-Chromium browsers remain unverified
(D-041, D-048). Per-capability status is in `docs/verification.md`.
docs/verification.md
`
.

---

## 2. Work Completed

Carried over from Phase 1: the pipeline, six packages, containment, extraction, the canonical
graph, gap analysis, persistence, the API, the UI, the container image and CI. Carried over
from Phase 2: snapshots and drift, content digests, the C4 projections at three levels,
deployment attribution by build context, and the Snapshot and Drift views.

Phase 3 added, in dependency order:

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

### Bugs found and fixed during this phase

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

Phase 3 (this phase):

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
   │                         └─ attributeBuildContext(): deploys edges from compose `build:`
   ▼
createSnapshot()             packages/core/src/snapshot.ts        content-addressed identity
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
React UI                     packages/web/src/    8 tabs
```

Three invariants now hold the design together:

1. **Artifacts can only read the graph.** They cannot create a fact, so a diagram can never
   disagree with the model it came from.
2. **Nothing exists without evidence.** Every node and edge cites a file and a line and
   carries a confidence that downgrades on merge.
3. **A claim about absence is separate from a claim about existence.** `removalConfidence`
   and `indeterminate` say how well *we looked*; `confidence` says how well *the repository
   states it*. One value cannot answer both.

---

## 5. Decisions Made

40 entries in `decisions.md`. The ones a new contributor must know:

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
| D-047 | Sequence messages are calls only; no return arrow is drawn |
| D-048 | Browser checks wait for content, not for controls |

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
npm run test          # vitest, 489 tests
npm run verify        # lint + typecheck + build + test, in that order
```

**Run `npm run verify`, not `npx vitest` alone.** Packages resolve through `dist/`, so a test
run without a build silently exercises the previous build (D-035).

Verification, recorded with output in `docs/verification.md`:

- **Real self-analysis.** This repository analysed at commit `954f3d7`: 4582 nodes, 6983 edges,
  9144 evidence records, sequence 257 participants / 1205 messages, activity 1809 / 2565,
  data flow 7 / 7, 31 requirements stated by documents plus 25 derived, and 37 use cases.
  Phase 3's own facts are visible in the node and edge kinds, not only in the totals.
- **Container.** Rebuilt from the Phase 3 tree; every Phase 3 endpoint exercised against
  an isolated read-only fixture on Node 24.21.0, including a requirement read from a
  document, a use case with three steps, a consistency report with zero contradictions,
  and an ER diagram whose foreign key came from an `ALTER TABLE` statement.
- **Browser.** Real headless Chromium over the DevTools Protocol, no added dependency:
  **38/38** checks with one analysis, **41/41** with two and a real change between them.
  Covers all ten tabs, the three behaviour views on demand, lineage, the requirements and
  use-case lists, opening a chain from the index, and the consistency view.
- **Performance, observed rather than benchmarked:** `/traceability` went from 15.2 s to
  2.9 s after D-046; the `/use-cases` payload for this repository is 538 KB for 37 use cases.

**Not verified:** visual layout, styling and responsive behaviour at any viewport; React Flow
zoom, pan and drag; and any browser other than the Chromium builds installed here. No
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
| `reads`/`writes` come only from single-table SQL in a string literal | A repository behind an ORM shows stores it never evidences, and the DFD is sparse | Deliberate and stated in `omitted[]`. Widening it is the first item of Phase 4 |
| Sequence diagrams have no return arrow | A sequence shows calls but not returns, so it is incomplete in a way the view states | `omitted[]` says so (D-047). Returns are Phase 4 |
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

1. **Return messages and error paths in sequence diagrams.** The graph records calls and no
   returns, so the sequence view draws no return arrow (D-047). Recovering returns needs data
   flow within a function, which is a different extraction problem.
2. **Dockerfile `COPY` analysis.** Would replace the build-context inference with a real
   statement of which source is in the image, strengthening every C4 component boundary
   (D-034).
3. **ORM and query-builder extraction.** `reads`/`writes` currently come only from
   single-table SQL in a string literal, so a repository behind an ORM shows stores it never
   evidences. This is the largest remaining gap in the data views and the lineage answer.
4. **State models.** 1480 condition nodes here name states but the graph holds no transition
   relationship, so no state diagram is drawn. Transitions need an explicit representation.
5. **Stronger rename detection.** `git log --follow` as corroboration where history exists;
   symbol-level pairing for a class moved between files. Both must keep D-029's refusal to
   guess.
6. **Requirements from an issue tracker.** Out of reach by design; the tool reports them as not
   recovered rather than guessing.
7. **Screenshot comparison in the browser driver.** Layout is still verified by DOM assertions
   only, so a visual regression would not be caught.
8. **Archive-upload endpoint, CORS, rate limiting, API authentication.** Unchanged from Phase 1;
   `extractTarArchive` exists and is tested but unreachable.

---

## 10. Next Subphase

**Phase 4 - data access beyond string literals, plus returns.**

Why this order:

- The data views are the weakest part of the product today. `reads` and `writes` come from one
  narrow, honest rule, and this repository's own DFD is 7 relationships because of it. Widening
  the rule is what turns "we can see six tables" into "we can see how data moves".
- Return messages follow from the same work: both need to know what a function hands back, and
  a single pass over return statements and typed results could produce both. Until then the
  sequence diagram is honest but incomplete, and its `omitted[]` says so.
- Everything else on the list is either a smaller improvement (Dockerfile `COPY`) or blocked on
  something external (an issue tracker).

Concrete first steps:

1. Record an explicit `returns` relationship from a function to the entity it returns, with the
   `return` statement as evidence, for TypeScript and Python. Do not infer it from types: a
   declared return type is a claim about the signature, not about the value.
2. Widen SQL extraction to the query builders actually present in the target repositories —
   Knex, Prisma, TypeORM, SQLAlchemy — one at a time, each with a fixture test, and keep the
   single-table limitation stated wherever it applies.
3. Add a `communicates_with` extractor for HTTP clients, so a data flow can cross the system
   boundary instead of always stopping at an unknown store.
4. Draw the sequence return arrow only where a `returns` relationship exists, and extend the
   `omitted[]` note to count the returns that were not recorded.
5. Extend the browser driver with a screenshot comparison, so layout stops being unverified.

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

Before committing:

11. `npm run verify` green. If something cannot be verified, say which and why.
12. `git status`, `git diff`, `git diff --cached`. Stage only intended files.
13. Confirm no secrets, no absolute machine paths in committed config, no AI attribution.
14. Commit message in the imperative, describing what changed and why.
15. After committing: `git status` clean, `git log -1 --oneline`, then push to
    `origin main`.

Honesty requirements:

16. Never write "working", "verified", "production-ready" or "tests passing" unless you
    ran the check in this session.
17. Record failed attempts in `decisions.md`, including the symptom and the workaround,
    even when the root cause was not identified (see D-014, D-035).
18. If a test asserts something trivial, delete it. A test that cannot fail is worse than
    no test, because it inflates the count and hides the gap. D-030 is the worked example:
    a category that could only ever report zero was removed rather than kept.
19. Run the thing against a real repository. Phase 2's best-found bug — compose volumes drawn
    as containers — was invisible to every test and obvious the moment C4 was run against
    this repository.
