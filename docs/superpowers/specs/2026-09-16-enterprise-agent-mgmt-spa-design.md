# Enterprise Agent Management — Admin SPA (design)

## Purpose

Redesign the **enterprise_server** admin SPA's 智能体管理 (Agent Management)
page to pixel-match the interactive prototype at
`/Users/paulwang/DoubaoWork/chats/2026-09-16/new-chat-1/agent-mgmt-interaction/proto/index.html`,
including its per-point interactions (card grid, unified tabbed drawer,
enable/disable + delete confirms, draft protection, duplicate-name warning,
loading/empty/no-result/error states).

## Scope (decided with the user)

- **Admin SPA only.** The prototype's desktop (Electron) side is **out of
  scope** — it is already ~75% built by a prior feature and is not touched.
- **No demo shell.** The prototype's floating 演示控制台 (app/role/network
  switcher), the simulated network-failure mode, and the "使用模板" button are
  **not** implemented. Real error states (load error, no-result) are driven by
  the real request/query outcomes, not a fake switch.
- **Add `aboutYou`** (a new field the prototype's 关于你 tab needs) via a new
  migration.
- **Keep the app's existing color tokens** (`--accent-primary`, etc.), not the
  prototype's own palette (`#2563eb`). Geometry (spacing, radii, grid columns,
  drawer width, chip/switch styles) follows the prototype.
- **Icon + color picker kept** (backward-compatible: a URL icon still renders
  as an image; a new `icon_color` column stores the tint index for the
  glyph-based picker).

## Non-goals

- Desktop/Electron changes (sync, prefs, read-only panel, kebab).
- A real "模板" (template) feature.
- Forking a second design-token palette app-wide.
- Broad refactors of unrelated files.

## Current state (starting point)

- SPA page: `web/src/pages/AgentManagePage.tsx` (owns the query, drawer
  open-state, delete/disable confirm, search text) + `web/src/pages/agentManage/`
  (`AgentCard.tsx`, `AgentCardGrid.tsx`, `CreateAgentForm.tsx`,
  `DetailDrawer.tsx`, `fields.tsx`, `types.ts`).
- The current create/edit surfaces are a **flat** form (`CreateAgentForm`) and
  a **flat** drawer (`DetailDrawer`) — this design **replaces both** with one
  tabbed drawer.
- Server: `src/routes/agentMarketplaceAdmin.ts` (CRUD + references),
  `src/routes/agentMarketplace.ts` (public catalog + role-options),
  `src/models/agentMarketplaceView.ts` (`AGENT_COLUMNS`, `AgentRow`,
  `AgentMarketplaceView`, `mapAgent`).
- Migration 025 (`src/db/migrations/025_agent_marketplace.sql`) created the
  `agent_marketplace_agents` table. **Next migration number: 026.**
- House components to reuse: `web/src/components/Switch.tsx` (`checked`,
  `onChange`, `label`, `disabled`, `className`),
  `web/src/components/ConfirmDialog.tsx` (`open`, `title`, `message`,
  `confirmLabel`, `cancelLabel`, `destructive`, `onConfirm`, `onCancel`),
  `web/src/components/toastStore.ts` (`useToast()` → `{ success, error, info }`),
  `web/src/lib/autoIcon.ts` (`autoIcon(seed): string`).
- SPA i18n: flat keys in `web/src/i18n.ts` (`en` block ~lines 1-450, `zh` block
  ~lines 451+); existing `agentmgmt.*` and `common.*` keys listed below.
- Model catalog: `web/src/api/models.ts` → `modelsApi.list(orgId)` returns
  `ModelView[]` (`id`, `provider`, `model`, `display_name`, `enabled`,
  `disabled_by_admin`, …). `orgId` is sourced as
  `const { claims } = useAuth(); const orgId = claims?.orgId ?? 'default-org'`.
- SPA API client: `web/src/api/agentMarketplace.ts` (`AgentMarketplaceItem`,
  `AgentInput`, `AgentPatch`, `agentMarketplaceApi`).

---

## 1. Server — `aboutYou` + `icon_color` (migration 026)

**Migration** `src/db/migrations/026_agent_marketplace_about.sql` adds **both**
new columns in one file:

```sql
-- v1
-- Add `about_you` (the "关于你" field) and `icon_color` (the tint index for
-- the glyph/color picker) to the agent catalog.
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS about_you  TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS icon_color SMALLINT NOT NULL DEFAULT 0;
```

Both idempotent (`IF NOT EXISTS`) so pglite test replay is safe — matches the
`008_setup_completion.sql` pattern.

**View module** `src/models/agentMarketplaceView.ts`:
- Add `about_you` and `icon_color` to `AGENT_COLUMNS`.
- Add `about_you: string;` / `icon_color: number;` to `AgentRow` and
  `aboutYou: string;` / `iconColor: number;` to `AgentMarketplaceView`.
- In `mapAgent`, map `aboutYou: row.about_you ?? ''` and
  `iconColor: row.icon_color ?? 0`.

**Admin route** `src/routes/agentMarketplaceAdmin.ts`:
- Create schema: add `about_you: z.string().optional().default('')`.
- Create INSERT: add the column + param.
- Patch: `agentPatchSchema` is `.partial()` so it inherits the field; add
  `if (b.about_you !== undefined) push('about_you', b.about_you);` to the PUT
  handler.

The **public catalog** route and the **desktop** flow read through the same
`AGENT_COLUMNS` / `mapAgent`, so `aboutYou` propagates automatically — no
further server change.

## 2. SPA API type

`web/src/api/agentMarketplace.ts`:
- `AgentMarketplaceItem`: add `aboutYou: string` and `iconColor: number`.
- `AgentInput`: add `about_you?: string` and `icon_color?: number`.

(Server `mapAgent` also returns `iconColor` from a new `icon_color` column —
see §6; the SPA type mirrors it.)

## 3. Page shell — states, search, card grid

`AgentManagePage.tsx` remains the owner of: the agents query, the skills /
role-options / model-catalog queries, drawer open-state, delete-confirm,
disable-confirm popover state, and the search text.

**Header** (unchanged in spirit): title `智能体管理` + `共 {n} 个智能体` on the
left; a search box (magnifier icon, debounced input, clear ×) + blue
`+ 新增智能体` button on the right.

**Card grid** (`AgentCardGrid` / `AgentCard`):
- 3-column responsive grid (`grid-cols-1 md:grid-cols-2 xl:grid-cols-3`), 14px
  gap.
- Each card: colored icon tile (glyph via a new `agentIcon(icon, color)` or the
  URL image), bold name, a real on/off `Switch` (top-right), 2-line
  description, a row of pill count-chips (model · `角色 N` · `技能 N` ·
  `子代理 N`, plus a `已禁用` chip when off), a divider, and a footer with a
  right-aligned `删除` (trash) button.
- **The whole card is clickable → opens the drawer** (the drawer serves detail
  *and* edit; there are no 详情/编辑 text links). A disabled card is dimmed
  (`opacity-[0.62]`).
- Footer actions are `button`s nested for accessibility — the card's click
  handler is on the card container; the `删除` button stops propagation.

**Search**: 300 ms debounce on name+description (case-insensitive). Empty
query shows all. A × clears the query.

**Page states** (driven by the real query lifecycle — no fake switch):
- **Skeleton** while `agentsQuery.isPending`: 6 shimmer cards in the grid.
- **Empty** (`agents.length === 0`, no search): "还没有企业智能体" + 3-step
  guide (创建并配置 / 选择可见角色 / 桌面端自动镜像) + the "仅 agent_admin 可管理"
  note.
- **No-result** (search yields 0): "未找到「{q}」相关的智能体" + 清除搜索.
- **Error** (`agentsQuery.isError`): "加载失败 / 无法连接 enterprise_server，
  请检查网络后重试" + 重试 (refetch). A `403` from the list resolves to the
  "无权访问" variant (only `agent_admin` manages agents); the existing route
  `AuthGuard requires="agent_admin"` already blocks the non-admin case at the
  router level, so the in-page 403 branch is a defensive fallback.

## 4. Unified tabbed drawer (the core)

One `AgentDrawer` component replaces both `CreateAgentForm` and
`DetailDrawer`. Create and edit share it (edit pre-fills the draft from the
agent). Files under `web/src/pages/agentManage/drawer/`:

- `AgentDrawer.tsx` — the 680px drawer: header, tab bar, active tab body,
  footer; owns the draft object and save/discard/validate logic.
- `drawerForm.ts` — the draft type + initializers (create / from-agent) +
  validation + dirty tracking.
- `IconColorPicker.tsx` — the tile + popover (glyph grid + 8-color palette).
- `ModelSelect.tsx` — the footer model dropdown (grouped, from the catalog).
- `SkillPicker.tsx` — the 技能 tab (searchable card rows with checkboxes).
- `SubagentPicker.tsx` — the 协作 tab (card rows + cycle detection).
- `RolesPicker.tsx` — the 可见范围 tab (chip multi-select, min 1).

**Header**: icon+color tile (click → `IconColorPicker` popover), inline
**name** input (max 32, required, blur-cleared error) and **desc** input
(max 120), a close ×.

**Tabs** (fixed order): `助手身份` / `助手性格` / `关于你` / `技能` / `协作` /
`IM 渠道` / `可见范围`.
- `助手身份` → markdown textarea → `identity`.
- `助手性格` → markdown textarea → `systemPrompt`.
- `关于你` → markdown textarea → `aboutYou`.
- `技能` → `SkillPicker`: a search input filters enabled skills; each skill is
  a clickable row with a name, a description, and a checkbox; info line
  "不选则使用所有已启用技能". Empty filter result → "无匹配技能".
- `协作` → `SubagentPicker`: "允许调用的 Agent" rows (all agents except the one
  being edited), each with a colored letter avatar, the agent id, and a
  checkbox. **Cycle detection**: a candidate whose
  `subagentAllowAgentIds` already contains the agent being edited is rendered
  disabled with a "成环" note (selecting it would create a reference cycle).
- `IM 渠道` → a static informational note: 企业智能体由服务端统一发布，不绑定
  IM 渠道（企业智能体不使用 IM 机器人）.
- `可见范围` → `RolesPicker`: chips of the selected roles (each removable via ×)
  + an add popover listing remaining role options; **min 1** enforced on
  save (removing the last role flags an error).

**Footer**: `ModelSelect` (left), a `思考` segmented control — three options
`低` / `标准` / `高` mapped to the canonical `ModelThinkingLevel` values
`low` / `medium` / `high` (stored in `thinking_level`; any other stored value
renders the closest match and is kept as-is) — and an `启用` `Switch`
(`enabled`), then 取消 / `创建智能体` or `保存` on the right.

**ModelSelect data source**: the org's enabled models via
`modelsApi.list(orgId)` (filter to `enabled === true && !disabled_by_admin`),
grouped; the value is the model's `id` string (what the `model` field stores).
If the catalog fails to load, fall back to a free-text input (the current
`providerId/modelId` placeholder). The prototype's "desktop-model 回退" warning
is **dropped** (desktop is out of scope).

**Draft + save**:
- The drawer keeps a single `draft` object; `dirty` is true when any field
  differs from the initial snapshot (edit) or is non-empty (create).
- Save validates: `name` non-empty, `roles.length >= 1`. On failure, sets field
  errors and does not submit. On success the button shows `保存中…`; create
  calls `agentMarketplaceApi.createAgent`, edit calls `update` (a full patch
  including `about_you` and `icon_color`).
- After a create, the new card **flashes** (a transient highlight class for
  ~2.2s, keyed off a `flashId` state in the page).
- Errors from the API surface via `toast.error(message)`.

## 5. Interactions (enable/disable, delete, draft protection, duplicate)

- **Enable/disable** (from the card `Switch`):
  - **Enable** → optimistic `PUT { enabled: true }` (rollback on error) + a
    success toast.
  - **Disable** → a **light-confirm popover** anchored to the card ("禁用后
    桌面端将不再显示该智能体，确定禁用？" with 取消 / 确定禁用). Confirm →
    `PUT { enabled: false }`. (The page tracks which card's popover is open.)
- **Delete** (from the card footer or drawer):
  1. `agentMarketplaceApi.getReferences(id)`.
  2. `ConfirmDialog` (destructive): title `删除智能体「{name}」？`; message
     lists the referencing agents (names joined by 、) when present
     ("该智能体被 {n} 个智能体引用为子代理：…删除后将自动解除这些引用。") + the
     "删除不可恢复…" line.
  3. Confirm → `agentMarketplaceApi.remove(id)` → refetch; on success the card
     animates out (a transient `.removing` opacity/translate class, ~160 ms)
     then is removed from the list.
- **Draft protection**: if `dirty`, closing the drawer (× / mask click / 取消 /
  Esc) opens a `ConfirmDialog` "放弃未保存的更改？" (继续编辑 / 放弃). Confirmed
  abandon discards the draft and closes.
- **Duplicate name** (edit only, non-blocking): under the name field, a weak
  warning "已有同名智能体（{other}），仍可保存" when another agent shares the
  name (case-insensitive).
- **Esc key**: closes the innermost layer (popover → confirm modal → drawer).
  A confirm modal is not dismissed by an outside mask click (matches
  `ConfirmDialog` semantics).

## 6. Icon + color (uses the `icon_color` column from §1)

The prototype lets the admin pick a glyph (from a small set) and a tint.
- **Admin route** (`agentMarketplaceAdmin.ts`): create/patch accept
  `icon_color` (a number, `z.number().int().min(0).optional().default(0)`).
- **SPA**: `AgentInput.icon_color?: number`; `AgentMarketplaceItem.iconColor`.
- **Rendering rule** (one place, reused by card + drawer + tile):
  - if `icon` is a non-empty URL (starts with `http`/`https`/`data:`) → render
    the `<img>` (existing behavior preserved);
  - otherwise render a glyph from `AGENT_GLYPHS` (a small name → lucide icon
    map) tinted by `AGENT_COLORS[iconColor]` on a soft background. `autoIcon`
    is the fallback when `icon` is empty and no glyph matches.
- **Picker** (`IconColorPicker`): an 8-color palette + glyph grid. Choosing a
  glyph writes its name to `icon` and the palette index to `iconColor`.

## 7. i18n

All new user-visible strings get **both `en` and `zh`** entries in
`web/src/i18n.ts` (flat `agentmgmt.*` keys). New keys (additive; existing keys
reused where present): `aboutYou`, the 7 tab labels, `skills.hint`,
`skills.search`, `skills.empty`, `subs.title`, `subs.hint`, `subs.cycle`,
`im.note`, `roles.hint`, `roles.min`, `roles.add`, `model.fallbackHint`,
`thinking.low/standard/high`, `discard.title`, `discard.body`, `dup.name`,
`disable.popover`, `delete.unrecoverable`, `delete.refNames`,
`noResult.title`, `noResult.clear`, `loadError.title`, `loadError.body`,
`retry`, `noAccess.title`, `noAccess.body`, `empty.hint`, `empty.steps.*`,
`saveSaving`. Both `common.save/cancel/delete/close` already exist.

## 8. Testing (Vitest)

Extend `web/tests/pages/AgentManagePage.test.tsx` (seed `fetchMock`) and add a
`web/tests/pages/agentManage/` suite. Cover at minimum:
- Card chips + count; disabled card dim + `已禁用` chip.
- Click card opens the drawer (create via `+ 新增智能体`; edit via card click).
- Enable (direct PUT) vs disable (popover → confirm → PUT `{enabled:false}`).
- Delete → `GET /references` → confirm → `DELETE`; reference list in the
  dialog when references exist.
- Tab switching renders the right body (身份/性格/关于你 textareas, 技能 rows,
  协作 rows, IM note, 可见范围 chips).
- 技能 row toggle updates the draft; 技能 search filters.
- **Subagent cycle detection**: editing agent A, candidate B (which references
  A) is disabled with the 成环 note and not selectable.
- 可见范围 min-1: removing the last role flags an error; save is blocked.
- Name required: empty name blocks save with an error.
- **Dirty → discard modal**: change a field, then close → discard confirm
  appears; 继续编辑 keeps the drawer.
- Create = `POST` (body includes `about_you`, `icon_color`); edit = `PUT`.
- Search: debounce filters the grid; no-result state; × clears.
- Skeleton (pending), empty (0 agents), and error (query reject) states.

## 9. Quality gates (per CLAUDE.md)

- Every touched `.ts/.tsx` file passes
  `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- `npm test` (SPA) and the server `npm test` stay green; tsc has no new errors.
- No hardcoded user-visible strings; all new copy in `en` + `zh`.
- Keep changes scoped; do not bloat large files (the drawer is deliberately
  split into small files under `pages/agentManage/drawer/`).

## Verification

- Server: run the 026 migration against a pglite/Postgres and confirm the new
  columns are present and `mapAgent` returns `aboutYou`/`iconColor`.
- SPA: `npm run web:dev`; with `agent_admin`, open 智能体管理; with 1+ agents in
  `agent_marketplace_agents`, confirm the grid, the tabbed drawer, enable/
  disable confirm, delete confirm with references, draft discard, and the
  no-result/empty states match the prototype.
