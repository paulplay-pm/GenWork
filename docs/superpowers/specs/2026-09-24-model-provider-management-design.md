# 大模型管理 (Model & Provider Configuration) — PRD V1.0 alignment

- **Date:** 2026-09-24
- **Status:** Design — awaiting approval to implement
- **Owners (files):** `enterprise_server` (Hono + Postgres backend) + `enterprise_server/web` (admin SPA). The Electron desktop (`src/`) is **not touched**.
- **Source of truth for UI:** the delivered high-fidelity prototype `大模型管理原型.html` (+ `_shots/大模型管理原型_desktop.jpg`). Where this spec and the prototype conflict on visuals, the prototype wins (per PRD 附).
- **Scope authority:** PRD V1.0 §2.3 (本次包含 / 本次不包含). The prototype's overview / quota / cross-provider-catalog views belong to the §2.3 *excluded* (V1.1) surface and are **not** part of this work.

---

## 1. Problem

The GenWork 工作台 "模型配置" (大模型管理) page manages two related
resources — **providers** (model sources, each with a Base URL + API key +
protocol) and the **models** under each provider. Much of the plumbing already
exists (provider CRUD, model CRUD, sampling columns, test-connection,
refresh-models). But the page was built around a *developer onboarding* mental
model and diverges from the enterprise-admin PRD in concrete ways:

| **Area** | **Today (verified)** | **PRD V1.0 target** |
|---|---|---|
| Provider list | "已配置 / 目录 (catalog seeds)" groups | **内置服务商 (9) / 自定义服务商 (N)** groups, with counts |
| Built-in providers | 8-provider *frontend catalog* (not DB rows); deletable | **9 first-class DB rows** (OpenAI…Xiaomi, 火山引擎), non-deletable, pre-filled |
| API protocol | Implicit — inferred from provider slug in `providerModelFetcher` | **Explicit radio** (OpenAI 兼容 / Anthropic 兼容) per provider |
| Model type | **single** `type` enum (6 values) | **multi-select**, 8 values (chat/vision/reasoning/image-gen/embedding/rerank/asr/tts) |
| Context window | Free numeric input | **5-stop slider** (32K / 64K / 200K / 1M / 2M) |
| Model editor | separate inline add/edit rows **+ a standalone params drawer** | **one drawer**: name / ID / 8 type cards / context slider / temp / topP |
| API key echo | `api_key_masked` column **never written** (always NULL) | Masked echo on every provider row |

This spec turns the PRD + prototype target into a concrete, testable design.

## 2. Background — current state (verified against source)

- **Stack A only.** Targets `enterprise_server` (Hono + Postgres, JWT Bearer)
  + its admin SPA `enterprise_server/web` (React 19 + TanStack Query +
  Zustand + Tailwind + lucide). The Electron desktop is a member client and
  is untouched.
- **`provider_keys`** (built across `002`, `015`, `006`):
  `id TEXT PK, org_id, provider, api_key_encrypted, endpoint, label, enabled
  DEFAULT true, created_by, created_at` + `description, api_key_masked, status
  ('unknown'|'connected'|'failed'), latency_ms, last_test_at` + `region,
  default_base_url, website`. **No `is_builtin` flag. No `protocol` field.**
  `api_key_masked` is *read* in `providerKeyVault` (SELECT at
  `src/vault/providerKeyVault.ts:18,68`) but **never written** anywhere →
  always NULL on the wire.
- **`model_catalog`** (built across `002`, `017`, `006`, `016`):
  `id, org_id, provider_key_id (FK), provider, model, display_name,
  quota_per_user_per_day, enabled DEFAULT true, UNIQUE (org_id, provider,
  model)` + `type TEXT NOT NULL DEFAULT 'chat'
  CHECK IN ('chat','reasoning','vision','embedding','image','audio')` (single
  string) + capability booleans `supports_image/video/thinking` + numeric
  `context_window INTEGER, max_tokens INTEGER` + sampling `temperature REAL,
  top_p REAL, max_output_tokens INTEGER`. **Sampling columns already exist.**
- **Built-in providers** exist **only in the frontend**:
  `web/src/data/providerCatalog.ts` → `PROVIDER_CATALOG` = 8 providers
  (deepseek, openai, anthropic, gemini, moonshot, qwen, zhipu, xai), each with
  `id, label, region, defaultBaseUrl, description, website, apiKeyUrl,
  defaultModels[]`. **No backend seed. No non-deletable concept.** Note the
  current catalog has `gemini` + `xai` and is **missing** the PRD's
  `minimax`, `xiaomi`, `volc`.
- **Provider routes** (`src/routes/admin/providerKeys.ts`, mounted
  `src/server.ts:56`): `GET ?orgId` (`provider:view`), `POST` (`provider:edit`,
  zod: orgId, provider, apiKey, label?, endpoint?, region?, defaultBaseUrl?,
  website?), `POST :id/disable`, `POST :id/enable`, `POST :id/refresh-models`
  (decrypt key → `fetchProviderModels` → `modelCatalog.upsertMany`), `PATCH :id`
  (description / baseUrl→endpoint / label / enabled; **no apiKey** → no
  rotation), `DELETE :id` (cascade models then key), `POST :id/test` (GET
  `{endpoint}/health` → fallback `/v1/models`, 5s timeout, writes status back).
- **Model routes / service** (`src/routes/admin/models.ts`, mounted
  `:57`; `src/models/modelCatalog.ts`): `GET ?orgId` (`model:view`), `POST`
  (`model:create`, body incl. `capabilities{supportsImage/Video/Thinking,
  contextWindow, maxTokens, temperature(0–2), topP(0–1),
  maxOutputTokens(1–200000)}`), `PATCH :id` (`model:edit`), `DELETE :id`
  (`model:delete`), `PATCH :id/quota`, `POST :id/disable|enable` (policy-based
  via `model_policies`, separate from catalog `enabled`). Types read/written as
  the **single `type` string**.
- **Protocol handling** is implicit: `src/models/providerModelFetcher.ts`
  dispatches on provider-slug sets (`OPENAI_COMPAT_PROVIDERS`,
  `ANTHROPIC_PROVIDERS`, `GEMINI_PROVIDERS`); base-URL normalization strips/
  appends `/v1`. **No `protocol` field/selector.**
- **Permission points** (`src/shared/permissionPoints.ts`): `provider:view /
  provider:edit / provider:rotate` + `model:view / model:create / model:edit /
  model:delete`. `provider:rotate` is defined but **unused**. Hand-mirror at
  `web/src/shared/permissions.ts`.
- **Frontend page** (`web/src/pages/ProvidersModelsPage.tsx` + 9 components
  under `pages/providersModels/`): two-column master–detail. Left `ProviderRail`
  (search + 已配置 rows w/ status dot + model-count + 目录 seeds + custom
  draft). Right pane: `ProviderHeaderBar` (test/save/delete) →
  `ProviderEnableSwitch` → `ProviderInfoCard` (name/label, base URL→endpoint,
  description, API key; **patch save silently drops apiKey**) → `ModelList`
  (columns: name+id / type pill / context / status / actions incl. **params
  drawer**, delete). Model table shows **only** context window (no temp/topP).
  Model types rendered via `modelType.tsx` (`ModelTypeSelect`, `ModelTypePill`),
  6 values. API clients at `web/src/api/providers.ts` + `web/src/api/models.ts`
  (`setQuota` orphaned — no UI consumer).

## 3. Goals & non-goals

**Goals (V1.0, per PRD §2.3):**
- Left provider list grouped **内置服务商 (9) / 自定义服务商 (N)** with group
  counts; brand icon + name + model-count badge + inline enable switch; delete
  icon on **custom** rows only; search; "+ 添加服务商" dashed entry.
- Right detail: header (48px icon + name + 内置/自定义 tag + Base URL) with
  **测试连接 + 保存 only, no cancel**; in-place 连接信息 form (name / API协议
  radio / Base URL / API Key masked); model table (name+id / multi-type tags /
  context / enable switch / edit) + **获取模型** + **+ 添加模型**.
- One **model drawer** (add + edit): name / ID / 8 type cards / 5-stop context
  slider / temperature / topP.
- 9 built-in providers as real DB rows, non-deletable, pre-filled.

**Non-goals (V1.1, per PRD §2.3 本次不包含 — will NOT build):**
- Cross-provider usage / cost dashboard.
- Department-level model visibility authorization.
- API key multi-key rotation.
- Model canary release / version management.

The prototype's `renderOverview` / `renderQuota` / `renderModels` (cross-provider
catalog) are these V1.1 surfaces. Not creating them.

## 4. Decision log (locked during brainstorming)

1. **Built-in providers = real DB rows.** Each org gets 9 seeded
   `provider_keys` rows (pre-filled base_url + protocol + sample models,
   `is_builtin=true`, no key) + their models in `model_catalog`. Left list is
   one query grouped by `is_builtin`. Built-ins are non-deletable. *Cost if
   wrong:* rework to a catalog-overlay; but the prototype's built-ins show model
   counts + enable switches, which DB rows give for free.
2. **API keys = masked-only on *return*; the single key is still settable.** No
   plaintext-*return* endpoint and no multi-key rotation — the key is shown as
   a mask on every row, and `provider:rotate` stays unused in V1.0. But the
   **single** API key can be set/replaced via the form (write-only field:
   accepted on create + patch, stored encrypted, never returned in plaintext).
   This is required because seeded built-ins start **keyless** and "未填写时模型
   不可调用". *Cost if wrong:* PRD §六's "reveal plaintext to 供应商密钥管理 role"
   is deferred (see §14); masked-only return is the safer default.
3. **Strict fold + strip.** Right pane matches the prototype exactly: single
   comprehensive model drawer **replaces** the standalone `ModelParamsDrawer` +
   inline add/edit rows. Region / website / quota are **removed from the
   visible form** (columns kept in DB; region/website auto-filled from catalog
   on create; quota stays API/DB-only). A model row keeps **delete** (functionally
   required; the prototype's edit affordance implies it). *Cost if wrong:* some
   power features lose their surface — acceptable per the "删除原型中不存在的
   功能" directive.
4. **`protocol` drives test-connection + refresh-models wire format only.** It
   does **not** rewire the runtime inference proxy (`src/routes/proxy.ts`,
   always OpenAI chat-completions) — that is the live model-serving path, out
   of this module's scope. *Cost if wrong:* minimal; proxy already works.
5. **Model types become a set.** New `types TEXT[]` column; legacy single `type`
   kept as a de-facto-primary read for backward-compat, deprecated. *Cost if
   wrong:* a later migration drops `type`.
6. **Sampling params are per-model** (prototype + existing DB agree); models
   pulled by 获取模型 **default to enabled** (existing `upsertMany` behavior).
   These resolve the two PRD §八 open items for V1.0.

## 5. Data model & migrations

Three new migrations, applied in order (next free numbers after the merged
org-permission `030`): **`031`**, **`032`**, **`033`**. All idempotent +
transactional. Migration tests assert before/after.

### 5.1 Migration 031 — `provider_keys` v2 (`031_provider_keys_v2.sql`)

```sql
ALTER TABLE provider_keys
  ADD COLUMN is_builtin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN protocol   TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai','anthropic'));

-- Built-ins are unique per (org, provider) so seeding is idempotent and a
-- built-in can never be duplicated; custom providers may repeat the slug
-- (e.g. two vllm endpoints) so they are NOT covered by this constraint.
CREATE UNIQUE INDEX provider_keys_org_provider_builtin
  ON provider_keys (org_id, provider) WHERE is_builtin;
```

- `protocol` ∈ `{openai, anthropic}`. (The PRD's protocol selector is binary;
  the existing Gemini path is folded into `openai`-shaped probing for V1.0 —
  Gemini is not one of the 9 built-ins and a custom Gemini endpoint uses the
  openai-shaped probe as before.)
- Partial unique index makes `033`'s built-in insert `ON CONFLICT (org_id,
  provider) WHERE is_builtin DO NOTHING`-safe **and** prevents an admin from
  adding a second built-in of the same slug.

### 5.2 Migration 032 — `model_catalog` multi-type (`032_model_multi_type.sql`)

```sql
ALTER TABLE model_catalog
  ADD COLUMN types TEXT[] NOT NULL DEFAULT ARRAY['chat'];

-- Backfill from the legacy single `type` string (one-off). Mapping:
--   image → image-gen ; audio → asr ; chat/reasoning/vision/embedding → 1:1
UPDATE model_catalog SET types = CASE
  WHEN type = 'image'  THEN ARRAY['image-gen']
  WHEN type = 'audio'  THEN ARRAY['asr']
  ELSE ARRAY[type]
END
WHERE types = ARRAY['chat'] AND type IS NOT NULL;  -- only touch untouched defaults
```

- Allowed values for `types`: `chat, vision, reasoning, image-gen, embedding,
  rerank, asr, tts` (8). `chat` is the default base type (always offered;
  may be empty in the raw array only for embedding/rerank-only rows — the UI
  enforces chat for chat-capable models, but the column does **not** hard-
  constrain to a non-empty set to allow pure embedding/rerank models).
- Legacy `type` column is **kept** and treated as the *primary/representative*
  type for backward-compatible reads (e.g. any existing consumer that filters
  on `type`). Writes continue to set `type = types[1]` (first) for compat; new
  code reads `types`. A future migration may drop `type`.
- `context_window` stays `INTEGER` (tokens, **free value**). The drawer's
  context control is a **5-stop picker** (32K / 64K / 200K / 1M / 2M →
  `32000 / 64000 / 200000 / 1000000 / 2000000`): dragging snaps to the nearest
  stop, but the **stored value is always the exact integer** so real off-ladder
  windows (e.g. a model's genuine 128K / 256K) are preserved and displayed as
  their actual formatted value (`128K`), not rounded to a stop. The thumb sits
  at the nearest stop for off-ladder values.

### 5.3 Migration 033 — seed 9 built-in providers (`033_seed_builtin_providers.sql`)

Idempotent, run for **every existing org** via a `DO` block that loops
`SELECT id FROM orgs` and, per org, inserts (all `is_builtin=true`, `enabled
DEFAULT true`, no key, deterministic id `builtin:<org>:<slug>`):

- 9 `provider_keys` rows with pre-filled `endpoint` + `protocol` (from the
  §6 table), `ON CONFLICT (org_id, provider) WHERE is_builtin DO NOTHING`.
- Each provider's PRD-listed default `model_catalog` rows (name / model id /
  mapped `types` / `context_window`), `ON CONFLICT (org_id, provider, model) DO
  NOTHING`.

**New orgs** get the same seed through the **org-creation flow**: extract the
seed body into a shared helper (`seedBuiltinProviders(orgId)`) used both by
`033` (loop) and by the create-org path, so a freshly created org is
consistent. The helper is deterministic and idempotent (same `ON CONFLICT`
guards), so it is safe to call more than once.

### 5.4 `api_key_masked` fix (no dedicated migration)

`providerKeyVault.add` (and any future re-set) computes and stores
`api_key_masked` — first/last 4 chars, middle masked: `sk-••••••••a93f` (mask
all but the trailing 4). List / GET return the **stored** `api_key_masked`; if
it is NULL (pre-existing rows from before this change), lazily derive
`decrypt → mask` in the read path so old rows echo correctly **without** a
fragile whole-table backfill. **No plaintext is ever returned** by any route.

## 6. The 9 built-in providers (seed values)

Slugs and values come from PRD §五 (built-in list) + the prototype's
`PROVIDERS`. `protocol` chosen per PRD (Anthropic-compatible for Anthropic;
OpenAI-compatible for the other 8). Sample models are the PRD §五 list (for
seed only — 获取模型 can later refresh/replace). `id = builtin:<org>:<slug>`.

| slug | name | endpoint (Base URL) | protocol | sample models (model id) |
|---|---|---|---|---|
| `openai` | OpenAI | `https://api.openai.com/v1` | openai | gpt-4o, gpt-4o-mini, o3-mini |
| `anthropic` | Anthropic | `https://api.anthropic.com` | anthropic | claude-sonnet-4, claude-opus-4 |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | openai | deepseek-v4-pro, deepseek-v4-flash, deepseek-reasoner |
| `moonshot` | Moonshot (Kimi) | `https://api.moonshot.cn/v1` | openai | kimi-k3, kimi-k2.6, kimi-k2.5 |
| `qwen` | Qwen (DashScope) | `https://dashscope.aliyuncs.com/api/v1` | openai | qwen3.6-plus, qwen3.5-plus, qwen-vl-max |
| `zhipu` | Zhipu (GLM) | `https://open.bigmodel.cn/api/paas/v4` | openai | glm-5.1, glm-5 |
| `minimax` | MiniMax | `https://api.minimax.chat/v1` | openai | MiniMax-M3, MiniMax-M2.7, MiniMax-M2.5 |
| `xiaomi` | Xiaomi (MiMo) | `https://api.xiaomimimo.com/v1` | openai | mimo-v2.5-pro, mimo-v2.5 |
| `volc` | 火山引擎 (豆包) | `https://ark.cn-beijing.volces.com/api/v3` | openai | doubao-seed-2.0-pro, doubao-seed-2.0-lite |

Seed `types` per model (from the prototype's model list; reasonable defaults
where the prototype is silent — e.g. `o3-mini`→`[reasoning]`,
`deepseek-reasoner`→`[reasoning]`, `qwen-vl-max`→`[chat,vision]`,
`claude-*-4`→`[chat,reasoning]`):

| slug | model id → types | context_window |
|---|---|---|
| openai | gpt-4o→[chat,vision], gpt-4o-mini→[chat], o3-mini→[chat,reasoning] | 128000 |
| anthropic | claude-sonnet-4→[chat,reasoning], claude-opus-4→[chat,reasoning] | 200000 |
| deepseek | deepseek-v4-pro→[chat,reasoning], deepseek-v4-flash→[chat], deepseek-reasoner→[reasoning] | 128000 |
| moonshot | kimi-k3→[chat,reasoning], kimi-k2.6→[chat], kimi-k2.5→[chat] | 200000 |
| qwen | qwen3.6-plus→[chat,vision], qwen3.5-plus→[chat], qwen-vl-max→[chat,vision] | 128000 |
| zhipu | glm-5.1→[chat,reasoning], glm-5→[chat] | 128000 |
| minimax | MiniMax-M3→[chat], MiniMax-M2.7→[chat], MiniMax-M2.5→[chat] | 128000 |
| xiaomi | mimo-v2.5-pro→[chat], mimo-v2.5→[chat] | 128000 |
| volc | doubao-seed-2.0-pro→[chat,vision,reasoning], doubao-seed-2.0-lite→[chat] | 200000 |

(These seed `types`/`context_window` are defaults; 获取模型 and the model drawer
overwrite them. Seed rows are created **enabled**.)

## 7. Backend API surface

Existing routes; changes marked. Gates unchanged (`provider:view/edit`,
`model:view/create/edit/delete`). Cross-org isolation preserved (existing
`org_id` scoping → 404 for cross-org targets).

### Providers (`src/routes/admin/providerKeys.ts`)

- `GET /admin/provider-keys?orgId` — list; now returns `is_builtin`, `protocol`,
  and a **populated** `api_key_masked` (lazy-derive when NULL). Response shape
  gains those fields.
- `POST /admin/provider-keys` — create. **Gains `protocol`** (zod enum
  `openai|anthropic`, default `openai`). Built-ins cannot be created via this
  route (they are seeded); a POST with a slug that collides a built-in's
  `(org,provider)` is rejected by the partial unique index → `409`.
- `PATCH /admin/provider-keys/:id` — patch description / baseUrl→endpoint /
  label / enabled. **Gains `protocol`.** **Accepts an optional `apiKey`
  (write-only)**: when present it re-sets the single key (encrypt + refresh
  `api_key_masked`); when absent the key is untouched. The key is **never
  returned** in plaintext (masked-only return; see §5.4). No multi-key rotation
  in V1.0.
- `POST /admin/provider-keys/:id/test` — **protocol-aware**: openai → `GET
  {base}/v1/models` (+Bearer) [health first as today]; anthropic →
  `x-api-key` + `anthropic-version: 2023-06-01` against `/v1/models` (Anthropic
  has no OpenAI-shaped health endpoint). 5s timeout, writes status back.
- `POST /admin/provider-keys/:id/refresh-models` — **protocol-aware** via
  `fetchProviderModels` keyed off `row.protocol` (see §8).
- `DELETE /admin/provider-keys/:id` — **built-in guard** (mirrors the just-
  shipped `builtin_role` 409): if the row `is_builtin`, return
  `409 {error:'builtin_provider'}` and **audit** the attempt; otherwise
  cascade-delete models then the row (custom). Guard fires **after** the
  `provider:edit` gate.
- `POST :id/enable|disable` — unchanged (toggles `enabled`); inline enable
  switch on both built-in and custom rows.

### Models (`src/routes/admin/models.ts`)

- `POST /admin/models` — body gains `types: string[]` (replacing single
  `type`); still accepts `capabilities{contextWindow, temperature, topP,
  maxOutputTokens}`. Writes `types` + sets legacy `type = types[0] ?? 'chat'`.
  Validates `types` ⊆ the 8 allowed values.
- `PATCH /admin/models/:id` — same `types` handling; range-validates
  `temperature` (0–2), `topP` (0–1).
- `GET ?orgId` — `ModelView` now carries `types: string[]` (and keeps `type`
  for compat).
- `DELETE /admin/models/:id`, `PATCH :id/quota`, `POST :id/enable|disable` —
  unchanged. (Quota stays API/DB-only in V1.0; no UI.)

### Audit

Provider enable/disable + delete + (built-in 409 attempt) and model
enable/disable + create/edit/delete are all audited via the existing
`auditStore` (already wired for most; the built-in 409 attempt + any new
protocol-aware refresh outcome are added). No new audit infrastructure.

## 8. Protocol dispatcher (`src/models/providerModelFetcher.ts`)

Refactor the dispatch to key off an **explicit protocol** passed in (from
`row.protocol`) instead of provider-slug sets:

- `openai` → `GET {base}/v1/models` with `Authorization: Bearer <key>`;
  base-URL normalization (strip/append `/v1`) as today. Custom providers with
  protocol=openai use this path (covers vllm / private gateways).
- `anthropic` → `GET {base}/v1/models` (Anthropic model list) with
  `x-api-key: <key>` + `anthropic-version: 2023-06-01`.
- Unknown/empty → the existing OpenAI-shaped `probeModelsEndpoint` fallback
  (unchanged), so a misconfigured custom provider degrades to the probe.

The per-slug sets (`OPENAI_COMPAT_PROVIDERS`, etc.) become **defaults** used
only when a row's `protocol` is unset (legacy rows); new reads prefer
`row.protocol`. The runtime inference proxy (`src/routes/proxy.ts`) is
**out of scope** and unchanged (always OpenAI chat-completions).

## 9. Frontend rework (`ProvidersModelsPage` + `pages/providersModels/`)

Rebuild to match the prototype. Keep TanStack Query + the existing API client
functions (extend, don't fork).

### 9.1 Left rail — `ProviderRail.tsx`

- Regroup **已配置 / 目录** → **内置服务商 (9) / 自定义服务商 (N)**; group label
  shows the count. (Data = one `providersApi.list` grouped by `is_builtin`.)
- Row: brand icon (colored, from the provider's catalog color) + name +
  model-count badge + inline **enable switch** (`providersApi.setEnabled`);
  switch toggles immediately with a toast (no save click).
- **Delete icon on custom rows only** → confirm dialog → `providersApi.remove`
  (cascades models). Built-in rows have no delete.
- Search box: fuzzy name filter (client-side).
- "+ 添加服务商" dashed entry **under the 自定义 group**: creates an empty
  custom draft (disabled by default, auto-selected, right pane shows empty form
  with placeholder "例如：My VLLM", empty model table with empty-state copy).
  Created (not persisted) until 保存.

### 9.2 Right header — `ProviderHeaderBar.tsx`

- 48px brand icon + name + **内置 / 自定义 tag** + Base URL (mono, grey; "尚未
  配置 Base URL" when empty).
- Right side: **测试连接 (ghost)** + **保存 (primary)** — **no cancel button**.
  测试连接 → `providersApi.test`, toast (green "连接成功" / red error with the
  reason). 保存 → `providersApi.patch` (existing) / `add` (new draft).

### 9.3 连接信息 form — `ProviderInfoCard.tsx`

- Fields: **服务商名称**, **API 协议** (radio: OpenAI 兼容 / Anthropic 兼容 →
  `protocol`), **Base URL** (mono; placeholder per protocol), **API Key**
  (password, mono, **write-only**: on create it's required; in edit mode it shows
  a masked echo + "留空保持不变，输入以替换" hint, and 保存 sends it only when the
  user typed a new value — never pre-filled with plaintext, which is impossible
  since the server never returns it).
- **Strip** region / website / description from the visible form (columns stay
  in DB; region/website auto-filled from catalog on create; description
  unused). On protocol switch, update the Base URL placeholder (openai →
  "https://api.example.com/v1"; anthropic → "https://api.anthropic.com").

### 9.4 Model table — `ModelList.tsx`

- Columns: **模型** (display name + mono model id) / **类型** (multi-tag,
  colored: 对话=蓝, 视觉理解=青, 思考推理=紫, 其他=灰) / **上下文** (ladder
  label) / **启用** (inline switch) / **操作** (edit → opens the model drawer).
- **Delete** kept on the row (functionally required; not contradicted by the
  prototype).
- Header right: **获取模型** (→ `providersApi.refreshModels`, toast with
  `{added, unchanged}`) + **+ 添加模型** (→ open empty drawer).
- Empty state: "暂无模型，点击右上角「添加模型」开始配置".

### 9.5 Model drawer — new `ModelDrawer.tsx` (replaces `ModelParamsDrawer` + inline rows)

Single drawer for **add and edit**, top-to-bottom (matches prototype):

1. **基本信息** — 模型名称* (placeholder "GPT-4", hint "自定义模型在列表中显示
   的名称"), 模型 ID* (mono, placeholder "gpt-4", hint "模型的唯一标识符，将用于
   API 调用").
2. **模型类型** — **8 two-column multi-select cards**: 对话 `chat` (default),
   视觉理解 `vision`, 思考推理 `reasoning`, 图像生成 `image-gen`, Embedding
   `embedding`, 重排序 `rerank`, 语音识别 `asr`, 语音合成 `tts`; checked =
   blue border. (Replace the `ModelTypeSelect` single-dropdown.)
3. **上下文窗口** — **5-stop picker** (32K/64K/200K/1M/2M); the current value
   (exact integer, formatted) is shown above, off-ladder values sit at the
   nearest stop; hint "窗口越大可容纳越多对话历史与文档，实际大小取决于模型本身".
4. **采样参数** (divider) — **温度** slider 0–2, step 0.1, default 0.7 (hint
   "对话建议 0.7，代码生成建议 0.2"); **Top P** slider 0–1, step 0.05, default
   0.9 (hint "核采样阈值，通常与温度二选一调参，保持默认 0.9").
- Footer: 取消 + 保存 (add → `modelsApi.add` with `types[]`; edit →
  `modelsApi.patch`).

### 9.6 Frontend type / i18n updates

- `web/src/api/models.ts` `ModelType` → extend to the 8-value set + add
  `types: string[]` to `ModelView`; keep `type` for compat. `providerKeys`
  view + `add`/`patch` gain `protocol` + `is_builtin`.
- `modelType.tsx`: multi-tag rendering from `types[]` (drop the single-select
  `ModelTypeSelect` if no longer used; keep `ModelTypePill` per value with the
  PRD color mapping).
- `web/src/data/providerCatalog.ts`: update to the **9** PRD built-ins (add
  minimax/xiaomi/volc, drop gemini/xai from the *built-in* set; keep them only
  if reused as custom-provider color/brand presets). Brand colors per
  prototype.
- i18n (`i18n.ts`, zh + en): new labels for the 8 types, protocol, context
  ladder, sampling hints, group labels, empty states.
- `web/src/shared/permissions.ts` mirror: unchanged point set (no new points in
  V1.0); keep the equality test green.

## 10. Security & audit

- **Masked-only keys:** no plaintext-return route; `api_key_masked` populated
  (write) and lazy-derived (read) when NULL. `provider:rotate` stays unused in
  V1.0.
- **Built-in delete guard:** `409 {error:'builtin_provider'}`, fires after the
  `provider:edit` gate, **audited** (attempt). Mirrors `builtin_role`.
- **Cross-org isolation:** existing `org_id` scoping preserved (cross-org target
  → 404, never mutated/leaked).
- **Audit:** provider enable/disable/delete, built-in-409 attempt, model
  create/edit/delete/enable/disable audited via `auditStore` (existing infra).
- **Permission gates unchanged:** `provider:view/edit`, `model:view/create/edit/
  delete`; `super_admin` bypass preserved.

## 11. Testing & verification

Per-file vitest (server) + jsdom (web), following the just-merged conventions.
**Run server tests per-file** (full enterprise_server suite hits the sandbox
fd/EBADF limit).

- **Migrations:** `031` (columns + partial unique index), `032` (types backfill
  mapping incl. image→image-gen, audio→asr), `033` (9 built-ins + models seeded
  per org; idempotent on re-run; new-org path seeds too).
- **Protocol dispatch:** openai vs anthropic headers/URLs; legacy unset
  protocol falls back to slug defaults; unknown → probe fallback.
- **Built-in guard:** `DELETE` a built-in → 409 + audit; `DELETE` a custom →
  cascade; POST colliding a built-in slug → 409 (partial unique index).
- **Masked echo:** after `add`, list returns a populated `api_key_masked`
  (never plaintext); a pre-existing NULL-mask row lazy-derives on read.
- **Multi-type round-trip:** `types[]` on create/patch persisted; legacy `type`
  = `types[0]`; validation rejects out-of-set values; context ladder maps to
  the 5 token values.
- **Routes:** provider list shape (is_builtin/protocol/masked); PATCH protocol;
  model create/patch with `types[]`.
- **Frontend (jsdom):** rail groups + counts; custom-only delete icon; enable
  switch toggles; model drawer (8 type cards, 5-stop context slider, temp/topP
  sliders) add + edit; API client type tests.
- **Visual (Playwright, real backend):** provider list (9 built-ins + custom)
  and the model drawer, against an isolated throwaway DB (as in the org-
  permission acceptance) — new baselines `providers-list.png`,
  `provider-detail.png`, `model-drawer.png`.
- **Acceptance walkthrough** (isolated live Postgres, not the dev DB):
  seeded 9 built-ins non-deletable (409), custom add→save, inline enable,
  protocol radio affects test-connection, 获取模型 populates, model drawer
  saves types/context/sampling, masked-only echo, cross-org 404.

## 12. Phasing & effort

- **P1 — Data model.** Migrations 031/032/033 + `seedBuiltinProviders(orgId)`
  helper + wire into create-org; `api_key_masked` write + lazy-derive read in
  `providerKeyVault`. Migration tests.
- **P2 — Backend.** Protocol-aware `providerModelFetcher` + `test` route;
  `is_builtin`/`protocol` on provider routes + built-in 409 guard (audited);
  model routes accept `types[]`; `ModelView` carries `types[]`. Per-file route
  tests.
- **P3 — Frontend.** Rebuild `ProviderRail` (groups), `ProviderHeaderBar`
  (test/save, no cancel), `ProviderInfoCard` (protocol radio, strip fields),
  `ModelList` (multi-type tags + context ladder), new `ModelDrawer` (replaces
  `ModelParamsDrawer` + inline rows); update `providerCatalog.ts` to 9; i18n
  zh+en; API client + `modelType.tsx` updates; permissions mirror test green.
- **P4 — Hardening & verification.** Visual baselines; acceptance walkthrough;
  cross-org isolation re-confirmed; final per-file + web suite green.

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Multi-type migration data change (backfill) | Idempotent + guarded (`WHERE types = ARRAY['chat'] AND type IS NOT NULL`); keep legacy `type` as compat primary; migration tests assert the mapping incl. image→image-gen / audio→asr. |
| Built-in seed collisions / re-runs | Deterministic ids + partial unique index + `ON CONFLICT DO NOTHING`; new-org path shares the same idempotent helper; migration test seeds twice. |
| Protocol dispatcher regression on existing providers | Slug sets remain the fallback when `protocol` unset; integration tests for openai/anthropic + legacy; runtime proxy untouched. |
| Removing `ModelParamsDrawer` loses quota/website/region UI | Deliberate (strict fold); those stay in DB + API/DB-only (quota) or auto-filled (region/website); documented as V1.1 surface. |
| Pre-existing NULL `api_key_masked` rows | Lazy decrypt→mask in the read path (no fragile backfill); test covers a NULL-mask row. |
| SPA/server type-vocabulary drift | Single source of the 8 values; `ModelView.types` round-trip test; i18n + `modelType.tsx` driven from the same list. |
| Sandbox fd/EBADF on full server suite | Run server tests per-file (established constraint). |

## 14. Deferred / open items (per PRD §2.3 本次不包含 + §八 未决事项)

- **Usage / cost dashboard** (overview stat cards, 7-day chart, top providers).
- **Department-level model visibility authorization** (department budget/quota
  table, per-dept model scope).
- **API key rotation / multi-key** (`provider:rotate` point has no consumer;
  masked-only in V1.0). **Reveal plaintext to a "供应商密钥管理" role** is
  deferred — PRD §六's literal reveal is NOT implemented; if desired later, add
  the permission point + a `GET .../key` reveal endpoint.
- **Model canary release / version management.**
- **Cross-provider model catalog** (the prototype's `renderModels` cross-provider
  table with price/visible-scope columns) — V1.1.
- PRD §八 #3 (custom-provider delete → how dependent agents degrade) — V1.1.
