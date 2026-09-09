# 大模型管理 (Model & Provider Configuration) — PRD V1.0 Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realign the enterprise `模型配置 / 大模型管理` page (Stack A: `enterprise_server` + `enterprise_server/web`) to the PRD V1.0 + high-fidelity prototype — grouped built-in/custom provider list, protocol-aware test/refresh, multi-type models with a unified config drawer — while adding the missing pieces and stripping the non-prototype surface.

**Architecture:** Two DDL migrations (`031` providers `is_builtin`+`protocol`; `032` models `types TEXT[]`); the 9 built-in providers are seeded by a **TS module** (`src/org/builtinProviders.ts`) invoked at server startup (existing orgs) and at create-org time (new orgs) — *not* a data migration, because the production runner executes one plain-`SQL` statement at a time (no `DO $$` blocks) and the pglite test harness can't run TS hooks either (see Ruling R1). Backend routes/fetcher become protocol-keyed; the frontend rail regroups, the provider form gains a protocol radio, and the model editor collapses into one drawer.

**Tech Stack:** Hono + Postgres (pglite in tests), Zod, React 19 + TanStack Query v5 + Tailwind + lucide. Vitest (per-file, server) + jsdom (web) + Playwright (visual).

**Spec:** `docs/superpowers/specs/2026-09-24-model-provider-management-design.md` (authoritative). Where this plan and the spec conflict, the spec wins; conflicts are ruled in the Global Constraints / per-task notes.

---

## Global Constraints

- **Scope = PRD V1.0 §2.3 only.** Do NOT build (deferred to V1.1): usage/cost dashboards, dept-level model visibility, API-key rotation/multi-key, model versioning/canary, the prototype's cross-provider catalog/overview/quota views.
- **R1 (seed mechanism — deviation from spec §5.3):** The spec's "Migration 033 seed via DO block" is infeasible — `src/db/migrate.ts` `splitStatements` cannot apply `DO $$` bodies, and `src/db/testDb.ts runMigrations` uses `db.exec` (no TS hooks). **Ruling:** the 9 built-ins are seeded by a TS module `src/org/builtinProviders.ts` (`seedBuiltinProviders(orgId)`, idempotent `ON CONFLICT DO NOTHING`), called (a) at server startup for all orgs and (b) at create-org time. Single source of truth, no `033` data migration. Cost if wrong: if a DO-free SQL seed is ever preferred, the same data moves into a plain-`SQL` `INSERT … SELECT … ON CONFLICT DO NOTHING` migration; the data table in Task 3 is the reference.
- **Masked-only key return.** No route ever returns the plaintext API key. `api_key_masked` is written on create/re-set and lazily derived (decrypt→mask) when NULL. The single key is still **settable** via the form (write-only field), because seeded built-ins start keyless.
- **`protocol` affects only test-connection + refresh-models wire format.** It does NOT rewire the runtime inference proxy (`src/routes/proxy.ts`, always OpenAI chat-completions) — that path is out of scope.
- **Model `types` is the source of truth (multi-set, 8 values).** The legacy single `type` column is kept as a *deprecated compat primary* always written as a mapped **old-6-domain** value (so the cross-repo desktop `GET /admin/catalog` contract keeps seeing a legal `type`). `types` uses the 8-value vocabulary: `chat, vision, reasoning, image-gen, embedding, rerank, asr, tts`.
- **Built-in providers are non-deletable** → `DELETE` returns `409 {error:'builtin_provider'}` (fires after the `provider:edit` gate, mirroring the just-shipped `builtin_role` guard) and is audited.
- **Cross-org isolation preserved.** Cross-org target → 404 (never mutated/leaked) — existing `org_id` scoping stays.
- **Run server tests per-file.** The full `enterprise_server` vitest suite hits a sandbox fd/EBADF limit; always run a single test file.
- **i18n:** all new/changed strings go into `web/src/i18n.ts` for **both** `en` and `zh` (the file has an `en` block ~line 300-1100 and a `zh` block; mirror every key).
- **Model type label/color (PRD §4.3.1):** 对话 `chat`=blue, 视觉理解 `vision`=cyan, 思考推理 `reasoning`=purple, all others=gray.
- **Context window is a free `INTEGER`** (tokens); the drawer's context control is a 5-stop picker (32K/64K/200K/1M/2M → `32000/64000/200000/1000000/2000000`), dragging snaps to the nearest stop but the stored value stays the exact integer (off-ladder values like a model's real 128000 are preserved and displayed formatted).
- **Permissions unchanged** — no new `PermissionPoint`s in V1.0. Gates stay `provider:view/edit`, `model:view/create/edit/delete`; `super_admin` bypass preserved.
- **Local-only commits.** Commit after each task; never push.

### Model-type value map (used by Tasks 3, 7, 8, 9, 10)

| 8-value `types` value | display label (zh / en) | legacy `type` compat value | color |
|---|---|---|---|
| `chat` | 对话 / Chat | `chat` | blue |
| `vision` | 视觉理解 / Vision | `vision` | cyan |
| `reasoning` | 思考推理 / Reasoning | `reasoning` | purple |
| `image-gen` | 图像生成 / Image Gen | `image` | gray |
| `embedding` | Embedding / Embedding | `embedding` | gray |
| `rerank` | 重排序 / Rerank | `embedding` | gray |
| `asr` | 语音识别 / ASR | `audio` | gray |
| `tts` | 语音合成 / TTS | `audio` | gray |

---

## File Structure

**Backend (`enterprise_server/src`)**
- Create `db/migrations/031_provider_keys_v2.sql` — `is_builtin`, `protocol`, relax `NOT NULL`s, partial unique index.
- Create `db/migrations/032_model_multi_type.sql` — `types TEXT[]` + backfill.
- Create `org/builtinProviders.ts` — the 9 built-ins data table + `seedBuiltinProviders(orgId)` + `seedBuiltinProvidersForAllOrgs()`.
- Modify `vault/providerKeyVault.ts` — `is_builtin`/`protocol` in views; mask write/derive; `setApiKey`.
- Modify `models/providerModelFetcher.ts` — protocol-keyed dispatch.
- Modify `routes/admin/providerKeys.ts` — protocol on add/patch, built-in 409, protocol-aware test.
- Modify `models/modelCatalog.ts` + `routes/admin/models.ts` — `types[]`.
- Modify `shared/enterpriseServerConstants.ts` — add `ProviderKeyBuiltinDelete`.
- Modify `server.ts` — post-migration backfill call.
- Modify `routes/setupAlias.ts` — new-org seed call.

**Frontend (`enterprise_server/web/src`)**
- Modify `api/providers.ts`, `api/models.ts`, `data/providerCatalog.ts`, `i18n.ts`.
- Modify `pages/providersModels/modelType.tsx` → add multi-type badges + 8-value map.
- Modify `pages/providersModels/ProviderRail.tsx`, `ProviderHeaderBar.tsx`, `ProviderInfoCard.tsx`, `ModelList.tsx`, `ModelTableRow.tsx`, `Pages/ProvidersModelsPage.tsx`.
- Create `pages/providersModels/ModelDrawer.tsx` (unified add/edit).
- Delete `pages/providersModels/ModelParamsDrawer.tsx`, `ModelInlineAddRow.tsx`, `ModelInlineEditRow.tsx`.

---

## Task 1: Migration 031 — provider_keys v2

**Files:**
- Create: `enterprise_server/src/db/migrations/031_provider_keys_v2.sql`
- Test: `enterprise_server/tests/db/migration031.test.ts`

**Interfaces:**
- Produces: columns `provider_keys.is_builtin BOOLEAN NOT NULL DEFAULT false`, `provider_keys.protocol TEXT NOT NULL DEFAULT 'openai' CHECK IN ('openai','anthropic')`; `api_key_encrypted` and `created_by` become **nullable**; partial unique index `provider_keys_org_provider_builtin ON (org_id, provider) WHERE is_builtin`.

**Context:** Base `provider_keys` (`002`) declares `api_key_encrypted TEXT NOT NULL` and `created_by TEXT NOT NULL REFERENCES users(id)`. A keyless, system-seeded built-in satisfies neither, so both must be relaxed to nullable. Legacy `type` CHECK is irrelevant here.

- [ ] **Step 1: Write the failing migration test**

`enterprise_server/tests/db/migration031.test.ts`:

```ts
import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 031 (provider_keys v2)', () => {
  test('adds is_builtin/protocol, relaxes NOT NULLs, partial-unique on builtins', async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    // Keyless, system-seeded builtin: no api_key, no created_by — must insert.
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, is_builtin, protocol, endpoint)
       VALUES ('b1','o1','openai', true, 'openai', 'https://api.openai.com/v1')`,
    );
    const cols = await testPool.query<{ name: string; null: boolean }>(
      `SELECT a.attname AS name, a.attnotnull AS null FROM pg_attribute a
       WHERE a.attrelid = 'provider_keys'::regclass
         AND a.attname IN ('is_builtin','protocol','api_key_encrypted','created_by')`,
    );
    const byName = Object.fromEntries(cols.rows.map((c) => [c.name, c.null]));
    expect(byName.is_builtin).toBe(false); // NOT NULL
    expect(byName.protocol).toBe(false);   // NOT NULL
    expect(byName.api_key_encrypted).toBe(true);  // now nullable
    expect(byName.created_by).toBe(true);         // now nullable
    // A custom provider may repeat a builtin's slug (partial index excludes it).
    await testPool.query(`INSERT INTO provider_keys(id, org_id, provider, is_builtin)
       VALUES ('c1','o1','openai', false)`);
    // Second builtin of the same (org, provider) is rejected.
    await expect(
      testPool.query(
        `INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('b2','o1','openai', true)`,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migration031.test.ts`
Expected: FAIL (columns `is_builtin`/`protocol` don't exist; the keyless insert violates `api_key_encrypted NOT NULL`).

- [ ] **Step 3: Write the migration**

`enterprise_server/src/db/migrations/031_provider_keys_v2.sql`:

```sql
-- provider_keys v2: built-in vs custom flag + explicit API protocol.
-- Plain SQL only (no DO blocks): the production runner executes one
-- `;`-delimited statement at a time (src/db/migrate.ts splitStatements).

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai', 'anthropic'));

-- A keyless, system-seeded built-in has no key and no creating user; both
-- columns must be nullable for the seed to insert (see 032/Task 3).
ALTER TABLE provider_keys ALTER COLUMN api_key_encrypted DROP NOT NULL;
ALTER TABLE provider_keys ALTER COLUMN created_by DROP NOT NULL;

-- Built-ins are unique per (org, provider) so seeding is idempotent and an
-- admin can't add a second builtin of the same slug. Custom providers are
-- excluded from the constraint (they may repeat a slug, e.g. two vllm endpoints).
CREATE UNIQUE INDEX IF NOT EXISTS provider_keys_org_provider_builtin
  ON provider_keys (org_id, provider) WHERE is_builtin;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migration031.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/031_provider_keys_v2.sql enterprise_server/tests/db/migration031.test.ts
git commit -m "feat(models): 031 add is_builtin/protocol to provider_keys"
```

---

## Task 2: Migration 032 — model_catalog multi-type

**Files:**
- Create: `enterprise_server/src/db/migrations/032_model_multi_type.sql`
- Test: `enterprise_server/tests/db/migration032.test.ts`

**Interfaces:**
- Produces: column `model_catalog.types TEXT[] NOT NULL DEFAULT ARRAY['chat']`. Legacy `type` column and its `model_catalog_type_check` constraint are **unchanged** (we never write a new-domain value into it).

**Context:** The 8-value `types` set has no CHECK constraint (arrays don't need one; pure embedding/rerank models may legitimately lack `chat`). Backfill maps legacy single `type` → a 1-element array; `image`→`image-gen`, `audio`→`asr`, rest 1:1. `context_window`/`temperature`/`top_p` already exist (006/016) — do not touch.

- [ ] **Step 1: Write the failing migration test**

`enterprise_server/tests/db/migration032.test.ts`:

```ts
import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 032 (model_catalog multi-type)', () => {
  test('adds types and backfills from the legacy type column', async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('p1','o1','openai', true)`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type)
       VALUES
         ('m1','o1','p1','openai','a','image'),
         ('m2','o1','p1','openai','b','audio'),
         ('m3','o1','p1','openai','c','reasoning'),
         ('m4','o1','p1','openai','d','chat')`,
    );
    const rows = await testPool.query<{ model: string; types: string[] }>(
      `SELECT model, types FROM model_catalog ORDER BY model`,
    );
    const byModel = Object.fromEntries(rows.rows.map((r) => [r.model, r.types]));
    expect(byModel.a).toEqual(['image-gen']);
    expect(byModel.b).toEqual(['asr']);
    expect(byModel.c).toEqual(['reasoning']);
    expect(byModel.d).toEqual(['chat']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migration032.test.ts`
Expected: FAIL (no `types` column).

- [ ] **Step 3: Write the migration**

`enterprise_server/src/db/migrations/032_model_multi_type.sql`:

```sql
-- model_catalog multi-type: a model can carry several capability labels.
-- Legacy single `type` is kept (deprecated compat primary); `types` is the
-- new source of truth. No CHECK on the array (pure embedding/rerank models
-- may omit 'chat').

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS types TEXT[] NOT NULL DEFAULT ARRAY['chat'];

-- One-off backfill: map the legacy single `type` to a 1-element `types` set.
-- image -> image-gen, audio -> asr, otherwise 1:1. Only touch rows still on
-- the default so a re-run can't clobber admin-set values.
UPDATE model_catalog
SET types = CASE type
  WHEN 'image' THEN ARRAY['image-gen']
  WHEN 'audio' THEN ARRAY['asr']
  ELSE ARRAY[type]
END
WHERE type IS NOT NULL AND types = ARRAY['chat'] AND type <> 'chat';
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migration032.test.ts`
Expected: PASS. (Note `m4` with `type='chat'` is skipped by the guard and keeps its default `['chat']`, which is correct.)

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/032_model_multi_type.sql enterprise_server/tests/db/migration032.test.ts
git commit -m "feat(models): 032 add multi-type `types` to model_catalog"
```

---

## Task 3: Built-in provider seed module + startup + create-org hooks

**Files:**
- Create: `enterprise_server/src/org/builtinProviders.ts`
- Modify: `enterprise_server/src/server.ts` (call backfill after `runMigrations()` at line ~132)
- Modify: `enterprise_server/src/routes/setupAlias.ts` (seed on org creation in `POST /start`)
- Test: `enterprise_server/tests/org/builtinProviders.test.ts`

**Interfaces:**
- Produces:
  - `export const BUILTIN_PROVIDERS: BuiltinProviderDef[]` (the 9, below).
  - `export async function seedBuiltinProviders(orgId: string): Promise<void>` — idempotent.
  - `export async function seedBuiltinProvidersForAllOrgs(): Promise<void>` — loops all orgs.
- Consumes: `provider_keys` (nullable key/created_by from Task 1), `model_catalog.types` (Task 2).

**Context:** `seedBuiltinProviders` uses the standard `pool` (so it works in prod against `DATABASE_URL` and, in tests, is mocked to `testPool`). Provider id = `builtin:<orgId>:<slug>`; model id = `builtin:<orgId>:<slug>:<modelId>`. Providers insert with `ON CONFLICT (org_id, provider) WHERE is_builtin DO NOTHING`; models with `ON CONFLICT (org_id, provider, model) DO NOTHING`. Models are inserted **enabled** with `types` from the data table and `type` = mapped legacy value (so the desktop `GET /admin/catalog` keeps a legal `type`). `provider_key_id` references the deterministic builtin provider id.

**The 9 built-ins (single source of truth — mirror the spec §6 table):**

```ts
export interface BuiltinModelDef {
  id: string;
  name: string;
  types: string[]; // 8-value vocabulary
  contextWindow: number; // tokens
}
export interface BuiltinProviderDef {
  slug: string;
  name: string;
  endpoint: string;
  protocol: 'openai' | 'anthropic';
  models: BuiltinModelDef[];
}
```

Data (verbatim):

- `openai` / OpenAI / `https://api.openai.com/v1` / openai / `[{gpt-4o, GPT-4o, [chat,vision],128000},{gpt-4o-mini, GPT-4o mini, [chat],128000},{o3-mini, o3-mini, [chat,reasoning],128000}]`
- `anthropic` / Anthropic / `https://api.anthropic.com` / anthropic / `[{claude-sonnet-4, Claude Sonnet 4, [chat,reasoning],200000},{claude-opus-4, Claude Opus 4, [chat,reasoning],200000}]`
- `deepseek` / DeepSeek / `https://api.deepseek.com` / openai / `[{deepseek-v4-pro, DeepSeek V4 Pro, [chat,reasoning],128000},{deepseek-v4-flash, DeepSeek V4 Flash, [chat],128000},{deepseek-reasoner, DeepSeek Reasoner, [reasoning],128000}]`
- `moonshot` / Moonshot (Kimi) / `https://api.moonshot.cn/v1` / openai / `[{kimi-k3, Kimi K3, [chat,reasoning],200000},{kimi-k2.6, Kimi K2.6, [chat],200000},{kimi-k2.5, Kimi K2.5, [chat],200000}]`
- `qwen` / Qwen (DashScope) / `https://dashscope.aliyuncs.com/api/v1` / openai / `[{qwen3.6-plus, Qwen3.6 Plus, [chat,vision],128000},{qwen3.5-plus, Qwen3.5 Plus, [chat],128000},{qwen-vl-max, Qwen-VL-Max, [chat,vision],128000}]`
- `zhipu` / Zhipu (GLM) / `https://open.bigmodel.cn/api/paas/v4` / openai / `[{glm-5.1, GLM 5.1, [chat,reasoning],128000},{glm-5, GLM 5, [chat],128000}]`
- `minimax` / MiniMax / `https://api.minimax.chat/v1` / openai / `[{MiniMax-M3, MiniMax M3, [chat],128000},{MiniMax-M2.7, MiniMax M2.7, [chat],128000},{MiniMax-M2.5, MiniMax M2.5, [chat],128000}]`
- `xiaomi` / Xiaomi (MiMo) / `https://api.xiaomimimo.com/v1` / openai / `[{mimo-v2.5-pro, MiMo V2.5 Pro, [chat],128000},{mimo-v2.5, MiMo V2.5, [chat],128000}]`
- `volc` / 火山引擎 (豆包) / `https://ark.cn-beijing.volces.com/api/v3` / openai / `[{doubao-seed-2.0-pro, Doubao Seed 2.0 Pro, [chat,vision,reasoning],200000},{doubao-seed-2.0-lite, Doubao Seed 2.0 Lite, [chat],200000}]`

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/org/builtinProviders.test.ts` (mirror the standard `vi.mock` of `../../src/db/pool` → `testPool`, as other service tests do):

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { BUILTIN_PROVIDERS, seedBuiltinProviders, seedBuiltinProvidersForAllOrgs } from '../../src/org/builtinProviders';

describe('builtin provider seed', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A'), ('o2','B')`);
  });

  test('exposes exactly 9 built-in providers', () => {
    expect(BUILTIN_PROVIDERS).toHaveLength(9);
    expect(BUILTIN_PROVIDERS.map((p) => p.slug).sort()).toEqual(
      ['anthropic', 'deepseek', 'minimax', 'moonshot', 'openai', 'qwen', 'volc', 'xiaomi', 'zhipu'].sort(),
    );
  });

  test('seeds 9 builtins + their models for an org, idempotently', async () => {
    await seedBuiltinProviders('o1');
    await seedBuiltinProviders('o1'); // re-seed must be a no-op
    const pk = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_keys WHERE org_id='o1' AND is_builtin`,
    );
    expect(pk.rows[0].n).toBe(9);
    const mc = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM model_catalog WHERE org_id='o1'`,
    );
    const expectedModels = BUILTIN_PROVIDERS.reduce((s, p) => s + p.models.length, 0);
    expect(mc.rows[0].n).toBe(expectedModels);
    // A seeded builtin has no key and no creator.
    const oai = await testPool.query<{ api_key_encrypted: string | null; created_by: string | null }>(
      `SELECT api_key_encrypted, created_by FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    );
    expect(oai.rows[0].api_key_encrypted).toBeNull();
    expect(oai.rows[0].created_by).toBeNull();
    // Seeded models carry a types array and a legal legacy type.
    const m = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE org_id='o1' AND model='gpt-4o'`,
    );
    expect(m.rows[0].types).toEqual(['chat', 'vision']);
    expect(m.rows[0].type).toBe('chat');
  });

  test('backfills all orgs', async () => {
    await seedBuiltinProvidersForAllOrgs();
    for (const o of ['o1', 'o2']) {
      const pk = await testPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM provider_keys WHERE org_id='${o}' AND is_builtin`,
      );
      expect(pk.rows[0].n).toBe(9);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/org/builtinProviders.test.ts`
Expected: FAIL (module `src/org/builtinProviders` does not exist).

- [ ] **Step 3: Implement `builtinProviders.ts`**

Create `enterprise_server/src/org/builtinProviders.ts`:

```ts
import { pool } from '../db/pool';

export interface BuiltinModelDef { id: string; name: string; types: string[]; contextWindow: number; }
export interface BuiltinProviderDef {
  slug: string; name: string; endpoint: string; protocol: 'openai' | 'anthropic';
  models: BuiltinModelDef[];
}

export const BUILTIN_PROVIDERS: BuiltinProviderDef[] = [
  { slug: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', protocol: 'openai',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', types: ['chat', 'vision'], contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', types: ['chat'], contextWindow: 128000 },
      { id: 'o3-mini', name: 'o3-mini', types: ['chat', 'reasoning'], contextWindow: 128000 },
    ] },
  { slug: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com', protocol: 'anthropic',
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', types: ['chat', 'reasoning'], contextWindow: 200000 },
      { id: 'claude-opus-4', name: 'Claude Opus 4', types: ['chat', 'reasoning'], contextWindow: 200000 },
    ] },
  { slug: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com', protocol: 'openai',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', types: ['chat', 'reasoning'], contextWindow: 128000 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', types: ['chat'], contextWindow: 128000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', types: ['reasoning'], contextWindow: 128000 },
    ] },
  { slug: 'moonshot', name: 'Moonshot (Kimi)', endpoint: 'https://api.moonshot.cn/v1', protocol: 'openai',
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', types: ['chat', 'reasoning'], contextWindow: 200000 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', types: ['chat'], contextWindow: 200000 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', types: ['chat'], contextWindow: 200000 },
    ] },
  { slug: 'qwen', name: 'Qwen (DashScope)', endpoint: 'https://dashscope.aliyuncs.com/api/v1', protocol: 'openai',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', types: ['chat', 'vision'], contextWindow: 128000 },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', types: ['chat'], contextWindow: 128000 },
      { id: 'qwen-vl-max', name: 'Qwen-VL-Max', types: ['chat', 'vision'], contextWindow: 128000 },
    ] },
  { slug: 'zhipu', name: 'Zhipu (GLM)', endpoint: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai',
    models: [
      { id: 'glm-5.1', name: 'GLM 5.1', types: ['chat', 'reasoning'], contextWindow: 128000 },
      { id: 'glm-5', name: 'GLM 5', types: ['chat'], contextWindow: 128000 },
    ] },
  { slug: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimax.chat/v1', protocol: 'openai',
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', types: ['chat'], contextWindow: 128000 },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', types: ['chat'], contextWindow: 128000 },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', types: ['chat'], contextWindow: 128000 },
    ] },
  { slug: 'xiaomi', name: 'Xiaomi (MiMo)', endpoint: 'https://api.xiaomimimo.com/v1', protocol: 'openai',
    models: [
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', types: ['chat'], contextWindow: 128000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', types: ['chat'], contextWindow: 128000 },
    ] },
  { slug: 'volc', name: '火山引擎 (豆包)', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai',
    models: [
      { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', types: ['chat', 'vision', 'reasoning'], contextWindow: 200000 },
      { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', types: ['chat'], contextWindow: 200000 },
    ] },
];

// Map an 8-value `types` first element to a legal legacy `type` (old-6 domain)
// so the desktop `GET /admin/catalog` contract keeps a valid single value.
const LEGACY_TYPE: Record<string, string> = {
  'chat': 'chat', 'vision': 'vision', 'reasoning': 'reasoning',
  'image-gen': 'image', 'embedding': 'embedding', 'rerank': 'embedding',
  'asr': 'audio', 'tts': 'audio',
};

export function legacyTypeFor(types: string[]): string {
  return LEGACY_TYPE[types[0]] ?? 'chat';
}

/** Idempotently seed the 9 built-in providers + models for one org. */
export async function seedBuiltinProviders(orgId: string): Promise<void> {
  for (const p of BUILTIN_PROVIDERS) {
    const pkId = `builtin:${orgId}:${p.slug}`;
    await pool.query(
      `INSERT INTO provider_keys(id, org_id, provider, endpoint, is_builtin, protocol)
       VALUES ($1,$2,$3,$4, true, $5)
       ON CONFLICT (org_id, provider) WHERE is_builtin DO NOTHING`,
      [pkId, orgId, p.slug, p.endpoint, p.protocol],
    );
    for (const m of p.models) {
      const mid = `builtin:${orgId}:${p.slug}:${m.id}`;
      await pool.query(
        `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, types, context_window, type, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, true)
         ON CONFLICT (org_id, provider, model) DO NOTHING`,
        [mid, orgId, pkId, p.slug, m.id, m.name, m.types, m.contextWindow, legacyTypeFor(m.types)],
      );
    }
  }
}

/** Seed every existing org (idempotent no-op once present). */
export async function seedBuiltinProvidersForAllOrgs(): Promise<void> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM orgs`);
  for (const org of r.rows) {
    await seedBuiltinProviders(org.id);
  }
}
```

- [ ] **Step 4: Wire the startup backfill**

In `enterprise_server/src/server.ts`, after `await runMigrations();` (line ~132), add:

```ts
import { seedBuiltinProvidersForAllOrgs } from './org/builtinProviders';
// ...
await runMigrations();
await seedBuiltinProvidersForAllOrgs();
```

(Add the import at the top with the other `./` imports, in alphabetical order.)

- [ ] **Step 5: Wire the new-org hook**

In `enterprise_server/src/routes/setupAlias.ts`, add `import { seedBuiltinProviders } from '../org/builtinProviders';` and, right after the `if (!inserted) { ... }` guard in `POST /start` (i.e. after the org is confirmed inserted, before `const inv = await invitationService.rotate(orgId);`):

```ts
  // Seed the 9 built-in providers + models so a fresh org matches an upgraded one.
  await seedBuiltinProviders(orgId);
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/org/builtinProviders.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/org/builtinProviders.ts enterprise_server/src/server.ts enterprise_server/src/routes/setupAlias.ts enterprise_server/tests/org/builtinProviders.test.ts
git commit -m "feat(models): seed 9 built-in providers for new + existing orgs"
```

---

## Task 4: providerKeyVault — is_builtin/protocol, mask write/derive, setApiKey

**Files:**
- Modify: `enterprise_server/src/vault/providerKeyVault.ts`
- Test: `enterprise_server/tests/vault/providerKeyVault.test.ts` (create; mirror existing vault test conventions if present, else stand up `testPool`)

**Interfaces:**
- `ProviderKeyView` gains `is_builtin: boolean` and `protocol: 'openai' | 'anthropic'`.
- `add(input)` gains `isBuiltin?: boolean` and `protocol?: 'openai' | 'anthropic'`; **`plaintextKey` becomes optional** (`plaintextKey?: string`); when provided it encrypts + writes `api_key_masked`.
- New `async setApiKey(id: string, plaintextKey: string): Promise<void>` — re-encrypts the key and writes a fresh mask.
- `list` returns a **populated** `api_key_masked`: stored value, or lazily `decrypt → mask` when NULL.
- `getRow` returns `protocol` too (so Task 5/6 can dispatch on it).
- `maskKey(key: string): string` exported (pure, unit-testable).

**Context:** `maskKey` produces `sk-••••••••a93f` (keep first `sk-`-style prefix chars and last 4, mask the middle). Simplest robust rule: if `key.length <= 8`, return `••••`; else keep first 3 and last 4, mask the middle with `•` repeated `min(len-7, 12)`. This is a display aid, not a secret.

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/vault/providerKeyVault.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { providerKeyVault, maskKey } from '../../src/vault/providerKeyVault';

describe('providerKeyVault', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
  });

  test('maskKey keeps first3 + last4 and masks the middle', () => {
    const m = maskKey('sk-abcdef1234567890xyz99');
    expect(m.startsWith('sk-')).toBe(true);
    expect(m.endsWith('z999')).toBe(true);
    expect(m).toContain('•');
    expect(maskKey('short')).toBe('••••');
  });

  test('add writes a populated api_key_masked', async () => {
    await providerKeyVault.add({ orgId: 'o1', provider: 'custom-x', plaintextKey: 'sk-abcdef1234567890xyz99', endpoint: 'https://e.example/v1', createdBy: undefined as unknown as string });
    const row = await testPool.query<{ api_key_masked: string | null }>(
      `SELECT api_key_masked FROM provider_keys WHERE org_id='o1' AND provider='custom-x'`,
    );
    expect(row.rows[0].api_key_masked).toContain('•');
    expect(row.rows[0].api_key_masked).toBe(maskKey('sk-abcdef1234567890xyz99'));
  });

  test('list lazy-derives a mask when stored mask is NULL (legacy row)', async () => {
    // Insert a legacy row with an encrypted key but NULL mask.
    const { encrypt } = await import('../../src/vault/crypto');
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, api_key_encrypted, is_builtin)
       VALUES ('lg','o1','openai', $1, true)`,
      [encrypt('sk-legacy-secret-000')],
    );
    const list = await providerKeyVault.list('o1');
    const lg = list.find((r) => r.id === 'lg');
    expect(lg?.api_key_masked).toBe(maskKey('sk-legacy-secret-000'));
  });

  test('setApiKey re-encrypts and refreshes the mask', async () => {
    const { id } = await providerKeyVault.add({ orgId: 'o1', provider: 'c1', plaintextKey: 'sk-first', createdBy: undefined as unknown as string });
    await providerKeyVault.setApiKey(id, 'sk-second-new-key');
    const row = await testPool.query<{ api_key_masked: string | null }>(
      `SELECT api_key_masked FROM provider_keys WHERE id=$1`, [id]);
    expect(row.rows[0].api_key_masked).toBe(maskKey('sk-second-new-key'));
  });

  test('getRow exposes protocol', async () => {
    const { id } = await providerKeyVault.add({ orgId: 'o1', provider: 'c2', plaintextKey: 'sk-x', protocol: 'anthropic', createdBy: undefined as unknown as string });
    const row = await providerKeyVault.getRow(id);
    expect(row?.protocol).toBe('anthropic');
  });
});
```

> Note: `createdBy: undefined` is passed because seeded/built-in style inserts have no creator; `add` must accept an undefined `createdBy` (the column is nullable now).

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/vault/providerKeyVault.test.ts`
Expected: FAIL (`maskKey` not exported; `api_key_masked` NULL; `protocol` missing).

- [ ] **Step 3: Implement the vault changes**

In `providerKeyVault.ts`:

1. Add to the imports: `import { decrypt, encrypt } from './crypto';` (already present — keep).
2. Export a pure `maskKey`:

```ts
/** Display mask for a secret: keep first 3 + last 4, mask the middle. Not a
 * secret — purely a UI aid. Never returns the plaintext. */
export function maskKey(key: string): string {
  if (!key || key.length <= 8) return '••••';
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  const mid = '•'.repeat(Math.min(key.length - 7, 12));
  return `${head}${mid}${tail}`;
}
```

3. `ProviderKeyView`: add `is_builtin: boolean;` and `protocol: 'openai' | 'anthropic';`.
4. `add(input)`: change `plaintextKey: string` → `plaintextKey?: string`; add `isBuiltin?: boolean; protocol?: 'openai' | 'anthropic'`. New insert:

```ts
  async add(input: {
    orgId: string;
    provider: string;
    plaintextKey?: string;
    label?: string;
    endpoint?: string;
    region?: ProviderRegion;
    defaultBaseUrl?: string;
    website?: string;
    createdBy?: string;
    isBuiltin?: boolean;
    protocol?: 'openai' | 'anthropic';
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO provider_keys(
         id, org_id, provider, api_key_encrypted, api_key_masked,
         endpoint, label, region, default_base_url, website, created_by,
         is_builtin, protocol
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, input.orgId, input.provider,
        input.plaintextKey ? encrypt(input.plaintextKey) : null,
        input.plaintextKey ? maskKey(input.plaintextKey) : null,
        input.endpoint ?? null, input.label ?? null, input.region ?? null,
        input.defaultBaseUrl ?? null, input.website ?? null, input.createdBy ?? null,
        input.isBuiltin ?? false, input.protocol ?? 'openai',
      ],
    );
    return { id };
  },
```

5. `list`: select `is_builtin, protocol`, and map each row to fill a NULL `api_key_masked` by decrypting:

```ts
  async list(orgId: string): Promise<ProviderKeyView[]> {
    const r = await pool.query<
      Omit<ProviderKeyView, 'last_test_at'> & { last_test_at: Date | null; api_key_encrypted: string | null }
    >(
      `SELECT id, org_id, provider, endpoint, label, enabled,
              region, default_base_url, website,
              description, api_key_masked, api_key_encrypted,
              is_builtin, protocol, status, latency_ms, last_test_at, created_at
       FROM provider_keys WHERE org_id=$1 ORDER BY created_at DESC`,
      [orgId],
    );
    return Promise.all(
      r.rows.map(async (row) => {
        const { api_key_encrypted, ...rest } = row;
        let masked = row.api_key_masked;
        if (!masked && api_key_encrypted) {
          masked = maskKey(decrypt(api_key_encrypted)); // legacy row without a stored mask
        }
        return { ...rest, api_key_masked: masked, last_test_at: row.last_test_at ? row.last_test_at.toISOString() : null };
      }),
    );
  },
```

6. `setApiKey`:

```ts
  async setApiKey(id: string, plaintextKey: string): Promise<void> {
    await pool.query(
      `UPDATE provider_keys SET api_key_encrypted = $1, api_key_masked = $2 WHERE id = $3`,
      [encrypt(plaintextKey), maskKey(plaintextKey), id],
    );
  },
```

7. `getRow`: add `protocol` to the SELECT + returned shape:

```ts
  async getRow(id: string): Promise<{
    id: string; org_id: string; provider: string; endpoint: string | null;
    region: ProviderRegion | null; enabled: boolean; protocol: 'openai' | 'anthropic';
  } | null> {
    const r = await pool.query(
      `SELECT id, org_id, provider, endpoint, region, enabled, protocol FROM provider_keys WHERE id=$1`,
      [id],
    );
    return (r.rows[0] as never) ?? null;
  },
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/vault/providerKeyVault.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/vault/providerKeyVault.ts enterprise_server/tests/vault/providerKeyVault.test.ts
git commit -m "feat(models): providerKeyVault is_builtin/protocol + populated mask + setApiKey"
```

---

## Task 5: Protocol-aware fetcher + test route

**Files:**
- Modify: `enterprise_server/src/models/providerModelFetcher.ts`
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts` (the `POST :id/test` handler only — protocol awareness)
- Test: `enterprise_server/tests/models/providerModelFetcher.test.ts` (extend existing if present, else create)

**Interfaces:**
- `fetchProviderModels(input)` — `input` gains **optional** `protocol?: 'openai' | 'anthropic'`. Dispatch: `if (input.protocol) → route by protocol; else → fall back to the existing provider-slug sets` (legacy rows with no protocol).
- `POST /admin/provider-keys/:id/test` — reads `protocol` from the row and probes the correct endpoint/headers.

**Context:** Keep the slug sets as the fallback for rows where `protocol` is unset (they are seeded `openai` by default now, but old custom rows may predate the column default). The `test` route currently does an unauthenticated `GET {base}/health` then `GET {base}/v1/models`; make the models probe protocol-aware (openai → Bearer; anthropic → x-api-key + anthropic-version) while keeping the unauthenticated `/health` first attempt (it's a connectivity probe; auth failures on the models call are the meaningful "connected" signal).

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/models/providerModelFetcher.test.ts` (add to the file if it exists; otherwise create with a `vi.stubGlobal('fetch', ...)` that records the URL/headers):

```ts
import '../helpers/setupEnv';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchProviderModels } from '../../src/models/providerModelFetcher';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const f = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('fetchProviderModels protocol dispatch', () => {
  test('protocol=anthropic uses x-api-key, not Bearer', async () => {
    const f = stubFetch(() => new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await fetchProviderModels({ provider: 'anthropic', endpoint: 'https://api.anthropic.com', apiKey: 'sk-ant-1', protocol: 'anthropic' });
    expect(res.ok).toBe(true);
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-1');
    expect(headers['authorization']).toBeUndefined();
  });

  test('protocol=openai uses Bearer', async () => {
    const f = stubFetch(() => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await fetchProviderModels({ provider: 'my-vllm', endpoint: 'https://vllm.example/v1', apiKey: 'sk-bearer', protocol: 'openai' });
    expect(res.ok).toBe(true);
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-bearer');
  });

  test('no protocol falls back to slug sets (anthropic slug -> x-api-key)', async () => {
    const f = stubFetch(() => new Response(JSON.stringify({ data: [{ id: 'claude' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchProviderModels({ provider: 'anthropic', endpoint: 'https://api.anthropic.com', apiKey: 'k' });
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/models/providerModelFetcher.test.ts`
Expected: FAIL (`fetchProviderModels` ignores `protocol`; the openai case for `my-vllm` currently falls through to the probe and the anthropic-no-protocol case needs the fallback to be preserved).

- [ ] **Step 3: Make the dispatcher protocol-aware**

In `providerModelFetcher.ts`, change `fetchProviderModels`:

```ts
export async function fetchProviderModels(input: {
  provider: string;
  endpoint: string;
  apiKey: string;
  protocol?: 'openai' | 'anthropic';
}): Promise<FetchResult> {
  if (input.protocol === 'anthropic') return fetchAnthropicModels(input);
  if (input.protocol === 'openai') return fetchOpenAiCompatibleModels(input);
  // Legacy fallback for rows without an explicit protocol (pre-031).
  if (OPENAI_COMPAT_PROVIDERS.has(input.provider)) return fetchOpenAiCompatibleModels(input);
  if (ANTHROPIC_PROVIDERS.has(input.provider)) return fetchAnthropicModels(input);
  if (GEMINI_PROVIDERS.has(input.provider)) return fetchGeminiModels(input);
  return probeModelsEndpoint(input);
}
```

- [ ] **Step 4: Make the test route protocol-aware**

In `providerKeys.ts` `POST :id/test`, select `protocol` alongside `endpoint`:

```ts
  const r = await pool.query<{ endpoint: string | null; protocol: 'openai' | 'anthropic' }>(
    `SELECT endpoint, protocol FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (r.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  const endpoint = r.rows[0].endpoint;
  const protocol = r.rows[0].protocol;
```

Then make the models-probe use the protocol. Replace the two-step unauthenticated probe with: keep `GET {base}/health` first (unauthenticated connectivity check); on failure, do a protocol-aware authenticated `GET {base}/v1/models` (openai → Bearer; anthropic → x-api-key + version) **only if a key is configured**; otherwise fall back to the unauthenticated `/v1/models` (as today). Concretely, replace the `probe` closure's second call with:

```ts
  const base = endpoint.replace(/\/$/, '');
  let probeResult = await probe(`${base}/health`);
  if (!probeResult.ok) {
    // Protocol-aware models probe (authenticates when a key exists).
    try {
      const key = await providerKeyVault.getDecrypted(id).catch(() => null);
      const fetched = await fetchProviderModels({ provider: (await providerKeyVault.getRow(id))!.provider, endpoint: base, apiKey: key ?? '', protocol });
      probeResult = { ok: fetched.ok, ms: probeResult.ms };
    } catch {
      probeResult = await probe(`${base}/v1/models`);
    }
  }
```

(Keep the 5s `setTimeout` inside `probe`; the models probe reuses `fetchProviderModels`' own 10s cap, which is acceptable for a manual "test connection" action.)

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/models/providerModelFetcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/models/providerModelFetcher.ts enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/tests/models/providerModelFetcher.test.ts
git commit -m "feat(models): protocol-aware refresh + test-connection"
```

---

## Task 6: Provider routes — protocol on add/patch, built-in 409, masked echo

**Files:**
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts` (add `ProviderKeyBuiltinDelete: 'provider_key_builtin_delete'`)
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Test: `enterprise_server/tests/routes/providerKeysV2.test.ts` (create)

**Interfaces:**
- `POST /admin/provider-keys` body gains `protocol?: 'openai'|'anthropic'` (default `openai`); `apiKey` becomes `z.string().min(1).optional()` (a custom provider can be created keyless and key added later — matches "未填写时模型不可调用").
- `PATCH /admin/provider-keys/:id` body gains `protocol?: 'openai'|'anthropic'` and optional `apiKey?: string` (write-only; when non-empty, calls `providerKeyVault.setApiKey`).
- `DELETE /admin/provider-keys/:id` — if the row `is_builtin`, return `409 {error:'builtin_provider'}` + audit `provider_key_builtin_delete`; else cascade as today.
- `GET` already returns the new fields via `providerKeyVault.list` (Task 4).

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/routes/providerKeysV2.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { seedBuiltinProviders } from '../../src/org/builtinProviders';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';

const app = new Hono();
app.route('/', adminProviderKeyRoutes);

async function admin(org = 'o1', roles: string[] = ['super_admin']) {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
  return signToken({ sub: 'u1', orgId: org, roles });
}

describe('provider routes v2', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedBuiltinProviders('o1');
  });

  test('DELETE a builtin provider -> 409 builtin_provider + audit', async () => {
    const tok = await admin();
    const builtinId = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${builtinId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'builtin_provider' });
    const audit = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_events WHERE action='provider_key_builtin_delete'`);
    expect(audit.rows[0].n).toBe(1);
  });

  test('PATCH sets protocol and re-sets the key (write-only)', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='anthropic' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic', apiKey: 'sk-ant-new-1234' }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ protocol: string; api_key_masked: string | null }>(
      `SELECT protocol, api_key_masked FROM provider_keys WHERE id=$1`, [id]);
    expect(row.rows[0].protocol).toBe('anthropic');
    expect(row.rows[0].api_key_masked).toContain('•');
  });

  test('GET returns is_builtin + protocol + populated mask', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys?orgId=o1', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ is_builtin: boolean; protocol: string }>;
    const oai = rows.find((r) => r.provider === 'openai');
    expect(oai?.is_builtin).toBe(true);
    expect(oai?.protocol).toBe('openai');
  });

  test('POST a custom provider colliding a builtin slug is allowed (partial index)', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', provider: 'openai', protocol: 'openai', endpoint: 'https://my-vllm/v1' }),
    });
    expect(res.status).toBe(200); // custom 'openai' is distinct from the builtin 'openai'
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts`
Expected: FAIL (no built-in 409; PATCH ignores `protocol`/`apiKey`; GET missing fields).

- [ ] **Step 3: Add the audit action**

In `enterprise_server/src/shared/enterpriseServerConstants.ts`, in the `AuditAction` object (near `ProviderKeyDelete`):

```ts
  ProviderKeyBuiltinDelete: 'provider_key_builtin_delete',
```

- [ ] **Step 4: Update the routes**

In `providerKeys.ts`:

1. `POST` schema: `apiKey: z.string().min(1).optional(),` and add `protocol: z.enum(['openai', 'anthropic']).optional(),`. In the `providerKeyVault.add({...})` call pass `plaintextKey: body.apiKey, protocol: body.protocol, createdBy: body.apiKey ? claims.sub : undefined`. (Keyless custom providers are allowed.)
2. `PATCH` handler: extend the parsed-body type + `fields` mapping:

```ts
  const body = await c.req.json<{
    description?: string | null; baseUrl?: string | null; label?: string | null;
    enabled?: boolean; protocol?: 'openai' | 'anthropic'; apiKey?: string;
  }>().catch(() => ({} as Record<string, unknown>));
  // ...
  if ('protocol' in body) fields.protocol = body.protocol as 'openai' | 'anthropic';
```
   Add `protocol?: 'openai' | 'anthropic'` to the local `fields` object type, and extend `providerKeyVault.patch` to set `protocol` (add a `protocol` branch to `patch`'s dynamic SET builder). After the existing `providerKeyVault.patch(...)` call, handle the key separately:
   ```ts
   if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
     await providerKeyVault.setApiKey(id, body.apiKey);
   }
   ```
   (Include `apiKey` presence in the audit guard so a key change is audited — add `changedKey: !!body.apiKey` to the `payload`.)
3. `DELETE` handler: after the cross-org `exists` check, fetch `is_builtin`:
   ```ts
   const exists = await pool.query<{ id: string; provider: string; is_builtin: boolean }>(
     `SELECT id, provider, is_builtin FROM provider_keys WHERE id = $1 AND org_id = $2`,
     [id, claims.orgId],
   );
   if (exists.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
   if (exists.rows[0].is_builtin) {
     await auditStore.write({
       orgId: claims.orgId, userId: claims.sub,
       action: AuditAction.ProviderKeyBuiltinDelete,
       targetType: 'provider_key', targetId: id,
       payload: { provider: exists.rows[0].provider },
     });
     return c.json({ error: 'builtin_provider' }, 409);
   }
   ```

- [ ] **Step 5: Add `protocol` to `providerKeyVault.patch`**

In `providerKeyVault.ts` `patch`, add to the fields type `protocol?: 'openai' | 'anthropic';` and the dynamic builder:
```ts
    if (fields.protocol !== undefined) { sets.push(`protocol = $${i++}`); params.push(fields.protocol); }
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the existing provider-key route tests (per-file) to confirm no regression**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysExtended.test.ts tests/routes/providerKeysGating.test.ts`
Expected: PASS (these may need their `seedAdmin` updated if `apiKey`/`createdBy` became optional — but the existing calls already pass `apiKey` and `createdBy`, so they should stay green; if a test asserts the exact `ProviderKeyView` shape, update it to include `is_builtin`/`protocol`).

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/src/vault/providerKeyVault.ts enterprise_server/tests/routes/providerKeysV2.test.ts
git commit -m "feat(models): provider protocol + built-in delete guard (409, audited) + key set"
```

---

## Task 7: Model routes + modelCatalog — `types[]`

**Files:**
- Modify: `enterprise_server/src/models/modelCatalog.ts`
- Modify: `enterprise_server/src/routes/admin/models.ts`
- Test: `enterprise_server/tests/routes/modelsTypes.test.ts` (create)

**Interfaces:**
- New const `ModelTypes` (8-value) in `modelCatalog.ts`; `ModelView.types: string[]` added (keep `type: ModelType` deprecated).
- `modelCatalog.add` / `patch` accept `types?: string[]`; write `types` and set legacy `type = legacyTypeFor(types)` (reuse `builtinProviders.legacyTypeFor` or a local copy — **reuse** the exported `legacyTypeFor` from `src/org/builtinProviders.ts`).
- `MODEL_LIST_COLS` adds `c.types`.
- Routes: `POST`/`PATCH` accept `types: string[]` (validated ⊆ 8 values, min 1 when provided) alongside the legacy `type`; `GET` returns `types`.

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/routes/modelsTypes.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminModelRoutes } from '../../src/routes/admin/models';

const app = new Hono();
app.route('/', adminModelRoutes);

describe('model routes: multi-type', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    await testPool.query(`INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('p1','o1','openai', true)`);
  });

  test('POST with types[] stores the set + mapped legacy type', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', providerKeyId: 'p1', provider: 'openai', model: 'm-x',
        types: ['chat', 'vision', 'reasoning'],
        capabilities: { contextWindow: 200000, temperature: 0.7, topP: 0.9 },
      }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE org_id='o1' AND model='m-x'`);
    expect(row.rows[0].types).toEqual(['chat', 'vision', 'reasoning']);
    expect(row.rows[0].type).toBe('chat'); // mapped from types[0]
  });

  test('POST rejects an out-of-set type', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', providerKeyId: 'p1', provider: 'openai', model: 'm-bad', types: ['chat', 'bogus'] }),
    });
    expect(res.status).toBe(400);
  });

  test('GET returns types[]', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', providerKeyId: 'p1', provider: 'openai', model: 'm-g', types: ['asr', 'tts'] }),
    });
    const res = await app.request('/admin/models?orgId=o1', { headers: { authorization: `Bearer ${tok}` } });
    const rows = (await res.json()) as Array<{ model: string; types: string[] }>;
    expect(rows.find((r) => r.model === 'm-g')?.types).toEqual(['asr', 'tts']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/modelsTypes.test.ts`
Expected: FAIL (routes don't accept `types`; `ModelView` lacks `types`).

- [ ] **Step 3: Add `ModelTypes` + `types` to `modelCatalog.ts`**

```ts
/** 8-value multi-type vocabulary (the `types` array). Distinct from the
 * deprecated single `ModelType` (6-value, legacy `type` column). */
export const ModelTypes = {
  Chat: 'chat', Vision: 'vision', Reasoning: 'reasoning', ImageGen: 'image-gen',
  Embedding: 'embedding', Rerank: 'rerank', Asr: 'asr', Tts: 'tts',
} as const;
export type ModelTypeValue = (typeof ModelTypes)[keyof typeof ModelTypes];
export const MODEL_TYPE_VALUES: ModelTypeValue[] = Object.values(ModelTypes);
```

- Import `import { legacyTypeFor } from '../org/builtinProviders';`.
- `ModelView`: add `types: ModelTypeValue[];` (keep `type: ModelType`).
- `MODEL_LIST_COLS`: add `c.types,` (after `c.type,`).
- `add(input)`: add `types?: ModelTypeValue[]`; in the INSERT, add `types` column and `legacy` column:
  ```ts
  const types = input.types ?? [ModelType.Chat];
  const legacy = legacyTypeFor(types);
  // INSERT column list: ... type, types, ...  values: ..., legacy, types, ...
  ```
- `patch(orgId, id, fields)`: add `types?: ModelTypeValue[]`; if present, `sets.push('types = $', 'type = $')` with `types` and `legacyTypeFor(types)`.
- `upsertMany`: leave as-is (new fetched models get the column default `types = ARRAY['chat']`, `type='chat'`).

- [ ] **Step 4: Update the routes**

In `models.ts`:
- Import `MODEL_TYPE_VALUES` (and keep `ModelType` for the legacy field).
- `POST` schema: keep `type` (optional) AND add `types: z.array(z.enum(MODEL_TYPE_VALUES)).min(1).optional(),`. Pass `types: body.types` (and `type: body.type`) to `modelCatalog.add`. If `types` present, drop reliance on `type`.
- `PATCH`: extend `ModelPatchBody` with `types?: string[]`; validate `if (body.types) { if (body.types.length === 0 || body.types.some(t => !MODEL_TYPE_VALUES.includes(t as ModelTypeValue))) return c.json({error:'validation_error', field:'types'},400); }`; pass `types: body.types` to `modelCatalog.patch`.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/modelsTypes.test.ts`
Expected: PASS.

- [ ] **Step 6: Run existing model/catalog route tests (per-file) for regressions**

Run: `cd enterprise_server && npx vitest run tests/org/roleService.test.ts tests/routes/admin.test.ts`
Expected: PASS (if any test asserts the exact `ModelView` shape, add `types`).

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/models/modelCatalog.ts enterprise_server/src/routes/admin/models.ts enterprise_server/tests/routes/modelsTypes.test.ts
git commit -m "feat(models): multi-type `types[]` on model catalog + routes"
```

---

## Task 8: Frontend shared layer — API clients, model types, 9-provider catalog, i18n

**Files:**
- Modify: `enterprise_server/web/src/api/providers.ts`, `enterprise_server/web/src/api/models.ts`, `enterprise_server/web/src/data/providerCatalog.ts`, `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/api/modelTypes.test.ts` (create), extend `web/tests/shared/permissionsMirror.test.ts` if it touches model types

**Interfaces (frontend types — keep in sync with backend):**
- `ProviderKeyView` gains `is_builtin: boolean; protocol: 'openai' | 'anthropic';`.
- `providersApi.add` input gains `protocol?: 'openai'|'anthropic'`, `apiKey` becomes optional; `patch` body gains `protocol?`, `apiKey?`.
- `ModelView` gains `types: ModelTypeValue[]` (keep `type`). New `ModelTypes` const + `ModelTypeValue` type mirroring the backend 8-value set; legacy `ModelType` (6-value) stays.
- `modelsApi.add`/`patch` gain `types?: ModelTypeValue[]`.
- `providerCatalog.ts`: replace the 8-provider `PROVIDER_CATALOG` with the **9 built-ins**' brand metadata (slug, label, color, defaultBaseUrl, protocol) — used for rail icons + custom-add defaults. Drop the `defaultModels` seeds (now DB-sourced). Export `BRAND_COLORS: Record<string,string>` and `BUILTIN_SLUGS: string[]`.
- `modelType.tsx`: add the 8-value label map + `ModelTypesBadges` (multi) + `CONTEXT_STOPS`; keep `modelTypeLabel` working.

**Context:** This task is pure types/data/i18n + the `modelType.tsx` presentational helpers — no page wiring yet (that's Tasks 9–10). It must compile standalone.

- [ ] **Step 1: Write the failing test**

`enterprise_server/web/tests/api/modelTypes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { MODEL_TYPE_VALUES } from '../../src/api/models';
import { BUILTIN_SLUGS, BRAND_COLORS } from '../../src/data/providerCatalog';

describe('model/provider shared types', () => {
  test('MODEL_TYPE_VALUES has exactly the 8 PRD values', () => {
    expect([...MODEL_TYPE_VALUES].sort()).toEqual(
      ['asr', 'chat', 'embedding', 'image-gen', 'reasoning', 'rerank', 'tts', 'vision'].sort(),
    );
  });
  test('BUILTIN_SLUGS are the 9 PRD providers', () => {
    expect(BUILTIN_SLUGS).toHaveLength(9);
    expect(BUILTIN_SLUGS).toContain('volc');
    expect(BUILTIN_SLUGS).toContain('minimax');
    expect(BUILTIN_SLUGS).not.toContain('gemini');
  });
  test('every builtin slug has a brand color', () => {
    for (const s of BUILTIN_SLUGS) expect(BRAND_COLORS[s]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server/web && npx vitest run tests/api/modelTypes.test.ts`
Expected: FAIL (`MODEL_TYPE_VALUES`/`BUILTIN_SLUGS` not exported / catalog still 8).

- [ ] **Step 3: Update `api/models.ts`**

Add (keeping the legacy `ModelType` 6-value block):

```ts
export const ModelTypes = {
  Chat: 'chat', Vision: 'vision', Reasoning: 'reasoning', ImageGen: 'image-gen',
  Embedding: 'embedding', Rerank: 'rerank', Asr: 'asr', Tts: 'tts',
} as const;
export type ModelTypeValue = (typeof ModelTypes)[keyof typeof ModelTypes];
export const MODEL_TYPE_VALUES: ModelTypeValue[] = Object.values(ModelTypes);
```
`ModelView`: add `types: ModelTypeValue[];`. `modelsApi.add` input + `patch` body: add `types?: ModelTypeValue[];`.

- [ ] **Step 4: Update `api/providers.ts`**

`ProviderKeyView`: add `is_builtin: boolean; protocol: 'openai' | 'anthropic';`. `providersApi.add` input: `apiKey?: string;` (was required) + `protocol?: 'openai' | 'anthropic';`. `providersApi.patch` body: add `protocol?: 'openai' | 'anthropic'; apiKey?: string;`.

- [ ] **Step 5: Rewrite `data/providerCatalog.ts`**

Replace with the 9 built-ins' brand metadata:

```ts
/** Brand metadata for the 9 PRD built-in providers (colors + default base URL
 * for placeholders). Model seeds are DB-sourced now (see builtinProviders.ts),
 * so this file only drives rail icons and custom-add defaults. */
export const BUILTIN_SLUGS = [
  'openai','anthropic','deepseek','moonshot','qwen','zhipu','minimax','xiaomi','volc',
] as const;
export type BuiltinSlug = (typeof BUILTIN_SLUGS)[number];
export const BRAND_COLORS: Record<string, string> = {
  openai: '#10A37F', anthropic: '#D97757', deepseek: '#4D6BFE', moonshot: '#1F2329',
  qwen: '#615CED', zhipu: '#3B5BFE', minimax: '#E63946', xiaomi: '#FF6900', volc: '#0D8AFF',
};
export interface ProviderBrand { slug: BuiltinSlug; label: string; defaultBaseUrl: string; protocol: 'openai' | 'anthropic'; }
export const PROVIDER_BRANDS: readonly ProviderBrand[] = [
  { slug: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', protocol: 'openai' },
  { slug: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com', protocol: 'anthropic' },
  { slug: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', protocol: 'openai' },
  { slug: 'moonshot', label: 'Moonshot (Kimi)', defaultBaseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai' },
  { slug: 'qwen', label: 'Qwen (DashScope)', defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', protocol: 'openai' },
  { slug: 'zhipu', label: 'Zhipu (GLM)', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai' },
  { slug: 'minimax', label: 'MiniMax', defaultBaseUrl: 'https://api.minimax.chat/v1', protocol: 'openai' },
  { slug: 'xiaomi', label: 'Xiaomi (MiMo)', defaultBaseUrl: 'https://api.xiaomimimo.com/v1', protocol: 'openai' },
  { slug: 'volc', label: '火山引擎 (豆包)', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai' },
];
export function brandColor(slug: string): string { return BRAND_COLORS[slug] ?? '#6B7280'; }
```

Remove the old `CatalogProviderSeed`/`CatalogModelSeed`/`PROVIDER_CATALOG` (their consumers are rewritten in Tasks 9–10; any remaining import will surface a compile error to fix there).

- [ ] **Step 6: Add the 8-value label map + helpers to `modelType.tsx`**

Add (keep the existing single-value `ModelType` map for the deprecated `type`):

```ts
import { ModelTypes, type ModelTypeValue } from '../../api/models';

export const TYPE_VALUE_LABEL_KEY: Record<ModelTypeValue, string> = {
  [ModelTypes.Chat]: 'providersModels.model.typeChat',
  [ModelTypes.Vision]: 'providersModels.model.typeVision',
  [ModelTypes.Reasoning]: 'providersModels.model.typeReasoning',
  [ModelTypes.ImageGen]: 'providersModels.model.typeImageGen',
  [ModelTypes.Embedding]: 'providersModels.model.typeEmbedding',
  [ModelTypes.Rerank]: 'providersModels.model.typeRerank',
  [ModelTypes.Asr]: 'providersModels.model.typeAsr',
  [ModelTypes.Tts]: 'providersModels.model.typeTts',
};
export function typeValueLabel(v: ModelTypeValue): string { return t(TYPE_VALUE_LABEL_KEY[v] ?? 'providersModels.model.typeChat'); }

// PRD §4.3.1 colors: chat=blue, vision=cyan, reasoning=purple, others=gray.
const TYPE_BG: Record<ModelTypeValue, string> = {
  'chat': 'bg-[var(--accent-light)] text-[var(--accent-primary)]',
  'vision': 'bg-cyan-50 text-cyan-700',
  'reasoning': 'bg-purple-50 text-purple-700',
  'image-gen': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'embedding': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'rerank': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'asr': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'tts': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
};
export function ModelTypesBadges({ types }: { types: ModelTypeValue[] }): JSX.Element {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {types.map((v) => (
        <span key={v} className={`inline-flex rounded-full px-2 py-0.5 text-xs ${TYPE_BG[v]}`}>{typeValueLabel(v)}</span>
      ))}
    </span>
  );
}
// 5-stop context picker (tokens). Off-ladder values sit at the nearest stop.
export const CONTEXT_STOPS = [
  { tokens: 32000, label: '32K' }, { tokens: 64000, label: '64K' }, { tokens: 200000, label: '200K' },
  { tokens: 1000000, label: '1M' }, { tokens: 2000000, label: '2M' },
] as const;
export function contextLabel(tokens: number | null): string {
  if (tokens == null) return '—';
  const fmt = (n: number): string => (n >= 1000000 ? `${n / 1000000}M` : `${Math.round(n / 1000)}K`);
  return fmt(tokens);
}
export function nearestStopIndex(tokens: number | null): number {
  if (tokens == null) return 2;
  let best = 0, bestD = Infinity;
  CONTEXT_STOPS.forEach((s, i) => { const d = Math.abs(s.tokens - tokens); if (d < bestD) { bestD = d; best = i; } });
  return best;
}
```

- [ ] **Step 7: i18n — add the new keys (en + zh)**

In `i18n.ts`, add to **both** the `en` and `zh` blocks (near the existing `providersModels.model.type*` keys). New keys:
- `providersModels.model.typeImageGen` (en "Image Gen" / zh "图像生成")
- `providersModels.model.typeRerank` (en "Rerank" / zh "重排序")
- `providersModels.model.typeAsr` (en "ASR" / zh "语音识别")
- `providersModels.model.typeTts` (en "TTS" / zh "语音合成")
- `providersModels.model.typeVision` zh → change to "视觉理解" (was "视觉"); keep en "Vision" (or "Vision understanding").
- `providersModels.protocol.label` ("API 协议" / "API Protocol"), `providersModels.protocol.openai` ("OpenAI 兼容"/"OpenAI compatible"), `providersModels.protocol.anthropic` ("Anthropic 兼容"/"Anthropic compatible")
- `providersModels.rail.builtin` ("内置服务商"/"Built-in"), `providersModels.rail.custom` ("自定义服务商"/"Custom")
- `providersModels.drawer.*`: `name`, `namePlaceholder`, `nameHint`, `id`, `idPlaceholder`, `idHint`, `types`, `typesHint`, `context`, `contextHint`, `sampling`, `temperature`, `temperatureHint`, `topP`, `topPHint`
- `providersModels.confirm.deleteProvider` already exists (reuse).
- `providersModels.form.apiKeyHint` (en "Leave empty to keep the current key; type a new value to replace." / zh "留空保持不变，输入以替换。")

- [ ] **Step 8: Run the test to confirm it passes; typecheck the web**

Run: `cd enterprise_server/web && npx vitest run tests/api/modelTypes.test.ts && npx tsc --noEmit`
Expected: test PASS. `tsc --noEmit` may surface the broken `PROVIDER_CATALOG`/`CatalogProviderSeed` imports in `ProvidersModelsPage.tsx`/`ProviderRail.tsx`/`ProviderInfoCard.tsx` — **do not fix them here** (they're rewritten in Tasks 9–10); just confirm the errors are confined to those files. If `tsc` isn't runnable standalone, run the existing web unit suite (per-file) to confirm nothing else broke.

- [ ] **Step 9: Commit**

```bash
git add enterprise_server/web/src/api/providers.ts enterprise_server/web/src/api/models.ts enterprise_server/web/src/data/providerCatalog.ts enterprise_server/web/src/pages/providersModels/modelType.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/api/modelTypes.test.ts
git commit -m "feat(models,web): shared types for multi-type + 9 builtins + i18n"
```

---

## Task 9: Frontend rail + header + info card (regroup, protocol radio, strip fields)

**Files:**
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderRail.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx`
- Test: `enterprise_server/web/tests/pages/ProvidersRail.test.tsx` (create)

**Interfaces (props the page will pass after Task 10 rewires the page):**
- `ProviderRail` now takes a single `providers: ProviderKeyView[]` (grouped internally by `is_builtin`), `modelCounts`, `selectedId`, `onSelect`, `canManage`, `onAddProvider`, and `onDeleteProvider` (custom rows only). It no longer takes `configured`/`catalog`.
- `ProviderHeaderBar`: shows 48px brand icon + name + 内置/自定义 tag + Base URL; right side **测试连接 (ghost) + 保存 (primary)** — no cancel, no delete (delete is on the rail row now). `onTest`/`onSave` props as today.
- `ProviderInfoCard`: fields = 名称, **API 协议 radio**, Base URL, API Key (write-only, masked hint). **Removes** description/region/website. Gains `protocol` in the save body.

**Context:** The rail's old "已配置/目录" split is replaced by 内置/自定义 from one data source. Delete-confirm (custom only) lives on the rail row (prototype shows the delete icon on custom rows); the header no longer deletes.

- [ ] **Step 1: Write the failing test**

`enterprise_server/web/tests/pages/ProvidersRail.test.tsx` (jsdom; render `ProviderRail` with a mixed provider list; assert grouping, counts, custom-only delete, enable switch):

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { ProviderRail } from '../../src/pages/providersModels/ProviderRail';

const mk = (over: Partial<import('../../src/api/providers').ProviderKeyView> = {}) => ({
  id: 'id', provider: 'openai', endpoint: 'https://api.openai.com/v1', label: 'OpenAI',
  enabled: true, region: null as const, default_base_url: null, website: null, description: null,
  api_key_masked: 'sk-••••••••a93f', status: 'unknown' as const, latency_ms: null, last_test_at: null,
  created_at: '', is_builtin: true, protocol: 'openai' as const, ...over,
});

describe('ProviderRail', () => {
  test('groups builtins and customs with counts; delete only on customs', async () => {
    const user = userEvent.setup();
    render(
      <ProviderRail
        providers={[mk({ id: 'b', provider: 'openai' }), mk({ id: 'c', provider: 'vllm', is_builtin: false, label: 'vllm-test' })]}
        modelCounts={{ openai: 3, vllm: 1 }}
        selectedId="b"
        onSelect={jest.fn()}
        canManage
        onAddProvider={jest.fn()}
        onDeleteProvider={jest.fn()}
      />,
    );
    expect(screen.getByText(/内置服务商 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/自定义服务商 \(1\)/)).toBeInTheDocument();
    // Delete icon present for the custom row only.
    expect(screen.getAllByLabelText('delete-provider').length).toBe(1);
    await user.click(screen.getByLabelText('delete-provider'));
  });
});
```

> Use the web test setup's `jest.fn`/`vi.fn` per the existing `tests/setup.ts` (mirror an existing `*.test.tsx` in `web/tests/pages/`).

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersRail.test.tsx`
Expected: FAIL (ProviderRail still takes `configured`/`catalog`, no builtin/custom grouping).

- [ ] **Step 3: Rewrite `ProviderRail.tsx`**

Take `providers: ProviderKeyView[]`; split into `builtins = providers.filter(p => p.is_builtin)` and `customs = providers.filter(p => !p.is_builtin)`; filter each by the search box. Render two sections (builtins / customs) with counts. Each row: brand icon (colored square, `brandColor(p.provider)`, first letter of label), name (`p.label ?? p.provider`), model-count badge (`modelCounts[p.provider] ?? 0`), enable switch (calls a new `onToggleProvider(p.id, enabled)` prop), and — for customs only — a delete icon button (`aria-label="delete-provider"`, `onClick` → `onDeleteProvider(p)`). Row click → `onSelect(p.id)`. Keep the "+ 添加服务商" dashed button under the custom section.

Add `onToggleProvider: (id: string, enabled: boolean) => void` to `Props`.

- [ ] **Step 4: Rewrite `ProviderHeaderBar.tsx`**

48px brand icon (`brandColor`, first letter) + name + 内置/自定义 tag (from `provider.is_builtin`) + Base URL (mono, grey, "尚未配置 Base URL" when empty). Right side: 测试连接 (ghost, `onTest`) + 保存 (primary, `onSave`). Remove the delete button + delete-confirm logic (moved to the rail). Keep the `busy` guard.

- [ ] **Step 5: Rewrite `ProviderInfoCard.tsx`**

State: `label`, `baseUrl`, `apiKey`, `protocol`. Drop `description`. Add a protocol radio (OpenAI 兼容 / Anthropic 兼容) bound to `protocol` (default `provider.protocol`). Base URL placeholder switches on protocol. API Key: password input, write-only; in edit mode show the masked hint + `providersModels.form.apiKeyHint` (send `apiKey` to the page only when the user typed a new value). `onSave(provider.id, { label, baseUrl, apiKey, protocol })` — update the `SaveBody` type to include `protocol` and drop `description`.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersRail.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ProviderRail.tsx enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx enterprise_server/web/tests/pages/ProvidersRail.test.tsx
git commit -m "feat(models,web): regroup provider rail + protocol radio + built-in tag"
```

---

## Task 10: Frontend unified model drawer + table + page rewire

**Files:**
- Create: `enterprise_server/web/src/pages/providersModels/ModelDrawer.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/ModelList.tsx`, `ModelTableRow.tsx`, `ProvidersModelsPage.tsx`
- Delete: `enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.tsx`, `ModelInlineAddRow.tsx`, `ModelInlineEditRow.tsx`
- Test: `enterprise_server/web/tests/pages/ModelDrawer.test.tsx` (create)

**Interfaces:**
- `ModelDrawer` props: `open: boolean; model: ModelView | null; providerId: string; provider: string; busy: boolean; onSave: (payload: ModelSavePayload) => void; onClose: () => void;` where
  `ModelSavePayload = { id?: string; name: string; model: string; types: ModelTypeValue[]; contextWindow: number; temperature: number; topP: number }`.
- `ModelList` now: columns 名称 / 类型 (multi-badge) / 上下文 (formatted) / 启用 (switch) / 操作 (edit → opens drawer). Header: 获取模型 + + 添加模型. Delete button kept on the row.
- `ProvidersModelsPage` rewires: rail (builtins/customs), header (test/save), info card (protocol), single `ModelDrawer` for add+edit, remove `ModelParamsDrawer` + inline add/edit + `saveParamsMut`/`paramsModelId`.

**Context:** This is the largest task. The drawer is the single editor for add + edit. `onSave` in the page maps the payload to `modelsApi.add` (new) or `modelsApi.patch` (edit, sends `types` + `capabilities{contextWindow, temperature, topP}` + `displayName`).

- [ ] **Step 1: Write the failing test**

`enterprise_server/web/tests/pages/ModelDrawer.test.tsx` (jsdom; assert the 8 type cards, 5-stop context, temp/topP sliders render; a checkbox toggle + save calls `onSave` with the chosen `types`):

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ModelDrawer } from '../../src/pages/providersModels/ModelDrawer';

describe('ModelDrawer', () => {
  test('renders 8 type cards and calls onSave with selected types', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ModelDrawer open providerId="p1" provider="openai" busy={false}
        model={{ id: 'm', provider: 'openai', model: 'gpt-4', display_name: 'GPT-4',
          types: ['chat'], type: 'chat', quota_per_user_per_day: null, enabled: true,
          disabled_by_admin: false, supports_image: false, supports_video: false, supports_thinking: false,
          context_window: 128000, max_tokens: null, temperature: 0.7, top_p: 0.9, max_output_tokens: null }}
        onSave={onSave} onClose={vi.fn()} />,
    );
    expect(screen.getByText('对话')).toBeInTheDocument();
    expect(screen.getByText('语音合成')).toBeInTheDocument(); // TTS card present
    await user.click(screen.getByText('思考推理')); // toggle reasoning on
    await user.click(screen.getByRole('button', { name: /保存/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].types).toContain('reasoning');
    expect(onSave.mock.calls[0][0].types).toContain('chat');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ModelDrawer.test.tsx`
Expected: FAIL (`ModelDrawer` doesn't exist).

- [ ] **Step 3: Create `ModelDrawer.tsx`**

A right-side drawer (reuse the drawer pattern/styles of the deleted `ModelParamsDrawer` — mask + `fixed right-0` panel). Local state initialized from `model` (edit) or defaults (add: `types=['chat']`, `contextWindow=200000`, `temperature=0.7`, `topP=0.9`). Sections:
1. 基本信息: 模型名称* (text, placeholder "GPT-4", hint), 模型ID* (mono text, placeholder "gpt-4", hint).
2. 模型类型: two-column grid of 8 checkbox cards from `MODEL_TYPE_VALUES` using `typeValueLabel` + a one-line description each (add a `TYPE_VALUE_DESC` map in the component or i18n); checked = blue border (`border-[var(--accent-primary)] bg-[var(--accent-light)]`).
3. 上下文窗口: current value shown above (via `contextLabel`); a 5-stop picker — render `CONTEXT_STOPS` as a segmented control / range `min=0 max=4` bound to `nearestStopIndex(contextWindow)`; selecting a stop sets `contextWindow = CONTEXT_STOPS[i].tokens`. Off-ladder values display their real `contextLabel` and sit at the nearest stop.
4. 采样参数 (divider): 温度 range `min=0 max=2 step=0.1` (value badge) + hint; Top P range `min=0 max=1 step=0.05` (value badge) + hint.
Footer: 取消 (`onClose`) + 保存 → `onSave({ id: model?.id, name: name, model: modelId, types, contextWindow, temperature, topP })`. Validate name + modelId non-empty before save.

- [ ] **Step 4: Rewrite `ModelList.tsx` + `ModelTableRow.tsx`**

`ModelList`: header row with "获取模型" (ghost, `onRefresh`) + "+ 添加模型" (primary, `onAdd`). Table columns: 名称 (display name + mono model id) / 类型 (`ModelTypesBadges` of `m.types`) / 上下文 (`contextLabel(m.context_window)`) / 启用 (switch, `onToggleEnabled`) / 操作 (edit button → `onEdit(m)`; delete icon → `onDelete(m.id)`). Empty state: "暂无模型，点击右上角「添加模型」开始配置". Replace the inline add/edit rows with a single `onEdit` callback (the drawer handles both).

`ModelTableRow`: drop the inline add/edit form behavior; render the display row (name/id, badges, context, switch, edit + delete icons).

- [ ] **Step 5: Rewire `ProvidersModelsPage.tsx`**

- Remove `import { ModelParamsDrawer }`, `ModelInlineAddRow`, `ModelInlineEditRow` (already gone from the component set), `paramsModelId` state, `saveParamsMut`, and the inline `addModelMut`/`saveModelMut` that used the old single-type `type`.
- `ModelList` now calls `onEdit` (opens the drawer) and `onAdd` (opens empty drawer). Track `drawerModel: ModelView | null` + `drawerOpen: boolean`.
- Replace the model mutations with one `saveModelDrawer` mutation:
  ```ts
  const saveModelDrawer = useMutation({
    mutationFn: (p: ModelSavePayload) => p.id
      ? modelsApi.patch(p.id, {
          displayName: p.name, types: p.types,
          capabilities: { contextWindow: p.contextWindow, temperature: p.temperature, topP: p.topP },
        }, orgId)
      : modelsApi.add({ orgId, providerKeyId: providerId, provider, model: p.model, displayName: p.name, types: p.types,
          capabilities: { contextWindow: p.contextWindow, temperature: p.temperature, topP: p.topP } }),
    onSuccess: () => { invalidate(); setDrawerOpen(false); toast.success(t('providersModels.toast.saved')); },
    onError: (e: Error) => toast.error(e.message),
  });
  ```
- Rail: pass `providers` (not `configured`/`catalog`), `onToggleProvider` (uses `providersApi.setEnabled` → `setEnabled` mutation), `onDeleteProvider` (confirm + `deleteProviderMut`), remove the catalog logic.
- Info card save body: send `protocol` + `apiKey` (only when non-empty) + `label` + `baseUrl`. The `addProviderMut`/`saveProviderMut` should pass `protocol` and conditional `apiKey` (keyless custom allowed).
- Render the single `<ModelDrawer ... open={drawerOpen} model={drawerModel} providerId={view.id} provider={view.provider} busy={saveModelDrawer.isPending} onSave={(p)=>saveModelDrawer.mutate(p)} onClose={()=>setDrawerOpen(false)} />` at the end.
- Update `handleSaveProvider` to include `protocol` and `apiKey` from the info-card body; remove the description-only follow-up patch.
- `modelCounts`/`providerModels` logic unchanged (still keyed by `provider` slug) — but note builtins are matched by slug, and the `model` count per provider works since `modelsApi.list` returns provider slug.

- [ ] **Step 6: Delete the old editor components**

```bash
git rm enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.tsx \
       enterprise_server/web/src/pages/providersModels/ModelInlineAddRow.tsx \
       enterprise_server/web/src/pages/providersModels/ModelInlineEditRow.tsx
```

- [ ] **Step 7: Typecheck + run affected web tests (per-file)**

Run: `cd enterprise_server/web && npx tsc --noEmit && npx vitest run tests/pages/ModelDrawer.test.tsx tests/pages/ProvidersRail.test.tsx`
Expected: `tsc` clean (the `PROVIDER_CATALOG`/`CatalogProviderSeed` errors from Task 8 are now resolved by the page rewire); both tests PASS.

- [ ] **Step 8: Run the full web unit suite (per-file)**

Run: `cd enterprise_server/web && npx vitest run`
Expected: PASS (existing `ProvidersModelsPage`-related tests updated to the new props if any; if `web/tests/pages/` had a `ProvidersModelsPage.test.tsx`, update it to the rail/header/drawer contract).

- [ ] **Step 9: Commit**

```bash
git add -A enterprise_server/web/src/pages/providersModels/ enterprise_server/web/src/pages/ProvidersModelsPage.tsx enterprise_server/web/tests/pages/
git commit -m "feat(models,web): unified model drawer + regrouped provider table"
```

---

## Task 11: Hardening — visual baselines + acceptance walkthrough + full green

**Files:**
- Create: `enterprise_server/web/tests/visual/providers.spec.ts` (Playwright; 2–3 baselines)
- Create: `enterprise_server/docs/acceptance-model-provider.md` (durable §-style walkthrough)
- No source changes unless a bug surfaces.

**Context:** Mirrors the just-merged org-permission acceptance approach: run against an **isolated throwaway Postgres DB** (not the dev DB), seed via `seedBuiltinProviders`, sign real JWTs, exercise the 越权/CRUD surface. Visual baselines captured against a real seeded backend on a spare port.

- [ ] **Step 1: Write the acceptance script**

Create `enterprise_server/_acceptance-model-provider.mjs` (or a `.ts` run via `npx tsx`): spin an isolated `pglite`/`DATABASE_URL` throwaway, apply migrations, seed builtins, then assert:
1. 9 built-ins present, grouped; each non-deletable → `DELETE` → `409 builtin_provider` + audit row.
2. Custom add (keyless ok) → `200`; PATCH sets `protocol` + key → mask populated; GET shows masked, never plaintext.
3. Inline enable/disable a builtin → `200`, `enabled` flips.
4. Protocol-aware refresh: an `anthropic`-protocol row hits `/v1/models` with `x-api-key` (assert via a stub or the audit `provider_call` outcome).
5. Model drawer save: `POST /admin/models` with `types=['chat','vision','reasoning']` → stored; `GET` returns `types`; out-of-set type → `400`.
6. Cross-org target → `404`.
Log each check ✅/❌ with the HTTP status.

- [ ] **Step 2: Run the acceptance script against the throwaway DB**

Run: `cd enterprise_server && DATABASE_URL='postgres://...throwaway' npx tsx _acceptance-model-provider.mjs`
Expected: all checks pass. (Use a throwaway DB; never the dev `gwork` DB.)

- [ ] **Step 3: Write the durable acceptance doc**

Create `enterprise_server/docs/acceptance-model-provider.md` summarizing the run (env, the 9 built-ins, the 409/mask/protocol/cross-org results) in the same style as `docs/acceptance-org-permission.md`.

- [ ] **Step 4: Add the Playwright visual spec + baselines**

Create `enterprise_server/web/tests/visual/providers.spec.ts` mirroring `users.spec.ts` (seed a signed token via `addInitScript`, real org id). Screenshots: `providers-list.png` (9 builtins + custom grouped), `provider-detail.png` (header + 连接信息 with protocol radio), `model-drawer.png` (8 type cards + context + sampling). Capture with:
```bash
cd enterprise_server/web && WEB_PORT=<spare> WEB_PROXY_TARGET=<backend> WEB_ORG_ID=<org> \
  npx playwright test tests/visual/providers.spec.ts --update-snapshots
```

- [ ] **Step 5: Full verification (per-file server + full web)**

Run, per-file for server (never the full suite at once):
```bash
cd enterprise_server
for f in tests/db/migration031.test.ts tests/db/migration032.test.ts tests/org/builtinProviders.test.ts \
         tests/vault/providerKeyVault.test.ts tests/models/providerModelFetcher.test.ts \
         tests/routes/providerKeysV2.test.ts tests/routes/modelsTypes.test.ts \
         tests/routes/providerKeysExtended.test.ts tests/routes/providerKeysGating.test.ts; do
  npx vitest run "$f" || echo "FAIL: $f"
done
```
Then the full web suite:
```bash
cd enterprise_server/web && npx vitest run
```
Expected: every server file PASS, web suite PASS.

- [ ] **Step 6: Remove the throwaway acceptance artifacts + commit**

```bash
rm -f enterprise_server/_acceptance-model-provider.mjs
git add enterprise_server/web/tests/visual/providers.spec.ts enterprise_server/docs/acceptance-model-provider.md
git commit -m "test(models): visual baselines + acceptance walkthrough for model/provider mgmt"
```

---

## Self-Review

**Spec coverage:**
- PRD §4.1 provider list (groups/counts/enable/delete/search/add) → Tasks 3 (seed), 9 (rail).
- §4.2 detail (header test/save no-cancel, protocol radio, masked key) → Tasks 4 (mask), 5 (test), 9 (header/info card).
- §4.3 model list (multi-type tags/colors, enable, 获取模型, + 添加模型) + drawer (8 cards, 5-stop context, temp/topP) → Tasks 2, 7 (types), 10 (drawer/table).
- §5 nine built-ins → Task 3.
- §6 security (encrypted key, masked echo, no plaintext, audit) → Tasks 4, 6.
- §6 perf (5s test timeout) → Task 5 (existing 5s/10s caps preserved).
- §7 acceptance items → Task 11.
- §2.3 non-goals (usage/dept-visibility/rotation/versioning) → explicitly excluded (Global Constraints); the prototype's overview/quota/catalog views are NOT built.

**Placeholder scan:** none — every step has concrete code or a precise per-file delta.

**Type consistency:** `types` = 8-value `ModelTypes`/`MODEL_TYPE_VALUES` (backend `modelCatalog.ts` ↔ frontend `api/models.ts`); legacy `type` = 6-value `ModelType` (unchanged, written via `legacyTypeFor`). `Protocol = 'openai'|'anthropic'` consistent across `providerKeyVault`, routes, `providerKeys.ts`, `api/providers.ts`. `ProviderKeyView.is_builtin/protocol` added once (backend) and mirrored (frontend) in the same Task 4/8. `ModelView.types: ModelTypeValue[]` added in backend Task 7 and frontend Task 8. The `SaveBody`/`ModelSavePayload` shapes are defined at their introduction.

**Rulings (per Global Constraints):** R1 seed-via-TS (replaces spec §5.3's infeasible DO-block migration); model `type` written as a mapped old-6 value to protect the cross-repo desktop contract (spec §4.6/§5.2 said "keep as compat primary" — this pins the exact mapping); context window is a free integer with a 5-stop picker (spec §5.2); key is settable-but-never-returned (spec §4 decision #2). All defensible against the spec's intent; none contradict it.
