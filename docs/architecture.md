# RepoAtlas — Architecture

Design rationale. For what the code *does*, read `flow.md`. For what was chosen and why,
read `decisions.md`.

## The central idea

Most tools that draw diagrams about a codebase generate each diagram independently. Two
diagrams of the same repository then disagree: the dependency graph shows a module the
class diagram never mentions, the ER diagram shows tables the code never reads.

RepoAtlas inverts that. There is exactly one model:

```
                     ┌─────────────────────────────┐
                     │  Software Knowledge Graph   │
                     │                             │
                     │  nodes    + evidence        │
                     │  edges    + confidence      │
                     └──────────────┬──────────────┘
                                    │
        ┌───────────────┬───────────┼───────────┬───────────────┬───────────────┐
        ▼               ▼           ▼           ▼               ▼               ▼
   dependency      module       class        ER          C4 levels      gap
     graph         graph       diagram     diagram    context / container / analysis
                                                    component
                                    │
                                    ▼
                     ┌─────────────────────────────┐
                     │  Analysis snapshot          │
                     │  identity = content digest  │
                     └──────────────┬──────────────┘
                                    │
                     ┌──────────────▼──────────────┐
                     │  Drift report               │
                     │  what changed, and how well  │
                     │  that change is evidenced    │
                     └─────────────────────────────┘
```

Artifacts are **projections**: they read the graph and reformat it. They cannot create a
fact. This is enforced by the package dependency graph (`decisions.md`, D-002), not by
convention — `@repoatlas/artifacts` imports only `@repoatlas/core`, and the core types it
reads carry no mutators.

The practical consequence: when a view needs information the graph lacks, the fix is to
improve extraction. That is the intended pressure, and it is what keeps a diagram from
becoming a place where guesses accumulate. Phase 2 is the clearest example: C4 component level
was empty for every real repository until extraction learned what a compose build context
states (`decisions.md`, D-034) — the alternative was letting the projection guess which code
runs where.

## Comparing two states

A **snapshot** is a repository state with a content-derived identity:

```
graphDigest = sha256(extractorVersion, graphSchemaVersion, every node, edge, evidence record)
snapshotId  = snap_<16 hex of sha256(graphDigest, graphSchemaVersion)>
```

Provenance — commit, branch, path, timestamp, truncation — is recorded alongside but is
deliberately **not** part of the identity, so re-analysing unchanged content produces the same
snapshot id and "nothing changed" is decidable (`decisions.md`, D-026).

`compareSnapshots()` walks two indexed graphs and reports what changed. Two rules give the
report its meaning:

- **Removal is a claim, not an observation.** If the target analysis hit a limit, the parts it
  never walked look exactly like deletions. Those removals are reported `INDETERMINATE` with
  the reason attached (D-028).
- **Rename is proved, never guessed.** A rename is reported only when the removed and added
  nodes share a kind, a language and a content digest, and that digest is unique on both
  sides. Anything else stays removed plus added (D-029).

## The chain the product promises

```
repository → evidence → canonical graph → snapshot → comparison / projection → artifact → evidence
```

Every stage is traceable in both directions, and the chain is closed: a C4 element names the
graph node it came from, a graph node cites a file and a line, a drift item names the entity
and the citations it had in each state. Where the chain cannot be closed — because the
repository does not state it — the artifact records an omission instead of drawing a plausible
substitute.

## Two invariants

### 1. Nothing exists without evidence

Every `GraphNode` and `GraphEdge` carries `EvidenceRef[]`, and every reference resolves to
an `Evidence` record with a repository-relative POSIX path, a 1-based line span, and the
extractor that produced it. Excerpts are redacted and truncated at capture time.

An edge whose endpoint does not exist is **not created** — `addEdge` returns `undefined`
and the caller records a `DANGLING_REFERENCE` diagnostic. An unresolvable relationship
becomes a diagnostic, never a guessed node.

### 2. Confidence is a required field, and downgrades

```ts
type Confidence = 'EXPLICIT' | 'STRONGLY_INFERRED' | 'WEEKLY_INFERRED' | 'UNKNOWN';
```

It is a required field on both nodes and edges, so a new extractor cannot forget it — the
compiler rejects the node. `SoftwareGraphBuilder` merges duplicate observations with
`weakerConfidence`, so two weak signals can never combine into a strong one.

| Level | Meaning | Example |
|---|---|---|
| `EXPLICIT` | The repository literally states it | `import './x.js'`, `class A extends B`, `CREATE TABLE t` |
| `STRONGLY_INFERRED` | The statement exists; we resolved the target | `a.calls(b)` where `b` matched a declared symbol |
| `WEEKLY_INFERRED` | Weaker claim about origin | a call whose enclosing function was not identified |
| `UNKNOWN` | Recognised but not established | invalid confidence from a caller, downgraded on read |

A separate vocabulary handles a different question — *was this looked for at all?*:

```ts
type EvidenceStatus = 'EXPLICIT' | 'PARTIALLY_EVIDENCED' | 'INFERRED' | 'NOT_FOUND';
```

Keeping these apart matters. Confidence describes how well-supported a fact is;
`EvidenceStatus` describes whether the repository says anything on the subject.
`NOT_FOUND` always carries a `checked` list and a `whatWouldResolve`, so the claim is
auditable rather than rhetorical.

## Layers

### `@repoatlas/core` — the model

Depends on nothing. Owns:

- **Domain types** (`types.ts`) — nodes, edges, evidence, confidence, `ParsedFile`,
  `CommitRecord`, diagnostics, analysis records, limits.
- **Identifiers** (`ids.ts`) — deterministic, so re-analysing a repository produces a
  comparable graph. Drift detection depends on this.
- **Evidence store** (`evidence.ts`) — deduplication by deterministic id, excerpt
  normalisation, secret redaction.
- **Secret redaction** (`redact.ts`) — pattern-based, deliberately aggressive.
- **Graph builder** (`graph.ts`, `graph-builder.ts`) — the only place nodes and edges are
  created. Enforces limits, refuses dangling edges, downgrades on merge.
- **Snapshots** (`snapshot.ts`) — content-derived identity for a repository state, plus the
  rule that decides when two snapshots may be compared at all.
- **Drift engine** (`drift.ts`) — indexed, deterministic comparison of two snapshots. Owns the
  rules for removals, renames and claim confidence.
- **Diagnostics** (`diagnostics.ts`) — typed codes and severities. Stages report rather
  than throw, so one bad file degrades one part of an analysis.
- **Limits** (`limits.ts`) — every bound, with clamping so a caller cannot request an
  unbounded run.

The graph builder runs in nine passes. Pass 3 indexes every symbol **before** any
relationship resolves; collapsing that into a single pass makes extraction
order-dependent, which was a real bug (`decisions.md`, D-010).

### `@repoatlas/ingest` — untrusted input

Everything that touches the filesystem. Its job is to decide *what may be read* and to
produce a bounded, sorted, deterministic file list.

- **`path-safety.ts`** — resolves real paths before comparing, so a symlink inside a
  repository cannot widen the analysed tree. One module decides containment for the whole
  product.
- **`discover.ts`** — layered `.gitignore` evaluation (pushed and popped as the walk
  descends), binary sniffing, size and count limits, symlink-cycle guard.
- **`binary.ts`** — NUL-byte and non-printable-density detection over an 8 KB sniff.
- **`ignore-stack.ts`** — nested ignore files, deepest wins, matching git.
- **`git.ts`** — read-only, fixed argv, no shell, repository git config neutralised.
- **`archive.ts`** — compressed-size, uncompressed-size, entry-count and depth ceilings,
  per-entry path validation, and rejection of device, FIFO and link entries.

### `@repoatlas/parsers` — deterministic extraction

A parser answers one question: *what does this file literally state?* It reports facts
with line spans, records problems instead of throwing, and never executes, imports or
evaluates the code it reads.

The contract (`contract.ts`) is deliberately narrow, which is what makes adding a language
a contained change.

| Parser | Approach | Honest limitation |
|---|---|---|
| `typescript.ts` | TypeScript compiler API, offline text mode | Only TS/JS |
| `python.ts` | Tokeniser over logical lines, indentation-derived scope | Not a full grammar; no metaprogramming |
| `config.ts` | Purpose-built per file type | JSON scanning reads scalars, not nested trees |

`python.ts` produces two views per logical line: `code` with string bodies blanked, for
detecting definitions and calls; and `raw` with literals intact, for markers that need
real values such as a route path. Without the second view, route detection is impossible;
without the first, a `def` inside a docstring becomes a phantom function.

### `@repoatlas/artifacts` — projections

Reads `SoftwareGraph`, returns `Artifact`. Cannot create facts.

Each artifact carries three honesty fields:

- `scope` — what the view does and does not cover, in the response itself.
- `omitted[]` — reason, count and examples for what could not be drawn.
- `insufficientEvidence` — true when the graph lacks enough to draw the view at all.

The ER projection is the clearest example of the policy: it draws inter-table
relationships only when the graph holds an explicit edge, and records in `omitted` that
foreign keys are **not inferred** in this phase. A guessed foreign key in an ER diagram is
exactly the kind of claim this product must not make.

Mermaid is the text format because it renders in the browser with no server-side renderer
and no headless browser, keeping the deployment to one Node process
(`decisions.md`, D-022).

### `@repoatlas/server` — orchestration and delivery

- **`analyze.ts`** — the pipeline. Independent, individually testable stages; each stage's
  output is the next stage's only input, and nothing downstream re-reads the repository.
- **`service.ts`** — lifecycle: admission control, execution with a hard timeout, snapshot
  creation, persistence, and recording of failures so they stay visible. `getSnapshot()`
  rebuilds identity from the stored graph on every read and refuses an analysis that did not
  succeed — a failed analysis has no graph, and comparing against one would report the whole
  system as deleted (`decisions.md`, D-032).
- **`store.ts`** — `node:sqlite`, WAL enabled, one transaction per analysis. Entities are
  one row per node or edge so they can be filtered by kind in SQL; evidence is
  denormalised onto them so an entity renders with its citations in one query.
- **`app.ts`** — HTTP. Validation through `parseOrThrow`, so a caller's typo is a 400 with
  the offending field named rather than a 500.
- **`cli.ts`** — the same pipeline without HTTP, so a CLI result and an API result are
  identical by construction.

Artifacts, gaps and snapshots are **re-derived** from the stored graph on read rather than
replayed from a cache, so a projection or extractor change is visible without re-analysing.

### `@repoatlas/web` — the atlas

Eight tabs: Overview, Architecture, **C4**, Structure, **Drift**, Evidence, Gaps,
Diagnostics. Any entity, anywhere, opens the same inspector showing its relationships, its
evidence and the confidence of each — which is how one entity connects across
representations.

Three decisions worth noting:

- **Deterministic layout** (`decisions.md`, D-021). A force simulation re-randomises, so
  two engineers would see different pictures and screenshots would not match. Determinism
  is what makes before/after comparison meaningful.
- **Confidence is visual.** Explicit edges are solid green; inferred edges are dashed amber
  and labelled with the confidence level. A legend is rendered next to every graph.
- **The inspector carries its own analysis id.** A drift row describing a removal belongs to
  the *base* snapshot, whose entity does not exist in the analysis selected in the sidebar.
  Without this the drill-through 404s and reads as a broken link rather than the correct
  answer (`decisions.md`, D-037).

There is no DOM or browser test in this repository. The decisions those views make live in
`presentation.ts` and are unit-tested; whether React draws them is **unverified**
(`decisions.md`, D-036, and `docs/verification.md` §5).

## Error handling philosophy

A repository is hostile input: syntax errors, mixed encodings, symlink loops, binary files
labelled `.ts`, 40 000 files, no git history, an invalid manifest.

The response is **structured degradation, not failure**:

- Stages report typed diagnostics; they do not throw for recoverable conditions.
- A file with a syntax error is parsed as far as it goes; whatever was read is kept.
- Limits stop work and mark the analysis `truncated: true`. Truncation is always
  reported, never silently applied.
- An empty or wholly unsupported repository is a **successful** analysis with an empty
  graph and a gap report explaining why — not an error.
- Only conditions the caller caused (bad path, outside the allow-list, malformed request)
  produce an HTTP error.

The one deliberate exception is containment failure, which aborts immediately: if a path
cannot be safely read, nothing downstream should run.

## Testing strategy

| Level | Location | What it protects |
|---|---|---|
| Unit | `packages/*/test/*.test.ts` | Confidence algebra, id stability, redaction, limits, path containment, ignore semantics, parser output |
| Integration | `packages/server/test/analyze.test.ts` | The whole pipeline on purpose-built repositories, including malformed and empty input |
| API | `packages/server/test/api.test.ts` | Status codes, validation, graph integrity over HTTP, allow-list refusal |
| End-to-end | `e2e/self-analysis.test.ts` | This repository, analysed for real, asserting invariants rather than counts |

The end-to-end test asserts only invariants that must hold for any non-trivial
repository — every node cited, no dangling edges, determinism across runs. It never
asserts a specific count, because that breaks on every commit and trains the reader to
bump a number instead of reading the output.

Fixtures are constructed on disk in temp directories rather than committed as a tree, so
tests can build the awkward cases — symlink escapes, binary files, unterminated string
literals, oversized files — portably.

Three genuine defects were found only by tests that assert behaviour rather than
constants: heritage clauses silently dropped (D-009), order-dependent symbol resolution
(D-010), and SQL columns dropped by marker ordering (D-011). Two more were found only by
building the container image: a startup crash when the UI was enabled (D-013) and a
Linux-only module resolution failure (D-014). Phase 2 added two more from the same source —
tests that compare a stored value with a recomputed one (D-031, D-032, D-038) — and one that
only running C4 against this repository could find: compose volumes and Docker base images
drawn as containers (D-039).

## Known architectural limits

Stated plainly rather than left to be discovered:

- **Call resolution is name-based.** A same-named symbol in another file can be chosen.
  This is why those edges are `STRONGLY_INFERRED` and never `EXPLICIT`.
- **Rename detection is whole-file and content-exact.** A class moved between files, or a
  renamed file whose content also changed, is reported as removed plus added. That is
  deliberate: the alternative is a rename claim that is a guess (`decisions.md`, D-029).
- **C4 component boundaries come from a declared build context.** That states what is sent
  to the image builder, not what the image runs, which is why those relationships are
  `STRONGLY_INFERRED`. A container with an image but no build context gets no components, and
  the omission is recorded (`decisions.md`, D-034).
- **C4 cannot recover human actors.** Nothing in the graph describes who uses the system, so
  no person element is ever emitted (`decisions.md`, D-033).
- **Drift compares two analyses; it does not judge one.** It reports what changed, not whether
  the current state is internally consistent.
- **Single-writer persistence.** SQLite serialises writes through one connection. Fine for
  the current bounded concurrency; not a multi-replica design.
- **Inline analysis.** Long analyses hold an HTTP connection (`decisions.md`, D-006).
- **No inference engine yet.** The pipeline has a place for one — facts that need
  interpretation would be added as nodes with `WEEKLY_INFERRED` confidence — but nothing
  beyond deterministic extraction and the inference already inherent in symbol resolution
  is implemented.
- **No semantic understanding.** Documentation that describes a component in prose without
  naming it cannot be linked. The gap analysis says so rather than guessing.