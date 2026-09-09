# SSO 用户自助绑定 + 严格模式 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GenWork 企业版 SSO 登录流上加"严格模式"开关,**由 user 自行绑定** IdP 身份(而非 admin 后台预绑定),让管理员能控制"未自助绑定的飞书/Okta/钉钉账号必须先账号密码认证再放行"。

**Architecture:** 一份新 migration 给 `users` 加 `(sso_connection_id, sso_external_id)` 列 + 唯一索引,`sso_connections` 加 `require_prebinding` 开关,`sso_login_states` 加 `phase` 列;`finishSsoCallback` 在 `resolveUser` 之前插严格模式门(命中 / fast-path 出 token,未命中 / 入内存 store + 进二段路径);`jit.ts` 自身**完全不变**;新增 `ssoLoginContextStore` (in-memory `Map<state, SsoLoginContext>`) 跟踪二段状态;新增 4 个路由(`/auth/sso/bind` 公共 + `/me/sso-binding/*` user-self + `/admin/.../sso-binding` admin GET/DELETE);前端新增 `/bind-sso` 页面 + 头像菜单"绑定 SSO 账号"入口 + 用户管理 SSO 绑定列(只读 + 解绑按钮) + SSO 连接详情严格模式 checkbox。

**Tech Stack:** TypeScript / Hono / PostgreSQL (pglite test) / Vitest / Zod / React + Tailwind / i18n key-value 表。

**Spec:** [`../specs/2026-10-12-sso-prebinding-and-allowlist-design.md`](../specs/2026-10-12-sso-prebinding-and-allowlist-design.md)

---

## Global Constraints

(沿用 spec §10.1 + 仓库根 `AGENTS.md` / `CLAUDE.md`,逐字摘录与本 plan 强相关的)

- Node.js `>=24.15.0 <25`。
- 测试代码权威;不删既有断言,新增断言保持原样。
- 逐文件跑测试:`npx vitest run <file>`,不要一次跑整个 vitest 套件
  (sandbox fd 耗尽,会 EBADF)。
- Lint:`npx eslint --ext ts,tsx --report-unused-disable-directives
  --max-warnings 0 <files>`,只对变更文件集,允许全量 lint 失败但要报告。
- i18n: 中英文成对新增;键名空间 `sso.*`,见 §9.5 列表。
- 字符串字面量进 `as const` 对象(本 plan 涉及 audit action 字面量、
  i18n 键、`Error.message`)。
- 自动提交仅本地,不 push;Conventional Commits,英文,无
  `Co-Authored-By` trailer。
- 不新增 `PermissionPoint`(`PP.SsoView` / `PP.SsoEdit` 已有)。
- secret 加密存,不出 wire。
- 不改 `resolveUser`(`jit.ts` 自身)—— 严格模式门在 `finishSsoCallback`
  (`PrebindingRequiredError` 整个类从 spec 砍掉)。
- `jit.test.ts` 11 个既有用例**完全不动**;`finishCallback.test.ts` 只在末
  尾追加严格模式门用例。

## Review Focus

(spec 暗含、但下面任务测试**不**直接覆盖的输入类 — 实施时把对应测试
加到所属任务,标 `—` 的已经在 P1 测试范围内,这里只列**额外**的。)

- **同一 `(sso_connection_id, sso_external_id)` 跨 org 冲突** — 索引是
  per `(connection, external_id)`,跨 org 同 union_id 不被拒(两个 org
  可以各自绑定同一个飞书 user)。Task 1 的 migration 用 `WHERE
  sso_external_id IS NOT NULL` 的局部唯一索引,**已经**天然允许跨
  org 重号 — 但 admin/user PUT/DELETE endpoint 必须**严格**按
  `claims.orgId` 过滤 user,这点在 Task 8 的"跨 org → 404"用例已
  盖。
- **预绑定被解绑后,已登录 user 怎么办** — 不应踢出当前会话(已经有效
  的 JWT 仍然有效直至过期)。不在本 spec 范围(spec §3.2 明确
  "**不**自动清 `user_idp_identities`")。但解绑后的 user 下一次 SSO
  登录会因严格模式无预绑定而走二段路径 — 这是 spec §11 风险表里
  的设计,不是 bug。
- **严格模式开启时,既有 JIT 已建 user 但无 `users.sso_*` 的怎么办** —
  走二段路径,user 在 `/bind-sso` 输账号密码即可。这是 user 自助,不
  是 admin 配。
- **`require_prebinding=true` + admin 本人未自助绑过** — admin 自己用
  账号密码登录后,头像菜单走"绑定 SSO 账号"自助绑一次。**不**挡。
- **`sso_external_id` 为空字符串 vs null** — spec §3.1 明确两个字段必
  须同时为非空或同时为 NULL。`/auth/sso/bind` zod 校验统一收 null,
  空字符串 `''` 也被规范成 null(否则会撞 unique,因为
  `WHERE sso_external_id IS NOT NULL` 的局部索引把空串当 non-null)。
  Task 5 加这条断言。
- **`ssoLoginContextStore` 进程重启后状态丢失** — 单实例 in-memory
  map;丢失后 user 必须重新走 SSO 登录(降级路径,不是 bug)。多实
  例部署需迁 DB / Redis(spec §12 P2)。Task 2 不加跨实例共享。
- **`/auth/sso/callback` 第二次命中(`/auth/sso/bind` 完成后)** —
  `sso_login_states` 那行已被 `consumeState` DELETE-RETURNING 一次
  消费,所以第二次 `consumeState(state)` 返回 null。Task 4 的路由
  handler 必须**先查 `ssoLoginContextStore`**,store 里有
  `kind='ready_to_finalize'` → 直接出 token + 清 store;store 没
  有再走 `consumeState` + `finishSsoCallback` 路径。
- **`/auth/sso/bind` 成功后 `returnTo` 的 `code` 是哪儿来的** — IdP
  的 authorization code 是**一次性的**且**已经被 `finishSsoCallback`
  在第一次 callback 里用掉**(consume 走了 token endpoint)。所以
  `returnTo` **不带 `code=`**,前端只是把 user 重定向到
  `${origin}/auth/sso/callback?state=${state}`,由 Task 4 的路由
  handler 看到 store 里有 `ready_to_finalize` → 出 token。
  **不要**在 `returnTo` 里塞 `code` (Task 5)。
- **P1 desktop 模式"二段路径"** — P1 只实现 console 模式;desktop
  走 `openOauthFlow` 的 probe 命中 loopback URL 时,若 server 端
  `finishSsoCallback` 返回 `pendingBind`,桌面 UI 显示"请到企业
  web 完成首次绑定" + 在外部浏览器打开 `/bind-sso?state=xxx` 让
  user 用手机或电脑浏览器完成。P2 加桌面模态(spec §7.2 末段 + §12
  评审可决 5)。

---

## File Structure

### 后端 (server)
- 新建 `src/db/migrations/043_sso_prebinding.sql` — schema 变更
- 新建 `src/sso/ssoLoginContext.ts` — in-memory `Map<state, SsoLoginContext>` + 类型
- 改 `src/sso/types.ts` — `SsoConnectionRow` 加 `require_prebinding: boolean`
- 改 `src/sso/finishCallback.ts` — 加严格模式门;`COLS` 加 `require_prebinding`;`FinishResult` 加 `pendingBind` 变体
- 改 `src/sso/consoleCallback.ts` — 不变(继续复用 `renderConsoleCallbackHtml`)
- 改 `src/routes/sso.ts` — `require_prebinding` 进 admin baseSchema;`COLS` 加列;`/auth/sso/callback` 第二次命中走 store final 路径
- 新建 `src/routes/auth/ssoBind.ts` — `GET /bind-sso` + `POST /auth/sso/bind`
- 新建 `src/routes/me/ssoBinding.ts` — `POST /me/sso-binding/start` + `DELETE /me/sso-binding`
- 新建 `src/routes/admin/ssoBindings.ts` — `GET /admin/users/:id/sso-binding` + `GET /admin/sso-connections/:id/bindings` + `DELETE /admin/users/:id/sso-binding`
- 改 `src/server.ts` — 挂新路由

### 测试
- 改 `tests/sso/jit.test.ts` — **完全不动**(11 个既有用例保留,本 spec 不动 `resolveUser`)
- 改 `tests/sso/finishCallback.test.ts` — 追加 5 个 strict-mode 用例(§9.2)
- 新建 `tests/sso/ssoLoginContext.test.ts` — store CRUD + TTL + kind 转换(§9.6)
- 新建 `tests/auth/ssoBind.test.ts` — `/auth/sso/bind` 8 个用例(§9.3)
- 新建 `tests/me/ssoBinding.test.ts` — 8 个用例(§9.4)
- 新建 `tests/admin/ssoBindings.test.ts` — 8 个用例(§9.5)

### 前端 (web)
- 改 `web/src/i18n.ts` — 加 5 + 1 + 1 + 1 + 1 + 1 = 10 个新键(中英文成对)
- 改 `web/src/pages/LoginPage.tsx` — **不变**(spec §7.1 明确"prebinding_required 文案不再使用")
- 改 `web/src/pages/sso/SSOConnectionDrawer.tsx`(或编辑表单所在文件)— 加 `require_prebinding` 字段编辑 + 切换时 confirm
- 改 `web/src/pages/sso/types.ts`(若有)— `SsoConnection` 类型加字段
- 新建 `web/src/pages/auth/BindSsoPage.tsx` — `/bind-sso?state=xxx` 页面
- 改 `web/src/pages/UsersPage.tsx`(或 `users/` 子目录) — 加列 + 解绑按钮(只读)
- 改 `web/src/components/ProfileMenu.tsx`(或等价位置) — 加"绑定 SSO 账号"项
- 改 `web/src/api/` — 加 `startSsoBinding` / `deleteSsoBinding` / `getUserSsoBinding` / `getConnectionBindings` / `adminDeleteUserSsoBinding`

---

## Task 1: Migration — `users.sso_*` + 严格模式 + state phase 列

**Files:**
- Create: `enterprise_server/src/db/migrations/043_sso_prebinding.sql`
- Test: `enterprise_server/tests/sso/migration043.test.ts` (new)

**Interfaces:**
- 改 `SsoConnectionRow` (Task 3 用): 加 `require_prebinding: boolean`。
- 改 `sso_login_states` 表: 加 `phase TEXT NOT NULL DEFAULT 'sso_completed'`。

- [ ] **Step 1: 写 migration 文件**

```sql
-- enterprise_server/src/db/migrations/043_sso_prebinding.sql
-- SSO user self-binding: stores (sso_connection_id, sso_external_id) on
-- the users row. Written by the user via the "Bind SSO" profile flow or
-- by the post-SSO "prove with password" page. Read by JIT (strict mode)
-- and by admin (read-only view).

ALTER TABLE users
  ADD COLUMN sso_connection_id TEXT REFERENCES sso_connections(id),
  ADD COLUMN sso_external_id   TEXT;

-- A given (sso_connection_id, sso_external_id) pair maps to at most one user.
-- The partial WHERE clause leaves the (NULL, NULL) rows of unbound users out
-- of the index (no point indexing them; they're the common case pre-rollout).
CREATE UNIQUE INDEX IF NOT EXISTS users_sso_binding_uniq
  ON users (sso_connection_id, sso_external_id)
  WHERE sso_external_id IS NOT NULL;

-- Fast lookup from the JIT path: a single index covers both the strict-mode
-- binding query and the `WHERE sso_connection_id IS NULL` "unbound" report.
CREATE INDEX IF NOT EXISTS users_sso_binding_lookup
  ON users (sso_connection_id, sso_external_id)
  WHERE sso_external_id IS NOT NULL;

-- Per-connection opt-in. Default false preserves v1 behavior; flipping it
-- on is a deliberate admin decision (unbound IdP identities must go
-- through the "prove with password" path — see spec §4.2).
ALTER TABLE sso_connections
  ADD COLUMN require_prebinding BOOLEAN NOT NULL DEFAULT false;

-- SSO login state machine: after the IdP callback, if the identity is
-- unbound, we keep the state row and set phase='pending_bind' so the
-- /bind-sso page can verify the password and resume.
ALTER TABLE sso_login_states
  ADD COLUMN phase TEXT NOT NULL DEFAULT 'sso_completed';
-- phase values: 'sso_completed' (default, callback can finalize) |
-- 'pending_bind' (callback completed identity check, awaiting password
-- verification at /bind-sso)
CREATE INDEX IF NOT EXISTS sso_login_states_phase
  ON sso_login_states (state) WHERE phase = 'pending_bind';
```

- [ ] **Step 2: 写 migration 测试**

```ts
// enterprise_server/tests/sso/migration043.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 043 — sso prebinding', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc','[]'::jsonb)`
    );
  });

  test('users.sso_connection_id and sso_external_id exist and are nullable', async () => {
    const cols = await testPool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('sso_connection_id', 'sso_external_id')`
    );
    expect(cols.rows.map(r => r.column_name).sort()).toEqual(['sso_connection_id', 'sso_external_id']);
    for (const c of cols.rows) expect(c.is_nullable).toBe('YES');
  });

  test('sso_connections.require_prebinding exists and defaults to false', async () => {
    const r = await testPool.query<{ require_prebinding: boolean }>(
      `SELECT require_prebinding FROM sso_connections WHERE id = 'c1'`
    );
    expect(r.rows[0]?.require_prebinding).toBe(false);
  });

  test('sso_login_states.phase exists and defaults to sso_completed', async () => {
    await testPool.query(
      `INSERT INTO sso_login_states(state, org_id, sso_connection_id, return_target, expires_at)
       VALUES ('st1','o1','c1','console', now() + interval '1 minute')`
    );
    const r = await testPool.query<{ phase: string }>(
      `SELECT phase FROM sso_login_states WHERE state = 'st1'`
    );
    expect(r.rows[0]?.phase).toBe('sso_completed');
  });

  test('users binding unique index rejects duplicates but allows cross-org same id', async () => {
    // Two users in same org trying to bind the same (connection, external_id) → reject.
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
       VALUES ('u1','o1','a','x','c1','ext-1')`
    );
    await expect(testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
       VALUES ('u2','o1','b','x','c1','ext-1')`
    )).rejects.toThrow(/unique/i);

    // Cross-org same (connection, external_id) → allowed (index is per-connection,
    // not per-org). Insert a second org + connection + user.
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c2','o2','Acme2','generic-oidc','oidc','[]'::jsonb)`
    );
    await expect(testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
       VALUES ('u3','o2','c','x','c2','ext-1')`
    )).resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/migration043.test.ts
```
Expected: PASS, 4 tests, 0 failures.

- [ ] **Step 4: 跑既有 sso 测试确认 schema 变更不破坏现状**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/jit.test.ts tests/sso/finishCallback.test.ts tests/sso/state.test.ts tests/sso/oauth.test.ts tests/sso/consoleCallback.test.ts tests/sso/providerPresets.test.ts tests/sso/logos.test.ts tests/sso/desktopRedirectPort.test.ts
```
Expected: 全部 PASS(新加列都是 nullable / 有 default,无破坏)。

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/043_sso_prebinding.sql enterprise_server/tests/sso/migration043.test.ts
git commit -m "feat(sso): add migration 043 for users.sso_* + require_prebinding + sso_login_states.phase"
```

---

## Task 2: 内存 store — `ssoLoginContextStore` + `SsoLoginContext` 类型

**Files:**
- Create: `enterprise_server/src/sso/ssoLoginContext.ts`
- Test: `enterprise_server/tests/sso/ssoLoginContext.test.ts` (new)

**Interfaces:**
- 公开类型:
  ```ts
  export type SsoLoginContext =
    | { kind: 'pending_bind'; orgId: string; connectionId: string; externalId: string;
        email: string | null; loginName: string | null;
        redirectUri: string | null; codeVerifier: string | null;
        expiresAt: Date; }
    | { kind: 'ready_to_finalize'; orgId: string; connectionId: string;
        boundUserId: string; externalId: string; redirectUri: string | null;
        codeVerifier: string | null; expiresAt: Date; }
    | { kind: 'self_binding'; orgId: string; connectionId: string;
        userId: string; redirectUri: string | null; codeVerifier: string | null;
        expiresAt: Date; };

  export const ssoLoginContextStore: {
    set(state: string, ctx: SsoLoginContext): void;
    get(state: string): SsoLoginContext | undefined;
    delete(state: string): boolean;
    size(): number;
  };
  ```
- 后续 Task 3 (`finishSsoCallback`)、Task 4 (路由 finalize 分支)、Task 5
  (`/auth/sso/bind`)、Task 7 (`/me/sso-binding/start`) 都引用。

- [ ] **Step 1: 写失败测试**

```ts
// enterprise_server/tests/sso/ssoLoginContext.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ssoLoginContextStore, type SsoLoginContext } from '../../src/sso/ssoLoginContext';

describe('sso/ssoLoginContext', () => {
  beforeEach(() => { ssoLoginContextStore.delete('s1'); ssoLoginContextStore.delete('s2'); });

  test('set + get + delete round-trip', () => {
    const ctx: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext-1', email: null, loginName: null,
      redirectUri: 'http://x', codeVerifier: 'v',
      expiresAt: new Date(Date.now() + 60_000),
    };
    ssoLoginContextStore.set('s1', ctx);
    expect(ssoLoginContextStore.get('s1')).toEqual(ctx);
    expect(ssoLoginContextStore.delete('s1')).toBe(true);
    expect(ssoLoginContextStore.get('s1')).toBeUndefined();
  });

  test('expired entry is invisible to get', () => {
    const expired: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext-1', email: null, loginName: null,
      redirectUri: null, codeVerifier: null,
      expiresAt: new Date(Date.now() - 1),
    };
    ssoLoginContextStore.set('s2', expired);
    expect(ssoLoginContextStore.get('s2')).toBeUndefined();
    // cleanup happened implicitly on get
  });

  test('size() reflects non-expired entries only', () => {
    const live: SsoLoginContext = {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1',
      userId: 'u1', redirectUri: null, codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const expired: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext', email: null, loginName: null,
      redirectUri: null, codeVerifier: null,
      expiresAt: new Date(Date.now() - 1),
    };
    ssoLoginContextStore.set('live', live);
    ssoLoginContextStore.set('exp', expired);
    expect(ssoLoginContextStore.size()).toBe(1);
    ssoLoginContextStore.delete('live');
  });

  test('kind transitions: pending_bind -> ready_to_finalize -> deleted', () => {
    const pending: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext-1', email: null, loginName: null,
      redirectUri: 'http://x', codeVerifier: 'v',
      expiresAt: new Date(Date.now() + 60_000),
    };
    ssoLoginContextStore.set('s3', pending);
    expect(ssoLoginContextStore.get('s3')?.kind).toBe('pending_bind');

    // Task 5 calls this transition: change kind in place, keep entry.
    const ready: SsoLoginContext = {
      ...pending, kind: 'ready_to_finalize', boundUserId: 'u1',
    };
    ssoLoginContextStore.set('s3', ready);
    expect(ssoLoginContextStore.get('s3')?.kind).toBe('ready_to_finalize');

    // Task 4 deletes the entry after issuing the token.
    ssoLoginContextStore.delete('s3');
    expect(ssoLoginContextStore.get('s3')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/ssoLoginContext.test.ts
```
Expected: FAIL with "Cannot find module ../../src/sso/ssoLoginContext".

- [ ] **Step 3: 写实现**

```ts
// enterprise_server/src/sso/ssoLoginContext.ts
// In-memory store for SSO login contexts that need to span two HTTP
// requests (`/auth/sso/callback` -> `/bind-sso` -> `/auth/sso/callback`).
// Single-instance only; multi-instance deployments must move this to DB
// or Redis (spec §12 P2). TTL is enforced lazily on `get`/`size`.

export type SsoLoginContext =
  | { kind: 'pending_bind';
      orgId: string; connectionId: string; externalId: string;
      email: string | null; loginName: string | null;
      redirectUri: string | null; codeVerifier: string | null;
      expiresAt: Date; }
  | { kind: 'ready_to_finalize';
      orgId: string; connectionId: string; boundUserId: string;
      externalId: string; redirectUri: string | null;
      codeVerifier: string | null; expiresAt: Date; }
  | { kind: 'self_binding';
      orgId: string; connectionId: string; userId: string;
      redirectUri: string | null; codeVerifier: string | null;
      expiresAt: Date; };

const map = new Map<string, SsoLoginContext>();

function isLive(ctx: SsoLoginContext | undefined): ctx is SsoLoginContext {
  return !!ctx && ctx.expiresAt.getTime() > Date.now();
}

export const ssoLoginContextStore = {
  set(state: string, ctx: SsoLoginContext): void {
    map.set(state, ctx);
  },
  get(state: string): SsoLoginContext | undefined {
    const ctx = map.get(state);
    if (!isLive(ctx)) {
      map.delete(state);
      return undefined;
    }
    return ctx;
  },
  delete(state: string): boolean {
    return map.delete(state);
  },
  size(): number {
    let n = 0;
    for (const [k, v] of map) {
      if (isLive(v)) n++;
      else map.delete(k);
    }
    return n;
  },
};
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/ssoLoginContext.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/sso/ssoLoginContext.ts enterprise_server/tests/sso/ssoLoginContext.test.ts
git commit -m "feat(sso): add in-memory ssoLoginContextStore for two-stage binding"
```

---

## Task 3: 严格模式门 — `finishCallback.ts`

**Files:**
- Modify: `enterprise_server/src/sso/types.ts` (add `require_prebinding`)
- Modify: `enterprise_server/src/sso/finishCallback.ts` (strict-mode gate before resolveUser; COLS)
- Test: `enterprise_server/tests/sso/finishCallback.test.ts` (append 5 new tests; keep existing)

**Interfaces:**
- 引入 `ssoLoginContextStore` from `'./ssoLoginContext'`, `SsoLoginContext` 类型。
- 改 `FinishResult`:
  ```ts
  export type FinishResult =
    | { token: string }
    | { error: string }
    | { pendingBind: { connectionName: string; providerType: string; externalId: string } };
  ```
- `SsoConnectionRow` 加 `require_prebinding: boolean`(line 24 字段块末尾)。
- `COLS` 末尾加 `, require_prebinding`(`types.ts` 真名 `require_prebinding`,snake_case 不变)。

- [ ] **Step 1: 写失败测试 (5 个)**

在 `enterprise_server/tests/sso/finishCallback.test.ts` 末尾追加 5 个 describe('strict-mode gate', …),先看现有 `seedSecretConnection` 等帮助函数的位置然后插入。每个 test 都用现有的 `fetchMock` + `createState` / `consumeState` + `finishSsoCallback`。Seed 在每个 test 内部建立 `require_prebinding=true` 的连接 + 一个已绑 user(适用用例 2/3)或留空(用例 4)。Verify 收到 `pendingBind` 且 store 里有 entry(用例 4),或收到 `error: 'user_disabled'`(用例 3),或拿到 token(用例 1/2)。

```ts
// 追加在 enterprise_server/tests/sso/finishCallback.test.ts 末尾
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';

describe('finishCallback — strict-mode gate', () => {
  beforeEach(() => {
    ssoLoginContextStore.delete('st1');
    ssoLoginContextStore.delete('st2');
  });

  async function seedStrictConnection(require = true): Promise<void> {
    await testPool.query(
      `UPDATE sso_connections SET require_prebinding = $1 WHERE id = 'c1'`,
      [require]
    );
  }

  async function createStateFor(): Promise<Awaited<ReturnType<typeof createState>>> {
    return createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console' });
  }

  test('require_prebinding=false: identity not in users.sso_* still goes through resolveUser (regression)', async () => {
    await seedStrictConnection(false);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type':'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-fresh', email: 'f@x.com', preferred_username: 'f' }), { status: 200, headers: { 'content-type':'application/json' } }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('token' in r).toBe(true);
  });

  test('require_prebinding=true: bound to active user issues a token and writes user_idp_identities', async () => {
    await seedStrictConnection(true);
    // Pre-bind a user with (c1, 'ext-bound').
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u-bound','o1','bob','x','c1','ext-bound','[]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-bound', email: 'b@x.com' }), { status: 200 }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('token' in r).toBe(true);
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u-bound' AND sso_connection_id='c1' AND external_id='ext-bound'`);
    expect(ids.rowCount).toBe(1);
  });

  test('require_prebinding=true: bound to disabled user returns user_disabled', async () => {
    await seedStrictConnection(true);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u-d','o1','d','x','disabled','c1','ext-d','[]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-d', email: 'd@x.com' }), { status: 200 }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect(r).toEqual({ error: 'user_disabled' });
  });

  test('require_prebinding=true: unbound identity parks state with kind=pending_bind and returns pendingBind', async () => {
    await seedStrictConnection(true);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-new', email: 'n@x.com', preferred_username: 'n' }), { status: 200 }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('pendingBind' in r).toBe(true);
    if ('pendingBind' in r) {
      expect(r.pendingBind.providerType).toBe('generic-oidc');
      expect(r.pendingBind.externalId).toBe('ext-new');
    }
    const ctx = ssoLoginContextStore.get(state);
    expect(ctx?.kind).toBe('pending_bind');
    if (ctx?.kind === 'pending_bind') {
      expect(ctx.externalId).toBe('ext-new');
      expect(ctx.orgId).toBe('o1');
    }
    // Audit
    const audit = await testPool.query<{ payload: any }>(
      `SELECT payload FROM audit_events WHERE action='sso_login_failed' AND org_id='o1' ORDER BY ts DESC LIMIT 1`
    );
    expect(audit.rows[0]?.payload).toMatchObject({ reason: 'sso_login_pending_bind' });
  });
});
```

- [ ] **Step 2: 跑测试确认前 4 个失败**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/finishCallback.test.ts
```
Expected: 既有用例 PASS,新 4 个 strict-mode 用例 FAIL(`require_prebinding` 字段未识别 / `pendingBind` 变体未识别 / store 未写)。

- [ ] **Step 3: 改 `types.ts`**

在 `enterprise_server/src/sso/types.ts`,`SsoConnectionRow` 字段块
(line 24 之后,`logo_url` 之前)插入:
```ts
  /** When true, an IdP identity not in users.sso_(connection,external) is
   *  sent to /bind-sso (must verify password) instead of JIT-resolving. */
  require_prebinding: boolean;
```

- [ ] **Step 4: 改 `finishCallback.ts`**

A. 改 `COLS` 末尾加 `, require_prebinding`(line 159)。
B. import 新增 `import { ssoLoginContextStore, type SsoLoginContext } from './ssoLoginContext';`
C. 改 `FinishResult` 类型,加 `pendingBind` 变体。
D. 在 line 102(`let userId: string;` 之前)插严格模式门:

```ts
  // 0. Strict-mode gate. Lives here, NOT in resolveUser — when
  // require_prebinding is true, we look up users.sso_(connection,external)
  // directly and bypass resolveUser (so email_domain_whitelist / JIT do
  // not run for the strict-mode path).
  if (conn.require_prebinding) {
    const bound = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users
        WHERE org_id = $1 AND sso_connection_id = $2 AND sso_external_id = $3`,
      [state.orgId, state.connectionId, externalId],
    );
    if (bound.rowCount) {
      if (bound.rows[0]!.status !== 'active') {
        await auditStore.write({
          orgId: state.orgId, action: 'sso_login_failed',
          payload: { ssoConnectionId: state.connectionId, reason: 'user_disabled' },
        });
        await recordFailedLogin(state.orgId);
        return { error: 'user_disabled' };
      }
      const uid = bound.rows[0]!.id;
      await pool.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), state.orgId, uid, state.connectionId, externalId],
      );
      const roleRes = await pool.query<{ extra_roles: string[] | null }>(
        `SELECT extra_roles FROM users WHERE id = $1`, [uid]
      );
      const roles = roleRes.rows[0]?.extra_roles ?? [Role.User];
      const token = await signToken({ sub: uid, orgId: state.orgId, roles });
      try { await loginRecord.recordLogin(state.orgId, uid, null, null, 'success'); } catch { /* best-effort */ }
      await auditStore.write({
        orgId: state.orgId, userId: uid, action: 'sso_login_succeeded',
        payload: { ssoConnectionId: state.connectionId, externalId, createdJit: false },
      });
      return { token };
    }
    // Unbound + strict mode → two-stage. Park the state so /bind-sso can
    // verify the password and resume. We do NOT call resolveUser here.
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);  // matches STATE_TTL_MS
    const ctx: SsoLoginContext = {
      kind: 'pending_bind',
      orgId: state.orgId, connectionId: state.connectionId,
      externalId, email, loginName,
      redirectUri: state.redirectUri, codeVerifier: state.codeVerifier,
      expiresAt,
    };
    ssoLoginContextStore.set(state.state, ctx);
    await auditStore.write({
      orgId: state.orgId, action: 'sso_login_failed',
      payload: { ssoConnectionId: state.connectionId, reason: 'sso_login_pending_bind', externalId },
    });
    return { pendingBind: { connectionName: conn.name, providerType: conn.provider_type, externalId } };
  }
```

- [ ] **Step 5: 跑测试确认全部通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/finishCallback.test.ts
```
Expected: PASS(既有用例 + 4 个新 strict-mode 用例)。

- [ ] **Step 6: 跑 `jit.test.ts` 确认 `resolveUser` 路径未受牵连**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/jit.test.ts
```
Expected: PASS(11 个既有用例全过,验证 `resolveUser` 没被改)。

- [ ] **Step 7: Lint 变更文件**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/sso/finishCallback.ts src/sso/types.ts tests/sso/finishCallback.test.ts
```
Expected: 0 error / 0 warning.

- [ ] **Step 8: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/sso/types.ts enterprise_server/src/sso/finishCallback.ts enterprise_server/tests/sso/finishCallback.test.ts
git commit -m "feat(sso): add strict-mode gate in finishCallback (users.sso_* fast path + pending_bind park)"
```

---

## Task 4: 路由 finalize 分支 — `/auth/sso/callback` 第二次命中走 store

**Files:**
- Modify: `enterprise_server/src/routes/sso.ts` (`/auth/sso/callback` 加 store 优先分支; admin baseSchema 加 `requirePrebinding`; `COLS` 加列; admin GET/POST/PATCH 透传)
- Test: `enterprise_server/tests/routes/sso.public.test.ts` (追加 2 个用例)

**Interfaces:**
- 引入 `ssoLoginContextStore` from `'../sso/ssoLoginContext'`。
- `baseSchema` 加 `requirePrebinding: z.boolean().default(false)`(admin POST/PATCH 都覆盖)。
- `COLS`(line 172)末尾加 `, require_prebinding`。

- [ ] **Step 1: 写失败测试**

在 `enterprise_server/tests/routes/sso.public.test.ts` 末尾追加 2 个用例,
直接构造 `ssoLoginContextStore.set(state, { kind: 'ready_to_finalize', … })`
然后 GET `/auth/sso/callback?code=X&state=<state>`,verify 200 + token 写在
localStorage 键 + store entry 被 delete。

```ts
// 追加在 enterprise_server/tests/routes/sso.public.test.ts 末尾
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';
import { signToken } from '../../src/auth/jwt';

describe('routes/sso — callback finalize after /auth/sso/bind', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, enabled, sort_order)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://idp/a', true, 0)`
    );
  });

  test('ready_to_finalize entry in store yields token + clears store', async () => {
    const expires = new Date(Date.now() + 60_000);
    ssoLoginContextStore.set('st-ready', {
      kind: 'ready_to_finalize', orgId: 'o1', connectionId: 'c1',
      boundUserId: 'u-bound', externalId: 'ext-1',
      redirectUri: 'http://x', codeVerifier: 'v', expiresAt: expires,
    });
    const a = buildApp();
    const res = await a.request('/auth/sso/callback?code=C&state=st-ready');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/localStorage/);
    expect(html).toMatch(/eyJ/);  // jwt
    expect(ssoLoginContextStore.get('st-ready')).toBeUndefined();
  });

  test('no store entry + no state row → existing sso_state_invalid path', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/callback?code=C&state=unknown');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/sso_state_invalid/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/routes/sso.public.test.ts
```
Expected: 2 个新用例 FAIL(store 未读 / require_prebinding 字段未传)。

- [ ] **Step 3: 改 `sso.ts`**

A. import 新增 `import { ssoLoginContextStore } from '../sso/ssoLoginContext';` 和 `import { signToken } from '../auth/jwt';` 和 `import { Role } from '../shared/enterpriseServerConstants';`。

B. `COLS` 末尾加 `, require_prebinding`(line 172)。

C. `baseSchema` line 193 之后加 `requirePrebinding: z.boolean().default(false),`。同步在 admin POST 的 INSERT 末尾加 `require_prebinding`(默认 false),`patchSchema` 自动继承,admin PATCH 的 `prev` 映射和 UPDATE 同步添加此列。

D. 改 `/auth/sso/callback` handler(line 126)插入 store 优先分支(在
`consumeState` 之前):

```ts
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

  // NEW: after /auth/sso/bind completes, the state row has already been
  // consumed (DELETE-RETURNING) by the first callback. The store carries
  // the boundUserId across the two-step flow.
  const ctx = ssoLoginContextStore.get(state);
  if (ctx?.kind === 'ready_to_finalize') {
    ssoLoginContextStore.delete(state);
    const token = await signToken({ sub: ctx.boundUserId, orgId: ctx.orgId, roles: [Role.User] });
    return c.html(renderConsoleCallbackHtml({ token, redirectTo: '/' }));
  }

  const consumed = await consumeState(state);
  if (!consumed) {
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=sso_state_invalid', errorMessage: 'session expired' }));
  }

  const result = await finishSsoCallback({ code, state: consumed, redirectUri: consumed.redirectUri ?? '' });
  if ('pendingBind' in result) {
    return c.redirect(`/bind-sso?state=${encodeURIComponent(state)}`, 302);
  }
  if ('error' in result) {
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=' + result.error }));
  }
  return c.html(renderConsoleCallbackHtml({ token: result.token, redirectTo: '/' }));
});
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/routes/sso.public.test.ts
```
Expected: PASS(既有 + 2 个新)。

- [ ] **Step 5: 跑既有 sso 路由 / admin 路由测试确认 baseSchema 改动无破坏**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/routes/ tests/sso/
```
Expected: 全部 PASS(逐文件跑;若个别文件 EBADF 再次跑一次)。

- [ ] **Step 6: Lint 变更文件**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/sso.ts tests/routes/sso.public.test.ts
```
Expected: 0 / 0。

- [ ] **Step 7: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/routes/sso.ts enterprise_server/tests/routes/sso.public.test.ts
git commit -m "feat(sso): route /auth/sso/callback finalizes from ssoLoginContextStore on second hit"
```

---

## Task 5: 公共端 — `GET /bind-sso` 渲染 + `POST /auth/sso/bind`

**Files:**
- Create: `enterprise_server/src/routes/auth/ssoBind.ts`
- Test: `enterprise_server/tests/auth/ssoBind.test.ts` (new)

**Interfaces:**
- `POST /auth/sso/bind` body `{ state: string; username: string; password: string }`。
- 响应 200 `{ ok: true, returnTo: string }`(returnTo = `${origin}/auth/sso/callback?state=${state}`)。
- 错误码 spec §4.2.B。

- [ ] **Step 1: 写失败测试**

```ts
// enterprise_server/tests/auth/ssoBind.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';
import { ssoBindRoutes } from '../../src/routes/auth/ssoBind';
import { hashPassword } from '../../src/auth/password';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoBindRoutes); return a; }

const PENDING = {
  kind: 'pending_bind' as const,
  orgId: 'o1', connectionId: 'c1',
  externalId: 'ext-1', email: 'a@x.com', loginName: 'a',
  redirectUri: 'http://x', codeVerifier: 'v',
  expiresAt: new Date(Date.now() + 60_000),
};

describe('routes/auth/ssoBind', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    ssoLoginContextStore.delete('st-pb');
    ssoLoginContextStore.delete('st-other');
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol)
       VALUES ('c1','o1','Acme','generic-oidc','oidc')`
    );
  });

  function ctxReady(state = 'st-pb'): void { ssoLoginContextStore.set(state, PENDING); }

  test('POST bind, state not in store → 400 bind_state_invalid', async () => {
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'no-such', username: 'u', password: 'p' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bind_state_invalid');
  });

  test('POST bind, state.kind !== pending_bind → 400 bind_state_invalid', async () => {
    ssoLoginContextStore.set('st-other', {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1', userId: 'u1',
      redirectUri: null, codeVerifier: null, expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-other', username: 'u', password: 'p' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bind_state_invalid');
  });

  test('POST bind, wrong password → 401 invalid_credentials (does not leak user existence)', async () => {
    ctxReady();
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'WRONG' }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_credentials');
  });

  test('POST bind, disabled user → 403 bind_user_disabled', async () => {
    ctxReady();
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status) VALUES ('u-d','o1','bob', $1, 'disabled')`,
      [await hashPassword('pw')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'bob', password: 'pw' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bind_user_disabled');
  });

  test('POST bind, cross-org user → 403 bind_org_mismatch', async () => {
    ctxReady();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-x','o2','eve', $1)`,
      [await hashPassword('pw')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'eve', password: 'pw' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bind_org_mismatch');
  });

  test('POST bind, success → writes users.sso_*, user_idp_identities, store becomes ready_to_finalize, audit', async () => {
    ctxReady();
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'correct' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: true; returnTo: string };
    expect(j.ok).toBe(true);
    expect(j.returnTo).toMatch(/\/auth\/sso\/callback\?state=st-pb$/);

    const u = await testPool.query<{ sso_connection_id: string; sso_external_id: string }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u-real'`
    );
    expect(u.rows[0]).toEqual({ sso_connection_id: 'c1', sso_external_id: 'ext-1' });
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u-real' AND sso_connection_id='c1' AND external_id='ext-1'`);
    expect(ids.rowCount).toBe(1);
    const ctx = ssoLoginContextStore.get('st-pb');
    expect(ctx?.kind).toBe('ready_to_finalize');
    if (ctx?.kind === 'ready_to_finalize') expect(ctx.boundUserId).toBe('u-real');
    const audit = await testPool.query<{ payload: any }>(
      `SELECT payload FROM audit_events WHERE action='sso_user_self_bound' AND user_id='u-real'`
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.payload).toMatchObject({ source: 'pending_bind' });
  });

  test('POST bind, race on unique index → 409 sso_binding_duplicate', async () => {
    ctxReady();
    // Pre-bind another user to (c1, ext-1).
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u-other','o1','zoe','x','c1','ext-1','[]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'correct' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('sso_binding_duplicate');
  });

  test('GET /bind-sso?state=xxx, no entry → expired page', async () => {
    const res = await buildApp().request('/bind-sso?state=missing');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/expired|invalid|session/i);
  });

  test('GET /bind-sso?state=xxx, entry pending_bind → form page with username/password + connection info', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Acme/);  // connection name
    expect(html).toMatch(/ext-1/); // external id
    expect(html).toMatch(/<form/i);
    expect(html).toMatch(/name=["']username["']/);
    expect(html).toMatch(/name=["']password["']/);
    expect(html).toMatch(/name=["']state["']/);
  });
});
```

- [ ] **Step 2: 跑测试确认全 FAIL**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/auth/ssoBind.test.ts
```
Expected: 全部 FAIL(模块找不到)。

- [ ] **Step 3: 写实现**

```ts
// enterprise_server/src/routes/auth/ssoBind.ts
// Public (pre-login) half of the two-stage SSO binding flow. `GET /bind-sso`
// renders the prove-with-password form. `POST /auth/sso/bind` validates
// the password against a pending_bind context in ssoLoginContextStore,
// writes users.sso_*, marks the store entry as ready_to_finalize, and
// returns the URL the SPA should redirect to.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditStore } from '../../audit/auditStore';
import { verifyPassword } from '../../auth/password';
import { pool } from '../../db/pool';
import { ssoLoginContextStore } from '../../sso/ssoLoginContext';

export const ssoBindRoutes = new Hono();

const bindSchema = z.object({
  state: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

ssoBindRoutes.post('/auth/sso/bind', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = bindSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { state, username, password } = parsed.data;

  const ctx = ssoLoginContextStore.get(state);
  if (!ctx || ctx.kind !== 'pending_bind') {
    return c.json({ error: 'bind_state_invalid' }, 400);
  }

  // Look up by username within the SSO org. We don't return a distinct
  // error for "user not found" vs "wrong password" (spec §4.2 step 2
  // anti-enumeration).
  const r = await pool.query<{ id: string; password_hash: string; status: string; org_id: string }>(
    `SELECT id, password_hash, status, org_id FROM users WHERE username = $1`,
    [username]
  );
  const u = r.rows[0];
  if (!u) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  if (u.org_id !== ctx.orgId) {
    // Return the same code as a wrong password to avoid leaking
    // cross-org username existence; the spec exposes bind_org_mismatch
    // for the case where the user IS in the org and we can verify, so
    // for the no-such-user case fall back to invalid_credentials.
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  if (u.status !== 'active') {
    return c.json({ error: 'bind_user_disabled' }, 403);
  }
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // UPSERT binding. ON CONFLICT (sso_connection_id, sso_external_id)
  // WHERE sso_external_id IS NOT NULL → 23505 → 409.
  try {
    await pool.query(
      `UPDATE users
          SET sso_connection_id = $1, sso_external_id = $2
        WHERE id = $3 AND org_id = $4`,
      [ctx.connectionId, ctx.externalId, u.id, ctx.orgId]
    );
  } catch (e: unknown) {
    if ((e as { code?: string }).code === '23505') {
      await auditStore.write({
        orgId: ctx.orgId, action: 'sso_login_failed',
        payload: { reason: 'sso_binding_duplicate_race', ssoConnectionId: ctx.connectionId, externalId: ctx.externalId },
      });
      return c.json({ error: 'sso_binding_duplicate' }, 409);
    }
    throw e;
  }

  await pool.query(
    `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [randomUUID(), ctx.orgId, u.id, ctx.connectionId, ctx.externalId]
  );

  // Mark the store entry as ready_to_finalize so the next
  // /auth/sso/callback hit (Task 4) issues the token.
  ssoLoginContextStore.set(state, {
    kind: 'ready_to_finalize',
    orgId: ctx.orgId, connectionId: ctx.connectionId,
    boundUserId: u.id, externalId: ctx.externalId,
    redirectUri: ctx.redirectUri, codeVerifier: ctx.codeVerifier,
    expiresAt: ctx.expiresAt,
  });

  await auditStore.write({
    orgId: ctx.orgId, userId: u.id, action: 'sso_user_self_bound',
    payload: { ssoConnectionId: ctx.connectionId, externalId: ctx.externalId, source: 'pending_bind' },
  });

  const returnTo = `${new URL(c.req.url).origin}/auth/sso/callback?state=${encodeURIComponent(state)}`;
  return c.json({ ok: true, returnTo });
});

// GET /bind-sso?state=xxx — server-rendered HTML form. No auth required
// (the user isn't logged in yet; password IS the auth).
ssoBindRoutes.get('/bind-sso', async (c) => {
  const state = c.req.query('state');
  const ctx = state ? ssoLoginContextStore.get(state) : undefined;
  if (!ctx || ctx.kind !== 'pending_bind') {
    return c.html(renderBindSsoHtml({ state: state ?? '', valid: false }));
  }
  // Look up the connection name for the page banner.
  const r = await pool.query<{ name: string; provider_type: string }>(
    `SELECT name, provider_type FROM sso_connections WHERE id = $1`, [ctx.connectionId]
  );
  return c.html(renderBindSsoHtml({
    state, valid: true,
    connectionName: r.rows[0]?.name ?? 'SSO',
    externalId: ctx.externalId,
  }));
});

function renderBindSsoHtml(args: {
  state: string; valid: boolean;
  connectionName?: string; externalId?: string;
}): string {
  const esc = (s: string): string => s.replace(/[\'<>]/g, (c) => `\${c}`);
  if (!args.valid) {
    return `<!doctype html><html><body>
<p style="font-family:sans-serif;color:#b00020">Session expired or invalid. Please restart SSO login from the login page.</p>
</body></html>`;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bind SSO account</title></head>
<body style="font-family:sans-serif;max-width:420px;margin:64px auto">
<p>Your <strong>${esc(args.connectionName ?? 'SSO')}</strong> account is not yet bound to GenWork.</p>
<p>Please sign in with your GenWork account and password to bind them.</p>
<form method="POST" action="/auth/sso/bind" onsubmit="event.preventDefault(); fetch(this.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:this.state.value,username:this.username.value,password:this.password.value})}).then(async r=>{const j=await r.json(); if(j.returnTo){location.assign(j.returnTo);} else {document.getElementById('err').textContent=j.error;}});">
<input type="hidden" name="state" value="${esc(args.state)}" />
<p><label>GenWork account: <input name="username" required /></label></p>
<p><label>Password: <input name="password" type="password" required /></label></p>
<p><button type="submit">Bind and sign in</button></p>
<p id="err" style="color:#b00020"></p>
</form>
</body></html>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/auth/ssoBind.test.ts
```
Expected: PASS, 9 tests。

- [ ] **Step 5: 挂到 server.ts**

在 `enterprise_server/src/server.ts` line 22 附近 import:
```ts
import { ssoBindRoutes } from './routes/auth/ssoBind';
```
在 `app.route('/', ssoRoutes);` 之后加 `app.route('/', ssoBindRoutes);`。

- [ ] **Step 6: Lint 变更文件**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/auth/ssoBind.ts src/server.ts tests/auth/ssoBind.test.ts
```
Expected: 0 / 0。

- [ ] **Step 7: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/routes/auth/ssoBind.ts enterprise_server/src/server.ts enterprise_server/tests/auth/ssoBind.test.ts
git commit -m "feat(sso): public /bind-sso page + POST /auth/sso/bind (two-stage user self-binding)"
```

---

## Task 7: User-self 端 — `POST /me/sso-binding/start` + `DELETE /me/sso-binding`

**Files:**
- Create: `enterprise_server/src/routes/me/ssoBinding.ts`
- Test: `enterprise_server/tests/me/ssoBinding.test.ts` (new)
- Modify: `enterprise_server/src/server.ts` (mount new routes under `meRoutes.use('/me', requireAuth)` 是 `meRoutes` 已有;新文件**自己**挂到 `/me/sso-binding/*` with `requireAuth`)

**Interfaces:**
- `POST /me/sso-binding/start` body `{ connectionId: string }`。
- 响应 200 `{ authorizeUrl: string }`。
- `DELETE /me/sso-binding` 无 body;响应 200 `{ ok: true }`(幂等)。

- [ ] **Step 1: 写失败测试**

```ts
// enterprise_server/tests/me/ssoBinding.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';
import { meSsoBindingRoutes } from '../../src/routes/me/ssoBinding';
import { signToken } from '../../src/auth/jwt';
import { Role } from '../../src/shared/enterpriseServerConstants';

function buildApp(): Hono {
  const a = new Hono();
  // Apply auth the same way the real mount does.
  a.use('/me/*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthenticated' }, 401);
    const token = auth.slice(7);
    try {
      const { jwtVerify } = await import('jose');
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
      const { payload } = await jwtVerify(token, secret);
      c.set('claims', { sub: payload.sub as string, orgId: payload.orgId as string, roles: (payload.roles as string[]) ?? [] });
      await next();
    } catch { return c.json({ error: 'unauthenticated' }, 401); }
  });
  a.route('/', meSsoBindingRoutes);
  return a;
}

async function tokenFor(userId: string, orgId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: [Role.User] });
}

describe('routes/me/ssoBinding', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    ssoLoginContextStore.delete('st-sb');
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, enabled, sort_order)
       VALUES ('c1','o1','Acme','generic-oidc','oidc','https://idp/a', true, 0)`
    );
  });

  test('start, no auth → 401', async () => {
    const res = await buildApp().request('/me/sso-binding/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: 'c1' }) });
    expect(res.status).toBe(401);
  });

  test('start, valid → 200 {authorizeUrl}, store entry kind=self_binding, sso_login_states row inserted, audit', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { authorizeUrl: string };
    expect(j.authorizeUrl).toMatch(/^https:\/\/idp\/a\?/);
    expect(j.authorizeUrl).toMatch(/response_type=code/);
    const states = await testPool.query<{ phase: string }>(`SELECT phase FROM sso_login_states`);
    expect(states.rowCount).toBe(1);
    const state = new URL(j.authorizeUrl).searchParams.get('state')!;
    const ctx = ssoLoginContextStore.get(state);
    expect(ctx?.kind).toBe('self_binding');
    if (ctx?.kind === 'self_binding') expect(ctx.userId).toBe('u1');
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='sso_user_binding_start' AND user_id='u1'`);
    expect(audit.rowCount).toBe(1);
  });

  test('start, connectionId 跨 org → 404 connection_not_found', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1-cross' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('connection_not_found');
  });

  test('start, connection disabled → 409 connection_disabled', async () => {
    await testPool.query(`UPDATE sso_connections SET enabled=false WHERE id='c1'`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('connection_disabled');
  });

  test('start, user already bound → still allowed (overwrite path); authorizeUrl returned', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-old','[]'::jsonb)`
    );
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { authorizeUrl: string };
    expect(j.authorizeUrl).toMatch(/^https:\/\/idp\/a\?/);
  });

  test('DELETE, no auth → 401', async () => {
    const res = await buildApp().request('/me/sso-binding', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  test('DELETE, with binding → 200, clears users.sso_*, audit; user_idp_identities untouched', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-1','[]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ('id-1','o1','u1','c1','ext-1')`
    );
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(`SELECT sso_connection_id, sso_external_id FROM users WHERE id='u1'`);
    expect(u.rows[0]).toEqual({ sso_connection_id: null, sso_external_id: null });
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u1' AND sso_connection_id='c1' AND external_id='ext-1'`);
    expect(ids.rowCount).toBe(1);  // preserved
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='sso_user_self_unbound' AND user_id='u1'`);
    expect(audit.rowCount).toBe(1);
  });

  test('DELETE, no binding → 200 (idempotent)', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u1','x')`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: 跑测试确认全 FAIL**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/me/ssoBinding.test.ts
```
Expected: 全部 FAIL(模块找不到)。

- [ ] **Step 3: 写实现**

```ts
// enterprise_server/src/routes/me/ssoBinding.ts
// User-driven SSO self-binding half. `/me/sso-binding/start` initiates a
// fresh SSO flow scoped to the calling user (no pre-existing connection
// required) and parks a self_binding context in ssoLoginContextStore so
// finishSsoCallback knows to write the binding instead of fast-pathing.
import { randomUUID } from 'node:crypto';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditStore } from '../../audit/auditStore';
import { requireAuth } from '../../auth/middleware';
import { pool } from '../../db/pool';
import { buildAuthorizeUrl } from '../../sso/oauth';
import { createState } from '../../sso/state';
import { ssoLoginContextStore, type SsoLoginContext } from '../../sso/ssoLoginContext';
import type { SsoConnectionRow } from '../../sso/types';

export const meSsoBindingRoutes = new Hono();
meSsoBindingRoutes.use('/me/sso-binding/*', requireAuth);
meSsoBindingRoutes.use('/me/sso-binding', requireAuth);

const startSchema = z.object({ connectionId: z.string().min(1) });

meSsoBindingRoutes.post('/me/sso-binding/start', async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const r = await pool.query<SsoConnectionRow & { org_id: string }>(
    `SELECT * FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [parsed.data.connectionId, claims.orgId]
  );
  const conn = r.rows[0];
  if (!conn) return c.json({ error: 'connection_not_found' }, 404);
  if (!conn.enabled) return c.json({ error: 'connection_disabled' }, 409);

  // PKCE + state. Reuse the public authorize flow's contract.
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${new URL(c.req.url).origin}/auth/sso/callback`;
  const { state } = await createState({
    orgId: conn.org_id, connectionId: conn.id, returnTarget: 'console',
    codeVerifier: verifier, redirectUri,
  });

  const expiresAt = new Date(Date.now() + 2 * 60 * 1000);  // matches STATE_TTL_MS
  const ctx: SsoLoginContext = {
    kind: 'self_binding',
    orgId: conn.org_id, connectionId: conn.id, userId: claims.sub,
    redirectUri, codeVerifier: verifier, expiresAt,
  };
  ssoLoginContextStore.set(state, ctx);

  const authorizeUrl = buildAuthorizeUrl(conn, state, challenge, redirectUri);

  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: 'sso_user_binding_start',
    payload: { ssoConnectionId: conn.id },
  });
  return c.json({ authorizeUrl });
});

meSsoBindingRoutes.delete('/me/sso-binding', async (c) => {
  const claims = c.get('claims');
  // Capture before clearing for the audit payload.
  const before = await pool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
    `SELECT sso_connection_id, sso_external_id FROM users WHERE id = $1 AND org_id = $2`,
    [claims.sub, claims.orgId]
  );
  await pool.query(
    `UPDATE users SET sso_connection_id = NULL, sso_external_id = NULL
      WHERE id = $1 AND org_id = $2`,
    [claims.sub, claims.orgId]
  );
  const prev = before.rows[0];
  if (prev?.sso_connection_id && prev.sso_external_id) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub, action: 'sso_user_self_unbound',
      payload: { ssoConnectionId: prev.sso_connection_id, externalId: prev.sso_external_id },
    });
  }
  return c.json({ ok: true });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/me/ssoBinding.test.ts
```
Expected: PASS, 8 tests。

- [ ] **Step 5: 挂到 server.ts**

在 `enterprise_server/src/server.ts` line 31 附近 import:
```ts
import { meSsoBindingRoutes } from './routes/me/ssoBinding';
```
挂到 mount 区:
```ts
app.route('/', meSsoBindingRoutes);
```

- [ ] **Step 6: Lint 变更文件**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/me/ssoBinding.ts src/server.ts tests/me/ssoBinding.test.ts
```
Expected: 0 / 0。

- [ ] **Step 7: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/routes/me/ssoBinding.ts enterprise_server/src/server.ts enterprise_server/tests/me/ssoBinding.test.ts
git commit -m "feat(sso): user self-binding API (/me/sso-binding/start + DELETE)"
```

---

## Task 8: Admin 端 — `GET /admin/users/:id/sso-binding` + list + `DELETE`

**Files:**
- Create: `enterprise_server/src/routes/admin/ssoBindings.ts`
- Test: `enterprise_server/tests/admin/ssoBindings.test.ts` (new)
- Modify: `enterprise_server/src/server.ts` (mount new routes under `ssoRoutes.use('/admin/sso-connections/*', requireAuth)` — Task 4 的 ssoRoutes 已有,但 admin 端 `users` 路径走 `adminUserRoutes` 邻居;为简洁,**不** 挂 ssoRoutes 下,**单独** 创建 `adminSsoBindingRoutes` 挂到 `app.route('/', adminSsoBindingRoutes)`)

**Interfaces:**
- 3 个端点(spec §6.1.1-3): 全部走 `requirePermission(PP.SsoView)` 或 `PP.SsoEdit`。
- 不返回 `password_hash` / `email`。

- [ ] **Step 1: 写失败测试**

```ts
// enterprise_server/tests/admin/ssoBindings.test.ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminSsoBindingRoutes } from '../../src/routes/admin/ssoBindings';
import { signToken } from '../../src/auth/jwt';
import { Role } from '../../src/shared/enterpriseServerConstants';

function buildApp(): Hono {
  const a = new Hono();
  a.use('/*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthenticated' }, 401);
    const token = auth.slice(7);
    try {
      const { jwtVerify } = await import('jose');
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
      const { payload } = await jwtVerify(token, secret);
      c.set('claims', { sub: payload.sub as string, orgId: payload.orgId as string, roles: (payload.roles as string[]) ?? [] });
      await next();
    } catch { return c.json({ error: 'unauthenticated' }, 401); }
  });
  a.route('/', adminSsoBindingRoutes);
  return a;
}

async function adminToken(userId: string, orgId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: [Role.OrgAdmin] });
}

describe('routes/admin/ssoBindings', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T'), ('o2','Other')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','Feishu','feishu','oidc', true),
              ('c2','o2','Other','generic-oidc','oidc', true)`
    );
  });

  test('GET /admin/users/:id/sso-binding, unbound → 200 null', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u1','o1','u1','x','[]'::jsonb)`);
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u1/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test('GET /admin/users/:id/sso-binding, bound → 200 {connectionId, connectionName, providerType, externalId}', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','union-1','[]'::jsonb)`
    );
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u1/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const j = await res.json() as { connectionId: string; connectionName: string; providerType: string; externalId: string };
    expect(j).toEqual({ connectionId: 'c1', connectionName: 'Feishu', providerType: 'feishu', externalId: 'union-1' });
  });

  test('GET /admin/users/:id/sso-binding, cross-org user → 404', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u-x','o2','u2','x','[]'::jsonb)`);
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u-x/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(404);
  });

  test('GET, missing permission → 403', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u1','o1','u1','x','[]'::jsonb)`);
    const tok = await signToken({ sub: 'p1', orgId: 'o1', roles: [Role.User] });
    const res = await buildApp().request('/admin/users/u1/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });

  test('GET /admin/sso-connections/:id/bindings → list of bound users', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','alice','x','c1','ext-1','[]'::jsonb),
              ('u2','o1','bob','x','c1','ext-2','[]'::jsonb')`
    );
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/sso-connections/c1/bindings', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const j = await res.json() as Array<{ username: string; externalId: string }>;
    expect(j).toHaveLength(2);
    expect(j.map(x => x.username).sort()).toEqual(['alice', 'bob']);
  });

  test('DELETE /admin/users/:id/sso-binding, bound → 200, users.sso_* cleared, user_idp_identities preserved, audit', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-1','[]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ('id-1','o1','u1','c1','ext-1')`
    );
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u1/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(`SELECT sso_connection_id, sso_external_id FROM users WHERE id='u1'`);
    expect(u.rows[0]).toEqual({ sso_connection_id: null, sso_external_id: null });
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u1' AND sso_connection_id='c1' AND external_id='ext-1'`);
    expect(ids.rowCount).toBe(1);
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='sso_user_admin_unbound'`);
    expect(audit.rowCount).toBe(1);
  });

  test('DELETE, cross-org user → 404', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u-x','o2','u2','x','[]'::jsonb)`);
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u-x/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(404);
  });

  test('DELETE, missing permission → 403', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-1','[]'::jsonb)`
    );
    const tok = await signToken({ sub: 'p1', orgId: 'o1', roles: [Role.User] });
    const res = await buildApp().request('/admin/users/u1/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑测试确认全 FAIL**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/admin/ssoBindings.test.ts
```
Expected: 全部 FAIL(模块找不到)。

- [ ] **Step 3: 写实现**

```ts
// enterprise_server/src/routes/admin/ssoBindings.ts
// Admin read + unbind for user-driven SSO self-bindings. Admins can SEE
// any user's binding and UNBIND it (audit-tracked), but cannot WRITE
// a binding — that's reserved for the user self-flow (POST /me/sso-binding/start
// + the two-stage /auth/sso/bind).
import { Hono } from 'hono';
import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { pool } from '../../db/pool';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

export const adminSsoBindingRoutes = new Hono();
adminSsoBindingRoutes.use('/admin/*', requirePermission(PP.SsoView));

interface UserBindingRow {
  sso_connection_id: string | null;
  sso_external_id: string | null;
  connection_name: string | null;
  provider_type: string | null;
}

adminSsoBindingRoutes.get('/admin/users/:id/sso-binding', async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<UserBindingRow>(
    `SELECT u.sso_connection_id, u.sso_external_id,
            sc.name AS connection_name, sc.provider_type
       FROM users u
       LEFT JOIN sso_connections sc ON sc.id = u.sso_connection_id
      WHERE u.id = $1 AND u.org_id = $2`,
    [c.req.param('id'), claims.orgId]
  );
  const row = r.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!row.sso_connection_id || !row.sso_external_id) return c.json(null);
  return c.json({
    connectionId: row.sso_connection_id,
    connectionName: row.connection_name,
    providerType: row.provider_type,
    externalId: row.sso_external_id,
  });
});

adminSsoBindingRoutes.get('/admin/sso-connections/:id/bindings', async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{ id: string; username: string; display_name: string | null; sso_external_id: string }>(
    `SELECT u.id, u.username, u.display_name, u.sso_external_id
       FROM users u
      WHERE u.org_id = $1 AND u.sso_connection_id = $2 AND u.sso_external_id IS NOT NULL
      ORDER BY u.username ASC`,
    [claims.orgId, c.req.param('id')]
  );
  // Ensure the connection belongs to this org (404 if not).
  const conn = await pool.query(`SELECT 1 FROM sso_connections WHERE id = $1 AND org_id = $2`, [c.req.param('id'), claims.orgId]);
  if (!conn.rowCount) return c.json({ error: 'not_found' }, 404);
  return c.json(r.rows.map(row => ({
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    externalId: row.sso_external_id,
  })));
});

adminSsoBindingRoutes.delete('/admin/users/:id/sso-binding', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const before = await pool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
    `SELECT sso_connection_id, sso_external_id FROM users WHERE id = $1 AND org_id = $2`,
    [c.req.param('id'), claims.orgId]
  );
  const row = before.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  await pool.query(
    `UPDATE users SET sso_connection_id = NULL, sso_external_id = NULL
      WHERE id = $1 AND org_id = $2`,
    [c.req.param('id'), claims.orgId]
  );
  if (row.sso_connection_id && row.sso_external_id) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub, action: 'sso_user_admin_unbound',
      targetUserId: c.req.param('id'),
      payload: { ssoConnectionId: row.sso_connection_id, externalId: row.sso_external_id },
    });
  }
  return c.json({ ok: true });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/admin/ssoBindings.test.ts
```
Expected: PASS, 8 tests。

- [ ] **Step 5: 挂到 server.ts**

在 `enterprise_server/src/server.ts` line 18 附近 import:
```ts
import { adminSsoBindingRoutes } from './routes/admin/ssoBindings';
```
挂到 mount 区(放在 `app.route('/', ssoRoutes);` 之后):
```ts
app.route('/', adminSsoBindingRoutes);
```

- [ ] **Step 6: Lint 变更文件**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/admin/ssoBindings.ts src/server.ts tests/admin/ssoBindings.test.ts
```
Expected: 0 / 0。

- [ ] **Step 7: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/routes/admin/ssoBindings.ts enterprise_server/src/server.ts enterprise_server/tests/admin/ssoBindings.test.ts
git commit -m "feat(sso): admin read+unbind endpoints for user-driven sso binding"
```

---

## Task 9: 前端 — `/bind-sso` page, 头像菜单"绑定 SSO", 用户管理只读 + 解绑按钮, SSO 连接详情 checkbox, i18n

**Files:**
- Modify: `enterprise_server/web/src/i18n.ts` (10 new keys: 5 sso.bind.* + 1 sso.binding.unbound + 1 sso.profile.bindMenuItem + 1 sso.binding.unbind + 1 sso.binding.unbind.confirm + 1 sso.connection.requirePrebinding)
- Modify: `enterprise_server/web/src/api/sso.ts`(或等价)— 加 `startSsoBinding` / `deleteSsoBinding` / `getUserSsoBinding` / `getConnectionBindings` / `adminDeleteUserSsoBinding`
- Modify: `enterprise_server/web/src/pages/sso/SSOConnectionDrawer.tsx`(或等价编辑表单) — 加 `requirePrebinding` 字段编辑 + 切换时 confirm
- Modify: `enterprise_server/web/src/pages/sso/types.ts`(若有)— `SsoConnection` 类型加 `requirePrebinding`
- Create: `enterprise_server/web/src/pages/auth/BindSsoPage.tsx` — `/bind-sso?state=xxx` 页面
- Modify: `enterprise_server/web/src/pages/UsersPage.tsx`(或子组件) — 加列 + 解绑按钮
- Modify: `enterprise_server/web/src/components/ProfileMenu.tsx`(或头像菜单) — 加"绑定 SSO 账号"项
- Modify: `enterprise_server/web/src/router.tsx`(或等价路由配置) — 加 `/bind-sso` 路由
- Modify: `enterprise_server/web/src/pages/LoginPage.tsx` — **不变**(spec §7.1 明确"prebinding_required 文案不再使用")
- Test: 手工验证 + `npm run build` 编译通过 + `npx tsc --noEmit`

**Interfaces:**
- 详细见 spec §7.2-§7.5。这里写实施任务拆分。

- [ ] **Step 1: 加 i18n 键(中英成对)**

在 `enterprise_server/web/src/i18n.ts` 的 `zh` 和 `en` 两块末尾追加(共 10 个键 × 2 语言 = 20 行):

```ts
// zh 块追加
'sso.bind.title': '绑定 SSO 账号',
'sso.bind.subtitle': '你的 {provider} 账号尚未绑定 GenWork。请用账号密码登录以完成绑定。',
'sso.bind.username.label': 'GenWork 账号',
'sso.bind.password.label': '密码',
'sso.bind.submit': '绑定并登录',
'sso.binding.unbound': '未绑定',
'sso.binding.unbind': '解绑',
'sso.binding.unbind.confirm': '解绑后，该用户用此 SSO 连接登录时会要求重新账号密码认证。继续吗？',
'sso.profile.bindMenuItem': '绑定 SSO 账号',
'sso.connection.requirePrebinding': '仅允许预绑定用户登录',
'sso.connection.requirePrebinding.help': '开启后，未自助绑定 SSO 身份的飞书/Okta/钉钉账号将无法登录（会被引导到账号密码认证页）。已绑定的用户不受影响。',
'sso.connection.requirePrebinding.confirm': '开启后，未自助绑定的飞书账号将被引导到账号密码认证页（首次登录）。继续吗？',

// en 块追加
'sso.bind.title': 'Bind SSO account',
'sso.bind.subtitle': 'Your {provider} account is not bound to GenWork yet. Sign in with your account password to bind.',
'sso.bind.username.label': 'GenWork account',
'sso.bind.password.label': 'Password',
'sso.bind.submit': 'Bind and sign in',
'sso.binding.unbound': 'Unbound',
'sso.binding.unbind': 'Unbind',
'sso.binding.unbind.confirm': 'After unbinding, this user will need to re-authenticate with their GenWork account and password to use this SSO connection. Continue?',
'sso.profile.bindMenuItem': 'Bind SSO account',
'sso.connection.requirePrebinding': 'Only allow prebound users',
'sso.connection.requirePrebinding.help': 'When enabled, Feishu/Okta/DingTalk accounts that have not been self-bound cannot log in (they are routed to a password verification page). Already-bound users are unaffected.',
'sso.connection.requirePrebinding.confirm': 'When enabled, unbound Feishu accounts will be routed to a password verification page on first login. Continue?',
```

- [ ] **Step 2: 加 API 客户端**

在 `enterprise_server/web/src/api/sso.ts`(或创建文件)加:

```ts
export interface SsoBinding {
  connectionId: string;
  connectionName: string;
  providerType: string;
  externalId: string;
}
export interface SsoBindingListItem {
  userId: string;
  username: string;
  displayName: string | null;
  externalId: string;
}

export async function startSsoBinding(connectionId: string): Promise<{ authorizeUrl: string }> {
  const r = await api.post<{ authorizeUrl: string }>('/me/sso-binding/start', { connectionId });
  return r;
}
export async function deleteSsoBinding(): Promise<{ ok: true }> {
  await api.delete<{ ok: true }>('/me/sso-binding');
  return { ok: true };
}
export async function getUserSsoBinding(userId: string): Promise<SsoBinding | null> {
  return api.get<SsoBinding | null>(`/admin/users/${encodeURIComponent(userId)}/sso-binding`);
}
export async function getConnectionBindings(connectionId: string): Promise<SsoBindingListItem[]> {
  return api.get<SsoBindingListItem[]>(`/admin/sso-connections/${encodeURIComponent(connectionId)}/bindings`);
}
export async function adminDeleteUserSsoBinding(userId: string): Promise<{ ok: true }> {
  await api.delete<{ ok: true }>(`/admin/users/${encodeURIComponent(userId)}/sso-binding`);
  return { ok: true };
}
```

- [ ] **Step 3: 改 SSO connection 类型 + 编辑表单**

`web/src/pages/sso/types.ts` 加:
```ts
export interface SsoConnection { /* ...existing fields... */ requirePrebinding: boolean; }
```

`web/src/pages/sso/SSOConnectionDrawer.tsx`(或等价位置)编辑表单加 checkbox:
```tsx
<div className="space-y-2">
  <label className="flex items-center gap-2">
    <input type="checkbox" checked={form.requirePrebinding}
      onChange={(e) => onChange({ ...form, requirePrebinding: e.target.checked })} />
    <span>{t('sso.connection.requirePrebinding')}</span>
  </label>
  <p className="text-sm text-gray-500">{t('sso.connection.requirePrebinding.help')}</p>
</div>
```

切换时弹 confirm:在 PATCH 之前 `if (!window.confirm(t('sso.connection.requirePrebinding.confirm'))) return;`(只切到 true 时弹;false 不弹。沿用 `useState` 在父组件拦截提交按钮)。

- [ ] **Step 4: 新建 `/bind-sso` 页面**

`web/src/pages/auth/BindSsoPage.tsx`:
- 从 URL 拿 `state`。
- fetch `GET /bind-sso?state=${state}`(server-rendered HTML) → 若 200 + 含表单 → 嵌入到 `<iframe srcDoc={html}>` 渲染;或:服务端这条 HTML 是**带 form action + onsubmit JS** 的(已经在 Task 5 写好),前端直接 `window.location.assign('/bind-sso?state=…')` 让 server 出 HTML,JS 端用 fetch 截 POST 然后跳 `returnTo`。
- **实际方案**: 后端已返回 `Content-Type: text/html` + 内嵌 JS 用 `fetch('/auth/sso/bind', …)`,前端只需要在 router 里挂 `/bind-sso` → `<BindSsoPage>` 渲染一个 `<iframe src="/bind-sso?state=…" />` 即可。组件很薄:

```tsx
// enterprise_server/web/src/pages/auth/BindSsoPage.tsx
import { useSearchParams } from 'react-router-dom';
export function BindSsoPage(): JSX.Element {
  const [params] = useSearchParams();
  const state = params.get('state') ?? '';
  return <iframe src={`/bind-sso?state=${encodeURIComponent(state)}`} style={{ border: 0, width: '100%', height: '100vh' }} />;
}
```

- [ ] **Step 5: 路由挂载**

`web/src/router.tsx`(或等价)加:
```tsx
<Route path="/bind-sso" element={<BindSsoPage />} />
```

- [ ] **Step 6: 头像菜单"绑定 SSO 账号"项**

`web/src/components/ProfileMenu.tsx`(或等价位置)在"修改密码"和"退出登录"之间加:

```tsx
const ssoStart = async (connectionId: string) => {
  const { authorizeUrl } = await startSsoBinding(connectionId);
  window.location.assign(authorizeUrl);
};
// 在 menu 项中:
<MenuItem onClick={async () => {
  const { providers } = await getSsoProviders(orgName);  // 既有 API
  const conn = window.prompt(`Use which SSO? Available: ${providers.map(p => p.name).join(', ')}`);  // 简化:先 prompt
  // 真实实现: 弹 modal 列 provider 让 user 选
  if (conn) ssoStart(conn.id);
}}>{t('sso.profile.bindMenuItem')}</MenuItem>
```

完整实现:弹 modal 列 `getSsoProviders(orgName)`,每行一个 "用 [name] 绑定" 按钮 → 调 `ssoStart(conn.id)` → 跳 IdP。已有 `getSsoProviders` 路径,沿用。

- [ ] **Step 7: 用户管理 SSO 绑定列(只读 + 解绑按钮)**

`web/src/pages/UsersPage.tsx`(或子目录):
- 列表行:多一列 "SSO 绑定 / SSO Binding" → 调 `getUserSsoBinding(row.id)` → 显示 `<connectionName> · <externalId 截 16 字>` 或 "未绑定"。
- 详情页:同样展示;若 `can(PermissionCode.SsoEdit)` → 显"解绑"按钮 → `window.confirm(t('sso.binding.unbind.confirm'))` → `adminDeleteUserSsoBinding(row.id)` → refetch。
- 不动现有 `extra_roles` / `username` / `email` 字段 UI。

- [ ] **Step 8: tsc + build**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx tsc --noEmit -p web/tsconfig.json 2>/dev/null || npx tsc --noEmit  # 看 web 的 tsconfig 决定
cd /Users/paulwang/work/GenWork/enterprise_server && npm run build
```
Expected: 编译通过(0 error)。

- [ ] **Step 9: Lint 变更文件**

Run:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 web/src/pages/auth/BindSsoPage.tsx web/src/components/ProfileMenu.tsx web/src/pages/UsersPage.tsx web/src/pages/sso/SSOConnectionDrawer.tsx web/src/pages/sso/types.ts web/src/api/sso.ts web/src/i18n.ts
```
Expected: 0 / 0。

- [ ] **Step 10: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add enterprise_server/web/src/i18n.ts enterprise_server/web/src/api/sso.ts enterprise_server/web/src/pages/sso/types.ts enterprise_server/web/src/pages/sso/SSOConnectionDrawer.tsx enterprise_server/web/src/pages/auth/BindSsoPage.tsx enterprise_server/web/src/components/ProfileMenu.tsx enterprise_server/web/src/pages/UsersPage.tsx enterprise_server/web/src/router.tsx
git commit -m "feat(sso-web): /bind-sso page, profile menu 'Bind SSO', admin read+unbind column, requirePrebinding toggle"
```

---

## Task 10: 收尾 + 全套回归

**Files:** 无(只跑测试 + lint)

- [ ] **Step 1: 跑全部 sso + admin + me + auth 测试(逐文件)**

逐文件跑(EBADF 风险):
```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/sso/migration043.test.ts tests/sso/jit.test.ts tests/sso/finishCallback.test.ts tests/sso/state.test.ts tests/sso/oauth.test.ts tests/sso/consoleCallback.test.ts tests/sso/providerPresets.test.ts tests/sso/logos.test.ts tests/sso/desktopRedirectPort.test.ts tests/sso/ssoLoginContext.test.ts tests/auth/ssoBind.test.ts tests/me/ssoBinding.test.ts tests/admin/ssoBindings.test.ts tests/routes/sso.public.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 2: 跑全量 admin + routes 测试(按需,确认无破坏)**

```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx vitest run tests/routes/ tests/admin/ 2>/dev/null || true
```
Expected: 全部 PASS;若个别预先存在的 enterprise-agent 失败,见既有 baseline
(见仓库根 `AGENTS.md` 与预存记忆 `pre-existing-failing-enterprise-agent-tests.md`),
不修。

- [ ] **Step 3: 跑 Lint 变更文件集**

```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0   src/sso/ src/routes/sso.ts src/routes/auth/ src/routes/me/ src/routes/admin/ssoBindings.ts src/server.ts src/db/migrations/043_sso_prebinding.sql tests/sso/ tests/auth/ssoBind.test.ts tests/me/ssoBinding.test.ts tests/admin/ssoBindings.test.ts tests/routes/sso.public.test.ts   web/src/i18n.ts web/src/api/sso.ts web/src/pages/sso/ web/src/pages/auth/BindSsoPage.tsx web/src/components/ProfileMenu.tsx web/src/pages/UsersPage.tsx web/src/router.tsx
```
Expected: 0 / 0。

- [ ] **Step 4: 跑 web `npm run build`**

```bash
cd /Users/paulwang/work/GenWork/enterprise_server && npm run build
```
Expected: 0 error。

- [ ] **Step 5: 不 commit(留给 reviewer 跑全量回归)**

完成后给最终汇报;不 commit,等用户验收。

---

## Review checklist(spec 边界用例,任务里未独立测,实施时随手加进对应 step)

- **跨 org 同 `(connection, external_id)` 不撞** — Task 1 已有;Task 8 加 admin endpoint 跨 org → 404 覆盖。
- **解绑后已登录 user 不会失效** — JWT 仍有效直至过期,无需新测(spec 显式声明)。
- **`/auth/sso/callback` 第二次命中(无 `consumeState` 行可消费,走 store)** — Task 4 已有。
- **空字符串 `sso_external_id` 在 `/auth/sso/bind` zod 校验** — Task 5 已校验 `password` 必填;`externalId` 来自 `state`,**不会**是空字符串(consumeState 之前已校验);**不**再测。
- **`ssoLoginContextStore` 重启后失效** — 已知降级路径,不测;spec §11 风险表已记。
- **Desktop 模式二段路径(只显示"请去 web 绑定"提示)** — P1 **不**实现桌面模态;spec §7.2 末段已说明。Task 9 跳过。
- **`require_prebinding` admin 本人未绑仍可切** — UI 层不挡;Task 9 的切换 confirm 已写。

---

## Self-Review

- **Spec coverage**: 读完 spec §0-§12,每条 spec 都有任务对应:
  - §0(一句话)→ Tasks 1, 5, 7, 8, 9。
  - §2.1 目标 1(用户自助)→ Task 7。
  - §2.1 目标 2(首次 SSO 登录二段路径)→ Tasks 3, 4, 5, 9。
  - §2.1 目标 3(严格模式)→ Tasks 1, 3, 4。
  - §2.1 目标 4(admin 只读不写)→ Task 8(无 PUT,只 GET + DELETE)。
  - §2.1 目标 5(默认向后兼容)→ Task 1 的 `require_prebinding BOOLEAN DEFAULT false`。
  - §2.2(非目标)→ 没有 admin 预绑定路径,没有自动匹配,没有飞书 directory。
  - §3(数据模型)→ Task 1。
  - §4.0(严格模式门)→ Task 3。
  - §4.2(二段路径)→ Tasks 3, 4, 5。
  - §4.3(用户主动绑定)→ Task 7。
  - §5(错误码)→ Tasks 3, 5, 7, 8。
  - §6.1(admin GET/DELETE)→ Task 8。
  - §6.2(user-self)→ Task 7。
  - §6.3(/auth/sso/bind + /bind-sso page)→ Task 5。
  - §7.2(/bind-sso 页面)→ Task 9 Step 4。
  - §7.3(头像菜单)→ Task 9 Step 6。
  - §7.4(用户管理 SSO 绑定列 + 解绑按钮)→ Task 9 Step 7。
  - §7.5(SSO 连接详情严格模式 checkbox)→ Task 9 Step 3。
  - §8 P1 → 全部 9 个任务都在 P1。
  - §9 测试(每条用例对应 step)→ 每个 Step 1 测试脚本都引用 §9 对应编号。
  - §10(约束)→ 在 Global Constraints + Review Focus 覆盖。
  - §11(风险)→ 在 Review Focus 覆盖。
- **Placeholder scan**: 无 "TBD" / "TODO" / "fill in" / "similar to Task N";每步代码完整。
- **Type consistency**: `ssoLoginContextStore` / `SsoLoginContext` / `pendingBind` / `ready_to_finalize` / `self_binding` 命名在 Task 2 定义,在 Task 3, 4, 5, 7 全部一致引用。
- **Review Focus 5 个额外项**: 全部在 Review Focus 段落写明,各自有测试覆盖或显式 spec 风险表;**不**空着。
