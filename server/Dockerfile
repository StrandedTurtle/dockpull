# Build context MUST be the repo root, e.g.:
#   docker build -f server/Dockerfile -t diun-updater .
# (docker-compose.yml at the repo root is already configured this way.)

# ---- Stage 1: build the client SPA ----
# Pin to the build platform: the client output is static, arch-independent JS,
# so there's no need to run the Vite build under emulation for each target
# platform during a multi-arch build.
FROM --platform=$BUILDPLATFORM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: server dependencies ----
# Built on the BUILD machine's own CPU (like the client), not under QEMU
# emulation: `npm ci` for linux/arm64 under QEMU intermittently died with
# "qemu: uncaught target signal 4 (Illegal instruction)", and buildx then hung
# instead of failing (it stalled the `:latest` builds of v1.8.0 and v1.9.0).
#
# Nothing here needs compiling for the target CPU, so the result is the same
# for every platform: the deps are plain JS, and better-sqlite3 ships prebuilt
# binaries for each platform inside the package and picks the right one at
# runtime (prebuilds/linuxmusl-<arch>.node). --ignore-scripts skips its
# redundant node-gyp step, ssh2/cpu-features' optional native speedups (only
# used for Docker-over-SSH, which DockPull doesn't use; they fall back to JS),
# and protobufjs's warning-only postinstall. No compiler toolchain needed.
FROM --platform=$BUILDPLATFORM node:22-alpine AS server-deps
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && find node_modules/better-sqlite3/prebuilds -type f ! -name 'linuxmusl-*' -delete \
  && test -f node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node \
  && test -f node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node

# ---- Stage 3: server runtime ----
FROM node:22-alpine

# docker-cli + the v2 compose plugin so `docker compose ...` works.
# NOTE: this is docker-cli-compose (the v2 `docker compose` plugin), not the
# deprecated v1 `docker-compose` standalone binary.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

# Mirror the repo's relative layout (server/src, client/dist) rather than
# flattening server/src to /app/src — index.js derives the client dist path
# from __dirname relative to its own location, and that math must match
# between local dev (run from the repo) and this image.
COPY --from=server-deps /app/node_modules ./server/node_modules
COPY server/package*.json ./server/
COPY server/src ./server/src
COPY --from=client-builder /app/client/dist ./client/dist

EXPOSE 5000

# Container health: hit the public /api/health endpoint. Node 22 ships a
# global fetch, so no extra tooling is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
