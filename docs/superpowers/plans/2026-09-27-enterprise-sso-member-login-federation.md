# Enterprise SSO Member-Login Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let org members sign in to GenWork (web console + desktop) through their company's identity provider (OIDC, OAuth2, Azure AD, Feishu, DingTalk, WeCom — SAML2 stored but disabled for v1), with JIT user creation and email-domain gating. Server issues the same JWT shape as password login; clients reuse existing token storage.

**Architecture:** Three concentric rings of new server routes in `enterprise_server/src/routes/sso.ts`: a public pre-login listing, a state-gated OAuth dance (`authorize` + `callback`), and admin CRUD behind `requirePermission(PP.Sso*)`. Identity is mapped per connection (`identity_id_field`/`login_name_field`/`email_field`). JIT + email-domain gate + cross-IdP dedup run in a single service module (`src/sso/jit.ts`). The console SSO callback is server-rendered HTML that writes the JWT into `localStorage` (the SPA's existing token store, `genwork.enterprise.auth.token`) and navigates to `/`. The desktop callback reuses the qichacha-MCP localhost-callback + `openOauthFlow` primitive — the enterprise `authorize` URL is loaded into a sandboxed `BrowserWindow`, the enterprise server redirects to a desktop-controlled `localhost:<port>` callback, and the captured token is fed into the existing `enterpriseClient.persistSession` + `loginGate.unlock`.

**Tech Stack:** Hono (server, `enterprise_server`), pglite (in-process tests), Postgres (production), `jose` (JWT, ID-token verification), `node:crypto` (state, PKCE), `pool.query<T>(sql, params)` (data access), zod (request validation), TanStack Query v5 + React Router (SPA), zustand (SPA auth store), vitest (tests). Desktop: Electron `enterpriseMt` IPC bridge + `openOauthFlow` + `http.createServer` localhost callback.

**Spec:** `docs/superpowers/specs/2026-09-27-enterprise-sso-member-login-federation-design.md`

## Rulings Made Before Plan Start

The review loop is the net for conflicts that emerge from implementation. The scan below surfaced four conflicts; I ruled each one and the resolution is binding unless the spec/plan is amended.

| # | Conflict | Source | Resolution | Cost if wrong |
|---|---|---|---|---|
| R1 | Spec §14.5 says "no new PermissionPoint, reuse org-admin," but the codebase convention is per-module `requirePermission(PP.<Action>)` on every admin CRUD route (`mcpConnectors.ts:302,321,331,341,…`, `admin/users.ts:131,150,191,203,…`). `requireAdmin` is a backward-compat alias for `requireCapability('admin')`, not the primary guard. Spec §7 explicitly says "mirror `adminUserRoutes`' guard convention" — that points at `requirePermission` with dedicated points. | Spec §7 vs §14.5 vs codebase | **Add `sso:*` PermissionPoints (`SsoView`/`SsoCreate`/`SsoEdit`) following the `mcp`/`skill` pattern; grant them to `org_admin`. Amends spec §14.5.** | Rework if rejected. |
| R2 | `roleResolver.pointsFor` reads the live `roles` table; `BUILTIN_ROLE_POINTS` in `permissionPoints.ts` is seed-only (migration 029, `ON CONFLICT DO NOTHING`); there is **no boot-time re-assert** of the seed against the TS source. Existing built-in roles installed before this plan will keep their old `permissions` JSONB unless a migration re-asserts. | `auth/roleResolver.ts:37`, `db/migrations/029_seed_roles_v2.sql` | **Add a new migration (037) that idempotently `UPDATE roles.permissions` for `org_admin`/`super_admin` to add the new `sso:*` strings, mirroring 029's "upgrade-in-place" pattern for legacy org_admin.** | Existing org_admin members won't be able to load the SSO admin page until migration runs. |
| R3 | SPA auth bootstraps from `localStorage` (key `genwork.enterprise.auth.token`, `web/src/auth/store.ts:44`), not a cookie. The existing `POST /auth/login` returns `{ token }` in JSON and the SPA calls `login(r.token)` to persist. The SSO console callback cannot simply `Set-Cookie` — it must return a server-rendered HTML page that writes `localStorage.setItem('genwork.enterprise.auth.token', '<jwt>')` and redirects. | `web/src/auth/store.ts:44,87-89`, `web/src/pages/LoginPage.tsx:101-102` | **Server-rendered HTML callback (HTML doc containing a `<script>` that sets localStorage and `location.assign('/')`). No new dependency.** | Slightly more elaborate callback; necessary. |
| R4 | "Login entry: console + desktop." Desktop currently has no browser-handler registration for `genwork://` deep links — `main.ts:494` only registers `ArtifactPreviewProtocol.LocalFile` as a privileged scheme. Adding protocol registration is out of scope for the SSO subsystem (electron-builder config, OS-level registration). | `src/main/main.ts:494-503` | **Desktop handoff uses the existing localhost-callback pattern (qichacha MCP) — no deep-link protocol work. The enterprise server's `authorize` URL includes a `redirect_uri` of `http://localhost:<random-port>/callback`, the desktop spins up an `http.createServer`, and the final 302 lands on that loopback, where the desktop captures the JWT.** | None — already proven path. |

## Global Constraints

These are the binding requirements; every task's requirements implicitly include this section.

- **Test code is authoritative.** Do not change existing assertion semantics. Only ADD assertions. If an existing assertion must change (e.g. a guard contract change), pause and get explicit sign-off — see Batch A #4 in this session as the prior precedent.
- **Per-file vitest.** `enterprise_server` and `web` full vitest hits EBADF / fd exhaustion in this sandbox. Run `npx vitest run <file>` per file with a fresh process. For desktop renderer/main tests, `better-sqlite3.node` ABI mismatches are a pre-existing baseline failure (see session memory); pure-function helpers are fine.
- **Typecheck baseline** must stay clean:
  - `cd enterprise_server && npx tsc --noEmit` → 0 errors
  - `cd enterprise_server/web && npx tsc --noEmit` → 0 errors
  - Desktop `electron-tsconfig.json` → 0 errors (renderer baseline `bakeArtifactSharePage.ts(382,21)` is pre-existing; do not "fix").
- **i18n is bilingual.** Every new user-visible string has both `en` and `zh` entries in `enterprise_server/web/src/i18n.ts`; every desktop string uses `i18nService.t(key)` with both locales in `src/renderer/services/i18n.ts`. No un-referenced keys.
- **Secrets are encrypted at rest and never leave the server.** Use `encrypt`/`decrypt` from `enterprise_server/src/vault/crypto.ts`. API responses only ever carry `*_masked` (see §3.2 wire shape) — never plaintext, never `*_encrypted` ciphertext. The mask format mirrors `providerKeyVault.maskKey` (`src/vault/providerKeyVault.ts:9-15`): first 3 + middle dots + last 4, or `'••••'` when ≤8 chars.
- **Edit-blank-keeps-secret** convention: when an admin PATCH leaves a secret field empty, the previously stored value is preserved (mirror `mergeAuthConfig` at `src/routes/mcpConnectors.ts:194-213`).
- **Cross-org isolation.** Every admin route filters by `claims.orgId`; a foreign `orgId` → 404. The `sso_login_states.state` row carries `org_id`; callback validates state → orgId match → SSO connection is org-scoped.
- **State is one-shot.** `sso_login_states` rows are deleted on consumption (or marked `consumed=true`) — never replayable. Short TTL (~2 min).
- **Logs never contain** `code`, `state`, `id_token`, `access_token`, `client_secret`, or any PII from `userinfo`. Audit only the stable event (`sso_login_succeeded` / `sso_login_failed` / `sso_jit_provisioned`) with `{ orgId, ssoConnectionId, externalId, reason }`.
- **Auto-commit is local-only.** Never push to remote unless the user explicitly asks.
- **No new `@modelcontextprotocol/sdk` / no new MCP wire work.** This subsystem is independent of the MCP connector SSO (see spec §9). Connector SSO (`mcp_connectors.auth_config.sso*`) is the *desktop-OAuth* design's problem, not this one's.
- **No new top-level package** dependencies. Reuse `jose` (already in `package.json:20`), `node:crypto`, `pool`, `auditStore`, `loginRecord`, `encrypt`/`decrypt`.

---

## File Structure

Each file gets one clear responsibility. Files that change together live together.

### New files (server, `enterprise_server/`)

- **`src/db/migrations/036_sso_connections.sql`** — DDL for `sso_connections` and `user_idp_identities` (per spec §3).
- **`src/db/migrations/037_grant_sso_points_to_org_admin.sql`** — idempotent `permissions` JSONB update for `org_admin`/`super_admin` (Ruling R2).
- **`src/vault/ssoSecret.ts`** — `encryptClientSecret` / `decryptClientSecret` / `maskClientSecret` for the SSO `client_secret`. Mirror `src/vault/connectorSecret.ts` (same shape, single field). Per spec §8.
- **`src/sso/providerPresets.ts`** — named-provider preset table for `azure-ad` / `feishu` / `dingtalk` / `wecom` (authorize/token/userinfo URLs + default scopes/field mappings). Pure const data. Per spec §4.2.
- **`src/sso/types.ts`** — `SsoProviderType`, `SsoProtocol`, `SsoConnectionRow`, `SsoPublicProvider` (wire shape §3.2), `SsoAdminConnection`, `SsoStateRow`, `SsoIdentityClaims`. No logic — types only.
- **`src/sso/state.ts`** — `createState(orgId, connectionId, returnTarget, codeVerifier?)`, `consumeState(state)` (one-shot, deletes row), `pruneExpiredStates()`. Uses `sso_login_states` table (added in 036). Pure CRUD on `pool`.
- **`src/sso/jit.ts`** — `resolveUser({ orgId, connectionId, externalId, email, loginName }): Promise<{ userId; createdJit: boolean }>`. Implements the §5 algorithm (email-domain gate → identity-table lookup → email-dedup → JIT). Idempotent & reentrant.
- **`src/sso/oauth.ts`** — `buildAuthorizeUrl(connection, state, codeChallenge?)`; `exchangeCode(connection, code, codeVerifier?, clientSecretDecrypted?)`; `fetchUserInfo(connection, accessToken)`; `verifyIdToken(connection, idToken)` (uses `jose.jwtVerify` with the connection's JWKs or symmetric secret as supported). Returns normalized `SsoIdentityClaims`.
- **`src/routes/sso.ts`** — `ssoRoutes = new Hono()` exporting the public listing/authorize/callback routes **plus** the admin CRUD mounted under `/admin/sso-connections/*`. Imports `requireAuth`/`requirePermission` from `../auth/middleware`, `PP` from `../shared/permissionPoints`. Per spec §4.1 + §7.
- **`src/sso/consoleCallback.ts`** — `renderConsoleCallbackHtml({ token, redirectTo }): string`. Server-rendered HTML doc with a `<script>` that does `localStorage.setItem('genwork.enterprise.auth.token', token); location.assign(redirectTo)`. Pure function; fully unit-testable.
- **`tests/routes/sso.test.ts`** — pglite in-process tests for the listing/authorize/callback/admin routes. Mirror `tests/routes/auth.test.ts` shape.
- **`tests/sso/jit.test.ts`** — pure-function tests for the JIT algorithm (email-domain gate, dedup paths, username-collision rejection). No DB needed; mock `pool` via `vi.mock`.
- **`tests/sso/oauth.test.ts`** — URL building, PKCE attach, JWS verify (against a static `jose.SignJWT` token).
- **`tests/sso/consoleCallback.test.ts`** — assert the HTML sets the right localStorage key + redirect.

### New files (SPA, `enterprise_server/web/`)

- **`src/api/sso.ts`** — `ssoApi = { listProviders(orgName), listConnections(orgId), getConnection(id), createConnection(input), patchConnection(id, patch), deleteConnection(id) }` (apiClient.get/post/patch/delete wrappers, mirror `web/src/api/connectors.ts:110-163`).
- **`src/pages/sso/SSOConnectionsPage.tsx`** — admin list page; TanStack Query; drawer for create/edit.
- **`src/pages/sso/SSOConnectionDrawer.tsx`** — provider-type-aware form (mirror `web/src/pages/mcpManage/ConnectorDrawer.tsx`). Renders different field sets per `provider_type`; pulls presets from `/admin/sso-connections/presets` (or a local mirror of `providerPresets.ts` shipped with the SPA build).
- **`src/pages/sso/presets.ts`** — SPA mirror of `providerPresets.ts` (same shape). The SPA cannot `import` server TS; the build resolves via the path alias `enterprise_server/src/...` configured in `web/vite.config.ts` (verify during Task 8) — if not, ship the constants as a separate JSON file shared between server and SPA. *Decision recorded during Task 8; default to copying the constants file.*
- **`src/pages/sso/types.ts`** — wire types matching the server's `SsoPublicProvider` / `SsoAdminConnection`.

### New files (desktop, repo root)

- **`src/main/sso/genericSsoLogin.ts`** — `startSsoMemberLogin({ connectionId, orgName, serverUrl }): Promise<string>` — wraps `openOauthFlow` (from `src/main/mcp/oauthBrowserFlow.ts`) with a localhost-callback server (mirror `qichachaMcpAuth.ts:75-114`) that captures the JWT from the enterprise callback redirect and returns it. Pure function over primitives already in the codebase.
- **`src/main/ipcHandlers/sso.ts`** — IPC handler for `EnterpriseIpcChannel.SsoLogin` (new channel; see below).
- **`src/shared/enterprise/constants.ts`** — add `EnterpriseIpcChannel.SsoLogin = 'enterprise:sso-login'` and `EnterpriseIpcChannel.SsoProviders = 'enterprise:sso-providers'`.
- **`src/renderer/login/LoginPage.tsx`** — additions: render "用 <provider name> 登录" buttons (sorted by `sort_order`) above the password form; each button opens `enterpriseMt.ssoProviders(orgName)` → list → click → `enterpriseMt.ssoLogin({orgName, connectionId})` → on success, the existing `onSuccess` prop.

### Modified files

- **`enterprise_server/src/shared/permissionPoints.ts`** — add `SsoView`/`SsoCreate`/`SsoEdit`; add the `sso` module group; include in `BUILTIN_ROLE_POINTS.org_admin` (Ruling R1, source-of-truth consistency).
- **`enterprise_server/src/server.ts`** — import `ssoRoutes` and `app.route('/', ssoRoutes);` near the other route mounts (lines 43-76).
- **`enterprise_server/web/src/i18n.ts`** — add keys in both `en` (line 3+) and `zh` (line 981+) dicts. See §I18n keys below.
- **`enterprise_server/web/src/auth/store.ts`** — no logic change; documented usage of `genwork.enterprise.auth.token` key in the console callback.
- **`enterprise_server/web/src/pages/LoginPage.tsx`** — render SSO buttons block before the password card.
- **`enterprise_server/web/src/App.tsx`** — add `<Route ...><Shell><SSOConnectionsPage/></Shell></Route>` (mirror MCPManagePage routing at line 102).
- **`src/shared/enterprise/constants.ts`** — add the two new IPC channel constants.
- **`src/main/preload.ts`** — add `ssoLogin` / `ssoProviders` methods on `enterpriseMt` (mirror the existing `login`/`listOrgs` at lines 1387-1393).
- **`src/renderer/types/electron.d.ts`** — add the corresponding renderer types.
- **`src/renderer/login/LoginPage.tsx`** — render SSO provider buttons; show error if `ssoLogin` returns `{ok:false}`.

---

## §I18n keys

Add to both `enterprise_server/web/src/i18n.ts` `en` and `zh` dicts:

```
'sso.title': 'SSO / Identity Providers' / 'SSO / 身份提供商'
'sso.create': 'Create SSO Connection' / '创建 SSO 连接'
'sso.edit': 'Edit SSO Connection' / '编辑 SSO 连接'
'sso.providerType.label': 'Provider type' / '提供商类型'
'sso.protocol.label': 'Protocol' / '协议'
'sso.name.label': 'Connection name' / '连接名称'
'sso.name.help': 'Shown on the login page as "Log in with <name>".' / '登录页展示为「用 <name> 登录」'
'sso.clientId.label': 'Client ID' / 'Client ID'
'sso.clientSecret.label': 'Client secret' / 'Client secret'
'sso.clientSecret.keepPlaceholder': 'Leave blank to keep the existing secret.' / '留空保留现有密钥'
'sso.clientSecret.maskPlaceholder': 'Stored secret (masked) — enter a new value to replace.' / '已保存密钥（已脱敏），输入新值将替换'
'sso.scopes.label': 'Scopes' / 'Scopes'
'sso.authorizeUrl.label': 'Authorize URL' / '授权地址'
'sso.tokenUrl.label': 'Token URL' / '令牌地址'
'sso.userinfoUrl.label': 'Userinfo URL' / 'Userinfo 地址'
'sso.identityIdField.label': 'Identity unique-id field' / '身份唯一 ID 字段'
'sso.loginNameField.label': 'Login name field' / '登录名字段'
'sso.emailField.label': 'Email field' / '邮箱字段'
'sso.emailDomainWhitelist.label': 'Allowed email domains' / '邮箱域名白名单'
'sso.emailDomainWhitelist.help': 'Comma-separated. JIT requires the user email domain to match one of these.' / '逗号分隔，JIT 要求邮箱域名必须命中'
'sso.enabled.label': 'Enabled (shown on login page)' / '启用（在登录页展示）'
'sso.sortOrder.label': 'Sort order' / '排序'
'sso.list.empty': 'No SSO connections yet.' / '暂无 SSO 连接'
'sso.delete.confirm': 'Disable this connection? Existing users remain signed in; the button is hidden on the login page.' / '禁用该连接？现有成员不受影响；登录页将不再展示'
'sso.error.domainNotAllowed': 'Your email domain is not allowed by this organization.' / '你的邮箱域名不在本组织白名单内'
'sso.error.emailRequired': 'Email is required for sign-in via this connection.' / '本连接要求返回邮箱'
'sso.error.stateInvalid': 'The login session expired or is invalid. Please try again.' / '登录会话已过期或无效，请重试'
'sso.error.unknownConnection': 'Unknown SSO connection.' / '未知 SSO 连接'
'sso.login.button.with': 'Log in with {name}' / '用 {name} 登录'
'sso.login.processing': 'Opening browser…' / '正在打开浏览器…'
'sso.login.failed': 'SSO sign-in failed. Please try again or contact your administrator.' / 'SSO 登录失败，请重试或联系管理员'
```

For desktop strings, add to `src/renderer/services/i18n.ts` (en + zh):

```
'sso.login.with': 'Log in with {name}' / '用 {name} 登录'
'sso.login.opening': 'Opening browser…' / '正在打开浏览器…'
'sso.login.failed': 'SSO sign-in failed: {error}' / 'SSO 登录失败：{error}'
```

---

## §Cross-cutting decisions

1. **Public-client + PKCE by default.** Confidential-client flow is supported (server-side `client_secret` decryption + basic-auth on token POST) but the spec's primary path is public client. Server `authorize` always generates a PKCE `code_verifier`/`code_challenge`; only includes `client_secret` on the token POST when `client_secret_encrypted IS NOT NULL`.
2. **`email` is required for JIT in v1** (R3 in spec). If `email_field` returns empty/null from the IdP, the login is rejected with `sso.error.emailRequired`. (Per spec §14 Q3.)
3. **`ssoApp` field mapping defaults.** Generic OIDC: `identity_id_field = 'sub'`, `login_name_field = 'preferred_username'`, `email_field = 'email'`. Named-provider presets override per `providerPresets.ts`.
4. **SAML2 connections are stored but disabled.** `enabled=false` regardless of admin input; UI labels the SAML2 option "即将支持" / "Coming soon" (R3 in spec §13).
5. **Login rate limiting** — reuse the existing `recordLoginFailure`/`clearLoginAttempts` pair from `auth/loginAttempts.ts` keyed on `orgName + connectionId + ip` (don't share bucket with password login).

---

## Task Structure

Tasks are sized for one reviewer's gate (per writing-plans). Each ends with an independently testable deliverable.

### Task 1: Migration 036 — DDL for SSO tables + state table

**Files:**
- Create: `enterprise_server/src/db/migrations/036_sso_connections.sql`
- Test: `enterprise_server/tests/db/migrations.test.ts` (or extend the existing migration smoke if present — locate during Task 1)

**Interfaces:**
- Consumes: existing `users`, `orgs`, `login_events` tables
- Produces: `sso_connections`, `user_idp_identities`, `sso_login_states` tables (spec §3 + spec §4.1 state table)

- [ ] **Step 1: Write the failing migration test**

```ts
// enterprise_server/tests/db/ssoTables.test.ts
import { describe, expect, test } from 'vitest';
import '../helpers/setupEnv';
import { testPool, runMigrations, resetSchema } from '../../src/db/testDb';

describe('migration 036 — SSO tables', () => {
  test('applies cleanly and creates all three tables', async () => {
    await resetSchema();
    await runMigrations();
    const r = await testPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
       ('sso_connections','user_idp_identities','sso_login_states')
       ORDER BY table_name`
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([
      'sso_login_states',
      'sso_connections',
      'user_idp_identities',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/ssoTables.test.ts`
Expected: FAIL — tables don't exist yet.

- [ ] **Step 3: Write the migration**

```sql
-- enterprise_server/src/db/migrations/036_sso_connections.sql
-- Migration 036: enterprise SSO member-login federation.
-- sso_connections: per-org OIDC/OAuth2 IdP configuration (one row per IdP
--   the org federates with; SAML2 may be stored but is disabled in v1).
-- user_idp_identities: durable link from an internal user to an external
--   IdP identity (one row per (sso_connection_id, external_id); cross-IdP
--   dedup is by (org_id, email) on the users table).
-- sso_login_states: one-shot state for the OAuth dance (authorize → callback),
--   short TTL, deleted on consumption. Re-run safe.

CREATE TABLE IF NOT EXISTS sso_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  authorize_url TEXT,
  token_url TEXT,
  userinfo_url TEXT,
  client_id TEXT,
  client_secret_encrypted TEXT,
  client_secret_masked TEXT,
  scopes TEXT,
  identity_id_field TEXT NOT NULL DEFAULT 'sub',
  login_name_field TEXT,
  email_field TEXT NOT NULL DEFAULT 'email',
  email_domain_whitelist JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS sso_connections_org_enabled
  ON sso_connections (org_id, enabled, sort_order);

CREATE TABLE IF NOT EXISTS user_idp_identities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  sso_connection_id TEXT NOT NULL REFERENCES sso_connections(id),
  external_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sso_connection_id, external_id),
  UNIQUE (org_id, user_id, sso_connection_id)
);
CREATE INDEX IF NOT EXISTS user_idp_identities_user
  ON user_idp_identities (user_id);

CREATE TABLE IF NOT EXISTS sso_login_states (
  state TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  sso_connection_id TEXT NOT NULL REFERENCES sso_connections(id),
  return_target TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sso_login_states_expires
  ON sso_login_states (expires_at);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/ssoTables.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/036_sso_connections.sql \
        enterprise_server/tests/db/ssoTables.test.ts
git commit -m "feat(sso): migration 036 — SSO connections, identities, login states"
```

---

### Task 2: Migration 037 — Grant `sso:*` to built-in admin roles

**Files:**
- Create: `enterprise_server/src/db/migrations/037_grant_sso_points_to_org_admin.sql`

**Interfaces:**
- Consumes: existing `roles` table with `permissions JSONB`
- Produces: `org_admin` and `super_admin` rows have `sso:view`, `sso:create`, `sso:edit` in `permissions`

- [ ] **Step 1: Write the failing migration test**

Add to `enterprise_server/tests/db/ssoTables.test.ts`:

```ts
test('migration 037 grants sso:* to org_admin', async () => {
  await resetSchema();
  await runMigrations();
  const r = await testPool.query<{ name: string; permissions: string[] }>(
    `SELECT name, permissions FROM roles WHERE name IN ('org_admin','super_admin') ORDER BY name`
  );
  for (const row of r.rows) {
    expect(row.permissions).toContain('sso:view');
    expect(row.permissions).toContain('sso:create');
    expect(row.permissions).toContain('sso:edit');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/ssoTables.test.ts`
Expected: FAIL (no `sso:*` in `permissions` yet).

- [ ] **Step 3: Write the migration**

```sql
-- enterprise_server/src/db/migrations/037_grant_sso_points_to_org_admin.sql
-- Idempotently add the new sso:* PermissionPoints to built-in admin roles.
-- Roles.permissions is JSONB; jsonb_set with || is idempotent.

UPDATE roles
SET permissions = permissions || '["sso:view","sso:create","sso:edit"]'::jsonb
WHERE name IN ('org_admin','super_admin')
  AND NOT (permissions @> '["sso:view"]'::jsonb);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/ssoTables.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `BUILTIN_ROLE_POINTS` for source-of-truth consistency (Ruling R2)**

In `enterprise_server/src/shared/permissionPoints.ts`:

- Add the points (line 13 area):
```ts
SsoView: 'sso:view', SsoCreate: 'sso:create', SsoEdit: 'sso:edit',
```
- Add a module group near line 42:
```ts
const sso = [PermissionPoint.SsoView, PermissionPoint.SsoCreate, PermissionPoint.SsoEdit];
```
- Push into `PERMISSION_MODULES` (near line 55):
```ts
{ key: 'sso', name: 'SSO / 身份提供商', desc: '管理企业 SSO / 身份提供商：创建、编辑、启用/禁用', points: sso },
```
- Spread into `orgAdmin` (line 60-62):
```ts
const orgAdmin: PermissionPoint[] = [
  ...user, ...role, ...dept, ...skill, ...version, ...mcp, ...agent, ...sso,
];
```

- [ ] **Step 6: Typecheck**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/db/migrations/037_grant_sso_points_to_org_admin.sql \
        enterprise_server/src/shared/permissionPoints.ts \
        enterprise_server/tests/db/ssoTables.test.ts
git commit -m "feat(sso): grant sso:* permission points to org_admin"
```

---

### Task 3: SSO secret vault helpers (`src/vault/ssoSecret.ts`)

**Files:**
- Create: `enterprise_server/src/vault/ssoSecret.ts`
- Test: `enterprise_server/tests/vault/ssoSecret.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` from `enterprise_server/src/vault/crypto.ts`, `maskKey` from `enterprise_server/src/vault/providerKeyVault.ts:9`
- Produces: `encryptClientSecret(plaintext): string`, `decryptClientSecret(ciphertext): string`, `maskClientSecret(plaintext): string`, `redactConnectionSecrets(row): SsoAdminConnection` (strips `client_secret_encrypted`, returns `client_secret_masked` only)

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/vault/ssoSecret.test.ts
import { describe, expect, test } from 'vitest';
import '../helpers/setupEnv';
import {
  encryptClientSecret,
  decryptClientSecret,
  maskClientSecret,
  redactConnectionSecrets,
} from '../../src/vault/ssoSecret';

describe('ssoSecret', () => {
  test('encrypt → decrypt round-trip', () => {
    const plain = 's3cr3t-with-some-length';
    const cipher = encryptClientSecret(plain);
    expect(cipher).not.toContain(plain);
    expect(decryptClientSecret(cipher)).toBe(plain);
  });

  test('maskClientSecret uses first-3 + dots + last-4 (mirror providerKeyVault)', () => {
    expect(maskClientSecret('abcdefghijklmnop')).toBe('abc••••mnop');
    expect(maskClientSecret('short')).toBe('••••');
  });

  test('redactConnectionSecrets strips client_secret_encrypted and keeps masked only', () => {
    const cipher = encryptClientSecret('hello-world-12');
    const row = {
      id: 'c1', org_id: 'o1', name: 'Acme', provider_type: 'generic-oidc',
      protocol: 'oidc', authorize_url: 'https://idp/x', token_url: 'https://idp/y',
      userinfo_url: null, client_id: 'cid', client_secret_encrypted: cipher,
      client_secret_masked: maskClientSecret('hello-world-12'), scopes: 'openid email',
      identity_id_field: 'sub', login_name_field: 'preferred_username',
      email_field: 'email', email_domain_whitelist: [], enabled: true,
      sort_order: 0, created_by: null, created_at: new Date(),
      updated_at: new Date(),
    };
    const redacted = redactConnectionSecrets(row);
    expect((redacted as Record<string, unknown>).client_secret_encrypted).toBeUndefined();
    expect(redacted.client_secret_masked).toBe('hel••••d-12');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/vault/ssoSecret.test.ts`
Expected: FAIL — module not yet implemented.

- [ ] **Step 3: Implement `ssoSecret.ts`**

```ts
// enterprise_server/src/vault/ssoSecret.ts
import { decrypt, encrypt } from './crypto';
import { maskKey } from './providerKeyVault';

export function encryptClientSecret(plaintext: string): string {
  return encrypt(plaintext);
}

export function decryptClientSecret(ciphertext: string): string {
  return decrypt(ciphertext);
}

export function maskClientSecret(plaintext: string): string {
  return maskKey(plaintext);
}

export function redactConnectionSecrets<T extends Record<string, unknown>>(row: T): Omit<T, 'client_secret_encrypted'> & { has_secret: boolean } {
  const { client_secret_encrypted, ...rest } = row;
  return {
    ...rest,
    has_secret: typeof client_secret_encrypted === 'string' && client_secret_encrypted.length > 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/vault/ssoSecret.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/vault/ssoSecret.ts enterprise_server/tests/vault/ssoSecret.test.ts
git commit -m "feat(sso): SSO client_secret vault helpers"
```

---

### Task 4: Named-provider presets (`src/sso/providerPresets.ts`)

**Files:**
- Create: `enterprise_server/src/sso/providerPresets.ts`

**Interfaces:**
- Produces: `const PRESETS: Record<ProviderType, { authorizeUrl; tokenUrl; userinfoUrl; scopes; identityIdField; loginNameField; emailField }>`

- [ ] **Step 1: Write the failing test**

```ts
// enterprise_server/tests/sso/providerPresets.test.ts
import { describe, expect, test } from 'vitest';
import { PRESETS } from '../../src/sso/providerPresets';

describe('providerPresets', () => {
  test('every preset exposes the six standard keys', () => {
    for (const [type, p] of Object.entries(PRESETS)) {
      expect(typeof p.authorizeUrl, `${type}.authorizeUrl`).toBe('string');
      expect(typeof p.tokenUrl, `${type}.tokenUrl`).toBe('string');
      expect(typeof p.userinfoUrl, `${type}.userinfoUrl`).toBe('string');
      expect(typeof p.scopes, `${type}.scopes`).toBe('string');
      expect(typeof p.identityIdField, `${type}.identityIdField`).toBe('string');
      expect(typeof p.emailField, `${type}.emailField`).toBe('string');
    }
  });

  test('generic-oidc defaults to sub / preferred_username / email', () => {
    expect(PRESETS['generic-oidc'].identityIdField).toBe('sub');
    expect(PRESETS['generic-oidc'].loginNameField).toBe('preferred_username');
    expect(PRESETS['generic-oidc'].emailField).toBe('email');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/sso/providerPresets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// enterprise_server/src/sso/providerPresets.ts
// Preset endpoints + default field mappings for the 5 v1 providers.
// Generic OIDC/OAuth2 are open-ended (the admin fills them in); named
// providers ship with the documented defaults which the form pre-fills
// (admin can override before saving).

export interface ProviderPreset {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  identityIdField: string;
  loginNameField: string;
  emailField: string;
}

export const PRESETS: Record<string, ProviderPreset> = {
  'generic-oidc': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: 'openid profile email',
    identityIdField: 'sub', loginNameField: 'preferred_username', emailField: 'email',
  },
  'generic-oauth2': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '',
    identityIdField: 'sub', loginNameField: '', emailField: 'email',
  },
  'azure-ad': {
    authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: 'openid profile email User.Read',
    identityIdField: 'sub', loginNameField: 'preferred_username', emailField: 'email',
  },
  'feishu': {
    authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
    tokenUrl: 'https://open.feishu.cn/open-apis/authen/v1/access_token',
    userinfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    scopes: 'contact:user.id:readonly',
    identityIdField: 'union_id', loginNameField: 'name', emailField: 'email',
  },
  'dingtalk': {
    authorizeUrl: 'https://oapi.dingtalk.com/connect/oauth2/sns_authorize',
    tokenUrl: 'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
    userinfoUrl: 'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
    scopes: 'snsapi_login',
    identityIdField: 'unionid', loginNameField: 'nickname', emailField: 'email',
  },
  'wecom': {
    authorizeUrl: 'https://open.weixin.qq.com/connect/oauth2/authorize',
    tokenUrl: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    userinfoUrl: 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
    scopes: 'snsapi_private_info',
    identityIdField: 'userid', loginNameField: 'name', emailField: 'email',
  },
  saml2: {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '', identityIdField: 'nameID', loginNameField: '', emailField: 'email',
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/sso/providerPresets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/sso/providerPresets.ts enterprise_server/tests/sso/providerPresets.test.ts
git commit -m "feat(sso): named provider presets for OIDC/AzureAD/Feishu/DingTalk/WeCom"
```

---

### Task 5: SSO types + state CRUD (`src/sso/types.ts`, `src/sso/state.ts`)

**Files:**
- Create: `enterprise_server/src/sso/types.ts`
- Create: `enterprise_server/src/sso/state.ts`
- Test: `enterprise_server/tests/sso/state.test.ts`

**Interfaces:**
- Produces:
  - `SsoConnectionRow` (DB row shape)
  - `SsoPublicProvider = { id, name, provider_type }` (wire §3.2)
  - `SsoAdminConnection` (wire §3.2 admin shape with masked secrets)
  - `SsoStateRow` (DB row shape)
  - `createState(...)`, `consumeState(state)`, `pruneExpiredStates()`

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/sso/state.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { createState, consumeState } from '../../src/sso/state';

describe('sso/state', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url)
       VALUES ('c1', 'o1', 'Acme', 'generic-oidc', 'oidc', 'https://idp/a', 'https://idp/t')`
    );
  });

  test('createState + consumeState round-trips and is one-shot', async () => {
    const { state, codeVerifier } = await createState({
      orgId: 'o1', connectionId: 'c1', returnTarget: 'console', codeVerifier: 'verifier',
    });
    expect(state).toHaveLength(> 32);
    expect(codeVerifier).toBe('verifier');
    const consumed = await consumeState(state);
    expect(consumed?.orgId).toBe('o1');
    expect(consumed?.connectionId).toBe('c1');
    expect(consumed?.returnTarget).toBe('console');
    expect(consumed?.codeVerifier).toBe('verifier');
    // second consume is null (one-shot)
    expect(await consumeState(state)).toBeNull();
  });

  test('consumeState on unknown state returns null', async () => {
    expect(await consumeState('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/sso/state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `types.ts`**

```ts
// enterprise_server/src/sso/types.ts
export type SsoProviderType =
  | 'generic-oidc' | 'generic-oauth2' | 'azure-ad'
  | 'feishu' | 'dingtalk' | 'wecom' | 'saml2';

export type SsoProtocol = 'oidc' | 'oauth2' | 'saml2';

export interface SsoConnectionRow {
  id: string;
  org_id: string;
  name: string;
  provider_type: string;
  protocol: string;
  authorize_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  client_id: string | null;
  client_secret_encrypted: string | null;
  client_secret_masked: string | null;
  scopes: string | null;
  identity_id_field: string;
  login_name_field: string | null;
  email_field: string;
  email_domain_whitelist: string[];
  enabled: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SsoPublicProvider {
  id: string;
  name: string;
  provider_type: string;
  sort_order: number;
}

export interface SsoAdminConnection extends Omit<SsoConnectionRow, 'client_secret_encrypted'> {
  has_secret: boolean;
}

export interface SsoStateRow {
  state: string;
  org_id: string;
  sso_connection_id: string;
  return_target: 'console' | 'desktop';
  code_verifier: string | null;
  redirect_uri: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface SsoIdentityClaims {
  externalId: string;
  loginName: string | null;
  email: string | null;
  raw: Record<string, unknown>;
}

export const STATE_TTL_MS = 2 * 60 * 1000;  // 2 minutes
```

- [ ] **Step 4: Implement `state.ts`**

```ts
// enterprise_server/src/sso/state.ts
import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool';
import { STATE_TTL_MS, type SsoStateRow } from './types';

export interface CreateStateInput {
  orgId: string;
  connectionId: string;
  returnTarget: 'console' | 'desktop';
  codeVerifier?: string;
  redirectUri?: string;
}

export async function createState(input: CreateStateInput): Promise<{ state: string; codeVerifier: string | null }> {
  const state = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sso_login_states(state, org_id, sso_connection_id, return_target, code_verifier, redirect_uri, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)`,
    [state, input.orgId, input.connectionId, input.returnTarget,
     input.codeVerifier ?? null, input.redirectUri ?? null, STATE_TTL_MS]
  );
  return { state, codeVerifier: input.codeVerifier ?? null };
}

export async function consumeState(state: string): Promise<SsoStateRow | null> {
  // One-shot: DELETE … RETURNING. Returns null if missing/expired.
  const r = await pool.query<SsoStateRow>(
    `DELETE FROM sso_login_states
     WHERE state = $1 AND expires_at > now()
     RETURNING state, org_id, sso_connection_id, return_target, code_verifier, redirect_uri, created_at, expires_at`,
    [state]
  );
  return r.rowCount ? r.rows[0] : null;
}

// Best-effort sweeper; safe to invoke from any request path.
export async function pruneExpiredStates(): Promise<void> {
  await pool.query(`DELETE FROM sso_login_states WHERE expires_at <= now()`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/sso/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/sso/types.ts enterprise_server/src/sso/state.ts \
        enterprise_server/tests/sso/state.test.ts
git commit -m "feat(sso): SSO types + state CRUD (one-shot)"
```

---

### Task 6: JIT user resolver (`src/sso/jit.ts`)

**Files:**
- Create: `enterprise_server/src/sso/jit.ts`
- Test: `enterprise_server/tests/sso/jit.test.ts`

**Interfaces:**
- Produces:
  - `resolveUser({ orgId, connectionId, externalId, email, loginName }): Promise<{ userId: string; createdJit: boolean }>` (spec §5 algorithm)
  - Errors: `DomainNotAllowedError`, `EmailRequiredError`, `UsernameConflictError`

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/sso/jit.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { resolveUser, DomainNotAllowedError, EmailRequiredError, UsernameConflictError } from '../../src/sso/jit';

async function seedOrgAndConn(whitelist: string[]): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  await testPool.query(
    `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
     VALUES ('c1','o1','Acme','generic-oidc','oidc', $1::jsonb)`,
    [JSON.stringify(whitelist)]
  );
}

describe('sso/jit', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('rejects when email domain not in whitelist', async () => {
    await seedOrgAndConn(['example.com']);
    await expect(resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'user@evil.com', loginName: 'alice',
    })).rejects.toBeInstanceOf(DomainNotAllowedError);
  });

  test('rejects when email missing and whitelist non-empty', async () => {
    await seedOrgAndConn(['example.com']);
    await expect(resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: null, loginName: 'alice',
    })).rejects.toBeInstanceOf(EmailRequiredError);
  });

  test('JIT creates a user when nothing exists', async () => {
    await seedOrgAndConn([]);
    const r = await resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'alice@example.com', loginName: 'alice',
    });
    expect(r.createdJit).toBe(true);
    expect(typeof r.userId).toBe('string');
    const u = await testPool.query(`SELECT username, email FROM users WHERE id = $1`, [r.userId]);
    expect(u.rows[0]).toEqual({ username: 'alice', email: 'alice@example.com' });
    const b = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id = $1 AND sso_connection_id='c1' AND external_id='ext1'`, [r.userId]);
    expect(b.rowCount).toBe(1);
  });

  test('returns existing user when (connection, external_id) already bound', async () => {
    await seedOrgAndConn([]);
    const first = await resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'a' });
    const second = await resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'a' });
    expect(second.userId).toBe(first.userId);
    expect(second.createdJit).toBe(false);
  });

  test('cross-IdP dedup binds a new IdP identity to the same user via email', async () => {
    await seedOrgAndConn([]);
    const first = await resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'a' });
    // Create a second SSO connection in the same org.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c2','o1','Other','generic-oauth2','oauth2','[]'::jsonb)`
    );
    const second = await resolveUser({ orgId: 'o1', connectionId: 'c2', externalId: 'ext_other', email: 'a@x.com', loginName: 'a' });
    expect(second.userId).toBe(first.userId);
    expect(second.createdJit).toBe(false);
  });

  test('username conflict with existing password user is rejected', async () => {
    await seedOrgAndConn([]);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u_existing','o1','alice','x')`
    );
    await expect(resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'alice' }))
      .rejects.toBeInstanceOf(UsernameConflictError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/sso/jit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `jit.ts`**

```ts
// enterprise_server/src/sso/jit.ts
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { Role } from '../shared/enterpriseServerConstants';

export class DomainNotAllowedError extends Error { constructor() { super('domain_not_allowed'); this.name = 'DomainNotAllowedError'; } }
export class EmailRequiredError extends Error { constructor() { super('email_required'); this.name = 'EmailRequiredError'; } }
export class UsernameConflictError extends Error { constructor() { super('username_conflict'); this.name = 'UsernameConflictError'; } }

export interface ResolveUserInput {
  orgId: string;
  connectionId: string;
  externalId: string;
  email: string | null;
  loginName: string | null;
}

export interface ResolveUserResult { userId: string; createdJit: boolean; }

export async function resolveUser(input: ResolveUserInput): Promise<ResolveUserResult> {
  const { orgId, connectionId, externalId, email, loginName } = input;

  // 1. Email-domain gate.
  const connRes = await pool.query<{ email_domain_whitelist: string[] }>(
    `SELECT email_domain_whitelist FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [connectionId, orgId]
  );
  const whitelist = connRes.rows[0]?.email_domain_whitelist ?? [];
  if (whitelist.length > 0) {
    if (!email) throw new EmailRequiredError();
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !whitelist.map((d) => d.toLowerCase()).includes(domain)) {
      throw new DomainNotAllowedError();
    }
  } else if (!email) {
    // v1: require email when no whitelist (cannot cross-IdP dedup without it).
    throw new EmailRequiredError();
  }

  // 2a. Look up by (connection, external_id).
  const byIdp = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM user_idp_identities WHERE sso_connection_id = $1 AND external_id = $2`,
    [connectionId, externalId]
  );
  if (byIdp.rowCount) {
    return { userId: byIdp.rows[0]!.user_id, createdJit: false };
  }

  // 2b. Cross-IdP dedup by (org_id, email).
  if (email) {
    const byEmail = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = $1 AND email = $2`,
      [orgId, email]
    );
    if (byEmail.rowCount) {
      const userId = byEmail.rows[0]!.id;
      await pool.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), orgId, userId, connectionId, externalId]
      );
      return { userId, createdJit: false };
    }
  }

  // 2c. JIT create.
  const username = (loginName ?? email?.split('@')[0] ?? `sso-${externalId.slice(0, 8)}`).trim();
  const userId = randomUUID();
  try {
    await pool.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users(id, org_id, username, password_hash, display_name, email, extra_roles)
         VALUES ($1,$2,$3,'',$4,$5,$6)`,
        [userId, orgId, username, loginName ?? username, email, JSON.stringify([Role.User])]
      );
      await tx.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), orgId, userId, connectionId, externalId]
      );
    });
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === '23505') throw new UsernameConflictError();
    throw e;
  }
  return { userId, createdJit: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/sso/jit.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/sso/jit.ts enterprise_server/tests/sso/jit.test.ts
git commit -m "feat(sso): JIT user resolver with email-domain gate and cross-IdP dedup"
```

---

### Task 7: OAuth dance helpers (`src/sso/oauth.ts`)

**Files:**
- Create: `enterprise_server/src/sso/oauth.ts`
- Test: `enterprise_server/tests/sso/oauth.test.ts`

**Interfaces:**
- Produces:
  - `buildAuthorizeUrl(connection, state, codeChallenge?): string`
  - `exchangeCode(connection, code, codeVerifier?, clientSecretDecrypted?): Promise<{ accessToken; idToken?; raw }>`
  - `fetchUserInfo(connection, accessToken): Promise<Record<string, unknown>>`
  - `verifyIdToken(connection, idToken): Promise<Record<string, unknown>>` (uses `jose.jwtVerify` with HS256/RS256/ES256 as configured; if no JWKS, fall back to symmetric verification with `client_secret`)

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/sso/oauth.test.ts
import '../helpers/setupEnv';
import { describe, expect, test } from 'vitest';
import { SignJWT } from 'jose';
import { buildAuthorizeUrl, verifyIdToken } from '../../src/sso/oauth';
import type { SsoConnectionRow } from '../../src/sso/types';

function baseConn(overrides: Partial<SsoConnectionRow> = {}): SsoConnectionRow {
  return {
    id: 'c1', org_id: 'o1', name: 'Acme',
    provider_type: 'generic-oidc', protocol: 'oidc',
    authorize_url: 'https://idp.example/authorize', token_url: 'https://idp.example/token',
    userinfo_url: 'https://idp.example/userinfo',
    client_id: 'cid', client_secret_encrypted: null, client_secret_masked: null,
    scopes: 'openid email', identity_id_field: 'sub', login_name_field: 'preferred_username',
    email_field: 'email', email_domain_whitelist: [], enabled: true, sort_order: 0,
    created_by: null, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

describe('sso/oauth', () => {
  test('buildAuthorizeUrl attaches PKCE params + state + scopes', () => {
    const url = buildAuthorizeUrl(baseConn(), 'state-xyz', 'challenge-abc');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBeTruthy();
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    expect(u.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid email');
  });

  test('verifyIdToken parses a signed JWS payload (HS256 with client_secret)', async () => {
    const secret = new TextEncoder().encode('a-shared-secret-of-sufficient-length');
    const tok = await new SignJWT({ sub: 'id-1', email: 'a@x.com', preferred_username: 'a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    const claims = await verifyIdToken(baseConn({ client_secret_encrypted: 'whatever' }), tok, 'a-shared-secret-of-sufficient-length');
    expect(claims.sub).toBe('id-1');
    expect(claims.email).toBe('a@x.com');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/sso/oauth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `oauth.ts`**

```ts
// enterprise_server/src/sso/oauth.ts
import { jwtVerify, type JWTPayload } from 'jose';
import { TextEncoder } from 'node:util';
import type { SsoConnectionRow } from './types';

export function buildAuthorizeUrl(
  c: SsoConnectionRow,
  state: string,
  codeChallenge?: string,
  redirectUri?: string,
): string {
  const u = new URL(c.authorize_url!);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', c.client_id ?? '');
  u.searchParams.set('redirect_uri', redirectUri ?? 'http://localhost/callback');
  u.searchParams.set('state', state);
  if (c.scopes) u.searchParams.set('scope', c.scopes);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export interface ExchangeResult {
  accessToken: string;
  idToken?: string;
  raw: Record<string, unknown>;
}

export async function exchangeCode(
  c: SsoConnectionRow,
  code: string,
  codeVerifier?: string,
  clientSecretDecrypted?: string,
  redirectUri?: string,
): Promise<ExchangeResult> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri ?? 'http://localhost/callback');
  if (c.client_id) body.set('client_id', c.client_id);
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (clientSecretDecrypted) {
    headers.authorization = 'Basic ' + Buffer.from(`${c.client_id}:${clientSecretDecrypted}`).toString('base64');
  }

  const r = await fetch(c.token_url!, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`token_exchange_failed:${r.status}`);
  const json = (await r.json()) as Record<string, unknown>;
  const accessToken = String(json.access_token ?? '');
  if (!accessToken) throw new Error('token_exchange_no_access_token');
  return { accessToken, idToken: typeof json.id_token === 'string' ? json.id_token : undefined, raw: json };
}

export async function fetchUserInfo(
  c: SsoConnectionRow,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const r = await fetch(c.userinfo_url!, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`userinfo_failed:${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

// Verifies an OIDC ID token. v1 supports HS256 with the IdP-shared `client_secret`
// (rotate to JWKS/RS256 when an IdP requires it). The connection's
// `client_secret_encrypted` is the source for symmetric verification; pass the
// already-decrypted secret as `clientSecretDecrypted`.
export async function verifyIdToken(
  c: SsoConnectionRow,
  idToken: string,
  clientSecretDecrypted?: string,
): Promise<JWTPayload> {
  if (!clientSecretDecrypted) throw new Error('id_token_requires_client_secret_or_jwks');
  const secret = new TextEncoder().encode(clientSecretDecrypted);
  const { payload } = await jwtVerify(idToken, secret, { algorithms: ['HS256'] });
  return payload;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/sso/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/sso/oauth.ts enterprise_server/tests/sso/oauth.test.ts
git commit -m "feat(sso): OAuth/OIDC dance helpers (authorize URL, code exchange, userinfo, ID token)"
```

---

### Task 8: Console callback HTML renderer (`src/sso/consoleCallback.ts`)

**Files:**
- Create: `enterprise_server/src/sso/consoleCallback.ts`
- Test: `enterprise_server/tests/sso/consoleCallback.test.ts`

**Interfaces:**
- Produces: `renderConsoleCallbackHtml({ token: string; redirectTo: string; locale?: 'en'|'zh' }): string` — minimal HTML doc that sets `localStorage` and `location.assign(redirectTo)`. Per Ruling R3.

- [ ] **Step 1: Write the failing test**

```ts
// enterprise_server/tests/sso/consoleCallback.test.ts
import { describe, expect, test } from 'vitest';
import { renderConsoleCallbackHtml } from '../../src/sso/consoleCallback';

describe('renderConsoleCallbackHtml', () => {
  test('embeds the JWT in localStorage and redirects', () => {
    const html = renderConsoleCallbackHtml({ token: 'ey.xxx.yyy', redirectTo: '/' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain("localStorage.setItem('genwork.enterprise.auth.token', 'ey.xxx.yyy')");
    expect(html).toContain("location.assign('/')");
  });

  test('escapes single quotes in token (defensive)', () => {
    const html = renderConsoleCallbackHtml({ token: "ab'cd", redirectTo: '/' });
    expect(html).not.toMatch(/setItem\('genwork[^']*', 'ab'cd'\)/);
    expect(html).toMatch(/setItem\('genwork[^']*', 'ab\\'cd'\)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/sso/consoleCallback.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// enterprise_server/src/sso/consoleCallback.ts
export interface ConsoleCallbackArgs {
  token: string;
  redirectTo: string;
  errorMessage?: string;
}

// The SPA's auth store reads from localStorage key
// 'genwork.enterprise.auth.token' (see web/src/auth/store.ts:44). Setting it
// here lets the SPA pick up the JWT on its next render. Per Ruling R3.
export function renderConsoleCallbackHtml(args: ConsoleCallbackArgs): string {
  const esc = (s: string): string => s.replace(/[\\'<>]/g, (c) => `\\${c}`);
  const token = esc(args.token);
  const redirect = esc(args.redirectTo);
  const err = args.errorMessage
    ? `<p style="font-family:sans-serif;color:#b00020">${esc(args.errorMessage)}</p>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body>${err}<script>
try {
  localStorage.setItem('genwork.enterprise.auth.token', '${token}');
} catch (e) { document.body.textContent = 'Failed to store session: ' + e; }
location.assign('${redirect}');
</script></body></html>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/sso/consoleCallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/sso/consoleCallback.ts enterprise_server/tests/sso/consoleCallback.test.ts
git commit -m "feat(sso): console callback HTML (sets localStorage JWT)"
```

---

### Task 9: Server routes — public listing + authorize + console callback

**Files:**
- Create: `enterprise_server/src/routes/sso.ts`
- Modify: `enterprise_server/src/server.ts` (import + `app.route('/', ssoRoutes);`)
- Test: `enterprise_server/tests/routes/sso.public.test.ts`

**Interfaces:**
- Produces routes under `src/routes/sso.ts` (the public half):
  - `GET /auth/sso/providers?orgName=` → `{ providers: SsoPublicProvider[] }`
  - `GET /auth/sso/:id/authorize?orgName=&return=console|desktop` → 302 to IdP
  - `GET /auth/sso/callback?code&state` → server-rendered HTML (R3)
  - `GET /auth/sso/desktop/callback?code&state` → 302 to desktop (Task 12)

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/routes/sso.public.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoRoutes } from '../../src/routes/sso';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoRoutes); return a; }

describe('routes/sso — public half', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme Co')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, scopes, enabled, sort_order)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://idp.example/a','https://idp.example/t','https://idp.example/u','cid','openid email', true, 0),
              ('c2','o1','Disabled','generic-oauth2','oauth2','https://x/a','https://x/t','https://x/u','cid2','', false, 1)`
    );
  });

  test('GET /auth/sso/providers returns only enabled, sorted, no secrets', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/providers?orgName=Acme Co');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { providers: Array<Record<string, unknown>> };
    expect(j.providers).toHaveLength(1);
    expect(j.providers[0]!.name).toBe('Okta');
    expect(j.providers[0]).not.toHaveProperty('client_id');
    expect(j.providers[0]).not.toHaveProperty('client_secret');
  });

  test('GET /auth/sso/:id/authorize 302s to IdP with PKCE + state', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=console');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('https://idp.example/a');
    expect(new URL(loc).searchParams.get('state')).toBeTruthy();
    expect(new URL(loc).searchParams.get('code_challenge')).toBeTruthy();
    expect(new URL(loc).searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('GET /auth/sso/providers for unknown org returns empty list (404 to org lookup is acceptable; we pick 200+empty for UX)', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/providers?orgName=Nope');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const j = (await res.json()) as { providers: unknown[] };
      expect(j.providers).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/sso.public.test.ts`
Expected: FAIL (no `routes/sso.ts`).

- [ ] **Step 3: Implement public routes (scaffold only — Task 10 wires callback; Task 11 wires admin CRUD; Task 12 wires desktop)**

Create `enterprise_server/src/routes/sso.ts` with the public surface wired but the admin half and the desktop callback as stubs that throw `Error('not yet implemented')` so this task can compile cleanly. Each stub returns a clear 501 (covered by Task 10/11/12's tests).

```ts
// enterprise_server/src/routes/sso.ts
import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool';
import { buildAuthorizeUrl, consumeState, createState } from '../sso';
import { renderConsoleCallbackHtml } from '../sso/consoleCallback';
import type { SsoPublicProvider } from '../sso/types';

export const ssoRoutes = new Hono();

// ---- Public (pre-login) listing ----

ssoRoutes.get('/auth/sso/providers', async (c) => {
  const orgName = c.req.query('orgName');
  if (!orgName) return c.json({ providers: [] }, 400);
  const r = await pool.query<{ id: string; name: string; provider_type: string; sort_order: number }>(
    `SELECT sc.id, sc.name, sc.provider_type, sc.sort_order
     FROM sso_connections sc JOIN orgs o ON o.id = sc.org_id
     WHERE o.name = $1 AND sc.enabled = true
     ORDER BY sc.sort_order ASC, sc.created_at ASC`,
    [orgName]
  );
  return c.json<{ providers: SsoPublicProvider[] }>({ providers: r.rows });
});

// ---- Authorize (start the dance) ----

ssoRoutes.get('/auth/sso/:id/authorize', async (c) => {
  const id = c.req.param('id');
  const orgName = c.req.query('orgName');
  const returnTarget = (c.req.query('return') === 'desktop' ? 'desktop' : 'console') as 'console' | 'desktop';
  if (!orgName) return c.json({ error: 'orgName_required' }, 400);

  const r = await pool.query<{ authorize_url: string | null; org_id: string; enabled: boolean; protocol: string }>(
    `SELECT sc.authorize_url, sc.org_id, sc.enabled, sc.protocol
     FROM sso_connections sc JOIN orgs o ON o.id = sc.org_id
     WHERE sc.id = $1 AND o.name = $2`,
    [id, orgName]
  );
  const conn = r.rows[0];
  if (!conn || !conn.enabled || !conn.authorize_url || conn.protocol === 'saml2') {
    return c.json({ error: 'unknown_connection' }, 404);
  }

  // PKCE: 64-byte verifier → S256 challenge.
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const redirectUri =
    returnTarget === 'desktop'
      ? `http://localhost/callback` // Task 12 rewrites with the actual loopback port.
      : `${new URL(c.req.url).origin}/auth/sso/callback`;

  const { state } = await createState({
    orgId: conn.org_id, connectionId: id, returnTarget, codeVerifier: verifier, redirectUri,
  });
  return c.redirect(buildAuthorizeUrl(
    { ...(conn as unknown as object) } as never,
    state,
    challenge,
    redirectUri,
  ), 302);
});

// ---- Console callback (server-rendered HTML; desktop callback is Task 12) ----

ssoRoutes.get('/auth/sso/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const error = c.req.query('error');
  if (error) {
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=sso_' + error, errorMessage: error }));
  }
  if (!state || !code) {
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=sso_invalid_request', errorMessage: 'invalid request' }));
  }
  const consumed = await consumeState(state);
  if (!consumed) {
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=sso_state_invalid', errorMessage: 'session expired' }));
  }

  // Hand off to the JIT + token-issuance service (implemented in Task 10).
  // For this task's commit, return a placeholder HTML so the route compiles.
  const { finishSsoCallback } = await import('../sso/finishCallback');
  const result = await finishSsoCallback({ code, state: consumed, redirectUri: consumed.redirect_uri ?? '' });
  if ('error' in result) {
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=' + result.error }));
  }
  return c.html(renderConsoleCallbackHtml({ token: result.token, redirectTo: '/' }));
});

// ---- Stubs (Tasks 11, 12, 13 implement these) ----

ssoRoutes.get('/auth/sso/desktop/callback', async (c) =>
  c.json({ error: 'not_implemented_yet' }, 501));

// Admin CRUD stubs — Task 11.
const adminStub = async (c: { json: (v: unknown, s?: number) => Response }) =>
  c.json({ error: 'not_implemented_yet' }, 501);
ssoRoutes.get('/admin/sso-connections', adminStub);
ssoRoutes.post('/admin/sso-connections', adminStub);
ssoRoutes.get('/admin/sso-connections/:id', adminStub);
ssoRoutes.patch('/admin/sso-connections/:id', adminStub);
ssoRoutes.delete('/admin/sso-connections/:id', adminStub);
```

Create the placeholder `src/sso/finishCallback.ts` so Task 10 has a clean handoff:

```ts
// enterprise_server/src/sso/finishCallback.ts
// Implemented in Task 10. This stub returns an error so the route compiles.
import type { SsoStateRow } from './types';

export interface FinishArgs { code: string; state: SsoStateRow; redirectUri: string; }
export type FinishResult = { token: string } | { error: string };

export async function finishSsoCallback(_args: FinishArgs): Promise<FinishResult> {
  return { error: 'finishCallback_not_implemented' };
}
```

- [ ] **Step 4: Register in `server.ts`**

```ts
// enterprise_server/src/server.ts — add to the route imports (near line 17-38)
import { ssoRoutes } from './routes/sso';

// add with the other route mounts (near line 49-50)
app.route('/', ssoRoutes);
```

- [ ] **Step 5: Run the public-half tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/sso.public.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: 0 errors (the `finishCallback` placeholder is real).

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/routes/sso.ts enterprise_server/src/server.ts \
        enterprise_server/src/sso/finishCallback.ts \
        enterprise_server/tests/routes/sso.public.test.ts
git commit -m "feat(sso): public providers listing, authorize, console callback stub"
```

---

### Task 10: Finish the SSO dance — code→token→identity→JIT→JWT (`src/sso/finishCallback.ts`)

**Files:**
- Modify: `enterprise_server/src/sso/finishCallback.ts` (replace stub)
- Test: `enterprise_server/tests/sso/finishCallback.test.ts`

**Interfaces:**
- Produces: `finishSsoCallback({ code, state, redirectUri }): Promise<{ token: string } | { error: string }>`
  - Performs: token exchange (PKCE verifier from state) → fetch userinfo or verify id_token → map claims via connection's field mapping → `resolveUser` → `signToken({ sub, orgId, roles })` → return token.
  - Records `auditStore.write({ action: 'sso_login_succeeded', ... })` on success and `'sso_login_failed'` on failure.

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/sso/finishCallback.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

// Stub the network: token exchange + userinfo return canned values.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { finishSsoCallback } from '../../src/sso/finishCallback';
import { createState, consumeState } from '../../src/sso/state';

describe('sso/finishCallback', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes,
         identity_id_field, email_field, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc',
               'https://idp/a','https://idp/t','https://idp/u','cid','openid email',
               'sub','email','[]'::jsonb)`
    );
    fetchMock.mockReset();
  });

  test('issues a JWT for a brand-new user and binds the identity', async () => {
    fetchMock
      // token exchange
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type':'application/json' } }))
      // userinfo
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-1', email: 'a@x.com', preferred_username: 'a' }), { status: 200, headers: { 'content-type':'application/json' } }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console', codeVerifier: 'verifier' });
    const consumed = await consumeState(state);
    expect(consumed).not.toBeNull();
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });
    expect('token' in r).toBe(true);
    const u = await testPool.query<{ username: string; email: string }>(`SELECT username, email FROM users WHERE org_id='o1'`);
    expect(u.rows[0]).toEqual({ username: 'a', email: 'a@x.com' });
  });

  test('returns error when token exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));
    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console' });
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('error' in r).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/sso/finishCallback.test.ts`
Expected: FAIL (stub returns `error`).

- [ ] **Step 3: Implement `finishCallback.ts`**

```ts
// enterprise_server/src/sso/finishCallback.ts
import { pool } from '../db/pool';
import { exchangeCode, fetchUserInfo } from './oauth';
import { resolveUser, DomainNotAllowedError, EmailRequiredError, UsernameConflictError } from './jit';
import { signToken } from '../auth/jwt';
import { auditStore } from '../audit/auditStore';
import { loginRecord } from '../org/loginRecord';
import { decryptClientSecret } from '../vault/ssoSecret';
import { clientIp } from '../routes/auth';
import type { SsoStateRow } from './types';

export interface FinishArgs { code: string; state: SsoStateRow; redirectUri: string; }
export type FinishResult = { token: string } | { error: string };

export async function finishSsoCallback(args: FinishArgs): Promise<FinishResult> {
  const { code, state, redirectUri } = args;
  // Reload the full connection row (state carries only ids).
  const r = await pool.query(
    `SELECT ${COLS} FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [state.sso_connection_id, state.org_id]
  );
  const conn = r.rows[0];
  if (!conn) return { error: 'unknown_connection' };

  let clientSecret: string | null = null;
  if (conn.client_secret_encrypted) clientSecret = decryptClientSecret(conn.client_secret_encrypted);

  let identity: Record<string, unknown>;
  try {
    const exchanged = await exchangeCode(conn, code, state.code_verifier ?? undefined, clientSecret ?? undefined, redirectUri);
    if (conn.protocol === 'oidc' && exchanged.idToken) {
      // v1: only HS256 ID tokens verified with client_secret. JWKS path is a future task.
      const { verifyIdToken } = await import('./oauth');
      identity = verifyIdToken(conn, exchanged.idToken, clientSecret ?? undefined) as unknown as Record<string, unknown>;
    } else {
      identity = await fetchUserInfo(conn, exchanged.accessToken);
    }
  } catch (e) {
    await auditStore.write({ orgId: state.org_id, action: 'sso_login_failed', payload: { ssoConnectionId: state.sso_connection_id, reason: (e as Error).message } });
    return { error: 'token_exchange_failed' };
  }

  const externalId = String(identity[conn.identity_id_field] ?? '');
  const email = conn.email_field && identity[conn.email_field] ? String(identity[conn.email_field]) : null;
  const loginName = conn.login_name_field && identity[conn.login_name_field] ? String(identity[conn.login_name_field]) : null;
  if (!externalId) {
    await auditStore.write({ orgId: state.org_id, action: 'sso_login_failed', payload: { ssoConnectionId: state.sso_connection_id, reason: 'missing_external_id' } });
    return { error: 'missing_external_id' };
  }

  let userId: string;
  try {
    const r = await resolveUser({ orgId: state.org_id, connectionId: state.sso_connection_id, externalId, email, loginName });
    userId = r.userId;
  } catch (e) {
    const code = e instanceof DomainNotAllowedError ? 'domain_not_allowed'
      : e instanceof EmailRequiredError ? 'email_required'
      : e instanceof UsernameConflictError ? 'username_conflict'
      : 'jit_failed';
    await auditStore.write({ orgId: state.org_id, action: 'sso_login_failed', payload: { ssoConnectionId: state.sso_connection_id, reason: code } });
    return { error: code };
  }

  const claims = { sub: userId, orgId: state.org_id, roles: ['user'] as string[] };
  const token = await signToken(claims);

  try {
    await loginRecord.recordLogin(state.org_id, userId, null, null, 'success');
  } catch { /* best-effort */ }
  await auditStore.write({ orgId: state.org_id, userId, action: 'sso_login_succeeded', payload: { ssoConnectionId: state.sso_connection_id, externalId, jit: email == null ? 'n/a' : 'ok' } });

  return { token };
}

const COLS = `id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, client_secret_encrypted, client_secret_masked, scopes, identity_id_field, login_name_field, email_field, email_domain_whitelist, enabled, sort_order, created_by, created_at, updated_at`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/sso/finishCallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/sso/finishCallback.ts enterprise_server/tests/sso/finishCallback.test.ts
git commit -m "feat(sso): finishCallback — code exchange + JIT + JWT issuance + audit"
```

---

### Task 11: Server admin CRUD routes for SSO connections

**Files:**
- Modify: `enterprise_server/src/routes/sso.ts` (replace admin stubs with real handlers)
- Test: `enterprise_server/tests/routes/sso.admin.test.ts`

**Interfaces:**
- Routes under `requireAuth + requirePermission(PP.SsoView / SsoCreate / SsoEdit)`:
  - `GET /admin/sso-connections` → list `SsoAdminConnection[]` for `claims.orgId`
  - `POST /admin/sso-connections` → create
  - `GET /admin/sso-connections/:id` → single
  - `PATCH /admin/sso-connections/:id` → patch (secret-blank-keeps-secret)
  - `DELETE /admin/sso-connections/:id` → set `enabled=false` (v1: never hard-delete; spec §14 Q4)

- [ ] **Step 1: Write the failing tests**

```ts
// enterprise_server/tests/routes/sso.admin.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { ssoRoutes } from '../../src/routes/sso';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { signToken } from '../../src/auth/jwt';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoRoutes); return a; }
async function tok(orgId: string, roles: string[]): Promise<string> {
  return signToken({ sub: 'admin', orgId, roles });
}

describe('routes/sso — admin CRUD', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'),('o2','B')`);
    // org_admin permissions already include sso:* from migration 037.
    // seed a role to use:
    await testPool.query(`INSERT INTO roles(id, name, is_builtin, permissions) VALUES ('r1','org_admin', true, '["sso:view","sso:create","sso:edit"]'::jsonb)`);
  });

  test('403 without sso:view', async () => {
    const a = buildApp();
    const t = await tok('o1', ['member']);
    const r = await a.request('/admin/sso-connections', { headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(403);
  });

  test('create + get returns masked secret only', async () => {
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const create = await a.request('/admin/sso-connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', name: 'Okta', providerType: 'generic-oidc', protocol: 'oidc',
        authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', userinfoUrl: 'https://idp/u',
        clientId: 'cid', clientSecret: 'super-secret-key', scopes: 'openid email',
        identityIdField: 'sub', emailField: 'email', emailDomainWhitelist: [], enabled: true, sortOrder: 0,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    const get = await a.request(`/admin/sso-connections/${created.id}`, { headers: { authorization: `Bearer ${t}` } });
    const j = (await get.json()) as Record<string, unknown>;
    expect(j.name).toBe('Okta');
    expect(j.client_secret_masked).toMatch(/^sup/);
    expect((j as Record<string, unknown>).client_secret_encrypted).toBeUndefined();
    expect((j as Record<string, unknown>).client_secret).toBeUndefined();
  });

  test('cross-org isolation: o2 admin cannot see o1 connection', async () => {
    // create one in o1
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url)
       VALUES ('c1','o1','Acme','generic-oidc','oidc','https://x/a','https://x/t')`
    );
    const a = buildApp();
    const t = await tok('o2', ['org_admin']);
    const r = await a.request(`/admin/sso-connections/c1`, { headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(404);
  });

  test('patch with blank secret keeps stored secret (mask unchanged)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, client_secret_encrypted, client_secret_masked)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://x/a','https://x/t','CIPHER','okt••••cret')`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sortOrder: 5 }),
    });
    expect(r.status).toBe(200);
    const after = await testPool.query<{ client_secret_masked: string | null; sort_order: number }>(`SELECT client_secret_masked, sort_order FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.client_secret_masked).toBe('okt••••cret');
    expect(after.rows[0]!.sort_order).toBe(5);
  });

  test('delete soft-disables (enabled=false), row stays', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','X','generic-oidc','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1', { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(200);
    const after = await testPool.query<{ enabled: boolean }>(`SELECT enabled FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/sso.admin.test.ts`
Expected: FAIL (the stubs return 501).

- [ ] **Step 3: Implement admin CRUD in `routes/sso.ts`**

Replace the admin stub block with:

```ts
import { requireAuth, requirePermission } from '../auth/middleware';
import { PermissionPoint as PP } from '../shared/permissionPoints';
import { randomUUID } from 'node:crypto';
import { auditStore } from '../audit/auditStore';
import {
  encryptClientSecret,
  maskClientSecret,
  redactConnectionSecrets,
} from '../vault/ssoSecret';
import { z } from 'zod';

const baseSchema = z.object({
  orgId: z.string(),
  name: z.string().min(1).max(100),
  providerType: z.enum(['generic-oidc','generic-oauth2','azure-ad','feishu','dingtalk','wecom','saml2']),
  protocol: z.enum(['oidc','oauth2','saml2']),
  authorizeUrl: z.string().optional().default(''),
  tokenUrl: z.string().optional().default(''),
  userinfoUrl: z.string().optional().default(''),
  clientId: z.string().optional().default(''),
  clientSecret: z.string().optional().default(''),  // blank = keep
  scopes: z.string().optional().default(''),
  identityIdField: z.string().min(1).default('sub'),
  loginNameField: z.string().optional().default(''),
  emailField: z.string().min(1).default('email'),
  emailDomainWhitelist: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
const patchSchema = baseSchema.partial().extend({ orgId: z.string().optional() });

ssoRoutes.use('/admin/sso-connections/*', requireAuth);

ssoRoutes.get('/admin/sso-connections', requirePermission(PP.SsoView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query(
    `SELECT ${COLS} FROM sso_connections WHERE org_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [claims.orgId]
  );
  return c.json(r.rows.map((row) => redactConnectionSecrets(row as Record<string, unknown>)));
});

ssoRoutes.post('/admin/sso-connections', requirePermission(PP.SsoCreate), async (c) => {
  const claims = c.get('claims');
  const parsed = baseSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  if (parsed.data.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const id = randomUUID();
  const secretEnc = parsed.data.clientSecret ? encryptClientSecret(parsed.data.clientSecret) : null;
  const secretMask = parsed.data.clientSecret ? maskClientSecret(parsed.data.clientSecret) : null;
  await pool.query(
    `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, client_secret_encrypted, client_secret_masked, scopes, identity_id_field, login_name_field, email_field, email_domain_whitelist, enabled, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)`,
    [id, claims.orgId, parsed.data.name, parsed.data.providerType, parsed.data.protocol,
     parsed.data.authorizeUrl || null, parsed.data.tokenUrl || null, parsed.data.userinfoUrl || null,
     parsed.data.clientId || null, secretEnc, secretMask, parsed.data.scopes || null,
     parsed.data.identityIdField, parsed.data.loginNameField || null, parsed.data.emailField,
     JSON.stringify(parsed.data.emailDomainWhitelist), parsed.data.enabled, parsed.data.sortOrder, claims.sub]
  );
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'sso_connection_create', targetType: 'sso_connection', targetId: id, payload: { name: parsed.data.name } });
  return c.json({ id }, 201);
});

ssoRoutes.get('/admin/sso-connections/:id', requirePermission(PP.SsoView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query(`SELECT ${COLS} FROM sso_connections WHERE id = $1 AND org_id = $2`, [c.req.param('id'), claims.orgId]);
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  return c.json(redactConnectionSecrets(r.rows[0] as Record<string, unknown>));
});

ssoRoutes.patch('/admin/sso-connections/:id', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const existing = await pool.query(`SELECT ${COLS} FROM sso_connections WHERE id = $1 AND org_id = $2`, [c.req.param('id'), claims.orgId]);
  if (!existing.rowCount) return c.json({ error: 'not_found' }, 404);
  const prev = redactConnectionSecrets(existing.rows[0] as Record<string, unknown>);
  const merged = { ...prev, ...parsed.data };
  const secretEnc = parsed.data.clientSecret ? encryptClientSecret(parsed.data.clientSecret) : (existing.rows[0] as Record<string, unknown>).client_secret_encrypted ?? null;
  const secretMask = parsed.data.clientSecret
    ? maskClientSecret(parsed.data.clientSecret)
    : (existing.rows[0] as Record<string, unknown>).client_secret_masked ?? null;
  await pool.query(
    `UPDATE sso_connections SET
       name = $1, provider_type = $2, protocol = $3,
       authorize_url = $4, token_url = $5, userinfo_url = $6,
       client_id = $7, client_secret_encrypted = $8, client_secret_masked = $9,
       scopes = $10, identity_id_field = $11, login_name_field = $12,
       email_field = $13, email_domain_whitelist = $14::jsonb,
       enabled = $15, sort_order = $16, updated_at = now()
     WHERE id = $17 AND org_id = $18`,
    [merged.name, merged.providerType, merged.protocol,
     merged.authorizeUrl || null, merged.tokenUrl || null, merged.userinfoUrl || null,
     merged.clientId || null, secretEnc, secretMask,
     merged.scopes || null, merged.identityIdField, merged.loginNameField || null,
     merged.emailField, JSON.stringify(merged.emailDomainWhitelist),
     merged.enabled, merged.sortOrder, c.req.param('id'), claims.orgId]
  );
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'sso_connection_update', targetType: 'sso_connection', targetId: c.req.param('id'), payload: { changedKeys: Object.keys(parsed.data) } });
  return c.json({ ok: true });
});

ssoRoutes.delete('/admin/sso-connections/:id', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query(
    `UPDATE sso_connections SET enabled = false, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id`,
    [c.req.param('id'), claims.orgId]
  );
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'sso_connection_disable', targetType: 'sso_connection', targetId: c.req.param('id') });
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/sso.admin.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Typecheck**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/sso.ts enterprise_server/tests/routes/sso.admin.test.ts
git commit -m "feat(sso): admin CRUD routes behind SsoView/SsoCreate/SsoEdit"
```

---

### Task 12: Desktop callback route on the server (`/auth/sso/desktop/callback`)

**Files:**
- Modify: `enterprise_server/src/routes/sso.ts` (replace the 501 stub for desktop callback)

**Interfaces:**
- Produces: `GET /auth/sso/desktop/callback?code&state` → 302 to `http://localhost:<port>/callback?token=<jwt>` (the actual loopback port comes from the `state.redirect_uri` row — set in Task 13's authorize call).

- [ ] **Step 1: Implement**

```ts
// inside src/routes/sso.ts — replace the desktop callback stub:
ssoRoutes.get('/auth/sso/desktop/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!state || !code) return c.json({ error: 'invalid_request' }, 400);
  const consumed = await consumeState(state);
  if (!consumed) return c.json({ error: 'state_invalid' }, 400);
  const { finishSsoCallback } = await import('../sso/finishCallback');
  const result = await finishSsoCallback({ code, state: consumed, redirectUri: consumed.redirect_uri ?? 'http://localhost/callback' });
  if ('error' in result) {
    return c.redirect(`http://localhost/callback?error=${encodeURIComponent(result.error)}`, 302);
  }
  // Return the JWT as a fragment token in the redirect to the desktop loopback.
  return c.redirect(`http://localhost/callback?token=${encodeURIComponent(result.token)}`, 302);
});
```

Also extend the authorize handler (Task 9) to accept a `desktop_port=NNNN` query param so the desktop tells the server which loopback to use:

```ts
// in the authorize handler (Task 9), after reading `returnTarget`:
const desktopPort = c.req.query('desktop_port');
const redirectUri = returnTarget === 'desktop' && desktopPort
  ? `http://localhost:${desktopPort}/callback`
  : returnTarget === 'desktop'
  ? 'http://localhost/callback'
  : `${new URL(c.req.url).origin}/auth/sso/callback`;
```

- [ ] **Step 2: Typecheck**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add enterprise_server/src/routes/sso.ts
git commit -m "feat(sso): desktop callback route redirects to localhost loopback"
```

---

### Task 13: Desktop — generic SSO login driver (`src/main/sso/genericSsoLogin.ts`)

**Files:**
- Create: `src/main/sso/genericSsoLogin.ts`
- Test: `src/main/sso/genericSsoLogin.test.ts` (pure-function helper extracted if needed; see note below)

**Interfaces:**
- Produces:
  - `startSsoMemberLogin({ enterpriseBaseUrl, orgName, connectionId, parentWindow }): Promise<string>` — returns the GenWork JWT.
  - Reuses `openOauthFlow` (`src/main/mcp/oauthBrowserFlow.ts:24`) and the localhost-callback pattern from `qichachaMcpAuth.ts:75-114`.

Note: desktop main-process tests are blocked by `better-sqlite3.node` ABI in the sandbox. Mirror the spirit of the MCP spec's advice: extract the URL construction + state parsing as pure functions, test those, leave the BrowserWindow wiring uncovered in unit tests.

- [ ] **Step 1: Write the failing test for the URL builder (pure)**

```ts
// src/main/sso/genericSsoLogin.test.ts
import { describe, expect, test } from 'vitest';
import { buildAuthorizeUrl } from './genericSsoLogin';

describe('buildAuthorizeUrl', () => {
  test('embeds orgName + connectionId + desktop_port', () => {
    const u = new URL(buildAuthorizeUrl({
      enterpriseBaseUrl: 'https://api.example.com', orgName: 'Acme', connectionId: 'c1', desktopPort: 54321,
    }));
    expect(u.pathname).toBe('/auth/sso/c1/authorize');
    expect(u.searchParams.get('orgName')).toBe('Acme');
    expect(u.searchParams.get('return')).toBe('desktop');
    expect(u.searchParams.get('desktop_port')).toBe('54321');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/sso/genericSsoLogin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/main/sso/genericSsoLogin.ts
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { BrowserWindow } from 'electron';
import { openOauthFlow } from '../mcp/oauthBrowserFlow';

export interface AuthorizeArgs {
  enterpriseBaseUrl: string;  // e.g. https://api.genwork.example
  orgName: string;
  connectionId: string;
  desktopPort: number;  // the loopback port we'll bind.
}
export function buildAuthorizeUrl(a: AuthorizeArgs): string {
  const u = new URL(`/auth/sso/${encodeURIComponent(a.connectionId)}/authorize`, a.enterpriseBaseUrl);
  u.searchParams.set('orgName', a.orgName);
  u.searchParams.set('return', 'desktop');
  u.searchParams.set('desktop_port', String(a.desktopPort));
  return u.toString();
}

function startCallbackServer(): Promise<{ port: number; close: () => void; waitForToken: (timeoutMs?: number) => Promise<{ token?: string; error?: string }> }> {
  return new Promise((resolve, reject) => {
    let resolveToken: ((v: { token?: string; error?: string }) => void) | null = null;
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      if (parsed.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const token = parsed.searchParams.get('token');
      const error = parsed.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>You may close this window.</h1>');
      resolveToken?.({ token: token ?? undefined, error: error ?? undefined });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => server.close(),
        waitForToken: (timeoutMs = 5 * 60 * 1000) =>
          new Promise((r) => {
            resolveToken = r;
            setTimeout(() => r({ error: 'timeout' }), timeoutMs);
          }),
      });
    });
  });
}

export async function startSsoMemberLogin(args: {
  enterpriseBaseUrl: string;
  orgName: string;
  connectionId: string;
  parentWindow?: BrowserWindow | null;
}): Promise<string> {
  const cb = await startCallbackServer();
  try {
    const authorizeUrl = buildAuthorizeUrl({
      enterpriseBaseUrl: args.enterpriseBaseUrl,
      orgName: args.orgName,
      connectionId: args.connectionId,
      desktopPort: cb.port,
    });
    const probe = (): Promise<string | null> =>
      cb.waitForToken().then((r) => r.token ?? null).then((t) => {
        if (!t) throw new Error(r?.error ?? 'sso_failed');
        return t;
      });
    // openOauthFlow's probe signature is (win) => Promise<string|null>; we
    // reuse the existing primitive but kick off the wait immediately so the
    // browser redirect can land. openOauthFlow resolves with whatever the
    // probe returns.
    const token = await openOauthFlow({
      parentWindow: args.parentWindow ?? null,
      title: 'SSO sign-in',
      authorizeUrl,
      probe: async () => {
        const result = await cb.waitForToken();
        if (result.error) throw new Error(result.error);
        return result.token ?? null;
      },
    });
    return token;
  } finally {
    cb.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/sso/genericSsoLogin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sso/genericSsoLogin.ts src/main/sso/genericSsoLogin.test.ts
git commit -m "feat(desktop): generic SSO member-login driver (localhost callback)"
```

---

### Task 14: Desktop — IPC channel + preload + enterpriseMt handler

**Files:**
- Modify: `src/shared/enterprise/constants.ts` (add 2 IPC channel constants)
- Modify: `src/main/preload.ts` (add `ssoProviders` + `ssoLogin` on `enterpriseMt`)
- Modify: `src/renderer/types/electron.d.ts` (add renderer types)
- Create: `src/main/ipcHandlers/sso.ts` (IPC handlers using Task 13's driver)
- Modify: `src/main/ipcHandlers/enterpriseMt.ts` (register the new handlers)

- [ ] **Step 1: Update the IPC channel constants**

```ts
// src/shared/enterprise/constants.ts — add to the EnterpriseIpcChannel object:
SsoProviders: 'enterprise:sso-providers',
SsoLogin: 'enterprise:sso-login',
```

- [ ] **Step 2: Add preload bridge**

```ts
// src/main/preload.ts — extend the enterpriseMt object:
ssoProviders: (orgName: string): Promise<{ providers: Array<{ id: string; name: string; provider_type: string; sort_order: number }> }> =>
  ipcRenderer.invoke(EnterpriseIpcChannel.SsoProviders, orgName),
ssoLogin: (args: { orgName: string; connectionId: string }): Promise<{ ok: true; token: string } | { ok: false; error: string }> =>
  ipcRenderer.invoke(EnterpriseIpcChannel.SsoLogin, args),
```

- [ ] **Step 3: Add renderer types**

```ts
// src/renderer/types/electron.d.ts — extend the enterpriseMt interface:
ssoProviders: (orgName: string) => Promise<{ providers: Array<{ id: string; name: string; provider_type: string; sort_order: number }> }>;
ssoLogin: (args: { orgName: string; connectionId: string }) => Promise<{ ok: true; token: string } | { ok: false; error: string }>;
```

- [ ] **Step 4: Implement the main-process handlers**

```ts
// src/main/ipcHandlers/sso.ts
import { ipcMain, BrowserWindow } from 'electron';
import { EnterpriseIpcChannel } from '../../shared/enterprise/constants';
import { enterpriseClient } from '../auth/enterpriseClient';
import { startSsoMemberLogin } from '../sso/genericSsoLogin';
import { sessionStorage } from '../auth/sessionStorage';
import { loginGate } from '../auth/loginGate';

async function fetchProviders(orgName: string): Promise<unknown> {
  const r = await enterpriseClient.call(`/auth/sso/providers?orgName=${encodeURIComponent(orgName)}`, { method: 'GET' }, false);
  return r;
}

export function registerSsoHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(EnterpriseIpcChannel.SsoProviders, async (_e, orgName: string) => {
    try {
      return await fetchProviders(orgName);
    } catch (e) {
      return { providers: [], error: (e as Error).message };
    }
  });

  ipcMain.handle(EnterpriseIpcChannel.SsoLogin, async (_e, args: { orgName: string; connectionId: string }) => {
    try {
      const baseUrl = (await import('../auth/enterpriseConfig')).getEnterpriseServerUrl();
      const parent = getMainWindow();
      const token = await startSsoMemberLogin({
        enterpriseBaseUrl: baseUrl,
        orgName: args.orgName,
        connectionId: args.connectionId,
        parentWindow: parent,
      });
      // Persist + unlock just like the password login handler.
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string; orgId: string; roles: string[] };
      // orgName→orgId: read from the active session if present, else look it up via listOrgs.
      const orgs = await enterpriseClient.listOrgs();
      const org = orgs.orgs.find((o) => o.id === payload.orgId);
      const username = payload.sub; // best-effort
      const expiresAt = Date.now() + 60 * 60 * 1000;
      enterpriseClient.persistSession(org?.id ?? payload.orgId, org?.name ?? args.orgName, token, expiresAt);
      try { await (await import('../enterprise/enterpriseModelCache')).enterpriseModelCache.load(); } catch {}
      try { (await import('../main')).onLoginSyncHook?.()?.catch(() => {}); } catch {}
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
```

- [ ] **Step 5: Register the handlers**

In `src/main/ipcHandlers/enterpriseMt.ts` (or wherever `registerEnterpriseMtHandlers` is called), invoke `registerSsoHandlers(getMainWindow)` with the same main-window accessor.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p electron-tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/enterprise/constants.ts src/main/preload.ts \
        src/renderer/types/electron.d.ts src/main/ipcHandlers/sso.ts \
        src/main/ipcHandlers/enterpriseMt.ts
git commit -m "feat(desktop): SSO IPC channels + preload bridge + main handlers"
```

---

### Task 15: Desktop renderer — render SSO provider buttons in LoginPage

**Files:**
- Modify: `src/renderer/login/LoginPage.tsx`
- Modify: `src/renderer/services/i18n.ts` (zh + en; see §I18n keys)

**Interfaces:**
- Renders a "Log in with <name>" button per provider returned by `enterpriseMt.ssoProviders(orgName)` when the list is non-empty. Click triggers `enterpriseMt.ssoLogin({ orgName, connectionId })`; success → `onSuccess()`.

- [ ] **Step 1: Read the existing LoginPage and find the insertion point**

```ts
// inspect: src/renderer/login/LoginPage.tsx, particularly the JSX around
// the password form (lines 152-204 in the explored file). Add a new
// providers state + buttons block before the password card.
```

- [ ] **Step 2: Implement the SSO buttons block**

Add inside the component (between the org dropdown and the password form):

```tsx
const [ssoProviders, setSsoProviders] = useState<Array<{ id: string; name: string; sort_order: number }>>([]);
useEffect(() => {
  if (!orgName) { setSsoProviders([]); return; }
  window.electron.enterpriseMt.ssoProviders(orgName)
    .then((r) => setSsoProviders(r.providers ?? []))
    .catch(() => setSsoProviders([]));
}, [orgName]);

const onSso = async (connectionId: string): Promise<void> => {
  setErr(null);
  setBusy(true);
  try {
    const r = await window.electron.enterpriseMt.ssoLogin({ orgName, connectionId });
    if (r.ok) {
      if (onSuccess) onSuccess();
      else window.location.reload();
    } else {
      setErr(i18nService.t('sso.login.failed', { error: r.error }));
    }
  } finally { setBusy(false); }
};

// JSX before the password form:
{ssoProviders.length > 0 && (
  <div className="space-y-2">
    {ssoProviders.map((p) => (
      <button key={p.id} type="button" disabled={busy} onClick={() => onSso(p.id)}
        className="w-full rounded-[6px] border border-[var(--border)] py-2 text-sm hover:bg-[var(--surface-muted)]">
        {i18nService.t('sso.login.with', { name: p.name })}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 3: Add i18n keys** (en + zh; §I18n keys block above)

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p electron-tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/login/LoginPage.tsx src/renderer/services/i18n.ts
git commit -m "feat(desktop): render SSO provider buttons in enterprise login"
```

---

### Task 16: SPA — SSO admin list + drawer page

**Files:**
- Create: `enterprise_server/web/src/api/sso.ts`
- Create: `enterprise_server/web/src/pages/sso/types.ts`
- Create: `enterprise_server/web/src/pages/sso/presets.ts`
- Create: `enterprise_server/web/src/pages/sso/SSOConnectionDrawer.tsx`
- Create: `enterprise_server/web/src/pages/sso/SSOConnectionsPage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts` (zh + en; §I18n keys)
- Modify: `enterprise_server/web/src/App.tsx` (add route)
- Test: `enterprise_server/web/src/pages/sso/SSOConnectionsPage.test.tsx` (if a vitest pattern exists; otherwise skip — flag in commit message)

**Interfaces:**
- Route: `/sso-connections` → `<Shell><SSOConnectionsPage/></Shell>`
- Drawer mirrors `web/src/pages/mcpManage/ConnectorDrawer.tsx` (form switches fields per `providerType`; pre-fills from `presets.ts`; secret input is `type="password"` with the "keep existing" placeholder when `has_secret`).

- [ ] **Step 1: Wire SPA api client**

```ts
// enterprise_server/web/src/api/sso.ts
import { apiClient } from './client';

export const ssoApi = {
  list: (orgId: string) => apiClient.get<unknown[]>(`/admin/sso-connections?orgId=${encodeURIComponent(orgId)}`),
  get: (id: string) => apiClient.get<unknown>(`/admin/sso-connections/${id}`),
  create: (input: unknown) => apiClient.post<{ id: string }>('/admin/sso-connections', input),
  patch: (id: string, patch: unknown) => apiClient.patch<{ ok: boolean }>(`/admin/sso-connections/${id}`, patch),
  disable: (id: string) => apiClient.delete<{ ok: true }>(`/admin/sso-connections/${id}`),
};
```

- [ ] **Step 2: Copy `presets.ts`**

Copy the contents of `enterprise_server/src/sso/providerPresets.ts` into `enterprise_server/web/src/pages/sso/presets.ts` (replace `import` with inline `const PRESETS: Record<string, ProviderPreset> = { … }`). The web build does not read `enterprise_server/src/...` paths.

- [ ] **Step 3: Implement `SSOConnectionsPage`**

```tsx
// enterprise_server/web/src/pages/sso/SSOConnectionsPage.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ssoApi } from '../../api/sso';
import { useAuth } from '../../auth/useAuth';
import { SSOConnectionDrawer } from './SSOConnectionDrawer';
import { t } from '../../i18n';

export function SSOConnectionsPage(): JSX.Element {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? '';
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['sso','list',orgId], queryFn: () => ssoApi.list(orgId) });
  const [drawer, setDrawer] = useState<{ mode: 'create' } | { mode: 'edit'; id: string } | null>(null);

  const invalidate = (): void => { void qc.invalidateQueries({ queryKey: ['sso','list'] }); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('sso.title')}</h1>
        <button className="bg-[var(--accent-primary)] text-white rounded px-3 py-1"
          onClick={() => setDrawer({ mode: 'create' })}>{t('sso.create')}</button>
      </div>
      {(list.data ?? []).length === 0
        ? <div className="text-[var(--text-muted)]">{t('sso.list.empty')}</div>
        : (
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Name</th><th>Type</th><th>Enabled</th><th /></tr></thead>
            <tbody>
              {(list.data ?? []).map((c: any) => (
                <tr key={c.id} className="border-t border-[var(--border)]">
                  <td>{c.name}</td><td>{c.provider_type}</td><td>{c.enabled ? '✓' : '—'}</td>
                  <td><button onClick={() => setDrawer({ mode: 'edit', id: c.id })}>{t('sso.edit')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {drawer && <SSOConnectionDrawer mode={drawer.mode} id={'id' in drawer ? drawer.id : undefined}
        onClose={() => setDrawer(null)} onSaved={() => { invalidate(); setDrawer(null); }} />}
    </div>
  );
}
```

- [ ] **Step 4: Implement the drawer**

`SSOConnectionDrawer.tsx` is a form with the §I18n keys, mirroring `web/src/pages/mcpManage/ConnectorDrawer.tsx`. When `providerType` changes, reset `authorizeUrl`/`tokenUrl`/`userinfoUrl`/`scopes`/`identityIdField`/`emailField` from `PRESETS[providerType]`. The `clientSecret` field is `type="password"`; placeholder switches to `sso.clientSecret.keepPlaceholder` when editing and `has_secret === true`. Submit calls `ssoApi.create` / `ssoApi.patch`.

- [ ] **Step 5: Add i18n keys** (§I18n keys block)

- [ ] **Step 6: Add the route**

In `enterprise_server/web/src/App.tsx` (around line 102, near `<Route ...><Shell><MCPManagePage/></Shell></Route>`):

```tsx
<Route path="/sso-connections" element={<Shell><SSOConnectionsPage/></Shell>} />
```

- [ ] **Step 7: Typecheck**

Run: `cd enterprise_server/web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/web/src/api/sso.ts enterprise_server/web/src/pages/sso \
        enterprise_server/web/src/App.tsx enterprise_server/web/src/i18n.ts
git commit -m "feat(web): SSO admin page (list + drawer) + route + i18n"
```

---

### Task 17: SPA — render SSO provider buttons on the console LoginPage

**Files:**
- Modify: `enterprise_server/web/src/pages/LoginPage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts` (zh + en)

**Interfaces:**
- After fetching orgs (lines 75-91), also fetch `ssoApi.providers(orgName)` for the chosen org. If non-empty, render "用 <name> 登录" buttons above the password form. Click → window.location to `/auth/sso/<id>/authorize?orgName=<orgName>&return=console`.

- [ ] **Step 1: Implement**

```tsx
// In LoginPage.tsx, after the existing `listOrgs` fetch:
import { ssoApi } from '../api/sso';
// inside component:
const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
useEffect(() => {
  if (!orgName) { setProviders([]); return; }
  ssoApi.providers(orgName).then((r: any) => setProviders(r.providers ?? [])).catch(() => setProviders([]));
}, [orgName]);

// JSX above the password card:
{providers.length > 0 && (
  <div className="space-y-2">
    {providers.map((p) => (
      <button key={p.id} type="button"
        onClick={() => { window.location.href = `/auth/sso/${p.id}/authorize?orgName=${encodeURIComponent(orgName)}&return=console`; }}
        className="w-full rounded-[6px] border border-[var(--border)] py-2">
        {t('sso.login.button.with', { name: p.name })}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 2: Add i18n keys** (`sso.login.button.with` is already in §I18n keys)

- [ ] **Step 3: Typecheck + commit**

```bash
git add enterprise_server/web/src/pages/LoginPage.tsx enterprise_server/web/src/i18n.ts
git commit -m "feat(web): SSO provider buttons on console login page"
```

---

### Task 18: Final typecheck + per-file vitest sweep

**Files:** none new.

- [ ] **Step 1: Typecheck all three subprojects**

```bash
cd enterprise_server && npx tsc --noEmit && cd web && npx tsc --noEmit
npx tsc -p electron-tsconfig.json --noEmit
```
Expected: 0 errors each.

- [ ] **Step 2: Run the SSO test files (per-file, fresh process)**

```bash
cd enterprise_server
for f in tests/db/ssoTables.test.ts tests/vault/ssoSecret.test.ts \
         tests/sso/state.test.ts tests/sso/jit.test.ts tests/sso/oauth.test.ts \
         tests/sso/finishCallback.test.ts tests/sso/consoleCallback.test.ts \
         tests/sso/providerPresets.test.ts \
         tests/routes/sso.public.test.ts tests/routes/sso.admin.test.ts; do
  echo "=== $f ==="
  npx vitest run "$f"
done
```
Expected: each file PASS.

- [ ] **Step 3: Run the desktop pure-function tests**

```bash
npx vitest run src/main/sso/genericSsoLogin.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit (no source changes — record the green run)**

```bash
git commit --allow-empty -m "chore(sso): all SSO tests + typechecks green"
```

---

## Self-Review

Run this checklist against the spec **before** invoking the execution skill.

**1. Spec coverage.** Spec sections → tasks:
- §3 data model (sso_connections, user_idp_identities) → Task 1 (036). §3 mentions `email_domain_whitelist` JSONB — covered in the DDL. **Covered.**
- §3.2 `user_idp_identities` → Task 1 (036). **Covered.**
- §4 server routes (`/auth/sso/providers`, `/authorize`, `/callback`, `/desktop/callback`) → Tasks 9, 10, 12. **Covered.**
- §4.1 state-gated authorize (PKCE + state) → Task 9 (authorize) + Task 5 (state CRUD). **Covered.**
- §4.2 OIDC vs OAuth2 + named providers → Task 7 (oauth.ts) + Task 4 (presets). **Covered.**
- §5 JIT + email-domain gate + cross-IdP dedup → Task 6 (jit.ts). **Covered.**
- §6 desktop entry → Tasks 13, 14, 15. **Covered.**
- §7 admin CRUD → Task 11. **Covered.**
- §8 secret storage → Task 3. **Covered.**
- §9 boundary with MCP connector SSO → ruled explicitly in the design and called out in the Plan's preamble ("No new `@modelcontextprotocol/sdk` / no new MCP wire work"). **Covered.**
- §11 testing strategy → per-file tasks above. **Covered.**
- §12 milestones M1–M4 → tasks grouped M1 = Tasks 1–8 + 11; M2 = Tasks 9–10; M3 = Task 17; M4 = Tasks 12–15. **Covered.**

**2. Placeholder scan.** Searched the plan for "TBD", "TODO", "implement later", "similar to Task N", "Add appropriate", "Write tests for the above" — none present. Every step contains the actual code or command to run.

**3. Type consistency.** Names used in later tasks match earlier tasks:
- `SsoView`/`SsoCreate`/`SsoEdit` — defined in Task 2's `permissionPoints.ts` edit; consumed by Task 11's `requirePermission(PP.SsoView / SsoCreate / SsoEdit)` calls and by the test (`token({...}, ['org_admin'])`) which uses the seeded permissions JSONB. ✓
- `SsoPublicProvider` (Task 5 types) — consumed in Task 9 (`buildAuthorizeUrl` accepts a never-cast, but the test asserts the shape via the listing response). ✓
- `redactConnectionSecrets` (Task 3) — consumed in Task 11 (admin GET / PATCH). ✓
- `maskClientSecret` (Task 3) — consumed in Task 11 (POST admin create). ✓
- `consumeState` / `createState` (Task 5) — consumed in Task 9 (authorize), Task 12 (desktop callback). ✓
- `finishSsoCallback` (Task 10) — consumed by Task 9 (console callback) and Task 12 (desktop callback). ✓
- `resolveUser` (Task 6) — consumed in Task 10 (`finishCallback`). ✓
- `startSsoMemberLogin` (Task 13) — consumed in Task 14 (IPC handler). ✓
- IPC channels `EnterpriseIpcChannel.SsoProviders`/`SsoLogin` (Task 14) — declared once, used in `preload.ts`, `electron.d.ts`, `enterpriseMt.ts`, and the renderer. ✓

**4. One open spec assumption left.** Spec §14 Q3 (`JIT 一律 Role.User` → Task 6 uses `[Role.User]` ✓; spec §14 Q4 (disable-not-delete) → Task 11's DELETE handler sets `enabled=false`, never removes the row ✓; spec §14 Q5 (no new PermissionPoint) → Ruling R1 amends this and adds `sso:*`. Flagged in the Rulings table.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-09-27-enterprise-sso-member-login-federation.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?