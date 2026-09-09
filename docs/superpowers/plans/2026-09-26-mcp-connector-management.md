# MCP 连接器管理重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild GenWork MCP management against the PRD + HTML prototype: org-scoped **connectors** (two-tab admin console: 企业连接器 + 连接器审核), 6-mode auth, **dept+member scope** (replacing role authz), draft/publish, version history/rollback, per-tool toggles, real MCP handshake, member submit-request flow. Drop call metrics + call-audit drawer.

**Architecture:** New `mcp_connectors`/`mcp_connector_versions`/`mcp_connector_submissions`/`mcp_connector_categories` tables + `orgs.members_can_submit_connectors`; retire the role-based `mcp_marketplace_servers` (public route re-pointed to connectors with **scope-based** visibility). Admin console (`enterprise_server/web`) rewritten to the prototype. Desktop 企业市场 re-pointed to the new wire + scope visibility + member submit entry.

**Tech Stack:** Hono + Postgres (pglite in tests) · zod · AES-256-GCM vault (`src/vault/crypto`) · `@modelcontextprotocol/sdk` (P1, desktop already depends on it; added to `enterprise_server` in P1) · React 19 + TanStack Query v5 + Tailwind + vitest (SPA) · Electron (desktop consumer).

**Spec:** `docs/superpowers/specs/2026-09-26-mcp-connector-management-design.md`

## Global Constraints

- **Conventional Commits, English, lowercase subject**; **local-only — never push** unless explicitly asked.
- **Org scoping:** every connector admin route guards on `claims.orgId` (cross-org → 404, never leaked), mirroring `src/routes/admin/providerKeys.ts`. Connectors are **org-scoped** (`org_id` column) — unlike the old global marketplace.
- **Secrets:** `auth_config` secret fields (shared-key key, client-creds/user-oauth secret) are **encrypted inline** with `src/vault/crypto` `encrypt/decrypt`; **no plaintext ever on the wire** — detail/list return masked values only; **blank on edit = keep current** (re-encrypt only when a new non-empty value is sent).
- **Scope:** `scope = { allCompany: bool, deptIds: string[], userIds: string[] }`. `allCompany` = 全公司. Else visible to users whose **dept subtree** (via `departments.path` prefix) intersects `deptIds` OR user ∈ `userIds`. Reuse `scopeApi.deptIdsFor(orgId, userId)` (already exists, `src/auth/scopeResolver.ts:119`).
- **i18n (SPA):** every new/changed string in **both** `en` and `zh` blocks of `web/src/i18n.ts`.
- **No new PermissionPoint** (V1): reuse `mcp:view/create/edit/delete` (`PP.McpView/McpCreate/McpEdit/McpDelete`, `src/shared/permissionPoints.ts:13`).
- **Test code is authoritative:** treat existing test assertions as source of truth; only change them with explicit user sign-off.
- **Run server AND web vitest per-file** (full suite hits sandbox EBADF/fd limit). Never touch the dev `gwork` Postgres `:5432`; tests use the pglite in-process harness (`src/db/testDb.ts`).
- **Migrations:** plain SQL, one `;`-statement at a time (`migrate.ts` `splitStatements` strips `--` comments); re-run-safe (`IF NOT EXISTS` / guarded seeds). Latest existing = 034 → this starts at **035**.
- **transport** (`http`/`sse`) affects only test-connection/handshake transport + the auth-mode availability set (SSE disables `user-oauth`/`client-creds`/`sso`), never the desktop runtime.
- **删除范围**（用户确认）：无调用指标（近30天调用/错误率/错误率高）、无调用审计日志抽屉。卡片元信息行只留版本号；卡片 ⋯ 菜单 = 编辑 / 停启用 / 删除。**保留**管理员写操作审计（`auditStore`，`{before,after}` diff）。

## File map

**New (enterprise_server):**
- `src/db/migrations/035_mcp_connectors.sql` — 4 tables + `orgs` column + best-effort legacy migration.
- `src/models/connectorView.ts` — `ConnectorRow`, `ConnectorView` (admin wire), `ConnectorPublicView` (public/desktop wire), `mapAdminConnector`, `mapPublicConnector`, `COLUMNS`, enums (`AuthMode6`, `Transport2`, `ConnectorType`), scope helpers.
- `src/vault/connectorSecret.ts` — per-`auth_mode` secret encrypt/decrypt/mask over the `auth_config` JSONB.
- `src/routes/mcpConnectors.ts` — admin CRUD/enable/delete/detail/save-draft/publish/rollback/test/categories/settings + audit.
- `src/routes/mcpSubmissions.ts` — review queue (list/submit/approve/reject/withdraw).
- `src/mcp/handshake.ts` (P1) — real MCP `initialize` + `tools/list` via `@modelcontextprotocol/sdk`.
- `tests/routes/mcpConnectors.test.ts`, `tests/routes/mcpSubmissions.test.ts`, `tests/mcp/handshake.test.ts`.

**Modified (enterprise_server):**
- `src/routes/mcpMarketplace.ts` — re-pointed to `mcp_connectors`, scope-based (replaces role filter at `:31-33`).
- `src/server.ts` — register new routes; drop `mcpMarketplaceAdminRoutes` registration.
- `src/shared/enterpriseServerConstants.ts` — add `AuditAction.McpConnector*`.
- `package.json` (P1) — add `@modelcontextprotocol/sdk`.

**New (enterprise_server/web):**
- `src/api/connectors.ts` — connectors CRUD + categories + settings + submissions + dept/member list (reuses `departments.ts`/`users.ts`).
- `src/pages/mcpManage/` (rewritten set): `ConnectorCategoryPanel`, `ConnectorCardGrid`, `ConnectorCard`, `ConnectorCardMenu`, `ConnectorDrawer` (+ `ConnectorBasicInfo`, `ConnectorConnConfig`, `ConnectorAuthFields`, `ConnectorToolPermissions`, `ConnectorScopeSelector`, `ConnectorVersionHistory`), `ReviewView` (+ `ReviewDetailDrawer`, `RejectReasonModal`), `DeleteConnectorModal`, `RollbackModal`, `AddCategoryModal` (extended).
- `src/pages/MCPManagePage.tsx` — rewritten (two tabs + global-setting card).

**Modified (enterprise_server/web):** `src/i18n.ts` (new `mcp.*` keys en+zh), `src/pages/MCPManagePage.tsx` (replace body), delete `src/api/mcpMarketplace.ts` + old `mcpManage/` components superseded, update `web/tests/pages/mcpManage/*`.

**Modified (desktop, repo root):**
- `src/renderer/types/mcp.ts` — `McpEnterpriseMarketServer` → new wire (drop `allowedRoles`/stdio legacy; add `serverKey`/`version`/`authMode`6/`authStatus`/`scopeSummary`/`hasDraft`/`connectorType`).
- `src/main/auth/enterpriseClient.ts` — `listEnterpriseMcps()` new return type; add `submitConnectorRequest()`.
- `src/renderer/components/mcp/McpServerFormModal.tsx` — prefill `authMode` on enterprise install (was reset to `none`).
- `src/renderer/components/mcp/McpManager.tsx` — member "申请连接器" entry (gated by toggle) + submit form (P1).
- `src/renderer/services/i18n.ts` — desktop zh+en keys for submit entry / 待配置 notes.

**Retired (kept on disk, unserved, not dropped):** `src/routes/mcpMarketplaceAdmin.ts`, `src/models/mcpMarketplaceView.ts` (old), `mcp_marketplace_*` tables.

---

## P0 — data model + admin core

### Task 1: Migration 035 (connector tables + orgs column + legacy migration)

**Files:**
- Create: `enterprise_server/src/db/migrations/035_mcp_connectors.sql`

- [ ] **Step 1.1: Write the migration**

```sql
-- Migration 035: MCP connector subsystem (replaces role-based marketplace).
-- Org-scoped connectors with 6-mode auth, dept+member scope, draft, tools,
-- versions, and a member submission (review) queue. Best-effort migration of
-- existing mcp_marketplace_servers rows that carry a server_url.
-- Re-run safe: IF NOT EXISTS + guarded INSERT/UPDATE.

CREATE TABLE IF NOT EXISTS mcp_connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  server_key TEXT NOT NULL,
  name_en TEXT,
  name_zh TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  category_id TEXT,
  description TEXT,
  connector_type TEXT NOT NULL DEFAULT 'mcp',
  url TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'http',
  auth_mode TEXT NOT NULL DEFAULT 'none',
  auth_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_meta JSONB,
  auth_status TEXT NOT NULL DEFAULT 'configured',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope JSONB NOT NULL DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft JSONB,
  last_test_at TIMESTAMPTZ,
  last_test_status TEXT,
  last_latency_ms INTEGER,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, server_key)
);

CREATE INDEX IF NOT EXISTS mcp_connectors_org_idx ON mcp_connectors (org_id);
CREATE INDEX IF NOT EXISTS mcp_connectors_org_cat_idx ON mcp_connectors (org_id, category_id);

CREATE TABLE IF NOT EXISTS mcp_connector_versions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES mcp_connectors(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  current BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_connector_versions_conn_idx ON mcp_connector_versions (connector_id);

CREATE TABLE IF NOT EXISTS mcp_connector_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  desc TEXT,
  author_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  cfg JSONB NOT NULL,
  approved_connector_id TEXT
);
CREATE INDEX IF NOT EXISTS mcp_connector_submissions_org_idx ON mcp_connector_submissions (org_id, status);

CREATE TABLE IF NOT EXISTS mcp_connector_categories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS members_can_submit_connectors BOOLEAN NOT NULL DEFAULT FALSE;

-- Best-effort migration: existing marketplace servers WITH a URL become
-- connectors scoped to the whole company. stdio/legacy (no URL) rows are left
-- in the old table, unserved (not dropped). Non-destructive.
INSERT INTO mcp_connectors
  (id, org_id, server_key, name_en, name_zh, version, category_id, description,
   connector_type, url, transport, auth_mode, auth_config, secret_meta, auth_status,
   enabled, scope, tools, draft, created_by, created_at, updated_at)
SELECT
  s.server_id, 'default',
  COALESCE(NULLIF(s.name, ''), s.server_id), s.name, s.name_zh, '1.0.0',
  NULLIF(s.category_id, 'uncategorized'), COALESCE(s.description_zh, s.description_en),
  'mcp', s.server_url, s.transport_type,
  CASE WHEN s.auth_method IN ('bearer','api-key') THEN 'shared-key'
       WHEN s.auth_method = 'oauth' THEN 'user-oauth' ELSE 'none' END,
  '{}'::jsonb, NULL, 'configured', s.enabled,
  '{"allCompany":true,"deptIds":[],"userIds":[]}'::jsonb, '[]'::jsonb, NULL,
  'system', now(), now()
FROM mcp_marketplace_servers s
WHERE s.server_url IS NOT NULL AND s.transport_type <> 'stdio'
ON CONFLICT (org_id, server_key) DO NOTHING;
```

> Note: `org_id 'default'` is a fallback for the legacy rows (the old table has no `org_id`). The admin public route is single-tenant in V1 (one org per deployment); the org-scoped admin routes use `claims.orgId`. Adjust `'default'` to the seeded org id if the repo seeds a specific org — verify against the `orgs` seed before running.

- [ ] **Step 1.2: Verify the migration applies cleanly in the pglite harness**

Run: `cd enterprise_server && npx vitest run tests/db/migrations.test.ts` (or any existing migration smoke test). If none exists, run a throwaway: create a temp test that calls `resetSchema()` + `runMigrations()` and asserts the 4 tables exist. Expected: green (all migrations 000→035 apply).

- [ ] **Step 1.3: Commit**

```bash
git add enterprise_server/src/db/migrations/035_mcp_connectors.sql
git commit -m "feat(mcp): add connector subsystem tables (migration 035)

Introduce org-scoped mcp_connectors with 6-mode auth, dept+member scope,
draft, tools and versions; a member submission queue; per-org categories;
and an orgs.members_can_submit_connectors toggle. Best-effort migration of
existing marketplace servers that carry a URL (scoped to the whole company);
stdio/legacy rows stay in the old table, unserved."
```

### Task 2: Connector view model (types, mapping, enums, scope helpers)

**Files:**
- Create: `enterprise_server/src/models/connectorView.ts`

**Interfaces:**
- Produces: `AuthMode6`, `Transport2`, `ConnectorType`, `ConnectorScope`, `ToolEntry`, `ConnectorRow`, `ConnectorView` (admin), `ConnectorPublicView` (public/desktop), `COLUMNS`, `mapAdminConnector(row)`, `mapPublicConnector(row)`, `scopeSummary(scope): string`, `scopeMatches(scope, callerDeptIds, callerId): boolean`.

- [ ] **Step 2.1: Write `connectorView.ts`**

```ts
import { maskCredential } from '../vault/mask';

export const AUTH_MODES = ['none','shared-key','user-key','user-oauth','client-creds','sso'] as const;
export type AuthMode6 = typeof AUTH_MODES[number];
export const TRANSPORTS = ['http','sse'] as const;
export type Transport2 = typeof TRANSPORTS[number];
export const CONNECTOR_TYPES = ['mcp','app'] as const;
export type ConnectorType = typeof CONNECTOR_TYPES[number];

export interface ConnectorScope { allCompany: boolean; deptIds: string[]; userIds: string[] }
export interface ToolEntry { name: string; desc?: string; enabled: boolean; syncedAt?: string; removed?: boolean }
export interface ConnectorDraft { [k: string]: unknown }

export interface ConnectorRow {
  id: string; org_id: string; server_key: string;
  name_en: string | null; name_zh: string | null; version: string;
  category_id: string | null; description: string | null;
  connector_type: ConnectorType; url: string; transport: Transport2;
  auth_mode: AuthMode6; auth_config: Record<string, unknown>; secret_meta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  auth_status: 'configured' | 'pending'; enabled: boolean;
  scope: ConnectorScope; tools: ToolEntry[]; draft: ConnectorDraft | null;
  last_test_at: Date | null; last_test_status: string | null; last_latency_ms: number | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}

/** Admin list/detail wire. Secrets are masked (see mapAdminConnector). */
export interface ConnectorView {
  id: string; serverKey: string; nameEn: string | null; nameZh: string | null;
  version: string; categoryId: string | null; description: string | null;
  connectorType: ConnectorType; url: string; transport: Transport2;
  authMode: AuthMode6;
  /** Per-mode, non-secret fields + masked secret(s). Shape keyed by authMode. */
  authConfig: Record<string, unknown>;
  secretMeta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  authStatus: 'configured' | 'pending'; enabled: boolean;
  scope: ConnectorScope; scopeSummary: string;
  tools: ToolEntry[]; toolCount: number; hasDraft: boolean;
  version: string;
  lastTestAt: string | null; lastTestStatus: string | null; lastLatencyMs: number | null;
  createdAt: string; updatedAt: string;
}

/** Public (desktop) wire — scope-filtered, no secret material. */
export interface ConnectorPublicView {
  id: string; serverKey: string; name: string; nameZh: string | null;
  description: string; category: string; version: string;
  connectorType: ConnectorType; url: string; transport: Transport2;
  authMode: AuthMode6; authStatus: 'configured' | 'pending';
  scopeSummary: string; hasDraft: boolean; enabled: boolean;
  toolCount: number;
}

export const COLUMNS = `id, org_id, server_key, name_en, name_zh, version, category_id, description,
  connector_type, url, transport, auth_mode, auth_config, secret_meta, auth_status,
  enabled, scope, tools, draft, last_test_at, last_test_status, last_latency_ms,
  created_by, created_at, updated_at`;

/** A connector's scope grants a caller access iff allCompany, or the caller
 * has any dept in a granted dept's subtree (path prefix), or is a member
 * exception. Pure — `callerDeptIds` = scopeApi.deptIdsFor(org, user). */
export function scopeMatches(scope: ConnectorScope, callerDeptIds: string[], callerId: string): boolean {
  if (scope.allCompany) return true;
  if (scope.userIds.includes(callerId)) return true;
  return (scope.deptIds ?? []).some((d) => callerDeptIds.includes(d));
}

export function scopeSummary(scope: ConnectorScope): string {
  if (scope.allCompany) return 'all';
  const d = scope.deptIds?.length ?? 0, u = scope.userIds?.length ?? 0;
  if (d === 0 && u === 0) return 'none';
  return `depts:${d}` + (u ? `,users:${u}` : '');
}
```

- [ ] **Step 2.2: Write the mappers (mask the secret in `authConfig`)**

Add `mapAdminConnector(row: ConnectorRow): ConnectorView` and `mapPublicConnector(row: ConnectorRow): ConnectorPublicView`. Import `maskConnectorSecrets` from Task 3 (`../vault/connectorSecret`). `mapAdminConnector` returns `authConfig: maskConnectorSecrets(row.auth_config)`; `mapPublicConnector` returns only the public fields (name = `name_zh ?? name_en ?? server_key`), **no `authConfig`**. Both compute `scopeSummary: scopeSummary(row.scope)`, `toolCount: row.tools.filter(t => !t.removed).length`, `hasDraft: !!row.draft`, and ISO-string the dates.

- [ ] **Step 2.3: Unit test the pure scope helper**

Create `enterprise_server/tests/models/connectorView.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { scopeMatches, scopeSummary } from '../../src/models/connectorView';

describe('scopeMatches', () => {
  test('allCompany grants everyone', () => {
    expect(scopeMatches({ allCompany: true, deptIds: [], userIds: [] }, [], 'u1')).toBe(true);
  });
  test('member exception grants the user', () => {
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u1')).toBe(true);
  });
  test('a granted dept grants its member', () => {
    expect(scopeMatches({ allCompany: false, deptIds: ['rd'], userIds: [] }, ['rd', 'fe'], 'u1')).toBe(true);
  });
  test('unmatched member is denied', () => {
    expect(scopeMatches({ allCompany: false, deptIds: ['sales'], userIds: [] }, ['rd'], 'u1')).toBe(false);
  });
});
```

> Subtree semantics (grant 销售部 → 华东/华南可见) are enforced **at query time** by the public route expanding `scope.deptIds` via `departments.path` (Task 6) — this pure helper checks the already-expanded caller dept set.

- [ ] **Step 2.4: Run + lint + typecheck + commit**

```bash
cd enterprise_server && npx vitest run tests/models/connectorView.test.ts
npx eslint --max-warnings 0 src/models/connectorView.ts tests/models/connectorView.test.ts
npx tsc --noEmit
git add enterprise_server/src/models/connectorView.ts enterprise_server/tests/models/connectorView.test.ts
git commit -m "feat(mcp): add connector view model and scope helpers"
```

### Task 3: Connector secret vault (per-mode auth_config encrypt/decrypt/mask)

**Files:**
- Create: `enterprise_server/src/vault/connectorSecret.ts`

**Interfaces:**
- Produces: `encryptConnectorSecrets(authConfig, authMode): Record<string,unknown>` (stores ciphertexts under `__enc__<field>` keys + strips plaintext), `decryptConnectorSecrets(authConfig): Record<string,unknown>`, `maskConnectorSecrets(authConfig): Record<string,unknown>` (non-secret passthrough, secret → `••••xxxx` or `true` sentinel), `hasStoredSecret(authConfig): boolean`.
- Secret field names per mode: `shared-key`→`apiKey`; `user-oauth`/`client-creds`→`clientSecret`; (`user-key`, `sso`, `none`→none).

- [ ] **Step 3.1: Write `connectorSecret.ts`**

```ts
import { decrypt, encrypt } from './crypto';

/** Which per-mode field holds the secret. */
export function secretFieldFor(authMode: string): string | null {
  if (authMode === 'shared-key' || authMode === 'user-oauth' || authMode === 'client-creds') {
    return authMode === 'shared-key' ? 'apiKey' : 'clientSecret';
  }
  return null;
}

const ENC_PREFIX = '__enc__';

/** Encrypt the secret field, storing it as `__enc__<field>` and removing the
 * plaintext. Non-secret fields pass through untouched. Idempotent: if the
 * field is already encrypted it is left as-is. */
export function encryptConnectorSecrets(authConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...authConfig };
  for (const mode of ['shared-key', 'user-oauth', 'client-creds'] as const) {
    const f = secretFieldFor(mode);
    if (!f) continue;
    const v = out[f];
    if (typeof v === 'string' && v.length > 0) {
      out[`${ENC_PREFIX}${f}`] = encrypt(v);
      delete out[f];
    }
  }
  return out;
}

/** Recover plaintext secret field(s) from `__enc__` ciphertexts. */
export function decryptConnectorSecrets(authConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...authConfig };
  for (const f of ['apiKey', 'clientSecret']) {
    const c = out[`${ENC_PREFIX}${f}`];
    if (typeof c === 'string') {
      try { out[f] = decrypt(c); } catch { out[f] = null; }
    }
  }
  return out;
}

/** Masked view: non-secret fields pass through; secret fields become a mask
 * or a `hasSecret` marker. Never returns plaintext. */
export function maskConnectorSecrets(authConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...authConfig };
  for (const f of ['apiKey', 'clientSecret']) {
    const c = out[`${ENC_PREFIX}${f}`];
    if (typeof c === 'string') {
      try { out[f] = `••••${decrypt(c).slice(-4)}`; } catch { out[f] = '••••'; }
    }
    delete out[`${ENC_PREFIX}${f}`];
  }
  return out;
}

export function hasStoredSecret(authConfig: Record<string, unknown>): boolean {
  return typeof authConfig['__enc__apiKey'] === 'string' || typeof authConfig['__enc__clientSecret'] === 'string';
}
```

- [ ] **Step 3.2: Unit test**

Create `enterprise_server/tests/vault/connectorSecret.test.ts` (import `'../helpers/setupEnv'` first so the master key is set). Cases: encrypt→mask round-trip keeps last-4 and strips `__enc__` from the masked view; encrypt then decrypt returns the plaintext; `hasStoredSecret` true after encrypt, false when empty; a fresh non-secret field (clientId) passes through mask unchanged.

- [ ] **Step 3.3: Run + lint + typecheck + commit**

```bash
cd enterprise_server && npx vitest run tests/vault/connectorSecret.test.ts
npx eslint --max-warnings 0 src/vault/connectorSecret.ts tests/vault/connectorSecret.test.ts && npx tsc --noEmit
git add enterprise_server/src/vault/connectorSecret.ts enterprise_server/tests/vault/connectorSecret.test.ts
git commit -m "feat(mcp): encrypt/mask per-mode connector secrets"
```

### Task 4: Audit actions + admin connector routes (CRUD / enable / delete / detail / list / categories / settings / light test)

**Files:**
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts` (add `AuditAction.McpConnector*`)
- Create: `enterprise_server/src/routes/mcpConnectors.ts`
- Modify: `enterprise_server/src/server.ts` (register `mcpConnectorsRoutes`)

**Interfaces:**
- Consumes: `ConnectorRow`/`COLUMNS`/`mapAdminConnector`/`scopeSummary` (Task 2), `encryptConnectorSecrets`/`maskConnectorSecrets`/`hasStoredSecret` (Task 3), `auditStore.write` (existing), `PP.McpView/Create/Edit/Delete`.
- Produces: `mcpConnectorsRoutes` (Hono). Wire: create `POST /admin/mcp-connectors`, list `GET /admin/mcp-connectors?orgId=`, detail `GET /admin/mcp-connectors/:id`, `PATCH /admin/mcp-connectors/:id` (incl. `enabled`), `DELETE /:id`, `POST /:id/test` (light fetch probe), categories `GET/POST/PUT/DELETE /admin/mcp-connectors/categories[/:id]`, settings `GET/PATCH /admin/mcp-connectors/settings`.

- [ ] **Step 4.1: Add AuditAction entries**

In `AuditAction` add: `McpConnectorCreate: 'mcp_connector_create', McpConnectorUpdate: 'mcp_connector_update', McpConnectorDelete: 'mcp_connector_delete', McpConnectorToggle: 'mcp_connector_toggle', McpConnectorTest: 'mcp_connector_test', McpConnectorCategoryCreate: 'mcp_connector_category_create', McpConnectorCategoryDelete: 'mcp_connector_category_delete', McpConnectorSettingUpdate: 'mcp_connector_setting_update'`.

- [ ] **Step 4.2: Write `mcpConnectors.ts`**

Route scaffolding (mirrors `providerKeys.ts`):

```ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { COLUMNS, mapAdminConnector, type ConnectorRow, type ConnectorScope } from '../models/connectorView';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';
import { encryptConnectorSecrets, maskConnectorSecrets } from '../vault/connectorSecret';

const scopeSchema = z.object({
  allCompany: z.boolean().optional().default(false),
  deptIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
});

const authModeEnum = z.enum(['none','shared-key','user-key','user-oauth','client-creds','sso']);
const transportEnum = z.enum(['http','sse']);

const createSchema = z.object({
  orgId: z.string(),
  serverKey: z.string().min(1).regex(/^[a-z0-9-]+$/),
  url: z.string().min(1),
  nameEn: z.string().optional(), nameZh: z.string().optional(),
  version: z.string().optional().default('1.0.0'),
  categoryId: z.string().nullable().optional(),
  description: z.string().max(200).optional(),
  transport: transportEnum.optional().default('http'),
  authMode: authModeEnum.optional().default('none'),
  authConfig: z.record(z.unknown()).optional().default({}),
  scope: scopeSchema.optional(),
});

export const mcpConnectorsRoutes = new Hono();
mcpConnectorsRoutes.use('/admin/mcp-connectors/*', requireAuth);
```

**Shared helpers (top of file):**
```ts
async function getOwn(connectorId: string, orgId: string): Promise<ConnectorRow | null> {
  const r = await pool.query<ConnectorRow>(`SELECT ${COLUMNS} FROM mcp_connectors WHERE id = $1 AND org_id = $2`, [connectorId, orgId]);
  return r.rowCount ? r.rows[0] : null;
}
function authStatusFor(authMode: string): 'configured' | 'pending' { return authMode === 'none' ? 'configured' : 'pending'; }
/** Per-mode required non-secret fields that must be present to publish. */
function missingAuthField(authMode: string, authConfig: Record<string, unknown>): string | null {
  if (authMode === 'shared-key') return authConfig.apiKey ? null : 'apiKey';
  if (authMode === 'user-oauth' || authMode === 'client-creds') {
    if (!authConfig.clientId) return 'clientId';
    if (authMode === 'user-oauth' && !authConfig.clientSecret) return 'clientSecret';
    return authConfig.clientSecret ? null : 'clientSecret';
  }
  return null; // none / user-key / sso have no admin-filled secret requirement
}
function sseOauthCombination(transport: string, authMode: string): boolean {
  return transport === 'sse' && ['user-oauth','client-creds','sso'].includes(authMode);
}
```

**Create** (`requirePermission(PP.McpCreate)`):
```ts
mcpConnectorsRoutes.post('/admin/mcp-connectors', requirePermission(PP.McpCreate), async c => {
  const claims = c.get('claims');
  const b = createSchema.safeParse(await c.req.json());
  if (!b.success) return c.json({ error: 'invalid_body', issues: b.error.issues }, 400);
  if (b.data.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  if (sseOauthCombination(b.data.transport, b.data.authMode)) return c.json({ error: 'sse_oauth_not_supported' }, 400);
  const dup = await pool.query('SELECT 1 FROM mcp_connectors WHERE org_id=$1 AND server_key=$2', [b.data.orgId, b.data.serverKey]);
  if (dup.rowCount) return c.json({ error: 'server_key_taken' }, 409);
  const scope: ConnectorScope = b.data.scope ?? { allCompany: false, deptIds: [], userIds: [] };
  const authConfig = encryptConnectorSecrets(b.data.authConfig);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mcp_connectors (id, org_id, server_key, name_en, name_zh, version, category_id, description,
       connector_type, url, transport, auth_mode, auth_config, auth_status, enabled, scope, tools, draft)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mcp',$9,$10,$11,$12,$13,TRUE,$14,$15, NULL)`,
    [id, b.data.orgId, b.data.serverKey, b.data.nameEn ?? null, b.data.nameZh ?? null, b.data.version,
     b.data.categoryId ?? null, b.data.description ?? null, b.data.url, b.data.transport, b.data.authMode,
     JSON.stringify(authConfig), authStatusFor(b.data.authMode), JSON.stringify(scope), JSON.stringify([])]);
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: AuditAction.McpConnectorCreate, targetType: 'connector', targetId: id, payload: { serverKey: b.data.serverKey, authMode: b.data.authMode } });
  return c.json({ id }, 201);
});
```

**List** (`PP.McpView`): `orgId` query required + cross-org guard → `SELECT ${COLUMNS} FROM mcp_connectors WHERE org_id=$1 ORDER BY created_at DESC` → `c.json(rows.map(mapAdminConnector))`.

**Detail** (`PP.McpView`): `getOwn` → 404 if null → `c.json(mapAdminConnector(row))`.

**PATCH** (`PP.McpEdit`): parse `{ nameEn?, nameZh?, url?, version?, categoryId?, description?, transport?, authMode?, authConfig?, scope?, enabled? }`; build dynamic SET (mirror `mcpMarketplaceAdmin.ts:97-133` `push` pattern); if `authConfig` supplied and has a plaintext secret, `encryptConnectorSecrets` the **merged** config (decrypt existing first via a raw read, then re-encrypt only changed secret) and set `secret_meta = { lastUpdatedAt: now, lastUpdatedBy: claims.sub }`; if `enabled` present, also audit `McpConnectorToggle`; if `authMode` present and differs from current → the publish path is the one that warns, but a PATCH that flips `auth_mode` must set `auth_status='pending'`. Cross-org 404 via `getOwn`. Audit `McpConnectorUpdate` with `{ fields }` (keys changed only).

**DELETE** (`PP.McpDelete`): `getOwn` → 404 → `DELETE` → return `{ ok:true, impact: { scopeSummary: scopeSummary(row.scope), draftRemoved: !!row.draft } }` (best-effort dependent list is `[]` in V1 — no agent/skill binding). Audit `McpConnectorDelete`.

**Test (light, P0)** (`PP.McpEdit`): read row; if `!row.url` → 400; build headers from decrypted `authConfig` (`shared-key` → `Authorization: Bearer <apiKey>`; else none); `fetch(url, { signal: AbortSignal.timeout(row last_latency or 30_000) })`; 2xx<400 → `connected` else `failed`; persist `last_test_at/last_test_status/last_latency_ms`; return `{ status, latencyMs?, error? }`. **No tool discovery in P0** (`tools` untouched). Audit `McpConnectorTest`.

**Categories** (`PP.McpView`/`McpEdit`): `GET` → `SELECT id, name FROM mcp_connector_categories WHERE org_id=$1 ORDER BY name`; `POST { name }` → unique per org (409 on dup) + **cap 20** (`SELECT count(*)` ≥ 20 → 409 `category_cap`); `PUT /:id { name }`; `DELETE /:id` → move connectors to `category_id=NULL` then delete (reserved none). Audit create/delete.

**Settings** (`PP.McpView`/`McpEdit`): `GET` → `{ membersCanSubmit: boolean }` from `orgs`; `PATCH { membersCanSubmit }` → `UPDATE orgs SET members_can_submit_connectors=$1 WHERE id=$2`. Audit `McpConnectorSettingUpdate`.

- [ ] **Step 4.3: Register the route**

In `enterprise_server/src/server.ts`: `import { mcpConnectorsRoutes } from './routes/mcpConnectors';` and `app.route('/', mcpConnectorsRoutes);` (keep the public `mcpMarketplaceRoutes` registration; the old `mcpMarketplaceAdminRoutes` registration is removed in Task 6).

- [ ] **Step 4.4: Typecheck (routes compile; tests added in Task 5)**

Run: `cd enterprise_server && npx tsc --noEmit` and `npx eslint --max-warnings 0 src/routes/mcpConnectors.ts src/shared/enterpriseServerConstants.ts src/server.ts`. Expected: clean.

- [ ] **Step 4.5: Commit**

```bash
git add enterprise_server/src/routes/mcpConnectors.ts enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/src/server.ts
git commit -m "feat(mcp): admin connector CRUD, categories, settings routes

Org-scoped admin routes for connectors (cross-org 404), 6-mode auth with
per-mode secret encryption, SSE+OAuth rejection, category cap of 20, the
members_can_submit toggle, and a light test-connection probe. All writes
audit with {before, after}."
```

### Task 5: Server route tests (permissions, validation, secret non-leak, categories, settings)

**Files:**
- Create: `enterprise_server/tests/routes/mcpConnectors.test.ts`

- [ ] **Step 5.1: Write the test suite**

Model on `tests/routes/providerKeysGating.test.ts` (seed env mock, `resetSchema`+`runMigrations` in `beforeEach`, `signToken`, Hono app). Seed: one org `o1`, a `super_admin` user, a `member` user in dept `rd` (create via `roleService`/direct SQL + `user_departments`), and a dept tree (`rd` with child `fe`). Cases:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { mcpConnectorsRoutes } from '../../src/routes/mcpConnectors';

const app = new Hono();
app.route('/', mcpConnectorsRoutes);

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
  await testPool.query(`INSERT INTO departments(id,org_id,name,path) VALUES ('rd','o1','R&D','/rd'), ('fe','o1','Frontend','/rd/fe')`);
  await testPool.query(`INSERT INTO users(id,org_id,username,department_id) VALUES ('u1','o1','a','rd'),('u2','o1','m','fe')`);
  await testPool.query(`INSERT INTO user_departments(user_id,dept_id) VALUES ('u1','rd'),('u2','fe')`);
}
const adminTok = () => signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
```

Assert at minimum:
- `POST /admin/mcp-connectors` as super_admin (body with `orgId:'o1'`, `serverKey`, `url`, `authMode:'shared-key'`, `authConfig:{apiKey:'sk-x'}`) → 201 `{ id }`; a follow-up `GET detail` returns `authConfig.apiKey` **masked** (matches `/^••••/`) and `JSON.stringify(detail)` does **not** contain `'sk-x'`.
- `POST` with a duplicate `serverKey` → 409 `server_key_taken`.
- `POST` with `transport:'sse'`, `authMode:'user-oauth'` → 400 `sse_oauth_not_supported`.
- `POST` `authMode:'shared-key'` with empty `authConfig` → 400 (missing required secret — assert `missingAuthField` guard returns `apiKey`); *if you surface validation at create* return 400.
- Cross-org: a second org `o2` admin POSTing then `GET o1`'s connector by id → 404.
- `PATCH { enabled:false }` → 200, list reflects `enabled:false`.
- `DELETE` → 200 `{ ok:true }`; subsequent detail → 404.
- Categories: `POST` a name → 201; duplicate → 409; creating the 21st → 409 `category_cap`.
- Settings: `PATCH { membersCanSubmit:true }` → 200; `GET` → `{ membersCanSubmit:true }`.
- Audit: after create, `audit_events` has a row `action='mcp_connector_create'`, `target_type='connector'`.

- [ ] **Step 5.2: Run per-file**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpConnectors.test.ts`. Expected: green. (Fix route bugs surfaced — do NOT weaken assertions without user sign-off.)

- [ ] **Step 5.3: Commit**

```bash
git add enterprise_server/tests/routes/mcpConnectors.test.ts
git commit -m "test(mcp): cover connector admin routes (authz, secrets, validation)"
```

### Task 6: Re-point public `/api/mcp-marketplace` to connectors (scope-based)

**Files:**
- Modify: `enterprise_server/src/routes/mcpMarketplace.ts`
- Modify: `enterprise_server/src/server.ts` (remove `mcpMarketplaceAdminRoutes` import + registration)

**Interfaces:**
- Produces: `GET /api/mcp-marketplace` → `{ categories, servers }` where `servers` = `ConnectorPublicView[]` filtered by scope + `enabled`, `categories` = distinct `category_id` of visible set (name from `mcp_connector_categories`).

- [ ] **Step 6.1: Rewrite the route**

```ts
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import { scopeApi } from '../auth/scopeResolver';
import { mapPublicConnector, type ConnectorRow, COLUMNS } from '../models/connectorView';

export const mcpMarketplaceRoutes = new Hono();
mcpMarketplaceRoutes.use('/api/mcp-marketplace', requireAuth);

/** Visible dept set = the caller's own depts expanded to every descendant via
 * `departments.path` prefix. Granting 销售部 makes 华东/华南 visible. */
async function visibleDeptSet(orgId: string, userId: string): Promise<Set<string>> {
  const own = await scopeApi.deptIdsFor(orgId, userId);
  const paths = await pool.query<{ id: string; path: string }>(`SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const pathOf = new Map(paths.rows.map((r) => [r.id, r.path]));
  const out = new Set<string>(own);
  for (const root of own) {
    const prefix = pathOf.get(root);
    if (!prefix) continue;
    for (const [id, path] of pathOf) {
      if (path === prefix || path.startsWith(prefix + '/')) out.add(id);
    }
  }
  return out;
}

mcpMarketplaceRoutes.get('/api/mcp-marketplace', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes('super_admin');
  const callerDeptIds = isSuperAdmin ? [] : await visibleDeptSet(orgId, claims.sub);

  const r = await pool.query<ConnectorRow>(`SELECT ${COLUMNS} FROM mcp_connectors WHERE org_id = $1 AND enabled = TRUE`, [orgId]);
  const visible = r.rows.filter((row) => isSuperAdmin || (
    row.scope.allCompany || row.scope.userIds.includes(claims.sub) ||
    row.scope.deptIds.some((d) => callerDeptIds.has(d))
  ));

  const catIds = Array.from(new Set(visible.map((v) => v.category_id).filter(Boolean))) as string[];
  const cats = catIds.length === 0 ? { rows: [] as { id: string; name: string }[] }
    : await pool.query<{ id: string; name: string }>(`SELECT id, name FROM mcp_connector_categories WHERE org_id=$1 AND id = ANY($2) ORDER BY name`, [orgId, catIds]);

  return c.json({
    categories: cats.rows.map((c) => ({ id: c.id, name_zh: c.name, name_en: c.name })),
    servers: visible.map(mapPublicConnector),
  });
});
```

- [ ] **Step 6.2: Drop the old admin route registration**

In `src/server.ts`, remove `import { mcpMarketplaceAdminRoutes } from './routes/mcpMarketplaceAdmin';` and its `app.route('/', mcpMarketplaceAdminRoutes);` line. (Keep the file on disk, unserved.)

- [ ] **Step 6.3: Add a scope-visibility test**

Create `enterprise_server/tests/routes/mcpMarketplaceScope.test.ts` (seed harness as Task 5). Cases:
- A member in `fe` (under `rd`) sees a connector with `scope.deptIds=['rd']` (subtree grant) and one with `allCompany:true`, and one with `userIds=['u2']`; does **not** see one with `scope.deptIds=['sales']`.
- A `super_admin` sees all enabled connectors regardless of scope.
- `enabled=false` connectors never appear for anyone.
- A connector with `scope.deptIds=['rd']` is **not** visible to a user in `sales`.

Run: `npx vitest run tests/routes/mcpMarketplaceScope.test.ts`. Expected: green.

- [ ] **Step 6.4: Typecheck + commit**

```bash
cd enterprise_server && npx tsc --noEmit
git add enterprise_server/src/routes/mcpMarketplace.ts enterprise_server/src/server.ts enterprise_server/tests/routes/mcpMarketplaceScope.test.ts
git commit -m "feat(mcp): serve the public marketplace from scope-scoped connectors

Re-point GET /api/mcp-marketplace to mcp_connectors with department-subtree +
member-exception visibility (super_admin sees all enabled). Removes the
retired role-based admin route registration."
```

### Task 7: Desktop client re-point (new wire + type)

**Files:**
- Modify: `src/renderer/types/mcp.ts`
- Modify: `src/main/auth/enterpriseClient.ts`

**Interfaces:**
- Produces: `McpEnterpriseMarketServer` (new fields), `listEnterpriseMcps()` returning the new shape.

- [ ] **Step 7.1: Update `McpEnterpriseMarketServer`**

Replace the interface (`src/renderer/types/mcp.ts:125`) with the public wire (drop `allowedRoles`, `command`, `lastStatus/latency/lastTestedAt`, `credentialMasked`; add the new fields):

```ts
export interface McpEnterpriseMarketServer {
  id: string;
  serverKey: string;
  name: string;
  nameZh: string | null;
  description: string;
  category: string;
  version: string;
  connectorType: 'mcp' | 'app';
  url: string;
  transport: 'http' | 'sse';
  authMode: 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
  authStatus: 'configured' | 'pending';
  scopeSummary: string;
  hasDraft: boolean;
  enabled: boolean;
  toolCount: number;
}
```

- [ ] **Step 7.2: Update `listEnterpriseMcps()`**

In `enterpriseClient.ts:289-340`, change both the declared return type and the `res.json() as Promise<...>` cast to the new `McpEnterpriseMarketServer[]` shape (categories unchanged: `{ id, name_zh, name_en }`). Remove the old fields from the inline type.

- [ ] **Step 7.3: Fix renderer consumers of the old fields**

Grep `allowedRoles|credentialMasked|lastStatus|lastLatencyMs|lastTestedAt` under `src/renderer/components/mcp/` and `src/renderer/services/mcp.ts`; replace references with the new fields (e.g. a connector's auth state now surfaces via `authStatus`; drop the role-count display if present). Keep the desktop doing **no** scope filtering (it relies on the server's filtered list).

- [ ] **Step 7.4: Typecheck + commit**

Run: `npx tsc --project electron-tsconfig.json --noEmit`. Fix any fallout. Commit:

```bash
git add src/renderer/types/mcp.ts src/main/auth/enterpriseClient.ts <any touched renderer files>
git commit -m "feat(mcp): align desktop enterprise-market wire to scope-scoped connectors

McpEnterpriseMarketServer drops role/stdio legacy fields and carries serverKey,
version, authMode (6-mode), authStatus, scopeSummary and toolCount. The
desktop still applies no filtering of its own."
```

---

## P0 — admin console (enterprise_server/web)

### Task 8: SPA API client (`connectors.ts`) + i18n keys

**Files:**
- Create: `enterprise_server/web/src/api/connectors.ts`
- Modify: `enterprise_server/web/src/i18n.ts`
- Delete (after Task 12 lands): `enterprise_server/web/src/api/mcpMarketplace.ts`

**Interfaces:**
- Produces: `Connector`, `ConnectorPublicScope`-less admin types, `connectorApi` (list/detail/create/patch/delete/saveDraft/publish/rollback/test + categories + settings + submissions + `listDeptTree`/`listMembers` reusing `departments.ts`/`users.ts`).

- [ ] **Step 8.1: Write `connectors.ts`**

```ts
import { apiClient } from './client';
import { deptApi } from './departments';
import { userApi } from './users';

export type AuthMode6 = 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
export type Transport2 = 'http' | 'sse';
export interface ConnectorScope { allCompany: boolean; deptIds: string[]; userIds: string[] }
export interface ToolEntry { name: string; desc?: string; enabled: boolean; removed?: boolean }
export interface Connector {
  id: string; serverKey: string; nameEn: string | null; nameZh: string | null;
  version: string; categoryId: string | null; description: string | null;
  connectorType: 'mcp' | 'app'; url: string; transport: Transport2; authMode: AuthMode6;
  authConfig: Record<string, unknown>;
  secretMeta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  authStatus: 'configured' | 'pending'; enabled: boolean;
  scope: ConnectorScope; scopeSummary: string; tools: ToolEntry[]; toolCount: number; hasDraft: boolean;
  lastTestAt: string | null; lastTestStatus: string | null; lastLatencyMs: number | null;
  createdAt: string; updatedAt: string;
}
export interface ConnectorInput {
  serverKey: string; url: string; nameEn?: string; nameZh?: string; version?: string;
  categoryId?: string | null; description?: string; transport?: Transport2; authMode?: AuthMode6;
  authConfig?: Record<string, unknown>; scope?: ConnectorScope;
}
export interface ConnectorPatch extends Partial<ConnectorInput> { enabled?: boolean }

export const connectorApi = {
  list: () => apiClient.get<Connector[]>('/admin/mcp-connectors'),
  get: (id: string) => apiClient.get<Connector>(`/admin/mcp-connectors/${id}`),
  create: (input: ConnectorInput) => apiClient.post<{ id: string }>('/admin/mcp-connectors', input),
  patch: (id: string, patch: ConnectorPatch) => apiClient.patch<{ ok: boolean }>(`/admin/mcp-connectors/${id}`, patch),
  del: (id: string) => apiClient.delete<{ ok: true }>(`/admin/mcp-connectors/${id}`),
  test: (id: string) => apiClient.post<{ status: string; latencyMs?: number; error?: string }>(`/admin/mcp-connectors/${id}/test`),
  listCategories: () => apiClient.get<{ id: string; name: string }[]>('/admin/mcp-connectors/categories'),
  createCategory: (name: string) => apiClient.post<{ id: string }>('/admin/mcp-connectors/categories', { name }),
  deleteCategory: (id: string) => apiClient.delete<{ ok: true }>(`/admin/mcp-connectors/categories/${id}`),
  getSettings: () => apiClient.get<{ membersCanSubmit: boolean }>('/admin/mcp-connectors/settings'),
  setSettings: (b: { membersCanSubmit: boolean }) => apiClient.patch<{ ok: true }>('/admin/mcp-connectors/settings', b),
  // Scope selector data (reuses existing dept/member endpoints).
  listDeptTree: (orgId: string) => deptApi.list(orgId),
  listMembers: (orgId: string) => userApi.list(orgId),
};
```

> **`orgId` source (canonical SPA pattern):** in the page (`MCPManagePage.tsx`), `const { claims } = useAuth();` then `const orgId = claims?.orgId ?? 'default-org';` — exactly how `UsersPage.tsx:51,57` and `DepartmentsPage.tsx:51` do it. Pass this `orgId` into the drawer and the `connectorApi` calls that take it. Do not hardcode a different value.

- [ ] **Step 8.2: Add i18n keys (en + zh, both blocks)**

Add under the existing `mcp.*` block in `web/src/i18n.ts` — e.g. `mcp.tabs.org`, `mcp.tabs.review`, `mcp.globalSetting.title`, `mcp.globalSetting.desc`, `mcp.tabCount`, `mcp.typeFilter.all|mcp|app`, `mcp.auth.none|sharedKey|userKey|userOAuth|clientCreds|sso`, `mcp.authHint.*`, `mcp.transport.http|sse`, `mcp.transportSseHint`, `mcp.scope.title|empty|allCompany|deptsUsers|memberException`, `mcp.draft.banner`, `mcp.draft.save|publish|cancel`, `mcp.delete.title|impact|confirm`, `mcp.review.*`, `mcp.reject.reason|empty`, `mcp.url.warnInternal|warnHttp|ok`, `mcp.test.ok|err|testing|empty`, `mcp.tools.createNote|editNote|removed`, `mcp.version.current|rollback`, etc. **Every key in both blocks.**

- [ ] **Step 8.3: Commit**

```bash
git add enterprise_server/web/src/api/connectors.ts enterprise_server/web/src/i18n.ts
git commit -m "feat(mcp): add connector SPA API client and i18n keys"
```

### Task 9: Category panel, card grid, card + menu (org connectors view)

**Files:**
- Create: `web/src/pages/mcpManage/ConnectorCategoryPanel.tsx`, `ConnectorCardGrid.tsx`, `ConnectorCard.tsx`, `ConnectorCardMenu.tsx`
- Modify: `web/src/pages/mcpManage/AddCategoryModal.tsx` (name-only + dup/cap errors)

- [ ] **Step 9.1: `ConnectorCategoryPanel.tsx`**

Props: `{ categories: {id,name}[]; counts: Record<string,number>; total: number; current: string; onSelect(id); onAdd(); search; onSearch }`. Renders: a search box (filters the category list **locally by name only**), the `全部` row (`total` count), the category rows (name + count badge), and a dashed `+ 新增分类` button (`onAdd`). Mirrors the current `CategorySidebar` layout/ids.

- [ ] **Step 9.2: `ConnectorCard.tsx`**

Props: `{ c: Connector; onOpen(id); onToggle(id, enabled); onMenu(e, id) }`. Renders (per prototype):
- header: icon badge (initials of name, colored), name + status dot + `启用/停用` tag, monospace `serverKey`.
- description.
- tags row: type tag (`mcp`→「MCP 连接器」cyan / `app`→「应用连接器」purple), auth-mode tag (`none`→gray, else blue), `N 个工具`, `有草稿` (orange, when `hasDraft`), `待配置授权` (orange, when `authStatus==='pending'`), scope summary tag (「未授权」/「全公司」/「N 个部门(+M 人)」 from `scopeSummary` + `scope`).
- **meta row: `v{version}` only** (no metrics).
- status **Switch** (top-right) with `onClick={e => e.stopPropagation()}` calling `onToggle`; menu `⋯` button (top-right) `onClick={e => { e.stopPropagation(); onMenu(e, c.id); }}`.

- [ ] **Step 9.3: `ConnectorCardMenu.tsx`**

A small positioned menu (like the prototype `#ctxMenu`). Props: `{ open; x; y; connector; onClose; onEdit(id); onToggle(id,enabled); onDelete(id) }`. Items: 编辑配置 / 停用·启用 / 删除连接器 (red). Close on outside click.

- [ ] **Step 9.4: `ConnectorCardGrid.tsx`**

Props: `{ connectors; typeFilter; onTypeFilter; categoryName; count; onAdd; onOpen; onToggle; onMenuOpen }`. Renders the type-filter chips (全部 / MCP 连接器 / 应用连接器) + a 2-col grid of `ConnectorCard` (filtered by `typeFilter` client-side). Empty state when none.

- [ ] **Step 9.5: Commit** (after a component test, Task 10)

```bash
git add enterprise_server/web/src/pages/mcpManage/Connector*.tsx enterprise_server/web/src/pages/mcpManage/AddCategoryModal.tsx
git commit -m "feat(mcp): connector category panel and card grid (no metrics)"
```

### Task 10: Org-connector components tests

**Files:** Create/replace `web/tests/pages/mcpManage/ConnectorCard.test.tsx`, `ConnectorCategoryPanel.test.tsx`, `ConnectorCardGrid.test.tsx`.

- [ ] **Step 10.1: Write component tests** (testing-library, mirror existing `mcpManage/*.test.tsx`):
- `ConnectorCard`: shows `serverKey` in monospace, auth-mode tag text, `N 个工具`, `v{version}`; shows `有草稿` when `hasDraft`; shows `待配置授权` when `authStatus==='pending'`; **does not** render any 调用/错误率 text; clicking the switch calls `onToggle` and does **not** bubble `onOpen`; clicking `⋯` calls `onMenu`.
- `ConnectorCategoryPanel`: renders 全部 + categories with counts; search input filters rows; `+ 新增分类` fires `onAdd`.
- `ConnectorCardGrid`: type filter chips render; selecting `MCP 连接器` hides `app` connectors.

- [ ] **Step 10.2: Run per-file**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/ConnectorCard.test.tsx tests/pages/mcpManage/ConnectorCategoryPanel.test.tsx tests/pages/mcpManage/ConnectorCardGrid.test.tsx`. Expected: green.

- [ ] **Step 10.3: Commit**

```bash
git add enterprise_server/web/tests/pages/mcpManage
git commit -m "test(mcp): connector card/panel/grid component coverage"
```

### Task 11: Create/Edit drawer (basic info, conn config + 6 auth fields, tools, scope, delete)

> **P0 scope:** create + edit-and-publish (direct `PATCH`). The two-step **draft** (存草稿 / 草稿横幅 / load-draft-on-edit) and **version history/rollback** are **P1 (Task 16)** and extend this drawer — do not build them here. The card's `有草稿` tag and `hasDraft` field already exist in the wire (schema has the `draft` column); in P0 `draft` is always null so the tag simply never shows.

**Files:** Create (P0): `web/src/pages/mcpManage/ConnectorDrawer.tsx`, `ConnectorBasicInfo.tsx`, `ConnectorConnConfig.tsx`, `ConnectorAuthFields.tsx`, `ConnectorToolPermissions.tsx`, `ConnectorScopeSelector.tsx`, `DeleteConnectorModal.tsx`. Create (P1, Task 16): `ConnectorVersionHistory.tsx`, `RollbackModal.tsx`.

**Interfaces:**
- Consumes: `connectorApi` (Task 8), `Connector`/`ConnectorInput`/`ConnectorPatch` (Task 8).
- Produces: `ConnectorDrawer` props `{ mode: 'create'|'edit'; orgId: string; connector?: Connector; depts: DeptNode[]; members: MemberRow[]; categories: {id,name}[]; onClose(); onSaved(); onDeleted() }`. (P1, Task 16 adds `versions: VersionRow[]` and the draft-aware footer.)

- [ ] **Step 11.1: `ConnectorDrawer.tsx` (form state + mode + footer)**

Holds a single form state object (all editable fields + `scope` set + `tools` toggles + `authConfig` sub-fields). Loads: create → defaults (`version:'1.0.0'`, `transport:'http'`, `authMode:'none'`, `scope:{allCompany:false,deptIds:[],userIds:[]}`); edit → from `connector` live row. **P0 footer:** create = 取消 / 创建并发布; edit = 删除 (left) | 取消 · 发布. On 创建并发布 → `create`; on 发布 (edit) → `patch` with the changed fields (this IS the publish in P0 — apply directly; `connectorApi.publish`/two-step draft is added in **Task 16**). Validate `serverKey`+`url` present (else toast), then `onSaved()`. **P1 (Task 16) will extend this drawer** to add the 存草稿 button, the draft banner (when `connector.hasDraft`), and load `connector.draft` instead of the live row.

- [ ] **Step 11.2: `ConnectorBasicInfo.tsx`** — Server Key*, **URL* + 测试连接 button** (calls `connectorApi.test` in edit-mode, or a client-side URL-validation-only in create-mode; inline result: success shows 「发现 N 个工具」 only in edit-mode after P1 sync, else 「地址校验通过」; failure shows reason), 展示名 EN / 展示名 ZH, 版本, 分类 (select from `categories`), 描述 (≤200). Client-side **URL validation** on change + on auth change: internal/reserved-address (regex `localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|\.internal`) → orange warn (出站白名单); non-HTTPS + auth in `{user-oauth,shared-key,client-creds}` → orange warn (凭据明文); else green 「地址校验通过」.

- [ ] **Step 11.3: `ConnectorConnConfig.tsx` + `ConnectorAuthFields.tsx`** — 传输协议 select (`http`/`sse`) with **SSE coupling**: choosing `sse` disables the `user-oauth`/`client-creds`/`sso` options and, if one is selected, resets `authMode` to `none` + hint. 授权方式 select (6) + hint line. `ConnectorAuthFields` renders the mode-specific block:
  - `none` → warning card.
  - `shared-key` → 组织 API Key (password; edit placeholder = masked value; blank=keep) + secret-meta line.
  - `user-key` → explanation card (admin fills nothing).
  - `user-oauth` → read-only callback URL (default `https://oauth.genwork.cn/mcp/callback`) + copy button, Client ID, Client Secret (password + secret-meta), **scope multi-select** (preset grouped list + custom input + chips).
  - `client-creds` → Token URL, Client ID, Client Secret.
  - `sso` → SSO app select (OIDC/飞书/钉钉/企业微信).
  - 超时时间 (5–300, default 30) / 重试次数 (0–5, default 2) (store in `authConfig.timeoutSeconds`/`retryCount`).
  - **Destructive auth-mode switch confirm** (edit, 发布): if `authMode` changed from the live connector → `RollbackModal`-style confirm 「发布后已授权员工的授权将失效，需重新完成授权」 (cancel → no publish).

- [ ] **Step 11.4: `ConnectorToolPermissions.tsx`** — create = explanation block; edit (P1) = one row per tool (mono name + desc + enable switch; `removed` grayed 「服务端已移除」, switch disabled). P0: create-only block (tools empty until handshake).

- [ ] **Step 11.5: `ConnectorScopeSelector.tsx`** — trigger showing summary (「已选 N 个部门 + M 位成员例外」/「未选择，保存后所有部门均不可见」/「已选：总公司（全公司）」); popover with **dept tree** (from `depts: DeptNode[]`, recursive checkboxes; checking the **root** node = `allCompany:true` → uncheck all children + clear members) and **成员例外** picker (select a member + 添加 → adds to `userIds`, and clears `allCompany`). Selected items render chips (dept=blue, member=purple 👤, × removes). Empty allowed.

- [ ] **Step 11.6: `ConnectorVersionHistory.tsx`** (P1) — version rows (version + 当前版本 tag + date + note); non-current rows → 「回滚到此版本」 → `RollbackModal` confirm → `connectorApi.rollback` (added to `connectors.ts` in P1).

- [ ] **Step 11.7: `DeleteConnectorModal.tsx`** — impact list (授权对象 from scope; 依赖将失效 — V1 best-effort, show 「依赖此连接器的技能/智能体将执行失败」; 历史日志 90 天; OAuth 与 Secret 立即吊销) + 确认删除 → `connectorApi.del` → `onDeleted()`.

- [ ] **Step 11.8: Commit** (drawer component test in Task 12)

```bash
git add enterprise_server/web/src/pages/mcpManage
git commit -m "feat(mcp): connector create/edit drawer (6-mode auth, scope, draft)"
```

### Task 12: Review view + rewritten page shell

**Files:**
- Create: `web/src/pages/mcpManage/ReviewView.tsx`, `ReviewDetailDrawer.tsx`, `RejectReasonModal.tsx`
- Rewrite: `web/src/pages/MCPManagePage.tsx`
- Delete: `web/src/pages/mcpManage/{CategorySidebar,McpCardGrid,CreateMcpForm,DetailDrawer,RoleChips}.tsx` + `web/src/api/mcpMarketplace.ts` (once nothing imports them)
- Modify: `web/src/i18n.ts` (any review-specific keys missing)

**Interfaces:**
- `connectorApi` submissions (add to Task 8's client): `listSubmissions(orgId)`, `approveSubmission(id)`, `rejectSubmission(id, reason)`, `withdrawSubmission(id)` — routes exist in Task 13 (backend) / Task 14 (SPA submit entry). For P0 the review queue is admin-readable; `submit` is called from the desktop (Task 15), so the SPA only needs list/approve/reject.

- [ ] **Step 12.1: `ReviewView.tsx`** — status filter chips (待审核/已通过/已驳回/已撤回/全部, each with count); table rows: 名称 / 描述 (rejected → reason inline) / 作者 (name + dept) / 版本 / 提交时间 / 状态 tag / 操作 (待审核 → 通过 · 驳回; else → 详情). Row click → `ReviewDetailDrawer`. 通过 → `approveSubmission`; 驳回 → `RejectReasonModal` (forced) → `rejectSubmission`.

- [ ] **Step 12.2: `ReviewDetailDrawer.tsx`** — status tag, 提交人, 提交时间, 描述, **提交的完整配置** (url / authMode / scope / tool list from `submission.cfg`); 待审核 footer = 取消 / 驳回 / 通过并发布.

- [ ] **Step 12.3: `RejectReasonModal.tsx`** — textarea, empty → block + toast 「请填写驳回意见」.

- [ ] **Step 12.4: Rewrite `MCPManagePage.tsx`** — top: page title 「连接器」 + subtitle + 「添加连接器」 button; **global-setting card** (`getSettings` → `members_can_submit_connectors` switch, `setSettings` on toggle + toast 「设置已保存」); **view tabs** (企业连接器 `<count>` / 连接器审核 `<pendingCount>`); render `OrgConnectorsView` (category panel + grid + drawer + category modal + delete modal) or `ReviewView`. Fetch via `useQuery`: `['connector','list']`, `['connector','categories']`, `['connector','submissions']`, `['org','depts']`, `['org','members']`, `['connector','settings']`. Escape closes drawer/modal.

- [ ] **Step 12.5: Remove superseded files + wire i18n**

Delete the old `mcpManage/` components and `mcpMarketplace.ts` after confirming no imports remain (`grep -rn "McpCardGrid\|CreateMcpForm\|DetailDrawer\|RoleChips\|mcpMarketplaceApi" web/src`). Update `i18n.ts` with any review keys.

- [ ] **Step 12.6: Page-level test + run**

Replace `web/tests/pages/mcpManage/*.test.tsx` with a page test: renders two tabs + the global-setting switch; switching to 连接器审核 shows the review table; the 添加连接器 button opens the create drawer. Run: `npx vitest run tests/pages/mcpManage` (per-file as needed). Typecheck: `npx tsc --noEmit`.

- [ ] **Step 12.7: Commit**

```bash
git add enterprise_server/web/src/pages enterprise_server/web/src/api/connectors.ts enterprise_server/web/src/i18n.ts
git commit -m "feat(mcp): rewrite MCP admin console (org connectors + review tabs)

Two-tab console per the prototype: org connectors (category panel, card grid,
create/edit drawer, dept+member scope) and the review queue (approve/reject
with forced reason). Global self-service toggle. Drops the role-based
marketplace components."
```

---

## P0 — desktop member submit entry (P1 deliverable, grouped here for the flow)

### Task 13: Backend submission routes (list / submit / approve / reject / withdraw)

**Files:**
- Create: `enterprise_server/src/routes/mcpSubmissions.ts`
- Modify: `enterprise_server/src/server.ts` (register)

**Interfaces:**
- Consumes: `createSchema`-like validation (reuse from Task 4 via a shared `connectorBody.ts` if you extract it; else redeclare), `encryptConnectorSecrets`, `auditStore`, `PP.McpView/Edit`.
- Produces: `mcpSubmissionsRoutes` → `GET /admin/mcp-connectors/submissions?orgId=&status=`, `POST /admin/mcp-connectors/submissions` (member, gated by org toggle), `POST /:id/approve` (`PP.McpEdit`), `POST /:id/reject` (`PP.McpEdit`, forced reason), `POST /:id/withdraw` (author).

- [ ] **Step 13.1: Write the routes**

- `POST /submissions`: `requireAuth` (member, not necessarily admin). Read `orgs.members_can_submit_connectors` for `claims.orgId`; if `false` → 403 `submission_disabled`. Validate the config body (same rules as create, minus org-mismatch). Insert row (`status:'pending'`, `author_id: claims.sub`). Return `{ id }`.
- `GET /submissions?orgId=`: cross-org guard → list ordered by `submitted_at DESC`; support `?status=` filter. Return rows + per-status counts.
- `POST /:id/approve`: `PP.McpEdit`. Load submission (cross-org 404). Build a connector from `cfg` (reuse the create INSERT logic — **extract a `createConnectorFromCfg(orgId, cfg, createdBy, sourceNote)` helper** shared with the create route); `server_key` collision → append `-2` (loop until unique). Insert versions row `{version, note:'审核通过发布', current:true}`. Set submission `status='approved'`, `approved_connector_id`. Audit.
- `POST /:id/reject`: `PP.McpEdit`. Body `{ reason }` required (empty → 400 `reason_required`). Set `status='rejected'`, `reject_reason`. Audit.
- `POST /:id/withdraw`: caller must be `author_id`. Set `status='withdrawn'`. Audit.

- [ ] **Step 13.2: Add AuditAction + register + typecheck**

`AuditAction.McpSubmissionSubmit/Approve/Reject/Withdraw`. Register in `server.ts`. `npx tsc --noEmit`.

- [ ] **Step 13.3: Test + commit**

Create `enterprise_server/tests/routes/mcpSubmissions.test.ts`: submit when toggle off → 403; submit when on → 201; approve creates a connector (verify it appears in the admin list + versions row `current:true`); approve with a colliding key → connector key gets `-2`; reject without reason → 400; reject with reason → status `rejected`; withdraw by non-author → 403, by author → `withdrawn`. Run per-file, green. Commit:

```bash
git add enterprise_server/src/routes/mcpSubmissions.ts enterprise_server/src/server.ts enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/tests/routes/mcpSubmissions.test.ts
git commit -m "feat(mcp): member connector submission + admin review routes"
```

### Task 14: SPA review wiring + desktop submit entry

**Files:**
- Modify: `enterprise_server/web/src/api/connectors.ts` (add submissions methods), `ReviewView.tsx` (wire to real `connectorApi`)
- Modify: `src/renderer/components/mcp/McpManager.tsx`, `src/renderer/services/i18n.ts`, `src/main/auth/enterpriseClient.ts` (add `submitConnectorRequest`), `src/main/preload.ts`, `src/main/ipcHandlers/mcp/handlers.ts`, `src/renderer/services/mcp.ts` (wrapper)

- [ ] **Step 14.1: SPA** — add `listSubmissions/approveSubmission/rejectSubmission` to `connectorApi`; wire `ReviewView` to them (replace any inline/mock). Run review component test.

- [ ] **Step 14.2: Desktop submit entry (P1)** — add `submitConnectorRequest(cfg)` to `enterpriseClient` (POST `/admin/mcp-connectors/submissions` with org JWT). In `McpManager` 企业市场 tab: when the org toggle is on (fetch `getSettings`/`/me`-exposed flag) and the user is not an admin, show a 「申请连接器」 affordance → a submit form (subset: key/url/names/version/category/desc/authMode/scope) → `submitConnectorRequest`. i18n zh+en for the entry + 待配置 notes.

- [ ] **Step 14.3: Typecheck both apps + commit**

```bash
cd enterprise_server/web && npx tsc --noEmit
cd .. && cd .. && npx tsc --project electron-tsconfig.json --noEmit
git add enterprise_server/web/src src/renderer src/main
git commit -m "feat(mcp): wire review queue and member submit-request entry"
```

---

## P1 — realism (handshake, tools, versions, draft two-step)

### Task 15: Add `@modelcontextprotocol/sdk` + `handshake.ts`

**Files:**
- Modify: `enterprise_server/package.json` (add `@modelcontextprotocol/sdk` — desktop already uses `^1.27.1`; match)
- Create: `enterprise_server/src/mcp/handshake.ts`

**Interfaces:**
- Produces: `probeConnector(args: { url; transport: 'http'|'sse'; headers: Record<string,string>; timeoutMs }): Promise<{ ok: boolean; status: 'connected'|'failed'; error?: string; serverInfo?: { name?: string; version?: string }; tools?: ToolEntry[]; latencyMs: number }>`.

- [ ] **Step 15.1: Implement `handshake.ts`**

Use `@modelcontextprotocol/sdk`'s client + `StreamableHTTPClientTransport` (for `http`) / `SSEClientTransport` (for `sse`). `connect()` → `client.initialize()` → `client.listTools()` → map `tools` to `ToolEntry[]` (`{name, description, enabled:true}`); on success `client.close()`. Wrap with `AbortSignal.timeout(timeoutMs)`. Map failures: 401/403 → `failed`/`unauthorized`; network/timeout → `failed`/`connect-error`; bad URL → `failed`/`bad_url`. Headers come from decrypted `authConfig` (shared-key → `Authorization: Bearer <apiKey>`; user-oauth/client-creds with a stored token → `Authorization: Bearer <token>`).

- [ ] **Step 15.2: Unit test `handshake.ts`** (mock the SDK client/transport or a local in-process MCP server):
- success → `{ ok:true, status:'connected', tools:[...] }` (assert `tools[].name`).
- 401 → `{ ok:false, status:'failed', error:'unauthorized' }`.
- unreachable URL → `{ ok:false, error:'connect-error' }`.

Run: `npx vitest run tests/mcp/handshake.test.ts`. Green. Commit:

```bash
git add enterprise_server/package.json enterprise_server/src/mcp/handshake.ts enterprise_server/tests/mcp/handshake.test.ts
git commit -m "feat(mcp): real MCP initialize+tools/list handshake for test-connection"
```

### Task 16: Tool sync on test + per-tool toggles + version history/rollback + two-step draft

**Files:**
- Modify: `enterprise_server/src/routes/mcpConnectors.ts` (`POST /:id/test` → use `probeConnector`; on success merge tools: new→`{enabled:true}`, existing kept, server-absent→`removed:true`; persist `tools` + `last_test_*`; `POST /:id/save-draft`; `POST /:id/publish` with version bump + versions row + apply `tools[].enabled` + destructive auth-switch detection; `POST /:id/rollback`; detail returns `versions`).
- Modify: `enterprise_server/web/src/api/connectors.ts` (add `saveDraft`, `publish`, `rollback`, `versions`), drawer components (tools toggles write to form state → publish body).

**Interfaces:**
- `POST /:id/save-draft` body = the full working copy (fields + `scope` + `tools` + `authConfig`); store in `draft` JSONB (no live effect). `POST /:id/publish` body = same; apply to live row, clear `draft`, bump `version` if the field changed (write a `mcp_connector_versions` row, mark `current`), apply `tools[].enabled`. Return `{ version, destructiveAuthSwitch?: boolean }`.
- `POST /:id/rollback` body `{ version }` → find the versions row, apply its `config` snapshot to the live row, mark it `current`, write a rollback versions row (`note:'回滚到 vX'`), `auth_status` recompute.
- Detail `GET /:id` returns `versions: VersionRow[]`.

- [ ] **Step 16.1: Implement the route changes** (extend Task 4's routes). Guard: publish with an auth-mode change on a connector that has any stored secret / `auth_status='configured'` → include `destructiveAuthSwitch:true` in the response (client already confirms before calling; server returns the flag so the client can also surface it). Rollback must not 404 on a missing version (`version_not_found` 404 if absent).

- [ ] **Step 16.2: Wire the SPA** — `ConnectorToolPermissions` (edit-mode) toggles update form state; footer 存草稿 → `saveDraft`, 发布 → `publish` (then invalidate + close, and if `destructiveAuthSwitch` the pre-publish confirm fires); `ConnectorVersionHistory` rollback → `rollback`. `ConnectorBasicInfo` 测试连接 in edit-mode now shows 「发现 N 个工具（清单已与服务端同步）」 on success.

- [ ] **Step 16.3: Tests** (extend `mcpConnectors.test.ts`):
- `POST /:id/test` with a mocked `probeConnector` (vi.mock `../../src/mcp/handshake`) → success merges tools (new tool `enabled:true`, a previously-known tool the server no longer lists → `removed:true`), persists `last_test_status='connected'`.
- `POST /:id/save-draft` → `draft` non-null, live row fields unchanged.
- `POST /:id/publish` after a draft → live fields = draft, `draft` null, a versions row `current:true`; publish with a changed `auth_mode` → response `destructiveAuthSwitch:true`.
- `POST /:id/rollback` to a prior version → live `config` matches that snapshot, rollback row written.
- Run per-file, green.

- [ ] **Step 16.4: Typecheck both apps + commit**

```bash
cd enterprise_server && npx tsc --noEmit && cd web && npx tsc --noEmit
git add enterprise_server/src/routes/mcpConnectors.ts enterprise_server/web/src
git commit -m "feat(mcp): tool sync on handshake, version history/rollback, two-step draft

test-connection now runs a real MCP handshake and syncs the tool list (new→
enabled, removed→grayed); publish applies the working copy and records a
version with rollback; save-draft stages changes without live effect."
```

---

## P1 — end-to-end validation

### Task 17: Manual end-to-end validation (no code changes)

- [ ] **Step 17.1: Admin console** — seed the SPA against a throwaway backend; create a connector (each of the 6 auth modes); verify scope selector (总公司 clears members + disables children), SSE coupling, URL warnings, test-connection (handshake) syncing tools, save-draft → draft banner → publish (version bump + rollback available), delete impact modal.
- [ ] **Step 17.2: Review flow** — enable the global toggle; submit from the desktop (member); approve (creates connector) / reject (forced reason); verify counts.
- [ ] **Step 17.3: Desktop scope visibility** — a member in dept `fe` sees connectors granted to `rd` (subtree) + `allCompany` + member-exception; does not see others; `none`/`user-key`/`user-oauth` connectors install + drive the existing per-user auth (待配置 = needs-auth).
- [ ] **Step 17.4: No-regression** — per-file server + web + desktop test suites green; lint + typecheck clean on all touched files. Existing `mcpMarketplace` desktop flows (built-in market, installed, local stdio, per-user auth) unchanged.
- [ ] **Step 17.5: Commit milestone note** — no code; confirm and (optionally) tag `mcp-connector-mgmt-v1`.

## Self-Review (run by author after writing the plan)

- **Spec coverage:** every PRD §4 feature maps to a task — categories (9), type filter (9), cards (9), create (4,11), 6-auth + transport coupling (4,11), URL test (4 P0 light / 15-16 P1), scope dept+member (4,11), draft/publish (16), tool toggles (16), version/rollback (16), review (13,14), delete impact (11), global setting (4,12). **Dropped per user:** call metrics + call-audit drawer — no task, no table, no card meta (Task 9 meta row = version only; card menu = edit/toggle/delete).
- **Placeholder scan:** none — every step has real code or an explicit reuse reference to a named existing file/function.
- **Type consistency:** `ConnectorView` (backend admin) ↔ `Connector` (SPA) ↔ `ConnectorPublicView` (backend public) ↔ `McpEnterpriseMarketServer` (desktop) field names align (serverKey, version, authMode, authStatus, scopeSummary, toolCount, hasDraft, connectorType).
- **Open items to resolve during execution (not blockers):** (a) **Pinned:** SPA `orgId` = `useMe()`/claims → `claims?.orgId ?? 'default-org'` (matches `UsersPage`/`DepartmentsPage`); pass it into the drawer + `connectorApi`. (b) Draft mechanism: P0 publishes directly via `PATCH`; P1 (Task 16) adds `POST /:id/save-draft` (store working copy in `draft` JSONB) + `POST /:id/publish` (apply draft, bump version, record rollback row) + SPA 存草稿/草稿横幅. (c) `org_id` for the 035 legacy-migration `INSERT` (`'default'` fallback) — verify the seeded org id in the throwaway harness before running; if the deployment seeds a specific org, substitute it.
