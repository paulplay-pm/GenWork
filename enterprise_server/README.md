# GenWork Enterprise Server

Multi-tenant backend API + admin console for GenWork's enterprise deployment.
Hosts the JWT-authed REST API for desktop clients (login, model proxy, audit,
usage, policy enforcement) and serves the admin SPA at `/`.

## Requirements

- Node.js `>=24.13` (matches `@types/node`); `tsx` ships with the project.
- PostgreSQL — local install, Docker container, or any reachable Postgres 14+.
  `pglite` is **only** for tests; production must use a real DB.
- First-run secrets: `JWT_SECRET` (≥32 chars) and `GENWORK_VAULT_MASTER_KEY`
  (32-byte base64 string) for encrypting provider keys at rest.

## Install

```bash
cd enterprise_server
npm install
```

## Dev quickstart

The first run goes entirely through the SPA — no CLI is required.

```bash
# 1. Bring up Postgres (Docker quickstart; or any reachable Postgres 14+)
docker run -d --name genwork-pg \
  -e POSTGRES_USER=genwork \
  -e POSTGRES_PASSWORD=genwork \
  -e POSTGRES_DB=genwork \
  -p 5433:5432 \
  postgres:16
# On macOS, Docker Desktop's backend binds 5432 on the host, so we map to
# host port 5433 to avoid the conflict.

# 2. Copy and fill the env template
cp .env.example .env

# 3. Generate the two required secrets and paste them into .env
echo "JWT_SECRET=$(openssl rand -hex 32)"                >> .env
echo "GENWORK_VAULT_MASTER_KEY=$(openssl rand -base64 32)" >> .env

# 4. Start the server (loads .env automatically, runs migrations)
npm run dev

# 5. Open the admin console and walk the in-browser setup wizard
open http://localhost:8787/setup
```

The wizard asks for an organization name (e.g. `Acme Corp`). The server
generates a random `org-<8 hex>` id, mints a one-time invite code, and
lets you create the first super-admin. Once the first super-admin is
created, the entire `/api/setup/*` surface is permanently closed (HTTP
410). To re-open it, run `npm run reinit`.

### First-run: create the super admin

`http://localhost:8787/setup` walks you through:

1. Enter an organization name (e.g. `Acme Corp`).
2. Click **Continue** — the server creates the org, mints an invite
   code, and shows it on the next screen.
3. Pick a username (e.g. `admin`) and a password (≥8 chars).
4. Click **Create admin** — the SPA receives a signed JWT and lands on
   the Dashboard.

Subsequent admins can be invited via `/orgs/users` → `+ Add user` by the
super-admin or any user holding the `org_admin` role.

### Sign in

`http://localhost:8787/login` (or `http://localhost:5173/login` during
SPA dev). Sign-in uses the **organization name** (not the id):

- **Organization name**: e.g. `Acme Corp`
- **Username**: `admin`
- **Password**: `Admin#2026`

Secrets are read once at startup. Rotating `JWT_SECRET` invalidates all
existing sessions; rotating `GENWORK_VAULT_MASTER_KEY` makes all stored
provider keys unreadable (would require re-adding every provider key).

## Vault master key

The vault crypto layer reads `GENWORK_VAULT_MASTER_KEY` from the
environment. It must be a 32-byte base64 string. Generate one with
`openssl rand -base64 32` and paste it into `.env`. The server refuses
to start if it is missing.

## Running tests

```bash
# Server tests (uses pglite — in-process Postgres via WASM, no Postgres required)
npm test

# Web (SPA) tests — vitest in jsdom
npm run web:test
```

The web test command must be run from the `web/` directory unless you use
the `npm run web:test` shortcut.

## Logs and operational notes

- The server logs to stdout. In dev (`npm run dev`) `tsx` prints file-change
  restart notices.
- All SQL migrations are idempotent: re-running `init` against an existing
  DB is safe (the `_migrations` ledger skips applied files).
- Two-tier role model: `super_admin` is a system flag stored in
  `users.extra_roles`. The four org-scoped roles are free-form strings
  (`org_admin`, `model_admin`, `policy_admin`, `auditor`) assignable in
  `extra_roles`. Any role string works — `requireCapability(role)` checks
  `roles ⊇ {role}` OR `roles ⊇ {super_admin}`.
- Provider keys are stored encrypted in `provider_keys.api_key_encrypted`
  (AES-256-GCM, key derived from `GENWORK_VAULT_MASTER_KEY`). The
  `GET /admin/provider-keys` endpoint returns metadata only — never the
  plaintext.

## Layout

```
enterprise_server/
├── src/
│   ├── server.ts                # Hono app + node:http listen
│   ├── auth/                    # JWT, password hashing, requireCapability middleware
│   ├── cli/reinit.ts            # Re-open /api/setup/* after first admin created
│   ├── db/                      # Pool, migrations, testDb (pglite)
│   ├── db/migrations/           # Idempotent SQL migrations, applied via _migrations ledger
│   ├── models/                  # Catalog, token usage, app releases
│   ├── org/                     # Departments, positions, user CRUD
│   ├── vault/                   # Provider-key AES-GCM encrypt/decrypt
│   ├── proxy/                   # /proxy/openai|anthropic|deepseek upstream + quota + audit
│   ├── audit/                   # Audit log writer + reader
│   ├── policies/                # MCP / skill policies
│   ├── setup/                   # Invitation code service
│   ├── archives/                # Org-level archives (server-side storage)
│   ├── shared/                  # Cross-process constants (AuditAction enum, etc.)
│   ├── lib/                     # Cross-cutting helpers
│   └── routes/                  # HTTP handlers (auth, admin/*, proxy, audit)
├── web/                         # Admin SPA (Vite + React 19 + TanStack Query + Zustand)
├── web-dist/                    # Built SPA (output of npm run web:build)
├── tests/                       # vitest specs (pglite)
└── package.json
```
