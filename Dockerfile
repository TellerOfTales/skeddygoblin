# Two stages so the runtime image carries no compiler, no dev dependencies and
# no source - just the built output and what it needs to run.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Copied first so this layer caches on the lockfile rather than on source
# changes - editing a handler should not reinstall node_modules.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependency tree, resolved separately from the build one.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Drop privileges. The node image ships a `node` user for exactly this.
USER node

# Only listened on when Steam is configured; harmless otherwise.
EXPOSE 8080

# No npm wrapper: node is PID 1 so it receives SIGTERM directly and the
# graceful shutdown in src/index.ts actually runs.
CMD ["node", "dist/index.js"]
