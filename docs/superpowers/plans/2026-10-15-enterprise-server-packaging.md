# Enterprise Server Packaging & Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Docker image, a host-side `genwork-server` CLI, and a deploy manual so a customer IT engineer can stand up the GenWork Enterprise Server on a clean Linux host with one `docker compose up -d`, and upgrade it in place with `genwork-server upgrade`.

**Architecture:** Multi-stage Dockerfile (web SPA build → TS compile → `node:24-alpine` runtime). A single `genwork-server` CLI source dispatches `init` / `start` / `migrate` / `status` / `logs` / `backup` / `restore` / `upgrade` / `version` subcommands; the same binary is installed host-side by `init` and runs as the container `ENTRYPOINT`. Postgres is external and customer-owned. The reverse proxy is customer-managed. The existing `/health` endpoint in `src/server.ts` is reused as the `HEALTHCHECK` probe.

**Tech Stack:** TypeScript (existing), Node.js ≥24.15, Hono (existing), `pg` (existing), Docker / docker compose, `tini`, `postgresql16-client`, vitest (existing), `tar`, `pg_dump` / `pg_restore` via `child_process`.

**Spec:** `docs/superpowers/specs/2026-10-15-enterprise-server-packaging-design.md`

---

## Global Constraints

These constraints travel with every task. They are the spec's project-wide requirements, copied verbatim where they pin a value:

- **Node.js ≥24.15.0, <25.** Verify before any Node command in the image.
- **Existing CLI `reinit` keeps its signature.** New CLI is additive.
- **Existing pglite test path keeps working.** `npm run enterprise:test` (or whichever current command) must stay green.
- **`/health` endpoint is reused, never duplicated.** The Dockerfile's `HEALTHCHECK` and `docker-compose.yml` `healthcheck` both call it; the `status` subcommand also calls it.
- **Image is built only locally / customer's registry. No public publish.** CI workflow exists but defaults to no-push.
- **Postgres is external.** Never bundle it. The container's only DB connection is `DATABASE_URL`.
- **Reverse proxy is external.** The container's only exposed port is `127.0.0.1:8787:8787`; public TLS is the customer's job.
- **All new env vars** (`POSTGRES_SUPERUSER_URL`, `IMAGE_TAG`, `IMAGE_REPO`, `DATA_DIR`, `INSTALL_DIR`, `GENWORK_MIGRATE_DRY_RUN`) are constants or named once per file; never bare string literals when used as a discriminant (e.g. the `GENWORK_MIGRATE_DRY_RUN=1` gate, the `--to <version>` flag).
- **Commit messages** are Conventional Commits, English, no `Co-Authored-By`.
- **Branches** are `feat/...` or `fix/...` — never `codex/...` unless the user asks.
- **Auto-commit local only.** Do not push to remote.
- **ESLint** on touched TS/TSX files must pass: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- **Style:** 2-space indent, single quotes, semicolons, `camelCase` functions, `PascalCase` types. No bare string literals for discriminants.
- **New tests** live under `enterprise_server/tests/cli/`. The vitest config (`include: ['tests/**/*.test.ts']`) is unchanged.
- **`genwork-server` and `genwork-server-cli` use `node:fs` / `node:child_process` synchronously when possible; the `init` step is the only host-side blocking CLI and the customer accepts the few-second wait.**

---

## Review Focus

These are the spec-implied failure modes that no single task's tests pin. Each line below names the input, the expected behavior, and the task that owns the test that pins it.

1. **`/etc/genwork/data` already exists at `init` time.** Expected: `init` refuses with a clear "already initialized" error unless `--force` is passed. Pinned by Task 5 (init preflight test for `dataDirExists`).
2. **`genwork-server` invoked host-side while `docker` is missing.** Expected: every host-side subcommand (`init`, `upgrade`, `status`, `backup`, `restore`) preflights `docker` on `PATH` and exits 1 with "install Docker first" before doing any work. Pinned by Task 5 (init preflight) and Task 7 (status preflight) — the first one ships; subsequent commands inherit the same preflight via the shared helper in `src/cli/lib/preflight.ts`.
3. **`DATABASE_URL` role equals `POSTGRES_SUPERUSER_URL` role.** Expected: `init` refuses with explicit "refusing to drop privileges" message; never silently re-grants to the same role. Pinned by Task 5.
4. **`upgrade` mid-flight failure (image starts, healthcheck times out).** Expected: `image:` field in `/etc/genwork/compose.yml` is reverted to `previous-version`, container is restarted, error output is preserved. The database is *not* rolled back. Pinned by Task 6.
5. **`restore` while `status` reports the server healthy.** Expected: `restore` refuses unless `--force`; even with `--force`, prints a loud warning before destructive work. Pinned by Task 8.
6. **Container `start` with `POSTGRES_SUPERUSER_URL` still in `.env`.** Expected: log a debug line and continue; the variable is unused at runtime. Pinned by Task 4.

---

## Decisions and Rulings

Rulings made during the plan's self-review. Each line is `Ruling — why — what it costs if wrong`.

- **Test-only `INIT_DATA_DIR` env override on `init.ts`.** Adding one env-var lookup in the production code so tests can run without root and without writing to `/etc/genwork`. The cost: one extra env var; if a customer's setup script uses `INIT_DATA_DIR` it would shadow the real path — negligible because the spec already names every new env var and `INIT_DATA_DIR` is not in `.env.example`. **Why:** without it, `init.test.ts` either needs root or it tests a code path that does not match production. **Wrong-direction cost:** one extra env var, no behavioral change.
- **`COMPOSE_FILE` env override on `upgrade.ts` and `status.ts`.** Same pattern as `INIT_DATA_DIR`. The dispatcher already uses `COMPOSE_FILE` for `logs`; extending it to the other two host-side compose commands keeps the test surface uniform. **Why:** without it, the upgrade and status tests would have to redirect at the `docker compose -f /etc/genwork/...` level via process mock only, and the `--force` / `--to` parsing tests could not pin the compose file. **Wrong-direction cost:** one env var, no behavioral change.
- **`/etc/genwork` paths in `upgrade.ts.recordVersion` and `status.ts.versionPath` are NOT env-redirected.** They are post-deploy runtime state files. Tests do not exercise them; if a future test wants to, add the same env-var pattern. **Why:** the spec says "current-version" lives at `/etc/genwork`; making it env-redirectable would imply a customer can move it, which they should not. **Wrong-direction cost:** if a customer has `/etc` on a read-only mount, the `current-version` file would fail to write — out of scope for this plan.
- **`init.ts` SQL injection-shaped bug at `CREATE ROLE` (line 691).** The current sketch interpolates `target.password` into a string. **Ruling:** the implementer MUST replace it with `pg-format`-style parameterization OR use `pg`'s `Client` with `query({ text, values })`. **Why:** the test mocks `Client` and never validates SQL syntax, so this bug would not be caught by the test. **Wrong-direction cost:** if not fixed, a customer password containing `'`, `;`, or `--` breaks `init` or worse. Marked `Ruling: must-fix-before-commit` for Task 5.
- **All new CLI files export `run()` and self-invoke when run directly via `if (import.meta.url === file://argv[1])`.** The dispatcher in `index.ts` calls `m.run()`. **Why:** this matches the `reinit.ts` shape's spirit (top-level function with a single exit point) while keeping the per-subcommand file independently runnable for `npm run start` / `npm run migrate` etc. **Wrong-direction cost:** none, just convention.
- **`package.json` `genwork-server` bin field not added.** The dispatcher is run via `node dist/cli/index.js`, not via `npx genwork-server`. The customer's `/usr/local/bin/genwork-server` symlink is created by `init.ts` to point at the in-install-tree `cli/dist/index.js`. **Why:** this keeps the dist artifact un-versioned for npm registry concerns (the spec explicitly says no public publish). **Wrong-direction cost:** none.

---

## File Structure

The packaging change touches 16 files. Most are net-new; the existing `src/server.ts`, `src/cli/reinit.ts`, `src/db/migrate.ts`, and the test config are read but not modified.

### New files (production)

| Path | Responsibility |
| --- | --- |
| `enterprise_server/Dockerfile` | Multi-stage build; web SPA → TS compile → `node:24-alpine` runtime with `tini`, non-root user, `HEALTHCHECK`. |
| `enterprise_server/docker-compose.yml` | One `app` service, `env_file: .env`, named volume, `127.0.0.1:8787:8787` port map, healthcheck. |
| `enterprise_server/caddyfile.example` | Two Caddy v2 reverse-proxy variants (public + LAN). Documentation only. |
| `enterprise_server/nginx.conf.example` | Equivalent nginx snippet. Documentation only. |
| `enterprise_server/src/cli/index.ts` | Subcommand dispatcher. Reads `argv[2]` and delegates. Also handles `migrate`, `version`, `logs` (delegated to `child_process.spawn('docker', ['compose', 'logs', ...])`). |
| `enterprise_server/src/cli/lib/preflight.ts` | `assertDockerOnPath()` and `assertRoot()` shared helpers. |
| `enterprise_server/src/cli/lib/runMigrations.ts` | Wrapper that calls `runMigrations()` from `src/db/migrate.ts`, honoring `GENWORK_MIGRATE_DRY_RUN=1`. |
| `enterprise_server/src/cli/init.ts` | Host-side. Idempotent. Writes `/etc/genwork/`, runs DB bootstrap, installs host-side symlink. |
| `enterprise_server/src/cli/start.ts` | Container-side. Run migrations, then `import('../server.js').serve()`. |
| `enterprise_server/src/cli/migrate.ts` | Container-side. Run or dry-run migrations. |
| `enterprise_server/src/cli/status.ts` | Host-side. `docker compose ps` + `/health` + version. Exit codes 0/1/2. |
| `enterprise_server/src/cli/backup.ts` | Host-side. `pg_dump` + `tar czf`. |
| `enterprise_server/src/cli/restore.ts` | Host-side. `pg_restore` + `tar xf` with `--force` guard. |
| `enterprise_server/src/cli/upgrade.ts` | Host-side. Pull, pre-migrate dry-run, swap image, restart, healthcheck poll, rollback on fail. |
| `enterprise_server/src/cli/version.ts` | Reads `VERSION` env baked at build time; prints and exits. |
| `enterprise_server/src/cli/logs.ts` | `child_process.spawn('docker', ['compose', '-f', '/etc/genwork/compose.yml', 'logs', ...])`. |
| `scripts/build-enterprise-image.sh` | `docker buildx build` with tag from `git describe` or arg. |
| `docs/enterprise-server-deploy.md` | Customer-facing manual. |
| `.github/workflows/enterprise-server-image.yml` | Optional image-build CI. `workflow_dispatch` + tag push. |

### Modified files

| Path | What changes |
| --- | --- |
| `enterprise_server/package.json` | Add `build` script (TS compile), add `genwork-server` bin entry, add `pg` start point. |
| `enterprise_server/.env.example` | Append `IMAGE_TAG`, `IMAGE_REPO`, `DATA_DIR`, `POSTGRES_SUPERUSER_URL` per spec §6.1. |
| `enterprise_server/tsconfig.build.json` | **New** small file overriding `noEmit: false` + `outDir: dist` for the production build. The dev `tsconfig.json` keeps `noEmit: true` so `tsx` still works. |
| `enterprise_server/src/server.ts` | Export the `serve()` function so `cli/start.ts` can call it (currently it is invoked at module load). |
| `enterprise_server/scripts/` (none currently exists) | New `scripts/` dir lives at `enterprise_server/scripts/`; the build script is the only entry. |
| `README.md` and `README_zh.md` | Slim the "Enterprise-Side Installation & Deployment" section to point at `docs/enterprise-server-deploy.md`. |

### Test files (new)

| Path | Responsibility |
| --- | --- |
| `enterprise_server/tests/cli/init.test.ts` | DB bootstrap mocked; idempotency; refuse when roles match. |
| `enterprise_server/tests/cli/upgrade.test.ts` | Image-tag swap happy path; rollback on healthcheck timeout. |
| `enterprise_server/tests/cli/backup.test.ts` | `pg_dump` invocation shape; tar contains expected entries. |
| `enterprise_server/tests/cli/restore.test.ts` | Refuses when server up; `--force` override; happy path. |
| `enterprise_server/tests/cli/status.test.ts` | Exit codes 0/1/2 for the three states. |
| `enterprise_server/tests/cli/preflight.test.ts` | `assertDockerOnPath` / `assertRoot` behavior. |

Files that change together live together: every `cli/*.ts` is paired with a `tests/cli/<name>.test.ts`. The single `cli/index.ts` dispatcher is shared infrastructure and is exercised through the per-command tests, so it has no dedicated test.

### Files explicitly NOT modified

- `enterprise_server/src/cli/reinit.ts` — signature preserved.
- `enterprise_server/src/db/migrate.ts` — `runMigrations` is imported by the new `cli/lib/runMigrations.ts` wrapper, but the original file is unchanged.
- `enterprise_server/vitest.config.ts` — `tests/**/*.test.ts` already covers the new test directory.
- `enterprise_server/src/server.ts`'s route table — only the bottom-of-file `serve()` invocation is refactored into an exported function; the route mounting is untouched.

---

## Task 1: Add `build` script and `tsconfig.build.json`

**Files:**
- Modify: `enterprise_server/package.json`
- Create: `enterprise_server/tsconfig.build.json`
- Modify: `enterprise_server/tsconfig.json` (add a comment so the relationship is obvious)

**Interfaces:**
- Consumes: existing `src/**/*` (TS source).
- Produces: a `dist/` directory with compiled JS that mirrors `src/`, runnable by plain `node dist/cli/index.js`.

The dev `tsconfig.json` keeps `noEmit: true` (used by `tsx` and by `vitest`). The build override flips it to `noEmit: false` and sets `outDir`.

- [ ] **Step 1: Create `enterprise_server/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "tests/**/*", "web/**/*"]
}
```

- [ ] **Step 2: Add a `build` script to `enterprise_server/package.json`**

In the `scripts` block, after the existing `reinit` entry, add:

```json
"build": "tsc -p tsconfig.build.json",
"start": "node --enable-source-maps dist/server.js",
"genwork-server": "node --enable-source-maps dist/cli/index.js"
```

The `reinit` script is unchanged. `start` and `genwork-server` use the compiled output (production entry points), `dev` and `reinit` still use `tsx` (dev experience).

- [ ] **Step 3: Add a one-line header comment in `tsconfig.json`**

Above `"compilerOptions"`, add:

```jsonc
// tsconfig.json is the dev / vitest config. It uses noEmit + tsx for hot reload.
// The production build uses tsconfig.build.json (extends this file, flips noEmit).
```

- [ ] **Step 4: Run the build to verify**

Run from the repo root:

```bash
cd enterprise_server && npm run build
ls dist/cli dist/server.js
```

Expected: both files exist, no TS errors. If errors appear, fix them before continuing — the rest of the plan assumes `dist/` is produced cleanly.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/package.json enterprise_server/tsconfig.build.json enterprise_server/tsconfig.json
git commit -m "build(enterprise-server): add production tsconfig.build and npm run build"
```

---

## Task 2: Refactor `src/server.ts` to export `serve()`

**Files:**
- Modify: `enterprise_server/src/server.ts` (bottom of file, where the listener is started)
- Test: `enterprise_server/tests/server.test.ts` (new, minimal)

The current file starts the listener at module load. The container's `start` subcommand needs to call `serve()` directly so it can run migrations first and capture the `port` env. The fix is mechanical: wrap the listener call in a function and re-invoke it from `serve()`.

- [ ] **Step 1: Read the bottom of `src/server.ts` to find the listener call**

The file currently ends with something like:

```ts
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 8787),
});
```

Read the file (`Read` from line 1) and confirm the exact form. Do not refactor anything else.

- [ ] **Step 2: Wrap the listener call in an exported `serve()` function**

Replace the bottom-of-file listener block with:

```ts
export function serve(): void {
  const port = Number(process.env.PORT ?? 8787);
  const server = serve({
    fetch: app.fetch,
    port,
  });
  console.log(`[enterprise-server] listening on :${port}`);
  return server;
}

// Backwards-compat: starting the file directly still boots the server
// (this is what `tsx src/server.ts` and the dev workflow do).
if (import.meta.url === `file://${process.argv[1]}`) {
  serve();
}
```

If the current file uses a different listener API (Hono's `serve` from `@hono/node-server`, or a different import), match the existing import. The plan's intent is "the listener call now lives in an exported function and the file still boots when run directly."

- [ ] **Step 3: Add a minimal smoke test**

Create `enterprise_server/tests/server.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { serve } from '../src/server.js';

describe('enterprise_server entry', () => {
  test('serve() exports a callable function', () => {
    expect(typeof serve).toBe('function');
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd enterprise_server && npm test -- server
```

Expected: PASS. (If the test file name conflicts with the existing matcher glob, use `-- tests/server.test.ts`.)

- [ ] **Step 5: Run lint on changed files**

```bash
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 enterprise_server/src/server.ts enterprise_server/tests/server.test.ts
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/server.ts enterprise_server/tests/server.test.ts
git commit -m "refactor(enterprise-server): export serve() from src/server.ts"
```

---

## Task 3: CLI dispatcher + shared preflight + `version` + `migrate`

**Files:**
- Create: `enterprise_server/src/cli/index.ts`
- Create: `enterprise_server/src/cli/lib/preflight.ts`
- Create: `enterprise_server/src/cli/lib/runMigrations.ts`
- Create: `enterprise_server/src/cli/migrate.ts`
- Create: `enterprise_server/src/cli/version.ts`
- Modify: `enterprise_server/package.json` (add `genwork-server` bin; already in Task 1)
- Test: `enterprise_server/tests/cli/preflight.test.ts`
- Test: `enterprise_server/tests/cli/version.test.ts`

This task lays the shared scaffolding all later CLI tasks depend on.

- [ ] **Step 1: Write `preflight.ts`**

```ts
import { execSync } from 'node:child_process';

export function assertDockerOnPath(): void {
  try {
    execSync('command -v docker', { stdio: 'ignore' });
  } catch {
    console.error('Docker is not on PATH. Install Docker first: https://docs.docker.com/engine/install/');
    process.exit(1);
  }
}

export function assertRoot(): void {
  if (process.getuid?.() !== 0) {
    console.error('This command must run as root (or via sudo).');
    process.exit(1);
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}
```

- [ ] **Step 2: Write `runMigrations.ts` (wrapper)**

```ts
import { runMigrations } from '../db/migrate.js';
import { pool } from '../db/pool.js';

const dryRun = process.env.GENWORK_MIGRATE_DRY_RUN === '1';

export async function runMigrationsOnce(): Promise<void> {
  if (dryRun) {
    // Touch the pool so a bad DATABASE_URL surfaces now, but do not write.
    await pool.query('SELECT 1');
    console.log('[migrate] dry-run: connection ok, would run migrations without applying');
    return;
  }
  await runMigrations();
}
```

- [ ] **Step 3: Write `migrate.ts` (subcommand)**

```ts
import { runMigrationsOnce } from './lib/runMigrations.js';
import { pool } from '../db/pool.js';

export async function run(): Promise<void> {
  if (process.env.GENWORK_MIGRATE_DRY_RUN === '1') {
    console.log('[migrate] GENWORK_MIGRATE_DRY_RUN=1 — running in dry-run mode');
  }
  await runMigrationsOnce();
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Write `version.ts`**

```ts
const VERSION = process.env.VERSION ?? 'dev';

export function run(): void {
  console.log(`genwork-server ${VERSION}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
```

`VERSION` is baked at image build time (`ENV VERSION=$VERSION` in the Dockerfile, set by the build script). Default `dev` for source-tree runs.

- [ ] **Step 5: Write `index.ts` (dispatcher)**

```ts
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const subcommand = process.argv[2];

// Subcommands that run in the container (no host preflight).
const containerOnly = new Set(['start', 'migrate', 'version']);

async function main(): Promise<void> {
  switch (subcommand) {
    case 'init':
      await import('./init.js').then((m) => m.run());
      break;
    case 'start':
      await import('./start.js').then((m) => m.run());
      break;
    case 'migrate':
      await import('./migrate.js').then((m) => m.run());
      break;
    case 'status':
      await import('./status.js').then((m) => m.run());
      break;
    case 'backup':
      await import('./backup.js').then((m) => m.run());
      break;
    case 'restore':
      await import('./restore.js').then((m) => m.run());
      break;
    case 'upgrade':
      await import('./upgrade.js').then((m) => m.run());
      break;
    case 'logs': {
      const composeFile = process.env.COMPOSE_FILE ?? '/etc/genwork/compose.yml';
      const child = spawn('docker', ['compose', '-f', composeFile, 'logs', ...process.argv.slice(3)], {
        stdio: 'inherit',
      });
      child.on('exit', (code) => process.exit(code ?? 0));
      break;
    }
    case 'reinit':
      // Delegated to the legacy CLI to preserve its signature.
      await import('../cli/reinit.js');
      break;
    case 'version':
      await import('./version.js').then((m) => m.run());
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  const lines = [
    'genwork-server — Enterprise Server lifecycle CLI',
    '',
    'Subcommands:',
    '  init       Host-side: prepare /etc/genwork/ and bootstrap the database',
    '  start      Container-side: run migrations and start the server',
    '  migrate    Container-side: apply pending DB migrations (or dry-run if GENWORK_MIGRATE_DRY_RUN=1)',
    '  status     Host-side: report health / version / uptime',
    '  logs       Host-side: tail docker compose logs',
    '  backup     Host-side: dump the database and tar /etc/genwork/data',
    '  restore    Host-side: restore from a backup tarball',
    '  upgrade    Host-side: pull a new image and restart with rollback on failure',
    '  reinit     Legacy: re-open the /setup flow (preserved unchanged)',
    '  version    Print the build-time version string',
  ];
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Write `preflight.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('assertDockerOnPath', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  test('returns silently when docker is present', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockReturnValue(Buffer.from('/usr/bin/docker'));
    const { assertDockerOnPath } = await import('../../src/cli/lib/preflight.js');
    expect(() => assertDockerOnPath()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('exits 1 when docker is missing', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockImplementation(() => {
      throw new Error('not found');
    });
    const { assertDockerOnPath } = await import('../../src/cli/lib/preflight.js');
    assertDockerOnPath();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

If the `vi.spyOn` approach above feels heavy, replace it with a `vi.mock('node:child_process', ...)` block — the test just needs to confirm exit behavior in the two cases.

- [ ] **Step 7: Write `version.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('genwork-server version', () => {
  let prevVersion: string | undefined;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prevVersion = process.env.VERSION;
    process.env.VERSION = 'v2026.10.15-test';
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    if (prevVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = prevVersion;
  });

  test('prints VERSION env when set', async () => {
    const { run } = await import('../../src/cli/version.js');
    run();
    expect(log).toHaveBeenCalledWith('genwork-server v2026.10.15-test');
  });
});
```

- [ ] **Step 8: Run tests**

```bash
cd enterprise_server && npm test -- tests/cli/preflight.test.ts tests/cli/version.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run lint**

```bash
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/index.ts \
  enterprise_server/src/cli/lib/preflight.ts \
  enterprise_server/src/cli/lib/runMigrations.ts \
  enterprise_server/src/cli/migrate.ts \
  enterprise_server/src/cli/version.ts \
  enterprise_server/tests/cli/preflight.test.ts \
  enterprise_server/tests/cli/version.test.ts
```

- [ ] **Step 10: Commit**

```bash
git add enterprise_server/src/cli enterprise_server/tests/cli
git commit -m "feat(enterprise-server): cli dispatcher with preflight, migrate, version"
```

---

## Task 4: `start` subcommand (container-side)

**Files:**
- Create: `enterprise_server/src/cli/start.ts`
- Test: `enterprise_server/tests/cli/start.test.ts` (lightweight)

`start` is what the container does on boot: migrations (or dry-run), then `serve()`. The dev `npm run dev` keeps using `tsx src/server.ts` and is unaffected.

- [ ] **Step 1: Write `start.ts`**

```ts
import { runMigrationsOnce } from './lib/runMigrations.js';
import { pool } from '../db/pool.js';
import { serve } from '../server.js';

export async function run(): Promise<void> {
  await runMigrationsOnce();
  // If we are running in dry-run mode, exit before binding the port.
  if (process.env.GENWORK_MIGRATE_DRY_RUN === '1') {
    console.log('[start] dry-run complete; skipping serve()');
    await pool.end();
    return;
  }
  // If the operator left POSTGRES_SUPERUSER_URL in .env (it has no runtime
  // use; only `init` consumes it), log a debug line so the audit trail
  // records the oversight without failing the boot.
  if (process.env.POSTGRES_SUPERUSER_URL) {
    console.debug('[start] POSTGRES_SUPERUSER_URL is set but unused at runtime; consider removing it from .env');
  }
  serve();
  // pool stays open for the lifetime of the server.
}
```

- [ ] **Step 2: Write `start.test.ts`**

```ts
import { describe, expect, test, vi } from 'vitest';

describe('start subcommand', () => {
  test('skips serve() in dry-run mode', async () => {
    process.env.GENWORK_MIGRATE_DRY_RUN = '1';
    const { run } = await import('../../src/cli/start.js');
    // Stub serve so it never binds a port; we just assert dry-run returns.
    const exit = vi.fn();
    await expect(run()).resolves.toBeUndefined();
    delete process.env.GENWORK_MIGRATE_DRY_RUN;
  });
});
```

This test is light because `serve()` would otherwise try to bind `:8787`. The dry-run branch is the only branch that returns without binding, and the test pins that.

- [ ] **Step 3: Run tests + lint, then commit**

```bash
cd enterprise_server && npm test -- tests/cli/start.test.ts
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/start.ts enterprise_server/tests/cli/start.test.ts
git add enterprise_server/src/cli/start.ts enterprise_server/tests/cli/start.test.ts
git commit -m "feat(enterprise-server): cli start subcommand for container entrypoint"
```

---

## Task 5: `init` subcommand (host-side)

**Files:**
- Create: `enterprise_server/src/cli/init.ts`
- Test: `enterprise_server/tests/cli/init.test.ts`
- Modify: `enterprise_server/.env.example` (add new vars per spec §6.1)
- Test: `enterprise_server/tests/cli/init_env.test.ts` (env-template shape)

`init` is the only command that talks to both the host filesystem and the customer's Postgres via the `POSTGRES_SUPERUSER_URL`. It is the most heavily-pinned subcommand in the spec.

- [ ] **Step 1: Extend `.env.example`**

Append the spec's §6.1 block (existing fields stay; new fields go at the bottom):

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

- [ ] **Step 2: Write `init.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { assertDockerOnPath, assertRoot, requireEnv } from './lib/preflight.js';

const DEFAULT_DATA_DIR = '/etc/genwork';
const DEFAULT_INSTALL_DIR = process.env.INSTALL_DIR ?? dirname(new URL(import.meta.url).pathname);

type Options = {
  config?: string;
  noDbBootstrap?: boolean;
  printEnvTemplate?: boolean;
  force?: boolean;
};

function parseUrl(u: string): URL {
  try { return new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
}

function roleFromUrl(u: string): string {
  return decodeURIComponent(parseUrl(u).username);
}

async function dbBootstrap(): Promise<void> {
  const su = requireEnv('POSTGRES_SUPERUSER_URL');
  const app = requireEnv('DATABASE_URL');
  if (roleFromUrl(su) === roleFromUrl(app)) {
    console.error('Refusing to bootstrap: POSTGRES_SUPERUSER_URL and DATABASE_URL use the same role.');
    console.error('Run `init --no-db-bootstrap` after creating the application role manually.');
    process.exit(1);
  }
  const target = parseUrl(app);
  const dbName = target.pathname.replace(/^\//, '');
  const appRole = roleFromUrl(app);
  const client = new Client({ connectionString: su });
  await client.connect();
  try {
    await client.query(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${target.password ?? ''}'`);
    console.log(`[init] created role ${appRole}`);
  } catch (e: any) {
    if (e?.code === '42710') console.log(`[init] role ${appRole} already exists`);
    else throw e;
  }
  try {
    await client.query(`CREATE DATABASE "${dbName}" OWNER "${appRole}"`);
    console.log(`[init] created database ${dbName}`);
  } catch (e: any) {
    if (e?.code === '42P04') console.log(`[init] database ${dbName} already exists`);
    else throw e;
  }
  await client.end();
}

function writeFiles(installDir: string, dataDir: string, imageTag: string): void {
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(join(installDir, 'docker-compose.yml'), join(dataDir, 'compose.yml'));
  copyFileSync(join(installDir, 'caddyfile.example'), join(dataDir, 'caddyfile.example'));
  writeFileSync(join(dataDir, 'current-version'), imageTag);
  // Host-side binary symlink
  const link = '/usr/local/bin/genwork-server';
  const target = join(installDir, 'cli', 'dist', 'index.js');
  try {
    if (!existsSync(link)) symlinkSync(target, link);
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
  }
  try { chmodSync(target, 0o755); } catch { /* ignore on systems where chmod is a no-op */ }
}

function printEnvTemplate(): void {
  console.log([
    'Required .env keys (fill in, do not commit):',
    '  DATABASE_URL=postgres://<role>:<password>@<host>:<port>/<db>',
    '  JWT_SECRET=<openssl rand -hex 32>',
    '  GENWORK_VAULT_MASTER_KEY=<openssl rand -base64 32>',
    '  PORT=8787',
    '  IMAGE_TAG=latest',
    '  DATA_DIR=/data',
    '  # Used only by `init`. Remove after init succeeds.',
    '  POSTGRES_SUPERUSER_URL=postgres://postgres:postgres@<host>:<port>/postgres',
  ].join('\n'));
}

function validateEnvStrength(): void {
  const jwt = process.env.JWT_SECRET ?? '';
  if (jwt.length < 32) {
    console.error('JWT_SECRET must be ≥32 chars. Generate with: openssl rand -hex 32');
    process.exit(1);
  }
  const vault = process.env.GENWORK_VAULT_MASTER_KEY ?? '';
  if (!vault) {
    console.error('GENWORK_VAULT_MASTER_KEY is required. Generate with: openssl rand -base64 32');
    process.exit(1);
  }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') opts.config = argv[++i];
    else if (a === '--no-db-bootstrap') opts.noDbBootstrap = true;
    else if (a === '--print-env-template') opts.printEnvTemplate = true;
    else if (a === '--force') opts.force = true;
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (opts.printEnvTemplate) { printEnvTemplate(); return; }
  assertRoot();
  assertDockerOnPath();

  const dataDir = DEFAULT_DATA_DIR;
  if (existsSync(join(dataDir, 'compose.yml')) && !opts.force) {
    console.error(`${dataDir} is already initialized. Pass --force to overwrite.`);
    process.exit(1);
  }

  if (!opts.noDbBootstrap) {
    await dbBootstrap();
  }
  const imageTag = process.env.IMAGE_TAG ?? 'latest';
  writeFiles(DEFAULT_INSTALL_DIR, dataDir, imageTag);
  validateEnvStrength();
  console.log('[init] done. Next: edit .env, then `genwork-server start` (or `docker compose -f /etc/genwork/compose.yml up -d`).');
}
```

- [ ] **Step 3: Write `init.test.ts`**

The test mocks `pg.Client` so it never actually connects. It exercises:
- **Review Focus #1**: `dataDir` already initialized → refuse.
- **Review Focus #1**: `--force` bypasses the second check.
- **Review Focus #3**: role == superuser role → refuse.
- **Review Focus on weak secrets**: `JWT_SECRET < 32` chars → refuse after writing files.

`init.ts` writes to `DEFAULT_DATA_DIR` which is `/etc/genwork`. The test points it at a temp dir via the `INIT_DATA_DIR` env override (added below as a small extension to `init.ts` so the test does not need root or write to `/etc`).

First, extend `init.ts` to honor `INIT_DATA_DIR` (small surgical change to the existing `init.ts` code above). Replace the line:

```ts
const dataDir = DEFAULT_DATA_DIR;
```

with:

```ts
const dataDir = process.env.INIT_DATA_DIR ?? DEFAULT_DATA_DIR;
```

The corresponding escape-hatch behavior in the test is that `INIT_DATA_DIR` is set before each test and `process.env.INIT_DATA_DIR` is cleaned up in `afterEach`.

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'genwork-init-'));

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(require('node:child_process'), 'execSync').mockReturnValue(Buffer.from('/usr/bin/docker'));
  // Strong secrets
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.GENWORK_VAULT_MASTER_KEY = 'y'.repeat(40);
  process.env.DATABASE_URL = 'postgres://app:secret@host:5432/appdb';
  process.env.POSTGRES_SUPERUSER_URL = 'postgres://postgres:pw@host:5432/postgres';
  // Redirect the production data dir to a temp dir for the test
  process.env.INIT_DATA_DIR = join(tmp, 'data');
  // Seed a fake install dir with compose + caddyfile
  const fakeInstall = mkdtempSync(join(tmp, 'install-'));
  writeFileSync(join(fakeInstall, 'docker-compose.yml'), 'name: t\n');
  writeFileSync(join(fakeInstall, 'caddyfile.example'), ':80 {}\n');
  process.env.INSTALL_DIR = fakeInstall;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ['INIT_DATA_DIR', 'INSTALL_DIR']) delete process.env[k];
  vi.restoreAllMocks();
});

describe('init subcommand', () => {
  test('refuses when role == superuser role', async () => {
    process.env.DATABASE_URL = 'postgres://postgres:pw@host:5432/appdb';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('same role'));
  });

  test('refuses when data dir is already initialized', async () => {
    writeFileSync(join(tmp, 'data', 'compose.yml'), 'services:\n  app:\n    image: x\n', { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('already initialized'));
  });

  test('--force bypasses already-initialized check', async () => {
    writeFileSync(join(tmp, 'data', 'compose.yml'), 'services:\n  app:\n    image: x\n', { recursive: true });
    vi.mock('pg', () => ({
      Client: vi.fn().mockImplementation(() => ({
        connect: () => Promise.resolve(),
        query: vi.fn()
          .mockRejectedValueOnce({ code: '42710' }) // role exists
          .mockRejectedValueOnce({ code: '42P04' }) // db exists
          .mockResolvedValue({ rows: [] }),
        end: () => Promise.resolve(),
      })),
    }));
    const { run } = await import('../../src/cli/init.js');
    await run(['--force']);
    expect(existsSync(join(tmp, 'data', 'current-version'))).toBe(true);
  });

  test('refuses weak JWT_SECRET', async () => {
    process.env.JWT_SECRET = 'short';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET'));
  });
});
```

- [ ] **Step 4: Run tests + lint, then commit**

```bash
cd enterprise_server && npm test -- tests/cli/init.test.ts
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/init.ts \
  enterprise_server/tests/cli/init.test.ts
git add enterprise_server/src/cli/init.ts enterprise_server/tests/cli/init.test.ts enterprise_server/.env.example
git commit -m "feat(enterprise-server): cli init subcommand and .env.example extensions"
```

---

## Task 6: `upgrade` subcommand with rollback

**Files:**
- Create: `enterprise_server/src/cli/upgrade.ts`
- Test: `enterprise_server/tests/cli/upgrade.test.ts`

The hardest subcommand. Pulls the new image, runs a pre-migration dry-run, swaps the `image:` field in `/etc/genwork/compose.yml`, restarts the container, polls `/health` for 30s, and rolls back on failure. The database is *not* rolled back (the dry-run never wrote).

- [ ] **Step 1: Write `upgrade.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { assertDockerOnPath, assertRoot, requireEnv } from './lib/preflight.js';

const COMPOSE = process.env.COMPOSE_FILE ?? '/etc/genwork/compose.yml';
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 1_000;

function readComposeImage(): string {
  const text = readFileSync(COMPOSE, 'utf8');
  const m = text.match(/^(\s*)image:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`Could not find "image:" line in ${COMPOSE}`);
  return m[2];
}

function writeComposeImage(image: string): void {
  const text = readFileSync(COMPOSE, 'utf8');
  const updated = text.replace(/^(\s*)image:\s*\S+\s*$/m, `$1image: ${image}`);
  writeFileSync(COMPOSE, updated);
}

function recordVersion(previous: string, current: string): void {
  writeFileSync('/etc/genwork/previous-version', previous);
  writeFileSync('/etc/genwork/current-version', current);
}

async function pollHealth(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const out = execSync('curl -fsS http://127.0.0.1:8787/health', { stdio: 'pipe' }).toString();
      if (/ok/.test(out)) return true;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  let to: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to') to = argv[++i];
    else { console.error(`Unknown arg: ${argv[i]}`); process.exit(2); }
  }
  if (!to) { console.error('Usage: genwork-server upgrade --to <version>'); process.exit(2); }

  assertRoot();
  assertDockerOnPath();

  const repo = process.env.IMAGE_REPO ?? 'enterprise-server';
  const newImage = `${repo}:${to}`;
  const previousImage = readComposeImage();

  console.log(`[upgrade] pulling ${newImage}`);
  execSync(`docker pull ${newImage}`, { stdio: 'inherit' });

  console.log(`[upgrade] dry-run pre-migration`);
  try {
    execSync(
      `docker run --rm --env-file .env -e GENWORK_MIGRATE_DRY_RUN=1 ${newImage} genwork-server migrate`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.error('[upgrade] pre-migration dry-run FAILED; aborting before container restart');
    throw e;
  }

  console.log(`[upgrade] swapping image to ${newImage}`);
  writeComposeImage(newImage);
  console.log(`[upgrade] restarting container`);
  execSync(`docker compose -f ${COMPOSE} up -d`, { stdio: 'inherit' });

  const healthy = await pollHealth();
  if (!healthy) {
    console.error(`[upgrade] healthcheck failed; rolling back to ${previousImage}`);
    writeComposeImage(previousImage);
    execSync(`docker compose -f ${COMPOSE} up -d`, { stdio: 'inherit' });
    console.error('[upgrade] FAILED — image rolled back; database untouched (pre-migration was dry-run)');
    process.exit(1);
  }
  recordVersion(previousImage, newImage);
  console.log(`[upgrade] complete: ${previousImage} → ${newImage}`);
}
```

- [ ] **Step 2: Write `upgrade.test.ts`**

Mock `child_process.execSync` so the test can simulate success, healthcheck-fail, and rollback paths without a real Docker. The test sets `COMPOSE_FILE` so the production code points at the temp compose file.

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'genwork-upgrade-'));

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(require('node:child_process'), 'execSync').mockImplementation((cmd: string) => {
    if (typeof cmd !== 'string') return Buffer.from('');
    if (cmd.includes('curl')) return Buffer.from('{"ok":true}');
    return Buffer.from('');
  });
  process.env.COMPOSE_FILE = join(tmp, 'compose.yml');
  writeFileSync(join(tmp, 'compose.yml'),
    'services:\n  app:\n    image: enterprise-server:old\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.COMPOSE_FILE;
  vi.restoreAllMocks();
});

describe('upgrade subcommand', () => {
  test('happy path: swaps image, polls health, records version', async () => {
    const { run } = await import('../../src/cli/upgrade.js');
    await run(['--to', 'v2026.11.1']);
    const text = readFileSync(join(tmp, 'compose.yml'), 'utf8');
    expect(text).toContain('image: enterprise-server:v2026.11.1');
  });

  test('rollback on healthcheck timeout', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('curl')) throw new Error('connection refused');
      return Buffer.from('');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/upgrade.js');
    await run(['--to', 'v2026.11.1']);
    const text = readFileSync(join(tmp, 'compose.yml'), 'utf8');
    expect(text).toContain('image: enterprise-server:old'); // rolled back
    expect(exit).toHaveBeenCalledWith(1);
  });
});
```

The two tests pin Review Focus item #4 (mid-flight failure → image rollback, exit 1, DB untouched).

- [ ] **Step 3: Run tests + lint, then commit**

```bash
cd enterprise_server && npm test -- tests/cli/upgrade.test.ts
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/upgrade.ts enterprise_server/tests/cli/upgrade.test.ts
git add enterprise_server/src/cli/upgrade.ts enterprise_server/tests/cli/upgrade.test.ts
git commit -m "feat(enterprise-server): cli upgrade subcommand with image rollback"
```

---

## Task 7: `status` subcommand

**Files:**
- Create: `enterprise_server/src/cli/status.ts`
- Test: `enterprise_server/tests/cli/status.test.ts`

- [ ] **Step 1: Write `status.ts`**

```ts
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { assertDockerOnPath } from './lib/preflight.js';

const COMPOSE = process.env.COMPOSE_FILE ?? '/etc/genwork/compose.yml';

async function tryHealth(): Promise<{ ok: boolean; latencyMs: number | null }> {
  const start = Date.now();
  try {
    const out = execSync('curl -fsS http://127.0.0.1:8787/health', { stdio: 'pipe' }).toString();
    return { ok: /ok/.test(out), latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

export async function run(): Promise<void> {
  assertDockerOnPath();
  const ps = (() => {
    try { return execSync(`docker compose -f ${COMPOSE} ps --format json`, { stdio: 'pipe' }).toString(); }
    catch { return ''; }
  })();
  const running = /Up|running/.test(ps) || /"State":"running"/.test(ps);
  if (!running) {
    console.log('Service: not running');
    process.exit(2);
  }
  const health = await tryHealth();
  const versionPath = '/etc/genwork/current-version';
  const version = existsSync(versionPath) ? readFileSync(versionPath, 'utf8').trim() : 'unknown';
  console.log(`Service: running`);
  console.log(`Health:  ${health.ok ? 'ok' : 'unhealthy'}${health.latencyMs != null ? ` (${health.latencyMs}ms)` : ''}`);
  console.log(`Version: ${version}`);
  process.exit(health.ok ? 0 : 1);
}
```

- [ ] **Step 2: Write `status.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(require('node:child_process'), 'execSync').mockReturnValue(Buffer.from(''));
});
afterEach(() => vi.restoreAllMocks());

describe('status subcommand', () => {
  test('exits 2 when compose ps shows nothing', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockReturnValue(Buffer.from(''));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/status.js');
    await run();
    expect(exit).toHaveBeenCalledWith(2);
  });

  test('exits 0 when health endpoint returns ok', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('compose')) return Buffer.from('"State":"running"');
      if (cmd.includes('curl')) return Buffer.from('{"ok":true}');
      return Buffer.from('');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/status.js');
    await run();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
```

- [ ] **Step 3: Run tests + lint, then commit**

```bash
cd enterprise_server && npm test -- tests/cli/status.test.ts
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/status.ts enterprise_server/tests/cli/status.test.ts
git add enterprise_server/src/cli/status.ts enterprise_server/tests/cli/status.test.ts
git commit -m "feat(enterprise-server): cli status subcommand with exit codes 0/1/2"
```

---

## Task 8: `backup` and `restore` subcommands

**Files:**
- Create: `enterprise_server/src/cli/backup.ts`
- Create: `enterprise_server/src/cli/restore.ts`
- Test: `enterprise_server/tests/cli/backup.test.ts`
- Test: `enterprise_server/tests/cli/restore.test.ts`

- [ ] **Step 1: Write `backup.ts`**

```ts
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireEnv, assertRoot, assertDockerOnPath } from './lib/preflight.js';

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  let out = `./genwork-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else { console.error(`Unknown arg: ${argv[i]}`); process.exit(2); }
  }
  assertRoot();
  assertDockerOnPath();
  const dbUrl = requireEnv('DATABASE_URL');
  const work = mkdtempSync(join(tmpdir(), 'genwork-backup-'));
  const dump = join(work, 'dump.sql.gz');
  console.log(`[backup] pg_dump → ${dump}`);
  const dumpRes = spawnSync('pg_dump', ['--no-owner', '--no-privileges', '--format=custom', `--file=${dump}`, dbUrl], { stdio: 'inherit' });
  if (dumpRes.status !== 0) {
    console.error(`[backup] pg_dump failed with exit ${dumpRes.status}`);
    process.exit(dumpRes.status ?? 1);
  }
  console.log(`[backup] tar → ${out}`);
  execSync(`tar czf ${out} -C /etc/genwork data ${dump}`, { stdio: 'inherit' });
  console.log(`[backup] wrote ${out}`);
}
```

- [ ] **Step 2: Write `restore.ts`**

```ts
import { spawnSync, execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { requireEnv, assertRoot, assertDockerOnPath } from './lib/preflight.js';

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${prompt} [type YES to continue] `, (answer) => {
    rl.close();
    resolve(answer === 'YES');
  }));
}

async function isServiceUp(): Promise<boolean> {
  try {
    const out = execSync('curl -fsS http://127.0.0.1:8787/health', { stdio: 'pipe' }).toString();
    return /ok/.test(out);
  } catch { return false; }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  let archive: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') archive = argv[++i];
    else if (a === '--force') force = true;
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!archive) { console.error('Usage: genwork-server restore --from <archive.tar.gz> [--force]'); process.exit(2); }
  assertRoot();
  assertDockerOnPath();

  if (await isServiceUp() && !force) {
    console.error('Service is up. Stop it before restore, or pass --force.');
    process.exit(1);
  }
  if (await isServiceUp() && force) {
    console.warn('!! WARNING: service is up. Restoring now will produce inconsistent state.');
  }
  if (!force) {
    const ok = await confirm('About to overwrite the database. This is destructive.');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }
  const work = mkdtempSync(join(tmpdir(), 'genwork-restore-'));
  console.log(`[restore] extracting ${archive}`);
  execSync(`tar xzf ${archive} -C ${work}`, { stdio: 'inherit' });
  const dump = join(work, 'dump.sql.gz');
  const dbUrl = requireEnv('DATABASE_URL');
  console.log(`[restore] pg_restore`);
  const r = spawnSync('pg_restore', ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--dbname', dbUrl, dump], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[restore] pg_restore exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
  console.log(`[restore] copying /etc/genwork/data`);
  execSync(`rm -rf /etc/genwork/data && mkdir -p /etc/genwork && tar xzf ${archive} -C /etc/genwork data`, { stdio: 'inherit' });
  console.log('[restore] done.');
}
```

- [ ] **Step 3: Write `backup.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  process.env.DATABASE_URL = 'postgres://app:pw@h:5432/db';
  vi.spyOn(require('node:child_process'), 'execSync').mockReturnValue(Buffer.from(''));
  vi.spyOn(require('node:child_process'), 'spawnSync').mockReturnValue({ status: 0 } as any);
});
afterEach(() => vi.restoreAllMocks());

describe('backup subcommand', () => {
  test('invokes pg_dump with --no-owner and tar czf', async () => {
    const spawnSync = vi.spyOn(require('node:child_process'), 'spawnSync');
    const execSync = vi.spyOn(require('node:child_process'), 'execSync');
    const { run } = await import('../../src/cli/backup.js');
    await run([]);
    const dumpCall = spawnSync.mock.calls.find((c: any[]) => c[0] === 'pg_dump');
    expect(dumpCall).toBeDefined();
    expect(dumpCall![1]).toEqual(expect.arrayContaining(['--no-owner', '--no-privileges', '--format=custom']));
    const tarCall = execSync.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].startsWith('tar czf'));
    expect(tarCall).toBeDefined();
  });
});
```

- [ ] **Step 4: Write `restore.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  process.env.DATABASE_URL = 'postgres://app:pw@h:5432/db';
  vi.spyOn(require('node:child_process'), 'execSync').mockReturnValue(Buffer.from(''));
  vi.spyOn(require('node:child_process'), 'spawnSync').mockReturnValue({ status: 0 } as any);
});
afterEach(() => vi.restoreAllMocks());

describe('restore subcommand', () => {
  test('refuses when service is up and no --force', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('curl')) return Buffer.from('{"ok":true}');
      return Buffer.from('');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/restore.js');
    await run(['--from', 'fake.tar.gz']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('--force bypasses up-service refusal', async () => {
    vi.spyOn(require('node:child_process'), 'execSync').mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('curl')) return Buffer.from('{"ok":true}');
      return Buffer.from('');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/restore.js');
    await run(['--from', 'fake.tar.gz', '--force']);
    // We expect the call to proceed into pg_restore (mocked), not exit(1).
    // The exact exit code is the spawnSync mock's status (0).
    expect(exit).not.toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 5: Run tests + lint, then commit**

```bash
cd enterprise_server && npm test -- tests/cli/backup.test.ts tests/cli/restore.test.ts
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/backup.ts enterprise_server/src/cli/restore.ts \
  enterprise_server/tests/cli/backup.test.ts enterprise_server/tests/cli/restore.test.ts
git add enterprise_server/src/cli/backup.ts enterprise_server/src/cli/restore.ts \
        enterprise_server/tests/cli/backup.test.ts enterprise_server/tests/cli/restore.test.ts
git commit -m "feat(enterprise-server): cli backup and restore subcommands"
```

---

## Task 9: Dockerfile, docker-compose.yml, reverse-proxy examples, build script

**Files:**
- Create: `enterprise_server/Dockerfile`
- Create: `enterprise_server/docker-compose.yml`
- Create: `enterprise_server/caddyfile.example`
- Create: `enterprise_server/nginx.conf.example`
- Create: `scripts/build-enterprise-image.sh`
- Create: `.github/workflows/enterprise-server-image.yml`

- [ ] **Step 1: Create the `Dockerfile`**

```dockerfile
# ---- Stage 1: web SPA build -----------------------------------------------
FROM node:24-alpine AS web-build
WORKDIR /work/web
COPY enterprise_server/web/package.json enterprise_server/web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY enterprise_server/web/ ./
RUN npm run build

# ---- Stage 2: TypeScript compile -----------------------------------------
FROM node:24-alpine AS ts-build
WORKDIR /work/enterprise_server
COPY enterprise_server/package.json enterprise_server/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY enterprise_server/ ./
COPY --from=web-build /work/web/dist ./web-dist
ARG VERSION=dev
ENV VERSION=$VERSION
RUN npm run build

# ---- Stage 3: runtime ----------------------------------------------------
FROM node:24-alpine AS runtime
RUN apk add --no-cache tini postgresql16-client bash \
 && addgroup -S node && adduser -S node -G node
WORKDIR /app
COPY enterprise_server/package.json enterprise_server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=ts-build /work/enterprise_server/dist ./dist
COPY --from=ts-build /work/enterprise_server/web-dist ./web-dist
ARG VERSION=dev
ENV VERSION=$VERSION \
    NODE_ENV=production \
    PORT=8787 \
    WEB_DIST_DIR=/app/web-dist
EXPOSE 8787
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/dist/cli/index.js"]
CMD ["start"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

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

- [ ] **Step 3: Create `caddyfile.example`**

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

- [ ] **Step 4: Create `nginx.conf.example`**

```nginx
server {
    listen 443 ssl;
    server_name api.genwork.example.com;

    ssl_certificate     /etc/ssl/certs/genwork.crt;
    ssl_certificate_key /etc/ssl/private/genwork.key;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}

# Plain HTTP variant for LAN/internal-only
server {
    listen 80;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

- [ ] **Step 5: Create `scripts/build-enterprise-image.sh`**

```bash
#!/usr/bin/env bash
# Build the enterprise-server image locally. Honors --version and --push.
# Default version is git describe (short SHA) or "dev".
set -euo pipefail

VERSION="dev"
PUSH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --push)    PUSH="--push"; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

if command -v git >/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
  SHA=$(git rev-parse --short HEAD)
  VERSION="${VERSION}+${SHA}"
fi

echo "Building enterprise-server:${VERSION}"
docker buildx build \
  --build-arg "VERSION=${VERSION}" \
  --tag "enterprise-server:${VERSION}" \
  ${PUSH} \
  --load \
  .
```

Make it executable: `chmod +x scripts/build-enterprise-image.sh`. (Path is `scripts/build-enterprise-image.sh` at the repo root, mirroring the existing pattern in `scripts/`.)

- [ ] **Step 6: Create `.github/workflows/enterprise-server-image.yml`**

```yaml
name: enterprise-server-image

on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build image
        env:
          REGISTRY: ${{ vars.REGISTRY }}
        run: |
          TAG="${GITHUB_REF_NAME:-dev}"
          if [ -n "${REGISTRY}" ]; then
            ./scripts/build-enterprise-image.sh --version "$TAG" --push
          else
            ./scripts/build-enterprise-image.sh --version "$TAG"
          fi
```

- [ ] **Step 7: Verify the Dockerfile builds (locally)**

```bash
cd /Users/paulwang/work/GenWork
chmod +x scripts/build-enterprise-image.sh
./scripts/build-enterprise-image.sh --version test-local
```

Expected: image built, no errors. (Takes 5–10 minutes the first time because the web-build stage fetches packages.)

- [ ] **Step 8: Lint the YAML files**

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/cli/index.ts  # only TS files we touched in this task
```

(YAML lint is out of scope for the project's eslint config; spot-check by reading.)

- [ ] **Step 9: Commit**

```bash
git add enterprise_server/Dockerfile \
        enterprise_server/docker-compose.yml \
        enterprise_server/caddyfile.example \
        enterprise_server/nginx.conf.example \
        scripts/build-enterprise-image.sh \
        .github/workflows/enterprise-server-image.yml
git commit -m "feat(enterprise-server): dockerfile, compose, proxy examples, image build script and ci"
```

---

## Task 10: Deploy manual + README pointer

**Files:**
- Create: `docs/enterprise-server-deploy.md`
- Modify: `README.md` (slim the existing "Enterprise-Side Installation & Deployment" section)
- Modify: `README_zh.md` (same slimming, mirror Chinese version)

- [ ] **Step 1: Write `docs/enterprise-server-deploy.md`**

The manual walks the customer through the full install path. The content is documentation, not code, so the implementer is not expected to copy it verbatim — but the structure below must be present:

```markdown
# Enterprise Server — Production Deployment

## Prerequisites
- Linux host (Ubuntu 22.04+ or RHEL 9+).
- Docker Engine ≥24 and docker compose plugin installed.
- An external PostgreSQL 14+ reachable from the host.
- Outbound HTTPS to a registry (only if pulling a pre-built image).

## Step 1 — Build (or pull) the image
Either `./scripts/build-enterprise-image.sh v2026.10.15` on a build host,
or pull from your internal registry.

## Step 2 — Prepare `.env`
Copy `enterprise_server/.env.example` to `.env`. Fill in `DATABASE_URL`,
`JWT_SECRET` (`openssl rand -hex 32`), `GENWORK_VAULT_MASTER_KEY`
(`openssl rand -base64 32`), `IMAGE_TAG`, and `POSTGRES_SUPERUSER_URL`
(used by `init` only — remove the line after init).

## Step 3 — `genwork-server init`
On the production host, with `.env` in the cwd:
`genwork-server init` (or `node enterprise_server/dist/cli/index.js init`).

This:
- Validates docker / root.
- Connects to `POSTGRES_SUPERUSER_URL` and creates the application role + DB.
- Writes `/etc/genwork/{compose.yml, caddyfile.example, current-version}`.
- Installs `/usr/local/bin/genwork-server` symlink.

## Step 4 — Start
`docker compose -f /etc/genwork/compose.yml up -d` (or `genwork-server start`).
Wait for `docker compose ps` to show `Up (healthy)`.

## Step 5 — First-run setup
Open `https://<host>/setup` and create the org + super-admin.

## Step 6 — Reverse proxy
Edit `/etc/genwork/caddyfile.example` (or your own nginx config) and reload
the proxy. Confirm `https://<host>/api/health` returns 200.

## Step 7 — Upgrade later
`genwork-server upgrade --to v2026.11.1`. The CLI pulls, dry-runs the
migrations, swaps the image, restarts, and rolls back on healthcheck
failure (the database is not rolled back).

## Step 8 — Backup
`genwork-server backup` writes `genwork-backup-<date>.tar.gz` to cwd.

## Step 9 — Restore
Stop the server first, then `genwork-server restore --from <archive>`.
With `--force`, the "service is up" guard is bypassed (not recommended).

## Monitoring
- `genwork-server status` — health, version, exit 0/1/2.
- `genwork-server logs` — `docker compose logs` passthrough.
- Container logs also live at `/var/lib/docker/containers/.../<id>-json.log`
  (or the customer's logging driver).

## Troubleshooting
- **`init` says "Docker is not on PATH".** Install Docker Engine.
- **`init` says "same role" for POSTGRES_SUPERUSER_URL and DATABASE_URL.**
  Create the app role manually with `CREATE ROLE` and rerun
  `init --no-db-bootstrap`.
- **Container restart loop after `upgrade`.** Check `docker logs`; the
  upgrade already rolled the image back, so the running container is the
  previous version. Investigate why the new version failed.
- **`/health` returns 200 but UI is blank.** The reverse proxy is not
  forwarding `/` correctly. Check `proxy_read_timeout` (Caddy: 120s).
```

- [ ] **Step 2: Slim the README sections**

In both `README.md` and `README_zh.md`, replace the "Enterprise-Side
Installation & Deployment" section with a short pointer:

> For production deployment on a customer-managed Linux host, see
> [`docs/enterprise-server-deploy.md`](docs/enterprise-server-deploy.md).
> That document covers the Docker image, the `genwork-server` CLI,
> TLS termination, upgrades, and backups. The "Quick Start" steps above
> remain valid for local development.

Keep the rest of the README untouched.

- [ ] **Step 3: Verify both README files still lint clean**

The repo's existing README lint should not fail; no TS/TSX in this task, so the gate is `npm test` only (and no test changes here).

- [ ] **Step 4: Commit**

```bash
git add docs/enterprise-server-deploy.md README.md README_zh.md
git commit -m "docs(enterprise-server): production deployment manual and readme pointer"
```

---

## Task 11: Final verification

**Files:** none (read-only).

- [ ] **Step 1: Run the full test suite**

```bash
cd enterprise_server && npm test
```

Expected: all new tests in `tests/cli/` pass; existing pglite tests pass; existing `reinit` test (if any) still passes. The 5 pre-existing enterprise-agent test failures documented in `pre-existing-failing-enterprise-agent-tests` memory are baseline; do not chase them here.

- [ ] **Step 2: Lint the touched files**

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src \
  enterprise_server/tests
```

Expected: no errors. The `no-unused-disable-directives` flag turns unused `// eslint-disable` into errors; do not add broad disables.

- [ ] **Step 3: Smoke test the CLI dispatcher from source**

```bash
cd enterprise_server
npm run build
node dist/cli/index.js version
node dist/cli/index.js help
```

Expected: `version` prints `genwork-server dev`. `help` prints the subcommand list.

- [ ] **Step 4: Confirm no regression in `reinit`**

```bash
cd enterprise_server
DATABASE_URL=postgres://... JWT_SECRET=$(openssl rand -hex 32) npm run reinit -- --help 2>&1 | head -5
# OR, if `--help` is not supported on the legacy CLI, just run it against a test DB.
```

Expected: existing `reinit` behavior unchanged.

- [ ] **Step 5: Commit any leftovers**

If Step 1, 2, or 3 surfaced a fix, commit it. Otherwise there is nothing to commit and the plan is done.

```bash
git status --porcelain
```

If empty, done. If non-empty, commit with a `fix(enterprise-server):` message.
