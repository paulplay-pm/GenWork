# MCP 连接器 — 桌面端按「传输协议 × 鉴权方式」消费设计（GenWork 工作台）

**Date:** 2026-09-27
**Owner:** paul
**Status:** Draft (待评审 → 转 writing-plans)
**前序设计:**
- `docs/superpowers/specs/2026-09-26-mcp-connector-management-design.md`（连接器子系统 P0/P1，含 §1.2 P2「服务端 MCP 网关」）
- `docs/superpowers/specs/2026-09-27-mcp-connector-desktop-oauth-design.md`（桌面端 `user-oauth` 按服务商登录）
**原型/PRD:** 同前序（传输协议 / 6 种鉴权方式为管理端已有配置项）。

---

## 0. 一句话

管理端（企业服务端）**只是配置**（传输协议 `http`/`sse` × 鉴权方式 6 种）。**真正使用连接器的是桌面端**（经 OpenClaw 调用 MCP）。本设计定义桌面端如何针对每种「传输 × 鉴权」组合去**获取凭据、注入、并决定 OpenClaw 连哪个 URL**。

---

## 1. 架构前提（已核对源码）

**桌面端本身不说 MCP 线协议。** `McpRuntime.getResolvedServers()`（`src/main/mcp/mcpRuntime.ts:211`）把每个 `McpServerConfig` 解析成 `ResolvedMcpServer`（`src/main/libs/openclawConfigSync.ts:1158`），再 **sync 进 OpenClaw 配置** —— **OpenClaw 才是真正建立 streamable-HTTP/SSE 连接、跑工具的一方。**

**传输协议已是纯 pass-through（无需新实现）：** `openclawConfigSync.ts:1215-1230` 已同时处理两种传输：
- `sse` → `{ url, headers }`（OpenClaw 用 SSE 客户端）
- `http` → `{ url, headers, transport: 'streamable-http' }`

桌面只需把连接器的 `url` + `transport` 透传给 OpenClaw。**因此本方案的「按传输协议实现」= 透传，无新桌面传输代码。** 真正的分组合工作在「按鉴权方式的凭据获取 + 注入 + 目标 URL 选择」。

> 桌面侧另有 `mcpAuthProbe.ts`（轻量 `fetch`+`initialize` 出「已启用/待配置」状态点）与企业服务端 `mcp/handshake.ts`（真实 MCP 握手，`@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport` / `SSEClientTransport`）。二者都**按连接器 URL + headers** 探活，本方案需让它们与 OpenClaw 命中**同一个目标 URL**（直连 or 网关），否则状态点失真。

### 1.1 管理端已有的矩阵约束（非本方案新增）

`ConnectorConnConfig.tsx:38`：`SSE_INCOMPATIBLE_AUTH_MODES = ['user-oauth', 'client-creds', 'sso']` —— **SSE 只能配 `none`/`shared-key`/`user-key`**；后三者**仅 `http`**。（与图中提示一致：SSE 为旧版，仅无鉴权 + API Key；OAuth 选 Streamable HTTP。）

---

## 2. 消费矩阵（本方案核心，已与用户确认）

| 鉴权方式 | 传输 | 路径 | 凭据归属 | 桌面端要做的事 |
|---|---|---|---|---|
| `none` | http/sse | **直连** | — | 无 header |
| `user-key`（用户密钥） | http/sse | **直连** | **用户** | 用户粘贴密钥 → 桌面 vault → 注入 header/env |
| `user-oauth`（用户 OAuth） | http only | **直连** | **用户** | 按服务商 OAuth 登录 → 令牌 → Bearer header（2026-09-27 spec） |
| `sso`（SSO） | http only | **直连** | **用户** | 连接器**自身**绑定的 SSO IdP 端点 → **通用 OAuth 驱动** → 令牌（复用 `user-oauth` 驱动）。**不复用成员企业会话**（见下） |
| `shared-key`（共享密钥·组织统一） | http/sse | **网关** | **组织**（服务端 vault） | OpenClaw → 网关 URL + 用户 JWT；网关注入组织密钥 |
| `client-creds`（客户端凭据） | http only | **网关** | **组织**（服务端 vault） | OpenClaw → 网关 URL + 用户 JWT；网关用 id+secret 换令牌 |

**两条消费路径取代现状的「组织凭据模式一律停在 needs-auth」：**
- **直连（用户持有：`user-key`/`user-oauth`/`sso`）** —— OpenClaw 直连连接器 `url`；桌面把用户凭据取进 vault 并注入 `headers`。
- **网关（组织持有：`shared-key`/`client-creds`）** —— OpenClaw 连企业服务端网关；网关在出站注入组织凭据。组织机密**永不下发**桌面。

> **SSO 归属决策（已确认）：** SSO 走**桌面直连**，且「SSO 端点存服务端、通用 OAuth 驱动」——即 SSO 复用 `user-oauth` 的通用 OAuth 驱动，差异仅在元数据来源（`ssoApp` 作 provider 标识 + 服务端下发的 SSO 端点/clientId）。**不**在桌面内置 4 个 IdP 的硬编码流程。
>
> **⚠ 明确决策（用户确认）：连接器 SSO 不复用成员企业会话。** MCP 连接器 `sso` 鉴权 = 「GenWork/桌面 → **该第三方 MCP 服务**的 API 调用」的身份验证，由**连接器自身单独绑定并使用 SSO 做验证**（连接器自己的 IdP 端点 + clientId，走桌面通用 OAuth 驱动），**不是**「成员已用企业 SSO 登录 GenWork 即放行」。它与 `2026-09-27-enterprise-sso-member-login-federation-design.md`（成员登录联邦）是**两件不同的事、无数据耦合** —— 成员登录联邦的 `sso_connections` **不**作为连接器 SSO 的凭据源。

---

## 3. 范围与分层

| 层 | 内容 |
|---|---|
| **桌面**（repo root） | ① 按连接器计算 **目标 URL（直连 vs 网关）+ 注入 headers**（`McpRuntime` / 安装路径）；② `user-key` 企业连接器接线（header 名 + vault + 重认证）；③ **通用 OAuth 驱动**（`user-oauth` + `sso` 共用，2026-09-27 spec 的 `genericOauthFlow`）；④ 探针/状态点与 OpenClaw 命中同一目标 URL。 |
| **后端**（`enterprise_server`） | ① 新增 **MCP 网关**路由（JWT 鉴权 + scope/启用/工具级校验 + 流式代理 + 组织凭据注入）；② 管理端 `user-oauth`/`sso` 表单补 **端点字段**（`authorizeUrl`/`tokenUrl`/`clientId`；SSO 补 IdP 端点）；③ 公开市场视图下发**非机密**端点元数据到桌面。 |
| **管理控制台**（`enterprise_server/web`） | `ConnectorDrawer`/`ConnectorAuthFields`：`user-oauth` 与 `sso` 的端点字段采集 + 回填 + 校验 + i18n（中英文）。 |

**不做（YAGNI / 边界）：**
- **不新增桌面传输**（透传既有 sse/streamable-http）。
- **组织机密永不下发桌面**（`clientSecret` / SSO secret 留服务端 vault；公开视图只发非机密端点）。
- **SSE 仅直连**（`none`/`shared-key`/`user-key`）；三个 OAuth 类模式保持 http-only（管理端已强制）。
- 不做 dynamic client registration（管理员提供 `clientId`，PKCE 公开客户端）。
- 不新增 `PermissionPoint`（复用 `mcp:*`）；写操作走既有 `auditStore`。
- **不动企查查内置 bundle**（`providerId:'qichacha'` 保持）。
- 不改动既有测试断言语义（测试是权威的）；仅新增断言（如需改既有断言，显式签核）。

---

## 4. 数据契约

### 4.1 管理端 `auth_config` 按模式（`mcp_connectors.auth_config` JSONB）

| 模式 | 非机密字段 | 机密字段（`__enc__`） |
|---|---|---|
| `user-key` | `apiKey` header 名（如 `X-Api-Key`） | `apiKey` 值（若组织预置）|
| `user-oauth` | `authorizeUrl` / `tokenUrl` / `clientId` / `scopes` | `clientSecret`（机密客户端才需；**不下发桌面**） |
| `sso` | **`ssoAuthorizeUrl` / `ssoTokenUrl` / `ssoClientId` / `ssoScopes`** + `ssoApp`（`oidc`/`feishu`/`dingtalk`/`wecom`） | `ssoClientSecret`（机密客户端才需；**不下发**） |
| `shared-key` | — | `apiKey`（组织统一密钥；**不下发桌面**，网关注入） |
| `client-creds` | `tokenUrl` / `clientId` / `scopes` | `clientSecret`（**不下发桌面**，网关换令牌） |

> `user-oauth` 与 `sso` 结构对称（同一套「authorize + token + client」），只是键前缀与 provider 标识不同 —— 便于桌面共用一个驱动（§5.1）。`shared-key`/`client-creds` 的机密字段**仅服务端可读**（网关用）。

### 4.2 公开市场视图下发到桌面（`ConnectorPublicView` / `McpEnterpriseMarketServer`）

在 2026-09-27 spec §4.2 的 `oauth` 子对象基础上，扩展为覆盖 user-oauth **与** sso（**仅非机密**）：

```ts
interface ConnectorPublicView {
  // …既有字段不变（id/serverKey/name/url/transport/authMode/…）…
  /** 仅直连模式（user-oauth / sso）且端点齐全时存在；非机密。绝不含 secret / __enc__* 。 */
  oauth?: {
    provider: string;          // user-oauth→连接器 serverKey；sso→ssoApp
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
}
```

**安全不变量：**
- 仅当 `authMode ∈ {user-oauth, sso}` 且对应 `authorizeUrl`+`tokenUrl` 非空时填充 `oauth`；其余模式 `undefined`。
- 取值走**白名单挑选**（`authorizeUrl`/`tokenUrl`/`clientId`/`scopes`/`ssoApp`），**显式忽略** `*ClientSecret` 与任何 `__enc__*`。不复用 `maskConnectorSecrets`（那是 admin 端脱敏展示语义）。
- `shared-key`/`client-creds` **不下发任何 authConfig**（机密留服务端；桌面只需知道「这是网关模式 + 网关 URL」）。
- 端点不全 → `oauth: undefined` → 桌面走 §5.4 护栏（不静默回落到企查查）。

### 4.3 桌面本地存储（`McpServerConfig`）

- 新增 `oauthConfig?`（结构同 §4.2 `oauth`）：企业安装时把 `enterpriseServer.oauth` 落进本地，供后续重认证。
- 新增 `consumption?: 'direct' | 'gateway'`（或按 `authMode` 推导）：决定 OpenClaw 目标 URL。
- 新增（网关模式）`gatewayUrl?` 或按 `serverKey` 约定拼出。
- 既有 `oauth: {providerId, token}` 凭据不变（access token 仍存此；端点元数据另存 `oauthConfig`）。

### 4.4 凭据落盘 / header 注入路径（复用，不重写）

- 直连：`mcpAuthFlows.saveCredential` 现有落盘（`headers.Authorization = Bearer` 或 apiKey header / stdio `env`）→ `openclawConfigSync` 透传 `headers`。**零新增落盘逻辑**。
- 网关：OpenClaw 的 `headers` 注入**用户 JWT**（`Authorization: Bearer <enterprise jwt>`），由桌面现有企业鉴权（`enterpriseFetchWithAuth` / sessionStorage org JWT）提供。网关凭据由服务端注入，桌面不感知。

---

## 5. 桌面实现

### 5.1 通用 OAuth 驱动（`user-oauth` + `sso` 共用）

沿用 2026-09-27 spec §5.1 的 `genericOauthFlow`（authorization-code + PKCE + localhost callback + `openOauthFlow` 原语 + code→token 交换）。本方案的差异点：
- **驱动参数化到连接器自身端点**（`authorizeUrl`/`tokenUrl`/`clientId`/`scopes`），来源为本地 `oauthConfig`（§4.3），`provider` 字段区分（user-oauth→serverKey；sso→`ssoApp`）。
- `sso` 与 `user-oauth` **同一驱动、同一 payload 形状**，仅 `provider`/端点值不同 —— 无 4 个 IdP 分支。

### 5.2 `OAUTH_REGISTRY` / payload（桌面）

同 2026-09-27 spec §5.2/5.3：`SaveCredentialPayloadOAuth` 增 `oauthConfig`；`providerId` 取 `generic:<provider>`（user-oauth=`generic:<serverKey>`；sso=`sso:<ssoApp>`）；registry 旁路（方案 B）按 `oauthConfig` 驱动通用流程，企查查路径不动。

### 5.3 目标 URL 选择（`McpRuntime` / 安装路径，本方案新增核心）

对每个连接器计算 OpenClaw 命中的 URL + headers：

```
if authMode ∈ {shared-key, client-creds}:
    url   = GATEWAY_BASE + '/mcp/gateway/' + serverKey   # 网关
    headers = { Authorization: Bearer <user-jwt> }
else:  # none / user-key / user-oauth / sso
    url   = connector.url                                 # 直连
    headers = 按鉴权注入（none 无 / user-key 密钥头 / oauth-sso Bearer）
transport 透传（sse / streamable-http）不变
```

- **直连**：`url = connector.url`（现状已成立）。
- **网关**：`url` 改写为网关 URL，header 携用户 JWT。**用户 JWT 在主进程可得**：`enterpriseClient.getToken(): Promise<string | null>`（`src/main/auth/enterpriseClient.ts:260`，已 `setTokenProvider(() => sessionStorage.load()?.jwt)`），过期走 `enterpriseClient.refresh()`。`McpRuntime` 组装 `headers` 时调用它。**探针（§6 桌面）同样指向该 URL**，使状态点反映真实路径。

### 5.4 护栏（替代「误开企查查」，复用 2026-09-27 §5.4）

`user-oauth`/`sso` 连接器若**无** `oauthConfig`（端点未配全）→ 桌面重认证不提交，展示明确文案（中英文）：「该连接器的 OAuth/SSO 登录方式尚未在管理端配置（缺少授权/令牌地址），暂时无法完成登录。」**绝不**静默回落企查查。`sse` + 三个 OAuth 类模式本就被管理端禁止，桌面侧兜底同护栏。

### 5.5 `user-key` 企业接线（复用现有 API-key 流）

现有桌面 `apiKey` 流程（header 名 + 值 → vault → header）已存在。本方案只需：企业 `user-key` 连接器安装时把 `apiKey` header 名预填、值走桌面 vault、重认证弹窗复用 `McpAuthModal` 的 ApiKey 分支。**基本是接线，非新子系统。**

---

## 6. 后端 MCP 网关（新增，前序 spec §1.2 P2 前移）

> 仅服务组织凭据两模式（`shared-key`/`client-creds`）。用户凭据三模式直连，不经网关（已确认「用户凭据直连」）。

### 6.1 路由与鉴权

- `POST/GET /mcp/gateway/:serverKey`（Hono，`requireAuth`）。
- 入站携**用户 JWT**：`claims.orgId` + `claims.sub`。
- **校验**（与公开路由 `mcpMarketplace.ts` 同口径）：连接器存在、`enabled`、`auth_mode ∈ {shared-key, client-creds}`、**scope 命中**（`scopeApi.deptIdsFor` + 子树）、**工具级**（`tools[].enabled`，`removed` 置灰）。任一不满足 → 404/403。

### 6.2 出站凭据注入 + 流式代理

- 解析连接器真实 `url` + `transport` + `auth_config`（**服务端解密** `clientSecret`/`apiKey`，`decryptConnectorSecrets`）。
- 注入组织凭据：
  - `shared-key` → 请求头 `Authorization: Bearer <apiKey>`（或连接器约定的 key 头）。
  - `client-creds` → 用 `clientId`+`clientSecret` 对 `tokenUrl` 做 client-credentials 换令牌 → `Authorization: Bearer <token>`；**缓存令牌**（见 §6.3）。
- 以 `@modelcontextprotocol/sdk` 建到真实连接器的 **streamable-http / SSE** 客户端（复用 `mcp/handshake.ts` 的 transport 选择逻辑），把入站 MCP 请求**流式代理**出去，把响应流式回传。

### 6.3 令牌缓存（client-creds）

按 `(orgId, serverKey)` 缓存 client-creds access token（TTL 取令牌 `expires_in`，留缓冲），过期重换。**不落库**（进程内缓存即可；重启重建）。

### 6.4 安全

- 组织 `clientSecret`/`apiKey` **只存在于服务端**，注入在网关进程内完成，**永不**出现在对桌面的响应里。
- 网关**不**回显连接器真实 URL 给桌面之外的调用方；错误信息不含凭据/机密。
- 复用既有企业 JWT（org 作用域），**不新增**独立凭据体系。

---

## 7. 管理控制台实现

- `ConnectorAuthFields.tsx` / `ConnectorDrawer.tsx`：
  - `user-oauth`：新增 `authorizeUrl` / `tokenUrl`（`clientId`/`scopes` 已有）—— `buildAuthConfig` 写入 `cfg.authorizeUrl`/`cfg.tokenUrl`；编辑态/`applyDraft` 回填；必填校验。
  - `sso`：现有仅 `ssoApp`（下拉）；新增 `ssoAuthorizeUrl` / `ssoTokenUrl` / `ssoClientId`（+ 可选 `ssoScopes`/`ssoClientSecret`）；`buildAuthConfig` 写入；校验 `ssoApp` + 端点齐全。
  - i18n（中英文）：`mcpDrawer.auth.authorizeUrl`/`tokenUrl`（user-oauth 与 sso 可复用或加 sso 前缀）+ 校验提示。
- 后端 `connectorCfgSchema` 的 `authConfig` 是 `z.record(z.unknown())`（loose），新键**天然通过**。
- **⚠ `missingAuthField`（`mcpConnectors.ts:156`）** 现对 `user-oauth` 强制 `clientId`+`clientSecret`。桌面直连需支持**公开客户端（无 secret）**形态 → 放宽：`user-oauth`/`sso` 若 `authorizeUrl`+`tokenUrl`+`clientId` 齐全则免 secret；否则要求 `clientSecret`（机密客户端走网关/或暂不支持桌面直连）。**触及既有测试语义 → 实现时经确认。**

---

## 8. IdP / 集成前提（非代码可解，文档记录）

- 直连的 `user-oauth`/`sso` 要求目标 IdP 支持**公开客户端 + PKCE + localhost 回跳**（或用可下发 `clientId`）。若某 IdP 仅支持机密客户端 + 固定服务端回跳 → 桌面无法独立完成 → 走 §5.4 护栏 / 或改走网关。
- SSO 各 IdP（oidc/feishu/dingtalk/wecom）需管理员提供其 `authorize`/`token` 端点 + `clientId`。

---

## 9. 关键约束（沿用全局约束）

- **测试代码是权威的**：不改既有断言语义；仅新增断言（如需改既有，显式签核）。
- **逐文件跑测试**（sandbox fd 耗尽）：`enterprise_server` 与 `web` 全量 vitest 会 EBADF —— `npx vitest run <file>` 逐文件 fresh process。desktop 主进程测试有 `better-sqlite3.node` ABI 既有失败（与本改动无关）。
- **typecheck 基线**：`enterprise_server`/`web` `tsc --noEmit` 0 错误；desktop `electron-tsconfig` 0 错误；desktop renderer 仅既有 `bakeArtifactSharePage.ts(382,21)`。
- **i18n 中英文成对**，无未引用键。
- **secret**：机密加密存、不出 wire；公开视图只发非机密端点。
- **跨组织隔离**：网关按 JWT org + scope 校验（外 org 404）。
- **自动提交仅本地**，不 push（除非明确要求）。
- 不新增 `PermissionPoint`。

---

## 10. 测试策略（逐文件）

- **后端网关**（新增 `tests/routes/mcpGateway.test.ts`，pglite in-process）：
  - 用户 JWT + `shared-key` 连接器（scope 命中）→ 网关代理成功，出站头注入 `apiKey`。
  - `client-creds` → 换令牌 + 缓存命中（第二次不重换）；过期重换。
  - scope 未命中 / `enabled=false` / 外 org → 404/403。
  - 工具级：`tools[].enabled=false` 的工具调用被拒。
  - 响应中**不含** `clientSecret`/`apiKey` 明文 / 连接器真实 URL 泄露。
- **公开视图**（`mcpMarketplace.test.ts` / `connectorView`）：
  - `user-oauth`/`sso` 端点齐全 → `oauth{provider,authorizeUrl,tokenUrl,clientId,scopes}`，**不含** secret/`__enc__*`。
  - 端点不全 / `shared-key`/`client-creds` → 无 `oauth`。
  - 跨组织隔离回归。
- **管理端校验**：`missingAuthField` 放宽后的公开/机密客户端分支（新增断言；若动既有断言 → 签核）。
- **桌面**（renderer 纯函数优先，规避主进程 ABI）：
  - 目标 URL 选择纯函数：`shared-key`/`client-creds`→网关 URL+JWT header；其余→直连 URL。
  - `buildSaveCredentialPayload`：user-oauth/sso → `generic:<provider>`/`sso:<ssoApp>` + `oauthConfig`；无 `oauthConfig` 非企查查 → 不回落 qichacha（护栏）。
  - 探针目标 URL 与 OpenClaw 一致（直连/网关）。
- **SPA**：`ConnectorDrawer` 组件补 user-oauth/sso 端点回填 + 必填校验断言（如有既有组件测试）。

---

## 11. 分期 / 里程碑

- **M0 — 护栏（低风险，独立可交付）**：§5.4 护栏（user-oauth/sso 无端点 → 明确提示，不再误开企查查）。显示标签已在 commit `4b077df` 完成。
- **M1 — 数据链路（直连三模式）**：§4.1–4.3（管理端 user-oauth/sso 端点字段 + 公开视图 `oauth` 白名单下发 + 桌面 `oauthConfig` 持久化）+ §5.1–5.2 通用 OAuth 驱动 + §5.5 `user-key` 接线。
- **M2 — 网关（组织两模式）**：§6（MCP 网关路由 + 组织凭据注入 + 流式代理 + 令牌缓存）+ §5.3 桌面目标 URL 选择（直连/网关分派）。
- **M3 — 端到端验证**：直连（user-key / user-oauth / sso）与网关（shared-key / client-creds）各跑通一个真实/ mock 连接器。

> 建议 M0 → M1 → M2 顺序，每里程碑一次独立验证 + 逐文件测试 + typecheck 门禁。M0 可先合（不动安全边界）。

---

## 12. 风险与回退

| 风险 | 缓解 |
|---|---|
| 网关流式代理（streamable-http/SSE）复杂度 + 延迟 | 复用 `mcp/handshake.ts` 的 SDK transport 选择；M2 单独验证流式回传；失败降级为明确错误。 |
| 向桌面下发 OAuth/SSO 端点触及安全边界 | 白名单只取非机密；secret/`__enc__*` 显式剥离；公开视图本就 org+scope 过滤。 |
| IdP 不支持 localhost/PKCE 公开客户端 | §8 前提 + §5.4 护栏兜底（清晰错误，不崩）。 |
| `missingAuthField` 放宽触及既有测试 | 实现时核对；如需改既有断言 → 显式签核（同 Batch A #4 先例）。 |
| 组织机密经网关代理泄露 | 网关进程内注入，组织 secret 不出服务端；错误/响应不含凭据；仅 JWT org+scope 校验。 |
| 桌面探针与 OpenClaw 目标 URL 不一致致状态点失真 | §5.3 单一函数计算目标 URL，探针与 OpenClaw 共用。 |
| 网关 header 用**静态**用户 JWT，而 JWT 会过期 | 复用既有 JWT 刷新重同步钩子：`main.ts:3127` `applyConfig: syncOpenClawConfig({reason:'enterprise-jwt-refresh'})` 会在 JWT 刷新时重写 OpenClaw 配置（含网关 header 的新 JWT）。**缺口**：刷新到刷新之间若 JWT 恰好过期，网关请求会 401 —— 需网关返回可识别的 401，触发桌面 `enterpriseClient.refresh()` + 重同步。列为 M2 验收点。 |

---

## 13. 待确认 / 开放问题（已给出决策假设，评审可否决）

1. **网关 URL 方案（已假设）**：桌面把 OpenClaw 指向 `GATEWAY_BASE + /mcp/gateway/:serverKey`，`GATEWAY_BASE` 用既有 `ENTERPRISE_SERVER_URL`（构建期烘焙，见 memory）拼出，header 携用户 JWT。**假设成立**：不改 OpenClaw 全局出口，只按连接器改写其 URL。评审如需「统一出口」再调整（当前决策为「用户凭据直连」，网关只服务组织两模式）。
2. **client-creds 令牌缓存（已假设）**：进程内按 `(orgId, serverKey)` 缓存 + TTL，**不落库**。评审如需跨进程/持久化再议。
3. **SSO 端点字段形状（已假设）**：`ssoAuthorizeUrl`/`ssoTokenUrl`/`ssoClientId`/`ssoScopes`（+ 可选 `ssoClientSecret`），与 `user-oauth` 结构对称、键前缀区分，**不下发 secret**。桌面复用同一 `oauth` 下发对象（`provider` 字段区分 user-oauth vs sso）。
4. **`ssoApp` 是否可移除**：保留（作为 provider 标识 + 潜在网关侧 IdP 选择）。
5. **SSO 机密客户端**：若某 SSO IdP 需 `ssoClientSecret`（机密客户端），桌面直连不成立（secret 不下发）→ 该连接器需走网关（当前网关仅覆盖 shared-key/client-creds）。**评审决策**：本期网关是否扩展到「sso 机密客户端」？默认**否**（保持 SSO 直连=公开客户端）。
