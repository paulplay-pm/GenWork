# SSO 用户自助绑定 + 白名单模式 — 设计（GenWork 企业版）

> **接续:** 本 spec 建立在
> [`2026-09-27-enterprise-sso-member-login-federation-design.md`](./2026-09-27-enterprise-sso-member-login-federation-design.md)
> 之上,沿用其数据模型 / JIT 流程 / 管理端 / 安全约束的全局约定,只描述新增的
> "用户自助绑定"层。读这份 spec 前先读过 09-27 那一篇。

---

## 0. 一句话

把 "IdP 身份 ↔ 本地 user" 的绑定**从 admin 后台手动**改为**用户自助**:
- 已有账号密码的 user 在头像菜单里点"绑定 SSO 账号"→ 走完整 SSO 流程
  → 成功后在 `users` 表上写入 `(sso_connection_id, sso_external_id)`。
- 通过 SSO 登录且**未绑**的 IdP 身份 → 跳转"先账号密码证明身份"页面 →
  验证通过后,回原 SSO 流程完成首次登录 + 自动建立绑定。
- admin 只能**查看**所有 user 的自助绑定结果,不能**新增 / 改写**(防止
  社工);admin 和 user 都能**解绑**。
- `sso_connections` 上的 `require_prebinding` 开关语义不变:开启后,未
  绑定的 IdP 身份必须走"先账号密码"的二段路径;已绑定的直接放行。

---

## 1. 背景与动机

v1 JIT(见 09-27 spec §5)的行为是:**任何能完成 IdP 授权的人,都会自动生成一个
本地 user**。当 IdP 是企业全员都能进的飞书、Okta 时,意味着:

- 任何飞书账号都能登进 GenWork → 不在 GenWork 名册上的人也能进来。
- 用户名自动用 `sso-${external_id 前 8 位}` 之类生成,组织盘点困难(看不到"谁是谁")。
- audit 记录里只有一个外部 id,没有"属于 GenWork 哪个 user"的语义挂钩。

v1 admin 预绑定的设计(spec 之前的版本)虽然解决了"谁有资格",但要求 admin
在后台逐人填 `union_id` / `sub` —— 这在百人以下小公司行得通,千人以上需要每
次新人入职都开后台配一次,运营成本高;且 admin 拿不到 union_id 的路径
(飞书 app 加 `contact:user.id:readonly` scope + 拉通讯录)本身又是一个
独立工程。

**用户自助绑定**换一种思路:**让 user 自己证明"我既是飞书那边的人,也是
GenWork 那个账号的主人"**。证明方式是"我能登进自己的 GenWork 账号密码"——
这道门只对账号主人开,绑上之后飞书那边的 union_id 跟 GenWork user 就锁
死了。

注意:本 spec **不**改 `email_domain_whitelist` 的语义(它只校验"邮箱后缀是否
落在允许的域名集合里",和"该 IdP 身份是否对应到 GenWork 名册上的某个 user"是两
个不同维度的问题;两者独立,可叠加)。

---

## 2. 目标与范围

### 2.1 目标

1. **用户自助绑定**(主路径): user 用账号密码登录后,头像菜单里点"绑
   定 SSO 账号"→ 走完整 SSO 流程,成功后自动在 `users.sso_connection_id`
   / `users.sso_external_id` 写入 `(connectionId, externalId)`。该 user
   后续用同 IdP 身份登录即可一键进入。
2. **首次 SSO 登录二段路径**(兜底): 通过 SSO 登录但 `users` 表里**无
   任何 user** 拥有该 `(connectionId, externalId)` → 跳转"先账号密码证
   明身份"页 → 验证通过后,既完成首次 SSO 登录,又**自动**建立该 user
   与该 IdP 身份的绑定。
3. **`sso_connections` 严格模式**开关语义保持:开启后,未绑定的 IdP 身
   份必须走"先账号密码"的二段路径(目标 2);已绑定的直接放行(目标 1
   后续每次)。
4. **admin 只读不写**: admin 在用户管理页**可查看**(每个 user 的
   绑定状态、`(connection, external_id)` 是什么),但**不能新增 / 改
   写**绑定(防社工:防止 admin 把 user A 绑到 user B 的飞书身份)。**解
   绑**则 admin 和 user 都能做。
5. 默认行为(开关关闭)与 v1 一致,**完全向后兼容**。

### 2.2 非目标 (Out of scope)

- **不做**任何"自动匹配":既不通过手机号、也不通过邮箱、也不通过姓名做
  GenWork user ↔ IdP 身份的自动关联(必然错配)。**只接受"账号密码 + SSO
  授权"双因素自助**或 admin 解绑(走显式路径)。
- **不**做"admin 替 user 预绑定"路径(之前的 spec 是这条,本版砍掉)。防
  社工,且解决"admin 怎么拿到 union_id"的运营痛点。
- **不**做"批量预绑定"导入(CSV 等)。一期单条自助。
- **不**改 `email_domain_whitelist`、`user_idp_identities`、桌面 OAuth 流。
- **不**改 `users.extra_roles` 或角色解析路径。
- **不**做 Okta / 钉钉 / 企微 / Wecom 的 admin API 拉取(那 N 个 IdP 每个
  一套不同的 API 和 scope,跨 ticket);本版砍掉了"飞书 admin API 拉通
  讯录"功能(已不再需要,user 自助已经覆盖)。

---

## 3. 数据模型 (migration `043_sso_prebinding.sql`)

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
-- through the "prove with password" path — see §4.2).
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

### 3.1 字段语义

| 字段 | 含义 |
|---|---|
| `users.sso_connection_id` | 该 user 绑定的 SSO 连接 id;`NULL` = 未绑定 |
| `users.sso_external_id` | 该 user 在该 IdP 上的稳定 id(`union_id` / `sub` / `openid` / `user_id` 等,取决于 IdP 类型);`NULL` = 未绑定。两个字段必须同时为非空或同时为 NULL |
| `sso_connections.require_prebinding` | 该连接是否开启严格模式。`true` 时,未绑定的 IdP 身份必须走"先账号密码"的二段路径(§4.2);已绑定的直接放行 |
| `sso_login_states.phase` | `sso_completed` = IdP 回调已完成,可直接 finalize;`pending_bind` = IdP 回调已完成但身份未绑定,等待 user 走 `/bind-sso` 验证账号密码 |

### 3.2 与既有 `user_idp_identities` 表的关系

- `user_idp_identities` 是 **"已成功登录过"** 的运行时痕迹(每次成功登录 JIT
  或 dedup 或 二段 bind 时插入),生命周期 = 用户的 SSO 登录历史。
- `users.sso_connection_id` / `sso_external_id` 是 **"user 自助建立的身份挂钩"**
  的管理配置(由 user 在绑定流中建立),生命周期 = user 主动维护 / admin 解绑。
- 两者**不重复**:严格模式下,`users.sso_*` 是**前置门**;`user_idp_identities`
  在严格模式下仍然会被插入(因为绑定一旦命中,意味着"该 user 走 SSO 登录成功
  过",仍应留 audit 痕迹)。**不允许**用 `user_idp_identities` 反推
  `users.sso_*`(那是 user 决策,不是用户行为)。

---

## 4. SSO 登录流程改造 (`src/sso/finishCallback.ts` + 新增 `ssoLoginContext.ts`)

> 之前的 spec 改在 `resolveUser` 里加严格模式分支。本版**反过来** —— 把
> 严格模式门放在 `finishSsoCallback`(callback 拿到 identity 后),不进
> `resolveUser`;未绑定的 IdP 身份**不 reject**,而是进入 §4.2 二段路径。

### 4.0 严格模式门(在 `finishSsoCallback` 里,不在 `resolveUser`)

```ts
// src/sso/finishCallback.ts
export async function finishSsoCallback(args: FinishArgs): Promise<FinishResult> {
  // ... existing code exchange + fetchUserInfo + identity extraction ...

  const externalId = String(identity[conn.identity_id_field] ?? '');
  const email = conn.email_field && identity[conn.email_field]
    ? String(identity[conn.email_field]) : null;
  const loginName = conn.login_name_field && identity[conn.login_name_field]
    ? String(identity[conn.login_name_field]) : null;
  if (!externalId) {
    await auditStore.write({ orgId: state.orgId, action: 'sso_login_failed', payload: { ssoConnectionId: state.connectionId, reason: 'missing_external_id' } });
    await recordFailedLogin(state.orgId);
    return { error: 'missing_external_id' };
  }

  // 0. Strict-mode gate. (resolveUser is unchanged — v1 path runs only
  // when require_prebinding=false, so v1 callers see no behavior change.)
  if (conn.require_prebinding) {
    const bound = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users
        WHERE org_id = $1 AND sso_connection_id = $2 AND sso_external_id = $3`,
      [state.orgId, state.connectionId, externalId],
    );
    if (bound.rowCount) {
      if (bound.rows[0]!.status !== 'active') {
        await auditStore.write({ orgId: state.orgId, action: 'sso_login_failed', payload: { ssoConnectionId: state.connectionId, reason: 'user_disabled' } });
        await recordFailedLogin(state.orgId);
        return { error: 'user_disabled' };
      }
      // Bound → fast path. Audit + identity row + token.
      const uid = bound.rows[0]!.id;
      await pool.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), state.orgId, uid, state.connectionId, externalId],
      );
      return await issueSsoSuccessToken(uid, state.orgId, state.connectionId, externalId, false);
    }
    // Unbound + strict mode → two-stage path. Park the state and let the
    // route handler render /bind-sso. Resolve happens AFTER password verify.
    const ctx: SsoLoginContext = {
      kind: 'pending_bind',
      orgId: state.orgId, connectionId: state.connectionId,
      externalId, email, loginName,
      redirectUri: state.redirectUri, codeVerifier: state.codeVerifier,
    };
    ssoLoginContextStore.set(state.state, ctx);
    return { pendingBind: { connectionName: conn.name, providerType: conn.provider_type, externalId } };
  }

  // v1 (require_prebinding=false): unchanged.
  const resolved = await resolveUser({ orgId: state.orgId, connectionId: state.connectionId, externalId, email, loginName });
  // ... existing token issuance + audit ...
}
```

要点:
- **严格模式命中** = 走 `users.sso_*` 直查 + 插 `user_idp_identities`,
  **不**走 `resolveUser`(避免 email_domain_whitelist 等次要门)。
- **严格模式未命中** = 把状态**入内存 store**(`ssoLoginContextStore`),
  `sso_login_states.phase` 切到 `pending_bind`,返回 `pendingBind` 让路
  由层渲染 `/bind-sso`,**不** reject(`PrebindingRequiredError` 在本
  版废弃)。
- **v1 / 严格模式关闭** = `resolveUser` 流程完全不变(完全向后兼容)。
- `require_prebinding=false` 时,`users.sso_*` 字段**不会**被检查,只
  有 user 主动用"绑定 SSO 账号"功能时才会写。
- **不**在 SQL 表上加 `kind` 列(避免 schema 膨胀);用 Node 进程内
  `Map<state, SsoLoginContext>`,TTL 与 `sso_login_states.expires_at`
  一致,`consumeState` 时同步清。单实例部署够用(spec §12 评审可决;
  多实例需迁 DB 列 / Redis)。

### 4.1 严格模式下 `user_idp_identities` 的写入

为了保持"该 user 走过这条 SSO 连接登录"的 audit 痕迹,严格模式命中后
**仍然**插入一条 `user_idp_identities` 行(若已存在则 `ON CONFLICT DO NOTHING`)。
这与 v1 路径 2b 的插入逻辑一致。

### 4.2 二段路径(`pending_bind` → 账号密码 → 首次登录 + 绑定)

state 在 `ssoLoginContextStore[state].kind === 'pending_bind'` 时,user
必须**走 `/bind-sso` 页面**证明他是某个 GenWork 账号的主人。

流程:

1. **`/bind-sso` 页面**(GET `?state=xxx`):
   - 服务端读 `ssoLoginContextStore[state]`,若不在 `pending_bind` →
     显示 "会话已过期或无效,请重试"(同现有 sso_state_invalid 文案)。
   - 否则渲染提示: "你的 [feishu/okta] 账号尚未绑定 GenWork。请用你的
     GenWork 账号和密码登录,首次绑定后,该飞书账号会自动关联到你的
     GenWork 账号。"
   - 列出 SSO 连接名(`conn.name`)和 union_id 截断(让 user 知道是哪
     个具体账号)。
   - 表单: `username` + `password` + 隐藏 `state`。
2. **`POST /auth/sso/bind`** body `{ state, username, password }`:
   - 校验 `ssoLoginContextStore[state]` 存在且 `kind==='pending_bind'`,
     否则 `bind_state_invalid`。
   - 校验账号密码 → `verifyPassword(username, password)` 拿 `userId`。
     失败统一 `invalid_credentials`(不暴露"该用户不存在"信息,防枚
     举)。
   - 写 `users.sso_connection_id = ctx.connectionId`、
     `users.sso_external_id = ctx.externalId`(**UPSERT**,可能覆盖该
     user 上一次的绑定)。
   - 写 `user_idp_identities`(同 §4.1)。
   - 写 audit `'sso_user_self_bound'`, payload
     `{ userId, connectionId, externalId, source: 'pending_bind' }`。
   - **不**消费 `ssoLoginContextStore[state]`(还要回原 SSO 流程);
     但把 store 里的 entry 标记为 `kind: 'ready_to_finalize'` 并附带
     `boundUserId: userId`。
   - 响应 `{ ok: true, returnTo: <原 redirect_uri,console 模式 →
     /auth/sso/callback?code=&state=xxx;desktop 模式 →
     http://localhost:port/callback?…token=> }`。
3. **前端拿到 `ok: true` 后重定向到 `returnTo`**:
   - 浏览器(console 模式)再次 GET `/auth/sso/callback?code=&state=xxx`。
   - 路由 handler 走"再次 finalize"路径(见 §4.2.A):读
     `ssoLoginContextStore[state]`,若 `kind==='ready_to_finalize'` → 拿
     `boundUserId`,**不**再调 `resolveUser`,直接发 token,清 store entry。
   - desktop 模式: 浏览器命中 loopback URL 时
     `?token=<jwt>`,desktop 进程读 token 走既有路径(无需再次 finalize)。

#### §4.2.A 路由层 finalize

```ts
// src/routes/sso.ts
ssoRoutes.get('/auth/sso/callback', async (c) => {
  const state = c.req.query('state');
  const code  = c.req.query('code');
  // ... existing error / missing-state checks ...
  const consumed = await consumeState(state);
  if (!consumed) return c.html(renderConsoleCallbackHtml({ ..., errorMessage: 'session expired' }));

  // NEW: check if a /bind-sso already finalized this state.
  const ctx = ssoLoginContextStore.get(state);
  if (ctx?.kind === 'ready_to_finalize' && ctx.boundUserId) {
    ssoLoginContextStore.delete(state);
    const token = await signToken({ sub: ctx.boundUserId, orgId: ctx.orgId, roles: [Role.User] });
    return c.html(renderConsoleCallbackHtml({ token, redirectTo: '/' }));
  }

  // existing finalize path (un-binds set ctx.kind='pending_bind' themselves)
  const result = await finishSsoCallback({ code, state: consumed, redirectUri: consumed.redirectUri ?? '' });
  if ('error' in result) {
    if ('pendingBind' in result) {
      // 重定向到 /bind-sso?state=...
      return c.redirect(`/bind-sso?state=${state}`, 302);
    }
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=' + result.error }));
  }
  return c.html(renderConsoleCallbackHtml({ token: result.token, redirectTo: '/' }));
});
```

#### §4.2.B 错误码

| 错误 | HTTP | audit reason |
|---|---|---|
| 账号密码错 | 401 `invalid_credentials` | `bind_invalid_credentials` |
| `state` 不在 store / 已被消费 / 不在 `pending_bind` | 400 `bind_state_invalid` | `bind_state_invalid` |
| UPSERT 撞 unique 索引(双 race:同 `(connection, external_id)` 被另一 user 占) | 409 `sso_binding_duplicate` | `sso_binding_duplicate_race` |
| user 已被 disabled | 403 `user_disabled` | `bind_user_disabled` |
| user 跨 org(账号密码 user.orgId ≠ ctx.orgId) | 403 `bind_org_mismatch` | `bind_org_mismatch` |

### 4.3 用户主动绑定(已有账号密码 → 走 SSO → 自动绑定)

这是 §4.2 的"主动发起"版:user 用账号密码登录后,头像菜单点"绑定 SSO 账号"。

流程:

1. **前端发请求** `POST /me/sso-binding/start` body `{ connectionId }`:
   - 服务端**只**校验 caller 已登录(有 `claims.sub`),**不**校验是否
     已绑定(已绑也允许"再绑一次",等于覆盖)。
   - 复用现有 `state` 创建逻辑;在 `ssoLoginContextStore[state]` 存
     `{ kind: 'self_binding', userId: claims.sub, ... }`。
   - 调现有 `buildAuthorizeUrl(conn, state, ...)`。
   - 响应 `{ authorizeUrl }`。
2. **前端开 SSO 窗口**: user 完成 IdP 授权 → 回到 `redirect_uri`(console
   模式 → `/auth/sso/callback?code&state`;desktop 模式 → loopback URL)。
3. **`finishSsoCallback` 看到 `ctx.kind === 'self_binding'`**:
   - **跳过**严格模式门(此路径就是要绑)。
   - 拿到 `external_id` 后**直接**写
     `users.sso_connection_id = ctx.connectionId`、
     `users.sso_external_id = ctx.externalId` 到 `ctx.userId`。
   - 写 `user_idp_identities`。
   - 把 store entry 标记为 `kind: 'ready_to_finalize'`,带 `boundUserId`。
   - 路由 finalize 看到 `ready_to_finalize` 出 token(同 §4.2.A)。

错误码: 同 §4.2.B(但 `invalid_credentials` 不适用,user 已登录)。

---

---

## 5. 错误类与映射

### 5.1 本版不新增 `PrebindingRequiredError`

之前 spec 在 `jit.ts` 加 `PrebindingRequiredError`(严格模式未命中 = 拒
绝)。本版**砍掉**该类 —— 严格模式未命中不再 reject,转 §4.2 二段路
径。`jit.ts` 自身**完全不变**,`resolveUser` 仍只抛既有的
`DomainNotAllowedError` / `EmailRequiredError` / `UsernameConflictError` /
`UserDisabledError`。

### 5.2 二段路径错误字符串(spec §4.2.B)

这些是**返回字符串**,不是 thrown error。`finishSsoCallback` / `/auth/sso/bind`
路由直接返回 `{ error: '<code>' }`,前端用 `?error=<code>` 查文案。

| 错误码 | 触发 |
|---|---|
| `bind_state_invalid` | `/bind-sso` 或 `/auth/sso/bind` 的 `state` 不在 `ssoLoginContextStore` / 不在 `pending_bind` phase / 已 finalize |
| `bind_invalid_credentials` | `/auth/sso/bind` 账号密码错(同既有密码登录,统一文案防枚举) |
| `sso_binding_duplicate` | UPSERT 撞 unique 索引(双 race) |
| `bind_user_disabled` | user 被 disabled |
| `bind_org_mismatch` | 账号密码 user.orgId ≠ ctx.orgId(防跨 org 误绑) |

`jit.ts` 既有 catch 链**完全不动**(不再加 `PrebindingRequiredError` 一
行)。`finishCallback.ts` 的 `sso_login_failed` audit `reason` 仍然
是 `domain_not_allowed` / `email_required` / `username_conflict` /
`user_disabled` / `jit_failed` / `missing_external_id` —— 这些是
`resolveUser` 抛出的语义,跟 §4.2 二段路径**完全无关**(二段路径不
进 `resolveUser`)。

---

## 6. 管理端 + user-self API

> **重要变化:** 之前的 spec 把"写绑定"放在 admin 端(`PUT .../sso-binding`),
> 本版**砍掉**。admin 只能**看** + **解绑**;**写**全部走 user 自助
> (§6.2 `/me/sso-binding/*`)。

### 6.1 admin 端(只读 + 解绑)

新文件 `src/routes/admin/ssoBindings.ts`(挂到 `server.ts`,
**权限点**沿用 `PP.SsoView` / `PP.SsoEdit`,**不新增**)。

#### 6.1.1 `GET /admin/users/:id/sso-binding`(只读)

查看某 user 的当前绑定(如有)。

- 鉴权: `requirePermission(PP.SsoView)`。
- Org 隔离: `users.org_id` 必须等于 `claims.orgId`,否则 404。
- 响应: `null`(未绑定) 或 `{ connectionId, connectionName, providerType, externalId, boundAt? }`。
- **不**暴露 `users.password_hash` / `users.email`(已有隐私规则)。
- 用途: 用户管理页"SSO 绑定"列的内容;admin 详情页可点开看。
- **不**允许 admin 在此端点 PUT/POST/PATCH(防社工)。

#### 6.1.2 `GET /admin/sso-connections/:id/bindings`(只读列表)

- 鉴权: `requirePermission(PP.SsoView)`。
- 响应: `[{ userId, username, displayName, externalId, boundAt? }]`。
- 用例: admin 盘点"哪些 user 已自助绑到这条 SSO 连接"。
- 走 LEFT JOIN `users`:`sso_connection_id = :id AND sso_external_id IS NOT NULL`
  过滤本 org + 本连接。

#### 6.1.3 `DELETE /admin/users/:id/sso-binding`(解绑)

- 鉴权: `requirePermission(PP.SsoEdit)`。
- Org 隔离: 同 6.1.1。
- 行为: `UPDATE users SET sso_connection_id = NULL, sso_external_id = NULL WHERE id = :id AND org_id = :orgId`。
- **不**删 `user_idp_identities` 历史痕迹(那行 audit 用)。
- 写 audit: `action='sso_user_admin_unbound'`, payload `{ userId, connectionId, externalId }`。
- 响应: `200 { ok: true }`。
- 幂等: 不存在也返回 200(无副作用)。

### 6.2 user-self 端(写绑定 + 解绑)

新文件 `src/routes/me/ssoBinding.ts`(挂到 `/me/*`,**走**现有
`requireAuth`,**不**走 `requirePermission` — 普通 user 都能调)。

#### 6.2.1 `POST /me/sso-binding/start` body `{ connectionId }`

启动"用户主动绑定"流程(§4.3)。

- 鉴权: `requireAuth` (任意已登录 user)。
- 行为:
  - 校验 `connectionId` 是本 org 的 enabled `sso_connection`,否则 404。
  - **不**校验 user 是否已绑定(已绑也允许"再绑一次",等于覆盖)。
  - 创建 `sso_login_states` 行(走既有 `createState` 逻辑,带
    `code_verifier`)。
  - 在 `ssoLoginContextStore[state]` 存
    `{ kind: 'self_binding', userId: claims.sub, orgId: claims.orgId, connectionId, redirectUri }`。
  - 响应 `{ authorizeUrl }`(同 `buildAuthorizeUrl` 输出)。
- 写 audit: `action='sso_user_binding_start'`, payload
  `{ userId, connectionId }`。
- 错误: `connection_not_found` / `connection_disabled` / `org_mismatch`。

#### 6.2.2 `DELETE /me/sso-binding` (user 自己解绑)

- 鉴权: `requireAuth`。
- 行为: 把 `claims.sub` 自己的 `sso_connection_id` / `sso_external_id` 置 NULL。
- **不**校验 user 当前是否真的有绑定(无绑定也 200,幂等)。
- **不**删 `user_idp_identities` 历史痕迹。
- 写 audit: `action='sso_user_self_unbound'`, payload
  `{ userId, connectionId, externalId }`。
- 响应: `200 { ok: true }`。
- 同 /admin 端 DELETE 行为对称,但 audit action 名不同(分清 admin 主动
  vs user 主动)。

### 6.3 `/auth/sso/bind` 公共端(账号密码 + SSO 状态)

新文件 `src/routes/auth/ssoBind.ts` 或加进 `src/routes/sso.ts`。

#### 6.3.1 `GET /bind-sso?state=xxx`(渲染页面)

- 鉴权: 无(公开路由,user 还没登录)。
- 行为:
  - 读 `ssoLoginContextStore[state]`,若不在 / 不在 `pending_bind` /
    已 finalize → 渲染"会话已过期或无效"占位页(同现有 sso_state_invalid
    文案)。
  - 否则渲染 `/bind-sso` 页(HTML,带表单)。
- 响应: `text/html`(由 `consoleCallback.ts` 同款风格渲染器输出)。

#### 6.3.2 `POST /auth/sso/bind` body `{ state, username, password }`

完成 §4.2 步骤 2。

- 鉴权: 无(账号密码登录本身就是鉴权)。
- 行为(spec §4.2 步骤 2):
  1. 校验 `ssoLoginContextStore[state]?.kind === 'pending_bind'`,
     否则 400 `bind_state_invalid`。
  2. 校验账号密码 → `verifyPassword(username, password)`(沿用既有密码
     登录服务)。失败统一 401 `invalid_credentials`(防枚举)。
  3. 校验 `passwordUser.orgId === ctx.orgId`,否则 403 `bind_org_mismatch`。
  4. 校验 `passwordUser.status === 'active'`,否则 403 `bind_user_disabled`。
  5. **UPSERT** `users`:
     ```sql
     UPDATE users
        SET sso_connection_id = $1, sso_external_id = $2
      WHERE id = $3 AND org_id = $4
     ```
     唯一索引撞 → 409 `sso_binding_duplicate`(理论上不应发生)。
  6. 插 `user_idp_identities`(同 §4.1,`ON CONFLICT DO NOTHING`)。
  7. 写 audit `action='sso_user_self_bound'`, payload
     `{ userId, connectionId, externalId, source: 'pending_bind' }`。
  8. **不**清 `ssoLoginContextStore[state]`,但把 entry 改为
     `{ kind: 'ready_to_finalize', boundUserId: userId, ... }`。
  9. 响应 `{ ok: true, returnTo: ctx.redirectUri }`(console 模式 →
     `${origin}/auth/sso/callback?code=&state=`;desktop 模式 →
     `http://localhost:port/callback?...token=` 客户端拼好,这里只返
     `state`,前端再走一遍流程)。

注 9: 实际上,console 模式的 returnTo 是 server 自己渲染回调页
面,desktop 模式是 desktop 进程消费 `state`。**简化**: `returnTo`
统一返 `${origin}/auth/sso/callback?state=${state}`(由 server
`/auth/sso/callback` 路由层处理 `ready_to_finalize`,见 §4.2.A);desktop
模式: state 在浏览器侧不再走 loopback,而是浏览器把 token
写在 `localStorage` + 跳 loopback URL,desktop 进程从 localStorage 读
—— **不,这个不行**。Desktop 模式的 SSO finalize 在 desktop 进程内
完成(token 由 desktop 进程从 IdP 拿到,不是浏览器 cookie)。

**Desktop 模式的 §4.2 特殊处理**:
- console 模式: §4.2.A 描述的"再次 finalize" 路径成立。
- desktop 模式: IdP 完成后 desktop 进程直接走 `openOauthFlow` 的 probe
  拿 token,`finishSsoCallback` 在 server 端跑,**但**不通过浏览器重
  定向到 `/auth-sso` —— 它通过 `state` 在 `ssoLoginContextStore`
  里挂"等待账号密码"。
- 桌面 UI 弹一个**模态**("你的飞书账号未绑定,请输入 GenWork 账号
  密码"),user 在桌面里输,桌面 POST `/auth/sso/bind`,server 写绑
  定 + 设 `ready_to_finalize`,**然后** desktop 进程继续 probe,
  探测到 `ready_to_finalize` → 服务端 finalize → 出 token。
- 这是桌面端 OAuth flow 的扩展点;`openOauthFlow` probe 已经是轮询
  `cb.waitForArrival`,只需要让 probe 在轮询中也 POST server
  `/auth/sso/bind-status?state=xxx` 拿"ready/finalize"信号。

> spec §12 评审可决: desktop 模式可以先**只实现 console 模式**,desktop
> 二段路径走 "在桌面内显示 web `/bind-sso?state=` 的二维码" ——
> user 用手机扫,在手机或电脑浏览器输密码,完成后再回桌面登录。**简
> 化默认**: 本 spec 重点实现 console 模式,desktop 模式显示"请到
> 企业 web 完成首次绑定"提示并 P2 加桌面模态。

---

## 7. 前端

### 7.1 登录失败提示(已废弃)

之前的 `?error=prebinding_required` 文案**不再使用** —— 严格模式未命中
不再 reject,转 §4.2 二段路径,user 不会看到这个文案。`LoginPage.tsx`
**不需要**任何改动。

### 7.2 `/bind-sso` 页面(新)

新页面 `pages/auth/BindSsoPage.tsx`(`/bind-sso?state=xxx`):

- 顶部 banner: "你的 [feishu/okta/dingtalk] 账号尚未绑定 GenWork。"
- 中段: "请用你的 GenWork 账号和密码登录,首次绑定后,该飞书账号会自
  动关联到你的 GenWork 账号。" + 显示 `connectionName` + `externalId`
  截断(让 user 确认"我要绑的是这个飞书账号")。
- 表单: `username` + `password` + 隐藏 `state`。
- 提交 → 调 `POST /auth/sso/bind`。
- 错误码处理:
  - `invalid_credentials` → 红色 inline 提示 "账号或密码错误"(同既有
    密码登录)。
  - `bind_state_invalid` → 整页替换为 "会话已过期或无效,请重新发起
    SSO 登录" + "返回登录" 链接。
  - `bind_user_disabled` / `bind_org_mismatch` → 红色提示。
  - 200 ok → 拿到 `returnTo` 拼 `code` 后 `window.location.href =
    returnTo`(console 模式 → `/auth/sso/callback?code=&state=`,server
    看到 `ready_to_finalize` 直接出 token,见 §4.2.A)。

i18n 新增 5 键:
- `sso.bind.title` "绑定 SSO 账号" / "Bind SSO account"
- `sso.bind.subtitle` "你的 {provider} 账号尚未绑定 GenWork。请用账号密码登录以完成绑定。" / "Your {provider} account is not bound to GenWork yet. Sign in with your account password to bind."
- `sso.bind.username.label` "GenWork 账号" / "GenWork account"
- `sso.bind.password.label` "密码" / "Password"
- `sso.bind.submit` "绑定并登录" / "Bind and sign in"

### 7.3 用户头像菜单"绑定 SSO 账号"(新)

`enterprise_server/web` 现有"个人头像"菜单(假设在 `pages/me/` 或
`components/ProfileMenu.tsx` 等位置)加一个**条件渲染**项:

- 文案: `i18n.sso.profile.bindMenuItem` = "绑定 SSO 账号" / "Bind SSO account"
- 位置: 在"修改密码"和"退出登录"之间。
- 点击 → 弹 modal:
  - 显示本 org 的 enabled `sso_connections` 列表(从
    `GET /auth/sso/providers?orgName=` 既有端点拿)。
  - 每行一个 "用 [connection.name] 绑定" 按钮。
  - 点击按钮 → 调 `POST /me/sso-binding/start` body
    `{ connectionId }` → 拿 `authorizeUrl` → 调既有
    `openOauthFlow`(web 模式用 `window.location.href = authorizeUrl`)。
  - 用户在 IdP 完成授权 → 回到 `/auth/sso/callback?code=&state=` → server
    走 `ready_to_finalize` finalize → 渲染 console 回调页(带 token)
    → 重定向到 `/me?bound=true`。
- **状态**:
  - user 已有绑定 → 文案 "重新绑定 SSO 账号"(点击后同样流程,会覆盖
    旧绑定,弹 confirm "将覆盖你当前的 SSO 绑定,继续吗?")。
  - `me/sso-binding` GET(查自己绑定状态)显示在头像菜单里: "已绑
    定: <connection.name> · 解绑"。

### 7.4 用户管理:SSO 绑定列(只读 + 解绑)

`enterprise_server/web` 用户列表 / 详情页:

- 列表页每行多一列 "SSO 绑定" / "SSO Binding":
  - 调 `GET /admin/users/:id/sso-binding`(spec §6.1.1)。
  - 空: 显示 "未绑定"(`i18n.sso.binding.unbound`),**无操作按钮**(admin
    不能绑,只能看)。
  - 非空: 显示 `<connection.name> · <externalId 截断 16 字 + ...>`。
- 详情页:
  - 同样的展示;**额外**一个"解绑"按钮(只有 `PP.SsoEdit` 权限才显
    示)。
  - 点击 → 调 `DELETE /admin/users/:id/sso-binding` → confirm
    "解绑后,该 user 用此 SSO 连接登录时会要求重新账号密码认证。继续
    吗?"。
- **不**动现有 `extra_roles` / `username` / `email` 字段 UI。

### 7.5 SSO 连接详情:严格模式开关

`/admin/sso-connections/:id` 编辑表单多一个 checkbox "仅允许预绑定用
户登录" / "Only allow prebound users"。

- 提示文字: "开启后,未自助绑定 SSO 身份的飞书/Okta/钉钉账号将无法登
  录(会被引导到账号密码认证页)。已绑定的 user 不受影响。"
- 切换时弹 confirm: "开启后,未自助绑定的飞书账号将被引导到账号密码
  认证页(首次登录)。继续吗?"

---

## 8. 分期

### P1 (本 spec 必须交付)
- §3 migration `043_sso_prebinding.sql`(`users.sso_*` + 唯一索引 +
  `sso_connections.require_prebinding` + `sso_login_states.phase`)
- §4.0 `finishSsoCallback` 严格模式门(在 `finishCallback.ts` 加分支,
  **不改** `resolveUser`)
- §4.2 二段路径:`/auth/sso/bind` + `ssoLoginContextStore` + 路由
  finalize `ready_to_finalize` 分支
- §4.3 用户主动绑定:`POST /me/sso-binding/start` + `DELETE /me/sso-binding`
- §6.1 admin `GET` + `DELETE` only:`GET /admin/users/:id/sso-binding`
  (只读) + `GET /admin/sso-connections/:id/bindings` (只读列表) +
  `DELETE /admin/users/:id/sso-binding` (解绑)
- §7.2 `/bind-sso` 页面
- §7.3 头像菜单"绑定 SSO 账号"
- §7.4 用户管理 SSO 绑定列(只读 + 解绑按钮)
- §7.5 SSO 连接详情严格模式 checkbox
- i18n zh+en 全部新键
- 测试 (见 §9)

### P2 (后续 ticket)
- Desktop 二段路径模态(本版 P1 只实现 console 模式 + "请去 web 绑定"
  提示;desktop 流程二次进 web 绑)
- `GET /admin/sso-connections/:id/unbound-users`(admin 找"谁还没绑")
- 飞书 admin API 拉取 union_id 工具(本版用户自助后已不再 P1)
- 批量预绑定 CSV 导入
- 跨实例 `ssoLoginContextStore` 共享(目前 in-memory map,单实例够)

---

## 9. 测试策略 (逐文件,见全局约束)

### 9.1 `tests/sso/jit.test.ts` (既有 11 用例**完全不动**)

之前的 spec 加 4 个 strict-mode 用例(`require_prebinding=true` 抛
`PrebindingRequiredError`)。本版**砍掉**: `resolveUser` 不再
有 strict-mode 分支,`PrebindingRequiredError` 类不再导出,既有
strict-mode 行为移到 `finishSsoCallback`。`jit.test.ts` 11 个既有用
例全部不动(它们测的是 `resolveUser` 的 `email_domain_whitelist` /
跨 IdP dedup / JIT create,与 strict-mode 无关)。

### 9.2 `tests/sso/finishCallback.test.ts` (新用例)

mock `exchangeCode` / `fetchUserInfo` / `users` 表,验:

1. `require_prebinding=false,identity 在 users.sso_* 没匹配 → v1
   resolveUser 路径(走 JIT 或 dedup)`,与现状一致(回归)。
2. `require_prebinding=true,identity 在 users.sso_* 命中 active user
   → 直接出 token,createdJit=false, user_idp_identities 被插入`。
3. `require_prebinding=true,identity 在 users.sso_* 命中 disabled user
   → return { error: 'user_disabled' }`。
4. `require_prebinding=true,identity 在 users.sso_* **无**匹配 →
   sso_login_states.phase 被切到 pending_bind,return
   { pendingBind: { connectionName, providerType, externalId } }`,
   **不**调 `resolveUser`,**不**出 token。
5. `pending_bind 状态时 audit reason='sso_login_pending_bind'`(新 audit
   action,见 §9.7)。

### 9.3 `tests/auth/ssoBind.test.ts` (新文件)

mock `ssoLoginContextStore`(内存 map),验 §4.2 + §6.3.2:

1. `POST /auth/sso/bind, state 不在 store → 400 bind_state_invalid`。
2. `POST, state.kind !== 'pending_bind' → 400 bind_state_invalid`。
3. `POST, 账号密码错 → 401 invalid_credentials`(不区分"user 不存在"
   和"密码错",防枚举)。
4. `POST, 账号密码对,但 user.status='disabled' → 403 bind_user_disabled`。
5. `POST, 账号密码对,但 user.orgId !== ctx.orgId → 403 bind_org_mismatch`。
6. `POST, 成功 → users.sso_connection_id/sso_external_id 写入,
   user_idp_identities 插入, store entry 改为
   { kind: 'ready_to_finalize', boundUserId }, audit
   'sso_user_self_bound' 写入`。
7. `POST, 撞 unique 索引(双 race) → 409 sso_binding_duplicate`。
8. `POST, 成功 → response.body.returnTo 等于 ctx.redirectUri(带
   state=...&code=... 拼好)`。

### 9.4 `tests/me/ssoBinding.test.ts` (新文件)

`POST /me/sso-binding/start` + `DELETE /me/sso-binding`,验 §4.3 + §6.2:

1. `start, 已登录, connectionId 是本 org enabled → 200 { authorizeUrl },
   sso_login_states 插入, store entry kind='self_binding' 带 userId`。
2. `start, 已登录, connectionId 跨 org → 404 connection_not_found`。
3. `start, 已登录, connectionId 已被 disabled → 409 connection_disabled`。
4. `start, 未登录 → 401`。
5. `start, 已绑过, 仍允许(走"覆盖绑定"路径),authorizeUrl 仍返回`。
6. `DELETE /me/sso-binding, 已登录且有绑定 → 200, users.sso_* 清空,
   audit 'sso_user_self_unbound' 写入, user_idp_identities **不**动`。
7. `DELETE, 已登录但无绑定 → 200(幂等)`。
8. `DELETE, 未登录 → 401`。

### 9.5 `tests/admin/ssoBindings.test.ts` (新文件)

1. `GET /admin/users/:id/sso-binding, 未绑 → 200 null`。
2. `GET, 已绑 → 200 { connectionId, connectionName, providerType, externalId }`。
3. `GET, 跨 org user → 404`。
4. `GET, 无 SsoView → 403`。
5. `GET /admin/sso-connections/:id/bindings, 列出本 org 预绑定 user
   列表,按 username 升序`。
6. `DELETE /admin/users/:id/sso-binding, 已绑 → 200, users.sso_* 清
   空, audit 'sso_user_admin_unbound' 写入, user_idp_identities 不动`。
7. `DELETE, 跨 org → 404`。
8. `DELETE, 无 SsoEdit → 403`。
9. **不**测 `PUT` / `POST`(本版砍掉,测了反而错)。

### 9.6 `tests/sso/ssoLoginContext.test.ts` (新文件)

`Map<state, SsoLoginContext>` 内存 store 的单测:

1. `set / get / delete` 基本 CRUD。
2. **TTL** 行为: store entry 必须在 `sso_login_states.expires_at` 之
   后被自动清理(可注入 fake clock)。
3. **kind 状态转换**: `pending_bind` → `ready_to_finalize`(由
   `/auth/sso/bind` 触发)→ 删除(由路由 finalize 触发)。

### 9.7 新 audit action 名字(字面 string,不入 `AuditAction` 枚举)

| 触发 | action |
|---|---|
| `finishSsoCallback` 走 strict-mode pending_bind | `sso_login_pending_bind` |
| `/auth/sso/bind` 成功 | `sso_user_self_bound` |
| `POST /me/sso-binding/start` | `sso_user_binding_start` |
| `DELETE /me/sso-binding` | `sso_user_self_unbound` |
| `DELETE /admin/users/:id/sso-binding` | `sso_user_admin_unbound` |

### 9.8 既有用例不变

09-27 spec §11 列出的 `tests/sso/*` 既有文件(`oauth.test.ts` /
`state.test.ts` / `logos.test.ts` / `finishCallback.test.ts` 中
strict-mode 无关的部分 / `consoleCallback.test.ts` /
`desktopRedirectPort.test.ts` / `providerPresets.test.ts`)都不动。
`finishCallback.test.ts` 既有 strict-mode **不相关**的用例也不动
(本版只在该文件加 §9.2 的 5 个新用例)。

### 9.9 运行约定

沿用全局约束(09-27 spec §10):`npx vitest run <file>` 逐文件跑,避免沙箱
fd 耗尽。Lint:`npx eslint --ext ts,tsx --report-unused-disable-directives
--max-warnings 0 <files>` 走变更文件集。

---

## 10. 关键约束 (沿用全局约束 + 本 spec 新增)

### 10.1 沿用 (09-27 §10)
- 测试代码权威;Lint 0 error;`tsc --noEmit` 0 error;i18n 中英成对;secret
  不出 wire;跨 org 隔离;自动提交仅本地;不新增 `PermissionPoint`;audit
  走 `auditStore`。
- 逐文件跑测试。

### 10.2 本 spec 新增
- **不**做自动匹配:任何"通过邮箱/手机号/姓名自动 dedup 到绑定"的方案
  都不在范围(必然错配)。**只接受 user 走"账号密码 + SSO"双因素自助**。
- **不**让 admin 替 user 写绑定(防社工)。admin 只能看 + 解绑。
- **不**改 `email_domain_whitelist` 语义:它仍只管"邮箱后缀"那一层;严格
  模式跳过它(预绑定比白名单更严,语义重叠)。
- **不**改 `user_idp_identities` 的语义:它仍是"该 user 走这条 SSO
  连接登录成功过"的历史痕迹,与"user 自助绑定"是两件事。
- `ssoLoginContextStore` 是**单实例内存 map**,TTL 与
  `sso_login_states.expires_at` 一致;多实例部署需迁 DB / Redis(P2)。
- 解绑(无论 admin / user 触发)→ **不**自动清 `user_idp_identities`:
  历史登录痕迹保留(否则审计会丢)。
- `PrebindingRequiredError` **本版不再使用**;`jit.ts` 的 catch 链也
  不加这一行。如果以后有需要再恢复。
- `sso_login_states.phase` 默认 `'sso_completed'`(兼容既有数据)。
  v1 路径走完全不变,新列对老逻辑无感。

---

## 11. 风险与回退

| 风险 | 缓解 |
|---|---|
| 同一 `(sso_connection_id, sso_external_id)` 跨 org 冲突 | spec §3 的唯一索引是 per `(connection, external_id)`,跨 org 同 union_id 不撞(两个 org 可以各自绑定同一个飞书 user)。PUT/DELETE 严格按 `claims.orgId` 过滤 user(Task 测试覆盖) |
| `require_prebinding=true` 开启后,unbound IdP 身份走二段路径 → 多次输入账号密码 | UX 层面:首次完成后该 `(connection, external_id)` 自动绑定,后续同 IdP 身份登录直接放行 |
| `ssoLoginContextStore` 重启后丢失(单实例 in-memory) | `sso_login_states` 表里仍存原始 `state` 凭证,新 store 可从 DB 重建(只缓存 `kind` 元信息,丢了走 fallback "重新 SSO 登录");**不**强一致,降级到"再次 SSO 登录"即可 |
| `require_prebinding=true` 开启时 admin 本人未绑 | admin 自己用账号密码登录后,头像菜单走"绑定 SSO 账号"自助绑一次;UI 在切换开关时不锁 admin(不像 v1 spec) |
| `sso_external_id` 为空字符串 vs null(API 边界) | UPSERT 路径只接受 `externalId` 非空;zod 校验 `nullable()` 不接 `''`,Task 测试覆盖 |
| 桌面端二段路径 UX 不完整(P1 只实现 console) | 桌面 P1 显示"请到企业 web 完成首次绑定"提示;P2 加桌面模态 |
| 已 bind user 重新 SSO 登录(同 IdP 身份) | strict-mode fast path:`finishSsoCallback` 看到 `users.sso_*` 命中 → 直接出 token,不走二段 |
| 已 bind user 改绑另一 IdP 身份 | §4.3 主动绑定路径,`POST /me/sso-binding/start` 不校验"已绑" → 走完整 SSO 后覆盖 `users.sso_*` 字段;前端弹 confirm "将覆盖你当前的 SSO 绑定" |
| admin 解绑(无 user 同意) | 写 audit `sso_user_admin_unbound` 明确区分于 user 自助解绑;`user_idp_identities` 保留 → user 下次 SSO 登录仍走 v1(若 require_prebinding=false)或二段(若 true) |

回退方案: 把 `require_prebinding` 改回 `false` 立即回到 v1 行为(无
破坏性)。不需要回滚 migration(`sso_connection_id` /
`sso_external_id` 字段留着也无害,索引很轻)。`ssoLoginContextStore`
重启后从空开始,完全可降级。

---

## 12. 待确认 / 开放问题 (评审可决)

1. **`sso_external_id` 字段长度**: Feishu union_id 通常 20+ 字符,
   Okta sub 可达 100+, 暂定 `TEXT`(无长度限制)。
2. **预绑定的 IdP 类型锁定**: 一个 user 只能绑一个 `(connection,
   external_id)`,**不**支持"绑多个 IdP 都能登"。P2 再说。
3. **审计 retention**: 现有 `audit_events` retention 沿用,本 spec
   新增的 5 个 action 不需要特殊保留。
4. **`ssoLoginContextStore` 单实例 vs 跨实例**: 当前 GenWork SSO 是
   单实例部署,内存 map 够用;多实例需迁 DB / Redis。迁移成本低
   (只是把 map 改成 `pool.query`)。
5. **Desktop 二段路径**: P1 只实现 console 模式;desktop 模式显示
   "请到企业 web 完成首次绑定"。P2 加桌面模态(走 web 的
   `/bind-sso`)。
6. **首次自助绑定时 user 已 disabled**: 当前 §4.2 步骤 4
   (spec line 484) 走 `bind_user_disabled` 拒绝。**是否**也允许
   admin 重新 enable 后再绑?当前不在范围(用户可以自己联系 admin
   enable,或换账号注册新 user)。
