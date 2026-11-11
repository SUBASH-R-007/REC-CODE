# REC Code — the application image.
#
# One image, three entrypoints, which is what deploy/compose.app.yml expects:
#
#   node apps/web/server.js            the web app (2 replicas)
#   node apps/scheduler/dist/main.js   the scheduler (exactly one)
#   node apps/judge-worker/dist/main.js  a worker — see "The judge" below
#
# It carries NO toolchain: no compilers, no interpreters, no isolate. Student
# code is never executed by anything in here. The judge host is a different
# machine built from infra/judge (cloud-init, a setuid isolate and the pinned
# toolchains); the worker entrypoint is in this image so that host can run the
# same build rather than compiling its own, and it is useless without isolate.
#
# Secrets are never built in. Every credential arrives at RUN time as a file
# (DATABASE_URL_FILE, IP_HASH_PEPPER_FILE, …) that packages/shared/env-file
# reads; .dockerignore keeps .env files out of the build context entirely.
#
# Build (from the repository root):
#
#   docker build -t recx-web:$(git rev-parse --short HEAD) .
#
# and deploy by digest, never by tag (docs/RUNBOOK.md §2.13).

# The base is pinned by tag here and MUST be pinned by digest in CI, the same
# rule deploy/*.yml follows for every image it names.
ARG NODE_IMAGE=node:22.17.1-bookworm-slim

# ── The toolchain the build needs ───────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
# The one pnpm the gates are run with (docs/CONVENTIONS.md): a different one
# resolves the lockfile differently.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /src

# ── Install, generate, build ────────────────────────────────────────────
#
# node-linker=hoisted, deliberately. pnpm's default layout is a symlink farm
# whose links are ABSOLUTE paths into /src, and `next build`'s standalone
# output copies those links as links: the tree then resolves only while /src
# exists at exactly that path, so the runtime stage below — a different
# filesystem — fails on its first require ("Cannot find module
# 'styled-jsx/package.json'"). Hoisting makes node_modules real directories,
# which copy.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted

# `next build` runs the Prisma client generation through the db package's own
# postinstall; this makes it explicit and fails the build if it did not run.
RUN pnpm --filter @recx/db generate \
 && test -d node_modules/.prisma/client

RUN pnpm --filter @recx/web build \
 && pnpm --filter @recx/scheduler build \
 && pnpm --filter @recx/judge-worker build

# The scheduler and the worker are single ESM bundles with their npm
# dependencies left external (tsup `noExternal: [/^@recx\//]`), so they need a
# node_modules beside them: the standalone tree's own modules are only what
# the WEB app imports, and `pino` and `nodemailer` are not among them.
# `pnpm deploy` writes a self-contained production tree per project — and
# needs the same hoisting, for the same reason as the install above.
RUN pnpm deploy --filter @recx/scheduler --prod --config.node-linker=hoisted /out/scheduler \
 && pnpm deploy --filter @recx/judge-worker --prod --config.node-linker=hoisted /out/judge-worker

# `pnpm deploy` runs the db package's postinstall again in the new tree, and
# what that writes is a 40 KB STUB of the Prisma client, not the ~50 MB
# generated one: `Prisma.sql` and `Prisma.raw` are missing, so the scheduler
# dies on its first raw query with "Prisma2.raw is not a function". Replace
# it with the client generated above. (The worker holds no database
# credentials and has no @prisma/client dependency at all.)
RUN rm -rf /out/scheduler/node_modules/.prisma \
 && cp -r node_modules/.prisma /out/scheduler/node_modules/.prisma \
 && test -f /out/scheduler/node_modules/.prisma/client/default.js

# ── The image that ships ────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# openssl for the Prisma query engine; ca-certificates for TLS to S3 and SMTP.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
WORKDIR /app

# The standalone tree is the root of everything: `node apps/web/server.js`
# chdirs to its own directory, which is what makes the health endpoint's
# `../../packages/db/prisma/migrations` resolve — those migrations are inside
# it already, traced from the schema, and the endpoint counts that folder
# against the rows in _prisma_migrations.
COPY --from=build --chown=node:node /src/apps/web/.next/standalone/ ./
# Tracing does not copy either of these: the server serves them from disk.
COPY --from=build --chown=node:node /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /src/apps/web/public ./apps/web/public

# Each bundle keeps its own package.json, which is how Node learns it is ESM:
# without `"type": "module"` beside it, `main.js` is reparsed on every start
# and warns MODULE_TYPELESS_PACKAGE_JSON.
COPY --from=build --chown=node:node /src/apps/scheduler/dist ./apps/scheduler/dist
COPY --from=build --chown=node:node /out/scheduler/node_modules ./apps/scheduler/node_modules
COPY --from=build --chown=node:node /out/scheduler/package.json ./apps/scheduler/package.json
COPY --from=build --chown=node:node /src/apps/judge-worker/dist ./apps/judge-worker/dist
COPY --from=build --chown=node:node /out/judge-worker/node_modules ./apps/judge-worker/node_modules
COPY --from=build --chown=node:node /out/judge-worker/package.json ./apps/judge-worker/package.json

# Nothing here writes to the filesystem: uploads spool to a tmpfs the compose
# file mounts, and the test data lives in S3/MinIO.
USER node
EXPOSE 3000

# No HEALTHCHECK: deploy/compose.app.yml defines one per service (the web's
# reads /api/health, the scheduler has none because it serves nothing), and
# two sources for it is one too many.
CMD ["node", "apps/web/server.js"]
