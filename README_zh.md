<h1 align="center">
  <img src="public/genwork.png" alt="GenWork" width="96"><br>
  GenWork
</h1>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <strong>全场景企业级智能体（Enterprise Agent）平台</strong><br/>
  桌面端 Agent 协同 + 企业服务端管控 + 统一管理控制台
</p>

---

## 目录

- [GenWork 是什么](#genwork-是什么)
- [核心能力](#核心能力)
- [整体架构](#整体架构)
- [企业端安装部署](#企业端安装部署)
  - [A. 生产环境部署（客户自管 Linux 主机）](#a-生产环境部署客户自管-linux-主机)
- [用户端安装部署](#用户端安装部署)
- [开发指南](#开发指南)
  - [4. 企业服务端开发与打包（Docker）](#4-企业服务端开发与打包docker)
- [测试与质量门禁](#测试与质量门禁)
- [项目目录结构](#项目目录结构)
- [数据、日志与状态位置](#数据日志与状态位置)
- [安全说明](#安全说明)
- [社区与支持](#社区与支持)
- [许可证](#许可证)

---

## GenWork 是什么

GenWork 是一个面向企业真实工作环境的**桌面端企业级智能体（Enterprise Agent）**。它把大模型驱动的智能体能力与本地办公工具链深度结合，让企业员工在自己的桌面上拥有一个能执行真实任务的 AI 同事——能读写本地文件、运行命令、操作浏览器、生成 Word/Excel/PPT/PDF 文档、收发邮件、接入 IM，并按组织授权完成跨系统的复合办公任务。

GenWork 由三个相互协作的部分组成：

- **桌面客户端（GenWork Desktop）**：基于 Electron + React 18 + Redux Toolkit 的跨平台桌面应用，是员工日常使用的入口。
- **企业服务端（GenWork Enterprise Server）**：基于 Node.js + Hono + PostgreSQL 的多租户后端，提供统一身份认证、组织/部门/角色管理、模型代理与配额、审计日志、策略下发、应用市场、SSO 绑定等能力。
- **管理控制台（Enterprise Web Console）**：由企业服务端内置的 React SPA，管理员通过浏览器即可完成组织初始化、用户管理、模型与 Provider 配置、技能/MCP 审核、审计查询、应用发布等运营动作。

企业级智能体的核心含义，在 GenWork 里有四个具体体现：

1. **多租户隔离**——服务端支持多个组织（Org）共存，组织间数据强隔离，跨组织访问直接 404，绝不泄露存在性。
2. **企业级权限模型**——基于「细粒度权限点（module:action）× 数据范围（DataScope）」的两轴模型，权限点与数据范围独立判定并审计，跨级越权一律 fail-closed。
3. **企业级模型治理**——服务端统一代理 LLM Provider，API Key 使用 AES-256-GCM 加密静态存储，可按组织/角色下发模型与配额，所有调用生成审计与用量记录。
4. **企业级管控通道**——管理员可通过服务端向桌面端统一下发模型目录、专家套件、MCP/技能市场、SSO 绑定、应用更新；桌面端在登录后会自动同步这些配置，无需终端用户手工干预。

GenWork 既可以作为个人开发者使用的桌面 Agent，也可以作为企业 IT 统一采购、分发、管控、审计的智能体平台。本文档覆盖**全部场景**的安装、部署与开发。

---

## 核心能力

### 桌面端能力

#### Cowork 长任务会话

围绕本地项目和文件执行长任务。GenWork 实时流式展示进度、持久化会话历史、渲染工具输出，并在文件操作、终端命令、网络访问等敏感动作前请求用户审批。

下图展示了一次真实场景：Agent 拿到一张电商仓库成本/利润手写笔记的扫描件，识别出 6 处模糊点并主动标注「?待确认」交给用户核对；右侧实时生成结构化的成本/利润结转逻辑文档与可下载的 Markdown / HTML Artifact。

<p align="center">
  <img src="docs/res/desktop-screenshot.png" alt="GenWork 桌面端：长任务会话 + Artifact 实时生成" width="960">
</p>

#### 多 Agent 工作流

创建拥有独立身份、模型、技能、工作目录、启用状态和 IM 绑定的自定义 Agent。主 Agent 处理通用工作，专用 Agent 负责重复性的特定角色（如周报生成、招聘筛选、研报写作等）。

#### 专家套件（Expert Kits）

按场景打包的能力组合。管理员可在管理控制台发布套件，用户一键安装后即可获得「能力选择 + 参考资料 + 工作流模板」的整体方案。套件与单个技能可自由叠加。

#### 技能（Skills）

GenWork 内置 29 个技能，覆盖 Web 搜索、Word 文档、Excel 表格、PowerPoint、PDF 处理、Remotion 视频生成、浏览器自动化、图片/视频生成、股票研究、内容写作、邮件、天气、技能创建等场景。企业服务端还提供技能市场与提交审核。

#### MCP 服务

通过 Model Context Protocol 接入外部工具和数据源。GenWork 在本地保存用户配置的 MCP 服务，并把启用的服务同步给执行引擎；管理员可通过服务端的市场与提交审核统一管控可用的 MCP。

#### 定时任务

通过自然语言或定时任务 UI 创建周期任务。适合每日新闻、邮箱摘要、网站监控、周报生成等重复性工作。

#### IM 远程控制

桌面 Agent 可被微信、企业微信、钉钉、飞书/Lark、QQ、Telegram、Discord、网易云信 IM、网易小蜜蜂、POPO 和邮件触达。多实例平台可以把不同账号或渠道绑定到不同 Agent。

#### 丰富 Artifacts

在桌面端预览和管理生成的 HTML、SVG、图片、视频、Mermaid 图表、代码、Markdown、文本、文档和本地服务类 Artifacts。HTML/SVG 通过本地预览服务或沙箱 iframe 安全渲染。

#### 本地记忆与数据

会话和应用数据保存在本地 SQLite。Agent 工作区记忆使用 `MEMORY.md`、`USER.md`、`SOUL.md` 和每日笔记等文件，让偏好和项目上下文能够跨会话延续。

### 企业服务端能力

| 模块 | 能力 |
| --- | --- |
| **多租户与组织** | 多 Org 隔离；组织名注册；Org-scoped 用户、部门树、岗位 |
| **认证与 SSO** | 本地账号密码（bcryptjs）；SSO 绑定（飞书等 IdP）；JWT（HS256）签发与校验 |
| **权限模型** | 「细粒度权限点 × 数据范围」两轴；41 个内置权限点；5 种 DataScope；fail-closed 校验 |
| **用户与角色管理** | 部门树、角色 CRUD、内置角色保护（不可删除）；批量操作；用户邀请 |
| **模型目录** | 按组织导入与下发模型；内置 Provider 模板（OpenAI、Anthropic、DeepSeek、GenWork Server 等） |
| **Provider Key 保险库** | AES-256-GCM 加密静态存储；只返回 `api_key_masked`；支持按角色访问 |
| **模型代理** | `/proxy/<provider>` 统一代理；按组织/角色配额；全量审计 |
| **审计日志** | 全操作审计；越权行为以 `admin_access_denied` 记录，区分权限点缺失与数据范围外 |
| **用量统计** | Token 用量、调用次数、模型分布 |
| **专家套件** | 服务端发布套件；客户端按需拉取 |
| **技能市场** | 服务端托管技能市场 + 提交审核 |
| **MCP 市场** | 服务端托管 MCP 连接器市场 + 提交审核 |
| **Agent 市场** | 服务端托管 Agent 模板市场 + 提交审核 |
| **应用分发** | 桌面端更新检查、安装包下载与签名校验 |
| **HTML 分享** | 生成可公开访问或仅 Org 内访问的 Artifact 分享页 |
| **归档** | 组织级归档服务端存储 |

下图展示了「模型配置」页面：左侧按内置服务商 / 自定义服务商分组并以开关粒度控制启停，右侧配置 Base URL、API 协议（OpenAI 兼容 / Anthropic 兼容）、Coding Plan 专属端点与加密的 API Key，下方是该服务商下挂载的模型列表（模型名、类型、上下文窗口、启用状态、操作）。所有 API Key 提交后即以 AES-256-GCM 加密入库，列表只展示掩码。

<p align="center">
  <img src="docs/res/enterprise-console-screenshot.png" alt="GenWork 管理控制台：模型配置" width="960">
</p>

### 实战指令

| 场景 | 示例指令 |
| --- | --- |
| 搭建本地系统 | "我还在用 Excel 记录库存和销售，帮我做一个本地进销存系统，可以录入进货和销售，自动计算库存和利润，并能在浏览器打开。" |
| 分析本地数据 | "基于 `product-growth.xlsx` 做一个可视化看板，并总结主要增长原因。" |
| 生成汇报 PPT | "调研 AI Agent 市场格局，并把结论整理成一份演示文稿。" |
| 自动检查网页后台 | "每天早上打开广告后台，检查消耗和转化是否异常，并总结可能原因。" |
| 批量筛选文档 | "把这个文件夹里的简历整理成筛选表，对照 JD 选出最匹配的人。" |
| 定时执行任务 | "每个工作日早上 9 点收集昨天的 AI 新闻，并发我一份简洁摘要。" |

---

## 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                       企业管理员浏览器                          │
│   Enterprise Web Console (React 19 + TanStack Query + Zustand)  │
└──────────────────────────────┬─────────────────────────────────┘
                               │ HTTPS / JWT
                               ▼
┌────────────────────────────────────────────────────────────────┐
│                  GenWork Enterprise Server                     │
│   Hono + node:http  •  PostgreSQL  •  /proxy + /admin + /api    │
│   Auth/RBAC • Vault • Audit • Catalog • Marketplace • Updates   │
└──────────────────────────────┬─────────────────────────────────┘
                               │ HTTPS (ENTERPRISE_SERVER_URL)
                               ▼
┌────────────────────────────────────────────────────────────────┐
│                  员工桌面 (GenWork Desktop)                     │
│   Electron 40 + React 18 + Redux Toolkit + Tailwind             │
│   Renderer  ⇄  Main (IPC)  ⇄  Cowork Store (SQLite)             │
│   Agents • Skills • MCP • IM • Scheduled Tasks • Artifacts      │
└────────────────────────────────────────────────────────────────┘
```

桌面端始终离线优先：本地 SQLite 存会话、应用数据；所有企业级配置（模型目录、套件、MCP、技能市场、SSO 绑定、应用更新）由企业服务端在登录后同步下发。

---

## 企业端安装部署

> 目标：负责在企业内部署 GenWork Enterprise Server（含管理控制台），并向员工桌面端统一下发企业配置。

### A. 生产环境部署（客户自管 Linux 主机）

> 适用对象：企业 IT 运维。准备一台长期运行的 Linux 主机，按本节步骤拉起生产容器。
> 架构概览、环境变量、本地开发"快速开始"见下方的第 1-6 节。

#### A.1 先决条件

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Ubuntu 22.04+ 或 RHEL 9+ |
| Docker | Docker Engine ≥24，且已安装 `docker compose` 插件 |
| PostgreSQL | 14+（本机、Docker 或可达的远端实例皆可） |
| 镜像来源 | 内部镜像仓库；或构建主机可外网拉 `node:24-alpine`（首次构建需出网） |
| 网络 | 反向代理（nginx / Caddy / 云 LB）提供 HTTPS 终止；建议证书由 ACME 自动签发 |

#### A.2 步骤 1 — 构建（或拉取）镜像

在**构建主机**上：

```bash
# 1.1 拉取源码并切到目标版本
git clone https://github.com/your-org/genwork.git
cd genwork
git checkout v2026.10.19   # 替换为实际要部署的版本 tag

# 1.2 用打包脚本构建（详见 §4.4，完整说明在开发指南）
./scripts/package-enterprise-server.sh --tag v2026.10.19

# 1.3 推送到内部镜像仓库
docker tag enterprise-server:v2026.10.19-abcd123 \
  registry.internal/genwork/enterprise-server:v2026.10.19-abcd123
docker push registry.internal/genwork/enterprise-server:v2026.10.19-abcd123
```

或在**生产主机**上直接拉：

```bash
docker pull registry.internal/genwork/enterprise-server:v2026.10.19-abcd123
```

#### A.3 步骤 2 — 准备 `.env`

在生产主机上：

```bash
mkdir -p /etc/genwork
cd /etc/genwork
cp /path/to/enterprise_server/.env.example .env
```

编辑 `.env`，填入：

| 变量 | 必填 | 说明 | 生成方式 |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://app:<password>@<pg-host>:5432/genwork` | 手动 |
| `JWT_SECRET` | ✅ | HS256 签名密钥，**≥ 32 字符** | `openssl rand -hex 32` |
| `GENWORK_VAULT_MASTER_KEY` | ✅ | Provider Key 加密主密钥，**32 字节 base64**；丢失则全部 Provider Key 不可恢复 | `openssl rand -base64 32` |
| `IMAGE_TAG` | ✅ | 镜像 tag（如 `v2026.10.15`） | 手动 |
| `POSTGRES_SUPERUSER_URL` | ⚠️ 仅 `init` 阶段 | `postgres://postgres:<pw>@<pg-host>:5432/postgres`；**init 成功后务必删除此行** | 手动 |

> ⚠️ `init` 默认会用 `POSTGRES_SUPERUSER_URL` 自动建应用账号与库。如已在 Postgres 里手动建好，改为运行 `genwork-server init --no-db-bootstrap` 并删除 `POSTGRES_SUPERUSER_URL`。

#### A.4 步骤 3 — `genwork-server init`

在生产主机上，确保 `.env` 在当前目录：

```bash
cd /etc/genwork          # 或任何含 .env 的工作目录
genwork-server init
# 或：node /opt/genwork/enterprise_server/dist/cli/index.js init
```

`init` 会：

1. 校验 Docker 在 `PATH`、当前用户是 `root`（init 拒绝以非 root 身份写 `/etc/genwork/`）
2. 校验 `JWT_SECRET` 与 `GENWORK_VAULT_MASTER_KEY` 强度
3. 用 `POSTGRES_SUPERUSER_URL` 创建应用账号与库（已存在则跳过；同账号报错）
4. 在 `/etc/genwork/` 写入：
   - `compose.yml`（来自镜像 bundle 的 compose 模板，`image:` 已被替换为 `IMAGE_TAG`）
   - `caddyfile.example`（反向代理配置模板）
   - `current-version`（`IMAGE_TAG`）
5. 在 `/usr/local/bin/genwork-server` 创建一个指向 `cli/dist/index.js` 的符号链接（最佳努力，失败只警告，不中断 init）

#### A.5 步骤 4 — 启动

```bash
genwork-server start
# 等价于：docker compose -f /etc/genwork/compose.yml up -d
```

等待 `docker compose ps` 显示 `Up (healthy)`：

```bash
docker compose -f /etc/genwork/compose.yml ps
# NAME                STATUS              PORTS
# genwork-app         Up (healthy)        0.0.0.0:8787->8787/tcp
```

#### A.6 步骤 5 — 首次运行（初始化组织 + Super Admin）

在浏览器打开：

```
https://<enterprise-host>/setup
```

按向导录入：

- **组织名**（例：`Acme Corp`）—— 桌面端"Enterprise"登录时填的也是这个
- **Super Admin 用户名 + 密码** —— 之后用 `(组织名, 用户名, 密码)` 登录管理控制台 `/login`

> 完成后 `/api/setup/*` 永久关闭（HTTP 410）。如需重开，跑 `genwork-server reinit`，会再次打开 setup 向导（**已有的组织与数据不会被清空**）。

#### A.7 步骤 6 — 配置反向代理

容器本身监听 `http://0.0.0.0:8787`。生产环境强烈建议前置 nginx / Caddy 终止 TLS。

**Caddyfile 示例**（`/etc/genwork/caddyfile.example` 已含模板）：

```caddy
<enterprise-host> {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-Proto https
        flush_interval -1
    }
}
```

**nginx 示例**（最小可用）：

```nginx
server {
    listen 443 ssl http2;
    server_name <enterprise-host>;
    ssl_certificate     /etc/letsencrypt/live/<enterprise-host>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<enterprise-host>/privkey.pem;

    client_max_body_size 50m;
    proxy_read_timeout   120s;
    proxy_send_timeout   120s;

    location / {
        proxy_pass         http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

验证：

```bash
curl -fsS https://<enterprise-host>/api/health
# 期望：{"ok":true}
```

#### A.8 步骤 7 — 后续升级

```bash
# 7.1 拉取新镜像到生产主机
docker pull registry.internal/genwork/enterprise-server:v2026.11.1

# 7.2 一条命令完成升级（预迁移 dry-run → 切镜像 → 重启 → 校验）
genwork-server upgrade --to v2026.11.1
```

升级流程：

1. `docker pull <new-image>`
2. **dry-run** 预迁移（`GENWORK_MIGRATE_DRY_RUN=1`），只校验迁移 SQL 是否可执行，**不写库**
3. 把 `compose.yml` 的 `image:` 替换为新 tag
4. `docker compose up -d` 拉起新容器
5. 轮询 `/health`（默认 30 秒超时）
6. 失败 → 自动 `docker compose up -d` 回滚到旧 tag，**数据库不动**；退出码 `1`
7. 成功 → 写 `previous-version` / `current-version` 元数据

#### A.9 步骤 8 — 备份

```bash
genwork-server backup                # 默认写到 ./genwork-backup-YYYY-MM-DD.tar.gz
# 或：
genwork-server backup --out /var/backups/genwork/genwork-$(date +%F).tar.gz
```

`backup` 做两件事：

1. `pg_dump --format=custom` 写到一个临时目录
2. 把临时目录里的 `dump.sql.gz` 与 `/etc/genwork/data/` 一起打成 `<out>`

建议：

- 把 `genwork-backup-*.tar.gz` 推到对象存储（S3/OSS/COS）
- 保留最近 14 天本地副本 + 异地冷归档

#### A.10 步骤 9 — 恢复

```bash
# 9.1 先停服务（restore 会校验 /health）
genwork-server stop

# 9.2 跑恢复
genwork-server restore --from /var/backups/genwork/genwork-2026-10-15.tar.gz

# 9.3 启动
genwork-server start
```

`restore` 流程（已加保险）：

1. 校验服务已停；未停但传 `--force` 会打 WARNING 后继续
2. 交互式二次确认（`--force` 时跳过）：要输入大写 `YES`
3. **先解压到 staging 目录**（`mkdtempSync`），失败时 live 数据不会丢
4. `pg_restore` 应用数据库 dump
5. **原子重命名** staging `data/` 目录覆盖 live（跨设备时回退到 `cp -a`）

#### A.11 监控与日常

| 命令 | 用途 | 退出码 |
| --- | --- | --- |
| `genwork-server status` | 健康 / 版本 | `0` 正常 / `1` 异常 / `2` 未运行 |
| `genwork-server logs` | `docker compose logs` 透传 | — |
| `genwork-server version` | 当前版本 | `0` |
| `genwork-server reinit` | 重新打开 setup 向导（**不**清空数据） | `0` |

容器日志位置（外部采集时挂这些目录）：

- `/var/lib/docker/containers/<id>/<id>-json.log`（Docker 默认 JSON driver）
- 或客户自己配置的 Loki / Filebeat / Fluent Bit 输出

#### A.12 故障排查

| 现象 | 排查 |
| --- | --- |
| `init` 报 "Docker is not on PATH" | 安装 `docker-ce` 与 `docker-compose-plugin`；确认 `docker --version` ≥ 24 |
| `init` 报 "same role"（`POSTGRES_SUPERUSER_URL` 与 `DATABASE_URL` 同账号） | 在 Postgres 手动 `CREATE ROLE` 出应用账号，再 `genwork-server init --no-db-bootstrap` |
| `upgrade` 之后容器 restart loop | 升级已自动回滚到旧 tag；查 `docker logs genwork-app` 找新版本为何没起。**数据库没动** |
| `/api/health` 200 但 `/` 空白 | 反向代理没把 `/` 转发过去；Caddy 加 `flush_interval -1`，nginx 调 `proxy_read_timeout 120s` |
| `genwork-server: command not found` | `init` 步骤 5 失败；手动建链接：`ln -s /opt/genwork/enterprise_server/dist/cli/index.js /usr/local/bin/genwork-server && chmod +x /opt/genwork/enterprise_server/dist/cli/index.js` |
| `restore` 报 "archive did not contain a data/" | 备份是在用本工具之前手动 `tar` 打的；用 `genwork-server backup` 重新生成 |
| 升级回滚后想强制升级到新版本 | 排查完阻塞问题（多半是数据库迁移 dry-run 失败），再 `genwork-server upgrade --to <ver>` 一次 |

#### A.13 桌面端对接

桌面端要连上服务端，需在构建桌面安装包时把 `ENTERPRISE_SERVER_URL` 烘焙进去（详见下方"桌面端环境变量"节）：

```bash
# 根目录 .env
ENTERPRISE_SERVER_URL=https://<enterprise-host>
```

登录页选 "Enterprise"，输入 **组织名 + 用户名 + 密码**（或走 SSO）即可。桌面端会从服务端同步模型目录、套件、技能市场、MCP 市场。

> 英文生产部署文档（含 `IMAGE_TAG` 命名规范、镜像 tag charset 限制）见
> [`docs/enterprise-server-deploy.md`](docs/enterprise-server-deploy.md)。

---

## 用户端安装部署

> 目标读者：终端员工、桌面用户。

### 1. 仅使用企业版（推荐企业用户）

如果你的公司已经部署了 GenWork Enterprise Server，你只需要拿到桌面安装包 + 登录凭据：

1. 从公司 IT 渠道获取最新安装包（macOS / Windows / Linux）。
2. 安装后启动应用，登录页选择「Enterprise」。
3. 填入公司 IT 给你的：
   - **组织名**（不是组织 ID，例如 `Acme Corp`）
   - **用户名**、**密码**（或选择 SSO 走 IdP 登录）
4. 登录后桌面端会自动从企业服务端同步模型目录、套件、技能市场、MCP 市场。

**系统要求**：

| 平台 | 最低版本 | 备注 |
| --- | --- | --- |
| macOS | macOS 12 Monterey+ | 通用包同时支持 Intel 与 Apple Silicon |
| Windows | Windows 10 1803+ | 需要内置 `tar.exe`；不需要单独装 Python |
| Linux | glibc 2.31+ 的发行版（Ubuntu 20.04+、Debian 11+、RHEL 8+ 等） | AppImage / deb / rpm 任选 |

### 2. 独立使用（个人/小团队）

如果你不接入企业服务端，可以直接使用个人模式：

1. 在登录页选择「Personal / Local」。
2. 自带 29 个内置技能 + 自定义 Agent + IM 渠道。
3. 模型需要在桌面端「Settings → Providers & Models」自行录入 API Key（OpenAI、Anthropic、DeepSeek 等）；Key 仅保存在本机 SQLite。
4. 所有数据（会话、记忆、Artifact）保留在本地；可随时接入企业服务端平滑迁移到企业模式。

### 3. 下载渠道

| 渠道 | 说明 |
| --- | --- |
| 企业内部渠道 | IT 自行托管；URL 在登录前通过环境变量 `ENTERPRISE_SERVER_URL` 注入到安装包（构建时）或启动时覆盖 |
| GitHub Releases | 历史版本与 beta |

### 4. 数据与日志位置（用户端）

- **应用数据**：`<userData>/genwork.sqlite`
  - macOS：`~/Library/Application Support/GenWork/genwork.sqlite`
  - Windows：`%APPDATA%/GenWork/genwork.sqlite`
  - Linux：`~/.config/GenWork/genwork.sqlite`
- **主进程日志**：保留 7 天，单文件 80 MB 轮转
  - macOS：`~/Library/Logs/GenWork/main-YYYY-MM-DD.log`
  - Windows：`%APPDATA%/GenWork/logs/main-YYYY-MM-DD.log`
  - Linux：`~/.config/GenWork/logs/main-YYYY-MM-DD.log`
- **Agent 工作区记忆**：`<userData>/openclaw/state/workspace-{agentId}/`（主 Agent 是 `workspace-main`），内含 `MEMORY.md`、`USER.md`、`SOUL.md`、每日笔记 `memory/YYYY-MM-DD.md`
- **执行引擎日志**：`<userData>/openclaw/logs/gateway-*.log`，保留 3 天

---

## 开发指南

> 目标读者：GenWork 桌面端 / 企业服务端的开发者。桌面端用 npm + Electron；企业服务端只通过 Docker 镜像交付，开发与打包全在容器内进行（详见 §4）。

### 1. 代码仓库布局

本仓库是一个 npm workspaces 单仓：

```
GenWork/
├── src/                 # 桌面端（Electron Main + Renderer）
├── enterprise_server/   # 企业服务端（Node.js + Hono + PostgreSQL）
├── enterprise_server/web/  # 管理控制台 SPA（Vite + React 19 + TanStack Query + Zustand）
├── SKILLs/              # 内置技能
├── scripts/             # 构建、打包、运行时、签名、迁移脚本
├── docs/                # 架构与部署文档
├── electron-builder.json
├── package.json         # 根 package.json（workspaces 包含 enterprise_server）
└── .env.example         # 桌面端构建期配置（ENTERPRISE_SERVER_URL 等）
```

### 2. 环境依赖

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | `>=24.15.0 <25`（与 `package.json` `engines` 一致） | 根项目要求；`.nvmrc` 也指向 24 |
| npm | 内置随 Node | workspaces 用 npm 协议 |
| PostgreSQL | `14+` | 企业服务端依赖；可用 Docker |


### 3. 桌面端开发

#### 3.1 首次启动

```bash
git clone https://github.com/genwork/genwork.git
cd GenWork
npm install
# 首次启动会自动构建桌面端所需的执行 runtime（约几分钟）
npm run electron:dev:openclaw
# 之后日常开发用：
npm run electron:dev
```

- 渲染进程 dev server：`http://localhost:5175`（`strictPort`，已占用会报错而不是回退）
- Electron 主进程等待 `http://localhost:5175` 与 `dist-electron/.electron-ready` 都就绪后再启动（`wait-on`）
- 主进程入口：`dist-electron/main.js`（由 vite-plugin-electron 打包），不是 `tsc` 产物 `dist-electron/main/main.js`

#### 3.2 常用脚本

| 脚本 | 用途 |
| --- | --- |
| `npm run dev` | 仅跑 Vite 渲染进程 dev server（不启动 Electron） |
| `npm run electron:dev` | 日常开发：编译 Electron + Vite + Electron 启动 |
| `npm run electron:dev:openclaw` | 首次或 runtime 升级后用：先构建执行 runtime 再启动 |
| `npm run build` | 生产 renderer bundle |
| `npm run compile:electron` | 编译 Electron main/preload TypeScript |
| `npm test` | Vitest 入口（CI 用的就是这个） |
| `npm run lint` | 全量 ESLint（可能命中历史 debt） |
| `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` | 改动文件按 CI 规则严格 lint |
| `npm run build:skills` | 编译内置技能（web-search、tech-news、imap-smtp-email） |

#### 3.3 OpenClaw / dsh Runtime 变量

| 变量 | 用途 |
| --- | --- |
| `OPENCLAW_SRC` | 覆盖执行引擎源码路径，默认 `../openclaw` |
| `OPENCLAW_SKIP_ENSURE=1` | 跳过自动 checkout，方便本地修改 |
| `OPENCLAW_FORCE_BUILD=1` | 强制重建 runtime |

> 上述 runtime 脚本（`openclaw:runtime:host`、`dsh:runtime:*`）用于构建打包到桌面应用内的本地执行引擎，**仅在调整执行引擎 / 升级 dsh 时需要**；日常 UI 业务开发不必动它们。

#### 3.4 桌面端环境变量（`.env`）

```bash
# 桌面端登录时连的企业服务端地址，会烘焙到安装包
ENTERPRISE_SERVER_URL=https://<enterprise-host>:8787
```

构建期烘焙的 URL 在用户登录时是默认值；启动时仍可用 `ENTERPRISE_SERVER_URL` 环境变量覆盖（MDM/终端启动场景）。

#### 3.5 桌面端打包

```bash
# macOS（任选单一目标）
npm run dist:mac          # 默认
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:mac:universal

# Windows
npm run dist:win
# Windows 打包会自动 setup Python runtime + 嵌入 mingit（如果需要）

# Linux
npm run dist:linux
```

打包会把执行引擎 runtime 烤进 `Resources/openclaw-runtime`，Windows 包还会烤入便携 Python（`resources/python-win`），用户无需手动安装。

离线 / 私有源打包可用的环境变量：

- `GENWORK_PORTABLE_PYTHON_ARCHIVE`
- `GENWORK_PORTABLE_PYTHON_URL`
- `GENWORK_WINDOWS_EMBED_PYTHON_VERSION`
- `GENWORK_WINDOWS_EMBED_PYTHON_URL`
- `GENWORK_WINDOWS_GET_PIP_URL`

### 4. 企业服务端开发与打包（Docker）

> 企业服务端只通过 **Docker 镜像** 交付。开发与打包全在容器内进行，宿主机只需要装 Docker 24+ 和 `docker compose` 插件，**不需要** 本地 Node.js / PostgreSQL。

#### 4.1 一次性准备：构建多阶段开发镜像

仓库自带 `enterprise_server/Dockerfile`，三阶段构建（`web-build` → `ts-build` → `runtime`）。开发时用一个**带 tsx watch 的开发 tag** 即可：

```bash
# 在仓库根目录
docker buildx build \
  -f enterprise_server/Dockerfile \
  --target ts-build \
  --tag genwork-enterprise-dev:latest \
  --load \
  .
```

`--target ts-build` 只跑到第二阶段（TypeScript 已编译、`tsx` 已安装、`web-dist` 已就位），不含运行时精简层。后面用这个镜像跑 tsx watch。

> 改 `enterprise_server/src/` 或 `web/` 里的代码后，重跑这条命令重新打 `:latest` tag 即可（增量构建通常 5-10 秒）。

#### 4.2 本地开发：docker compose + tsx watch

新建一个 **仅用于本机开发** 的 `docker-compose.dev.yml`（提交进仓库的 dev 路径，不影响生产 `docker-compose.yml`）：

```yaml
# enterprise_server/docker-compose.dev.yml
name: genwork-enterprise-dev

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: genwork
      POSTGRES_PASSWORD: genwork
      POSTGRES_DB: genwork
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U genwork"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    image: genwork-enterprise-dev:latest   # 来自 4.1 的开发镜像
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - ./src:/work/enterprise_server/src   # 源码挂载，让 tsx watch 看到改动
    command: ["npx", "tsx", "watch", "--env-file=.env", "src/server.ts"]

volumes:
  pg_data:
```

起服务：

```bash
cd enterprise_server
cp .env.example .env   # 填 DATABASE_URL / JWT_SECRET / GENWORK_VAULT_MASTER_KEY

# 起 Postgres
docker compose -f docker-compose.dev.yml up -d postgres

# 跑服务端（tsx watch，文件改动自动重启）
docker compose -f docker-compose.dev.yml run --rm --service-ports app
# 监听 http://127.0.0.1:8787
```

> 改 `src/` 里的 TypeScript / `web/` 里的 SPA 代码后：
> - **服务端代码改动**：`tsx watch` 自动重启，浏览器刷新即可
> - **SPA 代码改动**：重跑 §4.1 重新打 `genwork-enterprise-dev:latest`（web 改动需要重 build），再 `Ctrl+C` 重跑 `docker compose ... run`

#### 4.3 集成验证：直接跑生产镜像

`tsx watch` 不是生产路径。本地集成验证时**必须**用生产镜像（`runtime` 阶段，`npm ci --omit=dev`）：

```bash
# 1. 拉起 Postgres（同上）
docker compose -f docker-compose.dev.yml up -d postgres

# 2. 跑生产 compose
IMAGE_TAG=local-test docker compose -f docker-compose.yml up -d

# 3. 验证
curl -fsS http://127.0.0.1:8787/api/health
# 期望：{"ok":true}
```

集成验证的差异点（生产镜像独有）：

- 镜像内是 `tini` + `node dist/cli/index.js start`，**没有** `tsx` / `vitest` / 任何 dev 依赖
- `HEALTHCHECK` 走容器内 `node -e fetch(...)`，与本地 `tsx watch` 行为一致
- 日志走 `json-file` driver（20MB × 5 轮转），不是 stdout

#### 4.4 打包：构建生产镜像

仓库根目录的 `scripts/package-enterprise-server.sh` 是生产镜像打包的**推荐入口**，把 Dockerfile 三阶段（`web-build` → `build` → `runtime`）打成带版本 tag 的镜像并打印下一步提示。

```bash
# 4.4.1 仅构建（默认 builder 为 legacy V1，绕开 docker-desktop 上偶发的
# buildkit stale result-ref；CI 上可加 USE_BUILDKIT=1 切回 buildkit 取更快的层缓存）
./scripts/package-enterprise-server.sh --tag v2026.10.19
# → Successfully tagged enterprise-server:v2026.10.19-<short-sha>

# 4.4.2 直接推送到内部 registry（多架构需要 --push）
./scripts/package-enterprise-server.sh --tag v2026.10.19 \
    --registry registry.internal/genwork --push

# 4.4.3 多架构打包
./scripts/package-enterprise-server.sh --tag v2026.10.19 \
    --platform linux/amd64,linux/arm64 --push
```

镜像命名规范：

- **默认产出** `enterprise-server:v<version>-<short-sha>`（**单段名**，与 `docker-compose.yml` 的 `IMAGE_REPO` 默认值及 `genwork-server upgrade` 的 `IMAGE_REPO` 默认值一致，无需 env 覆盖即可 `docker compose up -d`）
- 仅允许 `[a-zA-Z0-9._-]`，**禁止 `+`**（OCI image tag 字符集限制，`docker push` 会拒绝）
- 不写 `--tag` 时默认 `dev-<short-sha>`

脚本还提供：

- `--env-file <path>` + `--generate-secrets`：用 `openssl rand` 生成 `JWT_SECRET` 与 `GENWORK_VAULT_MASTER_KEY` 写入指定文件，供你合并进生产主机的 `.env`。**镜像本身不 bake secret**，运行时由 `env_file:` 提供
- `--load-only`：与 `--load` 行为相同，仅本机 docker 加载，不推送
- `--help`：完整参数说明

### 早先的 `scripts/build-enterprise-image.sh`

仓库还保留了一个更精简的 `scripts/build-enterprise-image.sh`，只跑 `docker buildx + sha tag`、不校验 OCI 字符集、不处理 web 端缺 lockfile 的边界情况。该脚本是 CI 的最小化等价入口，**不适合**作为开发或本地手动打包的入口。所有新场景请用 `package-enterprise-server.sh`。

#### 4.5 推送到内部仓库

```bash
docker tag enterprise-server:v2026.10.19-abcd123 \
    registry.internal/genwork/enterprise-server:v2026.10.19-abcd123

docker push registry.internal/genwork/enterprise-server:v2026.10.19-abcd123
```

CI 会自动构建并推送（见 `.github/workflows/enterprise-server-image.yml`）；本地用上面这条命令手动推一次即可。推到内部仓库后，`genwork-server upgrade --to v2026.10.19-abcd123` 就能在生产主机上拉新镜像。

#### 4.6 改代码后的快速重打包 + 集成验证流程

```bash
# 改 enterprise_server/src/*.ts 或 web/ 下源码
./scripts/package-enterprise-server.sh --tag v2026.10.19-dev

# 起生产 compose 端到端验证（覆盖 ./enterprise_server/.env 与 compose 默认值）
docker compose -f enterprise_server/docker-compose.yml up -d
curl -fsS http://127.0.0.1:8787/health
# → {"ok":true}
```

集成验证的关键点：

- 镜像的 `ENTRYPOINT` 是 `tini + node /app/repo/dist/cli/index.js`，**入口就是** CLI 本身，**不要** 再加 `genwork-server` 前缀（参见 4.7）
- compose 默认注入 `DATABASE_URL=postgres://genwork:genwork@host.docker.internal:5434/genwork`，让容器内能连到 docker host 上的 Postgres；改用其他 DB 时直接覆盖该值即可
- 健康检查端点是 `/health` 与 `/api/health`（二者都返回 `{"ok":true}`，后者还 serve SPA 的 `index.html`）

#### 4.7 镜像内 CLI 工具

`enterprise-server` 镜像的 `ENTRYPOINT` 是 `tini + node /app/repo/dist/cli/index.js`，所以容器内**直接用** `version` / `migrate` 等子命令，不需要 `genwork-server` 前缀（`genwork-server` 是在生产主机上由 `init` 子命令在 `/usr/local/bin/` 建立的 shim，**容器内**没有这个文件）。

```bash
# 查看构建时注入的版本
docker run --rm enterprise-server:v2026.10.19-abcd123 version
# → genwork-server v2026.10.19-abcd123

# 列出所有子命令
docker run --rm enterprise-server:v2026.10.19-abcd123 help
```

`start` 子命令会自动跑迁移；手动跑迁移（带 `GENWORK_MIGRATE_DRY_RUN=1` 校验）：

```bash
docker run --rm \
    --env-file enterprise_server/.env \
    -e GENWORK_MIGRATE_DRY_RUN=1 \
    enterprise-server:v2026.10.19-abcd123 \
    migrate
```

### 关于 dist 的 ESM import 后缀

`enterprise-server` 源码用 bundler-style 相对路径 import（如 `from '../db/pool'`，不带 `.js`），tsc 编译到 `dist/` 后**保留**这种写法。Node 24 的 ESM loader 严格要求显式 `.js` 后缀，直接跑 `node dist/cli/index.js` 会 `ERR_MODULE_NOT_FOUND`。

Dockerfile 的 `build` 阶段在 `tsc` 之后跑了一次 `enterprise_server/scripts/patch-esm-imports.mjs`，给所有相对路径 import 补上 `.js` 后缀（且校验目标文件存在才补），并把 `src/db/migrations/*.sql` 显式 `COPY` 到 `dist/db/migrations/`（tsc 不会处理 SQL）。这就是为什么容器里 `start` 与 `migrate` 能直接跑通，无需任何运行时 loader 钩子。

等 `enterprise_server` 自身迁移到 NodeNext-style import（`./foo.js`）后，patcher 可从 Dockerfile 移除。

---

## 测试与质量门禁

| 场景 | 跑什么 |
| --- | --- |
| 改 TypeScript / TSX | `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` |
| 桌面端业务逻辑 | `npm test -- <keyword>` 走 vitest 选跑的子集 |
| 全量 CI 跑法 | `npm test`（vitest run，根 + workspace） |

> 仓库存在历史 lint debt，全量 `npm run lint` 可能会命中旧问题；本项目 CI 只 lint 改动文件。**不要**为通过 lint 而批量加 `eslint-disable`。

### 测试数据与稳定性

- 企业服务端测试用 pglite（in-process Postgres via WASM），无需本地 Postgres；用真实 Postgres 时单测请按文件跑（sandbox 偶有 fd 限制）
- 桌面端测试中 `mockImplementationOnce` 与节流缓存可能跨用例泄漏，统一在 `beforeEach` 中 `agentEnterpriseSyncThrottle._reset()` 清场
- 桌面端 `dist-electron/main.js` 是 vite 打包的真实入口，不是 tsc 输出的 `dist-electron/main/main.js`

---

## 项目目录结构

### 桌面端

| 路径 | 用途 |
| --- | --- |
| `src/main/main.ts` | Electron 生命周期、IPC 注册、鉴权、日志、runtime 启动、服务装配 |
| `src/main/preload.ts` | contextBridge，把受控 IPC API 暴露给渲染层 |
| `src/main/coworkStore.ts` | 会话、消息、配置、Agent、记忆元数据 + SQLite CRUD |
| `src/main/sqliteStore.ts` | 数据库初始化与迁移 |
| `src/main/auth/` | 企业登录、SSO、Provider Key 保险库客户端 |
| `src/main/agentManager.ts` | Agent CRUD 与预设安装 |
| `src/main/skills/skillManager.ts` | 内置 / 用户技能同步、安装、安全扫描、启用状态 |
| `src/main/im/` | IM 网关配置、状态、投递、会话映射、媒体、配对 |
| `src/scheduledTask/` | 定时任务模型、cron、本地元数据 |
| `src/main/mcp/` | MCP 服务存储、runtime、市场、启动解析 |
| `src/renderer/` | 渲染层（React 18 + Redux Toolkit + Tailwind） |
| `src/renderer/components/cowork/` | 会话 UI、提示词、权限、思考 / 工具展示、语音输入 |
| `src/renderer/components/agent/` | Agent 创建与设置 UI |
| `src/renderer/components/agentSidebar/` | Agent / 会话树与子 Agent UI |
| `src/renderer/components/artifacts/` | Artifact 面板、徽标、预览、渲染器 |
| `src/renderer/components/scheduledTasks/` | 定时任务 UI |
| `src/renderer/components/im/` | IM 平台配置与多实例 UI |
| `src/renderer/components/skills/` | 技能管理 UI |
| `src/renderer/components/mcp/` | MCP 管理 UI |
| `src/renderer/services/i18n.ts` | 渲染层 i18n 字典与 `t()` |
| `src/main/i18n.ts` | 主进程 i18n |
| `SKILLs/` | 内置技能（`SKILLs/skills.config.json` 列出全部） |
| `openclaw-extensions/` | 本地执行引擎扩展源，由 `npm run openclaw:extensions:local` 同步进 runtime |

### 企业服务端

| 路径 | 用途 |
| --- | --- |
| `enterprise_server/src/server.ts` | Hono 应用 + node:http 监听，挂载全部路由 |
| `enterprise_server/src/auth/` | JWT、密码哈希、`requireCapability` 中间件 |
| `enterprise_server/src/db/` | Pool、pglite、迁移 |
| `enterprise_server/src/db/migrations/` | 幂等 SQL 迁移；通过 `_migrations` ledger 应用 |
| `enterprise_server/src/models/` | 模型目录、token 用量、应用发布 |
| `enterprise_server/src/org/` | 部门、岗位、用户 CRUD，内置套件 / Provider 种子 |
| `enterprise_server/src/vault/` | Provider Key AES-GCM 加解密 |
| `enterprise_server/src/proxy/` | `/proxy/openai\|anthropic\|deepseek` 上游代理 + 配额 + 审计 |
| `enterprise_server/src/audit/` | 审计日志读写 |
| `enterprise_server/src/policies/` | MCP / 技能策略 |
| `enterprise_server/src/setup/` | 邀请码服务 |
| `enterprise_server/src/archives/` | 组织级归档 |
| `enterprise_server/src/routes/` | HTTP handler（auth、admin/*、proxy、audit、sso、marketplace…） |
| `enterprise_server/src/shared/` | 跨进程常量（AuditAction 枚举等） |
| `enterprise_server/web/` | 管理控制台 SPA（Vite + React 19 + TanStack Query + Zustand） |
| `enterprise_server/web-dist/` | 控制台构建产物（`web:build` 输出） |
| `enterprise_server/tests/` | vitest 用例（pglite） |

---

## 数据、日志与状态位置

### 桌面端

- 应用数据：`<userData>/genwork.sqlite`
- 执行引擎状态、记忆、生成配置、网关日志：`<userData>/openclaw/`
- 主 Agent 工作区：`workspace-main`；非主 Agent：`workspace-<agentId>`
- 主进程日志（保留 7 天，80 MB 轮转）：
  - macOS：`~/Library/Logs/GenWork/main-YYYY-MM-DD.log`
  - Windows：`%APPDATA%/GenWork/logs/main-YYYY-MM-DD.log`
  - Linux：`~/.config/GenWork/logs/main-YYYY-MM-DD.log`
- 网关抓取日志（保留 3 天）：
  - macOS：`~/Library/Logs/GenWork/openclaw/gateway-YYYY-MM-DD.log`
  - Windows：`%APPDATA%/GenWork/openclaw/logs/gateway-YYYY-MM-DD.log`

### 企业服务端

- 数据库：Postgres（按 `DATABASE_URL`）
- 服务端日志：stdout（容器场景走 `docker logs` / `kubectl logs` 收集）
- 备份：每日 `pg_dump`，归档 `token_usage` 旧数据到对象存储

---

## 安全说明

- **桌面端渲染层**：`contextIsolation` 开启、`nodeIntegration` 关闭、sandbox 启用；渲染层到主进程只能通过 `src/main/preload.ts` 声明的 IPC API。
- **敏感动作**：工具调用前必须经权限门控并记录。
- **企业服务端**：
  - Provider Key 用 AES-256-GCM 静态加密，密钥从 `GENWORK_VAULT_MASTER_KEY` 派生。
  - `GET /admin/provider-keys` 只返回 `api_key_masked`，从不返回明文。
  - 越权（`admin_access_denied`）一律 fail-closed（读 + 写），跨组织访问返回 404 不泄露存在性，内置角色 409 锁定不可删除。
  - 所有管理操作写审计，区分权限点缺失（`target_type=route`）与数据范围外（`target_type=user`, `reason=outside_scope`）。
- **桌面 SSO**：OAuth 回调走 loopback 端口（`53231`）的临时 `BrowserWindow`，`webRequest` 只放行注册的 `eTLD+1` 白名单（含 302 重定向后的 IdP 域名）。
- **桌面 SSO 令牌**：由企业 JWT（Org 登录产生）覆盖 consumer 令牌，不能与个人模式混用。

---

## 社区与支持

- **问题反馈 / 功能建议**：使用仓库 issue 模板
- **PR 规范**：
  - 提交信息使用英文，遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:`、`fix:`、`refactor:` 等）
  - 分支名：`feat/...` 或 `fix/...`，**不要**用 `codex/...` 前缀（除非显式要求）
  - PR 描述：简要说明、相关 issue 链接、UI 改动截图、Electron IPC / 存储 / 窗口行为变更说明
- **国际化**：用户可见文案必须用 `t('key')` 包裹，并同时提供中英文翻译

---

## 许可证

[MIT License](LICENSE)

由 GenWork 团队开发维护。
