# MCP 连接器 — 桌面端「按服务商 OAuth」登录设计（GenWork 工作台）

**Date:** 2026-09-27
**Owner:** paul
**Status:** Draft (待评审 → 转 writing-plans)
**前序设计:** `docs/superpowers/specs/2026-09-26-mcp-connector-management-design.md`（本方案是其 §6 桌面消费侧的补全 / 修正）
**关联 bug:** 桌面端 纷享销客连接器（`authMode: user-oauth`）点「重新认证」时，弹出的仍是**企查查**登录窗口（`agent.qcc.com`），而非纷享销客自身登录页。

---

## 1. 背景与问题

### 1.1 现状（已核对源码）

- 桌面端**只实现了一条 OAuth 握手流程** —— 企查查的（`src/main/mcp/qichachaMcpAuth.ts` → `startQichachaMcpApiKeyLogin`），**硬编码** `https://agent.qcc.com`（issuer + resource），走 dynamic client registration（`/oauth/register`）+ PKCE + 本地 callback 服务 + 自定义 token 探针。
- 主进程 `OAUTH_REGISTRY`（`src/main/mcp/mcpAuthFlows.ts`）**仅登记了 `qichacha` 一个 provider**（`// v1: just qichacha`）。
- 渲染进程 `buildSaveCredentialPayload`（`src/renderer/components/mcp/mcpAuthModalHelpers.ts`）对 `OAuth` 方法**硬编码** `{ kind:'oauth', providerId:'qichacha' }`（`// v1 only ships qichacha; the picker hard-codes that provider`）。
- 因此：**任意** `authMethod === OAuth` 的连接器（含企业 `user-oauth` 的纷享销客）点「重新认证」都会驱动**企查查**的 PKCE 流程 → 打开 `agent.qcc.com` 登录窗。

### 1.2 数据不闭环（根因）

桌面端**根本拿不到**驱动纷享销客自身登录所需的 OAuth 端点：

| 环节 | 现状 |
|---|---|
| 管理端 `user-oauth` 采集字段（`ConnectorDrawer.tsx`） | 仅 `clientId` / `clientSecret`(secret) / `callbackUrl`(服务端固定回跳) / `scopes`。**没有** `authorizeUrl` / `tokenUrl`。 |
| 公开市场视图（`mapPublicConnector` / `ConnectorPublicView`） | 下发给桌面的字段集**不含任何 `authConfig`**（`ConnectorPublicView` 接口里就没有这一项）。桌面 `McpEnterpriseMarketServer` 类型同样无 `authConfig`。 |
| 桌面连接器记录（`McpServerConfig`） | **没有 OAuth 端点字段**；`oauth` 凭据只存 `{providerId, token}`（`McpOAuthCredential`），端点信息无处存。 |

结论：桌面端对非企查查的 `user-oauth` 连接器，既没有正确标签（已由 commit `4b077df` 修复显示），也**没有可用的登录流程** —— 只能落到硬编码的企查查。

### 1.3 本方案目标

让每个连接器用**它自己的 OAuth 端点**驱动登录（「每个连接器 = 各自的服务商」）。管理员在管理端为 `user-oauth` 连接器配置授权/令牌端点 + client id + scopes；这些**非机密**配置随公开市场视图下发到桌面；桌面用一套**通用的** authorization-code + PKCE 流程驱动该连接器的登录，取代「一律走企查查」。

---

## 2. 方案选型（用户已确认）

| 选项 | 说明 | 取舍 |
|---|---|---|
| **护栏**（不做） | 非企查查 OAuth 连接器不再误开企查查，改为明确提示「暂不支持」。安全、改动小，但纷享销客在桌面仍无法登录。 | 不满足「各自服务商登录」的诉求。 |
| **通用按服务商 OAuth（本方案，已选）** | 用连接器自带端点驱动通用 OAuth 流程。 | 改动跨后端 + 桌面，且**跨安全边界**（向桌面下发 OAuth 配置）。 |
| **改连接器为非 OAuth**（不做） | 把纷享销客设成 API Key/Bearer，走既有通用凭据路径。 | 只是「把数据配对」，不新增按服务商登录能力；若产品就是要 OAuth 则不适用。 |

---

## 3. 范围与分层

| 层 | 内容 |
|---|---|
| **管理控制台**（`enterprise_server/web`） | `user-oauth` 采集新增 `authorizeUrl` / `tokenUrl` 两个**必填非机密**字段 + 校验；`McpEnterpriseMarketServer` 视图类型同步。 |
| **后端**（`enterprise_server/src`） | 公开市场视图 `mapPublicConnector` 新增**非机密** `oauth` 子对象（仅 `user-oauth` 模式下发，**剥离 secret / `__enc__*`**）。 |
| **桌面**（repo root） | 类型 + 安装时持久化 `oauthConfig`；主进程新增**通用 OAuth 驱动**并登记 `OAUTH_REGISTRY`；`buildSaveCredentialPayload` 改为传连接器自身 `oauthConfig`；**护栏**：无端点元数据时不再误开企查查，改为明确提示。 |

**不做（YAGNI / 边界）：**
- 不做 dynamic client registration（`/oauth/register`）——由管理员提供 `clientId`（公开客户端 + PKCE）。
- **不动企查查流程**：内置市场 `qichacha` bundle 保持现状（`providerId:'qichacha'`），回归风险最低。
- 不做 OAuth 端点自动 discovery（沿用前序设计 §1.2 的 P2 决策）。
- 不新增 `PermissionPoint`；不涉及新权限点。
- 不改动现有测试断言的语义（「测试代码是权威的」）；仅**新增**断言，且需逐文件运行（sandbox fd 耗尽约束）。

---

## 4. 数据契约

### 4.1 管理端 `auth_config`（`user-oauth`，存于 `mcp_connectors.auth_config` JSONB）

沿用现有字段，**新增** `authorizeUrl` / `tokenUrl`：

| 字段 | 机密性 | 说明 |
|---|---|---|
| `authorizeUrl` | **非机密** | 授权端点（IdP 的 `/oauth/authorize` 或等效地址），必填 |
| `tokenUrl` | **非机密** | 令牌端点（`/oauth/token`，code → access_token），必填 |
| `clientId` | **非机密** | 公开客户端 id（PKCE，无 secret），必填 |
| `scopes` | **非机密** | 空格分隔 / 数组；可空 |
| `clientSecret` | **机密**（`__enc__`） | 可选；仅私有客户端需要。**不下发桌面** |
| `callbackUrl` | **非机密** | 服务端固定回跳（既有 `CALLBACK_URL_DEFAULT`），**桌面不用于 redirect**（桌面用 localhost 回跳，见 §4.3） |

> 非机密字段在 vault 层**不加密**（现状：`clientId` / `tokenUrl` / `scopes` 本就是明文存）。`clientSecret` 经 `encryptConnectorSecrets` 内联加密。新增 `authorizeUrl` 按同样「非机密明文」处理，**不得**进 `maskConnectorSecrets` 的机密字段集。

### 4.2 公开市场视图下发到桌面（`ConnectorPublicView` / `McpEnterpriseMarketServer`）

新增一个**仅 `user-oauth` 时存在**的非机密子对象 `oauth`：

```ts
// ConnectorPublicView (enterprise_server/src/models/connectorView.ts)
interface ConnectorPublicView {
  // …既有字段不变…
  /** 仅 authMode==='user-oauth' 时存在；非机密。绝不含 clientSecret / 任何 __enc__* 。 */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
}

// McpEnterpriseMarketServer (src/renderer/types/mcp.ts) — 同步加上同样的 `oauth?` 字段。
```

**安全不变量（关键）：**
- `mapPublicConnector` 仅对 `authMode==='user-oauth'` 且 `authorizeUrl`+`tokenUrl` 均非空时填充 `oauth`；其余模式 `oauth` 为 `undefined`。
- 填充值**只取** `auth_config` 的非机密键（`authorizeUrl`/`tokenUrl`/`clientId`/`scopes`），**显式忽略** `clientSecret` 与任何 `__enc__*` 键。**不**复用 `maskConnectorSecrets`（那是给 admin 端「脱敏后展示」用的，语义不同）——公开视图走一条**白名单挑选**逻辑。
- 无端点（管理员未填全）时 `oauth` 为 `undefined` → 桌面走 §5.4 护栏。

### 4.3 桌面本地存储

- `McpServerConfig`（`src/renderer/types/mcp.ts`）新增 `oauthConfig?`（结构与 §4.2 的 `oauth` 一致）。
- 企业安装（`handleSaveForm` / 安装分支）把 `enterpriseServer.oauth` 落进本地 `oauthConfig`；**重新认证**时从本地 `oauthConfig` 读取，故安装后仍可用，不只安装时可用。
- 已有的 `oauth: {providerId, token}` 凭据（`McpOAuthCredential`）**保持不变**——access token 仍存这里，端点元数据另存 `oauthConfig`。

### 4.4 凭据落盘路径（不变）

`saveCredential`（`mcpAuthFlows.ts`）的 oauth 分支：`provider.runFlow(win)` 返回 access token → `store.updateServer(id, { oauth:{providerId, token}, headers.Authorization = Bearer token })` → probe。
**通用 provider 只需从标准 code→token 交换返回 access token 字符串**，其余落盘 / probe / Bearer 注入逻辑完全复用，**零改动**。

---

## 5. 桌面实现

### 5.1 通用 OAuth 驱动（主进程，新增 `src/main/mcp/genericOauthFlow.ts`）

标准 authorization-code + PKCE：

1. `createPkce()` 生成 `verifier`/`challenge`/`state`（复用 `qichachaMcpAuth.ts` 里的 `base64UrlEncode` / `createPkce` 同款实现，抽到共享处或本地复制）。
2. 起本地 callback 服务：`http://localhost:<随机端口>/callback`（复用 `qichachaMcpAuth.ts` 的 `startCallbackServer` 思路）。
3. `authorizeUrl = ${oauthConfig.authorizeUrl}?response_type=code&client_id=${clientId}&redirect_uri=${localhostCallback}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`。
4. `openOauthFlow({ parentWindow, title: <连接器名>, authorizeUrl, probe: <等 callback 收到 code 后做 code→token 交换并返回 access_token> })`（`openOauthFlow` 已是通用原语：给 URL + 探针即可）。
   - 回调命中 `/callback`（校验 `state`）→ 用 `code` + `code_verifier` POST 到 `tokenUrl`（`grant_type=authorization_code`）→ 解析 `access_token` → 返回。
5. 返回 access token 字符串。

> 不注册动态客户端、不用 `__enc__`、不读 `clientSecret`（PKCE 公开客户端模型）。

### 5.2 `OAUTH_REGISTRY` 登记（`mcpAuthFlows.ts`）

`OAUTH_REGISTRY` 的 provider 接口目前是 `{ id, label, buildAuthorizeUrl, runFlow }`，但 `runFlow(win)` **拿不到具体连接器的 `oauthConfig`**（provider 是无参的静态单例）。为支持「按连接器端点」，需让 oauth payload 携带 `oauthConfig`，registry 按 payload 解析端点：

- 新增一个**通用 provider 入口**：`runFlow` 接收的 payload 里带 `oauthConfig`（见 §5.3 的 payload 改动），registry 命中通用 id 时按该 `oauthConfig` 驱动 §5.1。
- 具体落地二选一（实现时定，倾向 B）：
  - **A.** `OAUTH_REGISTRY` 增 `generic` 条目，`runFlow` 从闭包/参数取 `oauthConfig`（需把 `saveCredential` 的 `payload` 透传给 `runFlow`，当前 `runFlow(win)` 签名不含 payload —— 要改）。
  - **B.** 在 `saveCredential` 的 oauth 分支**旁路** registry：若 `payload.providerId` 为 `generic:<serverKey>` 且带 `oauthConfig`，直接调 `runGenericOauthFlow(oauthConfig, win)`；否则走原 `OAUTH_REGISTRY`（企查查等不受影响）。**改动面最小，推荐。**

### 5.3 payload 改动（渲染进程 + 主进程同步）

- `SaveCredentialPayload`（`mcpAuthFlows.ts`）与 `SaveCredentialPayloadOAuth`（`mcpAuthModalHelpers.ts`）：
  ```ts
  { kind:'oauth'; providerId: string; oauthConfig?: { authorizeUrl; tokenUrl; clientId; scopes? } }
  ```
- `buildSaveCredentialPayload`（OAuth 分支）改为：
  - 连接器有 `oauthConfig` → `{ kind:'oauth', providerId:'generic:<id>', oauthConfig }`；
  - 连接器是内置企查查 bundle（无 `oauthConfig`、`providerId` 仍 `qichacha`）→ 维持 `{ kind:'oauth', providerId:'qichacha' }`（回归保护）。
  - 无 `oauthConfig` 且非企查查 → 见 §5.4 护栏（返回 `null` 或带 `unsupported` 标记，**不再**默认 qichacha）。
- 渲染侧需把当前编辑/重认证连接器的 `oauthConfig` 传进 `McpAuthModal` → `buildSaveCredentialPayload`。

### 5.4 护栏（安全网，替代「误开企查查」）

当 `authMethod===OAuth` 但**无** `oauthConfig` 且非内置企查查：
- `buildSaveCredentialPayload` 返回 `null`（或不提交），`McpAuthModal` 展示明确文案（i18n，中英文）：
  - zh：`「该连接器的 OAuth 登录方式尚未在管理端配置（缺少授权/令牌地址），暂时无法完成登录。」`
  - en：`「This connector's OAuth login isn't configured yet (missing authorize/token URL) on the admin console. It can't be authorized here yet.」`
- **绝不**静默回落到企查查。

---

## 6. 管理控制台实现

- `ConnectorDrawer.tsx`：
  - `user-oauth` 分支的 `buildAuthConfig` 增写 `cfg.authorizeUrl = s.authorizeUrl.trim()` / `cfg.tokenUrl = s.tokenUrl.trim()`。
  - 表单 state + 编辑态回填（`cfg.authorizeUrl`/`cfg.tokenUrl`）+ `applyDraft`（草稿也回填）+ `reset`。
  - 必填校验：`user-oauth` 下 `authorizeUrl`/`tokenUrl`/`clientId` 为空 → 返回对应 `mcpDrawer.error.authField`（复用既有校验模式）。
  - i18n 新增键（中英文）：`mcpDrawer.auth.authorizeUrl`（授权地址）、`mcpDrawer.auth.tokenUrl`（令牌地址）。
  - UI：与 `tokenUrl`（client-creds 已有）同款的输入框，放 user-oauth 段。
- `enterprise_server/web/src/api/connectors.ts` + SPA 侧类型：`user-oauth` 的 `authConfig` 允许 `authorizeUrl`/`tokenUrl`（后端 schema 若用 `z.object().passthrough()` 或 loose 则无需改；若严格则补两个 `z.string().optional()`）。

> 后端 `user-oauth` 的 `auth_config` 走 `z.record(z.unknown())`（**loose**，`mcpConnectors.ts:38/54/85`），新键 `authorizeUrl`/`tokenUrl` **天然通过**，无需放宽 schema。
>
> **⚠ 但存在两个既有服务端约束，与本方案直接相关（核对 `mcpConnectors.ts`）：**
> 1. **`missingAuthField`（line 158–161）对 `user-oauth` 强制要求 `clientId` + `clientSecret`**。本方案（§5.1）的桌面驱动流程基于**公开客户端 + PKCE（无 secret）**模型 —— secret 不能跨 wire 下发桌面。二者冲突：
>    - 若连接器是**机密客户端**（需 `clientSecret`），桌面**无法**独立完成 code→token 交换（缺 secret）→ 桌面驱动流程不成立，只能走服务端网关（P2）。
>    - 若连接器是**公开客户端**（PKCE，无 secret），桌面可驱动，但**当前服务端会因缺 `clientSecret` 而 400**（`missingAuthField` 拒绝）。
>    - **结论 / 待决策**：需放宽 `user-oauth` 的 `missingAuthField` —— 允许「无 clientSecret 但有 `authorizeUrl`+`tokenUrl`+`clientId`」的**公开客户端**形态（供桌面驱动），同时保留「有 clientSecret」的机密客户端形态（走服务端网关）。见 §12 Q3。
> 2. **`sseOauthCombination`（line 166–167）拒绝 `sse` + `user-oauth`** → 桌面可驱动的 `user-oauth` 连接器**仅 `http` 传输**。桌面侧安装 / 重新认证时应对 `sse` 的 user-oauth 连接器走 §5.4 护栏（不尝试 OAuth）。

### 6.1 服务端 `missingAuthField` 调整（本方案新增）

放宽 `user-oauth` 分支以支持公开客户端形态：

```ts
// mcpConnectors.ts:156 missingAuthField
if (authMode === 'user-oauth' || authMode === 'client-creds') {
  if (!authConfig.clientId) return 'clientId';
  if (authMode === 'user-oauth') {
    // 公开客户端（桌面驱动）：有 authorizeUrl+tokenUrl 即成立，无需 secret。
    // 机密客户端：需 clientSecret（服务端网关用）。
    const isPublicPkce = !!(authConfig.authorizeUrl && authConfig.tokenUrl);
    if (isPublicPkce) return null;
    return authConfig.clientSecret ? null : 'clientSecret';
  }
  return authConfig.clientSecret ? null : 'clientSecret';
}
```

> 此为**既有校验的语义扩展**，会改变 `user-oauth` 的必填规则 —— 触及「测试代码是权威的」约束。实现时若既有测试锁定「user-oauth 必带 clientSecret」，需经确认后再调整（与 Batch A #4 同类的显式签核）。

---

## 7. IdP 兼容前提（集成约束，非代码可解）

桌面驱动流程要求目标 IdP（如纷享销客）：
1. **允许 localhost redirect URI**（或动态注册的公开客户端）；
2. 支持 **PKCE / 公开客户端**（`token_endpoint_auth_method=none`）或提供可用的 `clientId`。

若某 IdP 只支持固定**服务端**回跳（不接受 localhost），桌面流程无法捕获回调 —— 此时应回落到 §5.4 护栏提示（而非报错硬崩）。此前提**无法在客户端代码内解决**，属于每个 IdP 的属性；文档记录之，实现上以「护栏 + 清晰错误」兜底。

---

## 8. 关键约束（沿用全局约束）

- **测试代码是权威的**：不改既有断言语义；仅新增断言，且（如需逐条）经确认。
- **逐文件跑测试**：`enterprise_server` 与 `web` 全量 vitest 会 sandbox EBADF / fd 耗尽 —— 必须 `npx vitest run <file>` 逐文件、fresh process。desktop 主进程测试在沙箱有 `better-sqlite3.node` ABI 不匹配的既有失败（与本改动无关，renderer-only 文件不触发）。
- **typecheck 基线**：`enterprise_server` / `web` `tsc --noEmit` 0 错误；desktop `electron-tsconfig` 0 错误；desktop renderer 仅既有 `bakeArtifactSharePage.ts(382,21)`。
- **i18n 中英文成对**，无未引用键。
- **secret 处理**：`clientSecret` 加密存、不出 wire；公开视图只发非机密 OAuth 字段。
- **跨组织隔离**：公开视图本就按 scope + org 过滤，本改动不触碰。
- **自动提交仅本地**，不 push（除非明确要求）。
- 不新增 `PermissionPoint`（复用 `mcp:*`）。

---

## 9. 测试策略（逐文件）

- **后端**（`enterprise_server/tests/routes/mcpMarketplace.test.ts` 或新增）：
  - `user-oauth` + 端点齐全 → 公开视图含 `oauth{authorizeUrl,tokenUrl,clientId,scopes}`，**不含** `clientSecret` / `__enc__*`。
  - `user-oauth` 端点不全 → `oauth` 为 `undefined`。
  - 非 `user-oauth`（如 `client-creds`）→ 无 `oauth` 字段。
  - 跨组织隔离回归（外 org 404）。
- **SPA / 类型**：`web` `tsc` 干净；`ConnectorDrawer` 组件（如有现有组件测试）补 `user-oauth` 端点回填 + 必填校验断言。
- **桌面**（renderer + 主进程）：
  - `mcpAuthModalHelpers.test`（如有）：`buildSaveCredentialPayload` 对「有 oauthConfig」→ `generic:<id>` + `oauthConfig`；「无 oauthConfig 非企查查」→ 不回落 qichacha。
  - `mcpAuthFlows`（主进程）：oauth 分支对 `generic` provider 调 `runGenericOauthFlow`；`clientSecret` 不出现在公开视图（已在后端覆盖）。
  - `mapPublicConnector`（`connectorView`）：oauth 白名单挑选逻辑的单元断言。
  - **注意**：主进程测试受 better-sqlite3 ABI 限制 —— 纯函数（payload 构造、白名单挑选、URL 拼装）尽量抽成无 store 依赖的可测函数，规避该限制。

---

## 10. 分期 / 里程碑

- **M0 — 护栏先行（低风险，可独立交付）**：§5.4 护栏 + 显示标签（标签已在 `4b077df` 完成）。效果：纷享销客不再误开企查查，改为明确「未配置」提示。**不碰安全边界，可先合。**
- **M1 — 数据链路**：§4（管理端字段 + 公开视图 `oauth` 白名单下发 + 桌面类型/持久化）。
- **M2 — 通用 OAuth 驱动**：§5.1–5.3（`genericOauthFlow` + registry 旁路 + payload 改造）。
- **M3 — 端到端验证**：用一个真实（或 mock）IdP 跑通纷享销客式连接器的 localhost PKCE 登录。

> 建议按 M0 → M1 → M2 顺序实现，每里程碑一次可独立验证 + 逐文件测试 + typecheck 门禁。

---

## 11. 风险与回退

| 风险 | 缓解 |
|---|---|
| 向桌面下发 OAuth 配置触及安全边界 | 白名单只取非机密字段；`clientSecret`/`__enc__*` 显式剥离；公开视图本就 org+scope 过滤。 |
| 目标 IdP 不支持 localhost / PKCE | §7 前提 + §5.4 护栏兜底（清晰错误，不崩）。 |
| `runFlow(win)` 签名不含 payload，需改主进程 oauth 分支 | 选 §5.2 B（旁路 registry，改动面最小）；企查查路径不动。 |
| 后端 schema 严格导致 `authorizeUrl`/`tokenUrl` 被拒 | 实现时核对 `authConfig` 子校验，必要时放宽。 |
| 主进程测试 ABI 失败干扰 | 关键逻辑抽为无 store 纯函数，逐文件跑可测部分。 |

---

## 12. 待确认 / 开放问题

1. **`providerId` 取值**：通用连接器建议 `generic:<serverKey>`（区分不同连接器的 token，避免复用同一 sub-key）。是否接受？（影响 `McpOAuthCredential.providerId` 的取值，纯标识，不影响落盘逻辑。）
2. **是否保留 `callbackUrl` 字段**：桌面用 localhost 回跳，管理端的 `callbackUrl`（服务端固定回跳）对桌面登录**无用**；是否从 user-oauth 表单移除 / 保留为服务端用途？（倾向：保留但不用于桌面；或明确标注「服务端网关用」。）
3. **公开客户端 vs 机密客户端（关键，§6.1）**：桌面驱动流程要求**公开客户端 + PKCE（无 secret）**。现有 `user-oauth` 强制 `clientSecret`。需确认：纷享销客的 OAuth 是否允许**公开客户端 + PKCE + localhost 回跳**？
   - 若**是** → 放宽 `missingAuthField`（§6.1），桌面可驱动。
   - 若**否**（只支持机密客户端 + 固定服务端回跳）→ 桌面无法独立完成登录，纷享销客只能走**服务端网关代理**（P2，本方案不做）；此时桌面端对该连接器走 §5.4 护栏提示。
4. **SSE 排除**（§6）：`sseOauthCombination` 已禁 `sse`+`user-oauth`，桌面驱动的 user-oauth 连接器**仅 `http`**；桌面安装/重新认证对 `sse` user-oauth 走护栏，不尝试 OAuth。
