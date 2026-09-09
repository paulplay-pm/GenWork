# 企业 SSO 成员登录联邦 — 设计（GenWork 工作台）

**Date:** 2026-09-27
**Owner:** paul
**Status:** Draft (待评审 → 转 writing-plans)
**原型:** 用户提供「创建 SSO 连接」7 张图（提供商类型 / 协议 / 身份凭据 / 身份字段映射 / 邮箱域名白名单）
**关系:** 本方案是**独立子系统**，**不在** MCP 连接器原型/PRD 范围内。与 MCP 连接器消费方案的边界见 §9。

---

## 0. 一句话

让企业成员通过公司身份提供商（IdP：通用 OAuth2/OIDC、Azure AD、钉钉、飞书、SAML2、企业微信）**登录 GenWork**（企业控制台 + 桌面端），服务端做身份验证（凭据服务端持有、**绝不展示给成员**），首次登录按「身份字段映射 + 邮箱域名白名单」**JIT 开号 / 匹配**，签发与密码登录**同构**的 JWT。

---

## 1. 目标与范围

### 1.1 目标（已与用户确认）

- **成员登录联邦 + JIT 开号**：成员用公司 IdP 登录取代/并行于现有 `username + password`。
- **登录入口**：企业控制台 + **桌面端** 都支持。
- **协议（一期）**：**OIDC + 纯 OAuth2**（6 种提供商类型中的前 5 种走 authorization-code；**SAML2 后置**）。
- **每 org 多条 SSO 连接**（集合）：登录页显示多条「用 X 登录」；JIT 需**跨连接去重**（同一人从两个 IdP 登录 → 同一内部用户）。
- **凭据服务端持有**：`client_secret` 仅服务端身份验证用，**绝不**下发给成员 / 桌面 / 任何客户端。

### 1.2 非目标（一期不做）

- **SAML2**（SP 端断言解析 / 元数据 / 签名验证）——后置。
- IdP 组 / 属性 → GenWork 角色的映射（JIT 一律默认 `Role.User`，后续人工调整角色）。
- SCIM / 目录同步（增量更新、离职禁用）。
- 账号合并（仅按 `email` 去重）。
- SSO 连接启停的灰度 / 按成员灰度（一期按 org 全量）。

---

## 2. 与现有登录 / JWT 的关系（已核对源码）

- 现有登录：`POST /auth/login { orgName, username, password }`（`routes/auth.ts:59`）→ `authService.login` → JWT claims `{ sub: userId, orgId, roles }`（`auth/jwt.ts:3` `Claims`）。
- `users` 表：`username`（`UNIQUE(org_id, username)`）、`email`（`UNIQUE(org_id, email)`，migration 028）、`password_hash`、`extra_roles`。
- **本方案不改动**现有密码登录与 JWT 结构 —— SSO 登录**复用同一 `signToken(claims)`**（claims 形状不变），只新增「如何拿到一个已验证的成员身份」这一环。
- 复用：`loginRecord.recordLogin`（审计）、`vault/crypto` `encrypt/decrypt`（`vault/crypto.ts:15/23`）+ `providerKeyVault` 的 `encrypt`+`mask`+`decrypt` 模式（`vault/providerKeyVault.ts`）作为 secret 存储范式。

---

## 3. 数据模型（migration `036_sso_connections.sql`）

### 3.1 `sso_connections`（每 org 多条）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `org_id` | TEXT NOT NULL | FK orgs |
| `name` | TEXT NOT NULL | 连接名称（登录页展示）；`UNIQUE(org_id, name)` |
| `provider_type` | TEXT NOT NULL | `generic-oidc`\|`generic-oauth2`\|`azure-ad`\|`feishu`\|`dingtalk`\|`wecom`\|`saml2`（SAML2 仅可存、不可启用至后置） |
| `protocol` | TEXT NOT NULL | `oidc`\|`oauth2`\|`saml2` |
| `authorize_url` | TEXT | 非机密；具名提供商有预设 |
| `token_url` | TEXT | 非机密 |
| `userinfo_url` | TEXT \| null | OAuth2 需要（OIDC 可从 ID token 取则留空） |
| `client_id` | TEXT | **非机密** |
| `client_secret_encrypted` | TEXT \| null | **机密**；`encrypt(plaintext)`（`vault/crypto`）；服务端解密用 |
| `client_secret_masked` | TEXT \| null | 展示用 mask（首 3 尾 4），仿 `providerKeyVault.maskKey` |
| `scopes` | TEXT | 如 `openid profile email` |
| `identity_id_field` | TEXT | 唯一 ID 字段，默认 `sub` |
| `login_name_field` | TEXT \| null | 登录名字段，默认 `account`（可选） |
| `email_field` | TEXT | 邮箱字段，默认 `email` |
| `email_domain_whitelist` | JSONB | `string[]`（逗号分隔存）；JIT 邮箱域名必须命中 |
| `enabled` | BOOLEAN | 登录页仅展示 enabled |
| `sort_order` | INT | 登录页排序 |
| `created_by` / `created_at` / `updated_at` | — | 审计 |

### 3.2 `user_idp_identities`（成员 ↔ IdP 身份绑定）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `org_id` | TEXT NOT NULL | 冗余（跨 org 隔离 + 查询） |
| `user_id` | TEXT NOT NULL | FK users.id |
| `sso_connection_id` | TEXT NOT NULL | FK sso_connections.id |
| `external_id` | TEXT NOT NULL | IdP 返回的 `identity_id_field` 值（该 IdP 内唯一） |
| `first_seen_at` | TIMESTAMPTZ | JIT 时戳 |

`UNIQUE(sso_connection_id, external_id)`；另建 `UNIQUE(org_id, email)`（已存在于 `users`）作为**跨连接去重**的键。

---

## 4. 服务端登录流程（新路由，注册进 `server.ts`）

> 全部新路由收进 `routes/sso.ts`（`ssoRoutes`），`server.ts` `app.route('/', ssoRoutes)`。登录三端点**公网可达但 state 门控**；管理 CRUD 走 `requireAuth` + org-admin（见 §7）。

### 4.1 登录端点（面向成员，公网可达）

| 方法 / 路径 | 说明 |
|---|---|
| `GET /auth/sso/providers?orgName=` | 公开（pre-login，仿 `/auth/orgs`）。返回该 org **enabled** 的 SSO 连接：`{ id, name, provider_type }`。**不含** client_id/secret/url/scopes（成员不需要）。 |
| `GET /auth/sso/:id/authorize?orgName=` | 服务端校验连接 enabled；生成短 TTL 随机 `state`（存内存/`state` 表，绑定 `orgId` + `connectionId` + `return_target`(控制台/桌面)）；按 `protocol` 构造 IdP authorize URL（**公开客户端 → PKCE**；机密客户端附 `client_secret`）；302 → IdP。 |
| `GET /auth/sso/callback?code&state`（控制台） | 校验 `state`（过期/不符 → 拒绝）；`code` 换 token（`token_url`）；取身份（OIDC 解析 ID token；纯 OAuth2 调 `userinfo_url`）；按字段映射取 `external_id`/`login_name`/`email` → §5 JIT → `signToken(claims)` → 种 session/返回 token；`loginRecord.recordLogin`。 |
| `GET /auth/sso/desktop/callback?code&state`（桌面，见 §6） | 同上，但回跳目标是桌面（localhost callback / 深链），返回 token 给桌面。 |

> `state` 存内存（进程内 map + TTL，重启丢失可接受 —— 登录态本就短命）或轻量 `sso_login_states` 表（`state` PK, `org_id`, `connection_id`, `return_target`, `code_verifier`(PKCE), `expires_at`）。**推荐表**（跨重启 + 多实例安全）。

### 4.2 身份提取（按 provider/protocol）

- **OIDC**：token 响应含 `id_token`（JWT）→ 解出 claims；`external_id = claims[identity_id_field]`（默认 `sub`）；`email = claims[email_field]`；`login_name = claims[login_name_field]`。
- **纯 OAuth2**：token 响应无 ID token → 用 access token 调 `userinfo_url` 取 profile；同上按字段映射。
- **具名提供商**（azure-ad/feishu/dingtalk/wecom）：`authorize_url`/`token_url`/`userinfo_url`/默认 scopes/默认字段由**预设表**提供（`provider_presets.ts`），表单可覆盖；本质仍走上述 OIDC/OAuth2 两条路径。

---

## 5. JIT 开号 + 邮箱域名门 + 去重（核心逻辑）

```
输入: connectionId, orgId, { external_id, login_name?, email? }
1. 域名门:
   - email 非空且 whitelist 非空:
        若 email 域名 ∉ whitelist → 拒绝(login_failed: not an org member / domain not allowed)
   - email 为空:
        - 若 connection 要求邮箱(默认要求) → 拒绝
        - 否则: 允许(仅按 external_id 匹配, 见下)
2. 去重 / JIT:
   a. 查 user_idp_identities WHERE (sso_connection_id, external_id) → 命中 → 该 user(已绑定, 复用)
   b. 否则按 (org_id, email) 查 users → 命中 → 为该 user 新增一条 user_idp_identities 绑定(跨 IdP 去重: 同一内部用户)
   c. 否则 JIT createUser:
        username = login_name 或 email 的 @前缀(冲突则加后缀/拒绝, 见下)
        email, display_name = login_name, extra_roles=[Role.User]
        新增 user_idp_identities 绑定
3. claims = { sub: userId, orgId, roles }; token = signToken(claims)
```

- **username 冲突**：`username` 取 `login_name`；若 `UNIQUE(org_id, username)` 冲突且该 user 非步骤 b 命中之人 → **拒绝**（不让 SSO 覆盖已有密码账号）。步骤 b 命中时不动 username。
- **角色**：JIT 一律 `Role.User`；管理员事后可在成员管理里调 `extra_roles`。
- **密码**：SSO JIT 用户 `password_hash` 为空（不可用密码登录，除非后续设置）。

---

## 6. 桌面端入口（复用现有企业登录桥）

- 桌面 `LoginPage` / 企业登录桥（`enterpriseAccount`、`enterpriseMt.ts`）：`enterpriseClient` 登录前调 `GET /auth/sso/providers?orgName=`；若有 enabled 连接，登录页在「用户名+密码」旁渲染**「用 <name> 登录」**按钮（按 `sort_order`）。
- 点击 → 打开 `GET /auth/sso/:id/authorize?orgName=&return=desktop`（`shell.openExternal` 或内嵌 BrowserWindow）。
- IdP 完成后回跳 `GET /auth/sso/desktop/callback?code&state`：
  - **桌面首选**：回跳到一个 **localhost 回调**（复用现有 OAuth 流的 localhost callback 机制，`main/mcp/oauthBrowserFlow.ts` / `qichachaMcpAuth` 同款）→ 桌面主进程拿到 token → `persistSession` + `loginGate.unlock`（复用现有登录后刷新流程，`enterpriseMt.ts:183`）。
  - 深链备选：`genwork://sso/callback?code=..`（若 localhost 不可用）。
- **服务端凭据绝不下发桌面**；桌面只拿最终 JWT。

---

## 7. 管理端（`enterprise_server/web`）+ 权限

- 新页面/入口：org-admin 的「SSO / 身份提供商」管理（列表 + 创建/编辑/启用/删除）。**创建 SSO 连接**表单即用户提供图（按 `provider_type` 切换字段：具名提供商出 App ID/Secret，通用 OIDC/OAuth2 出 Client ID/Secret + 授权/Token/UserInfo URL + 协议下拉，SAML2 出 IdP SSO URL/Entity ID/NameID/SP Entity ID）。
- **权限**：复用既有 org-admin（org 管理员可 CRUD SSO 连接）；**不新增 PermissionPoint**（若现有 org-admin 无独立点，则挂到既有 admin 门禁 —— 实现时核对现有 admin 路由的门禁约定，`requireAuth` + org-admin 校验，仿 `adminUserRoutes`）。
- **CRUD 路由**（`requireAuth`，org-scoped，外 org → 404）：`/admin/sso-connections`（list/get/create/patch/delete）。**删除**：禁用优先（`enabled=false`）；硬删需确认（该连接的 `user_idp_identities` 绑定一并删或保留 —— 一期**仅禁用，不硬删**，避免成员失联）。
- **写审计**：走既有 `auditStore`/`audit_events`（`{before, after}`）。
- 管理视图返回 `client_secret_masked`（**永不**返回明文/密文给 SPA）；编辑留空 = 保留现有 secret（同连接器 secret 约定）。

---

## 8. 安全约束

- **secret 存储**：`client_secret_encrypted = encrypt(plaintext)`（`vault/crypto`）；管理视图只回 `masked`；回调换 token 时服务端 `decrypt`。**明文 secret 永不出 wire / 永不进 SPA / 永不进桌面。**
- **CSRF**：服务端签发随机 `state`（短 TTL、一次性、绑定 org+connection+return_target）。
- **PKCE**：公开客户端（无 secret）强制 PKCE；机密客户端附 `client_secret`。
- **邮箱域名白名单**：JIT 时强制（§5 步骤 1）；白名单为空 → 拒绝 JIT（防任意 IdP 用户进 org）。
- **跨 org 隔离**：管理 CRUD 按 `claims.orgId` 过滤（外 org 404）；登录 `state` 绑定 org。
- **回调防护**：callback 限频 / 防暴力（复用既有登录限频）；state 一次性。
- 日志**永不**打印 code / token / secret / 凭据值。
- 不新增 `PermissionPoint`；不引入新 JWT 字段（claims 形状不变）。

---

## 9. 与 MCP 连接器 `sso` 鉴权方式的边界（关键澄清）

> **两者是不同的东西，不得混淆：**
> - **本方案（企业 SSO 成员登录联邦）**：解决「**成员如何登录 GenWork**」（成员 → GenWork 的身份）。
> - **MCP 连接器 `sso` 鉴权方式**：解决「**第三方 MCP 服务如何验证调用方身份**」（GenWork/桌面 → 第三方 MCP 服务的 API 调用）。
>
> **明确决策（用户确认）：连接器 SSO 不复用成员企业会话。** MCP 连接器 `sso` 模式由该连接器**单独使用 SSO 做验证**（即连接器自身绑定的 IdP 端点 + 凭据，走桌面通用 OAuth 驱动 / 或网关），**不是**「成员已登录 GenWork 即放行」。
>
> 因此：
> - 本子系统（`sso_connections`）**不**作为连接器 `sso` 鉴权的凭据源。
> - 连接器 `sso` 的端点/凭据**按连接器存**（见 `2026-09-27-mcp-connector-desktop-consumption-design.md` §4.1 的 `sso*` 字段 + 公开视图 `oauth` 下发），与本子系统无数据耦合。
> - 消费方案中 SSO 直连设计（桌面用连接器自身 SSO 端点 + 通用 OAuth 驱动）**保留不变** —— 已按此调整。

---

## 10. 关键约束（沿用全局约束）

- **测试代码是权威的**：不改既有断言语义；仅新增断言（如需改既有 → 显式签核）。
- **逐文件跑测试**（sandbox fd 耗尽）：`enterprise_server` 与 `web` 全量 vitest 会 EBADF —— `npx vitest run <file>` 逐文件 fresh process。
- **typecheck 基线**：`enterprise_server`/`web` `tsc --noEmit` 0 错误；desktop 既有基线。
- **i18n 中英文成对**，无未引用键（管理端表单 + 登录按钮文案）。
- **secret**：加密存、不出 wire；管理视图只 mask。
- **跨组织隔离**：外 org → 404。
- **自动提交仅本地**，不 push（除非明确要求）。
- 不新增 `PermissionPoint`；写操作走既有审计。

---

## 11. 测试策略（逐文件）

- **后端**（新增 `tests/routes/sso.test.ts` + `tests/sso/jit.test.ts`，pglite in-process + mock IdP）：
  - CRUD：create/patch/list/get（org-scoped，外 org 404）；`client_secret` 只回 mask、编辑留空保留。
  - `GET /auth/sso/providers`：只回 enabled + name/type，**不含** secret/url/client_id。
  - `authorize`：返回 302 到正确 IdP URL；`state` 生成且存表；PKCE（公开客户端）/ 附 secret（机密）。
  - `callback`：state 校验（过期/不符 → 拒）；code 换 token（mock）；OIDC ID token 解析 / OAuth2 userinfo 解析；字段映射取 `external_id`/`email`。
  - **JIT**：新身份 → 建用户（`Role.User`）+ 绑定；已有 `external_id` 绑定 → 复用；已有 `(org_id,email)` 用户 → 跨连接去重绑定；**邮箱域名白名单**命中/拒绝；username 冲突拒绝。
  - JWT claims 与密码登录同构（`{sub, orgId, roles}`）。
- **SPA**（`web` 组件测试）：创建 SSO 连接表单按 `provider_type` 切换字段 + 预设回填；登录页「用 X 登录」按钮列表。
- **桌面**（renderer 纯函数 + 主进程，规避 ABI）：provider 列表渲染；authorize 打开；token handoff（mock localhost callback）。
- **SPA 类型 / 后端 tsc** 干净。

---

## 12. 分期 / 里程碑

- **M1 — 数据模型 + 管理 CRUD + SPA 表单**：`036_sso_connections.sql`（含 `user_idp_identities`）；`/admin/sso-connections` CRUD；SPA「创建 SSO 连接」表单（6 提供商类型 + 字段切换 + 预设）。
- **M2 — 服务端登录舞 + JIT + 白名单**：`/auth/sso/providers` + `authorize` + `callback`（控制台）；OIDC + OAuth2 两条路径；`provider_presets`；JIT/去重/域名门。
- **M3 — 控制台登录入口**：登录页 SSO 按钮；state 表；审计。
- **M4 — 桌面登录入口**：桌面 provider 列表 + authorize 打开 + localhost callback token handoff。

> 建议 M1 → M2 → M3 → M4，每里程碑独立验证 + 逐文件测试 + typecheck 门禁。M1 可独立交付（管理端配置 + 校验，未接入登录）。

---

## 13. 风险与回退

| 风险 | 缓解 |
|---|---|
| 桌面 localhost callback 被其它应用抢占端口 | 随机端口 + 启动前探测 + 深链备选（§6）。 |
| IdP 侧需配置 redirect_uri（localhost）→ 部署不一致 | 文档化：desktop callback 为 localhost 动态端口（PKCE 公开客户端，无固定回跳）；具名提供商按各家约定。 |
| 跨 IdP 去重只按 email，email 缺失时可能建重复用户 | JIT 强制要求 email（默认）；缺 email 时仅按 `(connection, external_id)` 去重，不跨连接去重（文档明示）。 |
| SAML2 后置 → 图里 SAML2 选项暂不可用 | SAML2 连接可存但 `enabled` 强制 false（一期不启用），登录页不展示；UI 标注「即将支持」。 |
| 具名提供商端点预设随 IdP 变更 | 预设集中在 `provider_presets.ts`，可覆盖；变更只改预设表。 |
| 机密客户端 secret 泄露面 | secret 仅服务端 vault；回调换 token 服务端完成；永不下发。 |

---

## 14. 待确认 / 开放问题（已给决策假设，评审可否决）

1. **`state` 存储（已假设）**：轻量 `sso_login_states` 表（跨重启 + 多实例），短 TTL（~2 分钟）+ 一次性。
2. **JIT 角色（已假设）**：一律 `Role.User`；不接 IdP 组映射（§1.2）。
3. **email 必填（已假设）**：默认要求 IdP 返回 email 且命中白名单；`email` 为空 → 拒绝 JIT（防任意 IdP 用户进 org）。可配「允许无邮箱仅按 external_id」为后续开关。
4. **删除策略（已假设）**：一期**仅禁用不硬删**（避免成员失联）。
5. **权限点（已假设）**：复用现有 org-admin 门禁，**不新增** PermissionPoint；实现时核对现有 admin 路由门禁约定。
6. **与连接器 SSO 的边界（已确认，§9）**：连接器 SSO **不复用**成员企业会话，连接器单独用自身 SSO 验证 —— 本子系统不作连接器凭据源。
