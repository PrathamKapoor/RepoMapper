# RepoAtlas

RepoAtlas takes a software repository and reconstructs the software system behind it.

Point it at a repository and it produces a **Software Knowledge Graph** in which every
entity and every relationship is traceable to a file and a line, labelled with how strongly
it is actually supported. Multiple engineering views — dependency graph, module structure,
class diagram, ER diagram, C4 architecture — are then *projections* of that one graph, so
they cannot contradict each other. Each analysis is an immutable, content-addressed
**snapshot**, and any two snapshots can be compared to show exactly what changed and how well
that change is evidenced. A gap report states plainly where the repository provides no
evidence, without ever claiming a capability does not exist.

```
repository → ingestion → analysis → evidence → canonical graph
           → snapshots → drift reports
           → artifact projections (incl. C4) → gap analysis → interactive atlas
```

## Status

**STATUS: PARTIAL** — Phases 1 and 2 complete and verified. Usable and deployable for its
stated scope; deliberately incomplete beyond it. Per-capability status is in
[`docs/verification.md`](docs/verification.md).

| | |
|---|---|
| Analyses real repositories | Yes — verified against this repository, over HTTP and in a container |
| Drift between two states | Yes — verified on a real change set, in a container too |
| C4 context / container / component | Yes — verified against this repository; reports what it could not recover |
| Tests | 329 passing (`npm run test`) |
| Lint / typecheck / build | Clean |
| Container image | Builds and runs; verified, including Phase 2 endpoints |
| Languages parsed | TypeScript, JavaScript, Python (structural) |
| Artifacts | Dependency graph, module structure, class diagram, ER diagram, C4 × 3 levels |
| Browser rendering of the UI | **Unknown** — never opened in a real browser |
| Not built | Sequence, DFD, use-case, activity, deployment diagrams; requirements; in-graph consistency checks; symbol-level and Git-corroborated renames; archive-upload endpoint; API auth and rate limiting |

## Quick start

Requires Node.js 22.5 or newer (developed and verified on 24.19.0).

```bash
npm ci
npm run build
npm test
```

Analyse a repository from the command line:

```bash
node packages/server/dist/cli.js /path/to/some/repository
```

Add `--json` for the full graph and gap report as JSON.

Start the API and UI:

```bash
npm run build
REPOATLAS_ALLOWED_ROOTS=/path/to/parent npm start
# API  http://127.0.0.1:4300/api/health
# UI   http://127.0.0.1:4300
```

> `REPOATLAS_ALLOWED_ROOTS` is the security boundary. Unset means **no allow-list is
> enforced** and the API will analyse any path the process can read. `/api/health` reports
> this as `pathAllowListEnforced: false`.

Development, with the Vite dev server proxying the API:

```bash
npm run dev      # terminal 1 — API on :4300
npm run dev:web  # terminal 2 — UI on :5173
```

## Docker

```bash
docker build -t repoatlas:0.1.0 .
docker run --rm -p 127.0.0.1:4300:4300 \
  -e REPOATLAS_ALLOWED_ROOTS=/repos \
  -v "$PWD/repos:/repos:ro" \
  -v repoatlas-data:/data \
  repoatlas:0.1.0
```

Or `docker compose up --build`, which wires the same settings. Details and the security
posture are in [`docs/deployment.md`](docs/deployment.md).

## What makes the graph trustworthy

**Every fact is cited.** A node or edge without evidence does not get created. Every claim
points at `path:line`.

**Confidence is data, not decoration.** Each node and edge is `EXPLICIT`,
`STRONGLY_INFERRED`, `WEEKLY_INFERRED` or `UNKNOWN`. Merging two observations keeps the
weaker value, so combining weak evidence can never manufacture confidence. Diagrams render
inferred relationships dashed and labelled; the UI never draws a guess like a fact.

**Uncertainty is visible.** A gap is reported as `EXPLICIT`, `PARTIALLY_EVIDENCED`,
`INFERRED` or `NOT_FOUND`, and every `NOT_FOUND` records *what was searched* and *what
would resolve it*. `NOT_FOUND` means nothing in this repository supports the claim — it
never means the capability is absent. Two tests enforce that wording.

**Diagrams cannot invent facts.** Artifact projections can only read the graph. If a view
needs a fact the graph lacks, the fix is to improve extraction. Every projection also
reports what it could not draw.

**A C4 element must be able to justify itself.** Every element carries the rule that produced
it and the file and line it came from; every relationship names the graph edges or nodes that
justify it, and a relationship with neither is dropped rather than drawn. Human actors are
never invented, a dependency package is never drawn as a container, and a Docker base image
is never drawn as part of the system.

**"Removed" is a claim, not an observation.** Drift reports a removal only when the newer
analysis actually looked. If that analysis hit a limit, the parts it never walked look
identical to deletions — those are reported as *indeterminate* with the reason attached,
never as deletions.

**Renames are proved, not guessed.** A rename is reported only when the removed and added
files have identical content. Two identical files, or a rename whose content also changed,
stays reported as removed plus added.

**Nothing from a repository is executed.** Parsing uses the TypeScript compiler API in
offline text mode; git is invoked with a fixed argv, no shell, and neutralised config;
repository-provided ignore files and build contexts are treated as data — an absolute or
repository-escaping `build:` context is ignored rather than honoured.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness, version, and whether the path allow-list is enforced |
| `GET` | `/api/meta` | Node kinds, edge kinds, confidence levels, available artifacts |
| `GET` | `/api/analyses` | Stored analyses, newest first |
| `POST` | `/api/analyses` | Analyse `{ repositoryPath, label?, options? }` |
| `GET` | `/api/analyses/:id` | Record, stats, gap report, artifact availability |
| `GET` | `/api/analyses/:id/graph` | Filtered graph. `?kind=` node kinds, `?edgeKind=` relations, `?q=`, `?limit=`, `?edgeLimit=`, `?confidence=` |
| `GET` | `/api/analyses/:id/nodes/:nodeId` | Entity with relationships, neighbours and evidence |
| `GET` | `/api/analyses/:id/evidence` | Evidence records. `?path=` filters |
| `GET` | `/api/analyses/:id/artifacts[/:kind]` | Artifact projections, with Mermaid. Kinds: `dependency-graph`, `module-graph`, `class-diagram`, `er-diagram`, `c4-context`, `c4-container`, `c4-component` |
| `GET` | `/api/analyses/:id/snapshot` | Snapshot identity of this state, without its graph |
| `GET` | `/api/analyses/:id/drift?against=<analysisId>` | What changed between two states, with evidence on both sides. `?limit=`, `?includeChanges=` |
| `GET` | `/api/analyses/:id/gaps` | Gap report |
| `GET` | `/api/analyses/:id/diagnostics` | Every diagnostic from the run |
| `DELETE` | `/api/analyses/:id` | Delete an analysis and its graph |

Errors are `{"error": {"code", "message"}}`. Notable codes: `PATH_NOT_FOUND` (404),
`PATH_NOT_ALLOWED` (403), `BAD_REQUEST` (400), `NOT_FOUND` (404), `INTERNAL_ERROR`
(429 / 504 / 507).

`/drift` requires `against`: a comparison with one side has no meaning, and defaulting to
"the previous analysis" would silently pick whichever row sorted first. Direction is resolved
by analysis time, so the two ids may be passed in either order.

## Example

Analysing this repository with the CLI (Phase 1 figures, retained for comparison):

```
Repository       RepoMapper
Commit           23301a0  branch=main
Files            92 discovered, 86 analyzable, 8 skipped
Languages        typescript=55, json=19, markdown=7, unknown=6, yaml=2,
                 javascript=2, dockerfile=1
Graph            1689 nodes, 2842 edges, 3793 evidence records
Explicit share   nodes 100.0%, edges 68.0%

Artifacts
  dependency-graph   82 nodes / 164 edges
  module-graph       1482 nodes / 1502 edges
  class-diagram      105 nodes / 6 edges
      ! types with no in-repository heritage relationship (95)
  er-diagram         INSUFFICIENT EVIDENCE

Gaps (no evidence found ≠ does not exist)
  [EXPLICIT           ] Deployment architecture
  [EXPLICIT           ] API surface
  [NOT_FOUND          ] Data storage
  ...
```

The same tree in Phase 2 produces **2173 nodes, 3769 edges, 5280 evidence records**.

Three things worth reading twice:

- The ER diagram says `INSUFFICIENT EVIDENCE` because this repository has no SQL DDL. The
  view refuses to draw tables it cannot evidence rather than inventing them.
- The dependency-hygiene gap reports `typescript` and `vitest` as declared but never
  imported. That is **correct** — they are invoked through npm scripts, not imported.
- C4 reports one container for this repository and no external system. It does not invent a
  database, a queue or a human actor, and it says why each is absent.

Comparing two states of a real repository, after adding a module, renaming a file without
touching its content, and editing a third file:

```
base   snap_990760c77824bfea
target snap_48c9d2b5c3d15ad4
identical false | comparable true | targetIncomplete false

nodesAdded 5  nodesRemoved 0  nodesModified 20  nodesRenamed 1
relationshipsAdded 27  relationshipsRemoved 21
evidenceAdded 33  evidenceRemoved 25  evidenceChanged 25
totalChanges 157   reproducible true

NODE_RENAMED  module:packages/core/src/diagnostics → …/diagnostic-log   STRONGLY_INFERRED
              before packages/core/src/diagnostics.ts:1
              after  packages/core/src/diagnostic-log.ts:1
NODE_ADDED    class:snapshotledger                                     EXPLICIT
              after  packages/core/src/snapshot-extra/helper.ts:6
```

The rename appears once, as a rename — not also as a removal and an addition.

## Repository layout

```
packages/core        canonical model: entities, evidence, confidence, buildGraph(),
                     snapshots, drift engine
packages/ingest      untrusted input: containment, discovery, git, archives
packages/parsers     deterministic extraction per language
packages/artifacts   graph projections, C4 mapping, Mermaid rendering, gap analysis
packages/server      orchestration, SQLite persistence, HTTP API, CLI
packages/web         React UI
e2e                  end-to-end analysis of this repository
docs                 architecture, deployment, verification
```

The dependency direction is strict and acyclic. `@repoatlas/core` depends on nothing;
`@repoatlas/artifacts` depends only on core and therefore *cannot* create a fact.

## Documentation

| File | Contents |
|---|---|
| [`decisions.md`](decisions.md) | Every decision, with context, alternatives, and bugs with root causes |
| [`flow.md`](flow.md) | Real call order, why each stage exists, and every error path |
| [`handoff.md`](handoff.md) | Current state, known risks, next subphase, instructions |
| [`docs/architecture.md`](docs/architecture.md) | Package design and the reasoning behind it |
| [`docs/deployment.md`](docs/deployment.md) | Configuration, Docker, security posture |
| [`docs/verification.md`](docs/verification.md) | What was verified, how, and what was not |

## Security

Repositories are untrusted input. RepoAtlas will read any directory it can reach, so it
must be given an explicit boundary.

- Set `REPOATLAS_ALLOWED_ROOTS`. Without it, no containment is enforced.
- Symlinks cannot widen the analysed tree: paths are resolved before comparison and
  re-checked after following links.
- Uploaded archives are bounded on compressed size, uncompressed size, entry count and
  depth, with per-entry path validation and no device, FIFO or link entries.
- Evidence excerpts are passed through secret redaction before storage, so credentials
  committed to a repository are not surfaced in the API, the UI or generated output.
- No repository-provided command is ever executed. Repository-declared build contexts are
  compared only against paths already inside the analysed repository; an absolute or
  repository-escaping context is ignored.
- `/snapshot` and `/drift` read only stored graphs. They take analysis ids and no path, so
  they cannot widen the allow-list.

Known gaps: the API has no authentication of its own and no rate limiting. Bind it to
localhost or place it behind an authenticating proxy.

## Licence

MIT. Author: PrathamKapoor \<prathamkapoor027@gmail.com\>.