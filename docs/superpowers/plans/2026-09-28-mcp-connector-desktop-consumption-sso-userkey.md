# MCP Connector Desktop Consumption — SSO + user-key direct-link (M0+M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop **direct-link** consume the remaining two user-credential connector auth modes — `sso` and `user-key` — by (a) letting the admin console collect SSO IdP endpoints and user-key header names, (b) projecting that non-secret metadata into the public market view, and (c) routing `sso` through the already-merged generic OAuth driver and pre-filling the user-key header name on install.

**Architecture:** `sso` reuses the **same** generic authorization-code + PKCE driver as `user-oauth` (already merged in the 2026-09-27 oauth plan) — the desktop treats `sso` exactly like `user-oauth` (`McpAuthMethod.OAuth`, `providerId: generic:<serverKey>`), so the only desktop SSO change is a one-line auth-mode remap; the server projects the SSO endpoints into the existing `oauth` object. `user-key` reuses the existing desktop API-key flow; the only addition is an admin-configurable **header name** that flows server → public view → desktop prefill. No `provider` field is added to the public view (the desktop already derives the provider from `serverKey`); no Qichacha fallback is ever triggered for an enterprise connector.

**Tech Stack:** Node/TypeScript — Electron desktop (`src/main`, `src/renderer`, `src/shared`), Hono + Postgres (pglite for tests) server at `enterprise_server/`, React SPA at `enterprise_server/web`. Vitest (per-file only). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-mcp-connector-desktop-consumption-design.md` — implements §4.1 (admin `auth_config`), §4.2 (public view `oauth` extended to `sso`), §4.3/§5.1/§5.2 (desktop `oauthConfig` reuse), §5.4 (guardrail, already present for `user-oauth`), §5.5 (user-key wiring), §7 (admin SPA + `missingAuthField` relaxation). **Out of scope here:** the server MCP gateway (§6, `shared-key`/`client-creds`) and desktop target-URL selection (§5.3) — that is the M2 plan. The `user-oauth` M0+M1 is already merged and NOT re-planned.

## Global Constraints

- **Two apps, one repo:** repo root `/Users/paulwang/work/GenWork` = Electron desktop; `enterprise_server/` = Hono + Postgres backend + React SPA (a subdirectory, no own `.git`). Run each side's tests from its own dir.
- **Per-file tests only.** `enterprise_server` and `web` full `vitest` runs hit `EBADF`/fd exhaustion in the sandbox → `npx vitest run <file>`. The desktop main-process store tests (`mcpStore.test.ts`, `mcpAuthFlows.test.ts`) have a pre-existing `better-sqlite3.node` ABI failure (NODE_MODULE_VERSION 143 vs 137) in the sandbox — treat as CI-gated, unrelated to this change; keep logic in pure functions where testable.
- **Typecheck baselines:**
  - server: `cd enterprise_server && npx tsc --noEmit` → 0 errors
  - web: `cd enterprise_server/web && npx tsc --noEmit` → 0 errors
  - desktop main: `cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit` → 0 errors
  - desktop renderer: `cd /Users/paulwang/work/GenWork && npx tsc --noEmit` → **exactly 1 pre-existing error** `src/renderer/components/mcp/bakeArtifactSharePage.ts(382,21)` (do NOT fix it; do not add new errors)
- **Tests are authoritative.** Do not change the meaning of an existing assertion. Only ADD assertions. The two existing assertions this plan intentionally modifies are called out explicitly and require sign-off (see the task that changes them): (1) `enterpriseAuthMode.test.ts:23` — `sso` flips from `Bearer` to `OAuth` (this is the placeholder this feature replaces); (2) no other existing assertion is altered.
- **Secrets:** the public view exposes **non-secret** fields only. Never project `*ClientSecret`, `ssoClientSecret`, or any `__enc__*` ciphertext to the desktop. The desktop never holds org secrets.
- **SSO is public-client-only this period** (spec §13.5 default: "SSO 机密客户端 → 网关" = 否). The SSO `ssoClientSecret` field is accepted by the form (confidential client for a future gateway) but is NOT projected to the desktop and is NOT required. No vault changes (`secretFieldFor('sso')` stays `null`).
- **i18n in en + zh, no dead keys.** Every new key must be referenced in code and present in both the `zh` and `en` blocks.
- **No new top-level package dependency; no new `PermissionPoint`** (reuse `mcp:*`).
- **Auto-commit local only** — never push.
- **Do NOT touch the Qichacha built-in bundle** (`providerId: 'qichacha'`). Do NOT silently fall back to Qichacha for an enterprise connector (guardrail).

### Wire-shape invariants (keep in sync)

The `oauth` object shape is `{ authorizeUrl, tokenUrl, clientId, scopes? }` and must stay **identical** in all four sites:
1. server `ConnectorPublicView.oauth` — `enterprise_server/src/models/connectorView.ts`
2. desktop renderer `McpOAuthEndpoint` — `src/renderer/types/mcp.ts`
3. desktop store `McpOAuthEndpoint` — `src/main/mcp/mcpStore.ts`
4. desktop main `GenericOauthConfig` — `src/main/mcp/genericOauthFlow.ts`

The new non-secret **user-key header name** is `apiKeyHeaderName?: string`, added to:
- server `ConnectorPublicView` — `connectorView.ts`
- desktop `McpEnterpriseMarketServer` — `src/renderer/types/mcp.ts`
- desktop `McpServerConfig` — `src/renderer/types/mcp.ts`
- desktop store `McpServerConfig` / `McpServerFormData` / `McpConfigJson` — `src/main/mcp/mcpStore.ts`
- desktop IPC read-back `McpServerConfigIPC` — `src/renderer/types/electron.d.ts`
- desktop IPC market-list inline types — `src/main/auth/enterpriseClient.ts` and `src/renderer/types/electron.d.ts`
- admin SPA `ConnectorFormState` — `enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx`

---

## File Structure

| Responsibility | File(s) |
|---|---|
| Project non-secret SSO/user-key metadata to the public (desktop) wire | `enterprise_server/src/models/connectorView.ts` |
| Per-mode required-field guard (`sso` endpoints/clientId; keep `user-key` open) | `enterprise_server/src/routes/mcpConnectors.ts` (`missingAuthField`) |
| Admin SPA: collect SSO endpoints + user-key header name, validate, backfill, i18n | `enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx`, `.../ConnectorAuthFields.tsx`, `.../i18n.ts` |
| Desktop type mirror + store persistence of `apiKeyHeaderName` | `src/renderer/types/mcp.ts`, `src/main/mcp/mcpStore.ts`, `src/main/auth/enterpriseClient.ts`, `src/renderer/types/electron.d.ts` |
| Desktop SSO auth-mode remap (`sso → OAuth`) | `src/renderer/components/mcp/enterpriseAuthMode.ts` |
| Desktop user-key install prefill (header name) | `src/renderer/components/mcp/McpServerFormModal.tsx` |
| Desktop SSO not-configured message (en+zh) | `src/renderer/services/i18n.ts` |
| Tests | `enterprise_server/tests/models/connectorView.test.ts`, `enterprise_server/tests/routes/mcpConnectors.test.ts`, `src/renderer/components/mcp/enterpriseAuthMode.test.ts` |

**Ordering:** Server tasks (1–3) are independent of desktop tasks (4–6) but must land before the desktop tasks so the wire carries the new fields; within each side, bottom-up (pure functions/types → wiring). Task 7 is the verification sweep.

---

## Task 1: Server — public view projects SSO `oauth` + user-key `apiKeyHeaderName`

**Files:**
- Modify: `enterprise_server/src/models/connectorView.ts`
- Test: `enterprise_server/tests/models/connectorView.test.ts`

**Interfaces:**
- Consumes: `ConnectorRow` (same file), `ConnectorPublicView` (same file).
- Produces: `mapPublicConnector(row)` now returns `oauth` for **both** `user-oauth` and `sso` (when endpoints complete), and `apiKeyHeaderName?: string` for `user-key` (when set). Later tasks (desktop mirror, marketplace) rely on these exact field names.

### Step 1: Write the failing tests (additive)

Append to the existing `describe('mapPublicConnector.oauth (user-oauth whitelist)')` block in `enterprise_server/tests/models/connectorView.test.ts` (after the `client-creds → undefined` test, ~line 142). These ADD cases; do not modify existing ones:

```ts
  test('fills oauth for sso from the sso-* field whitelist when endpoints are complete', () => {
    const v = mapPublicConnector(makeRow({
      auth_mode: 'sso',
      auth_config: {
        ssoApp: 'feishu',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
        ssoClientId: 'sso-public-client',
        ssoScopes: ['openid', 'profile'],
        ssoClientSecret: 'shoud-not-leak-plaintext',
      },
    }));
    expect(v.oauth).toEqual({
      authorizeUrl: 'https://idp.example.com/sso/authorize',
      tokenUrl: 'https://idp.example.com/sso/token',
      clientId: 'sso-public-client',
      scopes: ['openid', 'profile'],
    });
    // ssoApp / ssoClientSecret never cross to the desktop.
    expect(JSON.stringify(v)).not.toContain('sso-public-client-secret');
    expect(v).not.toHaveProperty('ssoApp');
  });
  test('sso oauth is undefined when an sso endpoint is missing', () => {
    expect(
      mapPublicConnector(makeRow({
        auth_mode: 'sso',
        auth_config: { ssoApp: 'feishu', ssoAuthorizeUrl: 'https://a', ssoTokenUrl: '', ssoClientId: 'c' },
      })).oauth,
    ).toBeUndefined();
  });
  test('user-key exposes apiKeyHeaderName when set, omits it when unset', () => {
    const withName = mapPublicConnector(makeRow({ auth_mode: 'user-key', auth_config: { apiKeyHeaderName: 'X-My-Key' } }));
    expect(withName.apiKeyHeaderName).toBe('X-My-Key');
    const without = mapPublicConnector(makeRow({ auth_mode: 'user-key', auth_config: {} }));
    expect(without.apiKeyHeaderName).toBeUndefined();
  });
```

Also add, in the `describe('mapPublicConnector')` block (near the "exposes no authConfig…" test, ~line 81), a leak assertion for SSO:

```ts
  test('never leaks ssoClientSecret into the public view', () => {
    const v = mapPublicConnector(makeRow({
      auth_mode: 'sso',
      auth_config: {
        ssoAuthorizeUrl: 'https://a',
        ssoTokenUrl: 'https://t',
        ssoClientId: 'c',
        ssoClientSecret: 'top-secret-sso',
      },
    }));
    expect(JSON.stringify(v)).not.toContain('top-secret-sso');
  });
```

### Step 2: Run the tests to verify they fail

Run: `cd enterprise_server && npx vitest run tests/models/connectorView.test.ts`
Expected: the 3 new `oauth`/`sso`/`apiKeyHeaderName` tests FAIL (e.g. `expect(received).toBeUndefined()` where received is `undefined` for the sso oauth, or the `toEqual` mismatch). Existing tests still pass.

### Step 3: Implement

In `enterprise_server/src/models/connectorView.ts`:

(a) Extend the `ConnectorPublicView.oauth` doc comment and add `apiKeyHeaderName` to the interface. Change the `oauth?` doc comment and add the new field after `toolCount: number;`:

```ts
  /** Present only for direct-link modes (`user-oauth` / `sso`) with complete
   * endpoints. Non-secret only — never carries any `*ClientSecret` or `__enc__*`
   * ciphertext. `sso` reads its endpoints from the `sso*` fields. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
  /** Present only for `user-key`: the header name the connector's API key is
   * injected under (non-secret). Absent when the admin left it unset (the
   * desktop then defaults to `X-Api-Key`). */
  apiKeyHeaderName?: string;
```

(b) Generalize `pickPublicOauth` to accept the field names for the mode (keep the existing user-oauth field names as the default). Replace the current `pickPublicOauth` (lines 200–211) with a mode-aware version:

```ts
/** Pick the non-secret OAuth endpoints from a stored auth_config for the given
 * mode. `user-oauth` reads `authorizeUrl`/`tokenUrl`/`clientId`/`scopes`;
 * `sso` reads the `sso*`-prefixed equivalents. Whitelist-only; ignores any
 * `*ClientSecret` and every `__enc__*` key. Returns undefined when either
 * endpoint is missing (desktop then shows the not-configured guardrail, never
 * falls back to a default provider). */
function pickPublicOauth(
  authConfig: Record<string, unknown>,
  mode: 'user-oauth' | 'sso',
): ConnectorPublicView['oauth'] | undefined {
  const p = mode === 'sso' ? 'sso' : '';
  const authorizeUrl = typeof authConfig[`${p}authorizeUrl`] === 'string' ? (authConfig[`${p}authorizeUrl`] as string).trim() : '';
  const tokenUrl = typeof authConfig[`${p}tokenUrl`] === 'string' ? (authConfig[`${p}tokenUrl`] as string).trim() : '';
  if (!authorizeUrl || !tokenUrl) return undefined;
  const clientId = typeof authConfig[`${p}clientId`] === 'string' ? (authConfig[`${p}clientId`] as string).trim() : '';
  const scopes = Array.isArray(authConfig[`${p}scopes`])
    ? (authConfig[`${p}scopes`] as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  const out: ConnectorPublicView['oauth'] = { authorizeUrl, tokenUrl, clientId };
  if (scopes && scopes.length > 0) out.scopes = scopes;
  return out;
}
```

(c) Update `mapPublicConnector` to fill `oauth` for both modes and add `apiKeyHeaderName`. Change the return object (lines 218–236) — replace the `oauth:` line and add `apiKeyHeaderName`:

```ts
    toolCount: row.tools.filter(t => !t.removed).length,
    oauth:
      row.auth_mode === 'user-oauth'
        ? pickPublicOauth(row.auth_config, 'user-oauth')
        : row.auth_mode === 'sso'
          ? pickPublicOauth(row.auth_config, 'sso')
          : undefined,
    apiKeyHeaderName:
      row.auth_mode === 'user-key'
        ? (typeof row.auth_config.apiKeyHeaderName === 'string' && row.auth_config.apiKeyHeaderName.trim()
            ? (row.auth_config.apiKeyHeaderName as string).trim()
            : undefined)
        : undefined,
  };
```

### Step 4: Run the tests to verify they pass

Run: `cd enterprise_server && npx vitest run tests/models/connectorView.test.ts`
Expected: PASS (all old + new).

### Step 5: Typecheck

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: 0 errors.

### Step 6: Commit

```bash
git add enterprise_server/src/models/connectorView.ts enterprise_server/tests/models/connectorView.test.ts
git commit -m "feat(mcp): project sso oauth endpoints + user-key header name to the public view"
```

---

## Task 2: Server — `missingAuthField` SSO branch (public-client relaxation)

**Files:**
- Modify: `enterprise_server/src/routes/mcpConnectors.ts` (the `missingAuthField` function, lines 156–173)
- Test: `enterprise_server/tests/routes/mcpConnectors.test.ts`

**Interfaces:**
- Consumes: `authConfig` (a loose `Record<string, unknown>` — no per-field schema, so `sso*` keys pass through the `connectorCfgSchema` unchanged).
- Produces: `missingAuthField('sso', cfg)` → `'ssoClientId'` when no clientId, else `'ssoTokenUrl'` when endpoints incomplete, else `null`. This is consumed by the create (`:265`), publish (`:721`), and submission (`mcpSubmissions.ts:114`) guards — all of which already check `sseOauthCombination` **before** calling `missingAuthField`, so tightening `sso` does not affect the SSE test (`mcpConnectors.test.ts:216`), which 400s on the transport check first.

### Step 1: Write the failing tests (additive)

Add a new `test` inside the existing `describe('mcp connector admin routes')` in `enterprise_server/tests/routes/mcpConnectors.test.ts` (place it right after the `user-oauth public-client form` test, ~line 286). Mirror the shape of that test:

```ts
  test('sso public-client form (ssoClientId + sso endpoints, no secret) passes the guard; missing endpoints → ssoTokenUrl', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');

    // Public client + PKCE: ssoClientId + complete sso endpoints → accepted.
    const pub = await createConnector(tok, baseBody({
      serverKey: 'sso-feishu',
      authMode: 'sso',
      authConfig: {
        ssoApp: 'feishu',
        ssoClientId: 'sso-cid',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
      },
    }));
    expect(pub.status).toBe(201);

    // sso with endpoints but no clientId → needs ssoClientId.
    const noCid = await createConnector(tok, baseBody({
      serverKey: 'sso-no-cid',
      authMode: 'sso',
      authConfig: {
        ssoApp: 'feishu',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
      },
    }));
    expect(noCid.status).toBe(400);
    expect(await noCid.json()).toEqual({ error: 'missing_auth_field', field: 'ssoClientId' });

    // sso with clientId but incomplete endpoints → needs the token endpoint.
    const noToken = await createConnector(tok, baseBody({
      serverKey: 'sso-no-token',
      authMode: 'sso',
      authConfig: {
        ssoApp: 'feishu',
        ssoClientId: 'sso-cid',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
      },
    }));
    expect(noToken.status).toBe(400);
    expect(await noToken.json()).toEqual({ error: 'missing_auth_field', field: 'ssoTokenUrl' });
  });
```

### Step 2: Run the tests to verify they fail

Run: `cd enterprise_server && npx vitest run tests/routes/mcpConnectors.test.ts`
Expected: the new `sso` test FAILS — the public-client `sso` create returns 201 today (because `missingAuthField('sso')` currently returns `null`), but the `noCid`/`noToken` cases also 201 today, so the `expect(400)` assertions fail. Existing tests still pass.

### Step 3: Implement

In `enterprise_server/src/routes/mcpConnectors.ts`, extend `missingAuthField` (lines 156–173). Add an `sso` branch before the final `return null`, and update the trailing comment. The `user-key`/`none` path stays `null`:

```ts
  if (authMode === 'sso') {
    // Public client + PKCE (desktop-driven, same as user-oauth): the sso*
    // endpoints + clientId are enough — no ssoClientSecret crosses the wire.
    // A confidential SSO client (secret) is a gateway concern (M2), not the
    // desktop direct-link path, so it is not required here.
    if (!authConfig.ssoClientId) return 'ssoClientId';
    const hasSsoEndpoints = Boolean(authConfig.ssoAuthorizeUrl) && Boolean(authConfig.ssoTokenUrl);
    if (hasSsoEndpoints) return null;
    return 'ssoTokenUrl';
  }
  return null; // none / user-key have no admin-filled secret requirement
```

(Keep the existing `shared-key`, `user-oauth`, and `client-creds` branches byte-identical. `user-key` continues to fall through to `null` — it carries no admin-side required field.)

### Step 4: Run the tests to verify they pass

Run: `cd enterprise_server && npx vitest run tests/routes/mcpConnectors.test.ts`
Expected: PASS (all old + new). Confirm the `sse + oauth-family` test (line 213) still passes — it does, because `sseOauthCombination` returns first.

### Step 5: Typecheck

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: 0 errors.

### Step 6: Commit

```bash
git add enterprise_server/src/routes/mcpConnectors.ts enterprise_server/tests/routes/mcpConnectors.test.ts
git commit -m "feat(mcp): require sso clientId + endpoints in missingAuthField (public client)"
```

---

## Task 3: Admin SPA — SSO endpoint fields + user-key header name + validation + i18n

**Files:**
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx`
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`

**Interfaces:**
- Consumes: the server's `missingAuthField` contract (Task 2) so client validation mirrors it.
- Produces: `buildAuthConfig` writes `ssoAuthorizeUrl`/`ssoTokenUrl`/`ssoClientId`/`ssoScopes`/`ssoClientSecret` (SSO) and `apiKeyHeaderName` (user-key) into the `authConfig` wire object — the exact keys Task 1's `pickPublicOauth`/`mapPublicConnector` and Task 2's `missingAuthField` read.

### Step 1: Add the i18n keys (en + zh)

In `enterprise_server/web/src/i18n.ts`, add the SSO endpoint keys to **both** the `en` and `zh` blocks (near the existing `mcpDrawer.auth.sso.hint`, en ~line 674 / zh ~line 1684) and the user-key header-name key (near `mcpDrawer.auth.userKey.note`, en ~line 648 / zh ~line 1658).

English block (add these lines):
```ts
  'mcpDrawer.auth.ssoAuthorizeUrl': 'SSO authorize URL',
  'mcpDrawer.auth.ssoAuthorizeUrl.placeholder': 'https://auth.example.com/oauth/authorize',
  'mcpDrawer.auth.ssoTokenUrl': 'SSO token URL',
  'mcpDrawer.auth.ssoTokenUrl.placeholder': 'https://auth.example.com/oauth/token',
  'mcpDrawer.auth.ssoClientId': 'SSO Client ID',
  'mcpDrawer.auth.ssoClientId.placeholder': "Created on the IdP's developer portal",
  'mcpDrawer.auth.ssoClientSecret': 'SSO Client Secret (confidential client only)',
  'mcpDrawer.auth.ssoClientSecret.placeholder': 'Encrypted at rest, never shown to members. Leave blank for a public client (PKCE).',
  'mcpDrawer.auth.ssoPublicHint': 'Public client + PKCE: fill authorize/token URLs and the Client ID; no secret is sent to the desktop. Members complete SSO in a browser window on first use.',
  'mcpDrawer.auth.userKeyHeaderName': 'API Key header name',
  'mcpDrawer.auth.userKeyHeaderName.placeholder': 'X-Api-Key',
  'mcpDrawer.auth.userKeyHeaderName.hint': 'The HTTP header the member’s own key is sent under. Defaults to X-Api-Key if left blank.',
```

Chinese block (add the matching lines):
```ts
  'mcpDrawer.auth.ssoAuthorizeUrl': 'SSO 授权地址',
  'mcpDrawer.auth.ssoAuthorizeUrl.placeholder': 'https://auth.example.com/oauth/authorize',
  'mcpDrawer.auth.ssoTokenUrl': 'SSO 令牌地址',
  'mcpDrawer.auth.ssoTokenUrl.placeholder': 'https://auth.example.com/oauth/token',
  'mcpDrawer.auth.ssoClientId': 'SSO Client ID',
  'mcpDrawer.auth.ssoClientId.placeholder': '在 IdP 开放平台创建应用后获得',
  'mcpDrawer.auth.ssoClientSecret': 'SSO Client Secret（仅机密客户端）',
  'mcpDrawer.auth.ssoClientSecret.placeholder': '加密存储，不对员工展示；公开客户端（PKCE）请留空。',
  'mcpDrawer.auth.ssoPublicHint': '公开客户端 + PKCE：填授权/令牌地址与 Client ID，不下发 secret。成员首次使用时在浏览器窗口完成 SSO。',
  'mcpDrawer.auth.userKeyHeaderName': 'API Key 请求头名称',
  'mcpDrawer.auth.userKeyHeaderName.placeholder': 'X-Api-Key',
  'mcpDrawer.auth.userKeyHeaderName.hint': '成员填写的密钥以此请求头下发；留空则默认 X-Api-Key。',
```

### Step 2: Extend `ConnectorFormState` + seed/backfill + `buildAuthConfig` + `validate` in `ConnectorDrawer.tsx`

(a) Add the new sub-fields to `ConnectorFormState` (lines 44–67), after `ssoApp: string;`:
```ts
  ssoApp: string;
  ssoAuthorizeUrl: string;
  ssoTokenUrl: string;
  ssoClientId: string;
  ssoScopes: string[];
  ssoClientSecret: string;
  apiKeyHeaderName: string;
  timeoutSeconds: number;
```

(b) In `initState` (lines 103–140), seed the new fields from `cfg` (add after the `ssoApp:` line, line 136):
```ts
    ssoApp: str(cfg.ssoApp) || SSO_APP_OPTIONS[0],
    ssoAuthorizeUrl: str(cfg.ssoAuthorizeUrl),
    ssoTokenUrl: str(cfg.ssoTokenUrl),
    ssoClientId: str(cfg.ssoClientId),
    ssoScopes: Array.isArray(cfg.ssoScopes) ? (cfg.ssoScopes as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    ssoClientSecret: '',
    apiKeyHeaderName: str(cfg.apiKeyHeaderName),
```

(c) In `applyDraft` (lines 149–182), backfill the non-secret new fields (secrets stay blank). Add after the `ssoApp:` line (line 177):
```ts
    ssoApp: str(cfg.ssoApp) || base.ssoApp,
    ssoAuthorizeUrl: str(cfg.ssoAuthorizeUrl),
    ssoTokenUrl: str(cfg.ssoTokenUrl),
    ssoClientId: str(cfg.ssoClientId),
    ssoScopes: Array.isArray(cfg.ssoScopes) ? (cfg.ssoScopes as unknown[]).filter((s): s is string => typeof s === 'string') : base.ssoScopes,
    ssoClientSecret: '',
    apiKeyHeaderName: str(cfg.apiKeyHeaderName) || base.apiKeyHeaderName,
```

(d) In `buildAuthConfig` (lines 187–209), write the SSO and user-key fields. Replace the `sso` branch and add a `user-key` branch (leave `shared-key`/`user-oauth`/`client-creds` unchanged):
```ts
  } else if (s.authMode === 'sso') {
    cfg.ssoApp = s.ssoApp;
    cfg.ssoClientId = s.ssoClientId.trim();
    cfg.ssoAuthorizeUrl = s.ssoAuthorizeUrl.trim();
    cfg.ssoTokenUrl = s.ssoTokenUrl.trim();
    if (s.ssoClientSecret.trim()) cfg.ssoClientSecret = s.ssoClientSecret.trim();
    if (s.ssoScopes.length > 0) cfg.ssoScopes = s.ssoScopes;
  } else if (s.authMode === 'user-key') {
    if (s.apiKeyHeaderName.trim()) cfg.apiKeyHeaderName = s.apiKeyHeaderName.trim();
  }
  return cfg;
```

(e) Extend `FIELD_LABEL` (lines 211–215) so a server `missing_auth_field` error for the new SSO fields renders a readable label:
```ts
const FIELD_LABEL: Record<string, string> = {
  apiKey: 'mcpDrawer.auth.orgApiKey',
  clientId: 'mcpDrawer.auth.clientId',
  clientSecret: 'mcpDrawer.auth.clientSecret',
  ssoClientId: 'mcpDrawer.auth.ssoClientId',
  ssoAuthorizeUrl: 'mcpDrawer.auth.ssoAuthorizeUrl',
  ssoTokenUrl: 'mcpDrawer.auth.ssoTokenUrl',
};
```

(f) Add an SSO client-side validation branch in `validate()` (lines 329–355), mirroring `missingAuthField` (Task 2). Add this block inside `validate` after the `user-oauth || client-creds` block (after line 353, before the final `return null`):
```ts
    if (state.authMode === 'sso') {
      if (!state.ssoClientId.trim()) {
        return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.ssoClientId') });
      }
      const hasSsoEndpoints = Boolean(state.ssoAuthorizeUrl.trim()) && Boolean(state.ssoTokenUrl.trim());
      if (!hasSsoEndpoints) {
        return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.ssoAuthorizeUrl') });
      }
    }
```
(`user-key` needs no client-side requirement — `apiKeyHeaderName` is optional; the desktop defaults to `X-Api-Key`.)

### Step 3: Render the fields in `ConnectorAuthFields.tsx`

(a) Replace the `user-key` note-only branch (lines 180–182) with a header-name input plus the existing note:
```ts
  if (p.authMode === 'user-key') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.userKeyHeaderName')}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.userKeyHeaderName')}
            placeholder={t('mcpDrawer.auth.userKeyHeaderName.placeholder')}
            value={p.state.apiKeyHeaderName}
            onChange={(e) => p.onChange({ apiKeyHeaderName: e.target.value })}
          />
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.userKeyHeaderName.hint')}</span>
        </label>
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>{t('mcpDrawer.auth.userKey.note')}</p>
      </div>
    );
  }
```

(b) Replace the `sso` branch (lines 227–248) with the app select + the new endpoint fields. Keep the `ssoApp` select and its hint; add the endpoint/client fields and a public-client hint:
```ts
  if (p.authMode === 'sso') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.ssoApp')} {req}
          <select
            className={inputCls}
            aria-label={t('mcpDrawer.auth.ssoApp')}
            value={p.state.ssoApp}
            onChange={(e) => p.onChange({ ssoApp: e.target.value })}
          >
            {SSO_APP_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {t(`mcpDrawer.auth.sso.${v}`)}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.sso.hint')}</span>
        </label>
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.ssoAuthorizeUrl')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.ssoAuthorizeUrl')}
            placeholder={t('mcpDrawer.auth.ssoAuthorizeUrl.placeholder')}
            value={p.state.ssoAuthorizeUrl}
            onChange={(e) => p.onChange({ ssoAuthorizeUrl: e.target.value })}
          />
        </label>
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.ssoTokenUrl')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.ssoTokenUrl')}
            placeholder={t('mcpDrawer.auth.ssoTokenUrl.placeholder')}
            value={p.state.ssoTokenUrl}
            onChange={(e) => p.onChange({ ssoTokenUrl: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.ssoClientId')} {req}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.ssoClientId')}
            placeholder={t('mcpDrawer.auth.ssoClientId.placeholder')}
            value={p.state.ssoClientId}
            onChange={(e) => p.onChange({ ssoClientId: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.ssoClientSecret')}
          <input
            type="password"
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.ssoClientSecret')}
            placeholder={t('mcpDrawer.auth.ssoClientSecret.placeholder')}
            value={p.state.ssoClientSecret}
            onChange={(e) => p.onChange({ ssoClientSecret: e.target.value })}
          />
        </label>
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>{t('mcpDrawer.auth.ssoPublicHint')}</p>
      </div>
    );
  }
```

(No `ssoScopes` UI picker is added in this task — the SSO branch writes `ssoScopes` only when non-empty, and the admin can leave it empty; a scope picker for SSO is a follow-up if needed. This keeps the change minimal and matches the "endpoints + clientId" the desktop needs.)

### Step 4: Typecheck + dead-key check

Run:
```bash
cd enterprise_server/web && npx tsc --noEmit
cd enterprise_server/web && grep -rn "ssoAuthorizeUrl\|ssoTokenUrl\|ssoClientId\|ssoClientSecret\|userKeyHeaderName" src
```
Expected: `tsc` 0 errors; every new i18n key is referenced in `ConnectorAuthFields.tsx` / `ConnectorDrawer.tsx`.

### Step 5: Commit

```bash
git add enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx enterprise_server/web/src/i18n.ts
git commit -m "feat(web): collect SSO endpoints + user-key header name in the connector drawer"
```

---

## Task 4: Desktop types + store — persist `apiKeyHeaderName`

**Files:**
- Modify: `src/renderer/types/mcp.ts`
- Modify: `src/main/mcp/mcpStore.ts`
- Modify: `src/main/auth/enterpriseClient.ts`
- Modify: `src/renderer/types/electron.d.ts`

**Interfaces:**
- Consumes: server public view `apiKeyHeaderName?` (Task 1).
- Produces: `apiKeyHeaderName?: string` on `McpServerConfig` / `McpServerFormData` / `McpConfigJson` (store) and on the market-list wire types — consumed by Task 6 (prefill). The `create`/`update` IPC params are typed `any` (`src/renderer/types/electron.d.ts:570,573`), so no preload change is needed for the write path; only the read-back `McpServerConfigIPC` and store types are typed.

### Step 1: Add the field to the shared renderer types

In `src/renderer/types/mcp.ts`:

(a) `McpServerConfig` (lines 25–46) — add after `oauthConfig?` (line 43):
```ts
  oauthConfig?: McpOAuthEndpoint;
  /** user-key: header name the connector's API key is injected under (absent → desktop defaults to X-Api-Key). */
  apiKeyHeaderName?: string;
```

(b) `McpServerFormData` (lines 68–83) — add after `oauthConfig?` (line 82):
```ts
  oauthConfig?: McpOAuthEndpoint;
  apiKeyHeaderName?: string;
```

(c) `McpEnterpriseMarketServer` (lines 147–166) — add after `oauth?` (line 165):
```ts
  /** Present only for `user-key` with a header name set (non-secret). */
  apiKeyHeaderName?: string;
```

### Step 2: Add the field to the store types

In `src/main/mcp/mcpStore.ts`:

(a) `McpServerRecord` (lines ~15–29) — add after `oauthConfig?` (line 26): `apiKeyHeaderName?: string;`

(b) `McpServerFormData` (lines 31–47) — add after `oauthConfig?` (line 46): `apiKeyHeaderName?: string;`

(c) `McpConfigJson` (lines 78–91) — add after `oauthConfig?` (line 90): `apiKeyHeaderName?: string;`

(d) `deserializeRow` (lines ~248–268) — add after `oauthConfig: config.oauthConfig,` (line 265):
```ts
      oauthConfig: config.oauthConfig,
      apiKeyHeaderName: config.apiKeyHeaderName,
```

(e) `serializeConfig` (lines 271–286) — add after the `oauthConfig` line (line 284):
```ts
    if (data.oauthConfig !== undefined) config.oauthConfig = data.oauthConfig;
    if (data.apiKeyHeaderName !== undefined) config.apiKeyHeaderName = data.apiKeyHeaderName;
```

(f) `updateServer` merge (lines 344–361) — add after the `oauthConfig` line (line 360):
```ts
      oauthConfig: data.oauthConfig !== undefined ? data.oauthConfig : existing.oauthConfig,
      apiKeyHeaderName: data.apiKeyHeaderName !== undefined ? data.apiKeyHeaderName : existing.apiKeyHeaderName,
```

### Step 3: Mirror the field in the market-list wire types

(a) `src/main/auth/enterpriseClient.ts` — `listEnterpriseMcps` has two inline `servers: Array<{...}>` shapes (the return type ~line 318 and the `res.json()` cast ~line 350). In **both**, add after the `oauth?: {...}` field (lines 336 and 368):
```ts
      /** Present only for `user-key` with a header name set (non-secret). */
      apiKeyHeaderName?: string;
```

(b) `src/renderer/types/electron.d.ts` — `listEnterpriseMcps` data shape (~lines 598–617): add after the `oauth?: {...}` field (line 616):
```ts
          /** Present only for `user-key` with a header name set (non-secret). */
          apiKeyHeaderName?: string;
```

(c) `src/renderer/types/electron.d.ts` — `McpServerConfigIPC` (lines 423–465): add after `oauthConfig?` (line 462):
```ts
  oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
  apiKeyHeaderName?: string;
```

### Step 4: Typecheck

Run:
```bash
cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit
cd /Users/paulwang/work/GenWork && npx tsc --noEmit
```
Expected: electron-tsconfig 0 errors; renderer `tsc` shows exactly the 1 pre-existing `bakeArtifactSharePage.ts(382,21)` error and nothing new.

### Step 5: Commit

```bash
git add src/renderer/types/mcp.ts src/main/mcp/mcpStore.ts src/main/auth/enterpriseClient.ts src/renderer/types/electron.d.ts
git commit -m "feat(desktop): thread user-key apiKeyHeaderName through store + wire types"
```

---

## Task 5: Desktop — remap `sso → OAuth`

**Files:**
- Modify: `src/renderer/components/mcp/enterpriseAuthMode.ts`
- Modify: `src/renderer/components/mcp/enterpriseAuthMode.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig.oauthConfig` (populated by Task 4's wire path via `McpServerFormModal` install) and the existing `McpAuthMethod.OAuth` handling in `McpAuthModal`/`buildSaveCredentialPayload`/the main `generic:` bypass.
- Produces: `mapEnterpriseAuthModeToMcpAuthMethod('sso') === McpAuthMethod.OAuth`, so an SSO connector installs as `authMethod=OAuth`, shows the modal's OAuth branch + not-configured guardrail when `oauthConfig` is absent, and submits `providerId: generic:<serverKey>` (reused, no payload change).

**Ruling — no SSO-specific not-configured message.** The desktop `McpServerConfig` stores the *local* `authMethod` (`OAuth`) but not the enterprise wire `authMode`, so at the modal it cannot distinguish an `sso` connector from a `user-oauth` connector — both are `OAuth` with `serverKey` set. Rather than thread a new field through ~5 type sites just to pick a word, this plan **reuses the existing `mcpAuthOAuthNotConfigured` message** for the SSO not-configured case (spec §7 explicitly permits reusing the `user-oauth` wording; the message is generic: "缺少授权/令牌地址 … 暂时无法完成登录"). No new i18n key is added. The guardrail (no Qichacha fallback) is identical for both modes.

**Sign-off (existing assertion):** `enterpriseAuthMode.test.ts:23` currently asserts `sso → McpAuthMethod.Bearer`. This is the neutral placeholder the doc comment describes ("the real org key is gateway-injected in P2"). This feature makes `sso` a **user-credential direct-link** that reuses the OAuth driver, so the correct value is now `OAuth`. The assertion is updated (its title and the `expect`), and the function's doc comment is updated. This is the one sanctioned change to an existing assertion in the whole plan.

### Step 1: Update the test (the sanctioned assertion change)

In `src/renderer/components/mcp/enterpriseAuthMode.test.ts`, change the `sso` test (lines 22–24):
```ts
  test('sso → OAuth (user-credential direct-link, reuses the generic OAuth driver)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('sso')).toBe(McpAuthMethod.OAuth);
  });
```
Leave the `shared-key`/`client-creds` → `Bearer` assertions untouched (those remain the org-credential placeholders for the M2 gateway).

### Step 2: Run the test to verify it fails

Run: `npx vitest run src/renderer/components/mcp/enterpriseAuthMode.test.ts`
Expected: the `sso` test FAILS (implementation still returns `Bearer`); the other 6 pass.

### Step 3: Implement the remap

In `src/renderer/components/mcp/enterpriseAuthMode.ts`, move `sso` from the `Bearer` group into the `OAuth` group (lines 16–29):
```ts
    case 'user-oauth':
      return McpAuthMethod.OAuth;
    case 'sso':
      return McpAuthMethod.OAuth;
    case 'shared-key':
    case 'client-creds':
      return McpAuthMethod.Bearer;
```
Update the function's leading doc comment (lines 4–12): change "Org-credential modes (shared-key / client-creds / sso) map to a neutral placeholder" to reflect that `sso` is now a user-credential direct-link. New comment:
```ts
/**
 * Map an enterprise connector's wire `authMode` (6 modes) to the local
 * `McpAuthMethod` the install form should pre-fill. The downstream
 * `deriveAuthStatus` (mcpStore) then turns a non-None method with no
 * credential into the `needs-auth` state (orange dot + Connect button), which
 * is the spec's 待配置 affordance.
 *
 * - User-credential direct-link modes map to their real method:
 *   `user-oauth`/`sso` → OAuth (both drive the same generic PKCE flow off the
 *   connector's own endpoints), `user-key` → ApiKey.
 * - Org-credential modes (shared-key / client-creds) map to a neutral
 *   placeholder: the org key is gateway-injected in the MCP-gateway plan, so
 *   the desktop just parks them in needs-auth.
 */
```

### Step 4: Run the test + typecheck

Run:
```bash
npx vitest run src/renderer/components/mcp/enterpriseAuthMode.test.ts
cd /Users/paulwang/work/GenWork && npx tsc --noEmit
```
Expected: the test PASSES (all 7); renderer `tsc` shows only the pre-existing `bakeArtifactSharePage.ts(382,21)` error.

### Step 5: Commit

```bash
git add src/renderer/components/mcp/enterpriseAuthMode.ts src/renderer/components/mcp/enterpriseAuthMode.test.ts
git commit -m "feat(desktop): route sso connectors through the generic OAuth driver"
```

---

## Task 6: Desktop — user-key install prefill

**Files:**
- Modify: `src/renderer/components/mcp/McpServerFormModal.tsx`

**Interfaces:**
- Consumes: `McpEnterpriseMarketServer.apiKeyHeaderName` (Task 4).
- Produces: an installed `user-key` connector pre-fills the header name from the admin (default `X-Api-Key`).

**No SSO modal change is needed.** Because `sso` now maps to `McpAuthMethod.OAuth` (Task 5), an SSO connector already: (a) installs as `authMethod=OAuth`, (b) shows the modal's existing OAuth not-configured guardrail panel when `server.serverKey && !server.oauthConfig` (`McpAuthModal.tsx:156-168`), (c) submits `providerId: generic:<serverKey>` via the unchanged `buildSaveCredentialPayload`, and (d) shows the existing `mcpAuthOAuthNotConfigured` message on a blocked submit (`McpAuthModal.tsx:73-76`). The guardrail (never opens `agent.qcc.com`) is identical to `user-oauth`. So this task only adds the user-key header-name prefill.

### Step 1: Prefill the user-key header name on install

In `src/renderer/components/mcp/McpServerFormModal.tsx`, in the enterprise-install branch of the reset `useEffect` (lines 150–166), replace the hardcoded `setApiKeyName('X-Api-Key')` (line 166) with a server-driven default:
```ts
      setAuthMethod(mapEnterpriseAuthModeToMcpAuthMethod(enterpriseServer.authMode));
      setBearerValue('');
      setApiKeyValue('');
      // user-key: pre-fill the admin-configured header name (default X-Api-Key).
      setApiKeyName(enterpriseServer.apiKeyHeaderName?.trim() || 'X-Api-Key');
```
The other `setApiKeyName('X-Api-Key')` calls (create/edit/registry branches, lines 115/149/180) stay as-is — the server-driven name only applies to enterprise installs.

### Step 2: Typecheck

Run: `cd /Users/paulwang/work/GenWork && npx tsc --noEmit`
Expected: exactly 1 pre-existing error `bakeArtifactSharePage.ts(382,21)`, no new errors.

### Step 3: Commit

```bash
git add src/renderer/components/mcp/McpServerFormModal.tsx
git commit -m "feat(desktop): prefill the admin-configured user-key header name on install"
```

---

## Task 7: Full verification sweep (per-file) + final typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run every touched test file, individually**

```bash
cd enterprise_server
npx vitest run tests/models/connectorView.test.ts
npx vitest run tests/routes/mcpConnectors.test.ts
cd /Users/paulwang/work/GenWork
npx vitest run src/renderer/components/mcp/enterpriseAuthMode.test.ts
npx vitest run src/renderer/components/mcp/mcpAuthModalHelpers.test.ts
# CI-gated (better-sqlite3 ABI in sandbox — note if they can't run here):
npx vitest run src/main/mcp/mcpStore.test.ts
npx vitest run src/main/mcp/mcpAuthFlows.test.ts
```
Expected: `connectorView`, `mcpConnectors`, `enterpriseAuthMode`, `mcpAuthModalHelpers` all PASS. The two desktop main tests may show the pre-existing `better-sqlite3.node` ABI error (unrelated; note it, don't chase it).

- [ ] **Step 2: Full typecheck, all three targets**

```bash
cd enterprise_server && npx tsc --noEmit                                   # 0
cd /Users/paulwang/work/GenWork/enterprise_server/web && npx tsc --noEmit  # 0
cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit            # 0
npx tsc --noEmit        # renderer — only bakeArtifactSharePage.ts(382,21)
```

- [ ] **Step 3: Verify no dead i18n keys**

```bash
# admin SPA (web) — every added key referenced + present in en+zh:
grep -rn "ssoAuthorizeUrl\|ssoTokenUrl\|ssoClientId\|ssoClientSecret\|userKeyHeaderName" enterprise_server/web/src
```
Expected: each added admin key is referenced in `ConnectorDrawer.tsx` / `ConnectorAuthFields.tsx` and present in both the `en` and `zh` blocks. (The desktop adds **no** new i18n key — SSO reuses the existing `mcpAuthOAuthNotConfigured`, per the Task 5 ruling.)

- [ ] **Step 4: Confirm clean tree**

```bash
git status --porcelain   # must be empty (all committed)
```

- [ ] **Step 5: (Manual, if available) M2-free e2e smoke** — With an admin-configured `sso` connector (complete `sso*` endpoints) and a `user-key` connector (with a header name), confirm on the desktop: the SSO connector installs as an OAuth method, shows the not-configured guardrail when the endpoints were left unset (and never opens `agent.qcc.com`), and opens the connector's own authorize window when configured; the user-key connector pre-fills the admin header name (defaulting to `X-Api-Key`). (No IdP reachable in the sandbox → record that the live PKCE e2e is deferred to manual verification.)

---

## Self-Review (run before handing to execution)

**Spec coverage (M0+M1 SSO + user-key delta):**
- §4.1 admin `auth_config` — SSO `sso*` fields (Task 3) + user-key `apiKeyHeaderName` (Task 3). `ssoClientSecret` accepted but not required (spec §13.5 public-client default).
- §4.2 public view `oauth` extended to `sso` — Task 1. (`provider` field deliberately **omitted**: the desktop reuses `generic:<serverKey>`, so no `provider` is needed; the `oauth` shape is unchanged.) `shared-key`/`client-creds` still expose no `authConfig` (Task 1 fills `oauth` only for `user-oauth`/`sso`).
- §4.3 desktop `oauthConfig` — already persisted (merged); reused unchanged. `apiKeyHeaderName` persisted (Task 4).
- §5.1/§5.2 generic driver reuse — SSO reuses `generic:<serverKey>` + the existing `genericOauthFlow`/`runGenericOauthFlow`/main bypass (Task 5 remap; **no payload/driver/bypass change**).
- §5.4 guardrail — already present for `user-oauth` (`buildSaveCredentialPayload` returns `null` for a `serverKey` without endpoints; no Qichacha fallback); now applies to SSO via the `sso→OAuth` remap (Task 5). The existing `mcpAuthOAuthNotConfigured` message + not-configured panel are reused for SSO (Task 5 ruling — no new desktop key, per spec §7 "可复用").
- §5.5 user-key wiring — admin header name (Task 3) + public-view projection (Task 1) + desktop prefill (Task 6); the value path (vault + header) is unchanged.
- §7 admin SPA + `missingAuthField` — Task 2 (server) + Task 3 (SPA validation mirroring it).
- **Deliberately NOT in this plan:** §5.3 target-URL selection + §6 MCP gateway (`shared-key`/`client-creds` → gateway URL + JWT) — that is the M2 plan. §5.5's "re-auth reuses the ApiKey branch" already holds (no change needed).

**No gaps found for the M0+M1 SSO + user-key scope.**

**Placeholder scan:** none — every step has concrete code or an explicit run command. The one judgment call (Task 6 SSO-vs-OAuth not-configured wording) is given a concrete default (fallback) plus a concrete alternative.

**Type consistency:** `oauth` stays `{ authorizeUrl, tokenUrl, clientId, scopes? }` in all four sites (unchanged — no `provider` added). `apiKeyHeaderName?: string` is spelled identically across server `ConnectorPublicView`, `McpEnterpriseMarketServer`, `McpServerConfig`, store `McpServerRecord`/`McpServerFormData`/`McpConfigJson`, `McpServerConfigIPC`, the two `enterpriseClient.ts` inline shapes, the `electron.d.ts` market shape, and `ConnectorFormState`. `providerId` stays `generic:<serverKey>` for both `user-oauth` and `sso`.

**Existing-test impact:**
- `enterpriseAuthMode.test.ts:23` (`sso → Bearer`) — **intentionally changed to `sso → OAuth`** (Task 5, sanctioned; it is the placeholder this feature replaces). The `shared-key`/`client-creds` → `Bearer` assertions are unchanged.
- `connectorView.test.ts` — only ADDITIVE assertions (Tasks 1). The existing `oauth` tests use `user-oauth` (base) and `client-creds` (non-oauth → undefined); both remain valid because the `user-oauth` field names and the `client-creds`→`undefined` behavior are unchanged.
- `mcpConnectors.test.ts` — only ADDITIVE assertions (Task 2). The `sse + oauth-family` test (line 216, includes `sso`) still passes because `sseOauthCombination` is checked before `missingAuthField`. `connectorSecret.test.ts:19` (`secretFieldFor('sso') → null`) is untouched (Task 1 makes no vault change).
- `mcpAuthModalHelpers.test.ts` — untouched (no `buildSaveCredentialPayload` change).
