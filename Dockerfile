# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g npm@11.21.0
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules node_modules
COPY --from=build --chown=root:root /app/package.json ./
COPY --from=build --chown=root:root /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=root:root /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=root:root /app/apps/server/package.json apps/server/
COPY --from=build --chown=root:root /app/apps/server/dist apps/server/dist
COPY --from=build --chown=root:root /app/apps/server/migrations apps/server/migrations
# Code is root-owned and read-only for the runtime user.
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]

FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
