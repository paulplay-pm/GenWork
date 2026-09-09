# 技能管理重构 — 部门+成员授权 / 审核流 / 桌面消费（GenWork 工作台）实现设计

> **For agentic workers:** This is the DESIGN SPEC (the authority). The implementation plan argues from it.
> 范围：企业服务端 + 管理端 SPA + 桌面端，一次交付（全部功能）。

---

## 0. 一句话

把现有「技能市场」从 **角色可见（allowed_roles）+ 无 scope + 无审核** 的形态，重构为 **org 作用域 + 部门/成员 scope 授权 + 成员提交审核流 + zip 元数据/sha256 + 桌面消费** 的形态，与刚上线的 MCP 连接器（migration 035）同一套模式。服务端/管理端/桌面端一次交付。

## 1. 背景与现状（已核对源码）

现状（重构基线，已逐文件核对）：

- **DB** `enterprise_server/src/db/migrations/023_skill_marketplace.sql`：
  - `skill_marketplace_categories`（`category_id` PK，`name_zh/en`，`display_order`；`uncategorized` 保留桶）。**无 `org_id`**。
  - `skill_marketplace_skills`（`skill_id` PK，`name_en/zh`，`description_en/zh`，`icon`，`version`，`category_id` FK，`source_json`，`allowed_roles JSONB`（默认 `["org_admin"]`），`enabled`，时间戳）。**无 `org_id`、无 `scope`、无 zip 文件名/大小/摘要、无 `use_count_30d`、无 `created_by/updated_by`**。
- **模型** `src/models/skillMarketplaceView.ts`：`SKILL_COLUMNS` 单源列串 + `mapSkill`（对比 `connectorView.ts` 还持有纯函数 `scopeMatches`/`scopeSummary`——技能侧尚无）。
- **路由**：
  - 公开/桌面 `src/routes/skillMarketplace.ts`：`GET /api/skill-marketplace`（`enabled=TRUE` + JS 侧 `superadmin || allowed_roles∩caller` 过滤，**未按 org/scope**）、`GET …/download/:id`（`enabled`+`allowed_roles` 复检后流式返回 `skillStoreDir(id)/skill.zip` 原始字节，**无摘要/签名/断点**）。
  - 管理 `src/routes/skillMarketplaceAdmin.ts`：`POST skills`（**body 直接给 `skill_id`+`allowed_roles`**，无 zip 解析）、`PUT`、`DELETE`、`GET`（全量，无 org/scope 过滤）、`POST …/skills/:id/zip`（原始 zip ≤50MB，AdmZip 校验存在 SKILL.md，写 `skillStoreDir(id)/skill.zip`）、分类 CRUD（删除重归 未分类）。**无 `auditStore.write`**。
  - **无** 成员提交/审核路由（MCP 侧 `mcpSubmissions.ts` 已有模板）。
- **存储** `src/lib/stateDir.ts`：`$ENTERPRISE_STATE_DIR/skill-marketplace/<skillId>/skill.zip`。
- **权限** `src/shared/permissionPoints.ts`：`SkillView/Create/Edit/Toggle`（`skill:*`），授予 `policy_admin`（成员得 `SkillView`）。复用，不新增。
- **管理端 SPA** `enterprise_server/web/src/pages/SkillManagePage.tsx` + `pages/skillManage/`（`CategorySidebar`/`SkillCardGrid`/`CreateSkillForm`/`DetailDrawer`/`AddCategoryModal`/`types`，~500 行）：**卡片网格 + 角色 chips 单选视图**。无 tabs、无 7 列表格、无 scope 选择器、无审核队列、无设置卡。路由 `/config/skill`，侧栏 `nav.skill`（`requires:'policy_admin'`）。i18n 键 `skillmgmt.*`。
- **桌面端** `src/renderer/components/skills/SkillsManager.tsx`（~2193 行）+ `skillManager.ts`（~3331 行）：企业 Tab（=Marketplace）已有 fetch→download→security-audit→pending-confirm→installed 全链路、upgrade（备份+回滚）、catalog↔local-id 映射、`update_available` 版本比对。**缺**：下载无 sha256 校验、无「已失效/已停用」卡片态、无调用前授权校验门（OpenClaw 从 `extraDirs` 原生读 SKILL.md，桌面唯一抓手是写 `skills.entries[name].enabled=false` 或删除目录）。

**可复用（MCP/scope 侧已有，直接移植）**：
- `scopeMatches`/`scopeSummary`（`connectorView.ts`，纯函数）→ 抽到共享或复制为技能版。
- `scopeApi.deptIdsFor(orgId,userId)` + `descendantsOf(deptIds, deptPath)`（`src/auth/scopeResolver.ts`）。
- `mcpMarketplace.ts` 的 org+scope 可见性查询模式。
- `mcpSubmissions.ts` 审核队列路由模式。
- `ConnectorScopeSelector.tsx`（370 行：部门树 + 根节点=全公司 + 成员搜索 + chips + 清空）。
- `mcpManage/` 的 `ReviewView`/`ReviewDetailDrawer`/`RejectReasonModal`/`reviewShared.ts`。
- `auditStore.write`（`src/audit/auditStore.ts`）。
- 桌面 zip 下载/解包/审计/安装/升级/catalog↔local-id 全套。

**净新增（无对应物）**：zip 顶层目录名解析（服务端，AdmZip 已在用）；**sha256 摘要**（服务端算 + 桌面校验）；**桌面调用前校验门**；两张 UI 形态（7 列表格、审核 Tab，克隆 MCP）。

## 2. 关键决策（已锁定，评审可否决）

| # | 决策 | 选定 | 理由 |
|---|---|---|---|
| D1 | 可见性模型 | **替换 `allowed_roles` 为 `scope{allCompany,deptIds,userIds}`**，与 MCP 同一模型 | PRD 权威；复用 MCP 全部 scope 代码 |
| D2 | 表演进策略 | **原地升级 `skill_marketplace_*`**（加列、复用 `/api/skill-marketplace` 端点），桌面端零重指 | 单一活系统；避免 035 式新表+新路由造成双轨 |
| D3 | 技能身份 | `name` = zip 顶层目录名（归一为 slug，**不可改、org 内唯一**）；`id == name`。创建走**两段式**：`POST …/parse-zip`（返回 `{name,version,size,sha256,tempToken}`）→ 表单只读回填 → `POST …/skills` | PRD 4.4.1；名称来自包而非手填 |
| D4 | 下载完整性 | **sha256 校验**（服务端算摘要、桌面下载后比对）；**保留 Bearer**（不做签名 URL/断点续传） | 安全核心 + 低成本；签名/续传归 P1 |
| D5 | 审核流 | **本期纳入**（管理端审核 Tab + 桌面端成员提交入口 + 全局开关），对齐 MCP `mcpSubmissions` | PRD P1 内容；MCP 有完全对应实现 |
| D6 | 桌面消费范围 | **scope 可见（服务端过滤）+ 安装/更新/卸载 + 调用前校验**；离线缓存/断点续传/下载进度归 P1 | 与 MCP 消费切片同粒度 |
| D7 | 交付 | **全部一次交付**，一个 spec，按里程碑拆任务 | 用户确认 |
| D8 | 组织作用域 | 技能/分类/审核单全部 **org 作用域**（加 `org_id`）；跨 org 隔离（外 org → 404/不可见） | 与 MCP 一致 |

## 3. PRD 开放问题的裁决（本 spec 定死，消除歧义）

| PRD 遗留问题 | 本 spec 裁决 |
|---|---|
| 1. 审核通过时能否改成员提交的授权范围 | **原样带入**，发布后编辑调整（PRD 4.7.5 默认） |
| 2. 技能复制 / 跨分类批量移动 | **不做**（YAGNI） |
| 3. 重新上传旧版本回滚 | **不做**（覆盖不留存，PRD 明确） |
| 4. 成员例外授权理由 | **不做** |
| 5. 停用/删除二次管理员审批 | **不做** |
| 6. 调用时校验失败（网络异常）放行还是拦截 | **默认拦截**（安全优先，PRD §6 默认） |
| 7. 桌面端成员提交入口位置 | **企业 Tab「添加技能」复用**（对齐 MCP `SubmitConnectorForm`），受全局开关 `members_can_submit_skills` 控制（关闭时隐藏） |

## 4. 数据模型（新迁移 `038_org_skills.sql`）

**原地升级**（保留现有表名/端点；幂等 SQL；`ALTER … ADD COLUMN IF NOT EXISTS`）：

```sql
-- 1) 技能：加 org/scope/zip 元数据/统计/操作人；去 allowed_roles
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL
  DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_file_name TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_file_size INTEGER;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_sha256 TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS use_count_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS updated_by TEXT;
DROP TABLE IF EXISTS skill_policies; -- 已在 023 删除，幂等兜底
-- name（== id/skill_id）即身份；description_en 复用为单串描述（中文展示用 name_zh 优先）
CREATE INDEX IF NOT EXISTS skill_marketplace_skills_org_idx ON skill_marketplace_skills(org_id);
CREATE INDEX IF NOT EXISTS skill_marketplace_skills_org_cat_idx ON skill_marketplace_skills(org_id, category_id);
ALTER TABLE skill_marketplace_skills DROP COLUMN IF EXISTS allowed_roles;

-- 2) 分类：org 作用域
ALTER TABLE skill_marketplace_categories ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT '';
-- （uncategorized 保留桶按 org 各建一行；插入时 ON CONFLICT (org_id, category_id) DO NOTHING）

-- 3) 审核单（镜像 mcp_connector_submissions）
CREATE TABLE IF NOT EXISTS skill_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  "desc" TEXT,
  author_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',        -- pending|approved|rejected|withdrawn
  reject_reason TEXT,
  cfg JSONB NOT NULL,                            -- {zip{fileName,fileSize,sha256}, scope{allCompany,deptIds,userIds}}
  approved_skill_id TEXT
);
CREATE INDEX IF NOT EXISTS skill_submissions_org_idx ON skill_submissions(org_id, status);

-- 4) 组织开关
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS members_can_submit_skills BOOLEAN NOT NULL DEFAULT FALSE;

-- 5) best-effort 回填：现存行 → org 作用域 + 全公司（非破坏）
UPDATE skill_marketplace_skills
   SET org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
 WHERE org_id = '';
UPDATE skill_marketplace_categories
   SET org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
 WHERE org_id = '';
-- 为每个 org 确保 uncategorized 桶
-- （INSERT … SELECT distinct org_id … ON CONFLICT (org_id, category_id) DO NOTHING）
```

> **注**：`skill_submissions.cfg.zip` 不内联大字节——存**临时上传句柄/文件名**，zip 实体落 `skill-marketplace/<tmpId>/skill.zip`，审核通过时原子迁入 `<name>/`（同 MCP 提交/发布语义）。`cfg.scope` 为部门/成员 **ID** 集合（原型用名称模拟，实现以 ID 为准）。

### 字段模型（研发参考）

```
Skill {
  id,            // == name，zip 顶层目录归一 slug，不可改，org 内唯一
  nameZh, author, version,
  category,      // category_id，必填
  desc, icon,
  enabled: bool,
  scope: { allCompany, deptIds, userIds },   // 并集生效；allCompany=true ⇒ 全公司
  zip: { fileName, fileSize, sha256 },       // 服务端存储句柄 + 摘要
  useCount30d, updatedAt, createdBy, updatedBy
}
SkillSubmission {
  id, name, desc, version, authorId, submittedAt,
  status, rejectReason,
  cfg: { zip{fileName,fileSize,sha256}, scope{allCompany,deptIds,userIds} }
}
Category { id, orgId, nameZh, nameEn, sortOrder, deletable }
```

**约束**：`id/name` 来自 zip 顶层目录，创建后不可改；org 内唯一（审核通过发布时冲突自动加后缀 `-2`）；`scope` 为部门/成员 ID 集合，保存时校验存在，**已删除对象静默剔除**；zip ≤10MB，下载走 Bearer（无签名）。

> **新技能 vs 迁移行**：`name==id` 规则（顶层目录名）只作用于**新创建/重新上传**的包。已存在的行保留原 `skill_id`（多为 slug）作为 `id`，**不回推 zip 顶层目录名**（历史包未必与 skill_id 同名）；其 `name_zh`/描述沿用现状。
> **描述字段**：API/PRD 为单串 `desc`（≤200 字，非多语言）。DB 保留 `description_en`/`description_zh` 两列；写时 `desc` → `description_zh`（展示优先中文），`description_en` 同步写同一值（向后兼容）。桌面 wire 的 `description` 单串沿用（取 `description_zh`）。

## 5. 接口契约

### 5.1 管理端（`/api/admin/skill-marketplace/*`，org 作用域，复用 permissionPoints `skill:*`，全部写操作 `auditStore.write`）

| 接口 | 说明 |
|---|---|
| `POST /skills/parse-zip` | body=原始 zip ≤10MB。解包读**顶层目录名→name**（归一 slug，须匹配 `^[a-z0-9][a-z0-9._-]*$`，否则 `400 invalid_name`）、SKILL.md frontmatter `version`（默认 1.0.0）、算 `sha256`/`fileName`/`fileSize`，临时落盘。返回 `{ name, version, size, sha256, tempToken }`。重名 → `409 name_conflict`（含已存在技能名）。 |
| `POST /skills` | `{ tempToken, nameZh?, author?, category_id, desc?, icon?, scope }`。name 取 parse 结果。校验 category 存在（org 内）、scope 部门/成员 ID 存在（静默剔除失效项）。插入（`id=name`，`enabled=true`）。返回 `{ skill_id }`。 |
| `PATCH /skills/:id` | `{ nameZh?, author?, desc?, icon?, category_id?, scope?, enabled? }`。name/category 语义同创建；scope 增删；启停即时写回。 |
| `POST /skills/:id/zip` | 重新上传：解包，顶层目录名须 == 现有 `name`（否则 `409 name_mismatch`），覆盖包 + bump `version` + 重算 sha256/size，更新时间。 |
| `DELETE /skills/:id` | 硬删 + `rm` zip 目录。 |
| `GET /skills` | 管理视角，org 全量（含停用），按 `updatedAt` 倒序。 |
| `POST /categories` / `PUT /categories/:id` / `DELETE /categories/:id` | org 作用域；`uncategorized` 不可删（`409`）；删除先校验/重归（沿用 023 的 re-home）。 |
| `GET /submissions?status=` / `POST /submissions/:id/approve` / `…/reject` / `…/withdraw` | 审核队列（§5.3）。 |
| `GET /settings` / `PUT /settings` | `{ members_can_submit_skills }` 组织开关。 |

> 错误码对齐现有 MCP：`invalid_body`/`unknown_category`/`not_found`/`too_large`/`bad_zip`/`name_conflict`/`name_mismatch`/`empty_patch`/`reserved_category`。

### 5.2 桌面/成员视角（`/api/skill-marketplace/*`，`requireAuth`，**服务端 org+scope 过滤**）

| 接口 | 说明 |
|---|---|
| `GET /api/skill-marketplace` | 返回 `enabled=TRUE` **且** scope 命中当前成员（`allCompany` ∨ `userIds∋caller` ∨ caller 部门链∩`descendantsOf(deptIds)`）；superadmin 看全部。出参 skills：`[{ id, name, name_zh, description, category, version, icon, source, zipSize, sha256, updatedAt }]`（**去 `allowed_roles`/`enabled`**，**加 `zipSize`/`sha256`**，其余沿用现有桌面字段名以最小化重接）。`categories: [{id,name_zh,name_en}]`（仅可见技能用到的分类）。按 `updatedAt` 倒序。 |
| `GET /api/skill-marketplace/download/:id` | 复检 enabled+scope（外 org/失效 → 404/403），流式返回 zip（Bearer，无签名、无摘要头——sha256 由列表行下发）。 |
| `POST /api/skill-marketplace/verify` | body `{ name }` → 复检 enabled+scope，返回 `{ allowed: bool }`（桌面 5 分钟缓存）。 |
| `POST /api/skill-marketplace/events` | body `{ name, event }`（install/update/uninstall/invoke）→ 更新 `use_count_30d`（best-effort，不阻塞）。 |
| `POST /api/skill-marketplace/submissions` | 成员提交（受 `orgs.members_can_submit_skills` 控制；关闭 → `403 submission_disabled`）。body `{ desc?, scope, zip(raw) }` → 服务端 parse（顶层目录名→name、version、sha256），插入 `skill_submissions`（`status=pending`）。重名不阻断（发布时才加后缀）。 |

> 可见性判定**全在服务端**：桌面不持有授权规则、不做本地过滤。未授权技能对成员**完全不可见**（无占位/提示，防枚举）。

### 5.3 审核流（管理端 SPA + 桌面端提交）

- 流程：成员提交（桌面，受开关，含包+建议 scope）→ `pending` → 通过（以 `cfg` 建组织技能，带入 scope，重名加后缀，插入列表首位）/ 驳回（**强制意见**，成员可修改后重新提交生成新记录）/ 撤回（成员）。
- 审核通过发布：分类默认 `未分类`，scope 按提交值带入（**不建立与审核单的引用**，发布即独立实体）；toast + 审计说明重名后缀。
- 对齐 MCP：`mcpSubmissions.ts` 路由 + `ReviewView`/`ReviewDetailDrawer`/`RejectReasonModal`/`reviewShared.ts` + 桌面 `SubmitConnectorForm` 模式。

## 6. 管理端 SPA 设计（重建 `SkillManagePage` 为原型形态）

结构（对齐 `技能管理原型.html`）：

```
技能管理
├── 全局设置卡（1 项：个人允许添加技能到组织技能 → members_can_submit_skills 开关，即时生效）
│   （移除原有「公开市场可见性」「个人允许上传」两卡，超范围）
├── Tab：组织技能 {N}  /  技能审核 {N}
│   ├── 左：分类面板（搜索 / 分类+计数 / +新增分类）—— 复用 CategorySidebar
│   └── 右：7 列表格（替代 SkillCardGrid）
│       ├── 工具行：面包屑（技能/{分类}）+「只有被授权部门/成员…共 N 个技能」+ 搜索框
│       ├── 列：技能名称(图标+中文名+key) / 描述(+👥N) / Zip(文件名+大小+下载) /
│       │       授权范围 tag(scopeSummary) / 状态(开关,即时写回) / 更新时间(+v) / 操作(编辑|删除)
│       └── 抽屉：创建 / 编辑（同构）
└── Tab：技能审核
    ├── 状态 chips：待审核/已通过/已驳回/已撤回/全部（带计数）
    ├── 提交列表（已驳回行内展示驳回原因）
    └── 详情抽屉 + 通过并发布 / 驳回(强制意见)
```

组件改动：
- **创建/编辑抽屉**（重建 `CreateSkillForm`/`DetailDrawer`）：技能包（上传→「正在解析技能包…」→ 只读 name + × 移除）→ 基本信息（nameZh/author/version/category/desc/icon）→ **授权范围**（**移植 `ConnectorScopeSelector`**：部门树默认折叠+懒展开、根节点=全公司、部门搜索全树扁平匹配带上级路径、成员搜索 top20、chips 回显+清空）。
- **删除** → 影响清单确认弹窗（授权对象/使用人数/不可恢复/审计保留 90 天）。
- **审核 Tab**：移植 MCP 审核四组件。
- i18n：`skillmgmt.*` 演进 + 新增 `skillmgmt.review.*`/`skillmgmt.scope.*`/`skillmgmt.settings.*`（en+zh 成对，无未引用键）；删除废弃的 role-chip 键。
- 性能：部门树默认仅根级懒展开；部门搜索硬上限 50、成员 20；弹层分区重绘不丢搜索焦点（沿用 `ConnectorScopeSelector` 的既有实现）。

## 7. 桌面端设计（企业 Tab）

**复用现有全链路**（fetch→download→audit→pending→confirm→installed；upgrade 备份+回滚；catalog↔local-id；`update_available` 版本比对）。改动：

- **scope 可见 = 服务端**：fetch 不变，wire 去 `allowed_roles`；列表已按 scope 过滤。（最小：停止读 `allowed_roles`。）
- **sha256 校验（新增）**：`downloadZipUrl` 缓冲后（`skillManager.ts:1306` 处）算 sha256，与列表行 `zip_sha256` 比对；不符 → 删残包 + 「技能包校验失败，请重试」。
- **调用前校验门（新增）**：在 `onSkillsChanged → syncOpenClawConfig('skills-changed')`（main.ts:13026）+ JWT 刷新 sync（3127）+ 周期重拉 `listEnterpriseSkills()`：对已安装 org 技能，若**不在列表或 `enabled=false`** → 写 `skills.entries[name].enabled=false`（`openclawConfigSync.buildSkillEntries`）并置卡片 `已停用/已下线` 态；**本地目录保留**（PRD §3.4 数据不删，仅拦截）。`POST …/verify`（5 分钟缓存）在加载时兜底。**校验失败默认拦截**（D:安全优先）。
- **卡片状态机**：新增第 4 态 `已失效/已停用`（现状仅 not_installed/installed/update_available）；`update_available`（版本更新）沿用。
- **成员提交入口（新增，D7）**：企业 Tab「添加技能」复用 `SubmitConnectorForm` 模式（受 `members_can_submit_skills` 控制，关闭则隐藏），`POST …/submissions`。
- **P1（后续，不在此 spec 实现）**：下载进度%、断点续传、列表离线缓存。

## 8. 安全

- zip 上传：≤10MB + AdmZip 结构校验（存在 SKILL.md、禁路径穿越、禁可执行文件）；下载走 Bearer，仅服务端存储；成员端仅见授权范围内且启用的技能。
- scope：部门/成员 ID 保存时校验存在，失效静默剔除；全公司为原子授权（无交集/排除语义）。
- 未授权不可见（防技能名枚举）；调用时二次校验拦截越权。
- 审计：全部管理写操作（创建/编辑/启停/删除/审核/分类增删）`auditStore.write`；使用事件（install/update/uninstall/invoke）记 `use_count_30d`。
- 跨 org 隔离：列表/下载/校验均按 claims.orgId + scope 判定，外 org 404。

## 9. 非功能

- 性能：列表 P95<500ms（服务端过滤后 ≤100 条）；部门树首屏仅根级懒加载；部门搜索全树扁平 P95<300ms；成员搜索服务端 top20；启停生效 <5s。
- 兼容：技能包规范（顶层目录 + SKILL.md）；版本 semver；macOS/Windows 一致；本地技能目录与「我的」一致。
- 大规模适配：数千部门/数万员工——树默认折叠+懒展开；搜索硬上限（部门 50/成员 20）；弹层分区重绘不丢焦点。

## 10. 测试策略（逐文件，镜像 MCP 基线）

- **服务端**（pglite in-process，逐文件跑）：
  - `connectorView` 同款：`scopeMatches`/`scopeSummary` 纯函数（全公司/部门链/成员例外/并集/外 org 404）。
  - `parse-zip`：顶层目录名→name、版本读取、sha256、重名 409、bad_zip/超限。
  - 公开列表：enabled+scope 过滤（root=全公司/部门命中/成员命中/外 org 不可见）、无 `allowed_roles`、含 `sha256`。
  - 下载/verify：scope+enabled 复检（失效 404/403）。
  - 审核：提交(pending)/通过(建技能+scope 带入+重名后缀+列表首位)/驳回(意见必填)/撤回；审计写入。
  - 组织开关：`members_can_submit_skills` 关 → 提交 `403`。
- **管理端 SPA**：`tsc --noEmit` = 0；i18n en+zh 成对无未引用键；scope 选择器/审核 Tab 行为（如既有组件测试则补断言，否则 typecheck 门禁）。
- **桌面端**（renderer 纯函数优先，规避主进程 ABI）：sha256 比对（纯函数：给定 bytes+期望摘要→通过/失败）；版本比对（已有）；「失权→禁用」判定纯函数。主进程 `skillManager` 测试 CI-gated（`better-sqlite3` ABI 既有失败，与本改动无关）。
- **typecheck 基线**：server `tsc --noEmit` = 0；web `tsc --noEmit` = 0；desktop `electron-tsconfig` = 0；desktop renderer 仅既有 `bakeArtifactSharePage.ts(382,21)`。

## 11. 里程碑（一次交付内分阶段验证）

- **M1 服务端 + 数据**：迁移 038（org/scope/zip 元数据/submissions/org 开关/回填）、模型 `scopeMatches`/`scopeSummary`、`parse-zip`+CRUD+scope+审计、公开列表 org+scope 过滤 + `sha256`、下载/verify/events。
- **M2 管理端 SPA**：设置卡、7 列表格、scope 选择器、创建/编辑抽屉（两段式上传）、删除影响清单、审核 Tab。
- **M3 审核流端到端**：`skill_submissions` 路由 + 管理端审核 UI + 桌面成员提交入口。
- **M4 桌面消费**：scope 可见（wire 去 roles）、sha256 校验、调用前校验门 + 卡片 `已失效` 态。

## 12. 风险与回退

| 风险 | 缓解 |
|---|---|
| 原地升级（去 `allowed_roles`/加 org_id）触及现存数据 | best-effort 回填 org+全公司（035 模式），非破坏；`allowed_roles` 移除前确认无其它读取方 |
| `name==id` 收敛改变现有 `skill_id` 语义 | 现有 `skill_id` 多为 slug，与顶层目录名一致或归一化后等价；回填时保持原 slug 作 id |
| 桌面「失权拦截」误伤（校验端点不可达） | 默认拦截但**本地目录保留**+明确文案；verify 5 分钟缓存 + 失败降级按最近已知状态 |
| 大组织部门树性能 | 懒展开 + 搜索硬上限 + 分区重绘（沿用 ConnectorScopeSelector） |
| zip sha256 与下载传输不一致（时钟/中间件） | 摘要为服务端对落盘字节的计算，与传输无关；传输损坏 → 比对失败重试 |

## 13. 明确不做（本 spec 边界外）

- 技能包内容解析/执行/运行时沙箱（归技能运行时模块）；技能市场/公开市场（已移除）；计费配额；技能-智能体绑定编排；版本历史/回滚；**签名 URL / 断点续传 / 离线缓存**（P1）；跨分类批量移动/复制；双管理员审批；成员例外授权理由。
