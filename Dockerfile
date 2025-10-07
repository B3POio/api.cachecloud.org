# ---- Base (small + secure) ----
FROM node:22-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# tiny tools (for healthcheck curl) + user setup
RUN apk add --no-cache tini curl && \
    addgroup -S app && adduser -S app -G app

# ---- Install deps only (cache-friendly) ----
FROM base AS deps
# copy only manifests to leverage Docker layer caching
COPY package.json package-lock.json* ./
# install prod deps; use npm since you prefer it
RUN npm ci --omit=dev

# ---- Final runtime image ----
FROM base AS runtime
# copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
# copy the rest of the app
COPY . .

# run as non-root
USER app

# expose your API port
EXPOSE 5015

# optional: better stack traces in prod
ENV NODE_OPTIONS="--enable-source-maps"

# HEALTHCHECK (adjust /health path if needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:5015/health || exit 1

# tini handles proper signal forwarding (SIGTERM) for graceful shutdowns
ENTRYPOINT ["/sbin/tini","--"]

# Your ESM entry (kept minimal; all routing/error/cors in index.js)
CMD ["node", "index.js"]
