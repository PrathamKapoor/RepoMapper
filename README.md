# RepoAtlas

RepoAtlas takes a software repository and reconstructs the software system behind it.

Point it at a repository and it produces a **Software Knowledge Graph** in which every
entity and every relationship is traceable to a file and a line, labelled with how strongly
it is actually supported. Multiple engineering views — dependency graph, module structure,
class diagram, ER diagram — are then *projections* of that one graph, so they cannot
contradict each other. A gap report states plainly where the repository provides no
evidence, without ever claiming a capability does not exist.

```
repository → ingestion → analysis → evidence → canonical graph → inference
           → artifact projections → consistency → gap analysis → interactive atlas
```

## Status

**STATUS: PARTIAL** — Phase 1 complete and verified. Usable and deployable for its stated
scope; deliberately incomplete beyond it. Per-capability status is in
[`docs/verification.md`](docs/verification.md).

| | |
|---|---|
| Analyses real repositories | Yes — verified against this repository, over HTTP and in a container |
| Tests | 215 passing (`npm run test`) |
| Lint / typecheck / build | Clean |
| Container image | Builds and runs; verified |
| Languages parsed | TypeScript, JavaScript, Python (structural) |
| Artifacts | Dependency graph, module structure, class diagram, ER diagram |
| Not built | C4, sequence, DFD, use-case, activity, deployment diagrams; requirements; consistency/drift engine; archive-upload endpoint |

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

**Nothing from a repository is executed.** Parsing uses the TypeScript compiler API in
offline text mode; git is invoked with a fixed argv, no shell, and neutralised config;
repository-provided ignore files are treated as data.

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
| `GET` | `/api/analyses/:id/artifacts[/:kind]` | Artifact projections, with Mermaid |
| `GET` | `/api/analyses/:id/gaps` | Gap report |
| `GET` | `/api/analyses/:id/diagnostics` | Every diagnostic from the run |
| `DELETE` | `/api/analyses/:id` | Delete an analysis and its graph |

Errors are `{"error": {"code", "message"}}`. Notable codes: `PATH_NOT_FOUND` (404),
`PATH_NOT_ALLOWED` (403), `BAD_REQUEST` (400), `INTERNAL_ERROR` (429 / 504 / 507).

## Example

Analysing this repository with the CLI:

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

Two things worth reading twice:

- The ER diagram says `INSUFFICIENT EVIDENCE` because this repository has no SQL DDL.
  The view refuses to draw tables it cannot evidence rather than inventing them.
- The dependency-hygiene gap reports `typescript` and `vitest` as declared but never
  imported. That is **correct** — they are invoked through npm scripts, not imported — and
  it is exactly the kind of finding the consistency engine is meant to surface.

## Repository layout

```
packages/core        canonical model: entities, evidence, confidence, buildGraph()
packages/ingest      untrusted input: containment, discovery, git, archives
packages/parsers     deterministic extraction per language
packages/artifacts   graph projections, Mermaid rendering, gap analysis
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
- No repository-provided command is ever executed.

Known gaps: the API has no authentication of its own and no rate limiting. Bind it to
localhost or place it behind an authenticating proxy.

## Licence

MIT. Author: PrathamKapoor \<prathamkapoor027@gmail.com\>.