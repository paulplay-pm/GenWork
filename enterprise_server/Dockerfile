# ---- Stage 1: web SPA build -----------------------------------------------
# enterprise_server/web is a standalone npm project (not a workspace),
# with its own lockfile. We build the SPA in its own stage so that
# dist/web-dist can be COPY --from=web-build into the server stage.
FROM node:24-alpine AS web-build
WORKDIR /work
COPY enterprise_server/web/package.json enterprise_server/web/package-lock.json* ./web/
RUN cd web && npm ci --no-audit --no-fund --ignore-scripts
COPY enterprise_server/web/ ./web/
RUN cd web && npm run build

# ---- Stage 2: server build -----------------------------------------------
# enterprise_server itself is an npm workspace of the repo root, so its
# dependency lock lives at the ROOT package-lock.json. Install via the
# workspace selector and include the workspace root so the install
# resolves the workspace links. web-dist comes in from the web stage
# via COPY --from=web-build.
FROM node:24-alpine AS build
WORKDIR /work/repo
COPY package.json package-lock.json ./
COPY enterprise_server/package.json enterprise_server/
RUN npm ci --no-audit --no-fund --ignore-scripts \
        --include-workspace-root \
        --workspace=@genwork/enterprise-server

# Lay out the rest of the server source (src + tsconfig + cli) alongside
# the workspace. Vite already wrote web-dist to enterprise_server/web-dist,
# so we copy that in last to keep the layer dependencies clean.
COPY enterprise_server/src enterprise_server/src
COPY enterprise_server/tsconfig.json enterprise_server/tsconfig.build.json enterprise_server/

WORKDIR /work/repo/enterprise_server
COPY --from=web-build /work/web-dist ./web-dist
ARG VERSION=dev
ENV VERSION=$VERSION
RUN npm run build
# Patch bare relative imports in dist/ to add the .js extension. Node's
# ESM loader rejects specifiers like './db/pool' and requires './db/pool.js'.
# enterprise_server's source uses bare specifiers; tsc with
# moduleResolution: Bundler preserves them, so the produced dist/ tree
# is otherwise unloadable by `node` without this fix.
# TODO: remove once enterprise_server migrates to NodeNext-style imports.
COPY enterprise_server/scripts/patch-esm-imports.mjs /work/repo/patch-esm-imports.mjs
RUN node /work/repo/patch-esm-imports.mjs /work/repo/enterprise_server/dist
# SQL migration files are not TypeScript, so tsc does not emit them.
# runMigrations reads from dist/db/migrations at runtime; copy them
# across explicitly so the directory exists.
COPY enterprise_server/src/db/migrations /work/repo/enterprise_server/dist/db/migrations

# ---- Stage 3: runtime ----------------------------------------------------
FROM node:24-alpine AS runtime
# node:24-alpine already ships a `node` user (uid/gid 1000), so we just
# need tini + the postgres client + bash. No adduser/addgroup needed.
RUN apk add --no-cache tini postgresql16-client bash

WORKDIR /app/repo
COPY package.json package-lock.json ./
COPY enterprise_server/package.json enterprise_server/
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
        --include-workspace-root \
        --workspace=@genwork/enterprise-server \
 && npm cache clean --force

# Layout the runtime tree so the node process resolves npm packages via
# /app/repo/node_modules. Dist sits alongside node_modules at /app/repo/dist
# (not at /app/dist) so ESM's package resolution finds 'pg', 'hono', etc.
WORKDIR /app/repo
COPY --from=build /work/repo/enterprise_server/dist ./dist
COPY --from=build /work/repo/enterprise_server/web-dist ./web-dist

ARG VERSION=dev
ENV VERSION=$VERSION \
    NODE_ENV=production \
    PORT=8787 \
    WEB_DIST_DIR=/app/repo/web-dist
EXPOSE 8787
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/repo/dist/cli/index.js"]
CMD ["start"]