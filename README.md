<h1 align="center">
  <img src="public/genwork.png" alt="GenWork" width="96"><br>
  GenWork
</h1>

<p align="center">
  English · <a href="README_zh.md">中文</a>
</p>

<p align="center">
  <strong>An all-scenario Enterprise Agent platform.</strong><br/>
  Desktop Agent collaboration + Enterprise server governance + Unified admin console
</p>

---

## Table of Contents

- [What Is GenWork](#what-is-genwork)
- [Core Capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Enterprise-Side Installation & Deployment](#enterprise-side-installation--deployment)
- [User-Side Installation & Deployment](#user-side-installation--deployment)
- [Development Guide](#development-guide)
  - [4. Enterprise Server Development](#4-enterprise-server-development)
  - [4.5 Packaging the Production Docker Image](#45-packaging-the-production-docker-image)
  - [5. Full End-to-End Smoke Test](#5-full-end-to-end-smoke-test)
- [Testing & Quality Gates](#testing--quality-gates)
- [Project Structure](#project-structure)
- [Data, Logs, and State Locations](#data-logs-and-state-locations)
- [Security](#security)
- [Community & Support](#community--support)
- [License](#license)

---

## What Is GenWork

GenWork is a **desktop-grade Enterprise Agent** built for real corporate work environments. It fuses LLM-driven agent capabilities with the local office toolchain, giving every employee an AI coworker on their own desktop that can execute real tasks — reading and writing local files, running shell commands, operating the browser, generating Word / Excel / PPT / PDF documents, sending and receiving email, connecting to IM channels, and completing cross-system composite office tasks under organizational authorization.

GenWork is composed of three cooperating parts:

- **GenWork Desktop (Client)** — a cross-platform desktop application built on Electron + React 18 + Redux Toolkit, the entry point employees use every day.
- **GenWork Enterprise Server** — a multi-tenant backend on Node.js + Hono + PostgreSQL that delivers unified identity authentication, organization / department / role management, model proxying and quotas, audit logs, policy distribution, the app marketplace, SSO bindings, and more.
- **Enterprise Web Console** — a React SPA shipped inside the Enterprise Server. Administrators can use the browser to perform operations: organization initialization, user management, model and provider configuration, skill / MCP review, audit queries, and app distribution.

What "enterprise-grade" means in GenWork has four concrete manifestations:

1. **Multi-tenant isolation** — the server supports multiple organizations (Orgs) coexisting with strict data isolation between them. Cross-org access returns 404 directly and never leaks existence.
2. **Enterprise-grade permission model** — a two-axis model based on "fine-grained capability points (module:action) × data scope (DataScope)". Capability and data scope are evaluated and audited independently; any cross-tier escalation is fail-closed.
3. **Enterprise-grade model governance** — the server acts as a unified proxy for LLM providers. API keys are encrypted at rest with AES-256-GCM. Models and quotas can be distributed per organization / role, and every call generates audit and usage records.
4. **Enterprise-grade control channel** — administrators can use the server to push down the model catalog, expert kits, MCP / skill marketplace, SSO bindings, and app updates to all desktops. After login, the desktop client syncs these configurations automatically; end users never have to do anything manually.

GenWork works equally well as a personal desktop Agent or as an enterprise IT platform for unified procurement, distribution, governance, and auditing. This document covers installation, deployment, and development for **all scenarios**.

---

## Core Capabilities

### Desktop Capabilities

#### Cowork Long-Running Sessions

Run long-form Agent tasks against local projects and files. GenWork streams progress in real time, persists session history, renders tool output, and asks for explicit approval before sensitive actions such as file operations, shell commands, or network access.

The screenshot below shows a real scenario: the Agent receives a scan of handwritten notes on e-commerce warehouse cost and profit, identifies 6 ambiguous points and proactively labels them with "「?待确认」" for the user to confirm; on the right it generates a structured cost / profit settlement logic document in real time, with downloadable Markdown and HTML artifacts.

<p align="center">
  <img src="docs/res/desktop-screenshot.png" alt="GenWork Desktop: long-running session with real-time artifact generation" width="960">
</p>

#### Multi-Agent Workflows

Create custom Agents with their own identity, model choice, skills, working directory, enable state, and IM bindings. The Main Agent handles general work, while specialized Agents cover repeatable roles (e.g., weekly report generation, candidate screening, research-note writing).

#### Expert Kits

Scenario-oriented capability bundles. Administrators publish kits from the admin console, and users get the full "capability selection + reference material + workflow template" package with one click. Kits and individual skills can be freely combined.

#### Skills

GenWork ships with 29 built-in skills, covering web search, Word documents, Excel spreadsheets, PowerPoint, PDF processing, Remotion video generation, browser automation, image / video generation, stock research, content writing, email, weather, skill creation, and more. The Enterprise Server also provides a skill marketplace with submission review.

#### MCP Servers

Plug in external tools and data sources through Model Context Protocol. GenWork stores user-configured MCP servers locally and syncs the enabled ones to the execution engine. Administrators can govern the available MCP set through the server's marketplace and submission review.

#### Scheduled Tasks

Create recurring work either by conversation or through the scheduled task UI. Ideal for daily news digests, inbox summaries, website monitoring, weekly reports, and other repeatable jobs.

#### IM Remote Control

Reach your desktop Agent from WeChat, WeCom, DingTalk, Feishu / Lark, QQ, Telegram, Discord, NetEase IM, NetEase Bee, POPO, and email. On multi-instance platforms you can bind different accounts or channels to different Agents.

#### Rich Artifacts

Preview and manage generated HTML, SVG, images, video, Mermaid diagrams, code, Markdown, text, documents, and local-service artifacts inside the desktop. HTML / SVG are safely rendered through a local preview server or a sandboxed iframe.

#### Local Memory & Data

Sessions and app data live in a local SQLite database. Agent workspace memory uses files such as `MEMORY.md`, `USER.md`, `SOUL.md`, and daily notes, so durable preferences and project context can carry across sessions.

### Enterprise Server Capabilities

| Module | Capability |
| --- | --- |
| **Multi-tenant & organization** | Multi-Org isolation; org name registration; org-scoped users, department tree, positions |
| **Authentication & SSO** | Local account / password (bcryptjs); SSO bindings (Feishu and other IdPs); JWT (HS256) issuance and validation |
| **Permission model** | Two-axis "fine-grained capability point × data scope"; 41 built-in capability points; 5 DataScope values; fail-closed enforcement |
| **Users & roles** | Department tree, role CRUD, built-in role protection (cannot be deleted); bulk operations; user invitations |
| **Model catalog** | Per-organization model import and distribution; built-in provider templates (OpenAI, Anthropic, DeepSeek, GenWork Server, etc.) |
| **Provider key vault** | AES-256-GCM encryption at rest; only `api_key_masked` is returned; role-based access |
| **Model proxy** | Unified `/proxy/<provider>` proxy; per-org / per-role quota; full audit |
| **Audit logs** | Every operation audited; violations logged as `admin_access_denied`, distinguishing "missing capability point" from "outside data scope" |
| **Usage statistics** | Token usage, call count, model distribution |
| **Expert kits** | Server-side kit publishing; on-demand pull by the client |
| **Skill marketplace** | Server-hosted skill marketplace + submission review |
| **MCP marketplace** | Server-hosted MCP connector marketplace + submission review |
| **Agent marketplace** | Server-hosted Agent template marketplace + submission review |
| **App distribution** | Desktop update checks, installer download and signature verification |
| **HTML share** | Generate artifact share pages that are either public or restricted to the Org |
| **Archives** | Organization-level archive storage on the server |

The screenshot below shows the "Model Configuration" page: the left side groups built-in providers and custom providers, with per-provider on/off switches; the right side configures the Base URL, API protocol (OpenAI-compatible / Anthropic-compatible), a Coding Plan dedicated endpoint, and the encrypted API Key. The provider's model list sits below (model name, type, context window, enabled state, actions). All API keys are encrypted with AES-256-GCM upon submission, and the list only shows masked values.

<p align="center">
  <img src="docs/res/enterprise-console-screenshot.png" alt="GenWork admin console: model configuration" width="960">
</p>

### Real-World Prompts

| Scenario | Example prompt |
| --- | --- |
| Build a local system | "I still track inventory and sales in Excel. Build a local inventory system that records purchases and sales, calculates stock and profit, and opens in my browser." |
| Analyze local data | "Use `product-growth.xlsx` to build a visual dashboard and summarize the main growth drivers." |
| Generate a deck | "Research the AI Agent market and turn the findings into a presentation." |
| Automate browser checks | "Open the ads dashboard every morning, check spend and conversion anomalies, and summarize likely causes." |
| Screen documents | "Turn the resumes in this folder into a screening sheet and shortlist the strongest candidates against the JD." |
| Run scheduled work | "Every weekday at 9 AM, collect yesterday's AI news and send me a concise digest." |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                Enterprise admin's browser                       │
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
│                  Employee desktop (GenWork Desktop)            │
│   Electron 40 + React 18 + Redux Toolkit + Tailwind             │
│   Renderer  ⇄  Main (IPC)  ⇄  Cowork Store (SQLite)             │
│   Agents • Skills • MCP • IM • Scheduled Tasks • Artifacts      │
└────────────────────────────────────────────────────────────────┘
```

The desktop is offline-first: local SQLite holds sessions and app data; every enterprise-grade configuration (model catalog, kits, MCP, skill marketplace, SSO bindings, app updates) is pushed down by the Enterprise Server on login.

---

## Enterprise-Side Installation & Deployment

> Goal: deploy the GenWork Enterprise Server (including the admin console) inside the organization, and push enterprise configuration down to all employee desktops.

For production deployment on a customer-managed Linux host, see
[`docs/enterprise-server-deploy.md`](docs/enterprise-server-deploy.md). That
document covers the Docker image, the `genwork-server` CLI, TLS termination,
upgrades, and backups. The architecture overview, env-var reference, and
local-dev "Quick Start" remain below for development.

### 1. Architecture & Ports

| Component | Default port | Protocol | Notes |
| --- | --- | --- | --- |
| Enterprise Server (with SPA) | `8787` (override via `PORT`) | HTTPS (recommended; TLS terminated upstream) | Main service, admin console, and API are all same-origin |
| PostgreSQL | `5432` (in container) | TCP | The only external dependency for the server; pglite is for vitest only |
| Desktop SSO callback (loopback) | `53231` | HTTP | OAuth callback on the desktop; `127.0.0.1` only — **listened on by the desktop, not exposed externally** |
| Web SPA SSO callback | Same Enterprise Server (e.g. `https://<host>/auth/sso/callback`) | HTTPS | Server exchanges `code` for JWT; the IdP must register this callback URL |

### 2. Environment Dependencies

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | `>=24.13` | Matches `enterprise_server/package.json`; server ships with `tsx` |
| PostgreSQL | `14+` | Local, Docker, or a reachable remote instance; pglite **must not** be used in production |
| Operating system | macOS / Linux / Windows Server | Any; Linux recommended for long-term hosting |
| TLS certificate | Provided by the fronting proxy (nginx / Caddy / cloud LB) | HTTPS strongly recommended; the matching desktop `ENTERPRISE_SERVER_URL` must also be `https://` |
| Optional: object storage | S3 / OSS / COS compatible | Used for `token_usage` cold archival |

### 3. Required Environment Variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://user:pass@host:5432/db` |
| `JWT_SECRET` | ✅ | HS256 signing key, **≥ 32 characters**; generate with `openssl rand -hex 32` |
| `GENWORK_VAULT_MASTER_KEY` | ✅ | Master key for provider key encryption; must be a 32-byte base64 string; generate with `openssl rand -base64 32`. **Loss = all provider keys unrecoverable** |
| `PORT` | ❌ | HTTP listen port, default `8787` |
| `WEB_DIST_DIR` | ❌ | Override the bundled SPA directory, default `<cwd>/web-dist` |
| `SSO_DESKTOP_REDIRECT_PORT` | ❌ | Desktop SSO loopback port, default `53231` |

> ⚠️ The server **refuses to start** if `JWT_SECRET` or `GENWORK_VAULT_MASTER_KEY` is missing. Both are **read at startup only** — a restart is required to pick up changes. Rotating `JWT_SECRET` invalidates all existing sessions; rotating `GENWORK_VAULT_MASTER_KEY` makes all provider keys unreadable (must be re-entered).

### 4. Quick Start (First-Time Deployment)

```bash
# 1. Clone and install root dependencies (workspaces will install enterprise_server)
git clone https://github.com/genwork/genwork.git
cd GenWork
npm install

# 2. Bring up PostgreSQL (pick one)
#    Option A: Docker
docker run -d --name genwork-pg \
  -e POSTGRES_USER=genwork \
  -e POSTGRES_PASSWORD=genwork \
  -e POSTGRES_DB=genwork \
  -p 5432:5432 \
  postgres:16
#    Option B: existing Postgres — create a database + role and use that in DATABASE_URL

# 3. Prepare the Enterprise Server .env
cd enterprise_server
cp .env.example .env
# Edit .env and fill in:
#   DATABASE_URL=postgres://genwork:genwork@localhost:5432/genwork
#   JWT_SECRET=<openssl rand -hex 32>
#   GENWORK_VAULT_MASTER_KEY=<openssl rand -base64 32>

# 4. Build the admin console SPA (required on first install and after upgrade)
npm run web:install
npm run web:build
cd ..

# 5. Start the Enterprise Server
npm run enterprise:dev
# Listens on http://0.0.0.0:8787 ; SQL migrations run automatically on the first start

# 6. Open the browser and run the setup wizard
#    http://<server-host>:8787/setup
#    Enter the org name (e.g. "Acme Corp") → receive an invite code → create the Super Admin
#    After that, /api/setup/* is permanently closed (HTTP 410). To re-open:
#    npm run reinit --workspace=enterprise_server
```

### 5. First-Login Setup

After step 4, log in to the admin console at `/login` using **org name + username + password**. We recommend completing these immediately:

1. **Import a provider key** — go to "Provider & Models" and enter at least one LLM provider's API key for the current org (OpenAI, Anthropic, DeepSeek, GenWork Server, etc.). Keys are encrypted at rest; the plaintext is never returned.
2. **Create departments / roles / users** — under "Organization", build a department tree, define roles, and invite colleagues. **Built-in roles** (`super_admin`, `org_admin`, `model_admin`, `policy_admin`, `auditor`, all `dept_admin`, all `member`) **cannot be deleted**.
3. **Publish kits / skills / MCP / Agent** (optional) — upload or import through "Marketplace"; once reviewed, they appear in the desktop's marketplace.
4. **Configure SSO** (optional) — in "SSO Bindings", enter IdP credentials and the callback URL template, so employees can log in to the desktop via SSO.
5. **Configure app distribution** (optional) — in "Versions", upload the desktop installer; the desktop will check for updates on startup.

### 6. Desktop Integration

To connect the desktop to the Enterprise Server, you need to **bake** `ENTERPRISE_SERVER_URL` into the desktop installer at build time (or override it at startup via MDM / shell variable):

```bash
# Root .env (add to .gitignore)
ENTERPRISE_SERVER_URL=https://<enterprise-host>:8787
```

After the desktop installer starts, choose "Enterprise" on the login page and log in with your org name + credentials (password or SSO). The desktop will pull the model catalog, kits, and SSO bindings from the Enterprise Server, and report usage and audit data according to the server's policies.

For production deployment (TLS termination, upgrades, backups, common
operations), see [`docs/enterprise-server-deploy.md`](docs/enterprise-server-deploy.md).

---

## User-Side Installation & Deployment

> Audience: end employees, desktop users.

### 1. Enterprise Mode Only (Recommended for Enterprise Users)

If your company has already deployed the GenWork Enterprise Server, you only need the desktop installer + login credentials:

1. Get the latest installer (macOS / Windows / Linux) from your company's IT channel.
2. After installing, launch the app and choose "Enterprise" on the login page.
3. Fill in the information your IT team gave you:
   - **Org name** (not the org id — e.g. `Acme Corp`)
   - **Username** and **password** (or choose SSO via your IdP)
4. After login, the desktop will automatically sync the model catalog, kits, skill marketplace, and MCP marketplace from the Enterprise Server.

**System requirements:**

| Platform | Minimum version | Notes |
| --- | --- | --- |
| macOS | macOS 12 Monterey+ | Universal installer supports both Intel and Apple Silicon |
| Windows | Windows 10 1803+ | Requires built-in `tar.exe`; no separate Python install needed |
| Linux | glibc 2.31+ distributions (Ubuntu 20.04+, Debian 11+, RHEL 8+, etc.) | AppImage / deb / rpm — your choice |

### 2. Standalone Use (Personal / Small Teams)

If you don't connect to the Enterprise Server, you can use Personal mode directly:

1. Choose "Personal / Local" on the login page.
2. 29 built-in skills + custom Agents + IM channels are available out of the box.
3. Configure API keys for your own models under "Settings → Providers & Models" in the desktop (OpenAI, Anthropic, DeepSeek, etc.). Keys are stored only in your local SQLite.
4. All data (sessions, memory, artifacts) stays local; you can later connect to the Enterprise Server for a smooth migration to enterprise mode.

### 3. Download Channels

| Channel | Notes |
| --- | --- |
| Official site [genwork.app](https://genwork.app/) | Always the latest stable build |
| Internal enterprise channel | Hosted by IT; the URL is injected into the installer either at build time or via the `ENTERPRISE_SERVER_URL` env var on startup |
| GitHub Releases | Historical versions and betas |

### 4. Data & Log Locations (User Side)

- **App data**: `<userData>/genwork.sqlite`
  - macOS: `~/Library/Application Support/GenWork/genwork.sqlite`
  - Windows: `%APPDATA%/GenWork/genwork.sqlite`
  - Linux: `~/.config/GenWork/genwork.sqlite`
- **Main process logs**: 7-day retention, 80 MB per file before rotation
  - macOS: `~/Library/Logs/GenWork/main-YYYY-MM-DD.log`
  - Windows: `%APPDATA%/GenWork/logs/main-YYYY-MM-DD.log`
  - Linux: `~/.config/GenWork/logs/main-YYYY-MM-DD.log`
- **Agent workspace memory**: `<userData>/openclaw/state/workspace-{agentId}/` (the main Agent is `workspace-main`), containing `MEMORY.md`, `USER.md`, `SOUL.md`, and daily notes `memory/YYYY-MM-DD.md`
- **Execution engine logs**: `<userData>/openclaw/logs/gateway-*.log`, 3-day retention

---

## Development Guide

> Audience: developers working on GenWork Desktop or the Enterprise Server.

### 1. Repository Layout

This repository is a single npm workspaces monorepo:

```
GenWork/
├── src/                       # Desktop (Electron Main + Renderer)
├── enterprise_server/         # Enterprise server (Node.js + Hono + PostgreSQL)
├── enterprise_server/web/     # Admin console SPA (Vite + React 19 + TanStack Query + Zustand)
├── SKILLs/                    # Built-in skills
├── scripts/                   # Build, package, runtime, signing, migration scripts
├── docs/                      # Architecture & deployment docs
├── electron-builder.json
├── package.json               # Root package.json (workspaces include enterprise_server)
└── .env.example               # Desktop build-time config (ENTERPRISE_SERVER_URL, etc.)
```

### 2. Environment Dependencies

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | `>=24.15.0 <25` (matches `package.json` `engines`) | Required by the root project; `.nvmrc` also points to 24 |
| npm | Bundled with Node | Workspaces use the npm protocol |
| PostgreSQL | `14+` | Enterprise server dependency; Docker works |


### 3. Desktop Development

#### 3.1 First-Time Startup

```bash
git clone https://github.com/genwork/genwork.git
cd GenWork
npm install
# First launch will automatically build the execution runtime the desktop needs (takes a few minutes)
npm run electron:dev:openclaw
# For everyday development after that:
npm run electron:dev
```

- Renderer dev server: `http://localhost:5175` (`strictPort` — occupied port is an error, not a silent fallback)
- The Electron main process waits for both `http://localhost:5175` and `dist-electron/.electron-ready` before booting (via `wait-on`)
- Main process entry: `dist-electron/main.js` (bundled by vite-plugin-electron), **not** the tsc output at `dist-electron/main/main.js`

#### 3.2 Common Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite renderer dev server only (Electron not started) |
| `npm run electron:dev` | Daily development: compile Electron + Vite, then start Electron |
| `npm run electron:dev:openclaw` | For first run or after a runtime upgrade: build the execution runtime first, then start |
| `npm run build` | Production renderer bundle |
| `npm run compile:electron` | Compile Electron main / preload TypeScript |
| `npm test` | Vitest entry (this is what CI uses) |
| `npm run lint` | Full ESLint across the repo (may surface legacy debt) |
| `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` | CI-style strict lint on changed files |
| `npm run build:skills` | Compile built-in skills (`web-search`, `tech-news`, `imap-smtp-email`) |

#### 3.3 OpenClaw / dsh Runtime Variables

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_SRC` | Override the execution engine source path, default `../openclaw` |
| `OPENCLAW_SKIP_ENSURE=1` | Skip the automatic checkout (handy for local changes) |
| `OPENCLAW_FORCE_BUILD=1` | Force a runtime rebuild |

> The runtime scripts (`openclaw:runtime:host`, `dsh:runtime:*`) are used to build the local execution engine that ships inside the desktop installer. **They are only needed when adjusting the execution engine or upgrading dsh**; everyday UI work does not need them.

#### 3.4 Desktop Environment Variables (`.env`)

```bash
# The Enterprise Server URL the desktop will connect to when logging in; baked into the installer
ENTERPRISE_SERVER_URL=https://<enterprise-host>:8787
```

The build-time baked URL is the default at user login. At startup, the `ENTERPRISE_SERVER_URL` env var can still override it (MDM / terminal startup scenarios).

#### 3.5 Desktop Packaging

```bash
# macOS (any single target)
npm run dist:mac          # default
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:mac:universal

# Windows
npm run dist:win
# Windows packaging automatically sets up the Python runtime and embeds mingit if needed

# Linux
npm run dist:linux
```

Packaging bakes the execution engine runtime into `Resources/openclaw-runtime`; Windows builds also bake in portable Python under `resources/python-win`. End users do not need to install either manually.

Environment variables for offline / private-source packaging:

- `GENWORK_PORTABLE_PYTHON_ARCHIVE`
- `GENWORK_PORTABLE_PYTHON_URL`
- `GENWORK_WINDOWS_EMBED_PYTHON_VERSION`
- `GENWORK_WINDOWS_EMBED_PYTHON_URL`
- `GENWORK_WINDOWS_GET_PIP_URL`

### 4. Enterprise Server Development

```bash
# Install Enterprise Server dependencies (first time)
npm run enterprise:install

# Bring up local Postgres
docker run -d --name genwork-pg \
  -e POSTGRES_USER=genwork \
  -e POSTGRES_PASSWORD=genwork \
  -e POSTGRES_DB=genwork \
  -p 5432:5432 \
  postgres:16

# Prepare .env
cd enterprise_server
cp .env.example .env
# Fill in DATABASE_URL / JWT_SECRET / GENWORK_VAULT_MASTER_KEY

# Run the server and admin console SPA together
npm run dev          # Server (tsx watch, auto-restart on file changes)
npm run web:dev      # Admin console SPA (Vite, independent dev server)
# Open http://localhost:5173 in the browser to integrate

# Or via root script:
# npm run enterprise:dev  =  npm run dev --workspace=enterprise_server
```

Server test suites:

```bash
# Server (pglite, no Postgres needed)
npm run enterprise:test

# Admin console (SPA, jsdom)
npm run web:test --workspace=enterprise_server
```

### 4.5 Packaging the Production Docker Image

> `docs/enterprise-server-deploy.md` covers how to **run** the image on a
> production host (TLS, `genwork-server` CLI, upgrades, backups). This
> section covers how to **build** it.

The recommended entry point is `scripts/package-enterprise-server.sh`,
which builds the Dockerfile's three stages (`web-build` → `build` →
`runtime`) into a version-tagged image and prints the next-step commands
on success.

```bash
# 4.5.1 Build only — defaults to the legacy builder to avoid a known
# buildkit stale-result-ref issue on docker-desktop; CI can opt back in
USE_BUILDKIT=1 ./scripts/package-enterprise-server.sh --tag v2026.10.19
# → Successfully tagged enterprise-server:v2026.10.19-<short-sha>

# 4.5.2 Push directly to an internal registry (multi-arch needs --push)
./scripts/package-enterprise-server.sh --tag v2026.10.19 \
    --registry registry.internal/genwork --push

# 4.5.3 Multi-arch
./scripts/package-enterprise-server.sh --tag v2026.10.19 \
    --platform linux/amd64,linux/arm64 --push
```

Image naming:

- **Default** `enterprise-server:v<version>-<short-sha>` (single-segment;
  matches the `IMAGE_REPO` default in `docker-compose.yml` and in
  `genwork-server upgrade`, so `docker compose up -d` works with no env
  override)
- OCI tag chars: `[a-zA-Z0-9._-]` only — `+` is rejected by `docker push`
- `--tag` defaults to `dev-<short-sha>` when omitted

Other flags:

- `--env-file <path>` + `--generate-secrets`: writes `JWT_SECRET` and
  `GENWORK_VAULT_MASTER_KEY` (generated via `openssl rand`) into the
  specified file. The image itself never bakes secrets — they are passed
  at runtime via `env_file:` or `docker run -e`
- `--load-only`: same as `--load`, local docker daemon only, no push

> A more minimal `scripts/build-enterprise-image.sh` is also kept as the
> CI-equivalent entry point (raw `docker buildx` + sha tag). It skips the
> lockfile preflight, the OCI-tag char check, and the help/printout that
> `package-enterprise-server.sh` adds. **Prefer the new script for all
> manual builds.**

#### 4.5.1 Pushing to an internal registry

```bash
docker tag enterprise-server:v2026.10.19-abcd123 \
    registry.internal/genwork/enterprise-server:v2026.10.19-abcd123

docker push registry.internal/genwork/enterprise-server:v2026.10.19-abcd123
```

CI does this automatically (see
`.github/workflows/enterprise-server-image.yml`); run the above locally
only when you need to push from a build host. After it's in the internal
registry, the production host can run:

```bash
genwork-server upgrade --to v2026.10.19-abcd123
```

#### 4.5.2 Quick rebuild + integration smoke test

```bash
# After editing enterprise_server/src/*.ts or web/ source
./scripts/package-enterprise-server.sh --tag v2026.10.19-dev

# Run the production compose stack end-to-end
docker compose -f enterprise_server/docker-compose.yml up -d
curl -fsS http://127.0.0.1:8787/health
# → {"ok":true}
```

Key facts about the smoke-test stack:

- The image `ENTRYPOINT` is `tini + node /app/repo/dist/cli/index.js` —
  i.e. the CLI itself, **without** a `genwork-server` prefix (`genwork-
  server` is a shim created on the production host by the `init`
  subcommand, and does not exist inside the container)
- `docker-compose.yml` injects `DATABASE_URL=postgres://genwork:genwork@
  host.docker.internal:5434/genwork` so the container can reach a Postgres
  running on the docker host; override that line for any other DB
- Health endpoints are `/health` (returns `{"ok":true}`) and
  `/api/health` (returns `{"ok":true}` plus the SPA's `index.html`)

#### 4.5.3 CLI inside the image

```bash
docker run --rm enterprise-server:v2026.10.19-abcd123 version
# → genwork-server v2026.10.19-abcd123

docker run --rm enterprise-server:v2026.10.19-abcd123 help
```

`start` runs migrations automatically. For a manual migration dry-run:

```bash
docker run --rm \
    --env-file enterprise_server/.env \
    -e GENWORK_MIGRATE_DRY_RUN=1 \
    enterprise-server:v2026.10.19-abcd123 \
    migrate
```

#### 4.5.4 ESM import suffix workaround

`enterprise_server` source uses bundler-style relative imports without a
`.js` suffix (`from '../db/pool'`, not `'../db/pool.js'`). `tsc` with
`moduleResolution: Bundler` preserves this style in the emitted `.js`
files, which Node's ESM loader rejects (`ERR_MODULE_NOT_FOUND`).

The Dockerfile's `build` stage runs
`enterprise_server/scripts/patch-esm-imports.mjs` immediately after
`tsc`. The patcher appends `.js` to every relative import (skipping ones
whose target file does not exist, so dynamic imports and npm packages
are left alone). It also `COPY`s `src/db/migrations/*.sql` into
`dist/db/migrations/` explicitly because `tsc` doesn't process non-TS
files.

Once the enterprise_server source migrates to NodeNext-style imports
(`./foo.js`), the patcher can be removed from the Dockerfile.

### 5. Full End-to-End Smoke Test

Recommended flow for a desktop + Enterprise Server integration:

1. `npm run enterprise:dev` (server listening on `8787`)
2. Set `ENTERPRISE_SERVER_URL=http://localhost:8787` in the desktop's `.env`
3. `npm run electron:dev` to start the desktop
4. On the desktop login page, choose "Enterprise", pick any org name, follow the `/setup` flow to create an org + super admin, then log back in from the desktop
5. Verify: model catalog pulled from the server, calls work after a provider key is entered, and audit logs are visible in the server's `/admin/audit`

---

## Testing & Quality Gates

| Scenario | What to run |
| --- | --- |
| Modified TypeScript / TSX | `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` |
| Desktop business logic | `npm test -- <keyword>` to select a Vitest subset |
| Enterprise server | `npm run enterprise:test` (pglite isolated) |
| Admin console | `npm run web:test --workspace=enterprise_server` |
| Full CI run | `npm test` (vitest run, root + workspaces) |

> The repo has historical lint debt, so a full `npm run lint` may surface old issues; this project's CI only lints changed files. **Do not** add broad `eslint-disable` to make lint pass.

### Test Data & Stability

- Enterprise server tests use pglite (in-process Postgres via WASM), no local Postgres required. With a real Postgres, run unit tests file by file (sandbox occasionally hits fd limits)
- In desktop tests, `mockImplementationOnce` and the throttle cache can leak across cases — call `agentEnterpriseSyncThrottle._reset()` in `beforeEach` to clean up
- The real desktop entry is `dist-electron/main.js` (bundled by vite), not the tsc output `dist-electron/main/main.js`

---

## Project Structure

### Desktop

| Path | Purpose |
| --- | --- |
| `src/main/main.ts` | Electron lifecycle, IPC registration, auth, logging, runtime startup, service wiring |
| `src/main/preload.ts` | contextBridge exposing controlled IPC APIs to the renderer |
| `src/main/coworkStore.ts` | Sessions, messages, config, agents, memory metadata + SQLite CRUD |
| `src/main/sqliteStore.ts` | Database initialization and migrations |
| `src/main/auth/` | Enterprise login, SSO, provider key vault client |
| `src/main/agentManager.ts` | Agent CRUD and preset installation |
| `src/main/skills/skillManager.ts` | Built-in / user skill sync, install, security scan, enable state |
| `src/main/im/` | IM gateway config, status, delivery, session mapping, media, pairing |
| `src/scheduledTask/` | Scheduled task model, cron service, local metadata |
| `src/main/mcp/` | MCP server storage, runtime, marketplace, launch resolution |
| `src/renderer/` | Renderer (React 18 + Redux Toolkit + Tailwind) |
| `src/renderer/components/cowork/` | Session UI, prompt input, permissions, thinking / tool display, voice input |
| `src/renderer/components/agent/` | Agent creation and settings UI |
| `src/renderer/components/agentSidebar/` | Agent / session tree and subagent session UI |
| `src/renderer/components/artifacts/` | Artifact panel, badges, preview cards, renderers |
| `src/renderer/components/scheduledTasks/` | Scheduled task list, form, detail, run history, templates |
| `src/renderer/components/im/` | IM platform configuration and multi-instance UI |
| `src/renderer/components/skills/` | Skill management UI |
| `src/renderer/components/mcp/` | MCP management UI |
| `src/renderer/services/i18n.ts` | Renderer i18n dictionary and `t()` helper |
| `src/main/i18n.ts` | Main process i18n |
| `SKILLs/` | Built-in skills (full list in `SKILLs/skills.config.json`) |
| `openclaw-extensions/` | Local execution engine extension sources, synced into the runtime by `npm run openclaw:extensions:local` |

### Enterprise Server

| Path | Purpose |
| --- | --- |
| `enterprise_server/src/server.ts` | Hono app + node:http listener; mounts all routes |
| `enterprise_server/src/auth/` | JWT, password hashing, `requireCapability` middleware |
| `enterprise_server/src/db/` | Pool, pglite, migrations |
| `enterprise_server/src/db/migrations/` | Idempotent SQL migrations; applied via the `_migrations` ledger |
| `enterprise_server/src/models/` | Model catalog, token usage, app releases |
| `enterprise_server/src/org/` | Departments, positions, user CRUD, built-in kit / provider seeding |
| `enterprise_server/src/vault/` | AES-GCM encryption for provider keys |
| `enterprise_server/src/proxy/` | `/proxy/openai\|anthropic\|deepseek` upstream proxy + quota + audit |
| `enterprise_server/src/audit/` | Audit log read / write |
| `enterprise_server/src/policies/` | MCP / skill policies |
| `enterprise_server/src/setup/` | Invite code service |
| `enterprise_server/src/archives/` | Organization-level archives |
| `enterprise_server/src/routes/` | HTTP handlers (auth, admin/*, proxy, audit, sso, marketplace, etc.) |
| `enterprise_server/src/shared/` | Cross-process constants (AuditAction enum, etc.) |
| `enterprise_server/web/` | Admin console SPA (Vite + React 19 + TanStack Query + Zustand) |
| `enterprise_server/web-dist/` | Console build output (`web:build` target) |
| `enterprise_server/tests/` | Vitest cases (pglite) |

---

## Data, Logs, and State Locations

### Desktop

- App data: `<userData>/genwork.sqlite`
- Execution engine state, memory, generated config, gateway logs: `<userData>/openclaw/`
- Main Agent workspace: `workspace-main`; non-main Agents: `workspace-<agentId>`
- Main process logs (7-day retention, 80 MB rotation):
  - macOS: `~/Library/Logs/GenWork/main-YYYY-MM-DD.log`
  - Windows: `%APPDATA%/GenWork/logs/main-YYYY-MM-DD.log`
  - Linux: `~/.config/GenWork/logs/main-YYYY-MM-DD.log`
- Gateway capture logs (3-day retention):
  - macOS: `~/Library/Logs/GenWork/openclaw/gateway-YYYY-MM-DD.log`
  - Windows: `%APPDATA%/GenWork/openclaw/logs/gateway-YYYY-MM-DD.log`

### Enterprise Server

- Database: Postgres (per `DATABASE_URL`)
- Server logs: stdout (collect via `docker logs` / `kubectl logs` in container setups)
- Backups: daily `pg_dump`; archive `token_usage` old rows to object storage

---

## Security

- **Desktop renderer**: `contextIsolation` on, `nodeIntegration` off, sandboxing on. The renderer can only reach the main process through the IPC APIs declared in `src/main/preload.ts`.
- **Sensitive actions**: tool calls must pass through a permission gate and be logged.
- **Enterprise Server**:
  - Provider keys are encrypted at rest with AES-256-GCM, keyed from `GENWORK_VAULT_MASTER_KEY`.
  - `GET /admin/provider-keys` only returns `api_key_masked`; the plaintext is never returned.
  - Authorization failures (`admin_access_denied`) are always fail-closed (read + write). Cross-org access returns 404 without leaking existence; built-in roles are 409-locked and cannot be deleted.
  - Every admin operation is audited, distinguishing "missing capability point" (`target_type=route`) from "outside data scope" (`target_type=user`, `reason=outside_scope`).
- **Desktop SSO**: the OAuth callback goes through a temporary `BrowserWindow` on the loopback port (`53231`). `webRequest` only allows registered `eTLD+1` allowlist entries (including IdP domains after 302 redirects).
- **Desktop SSO tokens**: enterprise JWT (from the org login) overrides the consumer token and cannot be mixed with personal mode.

---

## Community & Support

- **Bug reports / feature requests**: use the repository's issue templates
- **Pull request rules**:
  - Commit messages in English, following [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, etc.)
  - Branch names: `feat/...` or `fix/...` — **do not** introduce a `codex/...` prefix unless explicitly asked
  - PR descriptions: a short summary, linked issue when relevant, screenshots for UI changes, and notes for Electron-specific behavior (IPC, storage, runtime, windowing) changes
- **Internationalization**: user-visible strings must be wrapped with `t('key')` and have both Chinese and English translations

---

## License

[MIT License](LICENSE)

Built and maintained by the GenWork team.
