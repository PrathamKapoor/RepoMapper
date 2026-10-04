# RepoAtlas — Deployment

Everything here was executed on the development machine unless a step is explicitly marked
otherwise. See `verification.md` for the recorded output.

---

## Requirements

| Component | Version | Why |
|---|---|---|
| Node.js | >= 22.5 | `node:sqlite` is used for persistence. Verified on 24.19.0 |
| npm | >= 10 | Workspace protocol. Verified on 12.0.2 |
| git | any recent | Optional. Enables commit, contributor and ownership facts |

`git` is optional by design. Without it, analysis still runs; the pipeline records
`GIT_NOT_A_REPOSITORY` and the ownership gap is reported honestly as `NOT_FOUND`.

---

## Configuration

All configuration is environment-driven and validated once at startup. Invalid values fail
fast with a readable message rather than surfacing later as a confusing runtime error.

Copy `.env.example` and adjust. Every value below is the default, so an empty environment
behaves exactly like that file.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables the static UI warning path and hides internal error text |
| `HOST` | `127.0.0.1` | Bind address. **Loopback by default** |
| `PORT` | `4300` | HTTP port |
| `REPOATLAS_ALLOWED_ROOTS` | *(empty)* | **Semicolon/comma-separated roots.** Empty means no allow-list |
| `REPOATLAS_DB_PATH` | `var/repoatlas.sqlite` | SQLite file. `:memory:` for throwaway |
| `REPOATLAS_MAX_UPLOAD_BYTES` | `268435456` (256 MB) | Hard request-body cap |
| `REPOATLAS_MAX_ANALYSES` | `50` | Stored analyses. Reaching it returns 507 |
| `REPOATLAS_CONCURRENCY` | `2` | Concurrent analyses. Over-capacity returns 429 |
| `REPOATLAS_CORS_ORIGIN` | *(empty)* | Reserved. **Not yet wired into the Fastify instance** |
| `REPOATLAS_INCLUDE_GIT` | `true` | Read git history |
| `REPOATLAS_STATIC_DIR` | *(auto)* | Built UI. Auto-detected in production |
| `REPOATLAS_ANALYSIS_TIMEOUT_MS` | `300000` | Abandon an analysis exceeding this. Returns 504 |
| `REPOATLAS_LOG_LEVEL` | `info` | `fatal`…`silent` |

---

## Security

**Read this before exposing RepoAtlas to anything you do not control.**

RepoAtlas reads any directory the process can reach. `REPOATLAS_ALLOWED_ROOTS` is the only
boundary between "a repository you meant to analyse" and "a path someone else chose".

```bash
# Unset: no containment. /api/health reports pathAllowListEnforced: false.
REPOATLAS_ALLOWED_ROOTS=

# Two roots, one path each:
REPOATLAS_ALLOWED_ROOTS=/srv/repos;/opt/legacy

# A whole parent tree:
REPOATLAS_ALLOWED_ROOTS=/srv/repos
```

A request outside the allow-list is refused:

```json
{ "error": { "code": "PATH_NOT_ALLOWED",
             "message": "Repository path is outside the configured allow-list: /etc" } }
```

The server logs a warning at startup when `NODE_ENV=production` and no allow-list is set,
and `/api/health` reports `pathAllowListEnforced` so the exposure is inspectable rather
than assumed away.

### What is implemented

| Control | Where | Notes |
|---|---|---|
| Path containment | `packages/ingest/src/path-safety.ts` | Real paths resolved **before** comparison, then re-checked after following symlinks |
| Allow-list enforcement | `packages/server/src/config.ts` | Refused with 403 |
| Symlink escape blocking | `packages/ingest/src/discover.ts` | Recorded as skipped `symlink_escape`, never read |
| Binary file refusal | `packages/ingest/src/binary.ts` | NUL byte or non-printable density; never parsed as text |
| Size and count limits | `packages/core/src/limits.ts` | Clamped, so a request cannot ask for an unbounded run |
| Secret redaction | `packages/core/src/redact.ts` | Applied before evidence is stored |
| No repository command execution | `packages/ingest/src/git.ts` | Fixed argv, no shell, repository git config neutralised |
| Archive hardening | `packages/ingest/src/archive.ts` | Size, entry-count, depth ceilings; per-entry path validation; no device/FIFO/link entries |
| Request body cap | `packages/server/src/app.ts` | `bodyLimit` from `REPOATLAS_MAX_UPLOAD_BYTES` |
| Unknown-field rejection | `packages/server/src/app.ts` | `zod` `.strict()` — a typo is an error, not a silent default |
| Internal error text hidden in production | `packages/server/src/app.ts` | Unexpected errors are logged, not echoed |
| Non-root container user | `Dockerfile` | `USER node` |
| Snapshot/drift read no filesystem | `packages/core/src/drift.ts` | `/drift` and `/snapshot` take analysis ids only, so they cannot widen the allow-list |
| Untrusted build context ignored | `packages/core/src/graph-builder.ts` | An absolute or repository-escaping `build:` is dropped; only paths already inside the analysed repository are compared |

### What is not implemented — read before exposing

| Gap | Consequence | Mitigation |
|---|---|---|
| **No API authentication** | Anyone who can reach the port can analyse allowed paths and read stored results | Bind to `127.0.0.1`, or place behind an authenticating proxy |
| **No rate limiting** | A client can queue analyses up to the concurrency limit | Concurrency returns 429; put a rate limiter in the proxy |
| **CORS parsed but not applied** | Browser clients on another origin will be blocked by the same-origin policy | Same-origin deployment works; a cross-origin deployment needs a proxy |
| **Results are not tenant-scoped** | Every stored analysis is readable by every client | Single-operator deployment assumption |
| **No archive-upload route** | Archive extraction exists and is tested, but there is no HTTP endpoint yet | Not reachable, therefore not exposed |
| **Git history may be unavailable for foreign-owned repositories** | Inside the container, a bind-mounted repository owned by another user is refused by git's dubious-ownership guard; commit facts are absent | Documented under *Git history inside the container*; the guard is not disabled by default |

**Recommended posture:** run with `REPOATLAS_ALLOWED_ROOTS` set, bind to `127.0.0.1`, and
put it behind an authenticating reverse proxy if it must be reachable from anywhere else.

---

## Docker

### Build

```bash
docker build -t repoatlas:0.1.0 .
```

Multi-stage: dependencies → build → runtime. The runtime stage carries no compiler, no
test runner and no source tree. `git` and `ca-certificates` are installed because history
facts depend on git; without it the pipeline degrades gracefully.

One detail worth knowing if you modify the Dockerfile: the build stage copies **both**
`/app/node_modules` and `/app/packages` from the dependency stage. npm nests conflicting
versions under `packages/*/node_modules`; copying only the root tree loses them and the
build fails with unresolved imports (`decisions.md`, D-015).

### Run

```bash
docker run -d --name repoatlas \
  -p 127.0.0.1:4300:4300 \
  -e REPOATLAS_ALLOWED_ROOTS=/repos \
  -v "$PWD/repos:/repos:ro" \
  -v repoatlas-data:/data \
  repoatlas:0.1.0
```

| Path | Purpose |
|---|---|
| `/data` | SQLite database. Declare a volume to persist |
| `/repos` | Conventional mount point for repositories. Read-only is enough |

The image sets `REPOATLAS_ALLOWED_ROOTS=/repos`, so a mounted repository is analysable and
nothing else is.

### Compose

```bash
docker compose up --build
```

`docker-compose.yml` is wired with the loopback port binding, the allow-list, a named data
volume, a read-only repository mount and a health check.

### Verify a deployment

```bash
curl -fsS http://127.0.0.1:4300/api/health
# expect "status":"ok" and "pathAllowListEnforced":true

curl -fsS http://127.0.0.1:4300/ | grep 'id="root"'
# expect the UI shell

id=$(curl -fsS -X POST http://127.0.0.1:4300/api/analyses \
  -H 'content-type: application/json' \
  -d '{"repositoryPath":"/repos/target"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

curl -fsS "http://127.0.0.1:4300/api/analyses/$id/graph?limit=5000" \
  | sed -E 's/.*"totals":\{"nodes":([0-9]+).*/nodes: \1/'

# snapshot identity of this state
curl -fsS "http://127.0.0.1:4300/api/analyses/$id/snapshot" \
  | sed -E 's/.*"snapshotId":"([^"]+)".*/snapshot: \1/'

# what changed since an earlier analysis (after making a change and re-analysing)
id2=$(curl -fsS -X POST http://127.0.0.1:4300/api/analyses \
  -H 'content-type: application/json' \
  -d '{"repositoryPath":"/repos/target"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

curl -fsS "http://127.0.0.1:4300/api/analyses/$id2/drift?against=$id" \
  | sed -E 's/.*"totalChanges":([0-9]+).*/total changes: \1/'

# C4 levels
curl -fsS "http://127.0.0.1:4300/api/analyses/$id2/artifacts/c4-container" \
  | sed -E 's/.*"insufficientEvidence":(true|false).*/insufficient: \1/'

# must be refused
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4300/api/analyses \
  -H 'content-type: application/json' -d '{"repositoryPath":"/etc"}'
# expect 403
```

`/drift` requires `against`; without it the server answers 400 rather than guessing which
analysis to compare against. Direction is decided by analysis time, so passing the ids in
either order produces the same report.

The container health check runs the same `/api/health` request every 30 s.

### Git history inside the container

`git` refuses a repository whose owner differs from the process user, and a bind mount from
Windows is owned by root while the container runs as `node`. The result is
`GIT_UNAVAILABLE`: the analysis still succeeds, `headCommit` is empty, and commit, contributor
and ownership facts are absent.

RepoAtlas deliberately does **not** pass `-c safe.directory=*` to suppress this — that guard
exists because a repository owned by another user is a known way to make a git client do
something it should not (`decisions.md`, D-040). Two supported remedies:

- mount the repository so its uid matches the container user (`--user "$(id -u):$(id -g)"`
  together with a matching `REPOATLAS_DB_PATH`, or a `chown` in a derived image), or
- add the exception in the image:

  ```dockerfile
  RUN git config --global --add safe.directory /repos
  ```

Only do the second when every mounted repository is one you already trust to read.

---

## Running without Docker

```bash
npm ci
npm run build

export REPOATLAS_ALLOWED_ROOTS=/srv/repos
export REPOATLAS_DB_PATH=/var/lib/repoatlas/repoatlas.sqlite
npm start
```

Run under a process supervisor. The process handles `SIGINT` and `SIGTERM` with a graceful
shutdown that closes the database.

`var/` and `data/` are gitignored. The database directory is created automatically.

---

## Operational notes

### Analyses are synchronous

An analysis runs inside the HTTP request (`decisions.md`, D-006). A large repository takes
seconds to minutes.

- Reverse proxies need a read timeout longer than your slowest repository.
- `REPOATLAS_ANALYSIS_TIMEOUT_MS` (default 5 min) abandons a run that exceeds it; the
  client receives 504 and a failed analysis record is stored.
- `REPOATLAS_CONCURRENCY` bounds simultaneous analyses; over-capacity returns 429.
- `REPOATLAS_MAX_ANALYSES` bounds stored analyses; reaching it returns 507. Delete one
  before starting another.

### Storage growth

Roughly, per analysis: one row per node, edge and evidence record. For this repository that
is about 1 600 nodes, 2 800 edges and 3 700 evidence records — a few megabytes including
evidence excerpts. `REPOATLAS_MAX_ANALYSES` is the practical bound; delete analyses you no
longer need.

To compact after many deletions:

```bash
sqlite3 /var/lib/repoatlas/repoatlas.sqlite 'VACUUM;'
```

### Health monitoring

`GET /api/health` reports status, version, uptime, environment, whether the allow-list is
enforced, how many analyses are stored, the concurrency limit, the upload cap, whether git
history is enabled, and the Node version. Suitable as a readiness probe.

Diagnostics for a specific run are at `GET /api/analyses/:id/diagnostics`, including which
files were skipped and why.

### Upgrading

1. `npm run verify` on the new revision.
2. Back up the database file.
3. Deploy. `schema_meta.schema_version` records the schema version; a breaking change will
   require a migration, and none has been needed yet.

---

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`.

| Job | What it does |
|---|---|
| `verify` | `npm ci`, lint, typecheck, 215 tests, full build |
| `image` | Builds the real image, starts it, waits for health, checks `/api/health` and the UI, **analyses this repository through the container** and asserts a non-trivial graph, then asserts a path outside the allow-list is refused |

The `image` job is not redundant with `verify`. Two defects in this project passed every
unit test and only appeared when the Linux image was built and run: a startup crash when
the UI was enabled (D-013), and a module resolution failure specific to the container's
dependency layout (D-014).