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
# better-sqlite3 is a native module with no musl (Alpine) prebuilt binary, so
# it must be compiled from source here — which needs a toolchain. Doing it in a
# dedicated stage keeps python3/make/g++ out of the final image. This stage
# runs on the TARGET platform, so the compiled binary matches the runtime arch.
FROM node:22-alpine AS server-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---- Stage 3: server runtime ----
FROM node:22-alpine

# docker-cli + the v2 compose plugin so `docker compose ...` works.
# NOTE: this is docker-cli-compose (the v2 `docker compose` plugin), not the
# deprecated v1 `docker-compose` standalone binary.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

COPY --from=server-deps /app/node_modules ./node_modules
COPY server/package*.json ./
COPY server/src ./src
COPY --from=client-builder /app/client/dist ./client/dist

EXPOSE 5000

# Container health: hit the public /api/health endpoint. Node 22 ships a
# global fetch, so no extra tooling is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
