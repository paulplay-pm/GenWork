# MCP Connector — Desktop per-provider OAuth login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each enterprise MCP connector with `authMode: 'user-oauth'` log in using ITS OWN admin-configured OAuth endpoints (generic authorization-code + PKCE), instead of every such connector wrongly opening the hardcoded Qichacha (`agent.qcc.com`) login window.

**Architecture:** Three layers. (1) **Admin console** collects two new non-secret fields (`authorizeUrl`/`tokenUrl`) per `user-oauth` connector. (2) **Server** exposes a whitelist-picked non-secret `oauth` sub-object on the public (desktop) market view — never `clientSecret`/`__enc__*` — and relaxes `missingAuthField` to accept the public-client (no-secret) form. (3) **Desktop** persists `oauthConfig`+`serverKey` on the connector record, drives a generic PKCE flow keyed by `serverKey`, and guards against silently falling back to Qichacha. The Qichacha built-in bundle is untouched (no `serverKey` → its qichacha path is preserved by default).

**Tech Stack:** Electron (main + renderer, better-sqlite3 for the local MCP store), Hono + Postgres (enterprise server), React + TanStack (admin SPA), vitest (per-file), TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-27-mcp-connector-desktop-oauth-design.md` (the plan argues from this spec; the IdP is confirmed to support public client + PKCE + localhost redirect, so the plan takes the spec's main path and relaxes `missingAuthField`).

## Global Constraints

- **Test code is authoritative.** Only ADD assertions; do NOT modify any existing test's assertions. (Verified: this plan requires **zero** changes to existing tests — see the pre-flight conflict table.)
- **Per-file vitest only** (full-suite runs hit EBADF/fd exhaustion in the sandbox): `npx vitest run <file>`.
- **Desktop main-process store tests are CI-gated:** `mcpStore.test.ts` / `mcpAuthFlows.test.ts` fail in this sandbox with a pre-existing `better-sqlite3.node` ABI error (`new Database(':memory:')`). Keep the new pure logic OUT of `better-sqlite3`-importing modules so it's testable; main-store integration assertions are added but expected to be green only in CI (note this in the commit message).
- **Typecheck baselines (must hold after each task):**
  - server: `cd enterprise_server && npx tsc --noEmit` → 0
  - web: `cd enterprise_server/web && npx tsc --noEmit` → 0
  - desktop main: `cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit` → 0 (covers `src/main`, `src/common`, `src/shared`)
  - desktop renderer: `cd /Users/paulwang/work/GenWork && npx tsc --noEmit` (root `tsconfig.json`, which includes `src/renderer`) → exactly 1 pre-existing error `bakeArtifactSharePage.ts(382,21)`.
- **i18n en + zh both, no un-referenced keys.** Desktop `t(key)` does NOT interpolate (manual `.replace` at call sites).
- **Secrets:** `clientSecret` stays encrypted server-side and never crosses the wire to the desktop. The public view emits ONLY non-secret OAuth fields via an explicit whitelist; do NOT reuse `maskConnectorSecrets` (that's admin-mask-display semantics).
- **Auto-commit LOCAL ONLY; never push.** commitlint: lowercase-first commit subjects. `git add` every touched file; `git status --porcelain` clean after each commit.
- **No new top-level npm deps; no new `PermissionPoint`** (reuse `mcp:*`).
- **Logs never contain tokens, secrets, or userinfo PII.**

---

## File Structure

| File | Responsibility (created/modified by) |
|---|---|
| `enterprise_server/src/models/connectorView.ts` | `ConnectorPublicView.oauth?` + whitelist pick in `mapPublicConnector` (Task 1) |
| `enterprise_server/tests/models/connectorView.test.ts` | public-view `oauth` whitelist tests (Task 1) |
| `enterprise_server/src/routes/mcpConnectors.ts` | `missingAuthField` public-client relaxation (Task 2) |
| `enterprise_server/tests/routes/mcpConnectors.test.ts` | new public-client create/publish assertions (Task 2) |
| `enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx` | `authorizeUrl` form state + `buildAuthConfig` + `validate()` (Task 3) |
| `enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx` | `authorizeUrl`+`tokenUrl` inputs for user-oauth (Task 3) |
| `enterprise_server/web/src/i18n.ts` | `mcpDrawer.auth.authorizeUrl` en+zh (Task 3) |
| `src/main/mcp/mcpStore.ts` | `oauthConfig?`/`serverKey?` on record/configJson/form-data + serialize/deserialize/merge (Task 4) |
| `src/main/mcp/genericOauthFlow.ts` (+ `.test.ts`) | pure PKCE/URL/token-exchange helpers + `runGenericOauthFlow` (Task 5) |
| `src/main/mcp/mcpAuthFlows.ts` | `SaveCredentialPayload.oauth` `oauthConfig?` + registry bypass (Task 6) |
| `src/main/preload.ts` | `SaveCredentialPayloadLike.oauth` `oauthConfig?` mirror (Task 6) |
| `src/renderer/types/mcp.ts` | `McpServerConfig.oauthConfig?`/`serverKey?`, `McpEnterpriseMarketServer.oauth?` (Task 4) |
| `src/main/auth/enterpriseClient.ts` | inline wire type gains `oauth?` (Task 4) |
| `src/renderer/components/mcp/mcpAuthModalHelpers.ts` (+ test) | `SaveCredentialPayloadOAuth.oauthConfig?`, `McpAuthFormFields.serverKey?/oauthConfig?`, `buildSaveCredentialPayload` generic + guardrail (Task 7) |
| `src/renderer/components/mcp/McpAuthModal.tsx` | pass `serverKey`/`oauthConfig`; not-configured message (Task 8) |
| `src/renderer/components/mcp/McpServerFormModal.tsx` | attach `oauthConfig`+`serverKey` on enterprise install (Task 8) |
| `src/renderer/services/i18n.ts` | `mcpAuthOAuthNotConfigured` en+zh (Task 8) |

---

## Pre-flight conflict table (run before Task 1)

| Pair / site | Produced vs consumed | Finding | Ruling |
|---|---|---|---|
| `mcpAuthModalHelpers.test.ts:49` (existing) vs Task 7 helper change | existing asserts `buildSaveCredentialPayload(OAuth, {}) → {providerId:'qichacha'}`; new code must not break it | `{}` has no `serverKey` → falls to the qichacha default branch. **Preserved unchanged.** | No sign-off needed. New behavior is keyed on `serverKey` presence; the empty-form default stays qichacha. |
| `mcpConnectors.test.ts:229-243` (existing) vs Task 2 `missingAuthField` relaxation | existing asserts `client-creds` missing `clientId` → 400; `shared-key` missing `apiKey` → 400; `none` passes. No existing test locks "user-oauth requires clientSecret". | The relaxation is **additive** (accepts a new valid form); existing assertions still hold. | No sign-off needed. New public-client case gets NEW assertions only. |
| `connectorSecret.test.ts:16` `secretFieldFor('user-oauth')==='clientSecret'` (existing) vs Task 2 | the relaxation touches `missingAuthField` (routes), NOT `secretFieldFor` (vault) | Untouched module. Encryption list unchanged. | No conflict. |
| `connectorView.test.ts:81` `not.toHaveProperty('authConfig')` (existing) vs Task 1 | existing asserts the public view has no `authConfig`; we ADD `oauth` (a different key) | `oauth` ≠ `authConfig`; the existing assertion still holds. New `oauth` assertions are additive. | No conflict. |
| Task 4 (store `oauthConfig`/`serverKey`) vs Task 6 (`saveCredential` reads `record.oauthConfig`) | Task 6 bypass reads `payload.oauthConfig` (from the renderer), not the store — store persistence is independent | No ordering dependency for correctness; Task 4 threads the field so the modal can read it back on re-authorize. | Task 4 before Task 7/8 (data link) so the field exists end-to-end. |
| Task 5 (`genericOauthFlow`) vs Task 6 (`mcpAuthFlows` bypass calls it) | Task 6 imports `runGenericOauthFlow` from Task 5 | Hard dependency. | Task 5 before Task 6. |
| `normalizeMcpServerInput` (handlers.ts:34) | it normalizes only `url` and returns `{...data}`; no field whitelist | `oauthConfig`/`serverKey` pass through `createServer`/`updateServer` automatically once in `McpServerFormData`. | No change needed in handlers. |
| `sseOauthCombination` (mcpConnectors.ts:166) | rejects `sse`+`user-oauth`; unchanged | Desktop-driven `user-oauth` is http-only (matches admin constraint). | No change. |

**Milestone order (spec §10):** M0 guardrail (Task 7 + Task 8 message) → M1 data link (Tasks 1–4, 8 wiring) → M2 generic driver (Tasks 5, 6). In practice the tasks are sequenced bottom-up so each builds on a compiling prior state: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. The guardrail (Task 7/8) and driver (Task 5/6) are the two milestones; the data link (1–4) is shared foundation.

---

## Task 1: Server — public view exposes non-secret `oauth` sub-object (whitelist)

**Files:**
- Modify: `enterprise_server/src/models/connectorView.ts:105-122` (`ConnectorPublicView`) and `:192-211` (`mapPublicConnector`)
- Test: `enterprise_server/tests/models/connectorView.test.ts` (add cases; the `makeRow` helper at :48 already builds a `ConnectorRow`)

**Interfaces:**
- Produces: `ConnectorPublicView.oauth?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }`. `mapPublicConnector(row)` fills `oauth` **iff** `row.auth_mode === 'user-oauth'` AND `row.auth_config.authorizeUrl` AND `row.auth_config.tokenUrl` are non-empty strings. It picks ONLY the whitelist keys from `auth_config`, explicitly ignoring `clientSecret` and any `__enc__*`. Otherwise `oauth` is `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `enterprise_server/tests/models/connectorView.test.ts` (after the existing `describe('mapPublicConnector', …)` block, add a new `describe`):

```ts
describe('mapPublicConnector.oauth (user-oauth whitelist)', () => {
  const base = {
    auth_mode: 'user-oauth' as const,
    auth_config: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-client-123',
      scopes: ['openid', 'profile'],
      clientSecret: 'shoud-not-leak-plaintext',
      __enc__clientSecret: 'ENC_CIPHERTEXT_DO_NOT_LEAK',
    },
  };
  test('fills oauth from the whitelist when endpoints are complete', () => {
    const v = mapPublicConnector(makeRow(base));
    expect(v.oauth).toEqual({
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-client-123',
      scopes: ['openid', 'profile'],
    });
  });
  test('never leaks clientSecret or __enc__* into the public view', () => {
    const v = mapPublicConnector(makeRow(base));
    expect(v).not.toHaveProperty('clientSecret');
    expect(JSON.stringify(v)).not.toContain('shoud-not-leak-plaintext');
    expect(JSON.stringify(v)).not.toContain('ENC_CIPHERTEXT_DO_NOT_LEAK');
    expect(JSON.stringify(v)).not.toContain('__enc__');
  });
  test('oauth is undefined when an endpoint is missing', () => {
    expect(mapPublicConnector(makeRow({ ...base, auth_config: { clientId: 'c' } })).oauth).toBeUndefined();
    expect(
      mapPublicConnector(makeRow({ ...base, auth_config: { clientId: 'c', authorizeUrl: 'https://a', tokenUrl: '' } })).oauth,
    ).toBeUndefined();
  });
  test('oauth is undefined for non-user-oauth modes even with endpoints set', () => {
    const v = mapPublicConnector(makeRow({ ...base, auth_mode: 'client-creds' }));
    expect(v.oauth).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/models/connectorView.test.ts`
Expected: the new `describe` fails (`v.oauth` is `undefined` / `v` has no `oauth`); the 13 existing cases still pass.

- [ ] **Step 3: Implement**

In `connectorView.ts`, add `oauth?` to the `ConnectorPublicView` interface (after `enabled`/`toolCount`, ~line 121):

```ts
  /** Present only for `user-oauth` with complete endpoints. Non-secret only —
   * never carries `clientSecret` or any `__enc__*` ciphertext. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
```

Add a pure whitelist helper + fill in `mapPublicConnector`:

```ts
/** Pick the non-secret user-oauth endpoints from a stored auth_config.
 * Whitelist-only; ignores `clientSecret` and every `__enc__*` key. Returns
 * undefined when either endpoint is missing (desktop then shows the
 * not-configured guardrail, never falls back to a default provider). */
function pickPublicOauth(authConfig: Record<string, unknown>): ConnectorPublicView['oauth'] | undefined {
  const authorizeUrl = typeof authConfig.authorizeUrl === 'string' ? authConfig.authorizeUrl.trim() : '';
  const tokenUrl = typeof authConfig.tokenUrl === 'string' ? authConfig.tokenUrl.trim() : '';
  if (!authorizeUrl || !tokenUrl) return undefined;
  const clientId = typeof authConfig.clientId === 'string' ? authConfig.clientId.trim() : '';
  const scopes = Array.isArray(authConfig.scopes)
    ? authConfig.scopes.filter((s): s is string => typeof s === 'string')
    : undefined;
  const out: ConnectorPublicView['oauth'] = { authorizeUrl, tokenUrl, clientId };
  if (scopes && scopes.length > 0) out.scopes = scopes;
  return out;
}
```

In `mapPublicConnector`, add the `oauth` field to the returned object (it is `undefined` for all non-user-oauth modes because `pickPublicOauth` is only called for them, and the ternary yields `undefined`):

```ts
  // after `toolCount: …`, inside the returned object:
  oauth: row.auth_mode === 'user-oauth' ? pickPublicOauth(row.auth_config) : undefined,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/models/connectorView.test.ts`
Expected: all pass (13 existing + 4 new).

- [ ] **Step 5: Typecheck + commit**

```bash
cd enterprise_server && npx tsc --noEmit   # 0
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/models/connectorView.ts enterprise_server/tests/models/connectorView.test.ts && git status --porcelain
git commit -m "feat(mcp): expose non-secret oauth endpoints on the public connector view"
```

---

## Task 2: Server — relax `missingAuthField` for the public-client (no-secret) user-oauth form

**Files:**
- Modify: `enterprise_server/src/routes/mcpConnectors.ts:156-164` (`missingAuthField`)
- Test: `enterprise_server/tests/routes/mcpConnectors.test.ts` (add cases; reuse the file's existing `baseBody`/`createConnector`/`superAdminTok`/`seedOrgs` helpers)

**Interfaces:**
- Consumes: `authConfig` shape `{ clientId?, clientSecret?, authorizeUrl?, tokenUrl? }`.
- Produces: `missingAuthField(authMode, authConfig)`:
  - `user-oauth` returns `null` (valid) when `clientId` present AND (`clientSecret` present OR (`authorizeUrl` AND `tokenUrl` present)); else returns the first missing of `clientId` → `clientSecret`.
  - `client-creds` UNCHANGED (requires `clientId` + `clientSecret`).
  - `shared-key`/`none`/`user-key`/`sso` UNCHANGED.

- [ ] **Step 1: Write the failing test**

Add a `test` inside the existing describe that exercises the create guard (near the `missing per-mode secret` test at :229). Confirm the exact helper names (`baseBody`, `createConnector`, `superAdminTok`, `seedOrgs`) from the top of the file before running.

```ts
test('user-oauth public-client form (authorizeUrl+tokenUrl+clientId, no secret) passes the guard; confidential form (no endpoints) still needs clientSecret', async () => {
  await seedOrgs();
  const tok = await superAdminTok('o1');

  // Public client + PKCE: no secret, but complete endpoints → accepted.
  const pub = await createConnector(tok, baseBody({
    serverKey: 'fxsk-oauth',
    authMode: 'user-oauth',
    authConfig: {
      clientId: 'public-cid',
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
    },
  }));
  expect(pub.status).toBe(201);

  // user-oauth with endpoints but no clientId → still needs clientId.
  const noCid = await createConnector(tok, baseBody({
    serverKey: 'fxsk-no-cid',
    authMode: 'user-oauth',
    authConfig: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
    },
  }));
  expect(noCid.status).toBe(400);
  expect(await noCid.json()).toEqual({ error: 'missing_auth_field', field: 'clientId' });

  // user-oauth WITHOUT endpoints → confidential-client path → needs clientSecret.
  const noEndpoints = await createConnector(tok, baseBody({
    serverKey: 'fxsk-no-endpoints',
    authMode: 'user-oauth',
    authConfig: { clientId: 'cid' },
  }));
  expect(noEndpoints.status).toBe(400);
  expect(await noEndpoints.json()).toEqual({ error: 'missing_auth_field', field: 'clientSecret' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpConnectors.test.ts`
Expected: the public-client case (201) FAILS today — the current code returns 400 `clientSecret` because it unconditionally requires `clientSecret` for `user-oauth`. (The `clientId`-missing and `clientSecret`-missing cases already pass.)

- [ ] **Step 3: Implement**

Replace the `user-oauth`/`client-creds` branch of `missingAuthField` (mcpConnectors.ts:158-162):

```ts
  if (authMode === 'user-oauth' || authMode === 'client-creds') {
    if (!authConfig.clientId) return 'clientId';
    if (authMode === 'user-oauth') {
      // Public client + PKCE (desktop-driven): complete authorize/token endpoints
      // are enough — no client secret crosses the wire. Confidential client: a
      // clientSecret is still required (used by the server-side gateway, not the
      // desktop). The relaxation is additive — the existing confidential path is
      // preserved when endpoints are absent.
      const hasPublicEndpoints = Boolean(authConfig.authorizeUrl) && Boolean(authConfig.tokenUrl);
      if (authConfig.clientSecret || hasPublicEndpoints) return null;
      return 'clientSecret';
    }
    return authConfig.clientSecret ? null : 'clientSecret';
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpConnectors.test.ts`
Expected: all pass (existing 19 + new 1). Confirm the pre-existing `missing per-mode secret` test at :229 still passes unchanged.

- [ ] **Step 5: Typecheck + commit**

```bash
cd enterprise_server && npx tsc --noEmit   # 0
cd /Users/paulwang/work/GenWork && git add enterprise_server/src/routes/mcpConnectors.ts enterprise_server/tests/routes/mcpConnectors.test.ts && git status --porcelain
git commit -m "feat(mcp): allow public-client user-oauth connectors without a client secret"
```

---

## Task 3: Admin console — `authorizeUrl`/`tokenUrl` fields for user-oauth

**Files:**
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx` — `ConnectorFormState` (:44), `initState` (:102), `applyDraft` (:146), `buildAuthConfig` (:183), client-side `validate()` (:323)
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx` — user-oauth section (:257 onward)
- Modify: `enterprise_server/web/src/i18n.ts` — add `mcpDrawer.auth.authorizeUrl` + `.placeholder` (en near :665; zh near :1673)

**Interfaces:**
- Produces: `ConnectorFormState.authorizeUrl: string`. `buildAuthConfig` writes `cfg.authorizeUrl` (and `cfg.tokenUrl`) for `user-oauth`. `validate()` requires `clientId`, and requires `clientSecret` **only** when `authorizeUrl`+`tokenUrl` are not both present.
- Note: the admin console has **no existing component tests** for the drawer — this task is typecheck-verified only. Flag this in the commit message (per spec §9).

- [ ] **Step 1: Add `authorizeUrl` to the form state**

In `ConnectorDrawer.tsx`, add `authorizeUrl: string;` to `ConnectorFormState` (after `tokenUrl`, line 60). In `initState` (line 131, next to `tokenUrl: str(cfg.tokenUrl)`), add `authorizeUrl: str(cfg.authorizeUrl),`. In `applyDraft` (line 170, next to `tokenUrl`), add `authorizeUrl: str(cfg.authorizeUrl),`.

- [ ] **Step 2: `buildAuthConfig` writes the new fields for user-oauth**

Update the `user-oauth` branch of `buildAuthConfig` (lines 190-194) to also carry the endpoints (keep the existing `callbackUrl`/`clientId`/`clientSecret`/`scopes`):

```ts
  } else if (s.authMode === 'user-oauth') {
    cfg.callbackUrl = s.callbackUrl.trim() || CALLBACK_URL_DEFAULT;
    cfg.clientId = s.clientId.trim();
    cfg.authorizeUrl = s.authorizeUrl.trim();
    cfg.tokenUrl = s.tokenUrl.trim();
    if (s.clientSecret.trim()) cfg.clientSecret = s.clientSecret.trim();
    cfg.scopes = s.scopes;
  }
```

- [ ] **Step 3: Relax client-side `validate()` to mirror the server rule**

Replace the `user-oauth`/`client-creds` block in `validate()` (lines 331-338):

```ts
    if (state.authMode === 'user-oauth' || state.authMode === 'client-creds') {
      if (!state.clientId.trim()) {
        return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.clientId') });
      }
      if (state.authMode === 'client-creds') {
        if (!state.clientSecret.trim() && !hasSecret.clientSecret) {
          return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.clientSecret') });
        }
      } else {
        // user-oauth: public client (PKCE) is valid with endpoints + no secret;
        // the confidential client still needs a secret when endpoints are absent.
        const hasPublicEndpoints = Boolean(state.authorizeUrl.trim()) && Boolean(state.tokenUrl.trim());
        if (!hasPublicEndpoints && !state.clientSecret.trim() && !hasSecret.clientSecret) {
          return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.clientSecret') });
        }
      }
    }
```

- [ ] **Step 4: Add the inputs in `ConnectorAuthFields.tsx` (user-oauth)**

In the user-oauth return block (after the read-only `callbackUrl` label at :259, before `clientId` at :279), add two inputs modeled on the client-creds `tokenUrl` input (:188). Both are required:

```tsx
      <label className={labelCls}>
        {t('mcpDrawer.auth.authorizeUrl')} {req}
        <input
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.authorizeUrl')}
          placeholder={t('mcpDrawer.auth.authorizeUrl.placeholder')}
          value={p.state.authorizeUrl}
          onChange={(e) => p.onChange({ authorizeUrl: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        {t('mcpDrawer.auth.tokenUrl')} {req}
        <input
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.tokenUrl')}
          placeholder={t('mcpDrawer.auth.tokenUrl.placeholder')}
          value={p.state.tokenUrl}
          onChange={(e) => p.onChange({ tokenUrl: e.target.value })}
        />
      </label>
```

(Note: the `mcpDrawer.auth.tokenUrl` input currently only appears for `client-creds`; it is now also used here for `user-oauth` — the same i18n key is reused, so no new key for `tokenUrl`.)

- [ ] **Step 5: Add i18n keys (en + zh)**

In `enterprise_server/web/src/i18n.ts`, next to `mcpDrawer.auth.tokenUrl` (en :665 / zh :1673), add:

```ts
// en (near line 665):
  'mcpDrawer.auth.authorizeUrl': 'Authorize URL',
  'mcpDrawer.auth.authorizeUrl.placeholder': 'https://auth.example.com/oauth/authorize',
// zh (near line 1673):
  'mcpDrawer.auth.authorizeUrl': '授权地址',
  'mcpDrawer.auth.authorizeUrl.placeholder': 'https://auth.example.com/oauth/authorize',
```

- [ ] **Step 6: Typecheck + commit**

```bash
cd enterprise_server/web && npx tsc --noEmit   # 0
cd /Users/paulwang/work/GenWork && git add enterprise_server/web/src/pages/mcpManage/ConnectorDrawer.tsx enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx enterprise_server/web/src/i18n.ts && git status --porcelain
git commit -m "feat(web): collect authorize/token endpoints for user-oauth connectors"
```
(No component tests exist for the drawer — this commit is typecheck-verified; say so in the message.)

---

## Task 4: Desktop — persist `oauthConfig` + `serverKey` on the connector record and wire the type

**Files:**
- Modify: `src/main/mcp/mcpStore.ts` — `McpServerRecord` (:7), `McpServerFormData` (:29), `McpConfigJson` (:63), `deserializeRow` (:217), `serializeConfig` (:252), `updateServer` merge (:319)
- Modify: `src/renderer/types/mcp.ts` — `McpServerConfig` (:14), `McpServerFormData` (:55), `McpEnterpriseMarketServer` (:132)
- Modify: `src/main/auth/enterpriseClient.ts` — `listEnterpriseMcps` inline wire type (:318-335 and :348-365)
- Test: `src/main/mcp/mcpStore.test.ts` — additive `oauthConfig`/`serverKey` round-trip (CI-gated, see Global Constraints)

**Interfaces:**
- Produces: `McpServerConfig.oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }`, `McpServerConfig.serverKey?: string`, and the same two optional fields on `McpEnterpriseMarketServer` (named `oauth?` there, matching the server public view) and `McpServerFormData` (both). The store round-trips both through the `config_json` blob (no migration).
- `oauth` shape is identical across the four locations — single source, keep in sync.

- [ ] **Step 1: Write the failing store round-trip test**

Add to `src/main/mcp/mcpStore.test.ts` (uses the file's existing `db`/`store` setup):

```ts
test('round-trips oauthConfig and serverKey through the config blob', () => {
  const s = store.createServer({
    name: 'fxsk',
    description: 'fenxiang',
    transportType: 'http',
    url: 'https://fxsk.example.com/mcp',
    authMethod: McpAuthMethod.OAuth, // the test file already imports McpAuthMethod (see its top)
    serverKey: 'fxsk-mcp',
    oauthConfig: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-cid',
      scopes: ['openid'],
    },
  });
  expect(s.serverKey).toBe('fxsk-mcp');
  expect(s.oauthConfig?.clientId).toBe('public-cid');

  const updated = store.updateServer(s.id, {
    oauthConfig: { authorizeUrl: 'https://x', tokenUrl: 'https://y', clientId: 'c2' },
  });
  expect(updated?.oauthConfig?.clientId).toBe('c2');
});
```

If the `McpServerFormData`/`authMethod` type does not already accept `'oauth'`, use the real `McpAuthMethod.OAuth` constant (import from `../../shared/mcp/constants`) instead of the `as never`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/mcp/mcpStore.test.ts`
Expected: FAILS in the sandbox with the pre-existing `better-sqlite3.node` ABI error (documented) — OR, if the sandbox happens to load the native module, FAILS because `serverKey`/`oauthConfig` are not yet persisted. Record which; the assertion is correct either way.

- [ ] **Step 3: Add the fields to the store**

In `mcpStore.ts`:
- `McpServerRecord` (:7): add `serverKey?: string;` and `oauthConfig?: McpOAuthEndpoint;` (see type below).
- `McpConfigJson` (:63): add `serverKey?: string;` and `oauthConfig?: McpOAuthEndpoint;`.
- `McpServerFormData` (:29): add `serverKey?: string;` and `oauthConfig?: McpOAuthEndpoint;`.
- Add the shared type near `McpOAuthCredential` (:45):
```ts
export interface McpOAuthEndpoint {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}
```
- `deserializeRow` (:246): add `serverKey: config.serverKey,` and `oauthConfig: config.oauthConfig,`.
- `serializeConfig` (:263): add
```ts
    if (data.serverKey !== undefined) config.serverKey = data.serverKey;
    if (data.oauthConfig !== undefined) config.oauthConfig = data.oauthConfig;
```
- `updateServer` merge (:337, next to `oauth`): add
```ts
      serverKey: data.serverKey !== undefined ? data.serverKey : existing.serverKey,
      oauthConfig: data.oauthConfig !== undefined ? data.oauthConfig : existing.oauthConfig,
```

- [ ] **Step 4: Add the fields to the renderer + wire types**

In `src/renderer/types/mcp.ts`:
- Add the shared shape (export it):
```ts
export interface McpOAuthEndpoint {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}
```
- `McpServerConfig` (:14): add `serverKey?: string;` and `oauthConfig?: McpOAuthEndpoint;`.
- `McpServerFormData` (:55): add `serverKey?: string;` and `oauthConfig?: McpOAuthEndpoint;`.
- `McpEnterpriseMarketServer` (:132): add `oauth?: McpOAuthEndpoint;` (matches the server public view's `oauth?`).

In `src/main/auth/enterpriseClient.ts`, add `oauth?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };` to BOTH inline `servers` array types (the return type at :318-335 and the `res.json()` cast at :348-365).

- [ ] **Step 5: Run the store test + typecheck**

```bash
npx vitest run src/main/mcp/mcpStore.test.ts            # green in CI; sandbox note per Step 2
cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit   # 0
npx tsc --noEmit          # renderer (root tsconfig) — only bakeArtifactSharePage.ts(382,21)
```

- [ ] **Step 6: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add src/main/mcp/mcpStore.ts src/main/mcp/mcpStore.test.ts src/renderer/types/mcp.ts src/main/auth/enterpriseClient.ts && git status --porcelain
git commit -m "feat(mcp): persist connector oauthConfig and serverKey on the desktop record"
```

---

## Task 5: Desktop main — generic OAuth flow (pure helpers + driver)

**Files:**
- Create: `src/main/mcp/genericOauthFlow.ts`
- Test: `src/main/mcp/genericOauthFlow.test.ts`

**Interfaces:**
- Produces (pure, unit-testable, NO electron/`better-sqlite3` imports):
  - `base64UrlEncode(buffer: Buffer): string`
  - `createPkce(): { verifier: string; challenge: string; state: string }` (local copy of the qichacha impl — qichacha is left byte-unchanged to minimize regression risk; the spec explicitly allows local copy)
  - `buildGenericAuthorizeUrl(args: { authorizeUrl: string; clientId: string; redirectUri: string; scopes?: string[]; state: string; challenge: string }): string`
  - `buildTokenExchangeBody(args: { code: string; codeVerifier: string; clientId: string }): string` (a `URLSearchParams`-encoded body: `grant_type=authorization_code&code=…&code_verifier=…&client_id=…`; `token_endpoint_auth_method=none`, so NO secret)
  - `parseTokenResponse(text: string): string` → returns `access_token`; throws on HTTP/JSON error or missing token.
- Produces (orchestration, uses electron + `openOauthFlow`): `runGenericOauthFlow(oauthConfig: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }, parentWindow: BrowserWindow | null): Promise<string>` — start a localhost callback server that captures the `code`, open the authorize window via `openOauthFlow({ probe })`, and once the code is captured, POST the token exchange to `oauthConfig.tokenUrl` and return the `access_token`.

- [ ] **Step 1: Write the failing pure-helper tests**

Create `src/main/mcp/genericOauthFlow.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import crypto from 'crypto';

import {
  buildGenericAuthorizeUrl,
  buildTokenExchangeBody,
  createPkce,
  parseTokenResponse,
} from './genericOauthFlow';

describe('createPkce', () => {
  test('produces a base64url verifier/challenge/state and the challenge is S256 of the verifier', () => {
    const { verifier, challenge, state } = createPkce();
    const expectChallenge = crypto
      .createHash('sha256')
      .update(base64UrlRoundTrip(verifier))
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    expect(challenge).toBe(expectChallenge);
    expect(verifier).not.toMatch(/[+/=]/);
    expect(state).not.toMatch(/[+/=]/);
  });
});

// helper: decode a base64url string back to a Buffer (verifier is base64url of raw bytes)
function base64UrlRoundTrip(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

describe('buildGenericAuthorizeUrl', () => {
  test('carries the standard PKCE params and scopes, url-encoded', () => {
    const url = buildGenericAuthorizeUrl({
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      clientId: 'cid 1',
      redirectUri: 'http://localhost:54321/callback',
      scopes: ['openid', 'email'],
      state: 'ST',
      challenge: 'CH',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example.com/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid 1');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:54321/callback');
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('state')).toBe('ST');
    expect(u.searchParams.get('code_challenge')).toBe('CH');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
  test('omits the scope param when there are no scopes', () => {
    const url = buildGenericAuthorizeUrl({
      authorizeUrl: 'https://idp/x', clientId: 'c', redirectUri: 'http://l', state: 's', challenge: 'ch',
    });
    expect(new URL(url).searchParams.get('scope')).toBeNull();
  });
});

describe('buildTokenExchangeBody', () => {
  test('encodes grant_type=authorization_code with code, verifier, client_id and no secret', () => {
    const body = buildTokenExchangeBody({ code: 'C0DE', codeVerifier: 'V0', clientId: 'CID' });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('C0DE');
    expect(params.get('code_verifier')).toBe('V0');
    expect(params.get('client_id')).toBe('CID');
    expect(body).not.toContain('client_secret');
  });
});

describe('parseTokenResponse', () => {
  test('returns access_token from a valid JSON response', () => {
    expect(parseTokenResponse(JSON.stringify({ access_token: 'at-1', token_type: 'Bearer' }))).toBe('at-1');
  });
  test('throws when access_token is missing', () => {
    expect(() => parseTokenResponse(JSON.stringify({ error: 'invalid_grant' }))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/mcp/genericOauthFlow.test.ts`
Expected: FAILS (module does not exist).

- [ ] **Step 3: Implement the pure helpers**

Create `src/main/mcp/genericOauthFlow.ts`:

```ts
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'node:net';
import type { BrowserWindow } from 'electron';

import { openOauthFlow } from './oauthBrowserFlow';

export interface GenericOauthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifierRaw = crypto.randomBytes(64);
  const verifier = base64UrlEncode(verifierRaw);
  return {
    verifier,
    challenge: base64UrlEncode(crypto.createHash('sha256').update(verifierRaw).digest()),
    state: base64UrlEncode(crypto.randomBytes(32)),
  };
}

export function buildGenericAuthorizeUrl(args: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  });
  if (args.scopes && args.scopes.length > 0) params.set('scope', args.scopes.join(' '));
  const base = args.authorizeUrl.includes('?')
    ? `${args.authorizeUrl}&${params.toString()}`
    : `${args.authorizeUrl}?${params.toString()}`;
  return base;
}

export function buildTokenExchangeBody(args: {
  code: string;
  codeVerifier: string;
  clientId: string;
}): string {
  // Public client (PKCE): token_endpoint_auth_method=none — no client secret.
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
  });
  return params.toString();
}

export function parseTokenResponse(text: string): string {
  let data: { access_token?: string; error?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('oauth token exchange: non-JSON response');
  }
  if (data.error) throw new Error(`oauth token exchange failed: ${data.error}`);
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('oauth token exchange: missing access_token');
  }
  return data.access_token;
}

/** One-shot localhost callback server that captures the authorization `code`
 * (validating `state`) exactly once. Returns `{ redirectUri, wait, close }` —
 * `wait` resolves to the captured code (or null if the window closes first). */
function startCodeCallback(expectedState: string): Promise<{
  redirectUri: string;
  wait: () => Promise<string | null>;
  close: () => void;
}> {
  let resolveCode: ((c: string | null) => void) | null = null;
  const codePromise = new Promise<string | null>((r) => {
    resolveCode = r;
  });
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      if (parsed.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const state = parsed.searchParams.get('state');
      const code = parsed.searchParams.get('code');
      if (state !== expectedState || !code) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Invalid callback');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Authorization complete</h1><p>You can return to GenWork.</p>');
      resolveCode?.(code); // resolve-once; later polls get the same settlement
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate OAuth callback port'));
        return;
      }
      resolve({
        redirectUri: `http://localhost:${(addr as AddressInfo).port}/callback`,
        wait: () => codePromise,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore close races */
          }
        },
      });
    });
  });
}

/** Drive the full generic authorization-code + PKCE flow for one connector's
 * own endpoints and return the access token. The pure pieces above are unit
 * tested; this orchestration uses Electron + `openOauthFlow`. */
export async function runGenericOauthFlow(
  oauthConfig: GenericOauthConfig,
  parentWindow: BrowserWindow | null,
): Promise<string> {
  const { verifier, challenge, state } = createPkce();
  const cb = await startCodeCallback(state);
  try {
    const authorizeUrl = buildGenericAuthorizeUrl({
      authorizeUrl: oauthConfig.authorizeUrl,
      clientId: oauthConfig.clientId,
      redirectUri: cb.redirectUri,
      scopes: oauthConfig.scopes,
      state,
      challenge,
    });
    const token = await openOauthFlow({
      parentWindow,
      title: 'MCP OAuth Authorization',
      authorizeUrl,
      probe: async (win) => {
        const code = await cb.wait();
        if (!code) return null;
        const res = await fetch(oauthConfig.tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: buildTokenExchangeBody({ code, codeVerifier: verifier, clientId: oauthConfig.clientId }),
        });
        const text = await res.text();
        if (!res.ok) {
          try {
            win.close();
          } catch {
            /* window may already be gone */
          }
          throw new Error(`oauth token exchange failed: HTTP ${res.status}`);
        }
        return parseTokenResponse(text);
      },
    });
    if (!token) throw new Error('oauth flow returned empty credential');
    return token;
  } finally {
    cb.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/mcp/genericOauthFlow.test.ts`
Expected: all pure-helper tests pass (the file imports `electron` types and `openOauthFlow`, but the pure functions are exercised without launching a window; if the `electron` import is a problem in the test env, the existing `oauthBrowserFlow.test.ts` `vi.mock('electron')` pattern is the reference).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit   # 0
git add src/main/mcp/genericOauthFlow.ts src/main/mcp/genericOauthFlow.test.ts && git status --porcelain
git commit -m "feat(mcp): add generic per-provider OAuth PKCE flow driver"
```

---

## Task 6: Desktop main — `saveCredential` drives the generic provider (registry bypass)

**Files:**
- Modify: `src/main/mcp/mcpAuthFlows.ts` — `SaveCredentialPayload` (:59), oauth branch of `saveCredential` (:96-123)
- Modify: `src/main/preload.ts` — `SaveCredentialPayloadLike` (:106)
- Test: `src/main/mcp/mcpAuthFlows.test.ts` (additive; CI-gated — `better-sqlite3` ABI in sandbox)

**Interfaces:**
- Consumes: `payload: { kind:'oauth'; providerId: string; oauthConfig?: GenericOauthConfig }` (from the renderer). `runGenericOauthFlow` from Task 5.
- Produces: `saveCredential` — when `payload.providerId.startsWith('generic:')` AND `payload.oauthConfig` present, run the generic flow directly (bypassing `OAUTH_REGISTRY` so the built-in `qichacha` entry is untouched), persist `oauth: {providerId, token}` + `headers.Authorization = Bearer <token>`, then probe. Everything else is unchanged.

- [ ] **Step 1: Extend the payload type**

In `mcpAuthFlows.ts`, change the `oauth` variant of `SaveCredentialPayload` (:59-63):

```ts
export type SaveCredentialPayload =
  | { kind: 'bearer'; bearer: string }
  | { kind: 'apiKey'; headerName: string; value: string }
  | { kind: 'env'; envKey: string; value: string }
  | { kind: 'oauth'; providerId: string; oauthConfig?: GenericOauthConfig };
```
and add the import at the top: `import { runGenericOauthFlow, type GenericOauthConfig } from './genericOauthFlow';`

In `preload.ts`, mirror it in `SaveCredentialPayloadLike` (:106-111): add `oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }` to the `{ kind: 'oauth'; providerId: string }` variant (preload must not import from `src/main/mcp/`, so keep it an inline literal — the file already notes this mirror convention).

- [ ] **Step 2: Add the generic-path test**

Add to `src/main/mcp/mcpAuthFlows.test.ts` (uses the file's existing store fixture). This asserts the dispatch decision, mocking the generic flow so no real window opens:

```ts
// (import runGenericOauthFlow where the file imports from the module under test;
//  vi.mock the genericOauthFlow module to control its return)
test('oauth payload with a generic:<serverKey> providerId drives the generic flow and persists the token', async () => {
  const store = makeStore(); // reuse the file's existing store factory
  const id = store.createServer({
    name: 'fxsk', description: '', transportType: 'http', url: 'https://fxsk.example.com/mcp',
    authMethod: McpAuthMethod.OAuth,
  }).id;
  const res = await saveCredential(null, id, {
    kind: 'oauth',
    providerId: 'generic:fxsk-mcp',
    oauthConfig: { authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', clientId: 'c' },
  }, { store });
  expect(res.ok).toBe(true);
  const after = store.getServer(id);
  expect(after?.oauth?.providerId).toBe('generic:fxsk-mcp');
  expect(after?.headers?.Authorization).toMatch(/^Bearer /);
});
```
Adjust `makeStore`/imports to match the existing file's fixtures. This test is CI-gated (better-sqlite3 ABI in the sandbox) — flag in the commit message.

- [ ] **Step 3: Implement the bypass**

In `saveCredential`'s `if (payload.kind === 'oauth')` branch, insert the generic path before the registry lookup:

```ts
  if (payload.kind === 'oauth') {
    // Per-provider generic flow (spec §5.2 option B): bypass the registry so
    // the built-in qichacha entry is untouched. `generic:<serverKey>` + an
    // oauthConfig means "drive this connector's own endpoints".
    if (payload.providerId.startsWith('generic:') && payload.oauthConfig) {
      let genericToken: string;
      try {
        genericToken = await runGenericOauthFlow(payload.oauthConfig, win);
      } catch (err) {
        console.warn(`[mcpAuthFlows] generic oauth flow failed for ${payload.providerId}: ${errMsg(err)}`);
        return { ok: false, reason: errMsg(err) };
      }
      if (!genericToken) return { ok: false, reason: 'oauth flow returned empty credential' };
      store.updateServer(id, {
        authMethod: McpAuthMethod.OAuth,
        oauth: { providerId: payload.providerId, token: genericToken },
        headers: { ...(record.headers ?? {}), Authorization: `Bearer ${genericToken}` },
      });
      const afterGeneric = store.getServer(id);
      if (!afterGeneric) return { ok: false, reason: 'server disappeared after save' };
      const result = await probeAuthorization(afterGeneric, store);
      console.log(`[mcpAuthFlows] saved generic oauth credential for server ${id}`);
      return { ok: true, result };
    }
    const provider = OAUTH_REGISTRY[payload.providerId];
    // ... existing qichacha path unchanged ...
  }
```

- [ ] **Step 4: Run the test + typecheck**

```bash
npx vitest run src/main/mcp/mcpAuthFlows.test.ts        # green in CI; sandbox note
cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit   # 0
```

- [ ] **Step 5: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add src/main/mcp/mcpAuthFlows.ts src/main/mcp/mcpAuthFlows.test.ts src/main/preload.ts && git status --porcelain
git commit -m "feat(mcp): drive per-provider generic OAuth from saveCredential"
```

---

## Task 7: Desktop renderer — `buildSaveCredentialPayload` generic path + Qichacha guardrail

**Files:**
- Modify: `src/renderer/components/mcp/mcpAuthModalHelpers.ts` — `SaveCredentialPayloadOAuth` (:23), `McpAuthFormFields` (:44), `buildSaveCredentialPayload` OAuth branch (:73-76)
- Test: `src/renderer/components/mcp/mcpAuthModalHelpers.test.ts` (additive; the existing `:49` qichacha-default test MUST keep passing)

**Interfaces:**
- Consumes: `McpAuthFormFields.serverKey?: string`, `McpAuthFormFields.oauthConfig?: { authorizeUrl; tokenUrl; clientId; scopes? }`.
- Produces: `SaveCredentialPayloadOAuth = { kind:'oauth'; providerId: string; oauthConfig?: {…} }`. `buildSaveCredentialPayload` OAuth branch:
  - `formFields.serverKey` present AND `formFields.oauthConfig` has non-empty `authorizeUrl`+`tokenUrl` → `{ kind:'oauth', providerId: 'generic:'+serverKey, oauthConfig }`.
  - `formFields.serverKey` present, no complete `oauthConfig` → `null` (guardrail: an enterprise connector without configured endpoints must NOT fall back to Qichacha).
  - `formFields.serverKey` absent (built-in Qichacha / default) → `{ kind:'oauth', providerId: 'qichacha' }` (regression protection — preserves the existing `{}`→qichacha test).

- [ ] **Step 1: Write the failing tests**

Append to `mcpAuthModalHelpers.test.ts`:

```ts
test('oauth with a serverKey and complete oauthConfig maps to a generic provider', () => {
  const cfg = { authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', clientId: 'c' };
  expect(
    buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp', oauthConfig: cfg }),
  ).toEqual({ kind: 'oauth', providerId: 'generic:fxsk-mcp', oauthConfig: cfg });
});

test('oauth with a serverKey but no endpoints returns null (guardrail, no qichacha fallback)', () => {
  expect(buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp' })).toBeNull();
  expect(
    buildSaveCredentialPayload(McpAuthMethod.OAuth, {
      serverKey: 'fxsk-mcp',
      oauthConfig: { authorizeUrl: 'https://idp/a', tokenUrl: '', clientId: 'c' },
    }),
  ).toBeNull();
});

test('oauth without a serverKey still defaults to qichacha (built-in regression)', () => {
  expect(buildSaveCredentialPayload(McpAuthMethod.OAuth, { registryId: 'qichacha' as never })).toEqual({
    kind: 'oauth',
    providerId: 'qichacha',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/components/mcp/mcpAuthModalHelpers.test.ts`
Expected: the two new generic/guardrail cases FAIL; the existing `:49` (`{}`→qichacha) and the new qichacha-regression case PASS.

- [ ] **Step 3: Implement**

In `mcpAuthModalHelpers.ts`:
- `SaveCredentialPayloadOAuth` (:23): add `oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };`.
- `McpAuthFormFields` (:44): add `serverKey?: string;` and `oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };`.
- Replace the OAuth branch of `buildSaveCredentialPayload` (:73-76):

```ts
  if (authMethod === McpAuthMethod.OAuth) {
    const cfg = formFields.oauthConfig;
    const hasEndpoints = Boolean(cfg?.authorizeUrl?.trim()) && Boolean(cfg?.tokenUrl?.trim());
    // Enterprise connector (identified by its serverKey): must have admin
    // endpoints; never silently drive qichacha.
    if (formFields.serverKey) {
      if (!hasEndpoints) return null; // guardrail — see spec §5.4
      return { kind: 'oauth', providerId: `generic:${formFields.serverKey}`, oauthConfig: cfg };
    }
    // Built-in Qichacha bundle (no serverKey): keep the qichacha path.
    return { kind: 'oauth', providerId: 'qichacha' };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/components/mcp/mcpAuthModalHelpers.test.ts`
Expected: all pass — including the existing `:49` test unchanged.

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/paulwang/work/GenWork && npx tsc --noEmit   # renderer — only bakeArtifactSharePage.ts(382,21)
git add src/renderer/components/mcp/mcpAuthModalHelpers.ts src/renderer/components/mcp/mcpAuthModalHelpers.test.ts && git status --porcelain
git commit -m "feat(mcp): map oauth connectors to their own provider with a no-qichacha guardrail"
```

---

## Task 8: Desktop renderer — wire `serverKey`/`oauthConfig` to the auth modal + not-configured message

**Files:**
- Modify: `src/renderer/components/mcp/McpAuthModal.tsx` — `handleSubmit` (:61-74), `renderAuthMethodFields` OAuth branch (:151-162)
- Modify: `src/renderer/components/mcp/McpServerFormModal.tsx` — `handleSave` enterprise branch (:320-325)
- Modify: `src/renderer/services/i18n.ts` — add `mcpAuthOAuthNotConfigured` (en near :6477; zh near :2661)

**Interfaces:**
- Consumes: `McpServerConfig.serverKey` / `.oauthConfig` (Task 4). `buildSaveCredentialPayload` generic path (Task 7).
- Produces: the modal passes `serverKey`+`oauthConfig` into the payload builder; when the OAuth payload is `null` (guardrail), it shows the localized "not configured on admin" message instead of a generic missing-field message. Enterprise install attaches `oauthConfig`+`serverKey` to the created record.

- [ ] **Step 1: Wire the modal to pass the connector identity**

In `McpAuthModal.tsx`, `handleSubmit` (:63) currently calls `buildSaveCredentialPayload(authMethod, { bearer, headerName, value })`. Change it to also pass the connector identity (so the helper can pick generic vs qichacha vs guardrail):

```ts
    const payload = buildSaveCredentialPayload(authMethod, {
      bearer: bearerValue,
      headerName: apiKeyName,
      value: apiKeyValue,
      serverKey: server.serverKey,
      oauthConfig: server.oauthConfig,
    });
    if (!payload) {
      setUiState({
        kind: 'missing-credential',
        message:
          authMethod === McpAuthMethod.OAuth
            ? i18nService.t('mcpAuthOAuthNotConfigured')
            : i18nService.t('mcpAuthFailedMissing'),
      });
      return;
    }
```

In the `renderAuthMethodFields` OAuth branch (:151), when `server.oauthConfig` is absent (the guardrail case), replace the bare "provider" panel with the not-configured copy so the user sees WHY before clicking:

```tsx
    if (authMethod === McpAuthMethod.OAuth) {
      if (server.serverKey && !server.oauthConfig) {
        return (
          <div className="space-y-1.5">
            <span className="text-xs font-semibold tracking-wide text-secondary">
              {i18nService.t('mcpAuthFieldOAuthProvider')}
            </span>
            <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-secondary">
              {i18nService.t('mcpAuthOAuthNotConfigured')}
            </p>
          </div>
        );
      }
      return (
        <div className="space-y-1.5">
          <span className="text-xs font-semibold tracking-wide text-secondary">
            {i18nService.t('mcpAuthFieldOAuthProvider')}
          </span>
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
            {server.name}
          </p>
        </div>
      );
    }
```

- [ ] **Step 2: Attach `oauthConfig` + `serverKey` on enterprise install**

In `McpServerFormModal.tsx`, the enterprise branch of `handleSave` (:320-325) currently sets `data.isBuiltIn`/`data.registryId`. Add the endpoints + key so the installed record carries them (from the public view's `oauth` + `serverKey`):

```ts
    if (enterpriseServer) {
      data.isBuiltIn = true;
      data.registryId = enterpriseServer.id;
      data.serverKey = enterpriseServer.serverKey;
      data.oauthConfig = enterpriseServer.oauth; // undefined for non-user-oauth modes
    }
```

- [ ] **Step 3: Add the i18n key (en + zh)**

In `src/renderer/services/i18n.ts`, next to `mcpAuthFieldOAuthProvider` (en :6477 / zh :2661):

```ts
// en (near 6477):
    mcpAuthOAuthNotConfigured:
      "This connector's OAuth login isn't configured yet (missing authorize/token URL) on the admin console. It can't be authorized here yet.",
// zh (near 2661):
    mcpAuthOAuthNotConfigured: '该连接器的 OAuth 登录方式尚未在管理端配置（缺少授权/令牌地址），暂时无法完成登录。',
```

- [ ] **Step 4: Typecheck + run the helper test**

```bash
cd /Users/paulwang/work/GenWork && npx tsc --noEmit   # renderer — only bakeArtifactSharePage.ts(382,21)
npx vitest run src/renderer/components/mcp/mcpAuthModalHelpers.test.ts   # still green
```

- [ ] **Step 5: Commit**

```bash
cd /Users/paulwang/work/GenWork && git add src/renderer/components/mcp/McpAuthModal.tsx src/renderer/components/mcp/McpServerFormModal.tsx src/renderer/services/i18n.ts && git status --porcelain
git commit -m "feat(mcp): pass connector oauth endpoints to the auth modal and surface the guardrail"
```

---

## Task 9: Full verification sweep (per-file) + final typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run every touched test file, individually**

```bash
cd enterprise_server
npx vitest run tests/models/connectorView.test.ts
npx vitest run tests/routes/mcpConnectors.test.ts
cd /Users/paulwang/work/GenWork
npx vitest run src/main/mcp/genericOauthFlow.test.ts
npx vitest run src/renderer/components/mcp/mcpAuthModalHelpers.test.ts
# CI-gated (better-sqlite3 ABI in sandbox — note if they can't run here):
npx vitest run src/main/mcp/mcpStore.test.ts
npx vitest run src/main/mcp/mcpAuthFlows.test.ts
```

- [ ] **Step 2: Full typecheck, all three targets**

```bash
cd enterprise_server && npx tsc --noEmit                                   # 0
cd /Users/paulwang/work/GenWork/enterprise_server/web && npx tsc --noEmit  # 0
cd /Users/paulwang/work/GenWork && npx tsc -p electron-tsconfig.json --noEmit            # 0
npx tsc --noEmit        # renderer — only bakeArtifactSharePage.ts(382,21)
```

- [ ] **Step 3: Verify no dead i18n keys**

```bash
# every new key is referenced:
grep -rn "mcpDrawer.auth.authorizeUrl" enterprise_server/web/src
grep -rn "mcpAuthOAuthNotConfigured" src/renderer
```
Expected: `authorizeUrl` referenced in `ConnectorAuthFields.tsx` + `ConnectorDrawer.tsx`; `mcpAuthOAuthNotConfigured` referenced in `McpAuthModal.tsx`.

- [ ] **Step 4: Confirm clean tree**

```bash
git status --porcelain   # must be empty (all committed)
```

- [ ] **Step 5: (Manual, if available) M3 e2e check** — with a mock or real PKCE IdP, install a `user-oauth` connector whose admin has `authorizeUrl`/`tokenUrl`/`clientId` set, and confirm "重新认证" opens the connector's OWN login window (not `agent.qcc.com`) and the built-in Qichacha still opens `agent.qcc.com`. (Spec §10 M3. If no IdP is reachable in this environment, record that e2e is deferred to manual verification.)

---

## Self-Review (run before handing to execution)

**Spec coverage:**
- §4.1 admin fields → Task 3. §4.2 public-view `oauth` whitelist → Task 1. §4.3 desktop persistence → Task 4. §4.4 credential path (unchanged) → Task 6 reuses `store.updateServer`. §5.1 generic driver → Task 5. §5.2 registry bypass (option B) → Task 6. §5.3 payload change → Task 6 (main) + Task 7 (renderer). §5.4 guardrail → Task 7 (helper) + Task 8 (modal message). §6.1 `missingAuthField` relaxation → Task 2. §6 SSE exclusion → unchanged (`sseOauthCombination` untouched; http-only holds). §7 i18n → Tasks 3, 8. §9 test strategy → Tasks 1, 2, 4, 5, 7, 8 + Task 9 sweep. §10 milestones M0/M1/M2 → Tasks 7/8 (M0), 1–4+8 (M1), 5–6 (M2), Task 9 (M3). §12 open Q1 `providerId=generic:<serverKey>` → Task 7. Q2 `callbackUrl` retained (admin) → Task 3 keeps it. Q4 SSE exclusion → unchanged.

**No gaps found.** The one spec item NOT implemented here is the **server-side MCP gateway** (`mcp-connector-desktop-consumption-design.md` §6) — that is deliberately out of scope for THIS spec/plan (it belongs to the consumption spec, planned second).

**Placeholder scan:** none — every step has concrete code or an explicit run command.

**Type consistency:** `oauth`/`oauthConfig` shape is `{ authorizeUrl; tokenUrl; clientId; scopes? }` in all four locations (server `ConnectorPublicView.oauth`, renderer `McpEnterpriseMarketServer.oauth`, store `McpOAuthEndpoint`/`McpServerConfig.oauthConfig`, main `GenericOauthConfig`) — kept identical. `providerId: 'generic:' + serverKey` is produced in the renderer (Task 7) and consumed by the main bypass (Task 6). `serverKey` is threaded server→public view→renderer `McpServerConfig`→modal→payload→main dispatch. Consistent.

**Existing-test impact:** NONE — `mcpAuthModalHelpers.test.ts:49` (qichacha default) and `mcpConnectors.test.ts:229-243` (clientId/clientSecret guards) and `connectorView.test.ts:81` (no `authConfig`) all remain valid because the new behavior is keyed on `serverKey`/`oauth`/public-endpoints, not by altering the defaults those tests lock.
