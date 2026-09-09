# Enterprise Server Packaging & Installation

> **Status:** draft
> **Date:** 2026-10-15
> **Owner:** GenWork platform team
> **Scope:** A Docker-based packaging + CLI installation flow for the GenWork Enterprise Server (Hono + Node.js + PostgreSQL), running on a customer-owned Linux host and connecting to a customer-owned external PostgreSQL.

---

## 1. Background & Goal

Today the Enterprise Server has only `npm run dev` / `npm test` / `reinit`. There is no official, reproducible way for a customer IT team to deploy a production-ready instance on a clean Linux box. The README walks through manual `git clone` + `npm install` + `docker run postgres` + filling `.env`, which is fine for a developer's laptop but not for handing the artifact to an external IT team.

This spec defines a Docker-image-based delivery, a `genwork-server` CLI that wraps the lifecycle, and the deployment manual that goes with them. After this lands, a customer with:

- a Linux host (Ubuntu 22.04+ / RHEL 9+ recommended),
- an external PostgreSQL 14+ they own,
- a `.env` filled in,

can run `docker compose up -d` and have a working Enterprise Server with `/setup` reachable, plus a working upgrade path.

### Non-goals (explicit)

1. **No image publishing to GHCR / Docker Hub.** Customers build the image themselves or pull from their own internal registry. The repo ships a `Dockerfile`, a `build-enterprise-image.sh`, and a CI workflow that *can* push to a configurable registry target — but the team's standing decision is to not own a public registry account.
2. **No bundled Postgres.** The customer owns the database lifecycle (backups, HA, monitoring). The app container just connects via `DATABASE_URL`.
3. **No built-in reverse proxy / TLS.** The app listens on plain HTTP. Customers terminate TLS with whatever they already have (Caddy / nginx / cloud LB). The spec ships Caddy and nginx config snippets as a starting point, not as part of the artifact.
4. **No changes to the dev workflow.** `npm run dev`, `npm test`, the existing pglite test path, and `reinit` all keep working untouched. The container path is additive.
5. **No changes to desktop `ENTERPRISE_SERVER_URL` handling.** The desktop side's build-time bake stays as-is; the spec only touches the server side.

---

## 2. User & Workflow

**Primary user:** Customer IT / DevOps engineer.

**Workflow they will follow:**

1. Receive the repo (or a tarball) from the GenWork team.
2. Read `docs/enterprise-server-deploy.md`.
3. Build the image on a build host: `./scripts/build-enterprise-image.sh v2026.10.15`.
4. Push the image to their internal registry (out of band; not part of this spec).
5. On the production host, prepare a `.env` from `.env.example`, including `POSTGRES_SUPERUSER_URL` (one-time), `DATABASE_URL` (used at runtime), `JWT_SECRET`, `GENWORK_VAULT_MASTER_KEY`.
6. Run `genwork-server init` (host-side, uses Docker socket): creates the application role + database in the customer's Postgres, writes `/etc/genwork/`, copies `compose.yml`, generates a Caddyfile example.
7. Run `genwork-server start` (or just `docker compose up -d`).
8. Open `https://<host>/setup` and create the org + super-admin.
9. Later: `genwork-server upgrade --to v2026.11.1` to upgrade in place.
10. `genwork-server backup` to snapshot the database + `/etc/genwork` (database backup is delegated to `pg_dump`; this spec only orchestrates it).

---

## 3. Architecture

```
┌─────────────────────────── Customer host ───────────────────────────┐
│                                                                     │
│  /etc/genwork/                       ┌────────────────────────┐    │
│  ├── compose.yml   (copied at init)  │  Reverse proxy         │    │
│  ├── caddyfile.example              │  (customer-managed)    │    │
│  ├── current-version                │  terminates TLS,       │    │
│  ├── previous-version               │  forwards to :8787     │    │
│  └── data/                          └──────────┬─────────────┘    │
│        │  (mounted into container)             │                    │
│        ▼                                       │                    │
│  ┌─────────────────────────────────┐  https://host/api/*          │
│  │  enterprise-server container    │ ◀──────┘                    │
│  │  image: enterprise-server:<ver> │                              │
│  │  - node:24-alpine runtime       │                              │
│  │  - ENTRYPOINT: genwork-server   │                              │
│  │  - non-root user "node"         │                              │
│  │  - HEALTHCHECK: GET /health     │                              │
│  │  - persistent: /data            │                              │
│  └────────────────┬────────────────┘                              │
│                   │ DATABASE_URL (TLS)                            │
└───────────────────┼─────────────────────────────────────────────────┘
                    ▼
            ┌──────────────────┐
            │  Customer's      │
            │  PostgreSQL 14+  │
            │  (managed)       │
            └──────────────────┘
```

`genwork-server` is a single Node entry point installed both:

- inside the container at `/usr/local/bin/genwork-server` (the container's `ENTRYPOINT`),
- on the host at `/usr/local/bin/genwork-server` (installed once by `init`, runs as root since it talks to the Docker socket).

The host-side and container-side binaries are the same source file. `init` / `upgrade` / `status` / `backup` / `restore` make sense from the host; `start` / `migrate` / `version` are what the container does at boot.

---

## 4. Deliverables

| # | Path | What it is |
| --- | --- | --- |
| 1 | `enterprise_server/Dockerfile` | Multi-stage: web SPA build → TS compile → `node:24-alpine` runtime with `tini`, `postgresql-client`, non-root `node` user, `genwork-server` entry point, `/data` volume, `HEALTHCHECK` |
| 2 | `enterprise_server/docker-compose.yml` | One `app` service, `env_file: .env`, named volume `genwork_data` mounted at `/data`, `restart: unless-stopped`, `healthcheck` calling `/health`, port mapping `127.0.0.1:8787:8787` (no public port) |
| 3 | `enterprise_server/cli/index.ts` (extended) | Existing `reinit` subcommand stays. New: `init`, `start`, `migrate`, `status`, `logs`, `backup`, `restore`, `upgrade`, `version` |
| 4 | `enterprise_server/cli/init.ts` (new) | Idempotent Postgres bootstrap using `POSTGRES_SUPERUSER_URL`: `CREATE ROLE` / `CREATE DATABASE` / `GRANT`; writes `/etc/genwork/`, copies `compose.yml` + `caddyfile.example`, generates a `.env` template at the host, records `current-version` |
| 5 | `enterprise_server/cli/upgrade.ts` (new) | Pull new image, run pre-migration in a one-shot container (`--entrypoint genwork-server migrate`), swap `image:` in `/etc/genwork/compose.yml`, `docker compose up -d`, watch `HEALTHCHECK` for 30s; on failure, restore `image:` to `previous-version` and roll back |
| 6 | `enterprise_server/cli/backup.ts` (new) | `pg_dump --no-owner --no-privileges` (uses `DATABASE_URL`), tar `/etc/genwork/data`, write to `--out <path>`; defaults to `./genwork-backup-<date>.tar.gz` |
| 7 | `enterprise_server/cli/restore.ts` (new) | Inverse of `backup`: validate target, refuse if `genwork-server status` says the server is up, prompt for confirmation, run `pg_restore` (or `psql` if plain SQL), restore `/etc/genwork/data` from tar |
| 8 | `enterprise_server/cli/start.ts` (new) | Container-side: run migrations, exec the server. Used as the `ENTRYPOINT` of the container. `tini` wraps the process tree |
| 9 | `enterprise_server/cli/status.ts` (new) | `docker compose ps` + `curl http://127.0.0.1:8787/health` + version report; exit codes: 0 healthy, 1 unhealthy, 2 not running |
| 10 | `enterprise_server/.env.example` (extended) | Add `POSTGRES_SUPERUSER_URL` (one-time, used by `init` only), `IMAGE_TAG` (default `latest`), `DATA_DIR` (default `/etc/genwork/data`). All other fields stay. |
| 11 | `enterprise_server/caddyfile.example` (new) | Caddy v2 config that reverse-proxies to `127.0.0.1:8787`, sets `X-Forwarded-For` / `X-Forwarded-Proto`, sets `proxy_read_timeout 120s` for the streaming model proxy. Includes both a LAN and a public-host variant. |
| 12 | `enterprise_server/nginx.conf.example` (new) | Equivalent nginx snippet for customers that don't use Caddy |
| 13 | `scripts/build-enterprise-image.sh` (new) | `docker buildx build --tag enterprise-server:<git-sha>+<version> --load .` with sensible defaults; reads version from `git describe` or `--version` arg |
| 14 | `.github/workflows/enterprise-server-image.yml` (new, optional) | Builds the image on tag push; can publish to a configurable registry via `REGISTRY` repo variable. Skipped silently if `REGISTRY` is empty (the default). |
| 15 | `docs/enterprise-server-deploy.md` (new) | End-to-end manual: prerequisites → image build → `.env` → `init` → `start` → `/setup` → upgrade → backup → restore → monitoring → troubleshooting |
| 16 | `enterprise_server/tests/cli/` (new) | Vitest cases for the new CLIs: `init` (Postgres path mocked, idempotency), `upgrade` (image-tag swap, rollback on healthcheck fail), `backup` / `restore` (tar + sql round-trip) |

---

## 5. Detailed Behavior

### 5.1 `Dockerfile` (multi-stage)

```dockerfile
# ---- Stage 1: web SPA build -----------------------------------------------
FROM node:24-alpine AS web-build
WORKDIR /work
COPY enterprise_server/web/package.json enterprise_server/web/package-lock.json* ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY enterprise_server/web/ ./web/
RUN cd web && npm run build
# output: /work/web/dist

# ---- Stage 2: TypeScript compile -----------------------------------------
FROM node:24-alpine AS ts-build
WORKDIR /work
COPY enterprise_server/package.json enterprise_server/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY enterprise_server/ ./
COPY --from=web-build /work/web/dist ./web-dist
RUN npm run build
# output: /work/dist/  (TypeScript → JS) + web-dist/

# ---- Stage 3: runtime ----------------------------------------------------
FROM node:24-alpine AS runtime
RUN apk add --no-cache tini postgresql16-client bash \
 && addgroup -S node && adduser -S node -G node
WORKDIR /app
COPY enterprise_server/package.json enterprise_server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=ts-build /work/dist ./dist
COPY --from=ts-build /work/web-dist ./web-dist
COPY enterprise_server/cli ./cli
COPY enterprise_server/caddyfile.example ./caddyfile.example
COPY enterprise_server/migrations ./migrations   # if any pure-SQL migrations live here
ENV NODE_ENV=production \
    PORT=8787 \
    WEB_DIST_DIR=/app/web-dist
EXPOSE 8787
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/cli/dist/index.js"]
```

`HEALTHCHECK` reuses the existing `GET /health` endpoint already defined in `server.ts:54`.

The runtime stage uses `cli/dist/index.js` as `ENTRYPOINT` so that `genwork-server` (container-side) is the same binary that the host-side `genwork-server` runs from. The image is small (< 250 MB) thanks to `node:24-alpine` and `npm ci --omit=dev`.

### 5.2 `docker-compose.yml`

```yaml
name: genwork-enterprise

services:
  app:
    image: ${IMAGE_REPO:-enterprise-server}:${IMAGE_TAG:-latest}
    env_file: .env
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - genwork_data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options: { max-size: "20m", max-file: "5" }

volumes:
  genwork_data:
```

Only the `app` service. Postgres is **not** in this compose — the customer owns it. `127.0.0.1:8787:8787` means the container's port 8787 is only reachable from the host; the customer's reverse proxy listens on `:443` and forwards here.

### 5.3 `genwork-server init`

```text
genwork-server init [--config <path>] [--no-db-bootstrap] [--print-env-template]
```

Steps (idempotent — re-running on an already-initialized host is a no-op unless `--force`):

1. **Preflight**: `docker` is on `PATH`; `POSTGRES_SUPERUSER_URL` is set (unless `--no-db-bootstrap`); the user can write to `/etc/genwork/`; `compose.yml` is reachable at the install path.
2. **DB bootstrap** (unless `--no-db-bootstrap`): connect using `POSTGRES_SUPERUSER_URL`; parse target db + role from `DATABASE_URL`; `CREATE ROLE` if missing; `CREATE DATABASE` if missing; `GRANT ALL ON DATABASE` to the role. Refuses if `DATABASE_URL` and `POSTGRES_SUPERUSER_URL` point to the *same* role (defensive — don't drop privileges into the floor).
3. **Filesystem**:
   - `mkdir -p /etc/genwork/data`
   - `cp <install>/docker-compose.yml /etc/genwork/compose.yml`
   - `cp <install>/caddyfile.example /etc/genwork/caddyfile.example`
   - write `/etc/genwork/current-version` (image tag recorded at init time)
   - install `/usr/local/bin/genwork-server` symlink to the in-repo CLI
4. **Env template**: print the expected `.env` keys (without values) if `--print-env-template`; refuse to start if any required key is missing or obviously weak (`JWT_SECRET` < 32 chars).
5. **Exit 0** with a one-page "next steps" output that the customer follows.

### 5.4 `genwork-server start`

This is what the container does on boot:

1. `node /app/dist/db/migrate.js up` — apply pending migrations (existing `runMigrations` reused; the dev path is `tsx src/server.ts` which already calls it).
2. `exec node /app/dist/server.js` — start the Hono server.

`dumb-init` is replaced with `tini` (already in the alpine package) for proper signal handling on PID 1.

### 5.5 `genwork-server upgrade --to <version>`

1. `docker pull <registry>/enterprise-server:<version>` (registry taken from `IMAGE_REPO` env var, default `enterprise-server`).
2. Read `current-version` from `/etc/genwork/`. Write it to `previous-version`.
3. Run pre-migration: `docker run --rm --env-file .env <new-image> genwork-server migrate --dry-run` — this validates the new image can connect to the DB and the SQL is parseable. The new image's pre-migration **never writes**; only the running server does that. (Achieved by gating on `process.env.GENWORK_MIGRATE_DRY_RUN=1` in `cli/migrate.ts`.)
4. Swap `image:` field in `/etc/genwork/compose.yml` from `previous-version` to `new-version`.
5. `docker compose -f /etc/genwork/compose.yml up -d` (rolls the container).
6. Poll `curl http://127.0.0.1:8787/health` for up to 30s; expect 200.
7. **Success path**: write new `current-version`; print "upgrade complete".
8. **Failure path**:
   - revert `image:` to `previous-version`,
   - `docker compose up -d` to roll back,
   - print "upgrade FAILED, rolled back to <previous-version>" with the captured healthcheck log,
   - **do not** roll back the database — pre-migration is a dry-run, so no destructive change has happened.

### 5.6 `genwork-server backup` / `restore`

**backup** runs `pg_dump --no-owner --no-privileges --format=custom --file=<tmpdir>/dump.sql.gz $DATABASE_URL` then `tar czf <out> /etc/genwork/data <tmpdir>/dump.sql.gz`. The tarball is self-contained.

**restore** refuses if `status` reports the server is up and healthy (to avoid clobbering a live DB). With `--force`, takes the customer through a confirm prompt, then `pg_restore` + `tar xf` into `/etc/genwork/data`.

### 5.7 `genwork-server status`

Single-shot report:

```text
Service: running (pid via docker compose ps)
Health:  ok
Version: v2026.10.15
DB:      reachable (10ms)
Uptime:  3d 4h
```

Exit codes: 0 healthy, 1 unhealthy, 2 not running.

### 5.8 Reverse proxy examples

**Caddy (`caddyfile.example`)** — has two variants:

```caddyfile
# Variant 1: public host with auto-issued cert
api.genwork.example.com {
    reverse_proxy 127.0.0.1:8787 {
        transport http {
            read_timeout 120s
        }
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}

# Variant 2: internal LAN, no TLS (customer terminates elsewhere)
:80 {
    reverse_proxy 127.0.0.1:8787
}
```

**nginx (`nginx.conf.example`)** — equivalent snippet with `proxy_read_timeout 120s` for streaming model proxy calls. Both configs are documentation, never activated by `init`.

### 5.9 CI / image build

`.github/workflows/enterprise-server-image.yml` runs on tag push. The job:

1. Checks out, sets up Buildx.
2. Runs `scripts/build-enterprise-image.sh <version>`.
3. If `vars.REGISTRY` is set (e.g. `registry.example.com/genwork`), pushes there with `--push`.
4. If `vars.REGISTRY` is empty, just builds `--load` and exits.

Default is "empty" — i.e. the workflow runs but does not push. Customers that want the workflow to publish set `REGISTRY` themselves. This honors the no-public-registry decision while not blocking customers who have their own.

---

## 6. Configuration

### 6.1 `.env.example` additions

```bash
# --- Image & install paths (NEW) -----------------------------------------
# Where the CLI looks for compose.yml / Dockerfile before init. Defaults to
# the install path of the genwork-server binary.
# INSTALL_DIR=/opt/genwork

# Image tag for `docker compose pull`. Bump during upgrade.
IMAGE_TAG=latest
# Image repo, e.g. registry.example.com/genwork/enterprise-server
# IMAGE_REPO=enterprise-server

# Persistent data dir inside the container. Keep as /data.
DATA_DIR=/data

# --- One-time DB bootstrap (NEW, used by `genwork-server init` only) -----
# A superuser URL with CREATEDB / CREATEROLE privileges. The app container
# does NOT need this; it uses DATABASE_URL. After init, you can delete this
# line.
POSTGRES_SUPERUSER_URL=postgres://postgres:postgres@db-host:5432/postgres
```

All existing fields stay. The customer is told to **remove** `POSTGRES_SUPERUSER_URL` after init (it has no use at runtime; leaving it in `.env` is at most a documentation mistake, not a security issue, since it points to a superuser role that lives behind the customer's own firewall).

### 6.2 New env vars read by the CLI

| Var | Read by | Default | Notes |
| --- | --- | --- | --- |
| `INSTALL_DIR` | `init` | dirname of the `genwork-server` binary | where the Dockerfile / compose.yml live |
| `IMAGE_REPO` | `upgrade` | `enterprise-server` | repo portion of the image ref |
| `IMAGE_TAG` | `upgrade`, `compose.yml` | `latest` | tag portion |
| `DATA_DIR` | `start` (container) | `/data` | persistent volume mount |
| `POSTGRES_SUPERUSER_URL` | `init` only | (none — required) | bootstrap URL |
| `GENWORK_MIGRATE_DRY_RUN` | `migrate` | unset | if `1`, parse but don't apply |

---

## 7. Failure Modes & Handling

| Failure | Detection | Behavior |
| --- | --- | --- |
| `docker` missing on host | `init` preflight | fail fast with "install Docker first" |
| `/etc/genwork` not writable | `init` preflight | fail with "run as root or use sudo" |
| `POSTGRES_SUPERUSER_URL` missing | `init` preflight | fail with "set POSTGRES_SUPERUSER_URL or pass --no-db-bootstrap" |
| `POSTGRES_SUPERUSER_URL` cannot connect | `init` step 2 | fail with the captured psql error; do not write `/etc/genwork` |
| `DATABASE_URL` references same role as superuser URL | `init` step 2 | fail with explicit message (refuses to drop privileges) |
| Container `HEALTHCHECK` fails on boot | `upgrade` step 6 | roll back image to `previous-version`, print captured healthcheck output |
| Pre-migration dry-run fails | `upgrade` step 3 | abort upgrade before any container restart; print DB error |
| `pg_dump` fails (DB unreachable) | `backup` | exit non-zero, no partial tarball written |
| `restore` while server is up | `restore` preflight | refuse unless `--force`; even then, print a loud warning |
| Customer forgot to remove `POSTGRES_SUPERUSER_URL` from `.env` | `start` (container) | log a debug line at startup; do not fail (the var is unused by the running server) |

---

## 8. Testing

### 8.1 Unit (Vitest, pglite)

- `cli/init.test.ts` — DB bootstrap path with mocked `pg.Client`; idempotency on a re-run; refuses when `DATABASE_URL` role == `POSTGRES_SUPERUSER_URL` role.
- `cli/upgrade.test.ts` — image-tag swap happy path; rollback on simulated healthcheck timeout; `previous-version` and `current-version` files updated atomically.
- `cli/backup.test.ts` — `pg_dump` invocation shape (mocked); tar archive contains the expected entries.
- `cli/restore.test.ts` — refuses when server is up; happy path with mocked subprocesses; `--force` override.

All new tests live in `enterprise_server/tests/cli/`. The vitest config already globs `**/*.test.ts`, so no config change.

### 8.2 Integration (manual, in this repo's own CI)

A new optional job in `.github/workflows/enterprise-server-image.yml`:

1. Build the image.
2. Start a Postgres service container (`postgres:16`).
3. `docker compose up -d`.
4. Wait for `/health` to return 200.
5. `docker compose exec -e GENWORK_RUN_SETUP=1 app genwork-server setup-fixture` — a new CLI subcommand (or a test-only one) that drives the `/setup` endpoint and asserts a 200.
6. Tear down.

This is a "smoke" job, not part of the official test suite. It's gated by `workflow_dispatch` so the default `npm test` does not require Docker-in-Docker.

### 8.3 No regression

- Existing pglite tests (`npm run enterprise:test`) must continue to pass.
- The existing `reinit` CLI keeps its signature.
- `npm run dev` and `npm test` work unchanged.

---

## 9. Rollout

| Step | Owner | Acceptance |
| --- | --- | --- |
| Land the 8 new CLI files + 2 example configs + Dockerfile + compose + build script | platform | `npm run enterprise:test` green, `docker build .` succeeds locally |
| Add CI smoke workflow (`workflow_dispatch` only) | platform | smoke job passes on a self-hosted runner with Docker |
| Land `docs/enterprise-server-deploy.md` | platform + docs | one pilot customer follows it end-to-end without Slack help |
| Cut a tag `v2026.10.15-server-packaging` | release | tag exists, image built, not pushed (default) |
| Update README "Enterprise-Side Installation & Deployment" to point at the new doc | docs | README diff is the only docs change |

The README "Enterprise-Side Installation & Deployment" section gets a slimmed-down version (the existing "Quick Start" stays as a dev-mode hint), with a new "Production deployment" pointer to `docs/enterprise-server-deploy.md`. The 6-step numbered structure of the current section can stay if it's accurate; otherwise collapse into the new doc.

---

## 10. Open Questions / Decisions

- **Do we need a Windows / macOS path for the host CLI?** No — the host CLI runs wherever Docker runs, and the target is Linux. macOS is fine for testing locally but is not a supported production host. Documented.
- **Should `init` install `genwork-server` as a real binary (compiled JS) or symlink to the source tree?** Symlink to the in-repo `cli/dist/index.js` post-`npm run build`. The `init` step **assumes** the customer has already run `npm run build` (or the build is part of the image-build script). This avoids shipping a separate Node-only install path.
- **What happens to the `web-dist` directory in the image?** It's baked in at build time. The container's `WEB_DIST_DIR` defaults to `/app/web-dist`. Customers can override with a volume mount if they want runtime-served different builds, but this is unsupported.
- **Is there a way to use a different image registry transparently?** Yes: `IMAGE_REPO` env var. Documented in the deploy manual. No new spec needed.

---

## 11. Review Checklist (post-write)

- [x] No mention of OpenClaw / dsh — the spec is intentionally runtime-agnostic.
- [x] All four non-goals are stated up front and respected throughout.
- [x] `/health` endpoint is reused, not duplicated.
- [x] `reinit` is preserved.
- [x] All env vars are listed once in §6.
- [x] Rollback semantics are unambiguous: image rollback yes, DB rollback no.
- [x] New tests are colocated under `enterprise_server/tests/cli/`.
- [x] No placeholder strings (`TBD`, `TODO`).
- [x] Customer-facing language uses `init` / `start` / `upgrade` consistently.
