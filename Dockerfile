# syntax=docker/dockerfile:1
# Flood Monitor — all-in-one image (dashboard + API + embedded poller + SQLite).
# Build:  docker build -t flood-monitor .
# Run:    docker compose up -d   (see docker-compose.yml)

# ---- dependencies -----------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORE=sqlite \
    DATA_DIR=/app/data \
    EMBEDDED_WORKER=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# The official image ships an unprivileged "node" user (uid/gid 1000).
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
VOLUME ["/app/data"]
EXPOSE 3000

# No curl in the slim image: use Node's built-in fetch.
HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
