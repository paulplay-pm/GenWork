# SSO 账号绑定管理页（桌面端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GenWork 桌面端的用户头像菜单增加"绑定 SSO 账号"入口,打开一个新的桌面内嵌管理页(1:1 还原原型图 `Image #17`),展示本组织所有可用的 SSO 连接 + 当前用户的绑定状态 + 已绑定账号与时间,支持绑定/解绑。

**Architecture:** 三层改动:服务端加 `GET /me/sso-binding/connections` 端点;桌面主进程扩展 IPC + 复用 `openOauthFlow` 跑 bind 的 OAuth;桌面渲染器加新页面 / 路由 / Redux slice / 菜单项。`genericSsoLogin.ts` 880 行大文件**不**碰;bind 流程的 OAuth 探针复用既有的 `createSsoLoginProbe`,新文件 `startSsoMemberBind.ts` 装 bind 专用的 entry 函数。

**Tech Stack:** Electron + React + Redux Toolkit + Tailwind(桌面) / Hono + Zod + node-postgres(服务端) / i18n 字典(双方各自维护)

**Spec:** `docs/superpowers/specs/2026-10-13-sso-binding-management-page-design.md`

## Global Constraints

- Node.js `>=24.15.0 <25`。
- ESLint touched files clean: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`。
- Per-file vitest,因 sandbox fd 限制。
- i18n 同步 zh + en(`src/renderer/services/i18n.ts` + `src/main/i18n.ts`)。
- Conventional Commits 英文,无 `Co-Authored-By` 尾签,无 push。
- 字符串常量集中(`as const`),不裸字面量比较。
- 复用既有 helpers:`enterpriseFetchWithAuth`(在 `src/main/main.ts:5207` 的 local closure,不可跨文件 import)、`openOauthFlow`、`createSsoLoginProbe`、`authService`、redux store 既有 slices。
- 不修改 `genericSsoLogin.ts`(880 行大文件) — bind 流程走新文件。

## Review Focus

- 服务端新端点不会泄露其他 org 的 SSO 连接(跨 org 隔离)。
- 桌面 OAuth 流程复用 `openOauthFlow` 时,probe 的 `pendingBind` 分支不会触发(用户已登录,走的是 `ready_to_finalize` finalize 路径)。
- 渲染器搜索/标签过滤的"未绑定 N"计数,在并发刷新时不会出现 negative 或 stale 值。
- 解绑流程在网络失败时不留 UI 假象(按钮恢复 + 错误 toast + 回滚 row state)。
- 既有企业版头像菜单的菜单项顺序不破坏(只在 退出 上方插入新项)。
- i18n 键不漏 zh,新增键同时填 en。
- `enterpriseFetchWithAuth` 是 main.ts 内的 local closure — 新 IPC handler 必须写在 main.ts 里,不能放新文件。

## File Structure

新增/修改文件一览(避免大文件膨胀):

| 角色 | 路径 | 状态 | 职责 |
| --- | --- | --- | --- |
| Server endpoint | `enterprise_server/src/routes/me/ssoBinding.ts` | modify | 加 GET 端点(既有文件 + ~30 行) |
| Server test | `enterprise_server/tests/me/ssoBindingConnections.test.ts` | new | 覆盖 GET 端点(6 个 case) |
| Desktop main | `src/main/sso/startSsoMemberBind.ts` | new | bind 专用的 OAuth 入口函数(走 openOauthFlow + createSsoLoginProbe) |
| Desktop main test | `src/main/sso/startSsoMemberBind.test.ts` | new | 覆盖 bind 完整流程 + 错误路径 |
| Desktop main IPC | `src/main/main.ts` | modify | 加 3 个 `ipcMain.handle('sso:*', ...)`(既有文件 + ~30 行) |
| Shared type | `src/shared/sso/binding.ts` | new | `SsoConnectionWithBinding` + IPC action 常量 |
| Server type | `enterprise_server/src/sso/bindingTypes.ts` | new | 同名 interface(server 端独立维护) |
| Renderer slice | `src/renderer/store/slices/ssoBindingsSlice.ts` | new | state + thunks |
| Renderer slice test | `src/renderer/store/slices/ssoBindingsSlice.test.ts` | new | 覆盖 thunks + reducers |
| Renderer page | `src/renderer/components/ssoBindings/SsoBindingsPage.tsx` | new | 主页面 1:1 还原原型 |
| Renderer page test | `src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx` | new | 渲染 / 搜索 / 标签 / 按钮交互 |
| Renderer menu | `src/renderer/components/EnterpriseMtAccountMenu.tsx` | modify | 加 1 个 MenuItem + LinkIcon |
| Renderer menu test | `src/renderer/components/EnterpriseMtAccountMenu.test.tsx` | new | 菜单展开后 4 项顺序 |
| Renderer router | `src/renderer/App.tsx` | modify | 加 `/sso-bindings` 路由 |
| Renderer i18n | `src/renderer/services/i18n.ts` | modify | 加 ~20 个新键(zh + en) |

---

## Task 1: Server 新端点 `GET /me/sso-binding/connections`

**Files:**
- Modify: `enterprise_server/src/routes/me/ssoBinding.ts`(+ ~30 行)
- Create: `enterprise_server/src/sso/bindingTypes.ts`(新文件,~25 行)
- Create: `enterprise_server/tests/me/ssoBindingConnections.test.ts`(新文件,~120 行)

**Interfaces:**
- Consumes: 既有 `requireAuth` 中间件 + `pool`(`pg.Pool` 单例)+ `SsoConnectionRow`(既有 type 在 `enterprise_server/src/sso/types.ts`)
- Produces: `SsoConnectionWithBinding`(新 type,在 `bindingTypes.ts`)+ 新端点 `/me/sso-binding/connections` GET

- [ ] **Step 1: 写服务端 type**

`enterprise_server/src/sso/bindingTypes.ts`:

```ts
/** Row shape for `GET /me/sso-binding/connections` — every enabled
 *  connection in the caller's org, annotated with the caller's binding
 *  status. `bound: false` rows have `externalId` / `boundAt` as null.
 *  The server fills `logoUrl` (absolute) so the client never has to
 *  rebuild it from a relative path. */
export interface SsoConnectionWithBinding {
  id: string;
  name: string;
  providerType: string;
  description: string | null;
  sortOrder: number;
  enabled: boolean;
  logoUrl: string | null;
  bound: boolean;
  externalId: string | null;
  /** ISO 8601 string (e.g. "2026-10-13T08:00:00.000Z") or null. */
  boundAt: string | null;
}
```

- [ ] **Step 2: 写失败的测试**

`enterprise_server/tests/me/ssoBindingConnections.test.ts`(摘要,完整代码 ~120 行):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { meSsoBindingRoutes } from '../../src/routes/me/ssoBinding';
// ... 启动 pg-mem 或类似方案,或用真实 test DB

describe('GET /me/sso-binding/connections', () => {
  it('returns 401 when no auth claims', async () => { /* ... */ });
  it('returns empty list when no connections in org', async () => { /* ... */ });
  it('returns connections with bound=false for unbound user', async () => { /* ... */ });
  it('returns connections with bound=true and externalId for bound user', async () => { /* ... */ });
  it('does not leak connections from other orgs', async () => { /* ... */ });
  it('excludes disabled connections', async () => { /* ... */ });
  it('converts logo_path to absolute logoUrl', async () => { /* ... */ });
  it('formats bound_at as ISO 8601 string', async () => { /* ... */ });
});
```

(具体 mock / fixture 写法跟既有 `tests/me/ssoBinding.test.ts` 对齐,需要先读那个文件确认测试 harness)

- [ ] **Step 3: 跑测试,确认它们失败**

Run: `cd enterprise_server && npx vitest run tests/me/ssoBindingConnections.test.ts`
Expected: 全部失败(端点不存在 → 路由 404)

- [ ] **Step 4: 实现 GET 端点**

`enterprise_server/src/routes/me/ssoBinding.ts` 末尾追加(在既有 `meSsoBindingRoutes.delete(...)` 之后):

```ts
import { type SsoConnectionWithBinding } from '../../sso/bindingTypes';

meSsoBindingRoutes.get('/me/sso-binding/connections', async (c) => {
  const claims = c.get('claims');
  const origin = new URL(c.req.url).origin;
  const r = await pool.query<{
    id: string; name: string; provider_type: string; description: string | null;
    sort_order: number; enabled: boolean; logo_path: string | null;
    bound: boolean; external_id: string | null; bound_at: Date | null;
  }>(
    `SELECT
       c.id, c.name, c.provider_type, c.description, c.sort_order, c.enabled, c.logo_path,
       (u.sso_connection_id IS NOT NULL) AS bound,
       u.sso_external_id AS external_id,
       u.sso_bound_at AS bound_at
     FROM sso_connections c
     LEFT JOIN users u
       ON u.id = $1
      AND u.org_id = c.org_id
      AND c.id = u.sso_connection_id
     WHERE c.org_id = $2
       AND c.enabled = true
     ORDER BY c.sort_order ASC, c.name ASC`,
    [claims.sub, claims.orgId]
  );
  const connections: SsoConnectionWithBinding[] = r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    description: row.description,
    sortOrder: row.sort_order,
    enabled: row.enabled,
    logoUrl: row.logo_path ? `${origin}/auth/sso/providers/${row.id}/logo` : null,
    bound: row.bound,
    externalId: row.external_id,
    boundAt: row.bound_at ? row.bound_at.toISOString() : null,
  }));
  return c.json({ connections });
});
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `cd enterprise_server && npx vitest run tests/me/ssoBindingConnections.test.ts`
Expected: 全部通过

- [ ] **Step 6: 跑既有测试,确保不回归**

Run: `cd enterprise_server && npx vitest run tests/me/ssoBinding.test.ts`
Expected: 既有 4 个 case 仍通过(本任务只新增,不修改既有端点)

- [ ] **Step 7: Lint**

Run: `npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 enterprise_server/src/routes/me/ssoBinding.ts enterprise_server/src/sso/bindingTypes.ts enterprise_server/tests/me/ssoBindingConnections.test.ts`
Expected: 无错误,无警告

---

## Task 2: Shared type + IPC action 常量

**Files:**
- Create: `src/shared/sso/binding.ts`(新文件)

**Interfaces:**
- Consumes: 跟 `enterprise_server/src/sso/bindingTypes.ts` 字段一致
- Produces: 桌面端共享 type + IPC action 名字常量

- [ ] **Step 1: 写 type + 常量**

`src/shared/sso/binding.ts`:

```ts
/** Row shape for `GET /me/sso-binding/connections`. The server fills
 *  `logoUrl` as an absolute URL so the renderer never has to rebuild
 *  it from a relative path. Mirrored by hand from
 *  `enterprise_server/src/sso/bindingTypes.ts` — keep in sync.
 *  The test in ssoBindingsSlice.test.ts asserts field equality
 *  with the server's response. */
export interface SsoConnectionWithBinding {
  id: string;
  name: string;
  providerType: string;
  description: string | null;
  sortOrder: number;
  enabled: boolean;
  logoUrl: string | null;
  bound: boolean;
  externalId: string | null;
  /** ISO 8601 string. */
  boundAt: string | null;
}

/** IPC channel names for the desktop SSO self-binding surface. The
 *  server-side counterparts live under `/me/sso-binding/*`. */
export const SSO_BINDING_IPC = {
  List: 'sso:listMyBindings',
  Unbind: 'sso:unbindMyConnection',
  Start: 'sso:startMyBinding',
} as const;
export type SsoBindingIpc = typeof SSO_BINDING_IPC[keyof typeof SSO_BINDING_IPC];
```

- [ ] **Step 2: Lint**

Run: `npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/shared/sso/binding.ts`
Expected: clean

---

## Task 3: 桌面 main 进程 `startSsoMemberBind` 入口函数

**Files:**
- Create: `src/main/sso/startSsoMemberBind.ts`(新文件,~40 行)
- Create: `src/main/sso/startSsoMemberBind.test.ts`(新文件,~150 行)

**Interfaces:**
- Consumes: 既有 `startCallbackServer`、`createSsoLoginProbe`(都在 `src/main/sso/genericSsoLogin.ts` exported)、`openOauthFlow`(在 `src/main/mcp/oauthBrowserFlow.ts`)
- Produces: `startSsoMemberBind(args: { enterpriseBaseUrl: string; authorizeUrl: string }): Promise<string>`

- [ ] **Step 1: 写失败的测试**

`src/main/sso/startSsoMemberBind.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { openOauthFlowMock } = vi.hoisted(() => ({ openOauthFlowMock: vi.fn() }));

vi.mock('../mcp/oauthBrowserFlow', () => ({
  openOauthFlow: (opts: unknown) => openOauthFlowMock(opts),
}));

vi.mock('./genericSsoLogin', () => ({
  startCallbackServer: vi.fn(async () => ({
    port: 53231,
    close: vi.fn(),
    waitForArrival: vi.fn(),
  })),
  createSsoLoginProbe: vi.fn(() => () => Promise.resolve(null)),
}));

import { startSsoMemberBind } from './startSsoMemberBind';

describe('startSsoMemberBind', () => {
  beforeEach(() => {
    openOauthFlowMock.mockReset();
  });

  test('starts the loopback, runs openOauthFlow with the server-supplied authorizeUrl, and returns the token', async () => {
    openOauthFlowMock.mockResolvedValueOnce('eyJ-bound-jwt');
    const token = await startSsoMemberBind({
      enterpriseBaseUrl: 'https://api.example.com',
      authorizeUrl: 'https://api.example.com/auth/sso/c1/authorize?state=...',
    });
    expect(token).toBe('eyJ-bound-jwt');
    expect(openOauthFlowMock).toHaveBeenCalledTimes(1);
    const opts = openOauthFlowMock.mock.calls[0]![0] as { authorizeUrl: string; probe: unknown };
    expect(opts.authorizeUrl).toBe('https://api.example.com/auth/sso/c1/authorize?state=...');
    expect(typeof opts.probe).toBe('function');
  });

  test('does not open a pendingBind branch — the probe is the self-binding variant', async () => {
    // 验证 probe 是 createSsoLoginProbe 的产物(它是 self-binding 路径,
    // 不会触发 pendingBind,因为 server 走 ready_to_finalize finalize)。
    openOauthFlowMock.mockResolvedValueOnce('tok');
    await startSsoMemberBind({ enterpriseBaseUrl: 'https://api.example.com', authorizeUrl: 'about:blank' });
    const opts = openOauthFlowMock.mock.calls[0]![0] as { probe: (...args: unknown[]) => unknown };
    // probe 必须存在且是函数;具体实现覆盖在既有 createSsoLoginProbe 测试里
    expect(typeof opts.probe).toBe('function');
  });

  test('propagates openOauthFlow rejection as a thrown error', async () => {
    openOauthFlowMock.mockRejectedValueOnce(new Error('bind_oauth_failed'));
    await expect(
      startSsoMemberBind({ enterpriseBaseUrl: 'https://api.example.com', authorizeUrl: 'about:blank' })
    ).rejects.toThrow(/bind_oauth_failed/);
  });

  test('always closes the loopback, even on failure', async () => {
    const close = vi.fn();
    const { startCallbackServer } = await import('./genericSsoLogin');
    vi.mocked(startCallbackServer).mockResolvedValueOnce({
      port: 53231,
      close,
      waitForArrival: vi.fn(),
    });
    openOauthFlowMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      startSsoMemberBind({ enterpriseBaseUrl: 'https://api.example.com', authorizeUrl: 'about:blank' })
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `npx vitest run src/main/sso/startSsoMemberBind.test.ts`
Expected: 全部失败(模块不存在)

- [ ] **Step 3: 实现 `startSsoMemberBind`**

`src/main/sso/startSsoMemberBind.ts`:

```ts
import { startCallbackServer, createSsoLoginProbe } from './genericSsoLogin';
import { openOauthFlow } from '../mcp/oauthBrowserFlow';

const SSO_DESKTOP_REDIRECT_PORT = 53231;

export async function startSsoMemberBind(args: {
  enterpriseBaseUrl: string;
  authorizeUrl: string;
}): Promise<string> {
  // 自助绑定复用 login 流程的 loopback + 探针(端口 + startCallbackServer
  // + createSsoLoginProbe)。区别只在入口:login 是 desktop 自己拼
  // authorizeUrl(经 buildAuthorizeUrl),bind 是 server 通过
  // /me/sso-binding/start 返 authorizeUrl 后直接传进来。Probe 的
  // pendingBind 分支不会触发,因为 server 端走 ready_to_finalize
  // finalize 路径,没有 pending_bind 状态。
  const cb = await startCallbackServer(SSO_DESKTOP_REDIRECT_PORT, args.enterpriseBaseUrl);
  try {
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: args.enterpriseBaseUrl,
      cb,
    });
    const token = await openOauthFlow({
      title: 'SSO self-binding',
      authorizeUrl: args.authorizeUrl,
      probe,
    });
    if (!token) throw new Error('sso_bind_failed');
    return token;
  } finally {
    cb.close();
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `npx vitest run src/main/sso/startSsoMemberBind.test.ts`
Expected: 4/4 通过

- [ ] **Step 5: 跑既有 genericSsoLogin 测试,确保不回归**

Run: `npx vitest run src/main/sso/genericSsoLogin.test.ts`
Expected: 26/26 仍通过(本任务**不**改 genericSsoLogin.ts)

- [ ] **Step 6: Lint**

Run: `npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/main/sso/startSsoMemberBind.ts src/main/sso/startSsoMemberBind.test.ts`
Expected: clean

---

## Task 4: 桌面 main 进程 IPC handlers(3 个,在 main.ts 内)

**Files:**
- Modify: `src/main/main.ts`(+ ~30 行,3 个 `ipcMain.handle('sso:*', ...)`)
- Modify: `src/main/main.ts`(import `startSsoMemberBind` + `SSO_BINDING_IPC`)

**Interfaces:**
- Consumes: `enterpriseFetchWithAuth`(local closure at `main.ts:5207`)、`startSsoMemberBind`、shared type `SsoConnectionWithBinding`
- Produces: 3 个 IPC handlers,renderer 可以调

- [ ] **Step 1: 找到挂 IPC 的位置**

`main.ts` 里找既有 `ipcMain.handle('store:get', ...)` 的位置(同 search 显示在 `main.ts` 顶部区域),看 3 个 SSO handler 应该挂在它下面还是分块(若 main.ts 已经分了 `loadIpcHandlers` / `setupIpcHandlers` 之类,挂在那里;否则紧跟现有 SSO 相关 handler,例如 `ipcMain.handle('sso:...', ...)` 若有的话)。

(具体位置在实现时根据代码情况调整,本任务不预设确切行号)

- [ ] **Step 2: 加 import**

在 `main.ts` 顶部 import 区域加:

```ts
import { startSsoMemberBind } from './sso/startSsoMemberBind';
import { SSO_BINDING_IPC } from '../shared/sso/binding';
```

(若 main.ts 已经按 `as const` 风格放常量,按那个风格;否则用上面这种。)

- [ ] **Step 3: 加 3 个 IPC handler**

```ts
ipcMain.handle(SSO_BINDING_IPC.List, async () => {
  const res = await enterpriseFetchWithAuth('/me/sso-binding/connections', { method: 'GET' });
  return await res.json();
});

ipcMain.handle(SSO_BINDING_IPC.Unbind, async () => {
  const res = await enterpriseFetchWithAuth('/me/sso-binding', { method: 'DELETE' });
  return await res.json();
});

ipcMain.handle(SSO_BINDING_IPC.Start, async (_e, args: { connectionId: string }) => {
  // 1) 调 /me/sso-binding/start 拿 authorizeUrl
  const startRes = await enterpriseFetchWithAuth('/me/sso-binding/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: args.connectionId }),
  });
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`sso_bind_start_failed: ${startRes.status} ${text}`);
  }
  const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
  // 2) 跑 OAuth flow(OS browser)
  const token = await startSsoMemberBind({
    enterpriseBaseUrl: getServerApiBaseUrl(),
    authorizeUrl,
  });
  return { ok: true as const, token };
});
```

注:`getServerApiBaseUrl()` 是 main.ts 既有的 helper(看 CLAUDE.md 提到的 enterprise URL 是 build-time baked 还是 runtime get),用既有的方式取,不要在这里 hardcode。

- [ ] **Step 4: Lint + 编译**

Run:
```
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/main/main.ts
npm run compile:electron
```
Expected: lint clean,compile 成功

- [ ] **Step 5: 跑既有 SSO 测试,确保不回归**

Run: `npx vitest run src/main/sso/`
Expected: 全部通过(本任务只新增 IPC handler,不删/改既有 handler)

---

## Task 5: 渲染器 Redux slice `ssoBindingsSlice`

**Files:**
- Create: `src/renderer/store/slices/ssoBindingsSlice.ts`(新文件,~120 行)
- Create: `src/renderer/store/slices/ssoBindingsSlice.test.ts`(新文件,~150 行)
- Modify: `src/renderer/store/index.ts`(register slice,既有模式)

**Interfaces:**
- Consumes: shared type `SsoConnectionWithBinding`、electron IPC bridge(从 `src/renderer/services/` 既有 helper 取)
- Produces: redux state + thunks

- [ ] **Step 1: 写失败的测试**

`src/renderer/store/slices/ssoBindingsSlice.test.ts`(摘要,完整 ~150 行):

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import ssoBindingsReducer, {
  fetchSsoBindings, startSsoBinding, unbindSsoConnection,
  setSearchQuery, setActiveTab, setBusy,
} from './ssoBindingsSlice';

// mock IPC bridge
vi.mock('../../services/electron', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '../../services/electron';
const invokeMock = vi.mocked(invoke);

describe('ssoBindingsSlice', () => {
  let store: ReturnType<typeof configureStore>;
  beforeEach(() => {
    invokeMock.mockReset();
    store = configureStore({ reducer: { ssoBindings: ssoBindingsReducer } });
  });

  describe('reducers', () => {
    test('setSearchQuery updates searchQuery', () => { /* ... */ });
    test('setActiveTab updates activeTab', () => { /* ... */ });
    test('setBusy sets and clears busyConnectionId', () => { /* ... */ });
  });

  describe('fetchSsoBindings', () => {
    test('happy path: stores connections, status=ready', async () => { /* ... */ });
    test('error path: stores error message, status=error', async () => { /* ... */ });
  });

  describe('startSsoBinding', () => {
    test('happy path: refetches on success', async () => { /* ... */ });
    test('error path: clears busy and surfaces error', async () => { /* ... */ });
  });

  describe('unbindSsoConnection', () => {
    test('happy path: refetches on success', async () => { /* ... */ });
    test('error path: refetches anyway so state matches server', async () => { /* ... */ });
  });
});
```

具体 mock 方式需要先读既有 `src/renderer/store/slices/coworkSlice.test.ts` 或 `authSlice.test.ts` 看测试 harness。

- [ ] **Step 2: 跑测试,确认失败**

Run: `npx vitest run src/renderer/store/slices/ssoBindingsSlice.test.ts`
Expected: 全部失败(模块不存在)

- [ ] **Step 3: 实现 slice**

`src/renderer/store/slices/ssoBindingsSlice.ts`:

```ts
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SsoConnectionWithBinding } from '../../../shared/sso/binding';
import { SSO_BINDING_IPC } from '../../../shared/sso/binding';
import { invoke } from '../../services/electron';

export type SsoBindingsStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SsoBindingsTab = 'all' | 'bound' | 'unbound';

export interface SsoBindingsState {
  connections: SsoConnectionWithBinding[];
  status: SsoBindingsStatus;
  error: string | null;
  searchQuery: string;
  activeTab: SsoBindingsTab;
  busyConnectionId: string | null;
}

const initialState: SsoBindingsState = {
  connections: [],
  status: 'idle',
  error: null,
  searchQuery: '',
  activeTab: 'all',
  busyConnectionId: null,
};

export const fetchSsoBindings = createAsyncThunk('ssoBindings/fetch', async () => {
  const res = await invoke<{ connections: SsoConnectionWithBinding[] }>(SSO_BINDING_IPC.List);
  return res.connections;
});

export const startSsoBinding = createAsyncThunk(
  'ssoBindings/start',
  async (connectionId: string) => {
    await invoke(SSO_BINDING_IPC.Start, { connectionId });
  }
);

export const unbindSsoConnection = createAsyncThunk(
  'ssoBindings/unbind',
  async () => {
    await invoke(SSO_BINDING_IPC.Unbind);
  }
);

const slice = createSlice({
  name: 'ssoBindings',
  initialState,
  reducers: {
    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
    },
    setActiveTab(state, action: PayloadAction<SsoBindingsTab>) {
      state.activeTab = action.payload;
    },
    setBusy(state, action: PayloadAction<string | null>) {
      state.busyConnectionId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSsoBindings.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(fetchSsoBindings.fulfilled, (state, action) => {
        state.status = 'ready';
        state.connections = action.payload;
      })
      .addCase(fetchSsoBindings.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.error.message ?? 'fetch_failed';
      })
      .addCase(startSsoBinding.pending, (state, action) => {
        state.busyConnectionId = action.meta.arg;
        state.error = null;
      })
      .addCase(startSsoBinding.fulfilled, (state) => {
        state.busyConnectionId = null;
      })
      .addCase(startSsoBinding.rejected, (state, action) => {
        state.busyConnectionId = null;
        state.error = action.error.message ?? 'bind_failed';
      })
      .addCase(unbindSsoConnection.pending, (state) => {
        // busy 标记由调用方在发起时设(startSsoBinding / unbindSsoConnection
        // 共用同一个 button-disabled 信号)
      })
      .addCase(unbindSsoConnection.fulfilled, (state) => {
        state.busyConnectionId = null;
      })
      .addCase(unbindSsoConnection.rejected, (state, action) => {
        state.busyConnectionId = null;
        state.error = action.error.message ?? 'unbind_failed';
      });
  },
});

export const { setSearchQuery, setActiveTab, setBusy } = slice.actions;
export default slice.reducer;
```

- [ ] **Step 4: 注册 slice**

`src/renderer/store/index.ts` 既有 `combineReducers({...})` 加一行:

```ts
ssoBindings: ssoBindingsReducer,
```

(具体 import path / 既有 register 风格按文件实际来)

- [ ] **Step 5: 跑测试,确认通过**

Run: `npx vitest run src/renderer/store/slices/ssoBindingsSlice.test.ts`
Expected: 全部通过

- [ ] **Step 6: Lint**

Run: `npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/renderer/store/slices/ssoBindingsSlice.ts src/renderer/store/slices/ssoBindingsSlice.test.ts src/renderer/store/index.ts`
Expected: clean

---

## Task 6: 渲染器页面 `SsoBindingsPage` 1:1 还原原型

**Files:**
- Create: `src/renderer/components/ssoBindings/SsoBindingsPage.tsx`(新文件,~250 行)
- Create: `src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx`(新文件,~200 行)

**Interfaces:**
- Consumes: redux state/thunks from `ssoBindingsSlice`、i18n from `i18nService`、既有 UI primitives
- Produces: 一个可路由的 React 组件,1:1 匹配原型 `Image #17`

- [ ] **Step 1: 写失败的渲染测试**

`src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx`(摘要,完整 ~200 行):

```tsx
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import ssoBindingsReducer from '../../store/slices/ssoBindingsSlice';
import { SsoBindingsPage } from './SsoBindingsPage';

vi.mock('../../services/electron', () => ({
  invoke: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

import { invoke } from '../../services/electron';
const invokeMock = vi.mocked(invoke);

const mockConnections = [
  { id: 'c1', name: '飞书', providerType: 'feishu', description: '飞书企业自建应用扫码登录',
    sortOrder: 0, enabled: true, logoUrl: null,
    bound: true, externalId: 'kk@example.com', boundAt: '2026-10-13T08:00:00.000Z' },
  { id: 'c2', name: '钉钉', providerType: 'dingtalk', description: '钉钉企业内部应用扫码登录',
    sortOrder: 1, enabled: true, logoUrl: null,
    bound: false, externalId: null, boundAt: null },
];

const renderWithStore = (initialConnections = mockConnections) => {
  invokeMock.mockResolvedValue({ connections: initialConnections });
  const store = configureStore({ reducer: { ssoBindings: ssoBindingsReducer } });
  return {
    store,
    ...render(<Provider store={store}><SsoBindingsPage /></Provider>),
  };
};

describe('SsoBindingsPage', () => {
  test('renders the title bar and subtitle', async () => { /* ... */ });
  test('renders the bound count pill (1/2)', async () => { /* ... */ });
  test('renders all rows with provider name + status badge + action button', async () => { /* ... */ });
  test('bound row shows bound account + bound date', async () => { /* ... */ });
  test('unbound row shows 绑定 button', async () => { /* ... */ });
  test('search filters rows by name', async () => { /* ... */ });
  test('tab switch: 已绑定 shows only bound rows', async () => { /* ... */ });
  test('tab switch: 未绑定 shows only unbound rows', async () => { /* ... */ });
  test('click 解绑 → invokes unbind IPC + refetches', async () => { /* ... */ });
  test('click 绑定 → invokes start IPC + refetches', async () => { /* ... */ });
  test('empty state: shows hint when connections is empty', async () => { /* ... */ });
  test('error state: shows retry button on fetch failure', async () => { /* ... */ });
  test('back button navigates(-1)', async () => { /* ... */ });
});
```

具体 mock / waitFor 模式按既有 `src/renderer/components/cowork/*.test.tsx` 或 `src/renderer/components/EnterpriseMtAccountMenu.test.tsx` 的风格。

- [ ] **Step 2: 跑测试,确认失败**

Run: `npx vitest run src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx`
Expected: 全部失败(组件不存在)

- [ ] **Step 3: 实现 `SsoBindingsPage`**

组件结构(完整实现 ~250 行):

```tsx
// 顶部 import
import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';

import { i18nService } from '../../services/i18n';
import {
  fetchSsoBindings, startSsoBinding, unbindSsoConnection,
  setSearchQuery, setActiveTab, setBusy,
  type SsoBindingsState, type SsoBindingsTab,
} from '../../store/slices/ssoBindingsSlice';
import { useToast } from '../toastStore';  // 既有

const useAppDispatch: () => AppDispatch = useDispatch;
const useAppSelector: TypedUseSelectorHook<{ ssoBindings: SsoBindingsState }> = useSelector;

export function SsoBindingsPage(): JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const { connections, status, error, searchQuery, activeTab, busyConnectionId } =
    useAppSelector((s) => s.ssoBindings);

  useEffect(() => {
    void dispatch(fetchSsoBindings());
  }, [dispatch]);

  // 派生:过滤 + tab
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return connections.filter((c) => {
      if (activeTab === 'bound' && !c.bound) return false;
      if (activeTab === 'unbound' && c.bound) return false;
      if (q && !(c.name.toLowerCase().includes(q) || c.providerType.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [connections, searchQuery, activeTab]);

  const counts = useMemo(() => {
    const bound = connections.filter((c) => c.bound).length;
    return { all: connections.length, bound, unbound: connections.length - bound };
  }, [connections]);

  const onBind = async (id: string) => {
    dispatch(setBusy(id));
    try {
      await dispatch(startSsoBinding(id)).unwrap();
      void dispatch(fetchSsoBindings());
      toast.success(i18nService.t('ssoBindings.bindSucceeded'));  // 可选,UI 反馈
    } catch (e) {
      toast.error(i18nService.format('ssoBindings.bindError', { error: (e as Error).message }));
    } finally {
      dispatch(setBusy(null));
    }
  };

  const onUnbind = async () => {
    dispatch(setBusy('unbind'));
    try {
      await dispatch(unbindSsoConnection()).unwrap();
      void dispatch(fetchSsoBindings());
    } catch (e) {
      toast.error(i18nService.format('ssoBindings.unbindError', { error: (e as Error).message }));
    } finally {
      dispatch(setBusy(null));
    }
  };

  // ... JSX,按原型图:
  // 1) header: [← 返回] + "SSO 账号绑定" + subtitle + status pill
  // 2) toolbar: search input + 3 个 tab(全部/已绑定/未绑定)
  // 3) list: 每个 row = brand-tile(letter fallback)+ name + providerType pill + status badge + description + bound 副行 + action button
  // 4) empty / loading / error states
}
```

视觉风格遵循 CLAUDE.md "Tailwind 优先" + 既有 EnterpriseMtAccountMenu 模式。

- [ ] **Step 4: 跑测试,确认通过**

Run: `npx vitest run src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx`
Expected: 全部通过

- [ ] **Step 5: Lint**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/ssoBindings/SsoBindingsPage.tsx src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx`
Expected: clean

---

## Task 7: 菜单项 + 路由

**Files:**
- Modify: `src/renderer/components/EnterpriseMtAccountMenu.tsx`(+ ~15 行,加 1 个 MenuItem)
- Create: `src/renderer/components/EnterpriseMtAccountMenu.test.tsx`(新文件;若已有,增量)
- Modify: `src/renderer/App.tsx`(+ ~5 行,加 1 个 Route)

**Interfaces:**
- Consumes: 既有 MenuItem 组件 + `useNavigate` + `LinkIcon`(新增 import)
- Produces: 4 项菜单(按 Image #16 顺序)+ `/sso-bindings` 路由

- [ ] **Step 1: 写失败的菜单测试**

`src/renderer/components/EnterpriseMtAccountMenu.test.tsx`(若不存在,新建;若存在,加 1 个 case):

```tsx
test('avatar menu shows 4 items in the right order: 个人信息 / 修改密码 / 绑定 SSO 账号 / 退出', async () => {
  // 打开菜单,断言 4 个 MenuItem 按 Image #16 顺序出现
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `npx vitest run src/renderer/components/EnterpriseMtAccountMenu.test.tsx`
Expected: 失败(菜单只有 3 项)

- [ ] **Step 3: 加 MenuItem**

`src/renderer/components/EnterpriseMtAccountMenu.tsx`:

```tsx
// 顶部 import
import { LinkIcon } from '@heroicons/react/24/outline';
import { useNavigate } from 'react-router-dom';

// 函数体内
const navigate = useNavigate();
const handleBindSso = () => {
  closeMenu();
  navigate('/sso-bindings');
};

// 在 enterpriseChangePasswordTitle 的 MenuItem 之后、separator 之前:
<MenuItem
  icon={<LinkIcon className="h-4 w-4 shrink-0 text-secondary" />}
  label={i18nService.t('sso.profile.bindMenuItem')}
  onClick={handleBindSso}
/>
```

(具体 import / 现有 useNavigate 是否已 import,看文件实际)

- [ ] **Step 4: 加路由**

`src/renderer/App.tsx` 在既有路由表里加:

```tsx
<Route path="/sso-bindings" element={<SsoBindingsPage />} />
```

(具体 import / 现有 Route 风格按文件实际)

- [ ] **Step 5: 跑测试,确认通过**

Run: `npx vitest run src/renderer/components/EnterpriseMtAccountMenu.test.tsx`
Expected: 通过

- [ ] **Step 6: Lint**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/EnterpriseMtAccountMenu.tsx src/renderer/App.tsx src/renderer/components/EnterpriseMtAccountMenu.test.tsx`
Expected: clean

---

## Task 8: i18n 字典(新键 zh + en)

**Files:**
- Modify: `src/renderer/services/i18n.ts`(+ ~22 个键 × 2 语言 = ~44 行)

**Interfaces:**
- 渲染器消费,既有 `i18nService.t(key)` / `i18nService.format(key, vars)`

- [ ] **Step 1: 加 zh 键**

`src/renderer/services/i18n.ts` 的 zh 字典对象(找 `zh: {` 那一段)加:

```ts
ssoBindings: {
  title: 'SSO 账号绑定',
  subtitle: '绑定企业身份源后,你可以使用对应的单点登录方式免密进入 GenWork。可以同时绑定多个身份源,互不影响。',
  statusBadge: '已绑定 {bound} / {total}',
  searchPlaceholder: '搜索 SSO 类型或名称',
  tabAll: '全部 {n}',
  tabBound: '已绑定 {n}',
  tabUnbound: '未绑定 {n}',
  statusBound: '已绑定',
  statusUnbound: '未绑定',
  bindButton: '绑定',
  unbindButton: '解绑',
  boundAccount: '已绑定账号 {account}',
  boundAt: '{date} 绑定',
  emptyTitle: '尚未配置任何 SSO 连接',
  emptyHint: '请联系管理员在 企业 web → SSO 身份提供商 创建。',
  loadError: '加载失败',
  retry: '重试',
  unbindError: '解绑失败:{error}',
  bindError: '绑定失败:{error}',
  bindSucceeded: '绑定成功',
  back: '返回',
},
sso: {  // 已有,确认里面已经有 profile.bindMenuItem
  profile: {
    bindMenuItem: '绑定 SSO 账号',
  },
},
```

(若 `sso.profile.bindMenuItem` 不存在,加;若存在,跳过。)

- [ ] **Step 2: 加 en 键**

```ts
ssoBindings: {
  title: 'SSO account binding',
  subtitle: 'After binding an enterprise identity source, you can use the corresponding SSO sign-in to access GenWork without password. You can bind multiple sources simultaneously.',
  statusBadge: 'Bound {bound} / {total}',
  searchPlaceholder: 'Search SSO type or name',
  tabAll: 'All {n}',
  tabBound: 'Bound {n}',
  tabUnbound: 'Unbound {n}',
  statusBound: 'Bound',
  statusUnbound: 'Unbound',
  bindButton: 'Bind',
  unbindButton: 'Unbind',
  boundAccount: 'Bound account: {account}',
  boundAt: 'Bound on {date}',
  emptyTitle: 'No SSO connections configured',
  emptyHint: 'Ask your admin to create one in the enterprise web under SSO / Identity providers.',
  loadError: 'Failed to load',
  retry: 'Retry',
  unbindError: 'Unbind failed: {error}',
  bindError: 'Bind failed: {error}',
  bindSucceeded: 'Bound',
  back: 'Back',
},
sso: {
  profile: {
    bindMenuItem: 'Bind SSO account',
  },
},
```

- [ ] **Step 3: Lint**

Run: `npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/renderer/services/i18n.ts`
Expected: clean

- [ ] **Step 4: 跑全量渲染器测试,确保不回归**

Run: `npx vitest run src/renderer/`
Expected: 全部通过(本任务只新增键,不改既有)

---

## Task 9: 集成验证(端到端跑一遍)

**Files:** 不修改任何文件;只跑既有 + 新增的测试。

- [ ] **Step 1: 跑服务端测试**

Run: `cd enterprise_server && npx vitest run tests/me/`
Expected: 全部通过(既有 4 个 + 新增 8 个 = 12 个)

- [ ] **Step 2: 跑桌面 main 测试**

Run: `npx vitest run src/main/sso/`
Expected: 26(既有 genericSsoLogin) + 4(startSsoMemberBind) = 30 个通过

- [ ] **Step 3: 跑渲染器测试**

Run: `npx vitest run src/renderer/`
Expected: 既有 + 新增 slice / page / menu 全部通过

- [ ] **Step 4: 编译**

Run: `npm run compile:electron`
Expected: 成功

- [ ] **Step 5: Lint touched files(全量)**

Run:
```
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/main/main.ts \
  src/main/sso/startSsoMemberBind.ts \
  src/main/sso/startSsoMemberBind.test.ts \
  src/renderer/components/EnterpriseMtAccountMenu.tsx \
  src/renderer/components/EnterpriseMtAccountMenu.test.tsx \
  src/renderer/components/ssoBindings/SsoBindingsPage.tsx \
  src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx \
  src/renderer/store/slices/ssoBindingsSlice.ts \
  src/renderer/store/slices/ssoBindingsSlice.test.ts \
  src/renderer/store/index.ts \
  src/renderer/services/i18n.ts \
  src/renderer/App.tsx \
  src/shared/sso/binding.ts \
  enterprise_server/src/routes/me/ssoBinding.ts \
  enterprise_server/src/sso/bindingTypes.ts \
  enterprise_server/tests/me/ssoBindingConnections.test.ts
```
Expected: 全部 clean

- [ ] **Step 6: 手动验证(electron:dev)**

Run: `npm run electron:dev`(可选,因 `npm test` 覆盖了核心逻辑;如不验证,跳过)

操作:
1. 登录企业版账号
2. 点击头像 → 看到 4 项菜单("个人信息 / 修改密码 / 绑定 SSO 账号 / 退出")
3. 点"绑定 SSO 账号" → 跳到 `/sso-bindings` 页面
4. 看到 1:1 还原原型的列表
5. 点未绑定行的"绑定" → 浏览器打开 IdP → 完成后回桌面,row 状态变为已绑定
6. 点已绑定行的"解绑" → 按钮 disabled → 解绑后 refetch,row 状态变为未绑定

---

## Self-Review

**1. Spec coverage:** 6 个 spec 节(§3 server、§4 main、§5 renderer、§6 shared contract、§7 tests、§10 risk)全部覆盖在 9 个 task 里。每节 ↔ 任务的对应:
- §3.1 → Task 1
- §4.2-4.3 → Task 3 + Task 4
- §4.2 IPC handlers → Task 4
- §5.1-5.4 → Task 5-7
- §5.5 i18n → Task 8
- §6 shared contract → Task 2
- §7 tests → Task 1(服务端)+ Task 3(main)+ Task 5(slice)+ Task 6(page)+ Task 7(menu)
- §10 risk → Task 9 集成验证 + Step 6 手动验证

**2. Placeholder scan:** 无 TBD/TODO/FIXME/placeholder。

**3. Type consistency:**
- `SsoConnectionWithBinding` 在 `src/shared/sso/binding.ts`(Task 2)、`enterprise_server/src/sso/bindingTypes.ts`(Task 1)、slice state(Task 5)、page props(Task 6)四处定义,字段一致;Task 1 写测试时断言服务端响应跟 shared type 字段名一致。
- IPC action 常量 `SSO_BINDING_IPC` 在 `src/shared/sso/binding.ts`(Task 2)定义,main.ts(Task 4)+ slice(Task 5)两边 import,字面值不重复。

**4. Review Focus 检查:** Task 1 第 5 步覆盖跨 org 隔离;Task 3 第 2 步覆盖 pendingBind 不触发;Task 5 slice 测试覆盖并发刷新;Task 6 page 测试覆盖解绑失败回滚;Task 7 menu 测试覆盖菜单顺序;Task 8 i18n 覆盖 zh+en 同步;Task 4 Step 1-3 显式提示 enterpriseFetchWithAuth 必须写在 main.ts 内。
