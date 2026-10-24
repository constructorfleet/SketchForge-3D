# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV SKETCHFORGE_DOCKER_BUILD=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV SKETCHFORGE_SHARED_PROJECTS_DIR=/data/projects

# su-exec lets the entrypoint drop from root to node after it has prepared
# the storage directories; see deploy/docker/entrypoint.sh.
RUN apk add --no-cache libcap su-exec \
  && setcap cap_net_bind_service=+ep /usr/local/bin/node \
  && mkdir -p /data/projects \
  && chown node:node /data/projects

COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
COPY --chown=node:node deploy/docker/start-server.mjs ./deploy/docker/start-server.mjs
COPY --chmod=755 deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh

EXPOSE 80 3000
VOLUME ["/data/projects"]

# Healthy means the server answers the shared-library route with its JSON
# status. An empty SKETCHFORGE_SHARED_PROJECTS_DIR (shared projects turned off)
# answers 200 with enabled:false, which is a configuration, not a fault; an
# unreadable library answers 500, which wget treats as a failure.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/api/shared-projects | grep -q '"enabled":' || exit 1

# The container starts as root so the entrypoint can create and chown the
# directories SKETCHFORGE_SHARED_PROJECTS_DIR and SKETCHFORGE_PROJECTS_DIR name,
# on a fresh volume or a bind mount; the server itself runs as node.
ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
CMD ["node", "deploy/docker/start-server.mjs"]
