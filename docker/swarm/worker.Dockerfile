# syntax=docker/dockerfile:1
#
# Hermes-Swarm worker image.
#
# Each swarm worker runs in its own container built from this image. The worker
# entrypoint is bundled by esbuild into a single self-contained JS file, so the
# runtime image needs nothing but Node and that one file — it stays tiny, which
# matters when the manager may spawn dozens of these in parallel.
#
# Build (from repo root):
#   docker build -f docker/swarm/worker.Dockerfile -t hermes-swarm-worker:latest .

# ── build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
# Only esbuild is needed to produce the bundle; install it in isolation to keep
# the build fast and independent of the full dependency tree.
RUN npm install --no-audit --no-fund esbuild@0.27.0
COPY tsconfig.json ./tsconfig.json
COPY scripts/build-swarm.mjs ./scripts/build-swarm.mjs
COPY src/swarm-runtime ./src/swarm-runtime
RUN node scripts/build-swarm.mjs

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
# Run as an unprivileged user — defense in depth alongside the manager's
# --cap-drop / --no-new-privileges / --read-only spawn flags.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin worker
WORKDIR /app
COPY --from=build /build/dist-swarm/worker ./worker
USER worker
ENV NODE_ENV=production
# The worker reads SWARM_* env vars injected by the manager at spawn time.
ENTRYPOINT ["node", "worker/entrypoint.js"]
