# RepoAtlas — Session Handoff

Read this file first, then `decisions.md` and `flow.md`, before starting work.

---

## 1. Current Phase

**Phase 2 — Drift detection and C4 architecture recovery: complete and committed.**

The canonical graph now has the two things it was missing: a comparable identity for a
repository state, and an architecture view derived only from that state.

The product is **usable and deployable for its stated scope** and **explicitly partial**
beyond it. Browser rendering remains **unknown** — see §8. Per-capability status is in
`docs/verification.md`.

---

## 2. Work Completed

Carried over from Phase 1 (see `git log`): the pipeline, six packages, containment, extraction,
the canonical graph, four projections, gap analysis, persistence, the API, the UI, the
container image and CI.

Phase 2 added:

- **Analysis snapshots** (`packages/core/src/snapshot.ts`). Content-derived identity:
  `sha256` over the extractor version, the graph schema version and every node, edge and
  evidence record. Provenance is recorded outside the identity, so re-analysing unchanged
  content yields the same snapshot id. Two snapshots from different extractor or schema
  versions are reported incomparable rather than diffed.
- **Content digests on module nodes** (`contentDigest()` in `packages/server/src/analyze.ts`),
  computed inside the read each file already requires, with CRLF normalised so a Windows and a
  Linux checkout of the same commit are the same source.
- **A drift engine** (`packages/core/src/drift.ts`). Indexed, deterministic comparison
  reporting node, edge, evidence and confidence changes. Removals are withheld as claims when
  the target analysis was truncated. Renames are proved by identical content, never by name
  similarity.
- **C4 projections** (`packages/artifacts/src/c4.ts`) at three levels, every element carrying
  its derivation and evidence and every relationship carrying the graph edges or nodes that
  justify it. A relationship with no support, or with an endpoint outside its level, is
  dropped and the drop is recorded.
- **Deployment attribution by build context** (`packages/core/src/graph-builder.ts`), so C4
  components rest on graph facts. Without it, level 3 was empty for every real repository.
- **Two HTTP endpoints**: `GET /api/analyses/:id/snapshot` and
  `GET /api/analyses/:id/drift?against=<analysisId>`.
- **C4 and Drift tabs in the UI**, with progressive disclosure, an element panel that
  explains why each element exists, and drill-through from a change row to the entity
  inspector in the snapshot that change belongs to.
- **114 new tests** (215 → 329), including drift fixtures built through the real pipeline.
- **Four bugs found and fixed**, three by tests and one by container verification, each with a
  regression test (D-031, D-032, D-038, D-039).
- **Verification**: real repository drift over a real change set, C4 against this repository,
  and a rebuilt container exercised through both Phase 2 endpoints.

### Bugs found and fixed during this phase

| | Symptom | Root cause |
|---|---|---|
| D-031 | `/snapshot` returned `"snapshotId": ""` | `createSnapshot()` left a placeholder in provenance and only overwrote the digest |
| D-032 | Drift against a failed analysis reported the entire system as removed, at full confidence | `getSnapshot()` accepted any analysis with rows; a failed one yields an empty but *valid* graph |
| D-038 | Container reported `schemaVersion: 1` and a digest that did not match the one recorded at analysis time | `Store.getGraph()` stamped rebuilt graphs with the **database** schema version instead of the graph model version |
| D-039 | C4 drew a named compose volume, a Docker base image and a component named `unknown` as containers | Compose parser matched any indented name and missed the long `build:` form; every deployment marker created a component |

---

## 3. Files Changed

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
packages/parsers/test/parsers.test.ts       volumes/networks, build: forms, service lines
packages/artifacts/src/c4.ts          NEW   C4 context, container, component
packages/artifacts/src/contract.ts         C4 element fields, supporting edge/node ids, gate
packages/artifacts/src/index.ts            three C4 artifacts registered
packages/artifacts/test/c4.test.ts    NEW   32 C4 tests
packages/server/src/store.ts               snapshot columns, digest column, schema-version fix
packages/server/src/service.ts             snapshot lifecycle and drift comparison
packages/server/src/app.ts                 /snapshot and /drift routes
packages/server/src/analyze.ts             content digests captured during read
packages/server/test/drift-api.test.ts NEW  15 HTTP tests over the real store
packages/web/src/c4.tsx              NEW   C4 tab with progressive disclosure
packages/web/src/drift.tsx           NEW   Drift tab
packages/web/src/presentation.ts     NEW   testable UI decisions
packages/web/test/presentation.test.ts NEW  17 tests for those decisions
packages/web/src/api.ts                    snapshot and drift client, C4 types
packages/web/src/app.tsx                   two new tabs, inspector carries its analysis id
packages/web/src/entity-drawer.tsx         unchanged; app.tsx now passes an explicit analysis
packages/web/tsconfig.json                 includes `test` for the type-aware linter
decisions.md  flow.md  docs/architecture.md  docs/deployment.md  docs/verification.md
README.md  handoff.md
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
projectAtlas()               packages/artifacts/src/index.ts      7 projections + gap analysis
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
| D-036 | UI decisions live in testable functions because no browser test exists |
| D-039 | Compose volumes and base images are not containers (bug found by real C4) |
| D-040 | Git's dubious-ownership guard is not disabled |

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
npm run test          # vitest, 329 tests
npm run verify        # lint + typecheck + build + test, in that order
```

**Run `npm run verify`, not `npx vitest` alone.** Packages resolve through `dist/`, so a test
run without a build silently exercises the previous build (D-035).

Phase 2 verification, recorded with output in `docs/verification.md`:

- **Real repository drift.** An isolated copy of this repository with its own Git history was
  analysed, then changed (a new module, a pure rename, a comment-only edit), then analysed
  again. Result: 157 changes across 11 categories, one proven rename with evidence on both
  sides, byte-identical output on repeat.
- **Real repository C4.** 1 software system, 1 container cited to `docker-compose.yml:7`,
  96 components with 181 relationships, each naming the `deploys` edge behind it.
- **Container.** Rebuilt, run healthy, both Phase 2 endpoints exercised, `schemaVersion: 2`
  after D-038, a rename detected across two host-side analyses, `/etc` and
  `/repos/fixture/../..` both refused with 403.

**Not verified:** browser rendering of any screen, including C4 and Drift. The decisions
those views make are unit-tested; that React draws them is not. No benchmark numbers are
claimed. See `docs/verification.md` §5 for the full list.

---

## 8. Known Issues / Risks

| Issue | Impact | Status |
|---|---|---|
| The UI has still never been opened in a real browser | A React runtime error, layout failure or broken React Flow canvas would not be caught by any current check | Known gap. `npm run dev:web`, open `localhost:5173`. UI *logic* is unit-tested (D-036) |
| C4 component boundaries come from a declared build context | A build context says what is sent to the builder, not what the image runs | Accepted and labelled `STRONGLY_INFERRED`; the caveat travels on the edge (D-034) |
| Rename detection is whole-file and content-exact | A moved class, or a rename whose content changed, is removed + added | Deliberate. Proved rather than guessed (D-029) |
| A container with an image but no build context gets no components | Level 3 is empty for such repositories | Recorded in `omitted[]`. Dockerfile `COPY` analysis would fix it |
| Git history is unavailable inside the container for foreign-owned repositories | Commit, contributor and ownership facts are absent there | `GIT_UNAVAILABLE` diagnostic, analysis still succeeds. The guard is not disabled by default (D-040) |
| Drift compares two analyses; it does not judge one | No in-graph consistency checking | Deferred, §9 |
| Analyses run inline; long runs hold an HTTP connection | Proxies with short read timeouts need raising | Accepted, documented, D-006 |
| No authentication on the API | Anyone who can reach the port can analyse paths the process can read | Mitigated by `REPOATLAS_ALLOWED_ROOTS`; bound to `127.0.0.1` in compose |
| Python extraction is structural, not a full grammar | Dynamic/metaprogrammed code is not modelled | Documented, D-004. Facts stay ≤ `STRONGLY_INFERRED` |
| Call resolution matches by name | A same-named symbol in another file can be chosen | Labelled `STRONGLY_INFERRED`/`WEEKLY_INFERRED`, never `EXPLICIT` |
| `constant` nodes dominate counts | Enum members are recorded individually | Cosmetic |
| No CORS/rate-limit middleware | `REPOATLAS_CORS_ORIGIN` is parsed but not applied | Known gap |
| Coverage not measured | Unknown blind spots | `npm run test:coverage` available |

---

## 9. Unfinished Work

Ordered by what unblocks the most downstream value. None of these are started.

1. **In-graph consistency checking.** Drift answers "what changed"; nothing answers "what
   disagrees *within* this state" — a route with no handler, an import nothing calls, a table
   no code reads, a declared dependency nothing imports. The graph now holds the facts for the
   first two.
2. **Dockerfile `COPY` analysis.** Would replace the build-context inference with a real
   statement of which source is in the image, strengthening every C4 component boundary
   (D-034).
3. **Stronger rename detection.** `git log --follow` as corroboration where history exists;
   symbol-level pairing for a class moved between files. Both must keep D-029's refusal to
   guess.
4. **Data-flow lineage.** Requires `reads`/`writes` edges from code to tables, which requires
   ORM and query-pattern extraction.
5. **Requirement extraction and traceability**, then requirements-vs-implementation.
6. **Further artifacts** in the documented order: sequence, DFD, use-case, activity,
   deployment — each only once the graph holds its facts (D-022 explains why the current
   renderer cannot express a sequence diagram).
7. **Archive upload endpoint.** `extractTarArchive()` is implemented and tested; the route is
   missing.
8. **Wider language coverage** via `web-tree-sitter`, per D-003.
9. **API auth and rate limiting** if the service is ever exposed beyond localhost.
10. **Browser verification**, and possibly a DOM test harness, so the UI's status can move
    from `unknown`.
11. **Coverage measurement** and closing any gaps it reveals.

---

## 10. Next Subphase

**Phase 3 — In-graph consistency analysis, plus stronger deployment attribution.**

Why this order:

- Consistency checking is the natural companion to drift. Drift needs two analyses; consistency
  needs one, and answers the question drift cannot: *is this state internally coherent?* The
  facts for the first two cases — a route with no handler, an import nothing calls — are
  already in the graph.
- Dockerfile `COPY` analysis is the smallest change that would turn C4 component boundaries
  from an inference into a citation, and it improves every future view that touches deployment.
- Browser verification should happen before more UI is built on top. Every additional screen
  multiplies the unverified surface.

Concrete first steps:

1. Extract `COPY --from=<stage> <src> <dest>` from Dockerfiles, and record it as a
   `deployment_component` attribute rather than as a new node kind.
2. Attribute a module to a container from `COPY` evidence when it exists, and fall back to the
   build context otherwise — with the two distinguishable in the C4 derivation string.
3. Add a `consistency.ts` module in `@repoatlas/core` producing a report shaped like the gap
   report: every finding cites evidence, every absence claim hedges, and a test enforces the
   wording as D-008 does.
4. Expose `GET /api/analyses/:id/consistency` and add it to the UI next to Gaps.
5. Add cross-artifact consistency tests: a graph edge removed must change the C4 projection,
   and a drift-visible change must be visible in C4.
6. Open the UI in a real browser and record what actually renders in `docs/verification.md`.

---

## 11. Critical Context

Things that are not obvious from the code and cost time to rediscover:

- **Tests resolve packages through `dist/`.** No alias exists, so `npx vitest run` after an
  edit tests the *previous* build. Use `npm run verify` (D-035).
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
