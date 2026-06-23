# Build context MUST be the repo root, e.g.:
#   docker build -f server/Dockerfile -t diun-updater .
# (docker-compose.yml at the repo root is already configured this way.)

# ---- Stage 1: build the client SPA ----
FROM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: server runtime ----
FROM node:22-alpine

# docker-cli + the v2 compose plugin so `docker compose ...` works.
# NOTE: this is docker-cli-compose (the v2 `docker compose` plugin), not the
# deprecated v1 `docker-compose` standalone binary.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/src ./src
COPY --from=client-builder /app/client/dist ./client/dist

EXPOSE 5000

CMD ["node", "src/index.js"]
