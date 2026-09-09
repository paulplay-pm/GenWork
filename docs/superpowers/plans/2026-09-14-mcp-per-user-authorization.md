# Desktop Per-User MCP Authorization (v2.1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a desktop user's installed-MCP card list, any MCP that has an `authMethod` not yet satisfied shows an orange "需要认证" indicator and a "连接" button. Clicking drives the right auth flow for the MCP's transport + method (http/sse bearer · http/sse api-key · http/sse oauth · stdio bearer · stdio api-key · stdio oauth). On success the card flips to a green-dot authenticated state with its tool list visible. Toggling the enable switch on an unauthenticated MCP silently auto-opens its auth flow. The detail drawer also exposes a per-MCP "重新认证" action.

**Architecture:** Per-MCP `authMethod` is captured at install/edit time (matches the existing enterprise admin shape: `none | bearer | api-key | oauth`) and stored inside the existing `config_json` blob. An `auth_status` column is added to `mcp_servers` so the renderer can show the orange/green state without re-deriving. Credentials themselves are stored inside `config_json` (bearer: `headers.Authorization`; api-key: `headers[<header-name>]`; oauth: provider token under a `oauth` sub-key), masked on read. A single generic probe helper sends an MCP JSON-RPC `initialize` request, returns ok/401/network, and persists `last_probe_status` + `auth_status`. The flow dispatcher (`mcpAuthFlows.ts`) maps `(transportType, authMethod)` to one of three handlers; `qichacha` OAuth reuses a generalized browser-window helper extracted from `qichachaMcpAuth.ts`.

**Tech Stack:** TypeScript · Electron main/renderer · React + Tailwind · Vitest · SQLite (better-sqlite3) · MCP JSON-RPC over HTTP / SSE / stdio.

**Spec:** Locked design recorded in this conversation; no separate spec file is needed because the design is small and bounded.

## Global Constraints

- Conventional Commits in English, no `Co-Authored-By` trailers (per repo rules).
- All IPC channel names are exported as `as const` from `src/shared/mcp/constants.ts` and imported by both ends — never string literals at call sites.
- New user-visible strings go through `i18nService.t(...)` with both `zh` and `en` keys.
- MCP credentials are secrets: stored inside `config_json`, masked on read (e.g. `Authorization: 'Bearer ***'`), and never echoed back in full over IPC or logs.
- Vitest is the official test path (`npm test`). Tests live next to the source as `.test.ts`.
- Lint clean per `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` on every touched file.
- Typecheck clean per `npx tsc --project electron-tsconfig.json --noEmit` on every touched file.

---

## File map

**New:**
- `src/main/mcp/mcpAuthProbe.ts` — transport-aware MCP `initialize` probe + DB writeback.
- `src/main/mcp/mcpAuthFlows.ts` — flow dispatcher with three handlers (http, stdio, oauth) + per-MCP credential save.
- `src/main/mcp/oauthBrowserFlow.ts` — generalized OAuth browser-window helper extracted from `qichachaMcpAuth.ts`.
- `src/renderer/components/mcp/mcpAuthModal.tsx` — generic per-`authMethod` modal (bearer token / api-key header-name+value / oauth provider picker / stdio env-key).
- `tests/components/mcp/McpCard.auth.test.tsx` *(or co-located next to McpCard.tsx if pattern allows)* — see "Tests" below.

**Modified:**
- `src/shared/mcp/constants.ts` — new IPC channels: `StartAuth`, `SaveCredential`, `ProbeAuthorization` (string constants).
- `src/main/mcp/mcpStore.ts` — `McpServerRecord` gets `authMethod` + `authStatus`; SQLite schema gets an `auth_status TEXT` column with a tiny migration; helpers to derive + write `authStatus`.
- `src/main/mcp/qichachaMcpAuth.ts` — slim down to consume the new `oauthBrowserFlow` helper (kept as the qichacha provider config).
- `src/main/main.ts` — IPC handlers: `mcp:startAuth`, `mcp:saveCredential`, `mcp:probeAuthorization`. Modify `mcp:setEnabled` to gate on `authStatus`.
- `src/main/preload.ts` — expose the three new channels on `window.electron.mcp`.
- `src/renderer/services/mcp.ts` — wrapper methods `startAuth`, `saveCredential`, `probeAuthorization`.
- `src/renderer/components/mcp/McpManager.tsx` (or McpCard.tsx) — orange-dot + 连接 button when `authStatus === 'needs-auth'`; auto-open flow when setEnabled would otherwise fail authStatus gate.
- `src/renderer/components/mcp/McpDetailModal.tsx` — new footer action "重新认证".
- `src/renderer/components/mcp/McpServerFormModal.tsx` — `authMethod` selector + per-method fields at install time.
- `src/renderer/services/i18n.ts` — new keys (zh + en).

**Tests (new):**
- `src/main/mcp/mcpAuthProbe.test.ts` — mocked `initialize` responses: ok / 401 / 403 / network failure / stdio missing env key / oauth missing token.
- `src/main/mcp/mcpAuthFlows.test.ts` — each of the three flows; mocked IPC + DB.
- `src/main/mcp/mcpStore.authStatus.test.ts` *(or extended into existing `mcpStore.test.ts`)* — `authStatus` derivation from `authMethod` + stored credentials.
- `src/main/main.setEnabled.gate.test.ts` *(or extended into existing `main.test.ts` if present)* — enabling `needs-auth` returns `{ enabled: false, startedAuth: true }`; enabling `authenticated` flips as before.

---

### Task 1: Add IPC channel constants + extend `McpServerRecord` with `authMethod` / `authStatus`

**Files:**
- Modify: `src/shared/mcp/constants.ts` (append three constants, regenerate the type).
- Modify: `src/main/mcp/mcpStore.ts` (add fields, add SQLite migration, add helpers).

**Interfaces:**
- Consumes: existing `McpChannel` shape (`as const` object with `type ChannelName = typeof McpChannel[keyof typeof McpChannel];`).
- Produces: `McpServerRecord.authMethod: McpAuthMethod` and `McpServerRecord.authStatus: McpAuthStatus`; new helpers `deriveAuthStatus(server): McpAuthStatus` and `updateAuthStatus(id, status, lastProbe)`.

- [ ] **Step 1.1: Extend the shared IPC constants**

Append to `src/shared/mcp/constants.ts`:

```ts
  StartAuth: 'mcp:startAuth',
  SaveCredential: 'mcp:saveCredential',
  ProbeAuthorization: 'mcp:probeAuthorization',
```

Verify the existing `type McpChannel` still re-derives correctly (no extra work — the `as const` + `keyof typeof` pattern auto-picks up the new keys).

- [ ] **Step 1.2: Add the auth enums (string constants, single source of truth)**

Add a new block at the bottom of `src/shared/mcp/constants.ts`:

```ts
export const McpAuthMethod = {
  None: 'none',
  Bearer: 'bearer',
  ApiKey: 'api-key',
  OAuth: 'oauth',
} as const;
export type McpAuthMethod = typeof McpAuthMethod[keyof typeof McpAuthMethod];

export const McpAuthStatus = {
  Authenticated: 'authenticated',
  NeedsAuth: 'needs-auth',
  AuthError: 'auth-error',
} as const;
export type McpAuthStatus = typeof McpAuthStatus[keyof typeof McpAuthStatus];
```

- [ ] **Step 1.3: Extend `McpServerRecord` + SQLite schema + helpers in `mcpStore.ts`**

In `McpServerRecord` add `authMethod: McpAuthMethod` and `authStatus: McpAuthStatus`.

In `McpServerFormData` add `authMethod: McpAuthMethod`.

In the `CREATE TABLE mcp_servers` schema, add `auth_status TEXT NOT NULL DEFAULT 'authenticated'` (mirroring `last_probe_status`). Add a migration shim in `mcpStore`'s constructor: if the existing `PRAGMA table_info(mcp_servers)` does not include `auth_status`, run `ALTER TABLE mcp_servers ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'authenticated'`. Mirror the pattern used for the `last_probe_status` column if one already exists; otherwise model it after the pattern used for `last_probe_at`.

Add helpers (pure functions, no I/O):
- `deriveAuthStatus(record: McpServerRecord): McpAuthStatus`:
  - `authMethod === None` → `'authenticated'`.
  - `authMethod === OAuth` and an `oauthToken` is present in `config_json` → `'authenticated'`.
  - `authMethod === Bearer` and `headers.Authorization` present → `'authenticated'`.
  - `authMethod === ApiKey` and at least one header in `headers` other than `Authorization` is present → `'authenticated'` (the user picks the header name at install time).
  - Otherwise → `'needs-auth'`.
- `updateAuthStatus(id, status, lastProbeStatus?: string)` — updates `auth_status` + `last_probe_status` + `last_probe_at` (when `lastProbeStatus` is provided) inside a single transaction.

- [ ] **Step 1.4: Vitest — `McpStore` auth-status derivation**

In `src/main/mcp/mcpStore.test.ts` add `describe('authStatus derivation')` block with tests:
- bearer without `Authorization` → `needs-auth`; bearer with `Authorization` → `authenticated`.
- api-key with empty headers → `needs-auth`; api-key with one custom header → `authenticated`.
- oauth with no token → `needs-auth`; oauth with token → `authenticated`.
- `none` → always `authenticated`.

Run: `npx vitest run src/main/mcp/mcpStore.test.ts`
Expected: all green (existing tests still pass; new ones pass).

- [ ] **Step 1.5: Lint + typecheck touched files**

Run:
```
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/shared/mcp/constants.ts src/main/mcp/mcpStore.ts src/main/mcp/mcpStore.test.ts
npx tsc --project electron-tsconfig.json --noEmit
```
Expected: clean.

- [ ] **Step 1.6: Commit**

```bash
git add src/shared/mcp/constants.ts src/main/mcp/mcpStore.ts src/main/mcp/mcpStore.test.ts
git commit -m "feat(mcp): add authMethod / authStatus to installed MCPs

Captures per-user MCP auth requirements (none | bearer | api-key | oauth)
in config_json and persists a derived auth_status column so the desktop
card list can render the orange needs-auth state without recomputing on
every render. SQLite migration adds auth_status alongside the existing
last_probe_status column; helper deriveAuthStatus is pure and unit-tested."
```

---

### Task 2: Add the OAuth browser-window helper extracted from `qichachaMcpAuth.ts`

**Files:**
- Create: `src/main/mcp/oauthBrowserFlow.ts`.
- Modify: `src/main/mcp/qichachaMcpAuth.ts` (thin to one provider entry; reuse the new helper).

**Interfaces:**
- Consumes: existing `qichachaMcpAuth` flow shape (provider id, auth URL, token probe function).
- Produces: `openOauthFlow(opts): Promise<{ token: string; expiresAt?: number }>` and a registry of named providers.

- [ ] **Step 2.1: Read `qichachaMcpAuth.ts` end-to-end and identify the chrome that is generic**

Expected: the helper opens a `BrowserWindow`, listens on a custom URL scheme or `will-navigate`, performs code→token exchange, and probes the resulting token. All of that is generic except for the provider's auth URL, token URL, scope, and probe URL — those become a config record.

- [ ] **Step 2.2: Extract `openOauthFlow` into `oauthBrowserFlow.ts`**

Create the new file with:

```ts
export interface OAuthProviderConfig {
  id: string;
  label: string;
  authorizeUrl: (state: { redirectUri: string; state: string }) => string;
  exchangeCode: (code: string, redirectUri: string) => Promise<{ accessToken: string; expiresAt?: number }>;
  probe: (token: string) => Promise<{ ok: boolean; error?: string }>;
}

export async function openOauthFlow(
  win: BrowserWindow,
  cfg: OAuthProviderConfig,
): Promise<{ token: string; expiresAt?: number }> { /* … lift the existing flow … */ }
```

Keep the redirect scheme (`genwork-mcp://callback/<provider>`) identical to what qichacha uses today.

- [ ] **Step 2.3: Slim `qichachaMcpAuth.ts` to a provider config**

Replace the body with a single `export const qichachaProvider: OAuthProviderConfig = { id: 'qichacha', label: '企查查', authorizeUrl, exchangeCode, probe }`. Keep `qichachaMcpAuth` re-exported as `{ id: 'qichacha', provider: qichachaProvider, openFlow: (win) => openOauthFlow(win, qichachaProvider) }` so any existing caller continues to work.

- [ ] **Step 2.4: Vitest — provider-config smoke**

In a new `src/main/mcp/oauthBrowserFlow.test.ts`:
- Test that `qichachaProvider` exposes the expected `id`, `label`, and the `probe` function returns `ok: false` when given an obviously invalid token (use a stub fetch that returns 401).
- Do NOT test the full browser-window interaction in unit tests — that path is exercised manually in Task 6.

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`

- [ ] **Step 2.5: Lint + typecheck**

```
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts src/main/mcp/qichachaMcpAuth.ts
npx tsc --project electron-tsconfig.json --noEmit
```

- [ ] **Step 2.6: Commit**

```bash
git add src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts src/main/mcp/qichachaMcpAuth.ts
git commit -m "refactor(mcp): extract generic openOauthFlow from qichachaMcpAuth

Lets every OAuth-style MCP reuse the same browser-window + code-exchange
+ token-probe flow by registering an OAuthProviderConfig. qichacha
becomes the first such provider; the existing flow is preserved
verbatim so existing install/connect paths are unchanged."
```

---

### Task 3: Add the transport-aware MCP `initialize` probe

**Files:**
- Create: `src/main/mcp/mcpAuthProbe.ts`.

**Interfaces:**
- Consumes: `McpServerRecord` (transport + url + headers + env + command/args + oauthToken), `deriveAuthStatus`.
- Produces: `probeAuthorization(record): Promise<ProbeResult>` + DB writeback of `last_probe_status` + `auth_status`.

- [ ] **Step 3.1: Define `ProbeResult`**

```ts
export interface ProbeResult {
  ok: boolean;
  status: 'authorized' | 'unauthorized' | 'connect-error' | 'missing-credential';
  latencyMs: number;
  serverInfo?: { name: string; version?: string };
  error?: string; // user-safe message; never includes credential values
}
```

- [ ] **Step 3.2: Implement HTTP/SSE branch**

Use the existing `node-fetch` import already in the project. Build the headers by merging `record.headers` (which holds the bearer / api-key values). Build the body as a JSON-RPC `initialize` request (`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"genwork","version":"<pkg version>"}}}`). POST to `record.url`. Timeout: 10s. Map outcomes:
- HTTP 200 with `result.serverInfo` (or any non-empty `result`) → `{ ok: true, status: 'authorized' }`.
- HTTP 401 / 403 → `{ ok: false, status: 'unauthorized' }`.
- ECONNREFUSED / DNS fail / timeout → `{ ok: false, status: 'connect-error' }`.
- Missing required credential (`authMethod != none` but `headers` empty after merge) → `{ ok: false, status: 'missing-credential' }` with `error` mentioning which header is expected (`Authorization` for bearer; the configured api-key header name for api-key).

- [ ] **Step 3.3: Implement stdio branch**

Spawn the configured command with `args` and `env` (which holds bearer / api-key). On the child's stdout, look for a JSON-RPC `result` line in response to `initialize`. Treat the same `result.serverInfo` rule as success. Exit before sending → `connect-error`. Missing env key (configured key name absent from `env`) → `missing-credential` with the key name in `error`. Reuse `mcpRuntime`'s spawn pattern but **do NOT** invoke its launch resolution; the probe is a one-shot. Use `child_process.spawn` with a hard 8s deadline.

- [ ] **Step 3.4: Implement OAuth branch**

If `record.authMethod === 'oauth'` and `config_json.oauth.token` is present, build the request exactly as the http/sse branch but inject `Authorization: Bearer <token>`. Otherwise → `missing-credential` with the error "OAuth token not set — please re-authorize". The HTTP status mapping is identical.

- [ ] **Step 3.5: DB writeback**

After computing `ProbeResult`, call `mcpStore.updateAuthStatus(record.id, result.ok ? 'authenticated' : (result.status === 'unauthorized' ? 'auth-error' : 'needs-auth'), result.status)`. Pass the latency into a `last_probe_at` write (extend the helper signature in Task 1 to also accept latency if not already).

- [ ] **Step 3.6: Vitest — `mcpAuthProbe.test.ts`**

Cases:
- HTTP ok (mocked fetch returns `result.serverInfo`) → `ok=true, status='authorized'`.
- HTTP 401 → `ok=false, status='unauthorized'`.
- HTTP 403 → `ok=false, status='unauthorized'` (same bucket).
- HTTP with missing `Authorization` header for bearer → `ok=false, status='missing-credential'`, error mentions `Authorization`.
- Stdio with missing env key → `ok=false, status='missing-credential'`, error mentions the env-key name.
- OAuth branch with token present → identical to bearer success path; OAuth without token → `missing-credential`.
- Writeback: after a failing probe, `mcpStore.updateAuthStatus` was called with the expected `authStatus` and `lastProbeStatus`.

Mock `fetch` and `child_process.spawn` per existing patterns in the repo (search for existing test fixtures for guidance). Use `:memory:` SQLite via the test helper.

Run: `npx vitest run src/main/mcp/mcpAuthProbe.test.ts`

- [ ] **Step 3.7: Lint + typecheck**

```
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/main/mcp/mcpAuthProbe.ts src/main/mcp/mcpAuthProbe.test.ts
npx tsc --project electron-tsconfig.json --noEmit
```

- [ ] **Step 3.8: Commit**

```bash
git add src/main/mcp/mcpAuthProbe.ts src/main/mcp/mcpAuthProbe.test.ts
git commit -m "feat(mcp): add transport-aware initialize probe for auth verification

Sends a real MCP JSON-RPC initialize over the server's configured
transport (http/sse/stdio) using the stored credential. Distinguishes
unauthorized (401/403) from connect-error and missing-credential so the
UI can show actionable errors. Persists last_probe_status / auth_status
back to the row. All branches covered by Vitest with mocked fetch / spawn."
```

---

### Task 4: Add the auth-flow dispatcher and credential save IPC

**Files:**
- Create: `src/main/mcp/mcpAuthFlows.ts`.
- Modify: `src/main/main.ts` (three new IPC handlers).
- Modify: `src/main/preload.ts` (expose channels).
- Modify: `src/renderer/services/mcp.ts` (wrappers).

**Interfaces:**
- Consumes: `McpChannel.StartAuth | SaveCredential | ProbeAuthorization`, `McpServerRecord`, `OAuthProviderConfig` registry.
- Produces: handlers `runHttpAuth`, `runStdioAuth`, `runOauthAuth`; renderer-side wrappers that call them and update the local store on success.

- [ ] **Step 4.1: Define the renderer→main IPC payloads (in `src/shared/mcp/constants.ts` companion types, or inline in `main.ts` if small)**

```ts
export interface StartAuthRequest { id: string }
export interface StartAuthResponse { ok: true; authMethod: McpAuthMethod } | { ok: false; reason: string }

export interface SaveCredentialRequest {
  id: string;
  /** For bearer: { bearer: '<token>' }. For api-key: { headerName: 'X-…', value: '<token>' }. */
  credential: { bearer?: string; apiKey?: { headerName: string; value: string }; oauth?: { providerId: string; token: string } };
}
export interface SaveCredentialResponse { ok: true; status: 'authorized' | 'auth-error' | 'connect-error' | 'missing-credential' } | { ok: false; reason: string }
```

- [ ] **Step 4.2: `runHttpAuth` / `runStdioAuth` / `runOauthAuth` in `mcpAuthFlows.ts`**

- `runHttpAuth(win, record, payload)`: save the credential to `headers` (bearer: `Authorization: 'Bearer <token>'`, api-key: `headers[payload.apiKey.headerName] = payload.apiKey.value`), call `probeAuthorization(record)`, return its `ProbeResult`.
- `runStdioAuth(win, record, payload)`: bearer/api-key save to `env[<key>]` (key name: payload.envKey, default `API_KEY`). Call `probeAuthorization(record)`. Return.
- `runOauthAuth(win, record, payload)`: look up provider by `payload.oauth.providerId` in a small in-file registry; default registry contains `{ qichacha }`. Call `openOauthFlow(win, provider)`. On success save token to `config_json.oauth = { providerId, token, expiresAt? }`; probe; return.

In all cases the credential write happens BEFORE the probe so the probe sees the fresh credential; if the probe fails, the credential is still saved (the user can retry with a corrected one) — only `last_probe_status` reflects the failure.

- [ ] **Step 4.3: Wire IPC handlers in `main.ts`**

Three `ipcMain.handle` blocks under the existing MCP handler section. Each loads the record, validates `payload.id`, dispatches to the right flow. On success the renderer is notified through the existing `mcp:changed` channel so the cards re-render.

- [ ] **Step 4.4: Expose channels in `preload.ts`**

Under `window.electron.mcp`, add:
```ts
startAuth: (options: StartAuthRequest) => ipcRenderer.invoke(McpChannel.StartAuth, options),
saveCredential: (options: SaveCredentialRequest) => ipcRenderer.invoke(McpChannel.SaveCredential, options),
probeAuthorization: (options: { id: string }) => ipcRenderer.invoke(McpChannel.ProbeAuthorization, options),
```

- [ ] **Step 4.5: Add renderer wrappers in `src/renderer/services/mcp.ts`**

Mirror the wrappers for the three new channels, returning typed responses. The existing service object is class-based; add methods `startAuth`, `saveCredential`, `probeAuthorization`.

- [ ] **Step 4.6: Vitest — `mcpAuthFlows.test.ts`**

Cases (all with `:memory:` DB, mocked probe):
- http bearer save + probe ok → returns `{ ok: true, status: 'authorized' }`; `record.headers.Authorization` set to `Bearer ***` after a follow-up read (i.e. credential is persisted).
- http api-key save + probe unauthorized → returns the unauthorized status; `record.headers[<header-name>]` is set even though probe failed (user can retry).
- stdio bearer save + missing env key → returns `missing-credential`.
- oauth save → opens the flow (mocked `BrowserWindow`); on callback the token is stored and probe is called.

Run: `npx vitest run src/main/mcp/mcpAuthFlows.test.ts`

- [ ] **Step 4.7: Lint + typecheck**

```
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/main/mcp/mcpAuthFlows.ts src/main/mcp/mcpAuthFlows.test.ts src/main/main.ts src/main/preload.ts src/renderer/services/mcp.ts
npx tsc --project electron-tsconfig.json --noEmit
```

- [ ] **Step 4.8: Commit**

```bash
git add src/main/mcp/mcpAuthFlows.ts src/main/mcp/mcpAuthFlows.test.ts src/main/main.ts src/main/preload.ts src/renderer/services/mcp.ts src/shared/mcp/constants.ts
git commit -m "feat(mcp): wire per-MCP authorization flow dispatcher and IPC

Three new IPC channels (startAuth, saveCredential, probeAuthorization)
fronted by transport-aware handlers in mcpAuthFlows. Each handler saves
the credential to the record's config_json and then runs the probe; on
unauthorized the credential is still saved so the user can retry.
oauth-style servers reuse the extracted openOauthFlow with a small
provider registry (qichacha for v1)."
```

---

### Task 5: Gate `mcp:setEnabled` on `authStatus` (auto-open auth flow)

**Files:**
- Modify: `src/main/main.ts` (`mcp:setEnabled` handler).
- New tests for the new branch (extend the existing test for `mcp:setEnabled` if any, else add `src/main/main.mcpSetEnabled.test.ts`).

- [ ] **Step 5.1: Read the existing `mcp:setEnabled` handler**

Confirm the current shape (returns updated server list).

- [ ] **Step 5.2: Add the gate**

```ts
if (enabled) {
  const record = mcpStore.getServer(id);
  if (record?.authStatus === 'needs-auth') {
    // Auto-open the right flow. The renderer side will show the modal.
    mainWindow.webContents.send(McpChannel.StartAuth, { id });
    return { enabled: false, startedAuth: true };
  }
}
```

The existing happy path is unchanged for `enabled=false` and for `authStatus === 'authenticated'`.

- [ ] **Step 5.3: Vitest — setEnabled gate**

Add cases:
- `setEnabled({ id, enabled: true })` on a `needs-auth` record → returns `{ enabled: false, startedAuth: true }`; DB `enabled` column stays `0`; `McpChannel.StartAuth` event was emitted to the window.
- `setEnabled({ id, enabled: true })` on an `authenticated` record → returns the normal `{ enabled: true, … }`; DB `enabled` becomes `1`.
- `setEnabled({ id, enabled: false })` on either → unchanged from existing behavior.

- [ ] **Step 5.4: Lint + typecheck**

```
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/main/main.ts src/main/main.mcpSetEnabled.test.ts
npx tsc --project electron-tsconfig.json --noEmit
```

- [ ] **Step 5.5: Commit**

```bash
git add src/main/main.ts src/main/main.mcpSetEnabled.test.ts
git commit -m "fix(mcp): auto-open auth flow when enabling an unauthenticated MCP

Prevents the toggle from lying about state: an MCP with authStatus
needs-auth cannot be flipped to enabled directly. setEnabled returns
{enabled:false, startedAuth:true} and emits mcp:startAuth to the
renderer so the auth modal opens immediately, matching the
spec'd silently-auto-open behavior."
```

---

### Task 6: Renderer UI — `authMethod` selector on the install form + auth modal + card states

**Files:**
- Modify: `src/renderer/components/mcp/McpServerFormModal.tsx` (add `authMethod` selector + per-method fields).
- Create: `src/renderer/components/mcp/mcpAuthModal.tsx` (generic modal that drives the flow).
- Modify: `src/renderer/components/mcp/McpManager.tsx` and/or `McpCard.tsx` (orange-dot + 连接 button; auto-open the modal on `startedAuth: true`).
- Modify: `src/renderer/components/mcp/McpDetailModal.tsx` (add "重新认证" footer action).
- Modify: `src/renderer/services/i18n.ts` (new keys in `zh` + `en`).
- New tests for the card rendering (orange / green / hidden states).

- [ ] **Step 6.1: i18n keys**

Add to both `zh` and `en`:
- `mcp.auth.method.{none,bearer,api-key,oauth}` — labels.
- `mcp.auth.need` — "需要认证" / "Authentication required".
- `mcp.auth.connect` — "连接" / "Connect".
- `mcp.auth.reauthorize` — "重新认证" / "Re-authorize".
- `mcp.auth.success` — "授权成功" / "Authorized".
- `mcp.auth.failed.unauthorized` — "授权失败(401): 请检查 API Key / Bearer 是否有效" / "Unauthorized (401): check your API key or bearer token".
- `mcp.auth.failed.connect` — "连接失败,请检查地址或网络" / "Connection failed, check URL or network".
- `mcp.auth.failed.missing` — "缺少授权字段<key>" / "Missing credential field <key>".
- `mcp.auth.field.bearer` / `mcp.auth.field.apiKeyName` / `mcp.auth.field.apiKeyValue` / `mcp.auth.field.envKeyName` / `mcp.auth.field.oauthProvider`.

- [ ] **Step 6.2: `McpServerFormModal.tsx` — add `authMethod` selector**

Add a section near the existing transport selector. When `authMethod === bearer`: show a password input labeled "API Key / Bearer Token". When `authMethod === api-key`: show two inputs, "Header Name" (default `X-API-Key`) and "Value". When `authMethod === oauth`: show a select of registered providers (v1: just `qichacha`). When `none`: hide the extra fields.

Save payload includes `authMethod` and the per-method fields. The form does NOT probe; that's the install form, the credential is stored as-is.

- [ ] **Step 6.3: `mcpAuthModal.tsx` — generic auth modal**

Props: `{ server, mode: 'connect' | 'reauthorize', onClose, onSuccess }`. Internally:
- Renders the right input(s) for `server.authMethod`.
- On submit, calls `mcpService.saveCredential` then `mcpService.probeAuthorization`.
- Shows the `ProbeResult` inline; on `ok` calls `onSuccess` and closes.
- On failure leaves the modal open with the error pill + a retry button.

- [ ] **Step 6.4: `McpManager.tsx` / `McpCard.tsx` — orange-dot + 连接 button**

When `server.authStatus === 'needs-auth'`:
- Render an orange dot (CSS only, matches the screenshot's orange circle) on the card.
- Replace the tools-list region with the "需要认证" indicator + a "连接" button on the right (matches the screenshot).
- Clicking the button opens `mcpAuthModal` in `connect` mode.

When `server.authStatus === 'authenticated'` and `server.enabled`: existing behavior (green dot + tools list).

When `server.authMethod === 'none'`: `authStatus` is always `authenticated` per the derivation, so this is handled.

Listen for `electron.ipcRenderer.on(McpChannel.StartAuth, …)` (emitted from Task 5) and open the modal in `connect` mode.

- [ ] **Step 6.5: `McpDetailModal.tsx` — 重新认证 action**

In the footer next to enable/edit/delete, render "重新认证" only when `server.authMethod !== 'none'`. Click opens `mcpAuthModal` in `reauthorize` mode. Disabled while a flow is running.

- [ ] **Step 6.6: Vitest — card rendering**

Co-locate with `McpCard.tsx` (or `tests/components/mcp/McpCard.test.tsx`). Cases:
- `authStatus === 'needs-auth'`: renders orange dot, "需要认证" indicator, "连接" button; **does not** render the tools list region.
- `authStatus === 'authenticated'`: renders green dot, tools list; no "连接" button.
- `authStatus === 'auth-error'`: same as `needs-auth` (treat as needs-auth for display purposes; the next probe will resolve).

- [ ] **Step 6.7: Vitest — `mcpAuthModal` interactions**

Cases (with mocked `mcpService`):
- Submitting a bearer token calls `saveCredential` then `probeAuthorization`; on `ok` calls `onSuccess` + closes.
- On `unauthorized` result leaves the modal open, shows the failed pill.
- Disabled submit button while in flight.

- [ ] **Step 6.8: Lint + typecheck**

```
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/mcp/McpManager.tsx src/renderer/components/mcp/McpCard.tsx src/renderer/components/mcp/McpDetailModal.tsx src/renderer/components/mcp/McpServerFormModal.tsx src/renderer/components/mcp/mcpAuthModal.tsx src/renderer/components/mcp/McpCard.test.tsx src/renderer/components/mcp/mcpAuthModal.test.tsx src/renderer/services/mcp.ts src/renderer/services/i18n.ts
npx tsc --project electron-tsconfig.json --noEmit
```

- [ ] **Step 6.9: Commit**

```bash
git add src/renderer/components/mcp src/renderer/services/mcp.ts src/renderer/services/i18n.ts
git commit -m "feat(mcp): desktop UI for per-user MCP authorization

Install form gains an authMethod selector with per-method fields.
Cards show an orange 'needs authentication' state with a Connect
button that opens a generic auth modal; on success the card flips to
authenticated and its tool list reappears. Toggling the enable
switch on an unauthenticated MCP silently opens the same modal
(via the IPC event from setEnabled). The detail drawer exposes
'Re-authorize' so users can replace expired or wrong credentials.
All user-visible strings are i18n'd in zh + en."
```

---

### Task 7: End-to-end manual validation in `npm run electron:dev`

**No code changes.** This task verifies the feature against real MCPs.

- [ ] **Step 7.1: HTTP/SSE + bearer (use the 纷享销客 MCP from the original screenshot)**

1. Install a new MCP with `transport=http`, `url=https://open.fxiaoke.com/mcp/...`, `authMethod=bearer`. Do **not** provide a token.
2. Expected: card shows orange dot + "需要认证" + "连接" button.
3. Toggle the enable switch. Expected: auth modal opens immediately (no 400/500 in DevTools).
4. Paste a wrong token → submit → expect "授权失败(401)" pill, modal stays open.
5. Paste the correct token → submit → expect green dot + tools list (or empty list with no error if the server returns no tools).
6. Open detail drawer → "重新认证" works the same way.

- [ ] **Step 7.2: HTTP/SSE + api-key**

1. Install another MCP with `authMethod=api-key`, header name `X-Api-Key`. Do not provide a value.
2. Expected: orange + 连接.
3. Click 连接, fill header name + value, submit. Expected: green if the server accepts that header, orange if not.

- [ ] **Step 7.3: stdio + bearer**

1. Install a stdio MCP (use any trivial command that responds to JSON-RPC, e.g. a local `mcp-echo` script) with `authMethod=bearer` and `env.API_KEY=<value>`.
2. Confirm the orange → green transition works as in 7.1.

- [ ] **Step 7.4: OAuth (qichacha)**

1. Install an MCP whose provider is `qichacha`. Click 连接. Expected: the OAuth browser window opens (same flow as before — unchanged by Task 2).
2. Complete auth. Expected: card flips to green; the OAuth token is persisted.

- [ ] **Step 7.5: Persistence**

1. Restart the app. Confirm: every authenticated MCP stays green; every `needs-auth` MCP stays orange; `last_probe_at` / `last_probe_status` survive restart (verify by reading SQLite directly).

- [ ] **Step 7.6: No-regression sanity**

1. The full test suite (`npm test`) still passes.
2. The touched files pass lint + typecheck.
3. Pre-existing MCP flows (e.g. launching an authenticated MCP at runtime) still work — `npm run electron:dev` can run an embedded turn that uses one of the now-authenticated MCPs, and the OpenClaw runtime's MCP launch path still sees the stored headers / env / oauth tokens.

- [ ] **Step 7.7: Tag the milestone**

After Steps 7.1–7.6 pass, tag the commit:
```bash
git tag mcp-per-user-auth-v2.1
```

---

## Notes on out-of-scope items (intentionally not in this plan)

- Token refresh / expiry policy — credentials are treated as valid until the user re-keys. The 重新认证 action covers re-keying.
- Adding new OAuth providers beyond `qichacha` in this PR — the registry pattern in Task 2 makes it trivial later.
- Admin-side (`enterprise_server`) `DetailDrawer.tsx` — untouched; that's a different product surface with a different credential model.
- OpenClaw runtime changes — the runtime already reads `headers` / `env`; this plan does not change that.