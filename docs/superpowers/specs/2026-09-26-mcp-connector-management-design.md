# MCP 连接器管理 — 重构设计（GenWork 工作台）

**Date:** 2026-09-26
**Owner:** paul
**Status:** Draft (brainstorm → written spec)
**Prototype:** `mcp-admin-prototype/MCP连接器管理原型.html`
**PRD:** `outputs/MCP连接器管理-产品需求文档PRD.md`（以原型图与 PRD 为根本）

---

## 1. Goal

按原型图与 PRD **重构** GenWork 的 MCP 管理功能：以原型/PRD 为根本，**增加**当前 MCP 管理缺失的能力（两级授权、审核流、6 种鉴权、草稿-发布、版本/回滚、工具粒度、测试连接、部门+成员授权范围），**删除**原型图中不存在的能力（基于角色的授权、stdio 传输、legacy 市场字段）。范围**全链路端到端**：企业管理控制台 + 后端 + 桌面消费侧。

### 1.1 明确删除 / 不做的功能（用户确认）

- **调用指标**（近 30 天调用量 / 错误率 / 错误率高标签）— **不做**。
- **调用审计日志抽屉面板**（卡片 ⋯ 菜单「查看审计」，成员按工具调用留痕）— **不做**。
  - 卡片底部元信息行因此**只保留版本号**。
  - 卡片 ⋯ 菜单因此只剩：**编辑配置 / 停用·启用 / 删除连接器**（无「查看审计」）。
- **MCP 调用遥测 / call-log 表 / 桌面→服务端调用上报** — 不做（随上两项一并移除）。

> **保留**：管理员**写操作审计**（创建/编辑/发布/停启用/删除/审核，走既有 `auditStore` / `audit_events` 表，`{before, after}` diff 约定）。这是 PRD §2「管理员操作留痕」，与「成员调用日志」是两回事，**不在删除范围内**，且不作为每连接器的调用日志抽屉呈现。

### 1.2 非目标（本期不做，PRD §1.3 一致）

- MCP 服务端本身的开发与托管。
- stdio 本地传输（**企业连接器**仅 HTTP 类：`http` / `sse`）。桌面**本地** stdio MCP 属另一子系统，不动。
- 按连接器计费 / 配额。
- 智能体与连接器的绑定编排（归智能体管理模块）。
- P2（文档化、延后）：出站白名单联动、连续失败自动「连接异常」标记、OAuth scope 自动 discovery、错误率阈值租户级配置、**服务端 MCP 网关**（3 种组织凭据模式的桌面调用）。

---

## 2. 范围与分层（用户已确认）

| 层 | 内容 |
|---|---|
| **管理控制台**（`enterprise_server/web`） | `MCPManagePage` + `mcpManage/` 重写为原型：双 Tab（企业连接器 / 连接器审核）、全局设置卡、分类面板、卡片网格、创建/编辑抽屉（草稿-发布两段式）、部门+成员授权范围、审核表+详情抽屉、删除影响弹窗。 |
| **后端**（`enterprise_server/src`） | 新连接器路由（CRUD / 停启用 / 删除 / 分类 / 审核通过·驳回·撤回 / 全局开关）、新数据模型、真实 MCP 握手（P1）、基于 scope 的公开路由、写操作审计。 |
| **桌面消费侧**（repo root） | 企业市场 **scope 可见性**（公开路由过滤从角色→scope）；**成员提交申请入口**（受全局开关控制，P1）；**待配置引导**复用既有 per-user 鉴权（`needs-auth`）。内置市场 / 已安装 / 本地 stdio / per-user 凭据流**不动**。 |

### 分期

- **P0 — 数据模型 + 管理核心**：连接器表 + 提交表 + 分类；6 模式 `auth_config`（secret 加密）；`scope{allCompany,deptIds,userIds}`；管理端 CRUD + 停启用 + 删除 + 分类 + 审核流 + 全局开关；**scope 化**桌面可见性；写操作审计。*（无真实握手；测试连接为轻量探测；卡片无指标。）*
- **P1 — 真实性**：真实 MCP `initialize`+`tools/list` 握手（`enterprise_server` 引入 `@modelcontextprotocol/sdk`）；工具自动发现 + 按工具开关 + 服务端同步（新增默认启用 / 已移除置灰）；版本历史 + 回滚；草稿-发布两段式；桌面成员提交申请入口。
- **P2（延后、文档化）**：见 §1.2。

---

## 3. 数据模型（Approach A：新建连接器子系统，退役基于角色的市场表）

> 组织根 = `org`（**无 root 部门行**；「全公司」= 勾选 `scope.allCompany`）。部门树已存在：`departments`（`parent_id` + 物化 `path`），成员经 `users.department_id`（主）+ `user_departments`（主+并发）。`scopeApi.deptIdsFor(orgId, userId)` 已存在，直接复用。

### 3.1 `mcp_connectors`（核心表，P0）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `org_id` | TEXT NOT NULL | 公司根 |
| `server_key` | TEXT NOT NULL | org 内唯一，`[a-z0-9-]` |
| `name_en` / `name_zh` | TEXT | 可空；卡片优先中文，回退 key |
| `version` | TEXT NOT NULL | 默认 `1.0.0`，semver |
| `category_id` | TEXT | 可空 → 自定义/uncategorized |
| `description` | TEXT | ≤200 |
| `connector_type` | TEXT NOT NULL | `'mcp'`（新）\| `'app'`（继承，V1 不播种） |
| `url` | TEXT NOT NULL | 服务地址 |
| `transport` | TEXT NOT NULL | `'http'`（默认）\| `'sse'` |
| `auth_mode` | TEXT NOT NULL | `none`\|`shared-key`\|`user-key`\|`user-oauth`\|`client-creds`\|`sso` |
| `auth_config` | JSONB | 按模式结构化；**secret 字段内联加密**（vault crypto），非 secret 明文（clientId / tokenUrl / scopes / callbackUrl / ssoApp） |
| `secret_meta` | JSONB | `{ lastUpdatedAt, lastUpdatedBy }` |
| `auth_status` | TEXT | `'configured'`\|`'pending'`（已配置/待配置） |
| `enabled` | BOOLEAN NOT NULL | 默认 true |
| `scope` | JSONB | `{ allCompany: bool, deptIds: string[], userIds: string[] }`；`allCompany`=全公司；否则 部门子树 ∪ 成员例外 |
| `tools` | JSONB | `[{name, desc, enabled, syncedAt, removed}]`（P1 握手同步） |
| `draft` | JSONB \| null | 未发布工作副本 |
| `last_test_at` / `last_test_status` / `last_latency_ms` | — | 测试连接结果（**无指标**） |
| `created_by` / `created_at` / `updated_at` | — | |

`UNIQUE(org_id, server_key)`。

### 3.2 `mcp_connector_versions`（P1）

`connector_id` FK, `version`, `date`, `note`, `current` bool, `config` JSONB（可编辑字段全量快照，供回滚）, `created_by`, `created_at`。

### 3.3 `mcp_connector_submissions`（P0，审核队列）

`org_id`, `name`, `desc`, `author_id`, `version`, `submitted_at`, `status`(`pending|approved|rejected|withdrawn`), `reject_reason`, `cfg` JSONB（完整提交配置）, `approved_connector_id`。

### 3.4 `mcp_connector_categories`（P0）

`org_id`, `name`, `created_at`, `UNIQUE(org_id, name)`，上限 20/org。「全部」为 UI 概念。预置 4 类（搜索 / 数据 API / CRM / 销售 / 自定义）**按 org 惰性播种**（首次访问时；migration 无法按 org 播种，参照 builtin-provider 播种模式）。

### 3.5 全局开关（P0）

`orgs.members_can_submit_connectors BOOLEAN NOT NULL DEFAULT false`。

### 3.6 退役 / 迁移（migration 035）

- 建 4 张新表 + `orgs` 新列。
- 尽力把既有 `mcp_marketplace_servers` 中**有 `server_url`** 的行迁移为 `mcp_connectors`（`connector_type='mcp'`，`scope={allCompany:true}`，`auth_mode` 映射：bearer/api-key→`shared-key`，oauth→`user-oauth`）。
- stdio / legacy（无 URL 落点）行**留在旧表、不再服务**（不删除——非破坏性）。
- 旧 `mcp_marketplace_*` 路由从路由表移除（公开路由改读连接器）。
- 旧 `mcp_marketplace_*` 表 **V1 不物理删除**。

---

## 4. 后端路由（复用既有 `mcp:*` 权限点，**不新增权限点**）

| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /admin/mcp-connectors` | `mcp:view` | 列表 + scope 摘要、工具数、有无草稿、版本 |
| `POST /admin/mcp-connectors` | `mcp:create` | 创建并发布；校验 key（唯一+格式）、url、按模式必填、scope；写审计 |
| `GET /admin/mcp-connectors/:id` | `mcp:view` | 详情；secret 掩码；tools、versions、draft |
| `POST /:id/save-draft` | `mcp:edit` | 存 `draft`（不影响线上） |
| `POST /:id/publish` | `mcp:edit` | 应用草稿→即时生效；版本变化写 versions 行；应用 `tools[].enabled`；**破坏性切换 auth_mode** → 提示（客户端确认；V1 服务端不知 per-user 授权数，故只要已发布连接器切换 `auth_mode` 即通用提示） |
| `PATCH /:id` | `mcp:edit` | 白名单含 `enabled`（停启用即时写回） |
| `DELETE /:id` | `mcp:delete` | 硬删除（无回收站）；返回影响（scope 摘要；依赖清单尽力而为，V1 无绑定） |
| `POST /:id/test` | `mcp:edit` | P0=轻量 `fetch` 探测；P1=真实 `initialize`+`tools/list`，随后合并 tools（新增→enabled，移除→grayed） |
| `POST /:id/rollback` | `mcp:edit` | `{ version }` → 应用快照 + 回滚记录 |
| `GET/POST/PUT/DELETE /categories…` | view/edit | 名称唯一 + ≤20；删除→移入自定义 |
| `GET/PATCH /settings` | view/edit | `members_can_submit_connectors` |
| `GET /submissions` | `mcp:view` | 按状态过滤、各状态计数 |
| `POST /submissions` | **成员**（非管理权限点） | 受 org 开关控制；提交人=成员 |
| `POST /submissions/:id/approve` | `mcp:edit` | 以 `cfg` 建连接器；server_key 冲突→追加 `-2` |
| `POST /submissions/:id/reject` | `mcp:edit` | 强制 `reject_reason` |
| `POST /submissions/:id/withdraw` | 成员（作者） | |
| `GET /api/mcp-marketplace`（公开，改指向连接器） | 成员 | 读 `mcp_connectors`，**scope 化可见性**（替换 `routes/mcpMarketplace.ts:31-33` 的角色过滤） |

### Scope 可见性规则（公开路由）

连接器可见 ⟺ `enabled` AND（`scope.allCompany` **或** 用户拥有任一授予 `scope.deptIds` 的**子树**部门（用 `departments.path` 前缀，授予销售部含华东/华南销售）**或** 用户 ∈ `scope.userIds`）。用 `scopeApi.deptIdsFor(orgId, userId)`（已存在）。

### 审计

写操作（创建/发布/停启用/删除/审核）调 `auditStore.write({ orgId, userId, action, targetType:'connector', targetId, payload:{before,after} })`。`AuditAction` 常量新增 `McpConnectorCreate/Update/Delete/Enable/Disable/Publish/Approve/Reject` 等（`enterpriseServerConstants.ts`）。

---

## 5. 管理控制台 UI（`enterprise_server/web`）

### 组件地图

现有 `MCPManagePage` + `mcpManage/` 7 子组件**重写**。现有 `McpCardGrid`/`CreateMcpForm`/`DetailDrawer`/`RoleChips` **替换**而非扩展（交互模型从「单一创建表单+编辑抽屉」→「双 Tab 视图 + 统一创建/编辑抽屉（草稿-发布两段式）」）。

**`web/src/pages/MCPManagePage.tsx`（重写）** — 拥有两个**视图 Tab**（企业连接器 / 连接器审核，含待审核计数）、**全局设置卡**，渲染 `OrgConnectorsView` 或 `ReviewView`。

**企业连接器视图**
- `ConnectorCategoryPanel.tsx`（替换 `CategorySidebar`）— 搜索框（本地过滤分类名）、分类列表含实时计数徽标、`+ 新增分类`。
- `AddCategoryModal.tsx`（保留+扩展）— 名称输入；重名拒绝；上限 20（超限置灰 + toast）。
- `ConnectorCardGrid.tsx`（替换 `McpCardGrid`）— **类型筛选 chips**（全部 / MCP 连接器 / 应用连接器）+ 2 列卡片网格 + 「添加连接器」。
  - **类型说明**：本期创建入口只产生 `connector_type='mcp'`；迁移（§3.6）也只把既有行标为 `mcp`。**不播种任何「应用连接器」假数据** —— 「应用连接器」chip 在 V1 恒为 0 匹配（类型由存量数据继承，PRD §4.2.2），UI 保留该筛选但无命中。
- `ConnectorCard.tsx`（新，抽出）— 图标+名称+状态点/标签+等宽 Server Key、描述、**标签行**（类型 / 鉴权方式 / `N 个工具` / 有草稿 / 待配置授权 / scope 摘要 `未授权`·`全公司`·`N 个部门(+M 人)`）、**元信息行=仅版本号**（指标已删）、状态**开关**（右上，stopPropagation，即时写回+停用 toast「员工端立即不可见」）、**⋯ 菜单**（右上）。
- `ConnectorCardMenu.tsx`（新）— 编辑配置 / 停用·启用 / 删除连接器（红）。（无「查看审计」。）

**创建/编辑抽屉** — 一个共享表单，`ConnectorDrawer.tsx` 拥有 mode + 表单状态 + 草稿/发布/破坏性确认逻辑。自上而下分段，各为独立组件：
- `ConnectorBasicInfo.tsx` — Server Key*、**URL* + 测试连接按钮**（结果内联：成功编辑态 P1 后显示「发现 N 个工具」；失败显示原因）、展示名 EN / 展示名 ZH、版本、分类（取分类面板集合下拉）、描述（≤200）。
- `ConnectorConnConfig.tsx` — 传输协议（`http` 默认 / `sse`），**联动**：选 `sse` 时 `user-oauth`/`client-creds`/`sso` 置灰，若当前选中则回落 `none` 并刷新提示；授权方式（6 选 1）+ 提示行；**按模式动态子块** `ConnectorAuthFields.tsx`：
  - `none` → 仅警告提示
  - `shared-key` → 组织 API Key（password）+ secret-meta 行
  - `user-key` → 说明卡（管理员不填 Key；员工首次桌面端自填，按人加密）
  - `user-oauth` → 只读回调地址+复制、Client ID、Client Secret（password + secret-meta）、**scope 多选**（按 IdP 分组的预置 + 自定义输入 + chips）
  - `client-creds` → Token URL、Client ID、Client Secret
  - `sso` → SSO 应用下拉（OIDC/飞书/钉钉/企业微信）
  - 超时时间（5–300，默认 30）/ 重试次数（0–5，默认 2）
  - **URL 校验**（输入变化 + 鉴权切换时）：内网/保留地址警告（→ 出站白名单）、非 HTTPS 且有凭据的警告、否则绿色「地址校验通过」。前端本地。
- `ConnectorToolPermissions.tsx` — **创建态**=说明块（首次成功连接后自动发现）；**编辑态**（P1）=每工具一行（等宽名+描述+启用开关；`removed` 置灰「服务端已移除」）。
- `ConnectorScopeSelector.tsx`（替换 `RoleChips`）— 部门+成员授权范围编辑器：触发器显示选择摘要，弹层含**部门树**（多选；勾「总公司」=全公司→禁用子部门复选 + 清空成员例外）与**成员例外**选择器（选成员+添加）。已选项渲染 chips（部门=蓝，成员=紫 👤，× 移除）。空=暂不授权任何人。
- `ConnectorVersionHistory.tsx`（P1）— 版本行（版本+当前版本标签+日期+说明），非当前版本「回滚到此版本」按钮→确认弹窗。
- **底部操作栏**：创建 = `取消` / `创建并发布`；编辑 = `删除`（左，红）｜`取消` · `存草稿` · `发布`。
- **草稿横幅**（编辑态、存在 draft 时）：橙色「存在未发布的草稿…」

**审核视图**
- `ConnectorReviewPanel.tsx`（新）— 状态筛选 chips（待审核 / 已通过 / 已驳回 / 已撤回 / 全部，各带计数）；表格：名称 / 描述（已驳回行内展示原因）/ 作者（姓名+部门）/ 版本 / 提交时间 / 状态标签 / 操作（待审核→通过·驳回；其余→详情）。
- `ReviewDetailDrawer.tsx`（新）— 状态标签、提交人、提交时间、描述、**提交的完整配置**（url / 鉴权方式 / 授权范围 / 工具清单）；待审核底部 = 取消 / 驳回 / 通过并发布。
- `RejectReasonModal.tsx`（新）— 强制驳回意见（空则阻断 + toast「请填写驳回意见」）。

**共享弹窗**
- `DeleteConnectorModal.tsx`（新）— 影响清单（授权对象 / 依赖将失效——尽力而为，V1 无绑定 / 历史日志 90 天 / OAuth 与 Secret 立即吊销）+ 确认删除。（30d 调用行随指标删除。）
- `RollbackModal.tsx`（P1）— 回滚确认。

### 横切

- **API client**：新 `web/src/api/connectors.ts`（替换 `mcpMarketplace.ts`）— 连接器 CRUD/停启用/删除/详情/存草稿/发布/回滚/测试、分类 CRUD、settings get/patch、submissions list/submit/approve/reject/withdraw、`listDeptTree()` + `listMembers()`（复用 `GET /admin/departments` + `GET /admin/users`）。线形对齐后端视图。
- **数据获取**：TanStack Query keys — `['connector','list'|'detail'|'versions']`、`['connector','categories']`、`['connector','submissions']`、`['org','depts']`、`['org','members']`、`['connector','settings']`。
- **路由 + 导航**：不变 — `Route path="/config/mcp-manage"` 与侧栏 `nav.mcpManage` 指向重写后的页面。
- **i18n**：新增 `mcp.*` keys，**en + zh 双语齐全**（鉴权模式标签/提示、scope、草稿/发布、审核、删除影响、URL 警告）。任何 key 不得缺于任一侧。
- **Secret 处理**：secret 字段用 password 输入；编辑态 placeholder=掩码值；**留空=保持不变**（服务端仅在收到新非空值时重新加密）。

---

## 6. 桌面消费侧改动（repo root）

对**既有企业市场 Tab 增量**；内置市场、已安装、本地 stdio、per-user 凭据流**不动**。

**1. Scope 可见性（P0）— 唯一的服务端契约变更。**
- `GET /api/mcp-marketplace`（改指向连接器）现返回 scope 可见连接器（而非角色可见）。桌面**自身不做过滤**（历来如此，过滤在服务端），故对 renderer 几乎无感：`enterpriseClient.listEnterpriseMcps()` 与 `fetchEnterpriseMarketplace()` 保持形态。
- **线形变更**：行增 `serverKey`、`nameZh`(=`name_zh`)、`version`、`connectorType`、`authMode`(6 模式)、`authStatus`、`scopeSummary`(仅展示)、`hasDraft`；删 `allowedRoles` 与 legacy stdio 字段（`command`/`defaultArgs`/`requiredEnvKeys`/`kind`）。桌面 `McpEnterpriseMarketServer` 类型对齐新服务端视图（关闭 09-13 spec 标记的线形漂移）。
- **连接时的鉴权路由**：桌面 `handleConnectEnterpriseServer` 当前安装时把 `authMethod` 重置为 `none`。改为**预填连接器的 `authMode`** 到本地安装，触发正确 per-user 流：`user-key`→填 key、`user-oauth`→OAuth 浏览器流、`none`→直接连、3 种组织凭据模式→装为 **needs-auth + 「待配置」说明**（网关延后至 P2）。既有 `needs-auth` 橙点 + Connect 弹窗已承载待配置引导，复用之。

**2. 成员提交申请入口（P1）。**
- 当 `members_can_submit_connectors` 开启（经 `/me` 或小型 settings GET 获取）且用户为成员（非管理员）时，企业市场 Tab 显示 **「申请连接器」**（右上，仿「添加连接器」但面向成员）。打开提交表单（创建表单子集：key、url、名称、版本、分类、描述、authMode、scope、工具清单）→ `POST /submissions`。
- 端到端门控：服务端开关关闭时拒绝提交；桌面开关关闭时隐藏入口。

**3. 明确不动（显式，便于界定影响面）：**
- 内置市场（静态 JSON 目录）、已安装 Tab、本地 stdio MCP、`mcpStore`/`mcpAuthFlows`/`mcpAuthProbe`/`oauthBrowserFlow`、`openclawConfigSync`。
- 桌面**运行时**（OpenClaw）不变——仍从 `openclaw.json` 读 `mcp.servers`。

---

## 7. 状态机（PRD §4.8）

```
连接器：创建/审核通过 → [待配置]（auth_mode ≠ none）→ [已配置]
        已配置 ⇄ 启用 ⇄ 停用（保留配置，员工端不可见）
        任意 → 删除（终态，不可恢复）
授权配置（user-oauth）：未配置 → 已配置（管理员填入 ID/Secret）
        scope / tools.enabled 变更均随「发布」原子生效
        auth_mode 切换 = 破坏性变更 → 发布时确认弹窗
```

---

## 8. 关键约束（沿用全局约束）

- Conventional commits，小写 subject，**仅本地提交，不推远端**（除非显式要求）。
- Secret：写入加密、任何接口不回显明文；编辑留空=保持；`credentialMasked` 仅展示。
- 跨 org 隔离：外 org 连接器 → 404，绝不改写/泄露。
- 内网/保留地址、SSE+OAuth 组合：前端置灰/警告，后端二次校验拒绝。
- `transport`（http/sse）只影响测试连接/握手的传输方式与鉴权可用集，不影响桌面运行时。
- i18n：所有新增/改动字符串 en + zh 齐全。
- V1 不新增 PermissionPoint（复用 `mcp:*`）。
- 测试**逐文件**运行（server + web 全套命中沙箱 EBADF/fd 上限）；测试代码为权威，改动断言前先向用户说明。
- 不触碰 dev `gwork` Postgres（`:5432`）；仅 throwaway/进程内 DB。

---

## 9. 测试策略（逐文件）

**后端**（pglite harness，仿 `tests/routes/*.test.ts`）— 新 `tests/routes/mcpConnectors.test.ts`：
- 权限：`mcp:view`-only 得 200 列表（掩码-only 线形，断言**无 secret/明文**泄漏，仿 `providerKeysGating.test.ts` key-set 断言）；无权限 403；写操作需 `mcp:edit`/`mcp:create`/`mcp:delete`。
- 创建/发布：key 格式 + org 唯一（冲突→409）、url 必填、按模式必填（`user-oauth` 需 clientId+secret）、scope 校验、SSE+OAuth 组合拒绝、secret 仅新值时重加密。
- Scope 可见性（公开路由）：dept X 成员 sees `scope.deptIds` 覆盖 X **子树**的连接器（授予销售部→华东销售成员可见）、成员例外可见、`allCompany` 可见、不匹配成员**不可见**；`enabled=false` 永不出现。
- 审核流：提交（开关门控，关→403/400）、通过建连接器（key 冲突→`-2`）、驳回需意见、作者撤回。
- 跨 org 隔离：外 org → 404，绝不改写/泄露。
- 审计：写操作产出 `audit_events` 行（`{before,after}`）。
- 握手（P1）：mock `initialize`/`tools/list`，工具同步新增→enabled / 移除→grayed；测试连接持久化 `last_test_*`。
- 既有 `mcpMarketplace.test.ts`（若有）随改指向路由更新/移除。

**管理 SPA**（vitest + testing-library，仿 `web/tests/pages/mcpManage/*.test.tsx`）：分类面板过滤/新增/上限、卡片标签+开关 stopPropagation+菜单、连接配置 6 模式动态块+SSE 联动+URL 校验、scope 选择器（总公司清成员+禁子）、审核计数+驳回强制意见、删除影响弹窗。既有 `mcpManage` 测试随组件替换而**替换**。

**桌面**（vitest，仿既有 renderer 测试）：`fetchEnterpriseMarketplace` 映射新线形；待配置按 authMode 路由；提交入口受开关门控。

---

## 10. 遗留问题（PRD §10，本期决策）

1. 连接器复制：不做（YAGNI）。
2. 定时停用：不做。
3. 审核通过后默认停用再二次启用：**否** — 审核通过即按提交配置创建并按其 `enabled`（默认启用）呈现。
4. 错误率阈值租户级：随指标删除，不适用。
