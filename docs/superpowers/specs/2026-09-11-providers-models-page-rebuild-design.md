# Providers & Models Page — Prototype-Driven Rebuild

## Context

The current `enterprise_server` "服务商与模型" page at `/config/providers`
(`enterprise_server/web/src/pages/ProvidersModelsPage.tsx`, ~856 lines) was built
incrementally over time. A new interactive prototype at
`/Users/paulwang/WorkBuddy/2026-09-08-21-59-26/llm-config/models.html` (plus
`models.js` and `styles.css`) defines a cleaner three-column layout, an inline
model-table editor, a slide-in model-params drawer, and a connection-test status
panel. The user wants the page rebuilt to match the prototype's UX and visual
language.

This spec captures the rebuild scope, the data-shape and API changes required to
support the prototype, and the verification steps. It deliberately excludes
several prototype features the user asked to drop (see "Out of scope" below).

## Scope

### In scope

- **Three-column layout** — icon sidebar (existing global) + provider rail +
  provider detail.
- **Provider rail** — search box, "内置服务商 / 自定义服务商" sections (rename
  current "configured / catalog"), per-row status dot + name + enabled-count
  badge, click-to-select.
- **Provider detail header** — breadcrumb, h1 = provider name, status pill, three
  action buttons (测试连接 / 保存 / 删除服务商), large enable/disable switch.
- **Provider info card** — name / 备注 / baseUrl / apiKey (with show-hide eye
  icon, masked display) / connection status line (dot + latency + lastTest).
- **Test connection** — real backend hit to upstream `GET <endpoint>/health` (or
  `/v1/models`); returns `connected` / `failed` plus latency.
- **Provider CRUD** — add (existing FormDrawer), edit (name/desc/baseUrl/label/
  enabled), delete (cascades to models), enable/disable.
- **Model CRUD** — inline add row, inline edit row (yellow background), per-row
  delete (confirm dialog), per-row enable/disable.
- **Model params drawer** — slide-in from right, 460px; sections for **kept
  fields only** (see below).
- **Refresh models** — existing `POST .../refresh-models` button; result shown as
  inline flash (3s) instead of toast.
- **Auth gating** — read access for any logged-in org user; write actions
  require `super_admin` OR `admin` role.
- **i18n** — full zh + en coverage for all new strings; remove unused keys
  (StatsRow, Tabs).

### Out of scope (per user, 2026-09-11)

The following prototype fields are **not** built into this page — no schema
column, no API field, no UI control, no i18n string:

1. 停止符 (stop sequences)
2. 流式输出 (stream toggle)
3. 函数调用 (function calling toggle)
4. 思维链预算 (thinking budget)
5. 响应格式 (response format — text / JSON Object / JSON Schema)
6. 限速 (RPM / TPM)
7. 定价 (input / output price)

### Out of scope (general)

- Tabs (Models / API keys / Usage / Activity) — current page has empty tab stubs;
  prototype has no tabs. **Removed** as part of the cleanup.
- StatsRow with real data — would need usage endpoints we don't have.
- "Catalog provider" addition flow stays as-is (catalog seed data unchanged).

## Architecture

The change spans the enterprise_server SPA, the API client, the API routes, the
DB migrations, and shared types.

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React SPA)                                          │
│  ProvidersModelsPage.tsx  (rewrite ~856 → ~600 lines)        │
│   ├── ProviderRail.tsx           (new)                        │
│   ├── ProviderDetail.tsx         (new)                        │
│   │    ├── ProviderHeaderBar.tsx (new)                       │
│   │    ├── ProviderInfoCard.tsx  (new)                       │
│   │    ├── ModelList.tsx         (new)                       │
│   │    │    ├── ModelTableRow.tsx     (new)                 │
│   │    │    ├── ModelInlineEditRow.tsx (new)                 │
│   │    │    └── ModelInlineAddRow.tsx  (new)                 │
│   │    └── ModelParamsDrawer.tsx (new)                       │
│   ├── StatusDot.tsx (new shared component)                   │
│   └── reuse: ConfirmDialog, FormDrawer, useToast, useAuth   │
├─────────────────────────────────────────────────────────────┤
│ API client (TS)                                               │
│  providers.ts + models.ts  (extend with new methods)          │
├─────────────────────────────────────────────────────────────┤
│ Server routes (Hono)                                          │
│  GET    /admin/provider-keys           (extend response)     │
│  POST   /admin/provider-keys           (extend body)         │
│  PATCH  /admin/provider-keys/:id       (NEW)                 │
│  DELETE /admin/provider-keys/:id       (NEW)                 │
│  POST   /admin/provider-keys/:id/test  (NEW)                 │
│  GET    /admin/models                  (extend response)     │
│  POST   /admin/models                  (extend body)         │
│  PATCH  /admin/models/:id              (NEW)                 │
│  DELETE /admin/models/:id              (NEW)                 │
├─────────────────────────────────────────────────────────────┤
│ DB migrations                                                  │
│  015_provider_keys_extended.sql  (NEW)                       │
│  016_models_params.sql           (NEW)                       │
└─────────────────────────────────────────────────────────────┘
```

## Data shapes

### DB migrations

```sql
-- 015_provider_keys_extended.sql
ALTER TABLE provider_keys
  ADD COLUMN desc TEXT,
  ADD COLUMN api_key_masked TEXT,             -- e.g. "sk-••••••••abc123"
  ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'connected', 'failed')),
  ADD COLUMN latency_ms INTEGER,
  ADD COLUMN last_test_at TIMESTAMPTZ;

-- 016_models_params.sql
ALTER TABLE models
  ADD COLUMN temperature REAL,                -- 0..2
  ADD COLUMN top_p REAL,                       -- 0..1
  ADD COLUMN max_output_tokens INTEGER;       -- 1..200000
  -- supports_image / supports_video / supports_thinking already exist
  -- from migration 005 (catalog metadata). No new capability columns.
```

`api_key_masked` is a server-rendered preview (last 6 chars + bullet prefix).
The actual `api_key` is write-only via `POST` / `PATCH`; once stored, the server
never returns plaintext.

### Shared types

```ts
// src/shared/providerKeys/constants.ts (NEW)
export const ProviderKeyStatus = {
  Unknown: 'unknown',
  Connected: 'connected',
  Failed: 'failed',
} as const;
export type ProviderKeyStatus =
  (typeof ProviderKeyStatus)[keyof typeof ProviderKeyStatus];

// src/shared/models/types.ts (NEW) — single source of truth for client + server
export interface ModelParamsKept {
  temperature: number | null;        // 0..2
  topP: number | null;               // 0..1
  maxOutputTokens: number | null;    // 1..200000
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsThinking: boolean;
}
```

## API contracts

| Endpoint                       | Method | Auth          | Notes                                        |
|--------------------------------|--------|---------------|----------------------------------------------|
| /admin/provider-keys           | GET    | All org users | Response extended (see below)                |
| /admin/provider-keys           | POST   | Admin only    | Body extended with `desc`                    |
| /admin/provider-keys/:id       | PATCH  | Admin only    | NEW — `{ name?, desc?, baseUrl?, label?, enabled? }` |
| /admin/provider-keys/:id       | DELETE | Admin only    | NEW — cascade delete models                  |
| /admin/provider-keys/:id/enable| POST   | Admin only    | Existing                                      |
| /admin/provider-keys/:id/disable| POST  | Admin only    | Existing                                      |
| /admin/provider-keys/:id/test  | POST   | All org users | NEW — `{ status, latency_ms, last_test_at }` |
| /admin/provider-keys/:id/refresh-models | POST | Admin only | Existing                                 |
| /admin/models                  | GET    | All org users | Response extended with params fields         |
| /admin/models                  | POST   | Admin only    | Body extended with params fields             |
| /admin/models/:id              | PATCH  | Admin only    | NEW — full edit                              |
| /admin/models/:id              | DELETE | Admin only    | NEW                                          |
| /admin/models/:id/enable       | POST   | Admin only    | Existing                                      |
| /admin/models/:id/disable      | POST   | Admin only    | Existing                                      |

### ProviderKeyView (extended)

```ts
interface ProviderKeyView {
  id: string;
  provider: string;            // internal slug
  name: string;                // display name (renamed from `label`)
  label: string | null;        // legacy field, retained for back-compat
  enabled: boolean;
  desc: string | null;         // NEW
  apiKeyMasked: string | null; // NEW — for display + show/hide
  status: ProviderKeyStatus;   // NEW — default 'unknown'
  latencyMs: number | null;    // NEW
  lastTestAt: string | null;   // NEW — ISO 8601
  endpoint: string | null;
  region: 'china' | 'global' | null;
  defaultBaseUrl: string | null;
  website: string | null;
  createdAt: string;
}
```

### ModelView (extended)

```ts
interface ModelView {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  enabled: boolean;
  disabledByAdmin: boolean;
  quotaPerUserPerDay: number | null;
  contextWindow: number | null;
  maxTokens: number | null;            // existing input context cap
  // NEW params fields:
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsThinking: boolean;
}
```

### Test connection logic

`POST /admin/provider-keys/:id/test`:

1. Read `endpoint` from DB. If `null`, return
   `{ status: 'failed', latencyMs: 0, lastTestAt: now, error: 'no_endpoint' }`.
2. Issue `GET <endpoint>/health` (preferred) or fall back to `GET /v1/models`
   for OpenAI-compatible endpoints. 5s timeout.
3. HTTP 2xx → `connected`; else → `failed`.
4. Write back to `status`, `latency_ms`, `last_test_at`.
5. Return the same fields.

### Cascade delete

`DELETE /admin/provider-keys/:id`:
- Transaction: `DELETE FROM models WHERE provider_id = :id; DELETE FROM
  provider_keys WHERE id = :id;`
- Return `{ ok: true, deletedModels: <count> }`.

## Error codes

| Error                    | HTTP | When                                          |
|--------------------------|------|-----------------------------------------------|
| provider_not_found       | 404  | `:id` doesn't exist or wrong org              |
| provider_in_use          | 409  | DELETE on provider with active chat sessions  |
| model_not_found          | 404  | model `:id` doesn't exist                     |
| model_duplicate          | 409  | adding a model with same `provider_id + model`|
| provider_test_failed     | 502  | upstream returned non-2xx                     |
| provider_test_timeout    | 504  | upstream didn't respond in 5s                 |
| provider_no_endpoint     | 400  | test endpoint called but no `endpoint` set    |
| forbidden                | 403  | non-admin tries a write endpoint              |
| validation_error         | 400  | bad input (e.g. temperature > 2)              |

## Validation rules

| Field                    | Rule                                         |
|--------------------------|----------------------------------------------|
| Provider name            | required, 1–64 chars                          |
| Provider desc            | optional, ≤ 256 chars                        |
| Provider baseUrl         | required, must be valid URL                   |
| Provider apiKey          | write-only; PATCH blank to keep current      |
| Model id                 | required, `[a-zA-Z0-9._-]{1,128}`             |
| Model displayName        | optional, ≤ 128 chars                        |
| Model.temperature        | 0..2 or null                                  |
| Model.topP               | 0..1 or null                                  |
| Model.maxOutputTokens    | 1..200000 or null                             |

Server is source of truth; client mirrors for instant feedback.

## UI structure

```
Sidebar (existing global nav, unchanged)
PageHeader: "模型管理" + breadcrumb + "Add provider" button
─────────────────────────────────────────────────────────
┌──────────────┬─────────────────────────────────────────────┐
│ ProviderRail │ ProviderDetail (when one selected)          │
│ ┌──────────┐ │ HeaderBar (icon + name + status pill + actions) │
│ │ search   │ │   [测试连接] [保存] [删除服务商]              │
│ ├──────────┤ │   ──── toggle: 已启用 / 启用 ────             │
│ │ 已配置   │ │ ProviderInfoCard (name/desc/baseUrl/apiKey)    │
│ │ ● Acme 5 │ │   status: ● 已连接 · 142ms · 2 分钟前          │
│ │ ○ Globex │ │ ModelList card                                 │
│ ├──────────┤ │   "模型列表 (5)"  [获取模型] [+ 添加]            │
│ │ 目录     │ │   ┌─────────────────────────────┐             │
│ │ + Foo    │ │   │ 模型 │ ID │ 类型 │ 上下文 │ 状态 │操作│  │
│ │ + Bar    │ │   │ ...                            │         │
│ └──────────┘ │   └─────────────────────────────┘             │
└──────────────┴─────────────────────────────────────────────┘
```

### Model params drawer (kept fields only)

- Slides in from right, 460px wide, with backdrop mask
- Header: model name + id (mono) + close button
- Sections:
  - **采样参数**: Temperature (0..2 step 0.1), Top P (0..1 step 0.05),
    最大输出 Tokens (1..200000)
  - **能力开关**: 视觉输入 (toggle), 思维链 (toggle)
  - **备注**: textarea
- Footer: 取消 / 保存配置 (no reset-to-defaults)

### Inline row edit (model table)

- Click "编辑" → row enters editing state (yellow background, like prototype)
- Inputs pre-filled with current values; "保存" / "取消" buttons replace
  action column
- Enter submits; Esc cancels
- "添加模型" → appends a new row in add state (blue background) below the table

### Provider enable toggle

- Switch in header, large 44×24
- ON state: "服务商已启用 — 该服务商的模型可用于业务调用"
- OFF state: "服务商已停用 — 暂不参与业务调用，可随时重新启用"
- Hits `POST .../enable` or `.../disable`

### Test connection

- Top-right "测试连接" button
- During test: spinner + "测试中…"
- On success: status dot turns green, latency + "最近测试 [relative time]"
  inline
- On failure: dot turns red, "连接失败" + error hint
- Inline flash (3s) shows ✓/✗ above the info card

### API key show/hide

- Eye icon button inside the API Key field
- Toggles `type` between `password` and `text`
- Field shows `api_key_masked` (e.g. `sk-••••••••abc123`)
- Server never returns plaintext

### Auth gating in UI

- Read-only users (non-admin) see: ProviderRail + ProviderDetail read-only +
  TestConnection + RefreshModels
- Admin users additionally see: enable/disable toggle, edit form fields (with
  save), delete buttons, inline edit/add/delete rows
- Gating via a `useCapability('admin')` hook reading from `useAuth` store

## File manifest

### New files (server-side)

- `enterprise_server/src/db/migrations/015_provider_keys_extended.sql`
- `enterprise_server/src/db/migrations/016_models_params.sql`
- `enterprise_server/src/shared/providerKeys/constants.ts`
- `enterprise_server/src/shared/models/types.ts`
- `enterprise_server/tests/routes/providerKeysExtended.test.ts`
- `enterprise_server/tests/routes/modelsExtended.test.ts`

### New files (client-side)

- `enterprise_server/web/src/pages/providersModels/ProviderRail.tsx`
- `enterprise_server/web/src/pages/providersModels/ProviderDetail.tsx`
- `enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx`
- `enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx`
- `enterprise_server/web/src/pages/providersModels/ModelList.tsx`
- `enterprise_server/web/src/pages/providersModels/ModelTableRow.tsx`
- `enterprise_server/web/src/pages/providersModels/ModelInlineEditRow.tsx`
- `enterprise_server/web/src/pages/providersModels/ModelInlineAddRow.tsx`
- `enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.tsx`
- `enterprise_server/web/src/components/StatusDot.tsx`
- `enterprise_server/web/src/pages/ProvidersModelsPage.test.tsx` (rewrite)

### Modified files (server-side)

- `enterprise_server/src/routes/admin/providerKeys.ts`
- `enterprise_server/src/routes/admin/models.ts`
- (any shared provider-key types file if it exists)

### Modified files (client-side)

- `enterprise_server/web/src/pages/ProvidersModelsPage.tsx` — rewrite
- `enterprise_server/web/src/api/providers.ts`
- `enterprise_server/web/src/api/models.ts`
- `enterprise_server/web/src/api/types.ts`
- `enterprise_server/web/src/i18n.ts`

### Dependencies

- **No new dependencies.** All work uses React + Hono + TanStack Query already
  in the project.

## Verification

### Phase 1: server compiles

```bash
cd /Users/paulwang/work/GenWork/enterprise_server
npm test -- providerKeysExtended modelsExtended
```

### Phase 2: client compiles

```bash
cd /Users/paulwang/work/GenWork/enterprise_server/web
npm run build
npx vitest run ProvidersModelsPage
```

### Phase 3: lint clean

```bash
cd /Users/paulwang/work/GenWork
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  enterprise_server/src/routes/admin/providerKeys.ts \
  enterprise_server/src/routes/admin/models.ts \
  enterprise_server/web/src/pages/ProvidersModelsPage.tsx \
  enterprise_server/web/src/pages/providersModels/*.tsx \
  enterprise_server/web/src/api/providers.ts \
  enterprise_server/web/src/api/models.ts
```

### Phase 4: manual QA (per AGENTS.md)

```bash
# Terminal 1
cd /Users/paulwang/work/GenWork/enterprise_server && npm run dev
# Terminal 2
cd /Users/paulwang/work/GenWork/enterprise_server/web && npm run dev
# Browser: http://localhost:5173/config/providers
```

Verify against a real enterprise_server:

- Provider rail shows configured + catalog sections
- Click a provider → detail panel populates
- Test connection → status dot updates
- Toggle enable/disable
- Add a model via inline add row
- Edit a model inline
- Open params drawer → edit temperature/topP/maxOutput/capabilities/note → save
- Delete a model → confirm dialog → mutation
- Edit provider name/desc/baseUrl → save
- Delete provider → confirm dialog → cascade
- Switch org users: non-admin sees no edit/delete controls

## Risks

1. **API contract change** — additive fields are safe; existing consumers
   using interface declarations (not narrow unions) are unaffected.
2. **Cascade delete data loss** — confirm dialog requires explicit
   confirmation; label clearly says "及其全部 N 个模型"; no undo flow.
3. **Test connection DoS** — 5s timeout; per-provider rate limit out of scope.
4. **Migration on large tables** — tables expected small (< 1000 rows); no
   locking concerns. Future-proofed by NULLABLE columns + `DEFAULT 'unknown'`
   only for `status`.

## Out-of-scope reminders

These are NOT in this PR — no schema, no API, no UI, no i18n:

- 停止符 / 流式输出 / 函数调用 / 思维链预算 / 响应格式 / 限速 / 定价
- Tabs (Models / API keys / Usage / Activity) — removed in cleanup
- StatsRow with real data
- Catalog provider concept — keep underlying data split, rename UI labels to
  match prototype's "内置 / 自定义"
