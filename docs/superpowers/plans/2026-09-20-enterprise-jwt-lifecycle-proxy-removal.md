# Implementation plan — enterprise JWT lifecycle, proxy removal, DSH enterprise-direct

Companion to the spec `../specs/2026-09-20-enterprise-jwt-lifecycle-proxy-removal-design.md`.
Each step is independently committable (English Conventional Commit, no push).
After each step: lint the touched files, and (for main-process code)
`npm run compile:electron`.

Touched-file lint gate (CI-equivalent):
```
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>
```

Legend — `[A]` Part A delete proxy · `[B]` DSH enterprise-direct ·
`[C]` JWT self-heal · `[D]` enterprise error signals.

---

## Step 1 [A] — delete the proxy module + its own test
- Delete `src/main/libs/openclawTokenProxy.ts`.
- Delete `src/main/libs/openclawTokenProxy.test.ts`.
- (Intentionally breaks compilation; fixed in Steps 2-4. This step only removes
  the module; do not attempt to build until Step 4.)
- **Commit:** `refactor(cowork): remove the local token proxy module`

## Step 2 [A] — sever references so main process compiles
- `src/main/main.ts`:
  - Remove imports `407-410` (`getOpenClawTokenProxyPort`,
    `startOpenClawTokenProxy`, `stopOpenClawTokenProxy`).
  - Remove quit-time `stopOpenClawTokenProxy()` (`12413`).
  - Remove startup block `12690-12710` (the `startOpenClawTokenProxy({...})`
    call incl. its profiler marks + try/catch). The
    `onEnterpriseMembershipRevoked` callback here (the `LlmSse` source) is
    re-established in Step 8 [D]; until then the revocation capability is
    temporarily reduced (JsonApi/EnterpriseContext sources still fire).
  - Remove any proxy-referencing comment near `2046`.
- `src/main/libs/openclawConfigSync.ts`:
  - Remove import `78`.
  - **Restructure the `1590-1703` block (do NOT delete the enumeration):**
    - Drop the `getOpenClawTokenProxyPort()` gate; run enumeration when
      `serverModels.length > 0` (enterprise mode).
    - Keep the per-model loop (`1628-1700`) and `resolveModelProxyUrl`
      (`1654-1663`) verbatim (per-model `/proxy/<provider>` base).
    - Provider-level base: use the active model's enterprise `baseURL` (the
      `providerSelection.providerConfig` base from Step 0's `tryEnterpriseCatalogFallback`).
    - `apiKey` for the provider block **and** each upserted model: the current
      user enterprise JWT (`sessionStorage.load()?.jwt`). This is a new
      read; add a small local helper or reuse an existing getter. If no JWT is
      present (pure local mode, empty catalog) the enumeration is skipped
      anyway (`serverModels.length === 0`), so no guard beyond that is needed.
  - Remove the two `'proxy-managed'` literals (`1597`, `1668`).
- `src/main/libs/claudeSettings.ts`:
  - Remove import `20`.
  - `resolveAllProviderApiKeys` (`899-907`): drop the
    `shouldInjectServerToken = !getOpenClawTokenProxyPort()` gate; always inject
    the consumer `SERVER` token when a consumer access token + base URL exist.
- `src/main/libs/claudeSettings.test.ts`:
  - Remove the `vi.mock('./openclawTokenProxy', ...)` (`32-33`) and any test
    that asserts the proxy port is "active"; adjust the enterprise-branch test
    (`264`) to reflect that the consumer `SERVER` token is now always injected.
- `npm run compile:electron` must pass.
- **Commit:** `refactor(cowork): drop the local token proxy wiring`

## Step 3 [A] — adapter seam: replace the deleted quota helper with a thin module
- Create `src/main/libs/enterpriseQuotaSignal.ts` (small): a module store with
  `rememberEnterpriseQuotaError({...})` and
  `consumeRecentEnterpriseQuotaError(): { message; code? } | null`, plus a
  `rememberMembershipRevoked()` no-op for now. Shape mirrors the deleted
  `consumeRecentOpenClawTokenProxyQuotaError` so the adapter's 6 call sites
  (`1721,1731,1747,1764,1768,1783`) recompile with a one-line import swap.
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`:
  - Replace `import { consumeRecentOpenClawTokenProxyQuotaError } from
    '../openclawTokenProxy'` (`116`) with the new module's
    `consumeRecentEnterpriseQuotaError`.
  - Re-point the 6 call sites to the new name.
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`:
  - Replace the import (`37-38`) and repoint the 7 test usages
    (`620,629,759,770,5156,5191,5195`) to the new module (add the corresponding
    `remember` export).
- **Commit:** `refactor(cowork): move quota-error signal off the deleted proxy`
- (This keeps A and D independently committable; D fills the new module in Step 8.)

## Step 4 [A] — verify A is complete and green
- `npm run compile:electron`.
- Lint all touched files (Step 2-3 list).
- `npm test -- openclawConfigSync` + `npm test -- claudeSettings` +
  `npm test -- openclawRuntimeAdapter`.
- Add/adjust the **provider-enumeration unit test** (the highest-risk guard):
  after the restructure, assert every enterprise catalog model is present in the
  `genwork-server` provider, each with its per-model `/proxy/<provider>` base
  and a real JWT apiKey (not `'proxy-managed'`).
- **Do not commit the test as a separate change; fold into Step 2's commit if
  it belongs there, or a follow-up `test(cowork)` commit.**

## Step 5 [B] — DSH plan provider: enterprise-direct, multi-baseUrl
- `src/main/libs/dshConfigSync.ts`:
  - Rework `DshPlanProviderInput` (`64-77`) to take **groups**:
    `Array<{ provider, baseURL, displayName, models[] }>`.
  - Rework `renderPlanRoutes` (`215-271`) to emit **one route per provider
    group** (keep the per-group openai/anthropic two-protocol split). Route ids
    via `sanitizeDshRouteId` (e.g. `genwork-plan-<provider>` + anthropic
    suffix). `apiKeyEnv` via `deriveDshApiKeyEnvRef`.
  - Skip reason on null input: `enterprise-unavailable`.
- `src/main/ipcHandlers/dsh/handlers.ts` + `main.ts:7480-7500`
  (`getPlanProvider`): build the groups from the enterprise catalog
  (`enterpriseModelCache.list()`), grouping models by `provider`, each
  `baseURL = ${getEnterpriseServerUrl()}/proxy/<provider>`. Return `null` unless
  `ENTERPRISE_SERVER_URL` + `sessionStorage.load()?.jwt` + non-empty catalog.
- `envVars[<ROUTE>_API_KEY] = <user enterprise JWT>` for every plan route
  (replace the `'proxy-managed'` placeholder).
- **Commit:** `feat(dsh): point the billed plan at enterprise direct, per-provider`

## Step 6 [B] — DSH idle-gated re-spawn on JWT refresh
- `src/main/libs/dshCodeMcpServer.ts`: add an active-task counter. Increment at
  the start of `runCodeTask` (`140`), decrement in a `finally` (covers timeout /
  success / failure). Expose `isDshIdle()`.
- `src/main/libs/dshEngineManager.ts`: add `refreshPlanCredential()`:
  - `Stopped` → no-op.
  - `Ready` + `isDshIdle()` → stop + start (re-bakes the new JWT).
  - `Ready` + active task → set a pending-refresh flag.
- On `runCodeTask` `finally` (task end): if pending-refresh flag set AND engine
  `Ready` AND idle → re-spawn.
- **Commit:** `feat(dsh): re-spawn the engine at idle to pick up a refreshed plan key`

## Step 7 [C] — proactive enterprise-JWT self-heal
- `src/main/main.ts`: add a background refresher mirroring the consumer one
  (`12621-12637`):
  - Periodic (≈30-40 min) read `sessionStorage.load()`; if
    `expiresAt - now < 10 min` → `enterpriseClient.refresh()` →
    `enterpriseClient.persistSession(orgId, username, newJwt, newExpiresAt)`.
  - On success: `syncOpenClawConfig({ reason: 'enterprise-jwt-refresh',
    restartGatewayIfRunning: false })` **and** the DSH
    `refreshPlanCredential()` (Step 6).
  - Single-flight (coalesce in-flight refreshes).
- Confirm the sync call does **not** suppress the deferred-restart path: if the
  gateway hot-delivery is `Rejected`, the existing `scheduleDeferredGatewayRestart`
  must take over (no code change expected; verify in V1).
- New i18n keys (zh + en) for the reactive "refreshed — please retry" message.
- **Commit:** `feat(auth): proactively refresh the enterprise JWT before expiry`

## Step 8 [C] — reactive single-flight recovery
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
  (`resolveOpenClawRuntimeError`): when `isGenWorkLoginExpiredMetadata`
  (`1668`) is true and provider is `GenworkServer`:
  - If stored JWT still verifies → trigger a refresh (single-flight guarded) and
    surface the "refreshed — please retry" message.
  - If expired → fall through to existing `loginGate.lock()` / login-expired.
- **Commit:** `fix(cowork): recover a stale enterprise JWT on the direct path`

## Step 9 [D] — enterprise server: structured signals
- `enterprise_server/src/proxy/providerProxy.ts` (`84-92`): add
  `reason: 'daily_quota_exhausted'` to the `429` body.
- `enterprise_server/src/auth/middleware.ts` (`requireAuth`): distinguish a
  validly-signed but revoked member from an expired token —
  `401 { error: 'not_member' }` vs the existing `{ error: 'unauthorized' }`.
  Add the membership check (V4: gate/cache it so it is not an unbounded hot-path
  query).
- New shared constant (no bare string literals) for the `not_member` /
  `daily_quota_exhausted` signals, importable by the desktop (e.g. under
  `src/shared/enterpriseAccount/` on the GenWork side mirroring the server's
  `shared/enterpriseServerConstants.ts`).
- **Commit (enterprise_server):** `feat(auth): surface quota reason and member revocation`
- **Commit (GenWork shared):** `feat(enterprise): add shared structured error constants`

## Step 10 [D] — desktop: consume the structured signals
- `src/main/libs/enterpriseQuotaSignal.ts` (from Step 3): feed it from the
  enterprise source. Wire `reason` → precise i18n (new keys alongside
  `coworkErrorQuotaExhausted`); `not_member` → membership revocation.
- `openclawRuntimeAdapter.ts`: read the enterprise `reason`/`not_member` from
  OpenClaw error metadata; add the **fallback light probe** (auth GET to
  enterprise) if metadata does not carry it (V3).
- Re-establish the `LlmSse` revocation source: `not_member` →
  `handleEnterpriseMembershipRevocation({ source: LlmSse })` (`main.ts:4784`) —
  the source the proxy previously fed in Step 2's removed startup block.
- **Commit:** `feat(cowork): resolve enterprise quota and revocation from the server`

## Step 11 — full verification
- Lint every touched file (both repos).
- `npm run compile:electron`; `enterprise_server` typecheck/build.
- `npm test -- openclawConfigSync claudeSettings openclawRuntimeAdapter dshConfigSync`.
- Manual `npm run electron:dev`:
  1. Enterprise login; long task on a plan model → watch logs for
     `enterprise-jwt-refresh`, confirm `openclaw.json` `apiKey` updates, no 401.
  2. Confirm hot-load (V1) or deferred-restart triggers.
  3. Exhaust a per-day quota → precise copy (V3).
  4. Revoke a member → bounced via `not_member` (V4 perf check).
  5. `dsh_code_task` → confirm idle re-spawn, no re-spawn mid-task (V2).

---

## Cross-cutting checks
- No bare string literals for the new discriminants (use `as const` shared
  constants; CLAUDE.md String Constants rule).
- i18n: every new user-visible string gets zh + en.
- Main-process changes: prefer `console.*` per the Logging rules (module-tagged,
  English, no hot-path info logs).
- No drive-by refactors on the oversized files; keep edits scoped.
- Nothing pushed; commit only after the user tests/confirmates per the standing
  constraint — i.e., present diffs for review rather than committing unilaterally
  if the user prefers to review first.

## Rollout order
Step 1 → 11, in order. A (1-4) is self-contained; B (5-6), C (7-8), D (9-10)
depend on A's seam (Step 3). C's refresher (7) is what actually *triggers* B's
re-spawn (6); land 6 before 7 so the trigger has a target.
