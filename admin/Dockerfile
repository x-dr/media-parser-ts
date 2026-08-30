# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS builder

WORKDIR /workspace
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/package.json
COPY admin/package.json ./admin/package.json
COPY web/package.json ./web/package.json
RUN --mount=type=cache,id=media-parser-pnpm-alpine,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @media-parser/admin

COPY admin ./admin
RUN pnpm --filter @media-parser/admin build

FROM nginx:alpine AS runtime

RUN rm /etc/nginx/conf.d/default.conf
COPY admin/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder --chown=nginx:nginx /workspace/admin/dist /usr/share/nginx/html/admin

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

CMD ["nginx", "-g", "daemon off;"]
