# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS production-deps

WORKDIR /workspace
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN corepack enable \
    && apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/package.json
COPY admin/package.json ./admin/package.json
COPY web/package.json ./web/package.json
RUN --mount=type=cache,id=media-parser-pnpm-alpine,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @media-parser/api

FROM production-deps AS builder

RUN --mount=type=cache,id=media-parser-pnpm-alpine,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter media-parser-ts \
      --filter @media-parser/api

COPY api ./api
RUN pnpm --filter @media-parser/api build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=8051 \
    DATABASE_PATH=/app/data/media-parser.sqlite

RUN addgroup -S -g 10001 media-parser \
    && adduser -S -D -H -u 10001 -G media-parser media-parser \
    && mkdir -p /app/data \
    && chown -R media-parser:media-parser /app

WORKDIR /app
COPY --from=production-deps --chown=media-parser:media-parser /workspace/node_modules ./node_modules
COPY --from=production-deps --chown=media-parser:media-parser /workspace/api/node_modules ./api/node_modules
COPY --from=builder --chown=media-parser:media-parser /workspace/api/package.json ./api/package.json
COPY --from=builder --chown=media-parser:media-parser /workspace/api/dist ./api/dist
COPY --from=builder --chown=media-parser:media-parser /workspace/api/openapi ./api/openapi

USER media-parser
VOLUME ["/app/data"]
EXPOSE 8051
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT ?? '8051'; fetch(`http://127.0.0.1:${port}/api/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "api/dist/server.js"]
