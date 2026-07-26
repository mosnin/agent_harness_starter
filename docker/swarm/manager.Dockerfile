# syntax=docker/dockerfile:1
#
# Hermes-Swarm manager image.
#
# Runs the manager agent + web dashboard (`hermes-swarm serve --mode docker`).
# The manager spawns worker *containers* as siblings via the host Docker socket,
# so this container is granted the socket mount in docker-compose.swarm.yml.
#
# Build (from repo root):
#   docker build -f docker/swarm/manager.Dockerfile -t hermes-swarm-manager:latest .

# ── build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund esbuild@0.27.0
COPY tsconfig.json ./tsconfig.json
COPY scripts/build-swarm.mjs ./scripts/build-swarm.mjs
COPY src/swarm-runtime ./src/swarm-runtime
RUN node scripts/build-swarm.mjs

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
# The docker CLI lets the manager talk to the mounted daemon socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/dist-swarm ./dist-swarm
ENV NODE_ENV=production
# Dashboard + control-plane ports.
EXPOSE 8080 8787
# Liveness: the dashboard's unauthenticated /healthz must return 200.
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["node", "dist-swarm/cli.js"]
CMD ["serve", "--mode", "docker", "--host", "0.0.0.0", "--workers", "3", \
     "--image", "hermes-swarm-worker:latest"]
