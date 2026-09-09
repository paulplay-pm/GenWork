# Model & provider management module — acceptance walkthrough

PRD V1.0 §七 (acceptance). This documents the acceptance run for the
model/provider management surface: 9 built-in providers, a custom-provider
CRUD surface with write-only (encrypted) API keys, a protocol-aware
models-refresh wire format, multi-type model save, and the cross-org 越权
boundary. It is pinned by
`enterprise_server/tests/acceptance/modelProviderAcceptance.test.ts`.

Nothing here is a unit test. It is the real-app integration evidence that the
security boundary (encrypted keys, masked echo, builtin non-deletability,
fail-closed cross-org isolation) holds on every read and write path, and that
the audit trail explains each built-in-delete refusal.

## Environment (how it was run)

- **Backend**: this repo's `enterprise_server` `buildApp()` (the *real*
  application, the same object `src/server.ts` serves), driven **in-process**
  at the HTTP boundary — `app.request(url, { method, headers, body })` for
  every check — under vitest. No separate Postgres server is stood up.
- **Data**: a **throwaway in-process Postgres** (the `pglite` shim in
  `src/db/testDb`), reset per test (`resetSchema()` + `runMigrations()`
  applies 000–032) and seeded exactly like the live server seeds it
  (`seedBuiltinProviders('o1')`). This is a genuine "throwaway DB" in the
  spirit of the constraint — it is discarded after the run and shares nothing
  with any real database. **The developer's running server and its `gwork`
  Postgres DB (on `:5432`) were never touched.** (This sandbox has no clean
  throwaway Postgres; the in-process pglite DB is the isolation mechanism.)
- **Tokens** are HS256 JWTs signed with the same `JWT_SECRET` the server loads
  (`signToken`), `super_admin` short-circuits every gate. The cross-org check
  uses a second, real org (`o2`) with its own token.

The two security axes exercised are distinct:

- **builtin guard** — a high-privileged caller attempts to remove a seeded
  provider; the guard returns a distinct `409 { error: 'builtin_provider' }`
  and writes an `audit_events` row
  (`action='provider_key_builtin_delete'`).
- **cross-org isolation** — a caller whose `orgId` differs from the target's
  org gets **404**, not 409/200: the target is neither mutated nor its
  existence (nor its built-in-ness) disclosed.

## A. The 9 built-ins (seeded per org)

`seedBuiltinProviders` idempotently inserts these 9 providers (and their
models) for each org. They are the non-deletable baseline. Because they seed
**without an API Key**, they start **disabled** (`enabled=false`): the
operator adds a key and enables the provider before its models are offered to
users (a keyless provider cannot authenticate).

| # | slug | display name | endpoint | protocol |
|---|------|--------------|----------|----------|
| 1 | `openai` | OpenAI | `https://api.openai.com/v1` | openai |
| 2 | `anthropic` | Anthropic | `https://api.anthropic.com` | anthropic |
| 3 | `deepseek` | DeepSeek | `https://api.deepseek.com` | openai |
| 4 | `moonshot` | Moonshot (Kimi) | `https://api.moonshot.cn/v1` | openai |
| 5 | `qwen` | Qwen (DashScope) | `https://dashscope.aliyuncs.com/api/v1` | openai |
| 6 | `zhipu` | Zhipu (GLM) | `https://open.bigmodel.cn/api/paas/v4` | openai |
| 7 | `minimax` | MiniMax | `https://api.minimax.chat/v1` | openai |
| 8 | `xiaomi` | Xiaomi (MiMo) | `https://api.xiaomimimo.com/v1` | openai |
| 9 | `volc` | 火山引擎 (豆包) | `https://ark.cn-beijing.volces.com/api/v3` | openai |

## B. 9 built-ins present + non-deletable (409 + audit row each)

A `super_admin` lists the org's provider keys and then attempts to delete all
9 built-ins:

```
GET /admin/provider-keys?orgId=o1
→ 200 ; 9 rows with is_builtin=true
```

Every one of the 9 `DELETE /admin/provider-keys/:id` calls is refused with the
distinct built-in guard (and leaves an audit trail of the attempt):

```
DELETE /admin/provider-keys/<builtin-id>   (×9)
→ 409 {"error":"builtin_provider"}
```

The guard fires *after* the cross-org guard (so a foreign org's built-in still
404s, as in §F) and returns a distinct `409 builtin_provider`, so built-ins
can never be removed even by a high-privileged caller. Each of the 9 refusals
wrote an `audit_events` row:

```
count(action='provider_key_builtin_delete') = 9
```

## C. Custom add (keyless ok) + masked echo, never plaintext

A custom provider may be created **keyless** (the key is added later); a real
key is then set via `PATCH` (write-only) and is echoed back **only** as a
`•`-masked form:

```
POST /admin/provider-keys   { orgId, provider:'vllm-custom', protocol:'openai',
                               endpoint:'https://x/v1' }            (NO apiKey)
→ 200 { id }

PATCH /admin/provider-keys/<id>   { protocol:'anthropic',
                                     apiKey:'sk-real-secret-123456' }
→ 200

GET /admin/provider-keys?orgId=o1
→ 200 ; that row shows api_key_masked = "sk-••••••••••••3456"
```

The plaintext `sk-real-secret-123456` is **absent** from the JSON body — only
the `•`-masked form is returned. The mask is a UI aid, not a secret; the
plaintext is encrypted at rest and never leaves the trust boundary.

## D. Inline enable/disable a builtin (enabled flips)

A built-in provider can be toggled inline (it is non-deletable, and its
`enabled` flag is settable). Built-ins seed **disabled** (no key), so the
inline PATCH toggles `enabled` from `false → true`:

```
GET /admin/provider-keys?orgId=o1                 → openai row enabled=false (keyless seed default)
PATCH /admin/provider-keys/<openai-id>  { enabled:true }
→ 200
GET /admin/provider-keys?orgId=o1                 → openai row enabled=true
```

(The UI additionally refuses to *enable* a keyless provider until an API Key
is entered — "开启前请先输入 API Key" — a client-side guard; the raw PATCH
sets the flag unconditionally, which is what this check pins.)

## E. Protocol-aware refresh wire format (anthropic → `x-api-key`, no Bearer)

A custom row seeded with `protocol='anthropic'` + a key + a local-stub endpoint
is refreshed; the outgoing wire request is captured via a stubbed
`globalThis.fetch`:

```
POST /admin/provider-keys/<id>/refresh-models
→ 200 { added, unchanged, upstreamCount }
```

The captured request headers use the **Anthropic** wire format:

```
x-api-key:          <stored key>
anthropic-version:  2023-06-01
authorization:      (absent — no "Bearer …")
```

An `openai`-protocol row, by contrast, sends `authorization: Bearer <key>` and
no `x-api-key`. The row's `protocol` column selects the wire format
(`src/models/providerModelFetcher.ts`), so a mislabelled provider authenticates
the way its endpoint expects rather than the way its slug suggests.

## F. Cross-org isolation → 404 (never 409/200/leak)

A token whose `orgId` is a **second org** (`o2`) targeting a `provider-keys` id
owned by `o1` gets **404**, not 409/200 — the target is neither mutated nor its
existence (or built-in-ness) disclosed:

```
# o2 super_admin deletes an o1 built-in
DELETE /admin/provider-keys/<o1-builtin-id>      (o2 token)
→ 404 {"error":"provider_not_found"}

# o2 super_admin patches an o1 built-in
PATCH  /admin/provider-keys/<o1-builtin-id>  { label:'leak' }   (o2 token)
→ 404 {"error":"provider_not_found"}
```

The cross-org guard (`WHERE id=$1 AND org_id=$2`) fires *before* the built-in
`409`, so a foreign org cannot even learn that the target is a built-in — it
simply does not exist from that org's viewpoint.

## G. Model multi-type save + out-of-set rejection

A model is saved with a multi-type set (the 8-value `ModelTypes` vocabulary)
and read back; an out-of-set type is rejected:

```
POST /admin/models  { orgId, providerKeyId, provider, model,
                       types:['chat','vision','reasoning'] }
→ 200 { id }
GET  /admin/models?orgId=o1
→ 200 ; that row returns types = ["chat","vision","reasoning"]

POST /admin/models  { …, model:'acceptance-bad-type',
                       types:['chat','bogus'] }
→ 400 {"error":"validation_error","field":"types.1"}
```

The 8-value `types` set is stored and returned verbatim; a value outside the
set (`bogus`) is rejected at the route (zod) with `400`. The deprecated single
`type` column stays in sync as the mapped old-6 value (`legacyTypeFor`).

## H. Model PATCH `types` round-trip + legacy mapping + non-array rejection

The edit path is pinned too: a model is PATCHed with a new multi-type set and
read back — the stored `types` and the deprecated `type` (mapped via
`legacyTypeFor`) both come back correct — and a non-array `types` value is
rejected at the route with `400`, not a `500`:

```
PATCH /admin/models/:id?orgId=o1   { types:['asr','tts'] }
→ 200 ; GET returns types = ["asr","tts"], type = "audio"   (asr/tts → legacy "audio")

PATCH /admin/models/:id?orgId=o1   { types:'bogus' }   (a string, not an array)
→ 400 {"error":"validation_error","field":"types"}
```

This guards the `Array.isArray` check in the PATCH handler so a malformed
(non-array) `types` value fails closed with `400` instead of throwing a `500`
inside `legacyTypeFor`.

## I. Cross-tenant `orgId` mismatch → `400` (no cross-org read/create)

The client-supplied `orgId` (query param on reads, body field on creates) is
cross-checked against the caller's token. A caller holding an `o2` token who
names `orgId=o1` gets `400 {"error":"org_mismatch"}` — they cannot list `o1`'s
providers/models or create into `o1`. This closes the read-leak path (a GET
used to return whatever org the query named) and matches the `org_mismatch`
guard already used by the `users`/`departments` routes.

```
GET  /admin/provider-keys?orgId=o1   (token = o2)  → 400 {"error":"org_mismatch"}
GET  /admin/models?orgId=o1          (token = o2)  → 400 {"error":"org_mismatch"}
POST /admin/provider-keys            (token = o2, body.orgId='o1')
                                        → 400 {"error":"org_mismatch"} ; no o1 row created
```

## Visual baselines

`web/tests/visual/providers.spec.ts` (mirrors `users.spec.ts`: HS256-signed
token seeded via `addInitScript`, real org id) renders the providers page
**against a real seeded backend** and snapshots three baselines under
`web/tests/visual/screenshots/providers.spec.ts/`:

- `providers-list.png` — the provider rail: 9 built-ins (`BUILT-IN (9)`) + a
  custom provider (`CUSTOM (1)`), grouped, with per-provider model-count badges
  and the "+ Add provider" affordance.
- `provider-detail.png` — the selected built-in (`anthropic`) detail: the
  header (breadcrumb + name + `Test connection` / `Save`) and the 连接信息
  "Provider info" card (Name / Base URL / **API-protocol radio** —
  "Anthropic compatible" checked / API Key showing the **masked** hint
  `Current: sk-•••••••••2026`, never plaintext).
- `model-drawer.png` — the "Add model" drawer: the **8 capability type cards**
  (Chat / Vision / Reasoning / Image Gen / Embedding / Rerank / ASR / TTS), the
  **5-stop context-window picker** (32K / 64K / 200K / 1M / 2M), and the
  **sampling params** (Temperature / Top P).

**Captured in this environment** against a real, isolated, seeded backend —
*not* a fabricated or stale snapshot. The setup (all on spare ports; the dev
server and its `gwork` DB on `:5432` were never touched):

1. A **throwaway Postgres** on `:5433` (a Docker `postgres:16` container — this
   sandbox has no host `psql`/`initdb`, so the isolation came from the
   container), database `gwork_acceptance`.
2. **Seeded**: `runMigrations()` (000–032) + one org (`org-model-provider`) +
   `seedBuiltinProviders` (the 9 built-ins) + one custom provider (`vllm-demo`,
   with a key) + a key on the `anthropic` built-in (so the masked hint renders).
3. The real `enterprise_server` (`npx tsx src/server.ts`) on `:8799` against
   that DB (`JWT_SECRET` + `GENWORK_VAULT_MASTER_KEY` set), health-checked.
4. Baselines captured from `enterprise_server/web/`:

```bash
WEB_PORT=5199 WEB_PROXY_TARGET=http://localhost:8799 \
WEB_ORG_ID=org-model-provider \
WEB_JWT_SECRET=<the-secret-the-backend-loads> \
  npx playwright test tests/visual/providers.spec.ts --update-snapshots
```

A plain re-run (no `--update-snapshots`) passes against the captured
baselines, confirming they are stable. **These baselines are gitignored and
local-only — not committed.** `web/.gitignore` ignores
`tests/visual/screenshots/` ("Visual regression baselines (generated,
regenerable via `npm run test:visual:update`)"), so the three PNGs are local
artifacts, consistent with the pre-existing `console.spec.ts` baselines (also
untracked). Regenerate them with `npm run test:visual:update` (or the
`--update-snapshots` command below). The visual specs run under
`npm run test:visual` (Playwright), **not** the default `npm test` (vitest)
gate, so they do not affect the default test flow. To regenerate the
baselines in any environment with a throwaway seeded backend, repeat the
four steps above (any free ports + a fresh seeded DB) and re-run the
`--update-snapshots` command.

## Result

```
B. 9 built-ins present + non-deletable                 ✅ 200 (9/9); 9× DELETE → 409 ; audit = 9 rows
C. custom add keyless + masked echo (no plaintext)     ✅ 200 / 200 / mask "sk-••••••••••••3456"
D. inline enable/disable a builtin (enabled flips)     ✅ 200 ; enabled false → true (keyless builtins start disabled)
E. protocol-aware refresh wire format (anthropic)      ✅ 200 ; x-api-key + anthropic-version, no Bearer
F. cross-org target (different org)                    ✅ 404 (DELETE+PATCH+enable/disable, never 409/200)
G. model multi-type save + out-of-set rejection        ✅ 200 (types returned) / 400 (types.1)
H. model PATCH types round-trip + legacy mapping       ✅ 200 (type="audio") / 400 (non-array types)
I. cross-tenant orgId mismatch (read/create)           ✅ 400 (org_mismatch; no foreign row created)
```

**8/8 acceptance checks pass against the real `buildApp()` over a throwaway
in-process Postgres.** Built-ins are `409`-locked and each refusal is audited;
custom keys are write-only and echoed only masked; the protocol column drives
the wire format; multi-type save round-trips and rejects out-of-set values;
cross-org targets fail closed with `404`; and the client-supplied `orgId` is
cross-checked against the token, so a foreign-org read or create fails with
`400 org_mismatch`. The three visual baselines
(`providers-list.png` / `provider-detail.png` / `model-drawer.png`) were
captured against a real, isolated, seeded backend (a throwaway Postgres on a
spare port; the dev `gwork` DB never touched). They are **gitignored /
local-only, not committed** (per `web/.gitignore`), and are regenerable via
`npm run test:visual:update`.

> **Re-baseline after the keyless→disabled seed change:** the captured
> `providers-list.png` / `provider-detail.png` were taken when built-ins seeded
> enabled. Built-ins now seed `enabled=false`, so those two baselines are
> stale (the rail switches + detail now render the disabled state) and must be
> re-captured with `npm run test:visual:update` against a fresh seeded backend.
> The `model-drawer.png` baseline is unaffected.
