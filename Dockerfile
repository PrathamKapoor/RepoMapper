# syntax=docker/dockerfile:1

###############################################################################
# RepoAtlas — multi-stage image
#
# Stage 1  deps     : install the full workspace (including dev deps) to build
# Stage 2  build    : compile every package to dist/ and bundle the web UI
# Stage 3  runtime  : production dependencies and compiled output only
#
# The runtime stage does not contain the TypeScript compiler, the test runner or the
# source tree. Node's SQLite build is used, so there is no native module to compile and
# the image builds without a toolchain beyond the Node base image.
###############################################################################

FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Copy only manifests first so the dependency layer is cached independently of source.
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/ingest/package.json    packages/ingest/
COPY packages/parsers/package.json   packages/parsers/
COPY packages/artifacts/package.json packages/artifacts/
COPY packages/server/package.json    packages/server/
COPY packages/web/package.json       packages/web/

RUN npm ci --no-audit --no-fund


FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development

# Both trees are required: npm hoists most dependencies to the workspace root but nests
# conflicting versions under packages/*/node_modules. Copying only the root tree loses
# those, and the build fails with unresolved imports for workspace devDependencies.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages     ./packages
COPY . .

RUN npm run build


FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4300 \
    REPOATLAS_DB_PATH=/data/repoatlas.sqlite \
    REPOATLAS_STATIC_DIR=/app/packages/web/dist

# git is required for history-based facts (ownership, commits). Without it the
# pipeline degrades gracefully and records GIT_UNAVAILABLE rather than failing.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /repos \
 && chown -R node:node /data /repos

COPY --from=build --chown=node:node /app/package.json            ./package.json
COPY --from=build --chown=node:node /app/node_modules             ./node_modules
COPY --from=build --chown=node:node /app/packages/core/dist      ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/package.json  ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/ingest/dist       ./packages/ingest/dist
COPY --from=build --chown=node:node /app/packages/ingest/package.json   ./packages/ingest/package.json
COPY --from=build --chown=node:node /app/packages/parsers/dist      ./packages/parsers/dist
COPY --from=build --chown=node:node /app/packages/parsers/package.json ./packages/parsers/package.json
COPY --from=build --chown=node:node /app/packages/artifacts/dist    ./packages/artifacts/dist
COPY --from=build --chown=node:node /app/packages/artifacts/package.json ./packages/artifacts/package.json
COPY --from=build --chown=node:node /app/packages/server/dist       ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/server/package.json  ./packages/server/package.json
COPY --from=build --chown=node:node /app/packages/web/dist         ./packages/web/dist

USER node
EXPOSE 4300
VOLUME ["/data"]

# The API refuses paths outside REPOATLAS_ALLOWED_ROOTS. Mount repositories at /repos
# and set REPOATLAS_ALLOWED_ROOTS=/repos to get a bounded deployment.
ENV REPOATLAS_ALLOWED_ROOTS=/repos

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]