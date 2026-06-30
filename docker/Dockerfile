# PicoGallery V2 — server image (serves the built client too).
# Build context is the repo root: `docker build -f docker/Dockerfile .`

# ---- build stage -------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

# Install with a warm dependency cache: copy manifests first.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile

# Copy sources and build shared → server → client (topological).
COPY shared/ shared/
COPY server/ server/
COPY client/ client/
RUN pnpm build

# Drop dev dependencies to slim the runtime copy.
RUN pnpm prune --prod

# ---- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PICO_CONFIG=/config/config.toml
WORKDIR /app

# Built workspace + pruned node_modules. The server resolves the client SPA at
# ../../../client/dist relative to server/dist/http, so the layout is preserved.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/package.json ./package.json

EXPOSE 8188
VOLUME ["/config", "/cache"]

# Liveness: the server answers /health before sources finish loading.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8188/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
