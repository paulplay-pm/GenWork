# Enterprise JWT lifecycle: remove the local token proxy and self-heal the direct path

- **Date:** 2026-09-20
- **Status:** Design — awaiting approval to implement
- **Owners (files):** GenWork desktop (`src/main`, `src/shared`) + `enterprise_server`
- **Scope:** Four parts, each independently committable: **A** delete the local token proxy, **B** point DSH plan models at enterprise-direct (multi-baseUrl), **C** self-heal the direct enterprise-JWT path (refresh + retry), **D** structured error signals from the enterprise server.

## 1. Problem

Mid-conversation, plan (套餐) models fail with `401` → the desktop surfaces
`coworkErrorGenWorkLoginExpired` ("登录状态已过期，请重新登录后继续使用 GenWork 套餐模型").

Root cause: plan models talk to the enterprise server **directly**
(`${ENTERPRISE_SERVER_URL}/proxy/<provider>`), and the desktop bakes the
**user enterprise JWT literally** into `openclaw.json` as the provider `apiKey`
(`claudeSettings.ts:488` via `buildProviderSelection({ apiKey: userJwt })`).
The enterprise JWT lives **1 hour** (`enterprise_server/src/auth/jwt.ts:20`
`.setExpirationTime('1h')`). On a long task the JWT expires in-flight; the
enterprise `/proxy/*` `requireAuth` returns `401`, OpenClaw classifies it as
`auth_invalid_token`, and the desktop reports login-expired.

There is a second LLM path that *would* self-heal this (the local token
proxy at `127.0.0.1:<port>/v1`, which swaps in a fresh token and retries on
401), but **plan models never use it** — measured: all model-fetch traffic for
plan models goes to the enterprise URL, zero to the loopback proxy. The proxy
exists for the *consumer* backend path only.

The user wants: (a) delete the local proxy and its dead weight, (b) make the
direct path self-heal so a long task does not die when the JWT ages out,
(c) keep DSH's billed plan models working after the proxy is gone, and
(d) keep quota / membership-revocation error messages precise, sourced from
the enterprise server.

## 2. Background: the two LLM paths

- **Path A — local token proxy.** `src/main/libs/openclawTokenProxy.ts` binds
  an HTTP server on `127.0.0.1:<dynamic-port>`, forwards to the *consumer*
  backend `${serverBaseUrl}/api/proxy<upstreamPath>`, injects the consumer
  access token per request, and on `401` refreshes + retries. It also scans
  the response stream for quota / membership-revocation signals (see §7).
- **Path B — enterprise direct.** `claudeSettings.ts:tryEnterpriseCatalogFallback`
  resolves plan models to `baseURL = ${ENTERPRISE_SERVER_URL}/proxy/<provider>`
  with `apiKey = <user enterprise JWT>`. `openclawConfigSync.ts` bakes this into
  `openclaw.json`. OpenClaw talks to the enterprise server directly. **No
  local hop, no per-request token swap, no 401 retry.**

`claudeSettings.ts:resolveRawApiConfig` routes plan models through B whenever
`ENTERPRISE_SERVER_URL` + a session JWT + a non-empty catalog are present.
A is the consumer-only fallback. In practice the two backends are distinct:
`getServerApiBaseUrl()` (consumer cloud) vs `process.env.ENTERPRISE_SERVER_URL`
(enterprise org server).

### Decisive facts (verified against source)

1. **The enterprise JWT cannot be refreshed after it expires.**
   `enterpriseClient.refresh()` POSTs to `/auth/refresh` carrying the *current*
   JWT; the server `verifyToken`s it first (`enterprise_server/src/routes/auth.ts:123`).
   An already-expired JWT fails verification → `401 {error:'unauthorized'}` →
   `loginGate.lock()` kicks the user to the login page. **Therefore the fix must
   refresh *before* expiry; a purely reactive "refresh on 401" cannot recover a
   hard-expired token.**
2. **The consumer-token refresh (`authSessionManager.refresh`) is a different
   system from the enterprise-JWT refresh.** The former uses a `refreshToken`
   against the consumer backend; the enterprise JWT rotates via
   `enterpriseClient.refresh()` and is persisted with
   `enterpriseClient.persistSession(orgId, username, jwt, expiresAt)`.
3. **A pure user-JWT refresh does not trigger a gateway hard restart on its
   own.** `needsHardRestart` (`main.ts:2573-2578`) is true only for
   `secretEnvVarsChanged` / bindings / explicit restart / `restartImpact`.
   `secretEnvVarsChanged` is driven by the org `GENWORK_APIKEY_<PROVIDER>` env
   vars (`claudeSettings.ts:963-973`), which are the *org* `provider_key` values
   and do not change when only the user JWT changes. `sync()` sets
   `restartImpact: Restart` only for mcp/model-compat
   (`openclawConfigSync.ts:2669`). So `syncOpenClawConfig({ restartGatewayIfRunning:
   false })` after a JWT refresh takes the **hot-delivery** path
   (`deliverOpenClawConfigToGateway`, `config.set` RPC), `main.ts:2597`.
   (Note: `classifyAppConfigChange` maps a changed provider `apiKey` to
   `AppProviderSecret → Restart` (`openclawConfigImpact.ts:249-251`), but that
   classifier is not the gate that `sync()` uses for `restartImpact` — the
   empirical hot-delivery behavior is what governs. See §8 open verification.)
4. **DSH's "plan models" are the enterprise models.**
   `getAllServerModelMetadata()` (`claudeSettings.ts:208`) reads
   `serverModelMetadataCache`, which the source comment
   (`claudeSettings.ts:175-183`) states is now populated **only from the
   enterprise catalog** via `enterpriseModelCache.load`. So re-pointing DSH at
   enterprise-direct uses the already-correct data source.
5. **DSH is a long-lived spawned process with credentials baked into its spawn
   env.** `dshEngineManager.ts:389-397` bakes `managed.envVars` (including the
   plan route's API key) into the child `env` at `start()`. The engine is
   app-resident: started at app-ready (`main.ts:12584`), stopped at quit
   (`handlers.ts:187`). It has **no hot-reload** of that env. This is the
   freshness constraint that drives Part B's re-spawn design.
6. **DSH supports multiple routes, each with one `baseURL` + `apiKeyEnv`.**
   `dshConfigSync.ts` emits `routes: Record<routeId, DshProviderRoute>`; today
   the plan provider is a single `baseUrl` for all models
   (`DshPlanProviderInput.baseUrl`, `renderPlanRoutes` at `:215-271`). Multiple
   routes are already a supported shape (the non-plan providers emit one
   route each), so "multi baseUrl" = one route per enterprise provider.

## 3. Goals and non-goals

**Goals**
- Remove `openclawTokenProxy.ts` and all of its wiring.
- Plan models (OpenClaw) keep working over the enterprise direct path and stop
  401-ing on a long task.
- DSH billed plan models keep working with the proxy removed, with correct
  per-provider routing (no same-name collision).
- Quota and membership-revocation messages stay precise, now sourced from the
  enterprise server rather than the deleted proxy.

**Non-goals**
- Changing the enterprise JWT lifetime (stays 1h). We rotate it, we do not
  lengthen it.
- DSH runtime changes. All DSH work is in the desktop render/manager layer;
  dsh itself is an external vendored runtime (`@deepseek-ai/dsh`).
- Adding enterprise *billing dimensions* (monthly credits / pool / batches).
  The enterprise `/proxy` currently enforces only a per-day quota
  (`quota_per_user_per_day`). Part D exposes what exists; new dimensions are
  out of scope and would be a follow-up.
- Migrating the *consumer* backend's `416xx` error regime. Plan models are
  enterprise; the consumer regime is a different product surface.

## 4. Part A — delete the local token proxy

Delete the module and its tests, and remove every reference.

**Delete files**
- `src/main/libs/openclawTokenProxy.ts`
- `src/main/libs/openclawTokenProxy.test.ts`

**`src/main/main.ts`**
- Imports `407-410` (`getOpenClawTokenProxyPort`, `startOpenClawTokenProxy`,
  `stopOpenClawTokenProxy` from `./libs/openclawTokenProxy`).
- Quit-time `stopOpenClawTokenProxy()` at `12413`.
- Startup block `12690-12710` (`startOpenClawTokenProxy({ getAuthTokens,
  refreshToken, getServerBaseUrl, onEnterpriseMembershipRevoked, ... })` plus its
  profiler marks and try/catch). The `onEnterpriseMembershipRevoked` callback
  here is the `LlmSse` revocation source; it is re-established in Part D
  (§7), so it is not simply dropped without a replacement.
- Any comment referencing the proxy around `2046`.

**`src/main/libs/openclawConfigSync.ts`** — *restructure, not delete.*
- Import at `78`.
- The block at `1590-1703` does **two** jobs and only one is removable:
  - **Job 1 (removable):** the `if (proxyPort)` gate and the loopback
    `http://127.0.0.1:${proxyPort}/v1` base URLs (provider-level at `1598`,
    per-model at `1669`) plus the `'proxy-managed'` apiKey placeholders
    (`1597`, `1668`).
  - **Job 2 (must be preserved):** the loop at `1628-1700` that **enumerates
    every enterprise model** (`serverModels = getAllServerModelMetadata()`,
    `1427`) into the single `genwork-server` provider, and — crucially — attaches
    a **per-model `baseUrl`** via `resolveModelProxyUrl` (`1654-1663`) that points
    each model at its own `${ENTERPRISE_SERVER_URL}/proxy/<provider>`. The comment
    at `1633-1636` explains why: without a per-model `baseUrl` all models collapse
    onto the provider-level base (the *active* model's provider) and a Qwen model
    forwarded to `/proxy/deepseek` 404s with `model_not_found`.
- **Concretely:** drop the `getOpenClawTokenProxyPort()` gate so the enumeration
  runs whenever `serverModels.length > 0` (enterprise mode). Keep the per-model
  `baseUrl` resolution (`resolveModelProxyUrl`, `1654-1663`) verbatim — it is
  already enterprise-direct. Replace the loopback base URLs and the
  `'proxy-managed'` apiKey with the enterprise-direct values: the provider-level
  base becomes the active model's enterprise `baseURL` (the same value
  `providerSelection` already carries from `tryEnterpriseCatalogFallback`), and
  each model's `apiKey` becomes the **current user enterprise JWT**
  (`sessionStorage.load()?.jwt`), matching how `tryEnterpriseCatalogFallback`
  keys the active model (`claudeSettings.ts:488`).
- Net effect: identical provider shape to today (one `genwork-server` provider,
  one model per enterprise catalog entry, per-model `/proxy/<provider>` base),
  but with a real JWT instead of `'proxy-managed'` and no loopback hop. This is
  what makes the provider `apiKey` a value Part C must keep fresh (§6).
- `getEnterpriseServerUrl` (`./endpoints`, imported at `51`) is already the base
  used by `resolveModelProxyUrl`, so no new dependency.

**`src/main/libs/claudeSettings.ts`**
- Import at `20`.
- `resolveAllProviderApiKeys`, `899-907`: the
  `shouldInjectServerToken = !getOpenClawTokenProxyPort()` gate. With the proxy
  gone, drop the proxy condition and always inject the consumer `SERVER` token
  when a consumer access token + server base URL are present. This preserves
  the consumer path's existing behavior (the consumer `SERVER` env var was
  already the fallback the proxy suppressed).

**`src/main/libs/claudeSettings.test.ts`**
- Update the `vi.mock('./openclawTokenProxy', ...)` at `32-33` — the module no
  longer exists; remove the mock and any assertion that depends on the proxy
  port being "active."

**Behavioral note (consumer, not enterprise):** the consumer backend path
(49889-style) previously relied on the proxy to swap its access token. That is
a *separate* concern from this change and is intentionally untouched: Part A
does not remove the consumer `SERVER`-token injection; it only stops gating it
on the proxy's presence. If the consumer path also loses its self-heal as a
result, that is a pre-existing property of the consumer backend, not a
regression introduced here, and is tracked as a follow-up, not blocked by it.

## 5. Part B — DSH plan models: enterprise-direct, multi-baseUrl, idle re-spawn

### 5.1 Data source
`getPlanProvider` (`main.ts:7480-7500`) currently returns
`{ baseUrl: http://127.0.0.1:<proxyPort>/v1, models: getAllServerModelMetadata() }`
and returns `null` when no proxy port is available. It is reworked to return
`null` unless `process.env.ENTERPRISE_SERVER_URL` is set, a user enterprise JWT
is present (`sessionStorage.load()?.jwt`), and the enterprise catalog is
non-empty.

### 5.2 Multi-baseUrl (per-provider routes)
Extend `DshPlanProviderInput` (`dshConfigSync.ts:64-77`) so the caller can pass
models **grouped by provider** rather than a single flat list with one
`baseUrl`. Concretely, the input becomes a list of groups:

```
groups: Array<{
  provider: string;                       // catalog provider (openai/anthropic/deepseek/vllm/...)
  baseURL: string;                        // ${ENTERPRISE_SERVER_URL}/proxy/<provider>
  displayName: string;                     // localized plan name (i18n owned by caller)
  models: Array<{ modelId; modelName?; apiFormat?; supportsImage?; contextWindow?; maxTokens? }>;
}>
```

`renderPlanRoutes` (`dshConfigSync.ts:215-271`) is reworked to emit **one route
per provider group**, each with its own `baseURL`, and within each provider
group keep the existing two-protocol split (openai-completions vs
anthropic-messages) when that provider spans both. Route ids are derived per
group (e.g. `genwork-plan-<provider>`, plus the anthropic suffix where needed),
sanitized by the existing `sanitizeDshRouteId`. Each route's `apiKeyEnv` is
derived by the existing `deriveDshApiKeyEnvRef`.

**Why per-provider:** the enterprise `/proxy/:provider/chat/completions`
catch-all dispatches by the request body's model name
(`proxy.ts:62-66`, `modelCatalog.getByUpstreamModel`). A single flat `baseUrl`
forces model-name-only dispatch, which is ambiguous when the same model name is
bound to two providers (two rows in `model_catalog`) — `LIMIT 1` would pick an
arbitrary one and bill the wrong `provider_key`. One route per provider keeps
the `:provider` path segment correct per model and eliminates that ambiguity.

### 5.3 Credential
`envVars[<ROUTE>_API_KEY]` for every plan route is set to the **current user
enterprise JWT** (not the old `'proxy-managed'` placeholder). dsh bakes this
into its spawn env (`dshEngineManager.ts:389`).

### 5.4 Freshness: idle-gated re-spawn on JWT refresh
Because the JWT is frozen into the dsh process env at spawn, a running dsh
eventually holds a stale key. This is handled by the Part C proactive refresher
(§6) which, on each successful enterprise-JWT refresh, also refreshes dsh's
plan credential — but **only when dsh is idle**.

- **Idle detection.** Add an active-task counter to the DSH subsystem. The
  single entry point for delegated work is
  `dshCodeMcpServer.ts:runCodeTask` (`:140`). Increment the counter when a task
  starts, decrement in a `finally` (covering timeout, success, and failure).
  Expose `isDshIdle()` (counter === 0). A running `dsh_code_task` is the only
  thing that consumes the baked key during a session, so "no active task" is a
  sound idle definition.
- **Re-spawn policy.** On refresh: if the dsh engine is `Stopped`, do nothing
  (it will spawn with the new JWT next time). If it is `Ready` and `isDshIdle()`,
  re-spawn (stop + start) so the new JWT is baked in. If it is `Ready` and a
  task is active, **park** a pending-refresh flag; on the task's completion
  (`runCodeTask` `finally`), if the flag is set and the engine is still `Ready`
  and idle, re-spawn. This mirrors the proven `scheduleDeferredGatewayRestart`
  pattern: bounded disruption, applied only at idle, no task loss, no task ever
  runs on a dead key.
- Add a `refreshPlanCredential()` method to the DSH manager implementing the
  above, called from the Part C refresher.

### 5.5 Fallback posture
If `getPlanProvider` returns `null` (no enterprise URL / no JWT / empty
catalog), `renderDshManagedSettings` skips plan routes (existing
`proxy-not-running`-style skip path, now re-labeled `enterprise-unavailable`),
and DSH still offers the user's own providers. DSH plan models are simply
absent, not a crash.

## 6. Part C — self-heal the direct enterprise-JWT path

### 6.1 C1: proactive refresh (primary defense)
Add a background refresher for the **enterprise** JWT, mirroring the existing
consumer proactive refresher (`main.ts:12621-12637`):
- A periodic check (≈30–40 min) reads `sessionStorage.load()`. If
  `expiresAt - now < threshold` (≈10 min), it calls
  `enterpriseClient.refresh()` (which rotates the still-valid JWT), then
  `enterpriseClient.persistSession(orgId, username, newJwt, newExpiresAt)`.
- On success it calls `syncOpenClawConfig({ reason: 'enterprise-jwt-refresh',
  restartGatewayIfRunning: false })` to bake the new JWT into `openclaw.json`
  and push it to the gateway (hot-delivery per fact #3). It also calls the DSH
  `refreshPlanCredential()` from §5.4.
- Single-flight: reuse the existing refresh coalescing discipline (a second
  refresh in flight joins the first) so overlapping triggers do not race.

### 6.2 C2: hot-delivery-first, deferred-restart fallback
The refresh relies on the gateway picking up the new provider `apiKey` via
`config.set` (`deliverOpenClawConfigToGateway`, `main.ts:2597`). Two outcomes,
both already handled by the sync machinery:
- If the hot delivery is accepted, the new key is live with zero disruption.
- If `delivery.mode === Rejected`, or if the running gateway does not hot-load a
  changed provider secret (see §8 open verification), the sync path defers a
  gateway restart (`scheduleDeferredGatewayRestart`, `main.ts:2604`, applied at
  idle per `:2635-2643`).

No new restart plumbing is introduced; we reuse the existing
needsHardRestart/delivery/deferred-restart logic. The single change is that the
enterprise-JWT-refresh sync call must not *suppress* the deferred restart —
it must let the existing `Rejected`/deferred path take over when hot-delivery
does not apply.

### 6.3 C3: reactive single-flight recovery (secondary)
In `openclawRuntimeAdapter.ts:resolveOpenClawRuntimeError`, when
`isGenWorkLoginExpiredMetadata(metadata)` (`:1668`) is true **and** the
provider is `ProviderName.GenworkServer`, attempt **one** recovery before
surfacing the error:
- If the stored enterprise JWT still verifies (not yet expired), trigger a
  refresh (`enterpriseClient.refresh()` → persist → `syncOpenClawConfig`) and
  surface a "refreshed — please retry" style message (new i18n key).
- If it is already expired, a refresh is impossible (fact #1); fall through to
  the existing `loginGate.lock()` / login-expired behavior. This is a hard
  constraint, not a bug.
- Guard with a single-flight flag so a burst of 401s does not loop the refresh.

## 7. Part D — structured error signals from the enterprise server

### 7.1 Why
The deleted proxy carried two side channels: a **precise quota copy** (it scanned
the consumer stream for `416xx` codes / "本月积分已用完" text, remembered them,
and the adapter consumed them via `consumeRecentOpenClawTokenProxyQuotaError`)
and an **`LlmSse` membership-revocation probe** (it detected `41602 NotMember`
and fired `onEnterpriseMembershipRevoked`). Plan models never used these (they
are enterprise, not consumer), but the *capability* is valuable and Part A
removes the only place it lives. Part D relocates it to the authoritative
source: the enterprise server.

The enterprise server uses a **different** error regime than the consumer
backend — it emits no `416xx`. Its `/proxy` returns
`429 {error:'quota_exceeded', used, quota, reset_at}` (`providerProxy.ts:84-92`),
`403 model_disabled`, `401 {error:'unauthorized'}` (auth failure, **not
distinguishing** expired-token from revoked-member), `502 upstream_failed`
(`enterprise_server/src/shared/enterpriseServerConstants.ts`).

### 7.2 D1: server changes (`enterprise_server`)
1. **Quota reason.** Extend the `429` body in
   `providerProxy.ts:84-92` to include a `reason` field. The only quota
   dimension in force today is per-day, so `reason: 'daily_quota_exhausted'`.
   ```json
   { "error": "quota_exceeded", "reason": "daily_quota_exhausted",
     "used": 42, "quota": 100, "reset_at": "2026-09-21T00:00:00Z" }
   ```
   (Future monthly/pool/batch dimensions would add `reason` values; that is a
   follow-up, not in scope.)
2. **Distinguish revocation from expiry.** In `requireAuth`
   (`enterprise_server/src/auth/middleware.ts`), when the JWT is validly signed
   but the member is no longer a member of the org, return a distinct body —
   e.g. `401 {error:'not_member'}` — instead of the generic
   `{error:'unauthorized'}`. A membership check must be added on that path
   (query membership for `claims.sub`/`claims.orgId`). Token-expired still
   returns `{error:'unauthorized'}`. The new body must be a stable, centralized
   constant (shared between server and desktop), not a string literal.

### 7.3 D2: desktop consumption
In `resolveOpenClawRuntimeError` (`openclawRuntimeAdapter.ts`), the first
source of a structured code is already the OpenClaw error metadata
(`metadata.errorCode` / `metadata.httpCode`). On the direct path OpenClaw talks
to the enterprise server, so its metadata is the only place the desktop can
see the enterprise response. Plan:
- Map the enterprise quota `reason` (from metadata, or from a 429 body the
  adapter can read) to a precise i18n message — new key(s) for
  `daily_quota_exhausted` alongside the existing
  `coworkErrorQuotaExhausted` fallback.
- Map the enterprise `not_member` signal to a membership-revocation event,
  driving `handleEnterpriseMembershipRevocation({ source: LlmSse })`
  (`main.ts:4784`) — the same handler the proxy's `LlmSse` source used, now fed
  by the enterprise server's structured `not_member`.
- **Fallback (accepted):** if OpenClaw does not transparently carry the
  enterprise `reason`/`error` into its error metadata (its abstraction layer
  may classify a 429 as rate-limit and drop the body), the adapter issues a
  light probe to the enterprise server with the current JWT (e.g. a
  no-op authenticated GET) to read the authoritative reason, then maps it. This
  runs only on the error path, so it is not on the request hot path.

### 7.4 D3: the A↔D seam (shared file)
`openclawRuntimeAdapter.ts` is touched by **both** Part A and Part D. Part A
removes `import { consumeRecentOpenClawTokenProxyQuotaError } from
'../openclawTokenProxy'` (`:116`) and the six call sites
(`:1721, :1731, :1747, :1764, :1768, :1783`). Part D replaces that
proxy-fed quota source with the new enterprise-metadata/probe source. To keep
the two parts independently committable, land them so the adapter compiles at
each step: **Part A** replaces the import with a thin new quota-signal module
(a small store with `rememberQuotaError`/`consume` that Part D later feeds from
the enterprise signals); **Part D** wires the enterprise `reason`/`not_member`
into that store and the revocation handler. The tests in
`openclawRuntimeAdapter.test.ts` that exercise
`consumeRecentOpenClawTokenProxyQuotaError` (`:620, :629, :759, :770, :5156,
:5191, :5195`) are repointed to the new module.

## 8. Open verification points (resolve during implementation, not design)

- **V1 — gateway hot-load of a changed provider `apiKey`.** Fact #3 predicts the
  refresh hot-delivers. Verify empirically that a running OpenClaw gateway
  actually adopts a new provider secret via `config.set`. If it does not, the
  deferred-restart path (already wired) is the correct behavior; confirm it
  triggers.
- **V2 — dsh key freshness on re-spawn.** Confirm the idle-gated re-spawn
  re-bakes the new JWT and that a subsequent `dsh_code_task` authenticates.
  Confirm no re-spawn happens mid-task.
- **V3 — enterprise error transparency.** Confirm whether OpenClaw carries the
  enterprise `429`/`401` body into error metadata. Determines whether the D2
  fallback probe is needed on the common path or only as a rare fallback.
- **V4 — enterprise membership check cost.** The `not_member` check adds a DB
  query to the `/proxy` hot path (every LLM request). If too costly, gate it
  (e.g. only when the JWT claims no longer match a cheap membership snapshot)
  or cache. Confirm with a timing check.

## 9. Testing strategy

- **Unit (Vitest):** `openclawConfigSync` (provider renders enterprise-direct
  after proxy removal), `claudeSettings` (consumer `SERVER` injection no longer
  gated on proxy; enterprise fallback unchanged), `openclawRuntimeAdapter`
  (reactive recovery single-flight; enterprise quota/revocation mapping),
  `dshConfigSync` (per-provider plan routes, route-id derivation, env var
  naming, two-protocol split, null/fallback skip).
- **Lint:** every touched file clean under
  `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0`.
- **Build:** `npm run compile:electron` (main/preload), plus `enterprise_server`
  build/typecheck for Part D1.
- **Manual (`npm run electron:dev`):** log in to an enterprise org; run a long
  task on a plan model; watch main logs for `enterprise-jwt-refresh`, confirm
  `openclaw.json` `apiKey` updates and the task does not 401. Exhaust a per-day
  quota and verify the precise copy. Verify a revoked member is bounced via the
  `not_member` path. Exercise a `dsh_code_task` to confirm idle re-spawn.

## 10. Rollout order

1. **Part A** — delete the proxy (independent).
2. **Part B** — DSH enterprise-direct + idle re-spawn hook (independent of C
   for the initial re-point; the re-spawn *trigger* lands with C).
3. **Part C** — proactive + reactive enterprise-JWT self-heal (feeds the B
   re-spawn).
4. **Part D** — enterprise structured signals + adapter rewiring (the A↔D seam).

Each lands as its own English Conventional Commit; nothing is pushed. Order
respects the A↔D shared-file seam so the adapter compiles at every step.

## 11. Risks

- **Provider enumeration (highest risk).** The `1590-1703` block is the only
  place every enterprise model is enumerated into the `genwork-server` provider
  with its per-model `baseUrl`. Part A must *restructure* it, not delete it
  (§4). If the loopback base URLs / `'proxy-managed'` keys are removed but the
  enumeration or the per-model `baseUrl` resolution is lost, plan models either
  vanish (only the active model remains) or 404 on the wrong upstream. Guarded
  by a unit test asserting every catalog model is present with the correct
  `/proxy/<provider>` per-model base after the change.
- **Consumer-path self-heal:** Part A stops gating the consumer `SERVER` token
  on the proxy. If the consumer path also depended on the proxy for token
  swap, that is a pre-existing consumer concern tracked separately, not a
  regression this change introduces (§4 note).
- **V4 hot-path cost:** the membership check on `/proxy` is the main
  performance risk; mitigated by gating/caching (V4).
- **DSH re-spawn cadence:** a refresh that lands mid-task is parked, so a task
  can outlive one refresh cycle and pick up the new key at the next idle —
  acceptable because the proactive refresh runs well before expiry (C1 threshold).
- **Enterprise catalog drift:** Part B relies on the catalog grouping models by
  provider; a catalog without a usable `provider` field would fall back to
  model-name dispatch (the ambiguous case). The per-provider grouping is
  preferred and the fallback is logged.
