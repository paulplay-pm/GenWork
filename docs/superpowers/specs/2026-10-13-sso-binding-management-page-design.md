# SSO 账号绑定管理页（桌面端） — 设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GenWork 桌面端的用户头像菜单里增加"绑定 SSO 账号"入口,打开一个新的桌面内嵌管理页（1:1 还原原型图 `Image #17`）,展示本组织所有可用的 SSO 连接、当前用户的绑定状态、已绑定的账号与时间,并支持绑定/解绑操作。

**Architecture:** 三层改动——服务端加一个新端点列出"连接 × 当前用户绑定状态"组合视图;桌面主进程扩展 IPC + 复用既有 OAuth 流程;桌面渲染器加新页面/路由/Slice/菜单项。i18n 同步新增键。已存在的 enterprise web 头像菜单 + `/me/sso-binding` POST/DELETE + migration 043 不动。

**Tech Stack:** Electron + React + Redux Toolkit + Tailwind（桌面） / Hono + Zod + node-postgres（服务端） / i18n 字典（双方各自维护）

**Spec anchor:** 本 spec 与既有 `docs/superpowers/specs/2026-10-12-sso-prebinding-and-allowlist-design.md` 是互补关系——后者定义"用户自助绑定"的**能力**(server endpoints + enterprise web 入口 + 数据库列),本 spec 定义"桌面端**也**要有这个能力,以及**长什么样**"。

## Global Constraints

- Node.js `>=24.15.0 <25`。
- ESLint touched files clean: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`。
- Per-file vitest,因 sandbox fd 限制。
- i18n 同步 zh + en(`src/renderer/services/i18n.ts` + `src/main/i18n.ts`)。
- Conventional Commits 英文,无 `Co-Authored-By` 尾签,无 push。
- 字符串常量集中(`as const`),不裸字面量比较。
- 复用既有 helpers:`enterpriseFetchWithAuth`、`openOauthFlow`、`createSsoLoginProbe`、`authService`、redux store 既有 slices。
- 不在既有大文件(`genericSsoLogin.ts`, `main.ts`, `App.tsx`)里堆新逻辑;新功能要么进新文件,要么先提议 focused extraction。

## Review Focus

- 服务端新端点不会泄露其他 org 的 SSO 连接(跨 org 隔离)。
- 桌面 OAuth 流程复用 `openOauthFlow` 时,probe 的 pendingBind 分支不会触发(用户已登录,走的是 `ready_to_finalize` 路径)。
- 渲染器搜索/标签过滤的"未绑定 N"计数,在并发刷新时不会出现 negative 或 stale 值。
- 解绑流程在网络失败时不留 UI 假象(按钮恢复 + 错误 toast + 回滚 row state)。
- 既有企业版头像菜单的菜单项顺序不破坏(只在 退出 上方插入新项)。
- i18n 键不漏 zh,新增键同时填 en。

---

## 1. 背景与动机

既有 SSO 用户自助绑定流程由 `feat/sso-user-self-binding` 系列 commit(`299aa8d`/`9f561d9`/`0747b8e`/`1359d8d`)落到 `main`:

- 服务端:`POST /me/sso-binding/start`(开始绑定)/ `DELETE /me/sso-binding`(解绑)/ `GET /admin/users/:id/sso-binding`(admin 读)/ `DELETE /admin/users/:id/sso-binding`(admin 解绑)/ `GET /admin/sso-connections/:id/bindings`(admin 列表)。
- 企业 web 头像菜单已有"绑定 SSO 账号"项(`UserMenu.tsx` 的 `SsoBindModal`),但它是个**简单弹窗**——只列 provider,点一个就开始 OAuth,绑定后由 web 回调处理。
- 数据库列 `users.sso_connection_id` / `users.sso_external_id` / `users.sso_bound_at` 已有(migration 043)。

**缺口**:
1. **桌面端**头像菜单(图片 `Image #15`)没有"绑定 SSO 账号"项,用户无法在桌面里管理自己的 SSO 绑定。
2. **没有"我绑了哪些 + 可以绑哪些"的统一视图**。企业 web 的 modal 只列"可以绑的";要看"已绑定的详情/解绑"得另找地方(spec §7.3 的"已绑定:<name>·解绑"目前**未实现**,被 §6.2 + §7.3 的 GET 端点划掉了)。
3. 原型图 `Image #17` 是**完整管理页**(搜索/标签/全列表/每行 解绑 或 绑定),需要新建。

**目标**:
- 桌面头像菜单(图片 `Image #15`)增加"绑定 SSO 账号"项,点击后跳到新页面。
- 新页面 1:1 还原原型图 `Image #17`。
- 服务端补一个 `GET /me/sso-binding/connections` 端点,返回"全 org 启用连接 × 当前用户绑定状态"组合。
- 绑定/解绑动作直接复用既有 `/me/sso-binding` POST/DELETE + `openOauthFlow` 流程。

**非目标(Out of scope)**:
- 不动既有 `/me/sso-binding/start` 与 `DELETE /me/sso-binding`。
- 不动既有 enterprise web 的 `SsoBindModal`(它是给企业 web 用户用的;桌面是另一个表面)。
- 不动 migration 043 已有列。
- 不做"管理员强解/批量操作"——已由 `feat/sso-user-self-binding` 系列 commit 在 admin 端实现。
- 不做"审计日志"UI——`auditStore` 已记录 `sso_user_self_unbound` 等动作,本 spec 不暴露给用户。

---

## 2. 数据模型

**无新列,无新表**。复用 migration 043 的 `users.sso_connection_id` / `users.sso_external_id` / `users.sso_bound_at`(`TIMESTAMPTZ`)。

唯一需要的服务端 view(在 SQL 里现拼,不在表里持久化):

```sql
SELECT
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
ORDER BY c.sort_order ASC, c.name ASC;
```

(`$1` = `claims.sub`,`$2` = `claims.orgId`)

---

## 3. 服务端变更(enterprise_server)

### 3.1 新端点 `GET /me/sso-binding/connections`

**位置**:追加到 `enterprise_server/src/routes/me/ssoBinding.ts`(既有,同文件加一个 GET)。

**鉴权**:`requireAuth`(任意已登录 user,跟既有 POST/DELETE 一致)。

**Org 隔离**:`WHERE c.org_id = $2` 强制按调用者 org 过滤。`requireAuth` 中间件已经在 `claims` 上放好 `orgId`。

**响应 200**:

```ts
type SsoConnectionWithBinding = {
  id: string;            // sso_connections.id
  name: string;          // sso_connections.name (e.g. "飞书")
  providerType: string;  // e.g. "feishu", "oidc", "saml2"
  description: string | null;  // sso_connections.description
  sortOrder: number;     // sso_connections.sort_order
  enabled: boolean;      // sso_connections.enabled (always true here)
  logoPath: string | null;  // sso_connections.logo_path,server 自己拼成绝对 URL 后再返
  bound: boolean;        // 当前 user 是否已绑此 connection
  externalId: string | null;  // 绑定的 IdP 外部账号
  boundAt: string | null;     // ISO 8601 字符串,绑定时间
};

type SsoConnectionsWithBindingsResponse = {
  connections: SsoConnectionWithBinding[];
};
```

**字段对齐**:
- 复用 `sso_connections` 表结构(spec 2026-10-12 §3 已有)。
- `logoPath` 在响应里**改名为 `logoUrl`**,server 把它拼成绝对 URL(`${origin}/auth/sso/providers/${id}/logo`),桌面直接用。**不**直接暴露 `logoPath` 路径,避免桌面拼错 base。
- `boundAt` 用 ISO 8601 字符串(用 `Date.prototype.toISOString()`),不返 raw timestamptz。
- `description` 可空,空时桌面 fallback 到 `""` + 一行占位文案。

**错误**:
- 401:未登录(由 `requireAuth` 抛)。
- 500:DB 异常(让 Hono 默认 handler 处理)。

**Edge case**:
- 用户没有任何 SSO 连接(新 org):返 `{ connections: [] }`,200。
- 用户的 `users` row 存在但 `sso_connection_id IS NULL`:每个 connection 的 `bound` 都是 false,`externalId` / `boundAt` 是 null。

### 3.2 既有端点不动

`POST /me/sso-binding/start` 与 `DELETE /me/sso-binding` 行为不变(已 ship 在 `0747b8e`)。

### 3.3 不动 admin 端点

`GET /admin/users/:id/sso-binding` / `DELETE /admin/users/:id/sso-binding` / `GET /admin/sso-connections/:id/bindings` 不动(已 ship 在 `9f561d9`)。

---

## 4. 桌面端 main 进程变更

### 4.1 既有代码盘点

- `src/main/sso/genericSsoLogin.ts`:**大文件**(目前 ~880 行),含 `startCallbackServer` / `pendingBindHtml` / `bindSuccessHtml` / `bindErrorHtml` / `startSsoMemberLogin` / `createSsoLoginProbe`。
- `src/main/mcp/oauthBrowserFlow.ts`:`openOauthFlow`(已有,540+ 行测试覆盖),参数有 `probe`、`onLoaded`、`pollIntervalMs`、`timeoutMs`、`width`、`height`。
- `src/main/libs/enterpriseFetch.ts`(CLAUDE.md 提到的 `enterpriseFetchWithAuth`):实际定义在 `src/main/main.ts:5207` 的 local arrow function,所有到 enterprise server 的请求都走它,带 org JWT。**注意**:`enterpriseFetchWithAuth` 当前是 `main.ts` 内的 local closure,不在 `libs/`,被多个 IPC handler 通过 closure 捕获(`main.ts:6606/6669/6712/6724` 等)。新 IPC handler 需要 import 或在 `main.ts` 同一闭包内注册(见 §4.2)。

### 4.2 IPC 新增(在 `main.ts` 内注册,放到既有 `loadIpcHandlers` 同位置)

**重要**:`enterpriseFetchWithAuth` 是 `main.ts:5207` 的 local closure,不能跨文件 import。本 spec 也不把它提取出来(那是独立 refactor)。新增的 IPC handler **必须写在 `main.ts` 内部**,跟 `store:get` / `enterprise:getConfig` / `app:relaunch` 等既有 handler 同一位置。`src/main/sso/` 下不放 IPC handler 文件。

```ts
// 在 main.ts 内,跟既有 ipcMain.handle('store:get', ...) 同一块
ipcMain.handle('sso:listMyBindings', async () => {
  return await enterpriseFetchWithAuth('/me/sso-binding/connections', { method: 'GET' });
});

ipcMain.handle('sso:unbindMyConnection', async () => {
  return await enterpriseFetchWithAuth('/me/sso-binding', { method: 'DELETE' });
});

ipcMain.handle('sso:startMyBinding', async (_e, args: { connectionId: string }) => {
  // 1) POST /me/sso-binding/start → { authorizeUrl }
  const start = await enterpriseFetchWithAuth('/me/sso-binding/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: args.connectionId }),
  });
  // 2) 跑 OAuth flow(OS browser)
  const token = await startSsoMemberBind({ authorizeUrl: start.authorizeUrl });
  return { ok: true as const, token };
});
```

`startSsoMemberBind` 函数定义在新文件 `src/main/sso/startSsoMemberBind.ts`,import 进 `main.ts` 即可。

### 4.3 `startSsoMemberBind` 提取

**问题**:`startSsoMemberLogin` 是 login 流程,跟 server 的 `pendingBind` 路径深度耦合(`createSsoLoginProbe` 有 token / pendingBind / error 三个分支,login 流程用全部分支)。Bind 流程:
- 用户已登录,不会触发 `pendingBind`(server `ready_to_finalize` finalize 路径走的是 console 模式回调,**不**走 desktop loopback 的 `?code=…&state=` 路径)。
- 只需要等 `?token=` 出现在 loopback 上(server 端 `ready_to_finalize` finalize 后会重定向到 `redirectUri` 带 `?token=`)。

**做法**:从 `genericSsoLogin.ts` 提取一个共享的 `createSsoLoginProbe`(已经是 exported 的,在 `genericSsoLogin.ts:705` 那一段),但**不**改它的三分支行为。**新建** `src/main/sso/startSsoMemberBind.ts`,它:

- 调 `startCallbackServer(53231, enterpriseBaseUrl)`(同 login)。
- 调 `openOauthFlow`:`probe = createSsoLoginProbe({ enterpriseBaseUrl, cb })`(同 login)。Probe 的 pendingBind 分支在 bind 场景**不会**触发,因为 self-binding 在 server 端走的是 `ready_to_finalize` finalize,而不是 `pending_bind`。
- 等待 token 返回。

`startSsoMemberLogin` 与 `startSsoMemberBind` 的差异:
- login:**不传** connectionId/return 形参,server 用 `return=desktop` 拼 authorizeUrl。
- bind:由 IPC 层先调 `POST /me/sso-binding/start` 拿 `authorizeUrl`,直接传进 bind 流程。

**为什么拆文件而不是在 `genericSsoLogin.ts` 里加函数**:
- 该文件已 880 行(CLAUDE.md "Legacy Debt And Large Files" 红线)。
- bind 流程调用栈短,函数体小,放在独立文件里更清楚;`startSsoMemberLogin` 不动。
- 既有 26 个测试保持原样。

### 4.4 端口复用

bind 流程也用 53231 端口(同 login)。`openOauthFlow` 内部用临时 partition,不会跟 login 冲突。`startCallbackServer` 启动时若端口被占用会 reject,跟 login 走同一条错误处理路径。

**风险**:同时跑 login 和 bind 是不可能的(用户同一时刻只能在一个 surface),所以端口竞争不存在。

### 4.5 深链与回调

bind 流程的 OAuth 完成后,server `ready_to_finalize` finalize 重定向浏览器到 `redirectUri`,desktop loopback 收 `?token=`,跟 login 走同一条 settle 路径。**不**复用 `bindSuccessHtml`(那个是给 strict-mode 二次绑定用的,本流程的 user 早已 active,不会出现 strict-mode 路径)。

**不**走 `genwork://` deep link(那个是给"绑定完成后让用户回到桌面"用的,本流程用户本来就在桌面里,不需要切窗口)。

---

## 5. 桌面端 renderer 变更

### 5.1 路由

新路由 `/sso-bindings`,挂到 `App.tsx` 的既有 router(同 `/profile` 之类的页面并列):

```tsx
<Route path="/sso-bindings" element={<SsoBindingsPage />} />
```

**Back navigation**:新页面顶部加一个返回箭头 + "返回"按钮,`onClick={() => navigate(-1)}`(回上一路由,通常是 `/`)。

### 5.2 组件 `SsoBindingsPage.tsx`(新文件)

**位置**:`src/renderer/components/ssoBindings/SsoBindingsPage.tsx`。

**Props**:无。组件自己 dispatch + select 所有需要的 redux 状态。

**结构**(匹配 Image #17):

```
┌─ Header ──────────────────────────────────────────────┐
│ [← 返回]                                              │
│ SSO 账号绑定                                            │
│ 绑定企业身份源后,你可以使用对应的单点登录方式免密进入…   │
│ [已绑定 1 / 7] 状态 pill                              │
├─ Toolbar ──────────────────────────────────────────────┤
│ [搜索框]                              [全部 7] [已绑定 1] [未绑定 6] │
├─ List ─────────────────────────────────────────────────┤
│ Row 1(已绑定): [icon] 飞书 [feishu] [●已绑定]  飞书企业… [解绑]  │
│             副:已绑定账号 kk@example.com · 2026-10-13 绑定              │
│ Row 2(未绑定): [icon] 钉钉 [dingtalk] [未绑定]  钉钉企业… [绑定] │
│ ...                                                     │
└─ Empty / Loading / Error states ──────────────────────┘
```

**Loading state**:首屏 list 加载未返回时,显示骨架行(同企业 web 的 skeleton pattern)。

**Empty state**:`connections.length === 0` 时,显示 "尚未配置任何 SSO 连接" + "请联系管理员在 企业 web → SSO 身份提供商 创建"。

**Error state**:`fetch` 失败时,显示 "加载失败 [重试]"。

### 5.3 Redux slice `ssoBindingsSlice.ts`(新文件)

**位置**:`src/renderer/store/slices/ssoBindingsSlice.ts`。

**State**:

```ts
type SsoConnectionWithBinding = /* 跟 §3.1 服务端定义对齐 */;

interface SsoBindingsState {
  connections: SsoConnectionWithBinding[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  searchQuery: string;
  activeTab: 'all' | 'bound' | 'unbound';
  busyConnectionId: string | null;  // 正在绑定/解绑的 connectionId
}
```

**Reducers**:
- `setSearchQuery(q)`
- `setActiveTab(tab)`
- `setBusy(connectionId | null)`
- 由 thunks 改 `status` / `connections` / `error`。

**Thunks**:
- `fetchSsoBindings()` → IPC `sso:listMyBindings` → `connections`。
- `startSsoBinding(connectionId)` → IPC `sso:startMyBinding` → 成功后 `fetchSsoBindings`。
- `unbindSsoConnection(connectionId)` → IPC `sso:unbindMyConnection` → 成功后 `fetchSsoBindings`。

### 5.4 菜单项 `EnterpriseMtAccountMenu.tsx` 变更

**现状**(src/renderer/components/EnterpriseMtAccountMenu.tsx:401-425):

```
[icon user]  个人信息         → setProfileOpen(true)
[icon key]   修改密码         → setPasswordOpen(true)
───────── separator ─────────
[icon out]   退出             → onLogout
```

**目标**(匹配 Image #16):

```
[icon user]   个人信息        → setProfileOpen(true)
[icon key]    修改密码        → setPasswordOpen(true)
[icon link]   绑定 SSO 账号   → navigate('/sso-bindings')
───────── separator ─────────
[icon out]    退出            → onLogout
```

**改动点**:
1. import `useNavigate` from `react-router-dom`(既有 import 模式)。
2. import 一个新 icon:从 `@heroicons/react/24/outline` 加 `LinkIcon` 或 `ArrowsRightLeftIcon`(先选 `LinkIcon`,跟企业 web 同款意图)。
3. 加一个 `MenuItem`,放在 `enterpriseChangePasswordTitle` MenuItem 之后、separator 之前。
4. i18n key:`sso.profile.bindMenuItem`(复用企业 web 既有键名,值共享)。

### 5.5 i18n 键(新增,既有键复用既有)

**既有键(企业 web 已有,renderer 加一份)**:
- `sso.profile.bindMenuItem`: "绑定 SSO 账号" / "Bind SSO account"

**新键(renderer 独有)**:

| Key | zh | en |
| --- | --- | --- |
| `ssoBindings.title` | SSO 账号绑定 | SSO account binding |
| `ssoBindings.subtitle` | 绑定企业身份源后,你可以使用对应的单点登录方式免密进入 GenWork。可以同时绑定多个身份源,互不影响。 | After binding an enterprise identity source, you can use the corresponding SSO sign-in to access GenWork without password. You can bind multiple sources simultaneously. |
| `ssoBindings.statusBadge` | 已绑定 {bound} / {total} | Bound {bound} / {total} |
| `ssoBindings.searchPlaceholder` | 搜索 SSO 类型或名称 | Search SSO type or name |
| `ssoBindings.tabAll` | 全部 {n} | All {n} |
| `ssoBindings.tabBound` | 已绑定 {n} | Bound {n} |
| `ssoBindings.tabUnbound` | 未绑定 {n} | Unbound {n} |
| `ssoBindings.statusBound` | 已绑定 | Bound |
| `ssoBindings.statusUnbound` | 未绑定 | Unbound |
| `ssoBindings.bindButton` | 绑定 | Bind |
| `ssoBindings.unbindButton` | 解绑 | Unbind |
| `ssoBindings.boundAccount` | 已绑定账号 {account} | Bound account: {account} |
| `ssoBindings.boundAt` | {date} 绑定 | Bound on {date} |
| `ssoBindings.emptyTitle` | 尚未配置任何 SSO 连接 | No SSO connections configured |
| `ssoBindings.emptyHint` | 请联系管理员在 企业 web → SSO 身份提供商 创建。 | Ask your admin to create one in the enterprise web under SSO / Identity providers. |
| `ssoBindings.loadError` | 加载失败 | Failed to load |
| `ssoBindings.retry` | 重试 | Retry |
| `ssoBindings.unbindError` | 解绑失败:{error} | Unbind failed: {error} |
| `ssoBindings.bindError` | 绑定失败:{error} | Bind failed: {error} |
| `ssoBindings.bindInProgress` | 正在打开浏览器… | Opening browser… |
| `ssoBindings.back` | 返回 | Back |

**不进 main i18n**(main 进程里只在 IPC 错误时返字符串,英文 "Failed to start binding: ${error}" 即可;不进 `src/main/i18n.ts`,因为它走的是 `enterpriseFetchWithAuth` 的 error 抛出路径,main 只 log,不展示给用户)。

---

## 6. 跨进程合约

新文件 `src/shared/sso/binding.ts`:

```ts
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
  boundAt: string | null;  // ISO 8601
}

export const SSO_BINDING_ACTIONS = {
  List: 'sso:listMyBindings',
  Unbind: 'sso:unbindMyConnection',
  Start: 'sso:startMyBinding',
} as const;
export type SsoBindingAction = typeof SSO_BINDING_ACTIONS[keyof typeof SSO_BINDING_ACTIONS];
```

- server 端 **不**引用 `src/shared/`(server 进程跟渲染器编译路径不同,不要强行共享 type)。Server 在 `enterprise_server/src/sso/bindingTypes.ts` 自维护一份同名 interface,跟 `src/shared/sso/binding.ts` 保持字段一致即可(由测试断言)。
- 字段命名:`logoPath` 在 server DB 里是 `logo_path`,在 server 响应里**已经拼好**成 `logoUrl`,在 desktop 收到时直接用。

---

## 7. 测试策略

### 7.1 新文件 `enterprise_server/tests/me/ssoBindingConnections.test.ts`

- 200 + 已绑定:mock 1 个 connection + mock users 表里 `sso_connection_id = conn.id`;期望响应 1 个 connection,`bound: true`,`externalId` 等于 mock 值,`boundAt` 是 ISO 字符串。
- 200 + 未绑定:mock 1 个 connection + users 表 `sso_connection_id IS NULL`;期望 `bound: false`,`externalId: null`,`boundAt: null`。
- 200 + 跨 org 隔离:mock 2 个 connection,1 个属于 user.org,1 个属于另一个 org;期望响应只含属于 user.org 的那个。
- 200 + 0 connection:期望 `{ connections: [] }`。
- 401:无 token 期望 401。
- 500:DB 抛错期望 500(server 端默认 handler)。

### 7.2 新文件 `src/main/sso/startSsoMemberBind.test.ts` (主)+ `src/main/main.test.ts` 增量(辅)

- `startSsoMemberBind` 函数本身在独立文件,有完整测试:
  - `sso:startMyBinding` 调 `/me/sso-binding/start` POST,带 org JWT,body 包含 connectionId。
  - 拿到 `authorizeUrl` 后调 `openOauthFlow` 跑 OAuth(用既有 `oauthBrowserFlow.test.ts` 的 mock 模式)。
  - OAuth 失败时 IPC handler 抛错,UI 弹 toast。
- 既有 `genericSsoLogin.test.ts` 26 个用例**完全不动**。
- `main.ts` 的 IPC handler 单测不强求(项目惯例是不测 main.ts 的 ipcMain.handle,走集成测试)。

### 7.3 新文件 `src/main/sso/startSsoMemberBind.test.ts`

- 跑通完整两阶段:mock server `POST /me/sso-binding/start` 返 `authorizeUrl` → mock IdP 完成 → loopback 收到 `?token=` → 解析出 token。
- pendingBind 不会触发:server 不返 409,probe 永远走 token 分支。
- 错误路径:server 返 500 / 401 / `connection_not_found` → IPC handler 抛错,UI 弹 toast。

### 7.4 新文件 `src/renderer/components/ssoBindings/SsoBindingsPage.test.tsx`

- 渲染骨架(list loading 状态)。
- 渲染完整 list(3 行:1 bound,2 unbound),断言 row 内容、按钮文案、状态 badge。
- 搜索过滤:输入 "feishu" 后只剩 1 行。
- 标签切换:点 "未绑定" 后只剩 unbound 行。
- 绑定按钮点击 → 调 `sso:startMyBinding` IPC mock,成功后 refetch。
- 解绑按钮点击 → 调 `sso:unbindMyConnection` IPC mock,成功后 refetch。
- 空状态:connections.length = 0 时显示 empty hint。
- 错误状态:fetch reject 时显示 retry 按钮 + retry 触发 refetch。

### 7.5 新文件 `src/renderer/components/EnterpriseMtAccountMenu.test.tsx`

- 现有测试不动,新加 1 个:菜单展开,断言 4 个 MenuItem("个人信息" / "修改密码" / "绑定 SSO 账号" / "退出"),顺序按 Image #16。

### 7.6 新文件 `src/renderer/store/slices/ssoBindingsSlice.test.ts`

- 既有 redux-slice 测试模式(`coworkSlice.test.ts` / `authSlice.test.ts` 之类),覆盖 thunks 的 success / failure 分支,reducer 纯函数分支。

### 7.7 Lint

- `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <all-touched-files>`。

---

## 8. 分期

### P1 (本 spec 必须交付)
- §3.1 server 新端点 `GET /me/sso-binding/connections`。
- §4 main 进程 IPC + `startSsoMemberBind` 提取(从 `genericSsoLogin.ts` 提取共享 probe,新建 `startSsoMemberBind.ts`)。
- §5 渲染器新页面 + slice + 菜单项 + 路由。
- §5.5 i18n 全部新键(zh + en)。
- §7 全部测试。
- `git commit` 本地(per standing constraint,无 push)。

### P2 (后续 ticket)
- 把 `SsoConnectionsWithBindingsResponse` type 提到 `enterprise_server/src/sso/bindingTypes.ts` 并加 `tsd` test 跟 renderer 端 type 对齐(目前 P1 靠手抄 + 测试断言)。
- 把 `bindIpc` 注册逻辑并到 `main.ts` 的 `loadIpcHandlers` 装载函数(目前 P1 单独 register)。
- 把 `EnterpriseMtAccountMenu.tsx` 的 LinkIcon 改成 `ArrowsRightLeftIcon`(后续如原型图调整)。

---

## 9. 风险与回退

1. **风险**:`startSsoMemberLogin` 的 880 行大文件,本 spec 不修改它,但 `startSsoMemberBind` 会引用 `createSsoLoginProbe` 和 `startCallbackServer`(都是 exported 的,不动)。**缓解**:`createSsoLoginProbe` 已有 6 个测试用例覆盖,行为不变。

2. **风险**:bind 流程的 OAuth 路径跟 login 流程共享 53231 端口。**缓解**:desktop 用户一次只能在一个 surface,port 竞争不存在(已在 §4.4 论证)。

3. **风险**:企业 web 的 `sso.profile.bindMenuItem` i18n 键可能跟桌面端翻译口径不同(zh 文案保持一致,en 文案从企业 web 拉取)。**缓解**:本 spec 复用企业 web 既有的 zh 字符串,en 字符串从企业 web 既有的 i18n 文件同步。

4. **风险**:服务端 `GET /me/sso-binding/connections` 的 `logoUrl` 拼接若变更(企业 web 之前是从 `logoPath` 拼 `${origin}/auth/sso/...`),桌面拼错 base 会 404。**缓解**:server 直接返绝对 URL,desktop 不再拼(已在 §3.1 论证)。

5. **回退**:本 spec 全部是新增,不动既有 server 端点 / 既有 enterprise web 页面 / 既有 login 流程。回退 = `git revert <commit>`。

---

## 10. 待确认 / 开放问题

无。所有关键决策已在 brainstorm 阶段跟用户确认(渲染表面、新端点、OAuth 流程复用、解绑策略、菜单布局、文档路径)。
