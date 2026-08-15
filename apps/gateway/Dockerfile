# Gateway container — SDD v0.5 §23, §28. Multi-stage build; runs as a
# non-root user; no host ports (the compose file only `expose`s 3000).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN pnpm install --frozen-lockfile --filter @browser-bridge/gateway... --ignore-scripts
COPY packages/protocol packages/protocol
COPY packages/config packages/config
COPY packages/policy packages/policy
COPY packages/audit packages/audit
COPY apps/gateway apps/gateway
RUN pnpm --filter @browser-bridge/protocol build \
 && pnpm --filter @browser-bridge/config build \
 && pnpm --filter @browser-bridge/policy build \
 && pnpm --filter @browser-bridge/audit build \
 && pnpm --filter @browser-bridge/gateway build
RUN pnpm --filter @browser-bridge/gateway deploy --prod --legacy /out

FROM node:22-alpine
# The runtime only ever executes `node`; drop the bundled npm/corepack
# toolchain (smaller attack surface, and npm's vendored deps otherwise
# carry CVEs the image scanner rightly flags).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && addgroup -S bridge && adduser -S bridge -G bridge \
 && mkdir -p /var/lib/browser-bridge/artifacts \
 && chown -R bridge:bridge /var/lib/browser-bridge
WORKDIR /app
COPY --from=build --chown=bridge:bridge /out /app/apps/gateway
COPY --chown=bridge:bridge db/migrations /app/db/migrations
ENV NODE_ENV=production \
    PORT=3000 \
    MIGRATIONS_DIR=/app/db/migrations
USER bridge
EXPOSE 3000
CMD ["node", "apps/gateway/dist/server.js"]
