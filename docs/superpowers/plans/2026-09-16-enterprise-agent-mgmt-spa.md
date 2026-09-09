# Enterprise Agent Management (Admin SPA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the enterprise_server admin SPA's 智能体管理 page to pixel-match the prototype: card grid with real page states, a unified 7-tab drawer, and per-point interactions (enable/disable + delete confirms, draft protection, duplicate-name warning).

**Architecture:** A new `about_you` + `icon_color` column on `agent_marketplace_agents` (migration 026) flows through the shared view module to both the admin and public routes. The SPA replaces the flat `CreateAgentForm` + `DetailDrawer` with one tabbed `AgentDrawer` built from small files under `pages/agentManage/drawer/`, driven by a single draft object. `AgentManagePage` stays the owner of queries, drawer state, and confirmations.

**Tech Stack:** Server: Hono + pg/pglite + Zod (Vitest `tests/**/*.test.ts`). SPA: React 19 + TanStack Query v5 + Tailwind v4 + `lucide-react` (Vitest + @testing-library/react, `tests/**/*.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-09-16-enterprise-agent-mgmt-spa-design.md`

## Global Constraints

- **Repo root is `enterprise_server/`.** Server commands run from `enterprise_server/`; SPA commands run from `enterprise_server/web/`.
- Every touched `.ts/.tsx` file passes `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- All new user-visible strings go in **both** `en` and `zh` in `web/src/i18n.ts` (flat `agentmgmt.*` / `common.*` keys). No hardcoded UI strings.
- i18n `t(key)` has **no interpolation** — use the `fill(s, kv)` helper from `web/src/pages/agentManage/types.ts` for `{n}`/`{name}`/`{q}` substitution.
- Styling uses the app's CSS-variable utilities (e.g. `bg-[var(--bg-secondary)]`, `text-[var(--text-secondary)]`, `border-[var(--border-default)]`, `text-[var(--accent-primary)]`) — never bare `bg-surface`/`text-muted` (those are aliased via `@theme` in `web/src/index.css`, but arbitrary-value utilities are the house pattern for new code).
- Reuse house components: `Switch` (`checked,onChange,label,disabled,className`), `ConfirmDialog` (`open,title,message,confirmLabel?,cancelLabel?,destructive?,onConfirm,onCancel`), `useToast()` → `{ success, error, info }`, `autoIcon(seed)`.
- `orgId` in the SPA: `const { claims } = useAuth(); const orgId = claims?.orgId ?? 'default-org';`
- `thinking_level` stores canonical `ModelThinkingLevel` values: segment `低/标准/高` → `low/medium/high`.
- Server route tests mint a `super_admin` token (short-circuits `requirePermission(PermissionCode.AgentsManage)`); run `resetSchema()` + `runMigrations()` in `beforeEach`.
- Keep changes scoped; do not bloat large files (the drawer is split into small files).
- **Gate tsc on no-new-errors**, not whole-repo legacy errors.

---

### Task 1: Server — migration 026 + view module + admin route (about_you, icon_color)

**Files:**
- Create: `src/db/migrations/026_agent_marketplace_about.sql`
- Modify: `src/models/agentMarketplaceView.ts`
- Modify: `src/routes/agentMarketplaceAdmin.ts`
- Test: `tests/models/agentMarketplaceView.test.ts`, Create `tests/routes/agentMarketplaceAdmin.test.ts`

**Interfaces:**
- Produces: `AgentRow`/`AgentMarketplaceView` now include `aboutYou: string` and `iconColor: number`; `AGENT_COLUMNS` includes `about_you`, `icon_color`. POST/PUT accept `about_you?` and `icon_color?`.

- [ ] **Step 1: Write the failing view tests**

Append to `tests/models/agentMarketplaceView.test.ts` (import unchanged):

```ts
test('mapAgent maps about_you and icon_color, defaulting missing values', () => {
  const v = mapAgent({
    agent_id: 'a', name: 'A', description: '', identity: '', system_prompt: '',
    model: '', thinking_level: '', icon: '',
    skill_ids: null, subagent_allow_agent_ids: null,
    allowed_roles: ['org_admin'], enabled: true,
    about_you: '我叫王经理', icon_color: 3,
  });
  expect(v.aboutYou).toBe('我叫王经理');
  expect(v.iconColor).toBe(3);
});

test('AGENT_COLUMNS includes about_you and icon_color', () => {
  const cols = AGENT_COLUMNS.split(',').map(s => s.trim());
  expect(cols).toContain('about_you');
  expect(cols).toContain('icon_color');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/models/agentMarketplaceView.test.ts`
Expected: FAIL — `aboutYou`/`iconColor` undefined; `about_you` not in columns.

- [ ] **Step 3: Create migration 026**

`src/db/migrations/026_agent_marketplace_about.sql`:

```sql
-- v1
-- Add `about_you` (the "关于你" field) and `icon_color` (the tint index for
-- the glyph/color picker) to the agent catalog.
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS about_you  TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS icon_color SMALLINT NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Update the view module**

In `src/models/agentMarketplaceView.ts`, add `about_you, icon_color` to `AGENT_COLUMNS`; add `about_you: string;` and `icon_color: number;` to `AgentRow`; add `aboutYou: string;` and `iconColor: number;` to `AgentMarketplaceView`; in `mapAgent` add `aboutYou: row.about_you ?? ''` and `iconColor: row.icon_color ?? 0`. Update the two existing `toEqual`/`mapAgent` calls in the test file's other two tests by adding `aboutYou: ''` and `iconColor: 0` to the expected wire object and `about_you: ''` / `icon_color: 0` to any row literal (the null-tolerance test omits them — `?? ''`/`?? 0` still applies, so only the full `toEqual` test needs the two new keys added to the expected object).

- [ ] **Step 5: Run the view test**

Run: `npx vitest run tests/models/agentMarketplaceView.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Write the failing admin-route tests**

Create `tests/routes/agentMarketplaceAdmin.test.ts`:

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
import { agentMarketplaceAdminRoutes } from '../../src/routes/agentMarketplaceAdmin';

const app = new Hono();
app.route('/', agentMarketplaceAdminRoutes);

const admin = async () => ({ authorization: `Bearer ${await signToken({ sub: 'a', orgId: 'o1', roles: ['super_admin'] })}` });

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('POST /api/admin/agent-marketplace/agents', () => {
  test('persists about_you and icon_color', async () => {
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await admin()) },
      body: JSON.stringify({ name: 'N', allowed_roles: ['org_admin'], about_you: 'hi', icon_color: 2 }),
    });
    expect(res.status).toBe(200);
    const { rows } = await testPool.query<{ about_you: string; icon_color: number }>(
      'SELECT about_you, icon_color FROM agent_marketplace_agents WHERE name = $1', ['N']);
    expect(rows[0].about_you).toBe('hi');
    expect(rows[0].icon_color).toBe(2);
  });

  test('PUT partial update sets about_you', async () => {
    await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await admin()) },
      body: JSON.stringify({ name: 'N', allowed_roles: ['org_admin'] }),
    });
    const row = (await testPool.query<{ agent_id: string }>('SELECT agent_id FROM agent_marketplace_agents')).rows[0];
    const res = await app.request(`/api/admin/agent-marketplace/agents/${row.agent_id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...(await admin()) },
      body: JSON.stringify({ about_you: 'updated', icon_color: 5 }),
    });
    expect(res.status).toBe(204);
    const after = (await testPool.query<{ about_you: string; icon_color: number }>(
      'SELECT about_you, icon_color FROM agent_marketplace_agents')).rows[0];
    expect(after.about_you).toBe('updated');
    expect(after.icon_color).toBe(5);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run tests/routes/agentMarketplaceAdmin.test.ts`
Expected: FAIL — `about_you`/`icon_color` not in schema/INSERT/PUT.

- [ ] **Step 8: Update the admin route**

In `src/routes/agentMarketplaceAdmin.ts`:
- Create schema: add `about_you: z.string().optional().default('')` and `icon_color: z.number().int().min(0).optional().default(0)`.
- POST INSERT: add `about_you, icon_color` columns and `$13, $14` params (push `b.about_you`, `b.icon_color`).
- PUT: add `if (b.about_you !== undefined) push('about_you', b.about_you);` and `if (b.icon_color !== undefined) push('icon_color', b.icon_color);`.

- [ ] **Step 9: Run admin-route test + view test**

Run: `npx vitest run tests/routes/agentMarketplaceAdmin.test.ts tests/models/agentMarketplaceView.test.ts`
Expected: PASS.

- [ ] **Step 10: Lint touched server files**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/models/agentMarketplaceView.ts src/routes/agentMarketplaceAdmin.ts tests/models/agentMarketplaceView.test.ts tests/routes/agentMarketplaceAdmin.test.ts`
Expected: no output (clean).

- [ ] **Step 11: Commit**

```bash
git add src/db/migrations/026_agent_marketplace_about.sql src/models/agentMarketplaceView.ts src/routes/agentMarketplaceAdmin.ts tests/models/agentMarketplaceView.test.ts tests/routes/agentMarketplaceAdmin.test.ts
git commit -m "feat(enterprise_server): add about_you and icon_color to agent catalog"
```

---

### Task 2: SPA — API types + i18n keys

**Files:**
- Modify: `web/src/api/agentMarketplace.ts`
- Modify: `web/src/i18n.ts`

**Interfaces:**
- Produces: `AgentMarketplaceItem.aboutYou: string`, `.iconColor: number`; `AgentInput.about_you?: string`, `.icon_color?: number`. New `agentmgmt.*` keys listed below (en + zh).

- [ ] **Step 1: Extend the SPA API types**

In `web/src/api/agentMarketplace.ts`, add to `AgentMarketplaceItem`: `aboutYou: string;` and `iconColor: number;`. Add to `AgentInput`: `about_you?: string;` and `icon_color?: number;`. (`AgentPatch` inherits via `Partial`.)

- [ ] **Step 2: Add i18n keys (en block, after existing `agentmgmt.*` keys ~line 76)**

```ts
  'agentmgmt.aboutYou': 'About you (markdown)',
  'agentmgmt.tab.identity': 'Identity',
  'agentmgmt.tab.persona': 'Persona',
  'agentmgmt.tab.about': 'About you',
  'agentmgmt.tab.skills': 'Skills',
  'agentmgmt.tab.subs': 'Collaboration',
  'agentmgmt.tab.im': 'IM channels',
  'agentmgmt.tab.roles': 'Visible roles',
  'agentmgmt.skills.hint': 'Pick the skills this agent can use. If none are selected, all enabled skills are used.',
  'agentmgmt.skills.search': 'Search skills…',
  'agentmgmt.skills.empty': 'No matching skills',
  'agentmgmt.subs.title': 'Agents allowed to be called',
  'agentmgmt.subs.hint': 'Once selected, this agent can hand tasks to these agents.',
  'agentmgmt.subs.cycle': 'Cycle',
  'agentmgmt.im.note': 'Enterprise agents are published by the server and do not bind IM channels. Use a local custom agent for IM bots.',
  'agentmgmt.roles.hint': 'Desktop users with these roles will see this agent. Select at least 1.',
  'agentmgmt.roles.min': 'Select at least one role',
  'agentmgmt.roles.add': 'Add role',
  'agentmgmt.model.fallback': 'Model not available — free entry',
  'agentmgmt.thinking.low': 'Low',
  'agentmgmt.thinking.standard': 'Standard',
  'agentmgmt.thinking.high': 'High',
  'agentmgmt.discard.title': 'Discard unsaved changes?',
  'agentmgmt.discard.body': 'The form has unsaved changes that will be lost if you leave.',
  'agentmgmt.discard.stay': 'Keep editing',
  'agentmgmt.discard.discard': 'Discard',
  'agentmgmt.dup.name': 'An agent named “{name}” already exists (you can still save).',
  'agentmgmt.nameRequired': 'Name is required',
  'agentmgmt.disable.popover': 'Disabling hides this agent on desktop. Disable it?',
  'agentmgmt.disable.confirm': 'Disable',
  'agentmgmt.delete.unrecoverable': 'This cannot be undone. Desktop users who can see it will see it removed on their next refresh.',
  'agentmgmt.delete.refNames': 'It is referenced as a subagent by {n} agent(s): {names}. Deleting clears those references.',
  'agentmgmt.noResult.title': 'No agents matching “{q}”',
  'agentmgmt.noResult.clear': 'Clear search',
  'agentmgmt.loadError.title': 'Failed to load',
  'agentmgmt.loadError.body': 'Could not reach enterprise_server. Check your network and retry.',
  'agentmgmt.retry': 'Retry',
  'agentmgmt.noAccess.title': 'You do not have access to agent management',
  'agentmgmt.noAccess.body': 'Only the agent_admin role can manage enterprise agents. Contact your org admin to be granted the role.',
  'agentmgmt.empty.hint': 'Once created, desktop users with matching roles will see it under “My Agents” automatically — no install needed.',
  'agentmgmt.empty.step1': 'Create & configure (identity / prompt / model / skills)',
  'agentmgmt.empty.step2': 'Pick visible roles (allowed_roles)',
  'agentmgmt.empty.step3': 'Desktop mirrors it automatically (read-only)',
  'agentmgmt.empty.note': 'Only agent_admin can manage agents. To create one, ask an org admin to grant you that role.',
  'agentmgmt.saveSaving': 'Saving…',
```

- [ ] **Step 3: Add the matching zh keys (zh block, after existing `agentmgmt.*` ~line 515)**

```ts
  'agentmgmt.aboutYou': '关于你（Markdown）',
  'agentmgmt.tab.identity': '助手身份',
  'agentmgmt.tab.persona': '助手性格',
  'agentmgmt.tab.about': '关于你',
  'agentmgmt.tab.skills': '技能',
  'agentmgmt.tab.subs': '协作',
  'agentmgmt.tab.im': 'IM 渠道',
  'agentmgmt.tab.roles': '可见范围',
  'agentmgmt.skills.hint': '选择该智能体可使用的技能。不选则使用所有已启用技能。',
  'agentmgmt.skills.search': '搜索技能…',
  'agentmgmt.skills.empty': '无匹配技能',
  'agentmgmt.subs.title': '允许调用的 Agent',
  'agentmgmt.subs.hint': '选中后，当前 Agent 可以把任务交给这些 Agent 协助完成。',
  'agentmgmt.subs.cycle': '成环',
  'agentmgmt.im.note': '企业智能体由服务端统一发布，不绑定 IM 渠道。如需 IM 机器人，请使用本地自定义智能体。',
  'agentmgmt.roles.hint': '拥有以下角色的桌面用户将看到该智能体。至少选择 1 个。',
  'agentmgmt.roles.min': '至少选择一个角色',
  'agentmgmt.roles.add': '添加角色',
  'agentmgmt.model.fallback': '该模型不可用，可自由填写',
  'agentmgmt.thinking.low': '低',
  'agentmgmt.thinking.standard': '标准',
  'agentmgmt.thinking.high': '高',
  'agentmgmt.discard.title': '放弃未保存的更改？',
  'agentmgmt.discard.body': '当前表单有未保存的修改，离开后修改将丢失。',
  'agentmgmt.discard.stay': '继续编辑',
  'agentmgmt.discard.discard': '放弃',
  'agentmgmt.dup.name': '已有同名智能体（{name}），仍可保存。',
  'agentmgmt.nameRequired': '名称不能为空',
  'agentmgmt.disable.popover': '禁用后桌面端将不再显示该智能体，确定禁用？',
  'agentmgmt.disable.confirm': '确定禁用',
  'agentmgmt.delete.unrecoverable': '删除不可恢复。桌面端中可见该智能体的用户将在下次刷新时看到它被移除。',
  'agentmgmt.delete.refNames': '该智能体被 {n} 个智能体引用为子代理：{names}。删除后将自动解除这些引用。',
  'agentmgmt.noResult.title': '未找到「{q}」相关的智能体',
  'agentmgmt.noResult.clear': '清除搜索',
  'agentmgmt.loadError.title': '加载失败',
  'agentmgmt.loadError.body': '无法连接 enterprise_server，请检查网络后重试。',
  'agentmgmt.retry': '重试',
  'agentmgmt.noAccess.title': '你无权访问智能体管理',
  'agentmgmt.noAccess.body': '仅 agent_admin 角色可管理企业智能体。如需创建，请联系组织管理员为你授予该角色。',
  'agentmgmt.empty.hint': '创建后，拥有匹配角色的桌面用户将自动在「我的 Agent」中看到它，无需安装。',
  'agentmgmt.empty.step1': '创建并配置（身份 / 提示词 / 模型 / 技能）',
  'agentmgmt.empty.step2': '选择可见角色 allowed_roles',
  'agentmgmt.empty.step3': '桌面端自动镜像（只读）',
  'agentmgmt.empty.note': '仅 agent_admin 可管理智能体。如需创建，请联系组织管理员为你授予该角色。',
  'agentmgmt.saveSaving': '保存中…',
```

- [ ] **Step 4: Lint + typecheck**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/api/agentMarketplace.ts src/i18n.ts && npx tsc --noEmit -p tsconfig.json 2>&1 | rg "agentMarketplace|error TS" | head`
Expected: eslint clean; tsc shows no new errors referencing the touched files (existing legacy errors, if any, are pre-existing).

- [ ] **Step 5: Commit**

```bash
git add web/src/api/agentMarketplace.ts web/src/i18n.ts
git commit -m "feat(enterprise_web): add agent aboutYou/icon_color types and i18n keys"
```

---

### Task 3: SPA — glyph/color tile module

**Files:**
- Create: `web/src/pages/agentManage/agentTile.ts`
- Test: `web/tests/pages/agentManage/agentTile.test.ts`

**Interfaces:**
- Produces: `AGENT_GLYPHS: Array<string>` (glyph names), `AGENT_COLORS: string[]` (8 hex), `isUrlIcon(icon: string): boolean`, `tileClass(iconColor: number): string` (returns `bg-[…] text-[…]` Tailwind arbitrary classes for the tile).

- [ ] **Step 1: Write the failing test**

Create `web/tests/pages/agentManage/agentTile.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { AGENT_COLORS, AGENT_GLYPHS, isUrlIcon, tileClass } from '../../../src/pages/agentManage/agentTile';

describe('agentTile', () => {
  test('has 8 colors and at least 5 glyphs', () => {
    expect(AGENT_COLORS).toHaveLength(8);
    expect(AGENT_GLYPHS.length).toBeGreaterThanOrEqual(5);
  });
  test('isUrlIcon detects http/https/data URLs only', () => {
    expect(isUrlIcon('https://x/y.png')).toBe(true);
    expect(isUrlIcon('data:image/png;base64,AA')).toBe(true);
    expect(isUrlIcon('bot')).toBe(false);
    expect(isUrlIcon('')).toBe(false);
  });
  test('tileClass wraps out-of-range indices into the palette', () => {
    expect(tileClass(9)).toBe(tileClass(9 % 8));
    expect(tileClass(0)).toContain('bg-[');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/agentManage/agentTile.test.ts --config vitest.config.ts` (from `web/`)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `web/src/pages/agentManage/agentTile.ts`:

```ts
/** Glyph names offered by the icon picker. Each maps to a lucide icon in the
 *  tile renderer. Matches the prototype's small glyph set. */
export const AGENT_GLYPHS: string[] = ['bot', 'chart', 'doc', 'code', 'meg', 'mic', 'globe', 'spark'];

/** 8-tint palette for the tile (app tokens where they exist, else the
 *  prototype's hues). Indexed by `icon_color`. */
export const AGENT_COLORS: string[] = [
  '#2563eb', '#0f766e', '#b45309', '#7c3aed', '#dc2626', '#0ea5e9', '#16a34a', '#db2777',
];

export function isUrlIcon(icon: string): boolean {
  return /^(https?:|data:)/i.test(icon);
}

/** Arbitrary-value Tailwind classes for a tinted tile at `iconColor`. */
export function tileClass(iconColor: number): string {
  const c = AGENT_COLORS[((iconColor % AGENT_COLORS.length) + AGENT_COLORS.length) % AGENT_COLORS.length];
  return `bg-[${c}]1a text-[${c}]`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/pages/agentManage/agentTile.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/agentTile.ts tests/pages/agentManage/agentTile.test.ts`

```bash
git add web/src/pages/agentManage/agentTile.ts web/tests/pages/agentManage/agentTile.test.ts
git commit -m "feat(enterprise_web): add agent icon tile palette + glyph helpers"
```

---

### Task 4: SPA — re-style the card + grid (chips, dim, clickable, delete-only footer)

**Files:**
- Modify: `web/src/pages/agentManage/AgentCard.tsx`
- Modify: `web/src/pages/agentManage/AgentCardGrid.tsx`
- Test: `web/tests/pages/AgentManagePage.test.tsx`

**Interfaces:**
- Consumes: `AgentMarketplaceItem` (now with `aboutYou`, `iconColor`), `tileClass`, `isUrlIcon`, `AGENT_GLYPHS`.
- Produces: `AgentCard` props unchanged (`agent, onToggle, onOpen, onDelete`). The card is clickable (calls `onOpen`); `删除` button stops propagation; disabled card dims.

- [ ] **Step 1: Update the card tests**

In `web/tests/pages/AgentManagePage.test.tsx`:

First, extend the `reviewerAgent(over)` default object to include the two now-required fields so the `AgentMarketplaceItem` literals typecheck: add `aboutYou: ''` and `iconColor: 0` to its returned object (before the `...over` spread).

Then, **replace** the two existing tests `'detail button opens the drawer'` and `'edit button opens the drawer (same editable surface as details)'` with the two tests below. They both queried the `详情`/`编辑` buttons, which the new delete-only footer removes; they covered the same open-drawer path, now exercised by clicking the card. (Do not leave the old tests in place — they would fail because those buttons are gone.)

```ts
test('the card is clickable and opens the drawer', async () => {
  seedAgents([reviewerAgent()]);
  renderPage();
  const card = (await screen.findByText('Reviewer')).closest('[data-testid="agent-card"]') as HTMLElement;
  fireEvent.click(card);
  // At this stage the page still uses the legacy drawer, which renders the
  // 思考等级 field; Task 6 swaps in the tabbed AgentDrawer and updates this
  // assertion to 助手身份.
  expect(await screen.findByText('思考等级')).toBeInTheDocument();
});

test('a disabled card is dimmed and carries the agent-card testid', async () => {
  seedAgents([reviewerAgent({ enabled: false })]);
  renderPage();
  const chip = await screen.findByText('已禁用');
  const card = chip.closest('[data-testid="agent-card"]') as HTMLElement;
  expect(card).not.toBeNull();
  expect(card.className).toContain('opacity-');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/AgentManagePage.test.tsx`
Expected: the two new tests FAIL (no `agent-card` testid / not yet clickable / not dimmed); the old `详情`/`编辑` tests are already removed.

- [ ] **Step 3: Rewrite AgentCard.tsx**

Rewrite `web/src/pages/agentManage/AgentCard.tsx` to: root `<div data-testid="agent-card" onClick={() => onOpen(agent)} className="group cursor-pointer ... ${disabled ? 'opacity-[0.62]' : ''}">`; icon tile uses `tileClass(agent.iconColor)` and renders an `<img>` when `isUrlIcon(agent.icon)` else a glyph (map `agent.icon` → a lucide icon via a local `GLYPH_ICON` record, else `autoIcon(agent.name)`); bold name; a `Switch` wrapped in a `span onClick={e => e.stopPropagation()}` so toggling does NOT open the drawer; 2-line description; chips (model · 角色 N · 技能 N · 子代理 N, + `已禁用` when off) using the existing `fill(t(...))` chips; **footer with ONLY a right-aligned `删除` button** (remove the `详情` and `编辑` buttons) that calls `e.stopPropagation(); onDelete(agent)`. Import `Switch`, `autoIcon`, `tileClass`/`isUrlIcon`, `Trash2` from `lucide-react` as needed. Keep the existing count-chip labels (`agentmgmt.rolesCount` etc.).

- [ ] **Step 4: Update AgentCardGrid.tsx**

Ensure the empty state uses `t('agentmgmt.empty')` and the grid is `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5`. (Grid passes the same `onToggle/onOpen/onDelete`.)

- [ ] **Step 5: Run the page tests**

Run: `npx vitest run tests/pages/AgentManagePage.test.tsx`
Expected: PASS (old + new tests).

- [ ] **Step 6: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/AgentCard.tsx src/pages/agentManage/AgentCardGrid.tsx tests/pages/AgentManagePage.test.tsx`

```bash
git add web/src/pages/agentManage/AgentCard.tsx web/src/pages/agentManage/AgentCardGrid.tsx web/tests/pages/AgentManagePage.test.tsx
git commit -m "feat(enterprise_web): restyle agent card to match prototype"
```

---

### Task 5: SPA — page states + debounced search

**Files:**
- Modify: `web/src/pages/AgentManagePage.tsx`
- Test: `web/tests/pages/AgentManagePage.test.tsx`

**Interfaces:**
- Produces: renders skeleton (pending), empty, no-result, error (with retry), and 403 variants. Search debounced 300 ms with a clear button.

- [ ] **Step 1: Write failing tests**

In `web/tests/pages/AgentManagePage.test.tsx`:

```ts
test('shows a no-result state when the search matches nothing', async () => {
  seedAgents([reviewerAgent()]);
  renderPage();
  const input = (await screen.findByRole('searchbox')) as HTMLInputElement; // or getByLabelText(t search)
  fireEvent.change(input, { target: { value: 'zzz-nope' } });
  await waitFor(() => expect(screen.getByText(/未找到/)).toBeInTheDocument());
});

test('shows the error state with a retry button when the list query fails', async () => {
  fetchMock.mockRejectedValueOnce(new Error('boom')); // first list call
  seedAgents([reviewerAgent()]); // restore after the rejected one (mockRejectedValueOnce only affects one call)
  renderPage();
  expect(await screen.findByText('加载失败')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
});
```

Note: give the search input `role="searchbox"` (or `aria-label={t('agentmgmt.search')}`) so it is queryable. If `mockRejectedValueOnce` is fragile with TanStack retries, disable retries for this render by passing `retry: false` in the `QueryClient` (the existing `renderPage` helper already sets `retry: false`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/AgentManagePage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement states + search in AgentManagePage.tsx**

- Add `const searchDebounce` via a `useEffect` on `search` that sets a 300 ms `setTimeout` committing to a `committedSearch` state; the grid filters on `committedSearch`.
- Wrap the body in: `agentsQuery.isPending` → 6-card skeleton (shimmer `<div>`s); `isError` → error state (`t('agentmgmt.loadError.title')` + `t('agentmgmt.loadError.body')` + a `重试` button calling `agentsQuery.refetch()`); a `403` status (inspect `(error as {status?:number}).status === 403`) → no-access state (`t('agentmgmt.noAccess.title')`/`.body`); `filtered.length === 0 && search` → no-result (`fill(t('agentmgmt.noResult.title'), {q: search})` + `t('agentmgmt.noResult.clear')`); `agents.length === 0` → empty state (`t('agentmgmt.empty')` + 3-step `t('agentmgmt.empty.step1..3')` + `t('agentmgmt.empty.note')`).
- The search input: `role="searchbox"`, `aria-label={t('agentmgmt.search')}`, a `Search` lucide icon, and a clear (×) button when non-empty that resets `search`/`committedSearch`.

- [ ] **Step 4: Run page tests**

Run: `npx vitest run tests/pages/AgentManagePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/AgentManagePage.tsx tests/pages/AgentManagePage.test.tsx`

```bash
git add web/src/pages/AgentManagePage.tsx web/tests/pages/AgentManagePage.test.tsx
git commit -m "feat(enterprise_web): agent page states (skeleton/empty/no-result/error) + debounced search"
```

---

### Task 6: SPA — drawer scaffold + draft model + footer (model select, thinking, enable)

**Files:**
- Create: `web/src/pages/agentManage/drawer/drawerForm.ts`
- Create: `web/src/pages/agentManage/drawer/AgentDrawer.tsx`
- Create: `web/src/pages/agentManage/drawer/ModelSelect.tsx`
- Modify: `web/src/pages/AgentManagePage.tsx` (open the drawer instead of `CreateAgentForm`/`DetailDrawer`)
- Test: `web/tests/pages/agentManage/AgentDrawer.test.tsx`

**Interfaces:**
- Produces:
  - `AgentDraft { agentId: string|null; name: string; description: string; icon: string; iconColor: number; model: string; thinkingLevel: string; enabled: boolean; identity: string; systemPrompt: string; aboutYou: string; skillIds: string[]; subagentAllowAgentIds: string[]; allowedRoles: string[]; }`
  - `emptyDraft(): AgentDraft`, `draftFromAgent(a: AgentMarketplaceItem): AgentDraft`, `isDirty(draft, initial: AgentDraft): boolean`, `validateDraft(d: AgentDraft): { name?: string; roles?: string }`
  - `AgentDrawer` props: `{ mode: 'create'|'edit'; agent?: AgentMarketplaceItem; roleOptions: string[]; skills: Array<{id,name,name_zh}>; agents: AgentMarketplaceItem[]; models: ModelView[]; modelsError?: boolean; onSave: (input: AgentInput) => Promise<void>; onClose: () => void; }`

- [ ] **Step 1: Write failing drawerForm tests**

Create `web/tests/pages/agentManage/drawerForm.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { emptyDraft, draftFromAgent, isDirty, validateDraft } from '../../../src/pages/agentManage/drawer/drawerForm';
import type { AgentMarketplaceItem } from '../../../src/api/agentMarketplace';

const item = (): AgentMarketplaceItem => ({
  agentId: 'a1', name: 'N', description: 'd', identity: 'i', systemPrompt: 'p',
  model: 'gpt-5', thinkingLevel: 'medium', icon: 'bot', iconColor: 2, aboutYou: 'me',
  skillIds: ['s1'], subagentAllowAgentIds: ['a2'], allowedRoles: ['org_admin'], enabled: true,
});

describe('drawerForm', () => {
  test('draftFromAgent copies every field', () => {
    const d = draftFromAgent(item());
    expect(d.agentId).toBe('a1');
    expect(d.aboutYou).toBe('me');
    expect(d.iconColor).toBe(2);
    expect(d.thinkingLevel).toBe('medium');
  });
  test('isDirty is false for an unchanged edit draft', () => {
    const base = draftFromAgent(item());
    expect(isDirty(base, base)).toBe(false);
  });
  test('isDirty is true after a field change', () => {
    const base = draftFromAgent(item());
    const changed = { ...base, name: 'M' };
    expect(isDirty(changed, base)).toBe(true);
  });
  test('validateDraft flags empty name and empty roles', () => {
    expect(validateDraft(emptyDraft()).name).toBeTruthy();
    const withName = { ...emptyDraft(), name: 'x' };
    expect(validateDraft(withName).roles).toBeTruthy();
    const ok = { ...withName, allowedRoles: ['org_admin'] };
    expect(validateDraft(ok)).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/agentManage/drawerForm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement drawerForm.ts**

```ts
import type { AgentInput, AgentMarketplaceItem } from '../../../api/agentMarketplace';

export interface AgentDraft {
  agentId: string | null;
  name: string; description: string; icon: string; iconColor: number;
  model: string; thinkingLevel: string; enabled: boolean;
  identity: string; systemPrompt: string; aboutYou: string;
  skillIds: string[]; subagentAllowAgentIds: string[]; allowedRoles: string[];
}

export function emptyDraft(): AgentDraft {
  return { agentId: null, name: '', description: '', icon: 'bot', iconColor: 0,
    model: '', thinkingLevel: 'medium', enabled: true, identity: '', systemPrompt: '',
    aboutYou: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'] };
}

export function draftFromAgent(a: AgentMarketplaceItem): AgentDraft {
  return { agentId: a.agentId, name: a.name, description: a.description, icon: a.icon,
    iconColor: a.iconColor, model: a.model, thinkingLevel: a.thinkingLevel || 'medium',
    enabled: a.enabled, identity: a.identity, systemPrompt: a.systemPrompt, aboutYou: a.aboutYou,
    skillIds: [...a.skillIds], subagentAllowAgentIds: [...a.subagentAllowAgentIds],
    allowedRoles: [...a.allowedRoles] };
}

export function isDirty(d: AgentDraft, initial: AgentDraft): boolean {
  if (d.agentId === null) return JSON.stringify(d) !== JSON.stringify(emptyDraft());
  return JSON.stringify(d) !== JSON.stringify(initial);
}

export function validateDraft(d: AgentDraft): { name?: string; roles?: string } {
  const errs: { name?: string; roles?: string } = {};
  if (!d.name.trim()) errs.name = 'name';
  if (d.allowedRoles.length === 0) errs.roles = 'roles';
  return errs;
}

export function draftToInput(d: AgentDraft): AgentInput {
  return { name: d.name.trim(), description: d.description, identity: d.identity,
    system_prompt: d.systemPrompt, model: d.model, thinking_level: d.thinkingLevel,
    icon: d.icon, icon_color: d.iconColor, about_you: d.aboutYou,
    skill_ids: d.skillIds, subagent_allow_agent_ids: d.subagentAllowAgentIds,
    allowed_roles: d.allowedRoles, enabled: d.enabled };
}
```

- [ ] **Step 4: Run drawerForm tests**

Run: `npx vitest run tests/pages/agentManage/drawerForm.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement ModelSelect.tsx**

`web/src/pages/agentManage/drawer/ModelSelect.tsx`: a controlled dropdown. Props: `{ value: string; onChange: (v: string) => void; models: ModelView[]; fallbackFree: boolean }`. When `models` is non-empty (and not `fallbackFree`), render a button + an absolutely-positioned list of `models` (show `display_name ?? model`), checking the current `value`. When empty/`fallbackFree`, render a free-text `<input value={value} onChange>` with placeholder `providerId/modelId`. Import `ModelView` from `../../../api/models`.

- [ ] **Step 6: Implement AgentDrawer.tsx (scaffold + header + tabs + footer)**

`web/src/pages/agentManage/drawer/AgentDrawer.tsx`:
- State: `draft` (init `agent ? draftFromAgent(agent) : emptyDraft()`), `initial` (same snapshot for dirty), `tab` (default `'identity'`), `popOpen` (`null|'icon'|'model'`), `saving`.
- Header: icon tile (button → toggles `popOpen==='icon'`; renders `ModelSelect`-style popover later — for now a placeholder tile using `tileClass`), inline name input (`onChange` sets `draft.name`; on blur clears a `nameErr`), inline desc input; close × (`requestClose`).
- Tabs row: the 7 tabs from `t('agentmgmt.tab.*')`. Render the active tab body: identity/persona/about → a markdown `<textarea data-field>` bound to `draft.identity/systemPrompt/aboutYou`; skills/subs/im/roles → placeholders for now (`{/* SkillPicker */}` etc., to be filled in later tasks — render an empty `<div/>` so the scaffold compiles).
- Footer: `<ModelSelect value={draft.model} onChange={v=>set('model',v)} models={models} fallbackFree={!!modelsError} />`, a `思考` segmented control mapping 低/标准/高 → low/medium/high (`t('agentmgmt.thinking.*')`), a `启用` `Switch` bound to `draft.enabled`; right side 取消 (`requestClose`) + `创建智能体`/`保存` (`save`).
- `requestClose()`: if `isDirty(draft, initial)` → call `onDiscardRequest?.()` (prop) which the page wires to a discard confirm; else `onClose()`. Add `onDiscardRequest?: () => void` prop.
- `save()`: `const errs = validateDraft(draft)`; if `errs.name` show it under name; if `errs.roles` switch to roles tab and show error; else call `onSave(draftToInput(draft))` with a `保存中…` label while `saving`.
- Esc key: if `popOpen` close it, else `requestClose`.

Add `onDiscardRequest` to the props interface. Keep `onClose` for the discard-cancel/discard-confirmed path.

- [ ] **Step 7: Wire AgentManagePage to the drawer**

In `AgentManagePage.tsx`: remove `view === 'create'` form and `DetailDrawer`. Add a models query: `const { claims } = useAuth(); const orgId = claims?.orgId ?? 'default-org'; const modelsQuery = useQuery({ queryKey: ['models', orgId], queryFn: () => modelsApi.list(orgId) });`. Replace the drawer render with `<AgentDrawer mode={openMode} agent={open ?? undefined} roleOptions={...} skills={skillsQuery.data ?? []} agents={agents} models={modelsQuery.data ?? []} modelsError={modelsQuery.isError} onSave={handleSave} onClose={...} onDiscardRequest={() => setDiscard(true)} />`. Track `openMode: 'create'|'edit'|null`; `+ 新增智能体` sets `{mode:'create'}`; card `onOpen` sets `{mode:'edit', agent}`. `handleSave` calls `createAgent`/`update` then refresh + close (+ set `flashId` on create). Delete the now-unused `CreateAgentForm`/`DetailDrawer` imports.

- [ ] **Step 8: Add a scaffold drawer test**

Create `web/tests/pages/agentManage/AgentDrawer.test.tsx`:

```tsx
import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentDrawer } from '../../../src/pages/agentManage/drawer/AgentDrawer';
import type { AgentMarketplaceItem } from '../../../src/api/agentMarketplace';

const item = (): AgentMarketplaceItem => ({ agentId: 'a1', name: 'N', description: 'd', identity: 'i', systemPrompt: 'p', model: 'gpt-5', thinkingLevel: 'medium', icon: 'bot', iconColor: 2, aboutYou: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true });

describe('AgentDrawer', () => {
  test('renders all 7 tabs and the save button', () => {
    render(<AgentDrawer mode="edit" agent={item()} roleOptions={['org_admin','agent_admin']} skills={[]} agents={[item()]} models={[]} modelsError onSave={async()=>{}} onClose={()=>{}} />);
    for (const label of ['助手身份','助手性格','关于你','技能','协作','IM 渠道','可见范围']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument();
  });
});
```

Set the tab buttons to `role="tab"` in the scaffold (add `role="tab"` to each tab `<button>`).

- [ ] **Step 9: Update the card-opens test, then run drawer + page tests**

Because the page now opens the tabbed `AgentDrawer` (not the old drawer), update the Task-4 test in `web/tests/pages/AgentManagePage.test.tsx`: change the `the card is clickable and opens the drawer` test to expect the identity tab label instead of `思考等级`:
`expect(await screen.findByText('助手身份')).toBeInTheDocument();` (the `reviewerAgent` fixture already carries `aboutYou`/`iconColor` from Task 4).

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx tests/pages/AgentManagePage.test.tsx tests/pages/agentManage/drawerForm.test.ts`
Expected: PASS.

- [ ] **Step 10: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/drawer/AgentDrawer.tsx src/pages/agentManage/drawer/ModelSelect.tsx src/pages/agentManage/drawer/drawerForm.ts src/pages/AgentManagePage.tsx tests/pages/agentManage/AgentDrawer.test.tsx tests/pages/agentManage/drawerForm.test.ts`

```bash
git add web/src/pages/agentManage/drawer/AgentDrawer.tsx web/src/pages/agentManage/drawer/ModelSelect.tsx web/src/pages/agentManage/drawer/drawerForm.ts web/src/pages/AgentManagePage.tsx web/tests/pages/agentManage/AgentDrawer.test.tsx web/tests/pages/agentManage/drawerForm.test.ts
git commit -m "feat(enterprise_web): add unified tabbed agent drawer scaffold"
```

---

### Task 7: SPA — 技能 tab (SkillPicker)

**Files:**
- Create: `web/src/pages/agentManage/drawer/SkillPicker.tsx`
- Modify: `web/src/pages/agentManage/drawer/AgentDrawer.tsx` (mount SkillPicker in the skills tab)
- Test: `web/tests/pages/agentManage/AgentDrawer.test.tsx`

**Interfaces:**
- Produces: `SkillPicker` props `{ skills: Array<{id,name,name_zh}>; selected: string[]; onToggle: (id: string) => void }`.

- [ ] **Step 1: Write failing test**

Add to `AgentDrawer.test.tsx`:

```tsx
test('skills tab lists skills and toggling updates selection via save payload', async () => {
  let saved: unknown;
  const skills = [
    { id: 's1', name: 'SQL 查询', name_zh: 'SQL 查询' },
    { id: 's2', name: '文档生成', name_zh: '文档生成' },
  ];
  render(<AgentDrawer mode="create" roleOptions={['org_admin']} skills={skills} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: '技能' }));
  expect(screen.getByText('SQL 查询')).toBeInTheDocument();
  // Click the SQL row to select it.
  fireEvent.click(screen.getByText('SQL 查询'));
  fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'New' } });
  fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
  await waitFor(() => expect((saved as { skill_ids?: string[] }).skill_ids).toEqual(['s1']));
});
```

Set the name input's accessible name to `Agent 名称` (add `aria-label="Agent 名称"`). Import `waitFor` from `@testing-library/react`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: FAIL (skills tab still a placeholder).

- [ ] **Step 3: Implement SkillPicker.tsx**

```tsx
import { useState } from 'react';
import { Search, Check } from 'lucide-react';
import { t } from '../../types';

interface Props { skills: Array<{ id: string; name: string; name_zh: string | null }>; selected: string[]; onToggle: (id: string) => void; }

export function SkillPicker({ skills, selected, onToggle }: Props) {
  const [q, setQ] = useState('');
  const list = skills.filter(s => !q || (s.name + (s.name_zh ?? '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="mb-2 text-xs text-[var(--text-secondary)] bg-[var(--accent-primary)]/5 rounded-lg px-3 py-2">{t('agentmgmt.skills.hint')}</div>
      <div className="relative mb-2">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input aria-label={t('agentmgmt.skills.search')} className="h-9 w-full pl-8 pr-3 rounded-lg border border-[var(--border-default)] text-sm"
               placeholder={t('agentmgmt.skills.search')} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {list.length === 0 ? <div className="py-4 text-center text-sm text-[var(--text-tertiary)]">{t('agentmgmt.skills.empty')}</div> :
        list.map(s => { const on = selected.includes(s.id); return (
          <button key={s.id} type="button" onClick={() => onToggle(s.id)}
                  className={`mb-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${on ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/5' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)]'}`}>
            <span className="flex-1 min-w-0">
              <span className="block text-[13.5px] font-medium">{s.name_zh ?? s.name}</span>
              <span className="block text-[11.5px] text-[var(--text-tertiary)]">{s.name_zh ?? s.name}</span>
            </span>
            <span className={`flex h-[19px] w-[19px] items-center justify-center rounded-md ${on ? 'bg-[var(--accent-primary)] text-white' : 'border border-[var(--border-default)]'}`}>{on ? <Check size={12} /> : null}</span>
          </button>); })}
    </div>
  );
}
```

In `AgentDrawer.tsx`, replace the skills-tab placeholder with `<SkillPicker skills={skills} selected={draft.skillIds} onToggle={(id) => setDraft(d => ({ ...d, skillIds: d.skillIds.includes(id) ? d.skillIds.filter(x => x !== id) : [...d.skillIds, id] }))} />`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/drawer/SkillPicker.tsx src/pages/agentManage/drawer/AgentDrawer.tsx tests/pages/agentManage/AgentDrawer.test.tsx`

```bash
git add web/src/pages/agentManage/drawer/SkillPicker.tsx web/src/pages/agentManage/drawer/AgentDrawer.tsx web/tests/pages/agentManage/AgentDrawer.test.tsx
git commit -m "feat(enterprise_web): agent drawer skills tab with search + toggle"
```

---

### Task 8: SPA — 协作 tab (SubagentPicker with cycle detection)

**Files:**
- Create: `web/src/pages/agentManage/drawer/SubagentPicker.tsx`
- Modify: `web/src/pages/agentManage/drawer/AgentDrawer.tsx`
- Test: `web/tests/pages/agentManage/AgentDrawer.test.tsx`

**Interfaces:**
- Produces: `SubagentPicker` props `{ agents: AgentMarketplaceItem[]; currentId: string | null; selected: string[]; onToggle: (id: string) => void }`. A candidate whose `subagentAllowAgentIds` includes `currentId` is disabled with a "成环" note and cannot be toggled.

- [ ] **Step 1: Write failing test**

Add to `AgentDrawer.test.tsx`:

```tsx
test('subagent tab disables a cyclic candidate with a 成环 note', async () => {
  // editing a1; a2 references a1 → selecting a2 would form a cycle.
  const a1: AgentMarketplaceItem = { agentId: 'a1', name: 'A1', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: 'bot', iconColor: 0, aboutYou: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true };
  const a2: AgentMarketplaceItem = { ...a1, agentId: 'a2', name: 'A2', subagentAllowAgentIds: ['a1'] };
  render(<AgentDrawer mode="edit" agent={a1} roleOptions={['org_admin']} skills={[]} agents={[a1, a2]} models={[]} onSave={async()=>{}} onClose={()=>{}} />);
  fireEvent.click(screen.getByRole('tab', { name: '协作' }));
  const a2row = screen.getByText('A2').closest('button, [role="button"]') as HTMLElement;
  expect(a2row).toHaveClass('disabled'); // or isDisabled()
  expect(screen.getByText('成环')).toBeInTheDocument();
});
```

Implement the disabled row as `<button type="button" disabled className="...">` (so `toBeDisabled()`/class assertion works — use `screen.getByText('A2').closest('button')` and `expect(btn).toBeDisabled()`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement SubagentPicker.tsx**

```tsx
import type { JSX } from 'react';
import type { AgentMarketplaceItem } from '../../../api/agentMarketplace';
import { Check } from 'lucide-react';
import { tileClass } from '../agentTile';
import { t } from '../../types';

interface Props { agents: AgentMarketplaceItem[]; currentId: string | null; selected: string[]; onToggle: (id: string) => void; }

export function SubagentPicker({ agents, currentId, selected, onToggle }: Props): JSX.Element {
  const opts = agents.filter(a => a.agentId !== currentId);
  return (
    <div>
      <div className="mb-0.5 text-sm font-semibold">{t('agentmgmt.subs.title')}</div>
      <div className="mb-3 text-xs text-[var(--text-secondary)]">{t('agentmgmt.subs.hint')}</div>
      {opts.map(a => {
        const on = selected.includes(a.agentId);
        const cycle = !!currentId && a.subagentAllowAgentIds.includes(currentId);
        return (
          <button key={a.agentId} type="button" disabled={cycle} onClick={() => onToggle(a.agentId)}
                  className={`mb-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${on ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/5' : 'border-[var(--border-subtle)]'} ${cycle ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--bg-tertiary)]'}`}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold ${tileClass(a.iconColor)}`}>{a.name.charAt(0)}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13.5px] font-medium">{a.name}</span>
              <span className="block text-[11px] text-[var(--text-tertiary)]">{a.agentId}</span>
            </span>
            {cycle ? <span className="text-[11px] text-[var(--warning-primary)]">{t('agentmgmt.subs.cycle')}</span> : null}
            <span className={`flex h-[19px] w-[19px] items-center justify-center rounded-md ${on ? 'bg-[var(--accent-primary)] text-white' : 'border border-[var(--border-default)]'}`}>{on ? <Check size={12} /> : null}</span>
          </button>
        );
      })}
    </div>
  );
}
```

In `AgentDrawer.tsx`, replace the subs-tab placeholder with `<SubagentPicker agents={agents} currentId={draft.agentId} selected={draft.subagentAllowAgentIds} onToggle={(id) => setDraft(d => ({ ...d, subagentAllowAgentIds: d.subagentAllowAgentIds.includes(id) ? d.subagentAllowAgentIds.filter(x => x !== id) : [...d.subagentAllowAgentIds, id] }))} />`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/drawer/SubagentPicker.tsx src/pages/agentManage/drawer/AgentDrawer.tsx tests/pages/agentManage/AgentDrawer.test.tsx`

```bash
git add web/src/pages/agentManage/drawer/SubagentPicker.tsx web/src/pages/agentManage/drawer/AgentDrawer.tsx web/tests/pages/agentManage/AgentDrawer.test.tsx
git commit -m "feat(enterprise_web): agent drawer collaboration tab with cycle detection"
```

---

### Task 9: SPA — 可见范围 tab (RolesPicker, min 1) + IM note

**Files:**
- Create: `web/src/pages/agentManage/drawer/RolesPicker.tsx`
- Modify: `web/src/pages/agentManage/drawer/AgentDrawer.tsx`
- Test: `web/tests/pages/agentManage/AgentDrawer.test.tsx`

**Interfaces:**
- Produces: `RolesPicker` props `{ options: string[]; selected: string[]; onChange: (v: string[]) => void; error?: string }`.

- [ ] **Step 1: Write failing tests**

Add to `AgentDrawer.test.tsx`:

```tsx
test('roles tab shows chips and save is blocked when all removed', async () => {
  let saved: unknown;
  render(<AgentDrawer mode="create" roleOptions={['org_admin','agent_admin']} skills={[]} agents={[]} models={[]} onSave={async (i)=>{saved=i;}} onClose={()=>{}} />);
  fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
  fireEvent.click(screen.getByRole('tab', { name: '可见范围' }));
  // Remove the only default role (org_admin) via its chip ×.
  fireEvent.click(screen.getByRole('button', { name: /org_admin/ }));
  // Now click save → should be blocked (roles empty), no POST.
  fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
  await waitFor(() => expect(saved).toBeUndefined());
  expect(screen.getByText('至少选择一个角色')).toBeInTheDocument();
});
```

Make each selected-role chip a `button` whose accessible name is the role (and removes it on click).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement RolesPicker.tsx**

```tsx
import type { JSX } from 'react';
import { X } from 'lucide-react';
import { t } from '../../types';

interface Props { options: string[]; selected: string[]; onChange: (v: string[]) => void; error?: string; }

export function RolesPicker({ options, selected, onChange, error }: Props): JSX.Element {
  const addable = options.filter(o => !selected.includes(o));
  return (
    <div>
      <div className="mb-0.5 text-sm font-semibold">{t('agentmgmt.tab.roles')}</div>
      <div className="mb-3 text-xs text-[var(--text-secondary)]">{t('agentmgmt.roles.hint')}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((r, i) => (
          <button key={r} type="button" onClick={() => onChange(selected.filter((_, j) => j !== i))}
                  aria-label={r}
                  className="flex items-center gap-1 rounded-full bg-[var(--accent-primary)]/10 px-2.5 py-1 text-xs text-[var(--accent-primary)]">
            {r}<X size={11} />
          </button>
        ))}
        {selected.length === 0 && <span className="text-xs text-[var(--text-tertiary)]">{t('agentmgmt.roles.add')}</span>}
      </div>
      {addable.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {addable.map(r => (
            <button key={r} type="button" onClick={() => onChange([...selected, r])}
                    className="rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-xs hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
              + {r}
            </button>
          ))}
        </div>
      )}
      {error && <div className="mt-2 text-[11.5px] text-[var(--danger-primary)]">{error}</div>}
    </div>
  );
}
```

In `AgentDrawer.tsx`: render `<RolesPicker options={roleOptions} selected={draft.allowedRoles} onChange={(v) => setDraft(d => ({ ...d, allowedRoles: v }))} error={errors.roles ? t('agentmgmt.roles.min') : undefined} />` in the roles tab; render `t('agentmgmt.im.note')` (a static note block) in the im tab. Store validation `errors` in drawer state so the roles error displays.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/drawer/RolesPicker.tsx src/pages/agentManage/drawer/AgentDrawer.tsx tests/pages/agentManage/AgentDrawer.test.tsx`

```bash
git add web/src/pages/agentManage/drawer/RolesPicker.tsx web/src/pages/agentManage/drawer/AgentDrawer.tsx web/tests/pages/agentManage/AgentDrawer.test.tsx
git commit -m "feat(enterprise_web): agent drawer roles tab (min 1) + IM note"
```

---

### Task 10: SPA — icon/color picker

**Files:**
- Create: `web/src/pages/agentManage/drawer/IconColorPicker.tsx`
- Modify: `web/src/pages/agentManage/drawer/AgentDrawer.tsx`
- Test: `web/tests/pages/agentManage/AgentDrawer.test.tsx`

**Interfaces:**
- Produces: `IconColorPicker` props `{ icon: string; iconColor: number; onPick: (glyph: string, color: number) => void; onColor: (color: number) => void }` (or a single `onSelect(icon, color)`).

- [ ] **Step 1: Write failing test**

Add to `AgentDrawer.test.tsx`:

```tsx
test('icon tile popover changes the draft color on pick', async () => {
  let saved: unknown;
  render(<AgentDrawer mode="create" roleOptions={['org_admin']} skills={[]} agents={[]} models={[]} onSave={async (i)=>{saved=i;}} onClose={()=>{}} />);
  fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
  fireEvent.click(screen.getByRole('button', { name: /更换图标/ })); // tile has aria-label 更换图标
  // pick the 3rd color swatch
  const swatches = screen.getAllByRole('button', { name: /颜色/ });
  fireEvent.click(swatches[2]);
  fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
  await waitFor(() => expect((saved as { icon_color?: number }).icon_color).toBe(2));
});
```

Give the tile button `aria-label="更换图标"` and each color swatch `aria-label="颜色 N"` (N = index+1) so they are queryable.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement IconColorPicker.tsx**

A popover (absolutely positioned under the tile) with a glyph grid (map `AGENT_GLYPHS` to lucide icons via a `GLYPH_ICON` record; clicking writes the glyph name) and an 8-swatch color row (`AGENT_COLORS`; each `button aria-label={"颜色 " + (i+1)}` with `style={{ background: c }}`, `on` state ringed). Expose `onPick(glyph)` and `onColor(color)`.

In `AgentDrawer.tsx`, render the popover when `popOpen === 'icon'`; the tile `<button aria-label="更换图标" onClick={() => setPopOpen(p => p === 'icon' ? null : 'icon')}>`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/agentManage/drawer/IconColorPicker.tsx src/pages/agentManage/drawer/AgentDrawer.tsx tests/pages/agentManage/AgentDrawer.test.tsx`

```bash
git add web/src/pages/agentManage/drawer/IconColorPicker.tsx web/src/pages/agentManage/drawer/AgentDrawer.tsx web/tests/pages/agentManage/AgentDrawer.test.tsx
git commit -m "feat(enterprise_web): agent drawer icon + color picker"
```

---

### Task 11: SPA — enable/disable confirm, delete confirm, draft discard, duplicate warning, create flash

**Files:**
- Modify: `web/src/pages/AgentManagePage.tsx`
- Modify: `web/src/pages/agentManage/AgentCard.tsx` (disable popover anchor)
- Test: `web/tests/pages/AgentManagePage.test.tsx`

**Interfaces:**
- Produces: card enable (direct), disable (popover confirm), delete (references → confirm → remove + animate), dirty→discard confirm, duplicate-name warning in the drawer, and a create flash.

- [ ] **Step 1: Write failing tests**

Add to `web/tests/pages/AgentManagePage.test.tsx`:

```ts
test('disabling an enabled agent shows a confirm popover, then PUT enabled:false', async () => {
  seedAgents([reviewerAgent({ enabled: true })]);
  renderPage();
  const sw = await screen.findByRole('switch', { checked: true });
  fireEvent.click(sw);
  // popover with confirm appears
  const confirm = await screen.findByRole('button', { name: '确定禁用' });
  fireEvent.click(confirm);
  await waitFor(() => expect(putBodyFor('agent_1')).toEqual({ enabled: false }));
});

test('deleting shows the reference list then DELETE on confirm', async () => {
  // references endpoint returns one referrer
  seedAgents([reviewerAgent()], { refs: { ids: ['a2'], names: ['数据分析员'] } });
  renderPage();
  const del = await screen.findByRole('button', { name: '删除' });
  fireEvent.click(del);
  await waitFor(() => expect(findCall('GET', '/references')).toBe(true));
  expect(screen.getByText(/数据分析员/)).toBeInTheDocument();
  const delBtns = screen.getAllByRole('button', { name: '删除' });
  fireEvent.click(delBtns[delBtns.length - 1]);
  await waitFor(() => expect(findCall('DELETE', '/agents/agent_1')).toBe(true));
});

test('closing a dirty drawer prompts to discard', async () => {
  seedAgents([reviewerAgent()]);
  renderPage();
  fireEvent.click((await screen.findByText('Reviewer')).closest('[data-testid="agent-card"]') as HTMLElement);
  const name = await screen.findByRole('textbox', { name: /Agent 名称/i });
  fireEvent.change(name, { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: /取消/ }));
  expect(await screen.findByText('放弃未保存的更改？')).toBeInTheDocument();
});
```

Extend the existing `seedAgents(agents, opts?)` helper to accept an optional `refs` (default `{ ids: [], names: [] }`) and return it for `/references`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages/AgentManagePage.test.tsx`
Expected: FAIL (new behaviors unimplemented).

- [ ] **Step 3: Implement enable/disable + delete in AgentManagePage.tsx**

- Add state `disableOn: string | null` and `discard: boolean`.
- `toggleEnabled(agent, enabled)`: if `enabled` (turning on) → optimistic `update(agentId, { enabled: true })` (rollback + toast.error on failure). If disabling → set `disableOn = agent.agentId` (render the popover anchored to that card).
- Disable popover (rendered in the card area when `disableOn === agent.agentId`): text `t('agentmgmt.disable.popover')` + 取消 (`setDisableOn(null)`) + `t('agentmgmt.disable.confirm')` (`disable-ok` → `update(agentId, { enabled: false })`, `setDisableOn(null)`, toast).
- Delete: on confirm of the references `ConfirmDialog`, after `remove`, set `removingId = agent.agentId` (the card animates out via a `.removing` class/inline style), then clear after ~160 ms.
- Wire `onDiscardRequest` on `AgentDrawer` to `setDiscard(true)`; render a `ConfirmDialog` for discard: title `t('agentmgmt.discard.title')`, message `t('agentmgmt.discard.body')`, `cancelLabel={t('agentmgmt.discard.stay')}`, `confirmLabel={t('agentmgmt.discard.discard')}`, onConfirm → close drawer + `setDiscard(false)`, onCancel → `setDiscard(false)` (stay).
- Duplicate-name warning: in `AgentDrawer`, when `mode==='edit'` and a draft name matches another agent's name (case-insensitive), show `fill(t('agentmgmt.dup.name'), { name: other })` under the name field (non-blocking). Add this to `AgentDrawer` (it has `agents`).
- Create flash: after create, set `flashId = out.agent_id`; pass `flashId` to the grid/card so that card gets a transient ring (clear via a `setTimeout` ~2.2 s).

- [ ] **Step 4: Run page + drawer tests**

Run: `npx vitest run tests/pages/AgentManagePage.test.tsx tests/pages/agentManage/AgentDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/AgentManagePage.tsx src/pages/agentManage/AgentCard.tsx tests/pages/AgentManagePage.test.tsx`

```bash
git add web/src/pages/AgentManagePage.tsx web/src/pages/agentManage/AgentCard.tsx web/tests/pages/AgentManagePage.test.tsx
git commit -m "feat(enterprise_web): agent enable/disable confirm, delete refs, discard, dup warning"
```

---

### Task 12: Remove dead flat forms + final gates

**Files:**
- Delete: `web/src/pages/agentManage/CreateAgentForm.tsx`, `web/src/pages/agentManage/DetailDrawer.tsx`
- Modify: `web/src/pages/agentManage/fields.tsx` (remove now-unused exports if any)
- Modify: `web/src/pages/AgentManagePage.tsx` (drop any leftover references)

**Interfaces:**
- Consumes: everything from prior tasks.

- [ ] **Step 1: Remove dead files and unused imports**

Delete `CreateAgentForm.tsx` and `DetailDrawer.tsx`. Confirm no file imports them (`grep -rn "CreateAgentForm\|DetailDrawer" src` → only this file, now cleaned). If `fields.tsx` exports (`Field`, `MultiChips`) are now unused, remove the dead exports (keep `types.ts` `t`/`fill`).

- [ ] **Step 2: Full SPA test run**

Run (from `web/`): `npx vitest run`
Expected: all tests PASS (the pre-existing ~185 + the new agent tests).

- [ ] **Step 3: Lint all touched files**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/AgentManagePage.tsx src/pages/agentManage/ src/api/agentMarketplace.ts src/i18n.ts`
Expected: clean.

- [ ] **Step 4: Typecheck (no new errors)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | rg "agentManage|AgentManagePage|agentMarketplace|drawer/" | head`
Expected: no errors referencing the touched files (any other legacy errors are pre-existing and out of scope — report them as such).

- [ ] **Step 5: Server test still green**

Run (from `enterprise_server/`): `npx vitest run tests/models/agentMarketplaceView.test.ts tests/routes/agentMarketplaceAdmin.test.ts tests/routes/agentMarketplacePublic.test.ts`
Expected: PASS.

- [ ] **Step 6: Production build**

Run (from `web/`): `npx vite build`
Expected: build succeeds (confirms the CSS/theme + new components compile).

- [ ] **Step 7: Commit**

```bash
git add -A web/src/pages/agentManage/CreateAgentForm.tsx web/src/pages/agentManage/DetailDrawer.tsx web/src/pages/agentManage/fields.tsx web/src/pages/AgentManagePage.tsx
git commit -m "chore(enterprise_web): remove superseded flat agent form/drawer"
```

---

## Self-Review

**Spec coverage:**
- §1 (migration 026, view, admin route) → **Task 1**.
- §2 (SPA API types) → **Task 2**.
- §3 (page shell: states, search, card grid) → **Tasks 4, 5** (Task 4 = card/grid restyle; Task 5 = states + search).
- §4 (unified tabbed drawer, ModelSelect, thinking, enable, draft/save) → **Task 6**; skills → **Task 7**; subagents/cycle → **Task 8**; roles/IM → **Task 9**; icon/color → **Task 10**.
- §5 (enable/disable, delete, draft protection, duplicate) → **Task 11**.
- §6 (icon/color render rule) → **Tasks 3, 4, 10** (module + card tile + picker).
- §7 (i18n) → **Task 2**.
- §8 (tests) → distributed across Tasks 4–11 (card, states, drawer tabs, pickers, interactions).
- §9 (quality gates) → **Task 12** (+ per-task lint).

Gaps found & fixed during self-review:
- The spec's §5 lists create-flash and delete-animation; wired into **Task 11** (flash + `removingId`).
- The spec's model "free-text fallback when catalog fails" → **Task 6** `ModelSelect fallbackFree={!!modelsError}`.
- Duplicate-name warning needs the `agents` list in the drawer → **Task 11** (AgentDrawer already receives `agents`).
- The 403 no-access in-page fallback → **Task 5** (defensive; the router `AuthGuard` already blocks).

**Placeholder scan:** no TBD/TODO; every code step has concrete code. The Task 6 scaffold uses explicit placeholder *comments* only for tabs that are implemented in the immediately-following Tasks 7–10 (each with its own failing test + implementation), so no step depends on an unimplemented reference.

**Type consistency:**
- `AgentDraft` / `emptyDraft` / `draftFromAgent` / `isDirty` / `validateDraft` / `draftToInput` — defined in Task 6 Step 3, consumed identically in Tasks 7–11.
- `AgentDrawer` props (`mode, agent?, roleOptions, skills, agents, models, modelsError, onSave, onClose, onDiscardRequest?`) — consistent across Task 6 and the tests in Tasks 6–10.
- `AgentInput` gains `about_you`/`icon_color` (Task 2) — matches `draftToInput` (Task 6) and server schema (Task 1).
- `tileClass`/`isUrlIcon`/`AGENT_GLYPHS`/`AGENT_COLORS` (Task 3) — used in Task 4 card, Task 8 avatar, Task 10 picker.
- i18n keys referenced in UI (`t('agentmgmt.tab.*')`, `.skills.*`, `.subs.*`, `.roles.*`, `.discard.*`, `.dup.name`, `.noResult.*`, `.loadError.*`, `.empty.*`, `.thinking.*`) — all added in Task 2 (en + zh).

**Ordering / green-at-each-step:** Tasks 1→2→3 are green independently (server, then types+i18n, then the pure tile module). Tasks 4, 5 modify the page/card with tests. Tasks 6–10 build the drawer incrementally, each landing its own tests green before the next. Task 11 wires interactions. Task 12 removes dead code and runs the full gate. No task consumes a symbol defined in a later task.
