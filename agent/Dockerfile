# The MCP gateway that Grok Bot talks to (see agent/README.md).
# Build from the repository root, because the gateway reuses mcp/src/query.ts:
#   docker build -f agent/Dockerfile -t aipulse-agent-gateway .
# Deploy ON: root directory = the repository root, Dockerfile path = agent/Dockerfile.

FROM node:22-alpine AS build
WORKDIR /src/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY agent/tsconfig.json agent/tsup.config.ts ./
COPY agent/src ./src
COPY mcp/src /src/mcp/src
RUN npm run build:gateway

# The runtime image holds Node and one bundled file, nothing else.
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /src/agent/dist/gateway.js ./gateway.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
# Measured under a 64 MB, quarter-CPU cap: this small V8 heap keeps the process inside it.
CMD ["node", "--max-old-space-size=24", "--max-semi-space-size=1", "gateway.js"]
