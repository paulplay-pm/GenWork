# Organization & permission module — acceptance walkthrough

PRD V1.0 §八. This documents the manual acceptance run performed against a
**live, isolated Postgres backend** (a throwaway DB, not the developer's running
server), exercising the two-axis model end-to-end: 41 fine-grained permission
points (`module:action`) × 5 `DataScope` values, where the two axes are
**independent** (a role can hold a point yet have a narrow scope, or vice-versa).

Nothing here is a unit test. It is the real-server integration evidence that the
越权 (privilege-escalation) boundary is **fail-closed** on every read and write
path, and that the audit trail explains each refusal.

## Environment (how it was run)

- **Backend**: this repo's `enterprise_server` (`npx tsx src/server.ts`) on a
  free port (`:8799`), against a **throwaway** database. `runMigrations()` applies
  000–030 (incl. the two-axis 028/029/030); built-in roles are seeded globally by
  029. The user's own `:8787` server and its `gwork` DB were never touched.
- **Data**: one org with a 5-level department tree and five users:

  | dept path | user | role | notes |
  |---|---|---|---|
  | `/Engineering` | carol | `dept_admin` | scope `dept_and_below` over Engineering |
  | `…/Platform/Backend/Backend-Core` | bob | `member` | in Carol's subtree |
  | `…/Backend-Core/Storage` | alice | `member` | in Carol's subtree |
  | `/Sales` | dave | `member` | **out** of Carol's scope |
  | — (root) | admin | `super_admin` | org-wide, created by the setup flow |

- **Tokens** are HS256 JWTs signed with the same `JWT_SECRET` the server loads.
  `super_admin` short-circuits every gate; `dept_admin`/`member` are resolved
  against the live `roles` table for their fine points and data scope.

The two refusal axes are distinct and both audited:

- **permission axis** — the caller lacks the fine point for the route
  (`target_type: "route"`, e.g. `dept_admin` has no `dept:delete` / `role:delete`).
- **data-scope axis** — the caller has the point but the target is outside its
  scope (`target_type: "user"`, `payload.reason: "outside_scope"`).

## A. Scoped read: `dept_admin` sees only its subtree

Carol (`dept_admin`, scope `dept_and_below` over Engineering) lists users:

```bash
curl -s -H "authorization: Bearer $CAROL" "http://localhost:8799/admin/users?orgId=$ORG"
```

```
status 200 → users = [carol, bob, alice]
```

Only the Engineering subtree is visible; **dave (`/Sales`) is absent**. The list
is filtered server-side by data scope, not by the client. (Contrast: `admin`
`super_admin` sees all five.)

## B. 越权 write → 403, audited (data-scope axis)

Carol PATCHes an **out-of-scope** user (dave):

```bash
curl -s -H "authorization: Bearer $CAROL" -X PATCH \
  -H 'content-type: application/json' -d '{"displayName":"evil"}' \
  "http://localhost:8799/admin/users/$DAVE_ID"
```

```
status 403 → {"error":"forbidden"}
```

The same 403 (before any write) holds for a **batch** mutation on an out-of-scope
user, and for the **read path** (detail fetch):

```bash
# batch on out-of-scope user
curl -s -H "authorization: Bearer $CAROL" -X POST \
  -H 'content-type: application/json' \
  -d '{"action":"disable","userIds":["'$DAVE_ID'"]}' \
  "http://localhost:8799/admin/users/batch"
# → 403 {"error":"forbidden"}

# detail read on out-of-scope user (fail-closed on the READ path, not just writes)
curl -s -H "authorization: Bearer $CAROL" "http://localhost:8799/admin/users/$DAVE_ID"
# → 403 {"error":"forbidden"}
```

## C. 越权 write → 403 (permission axis)

Carol **does not hold** `dept:delete` or `role:delete`, so even her *own*
department and built-in roles are 403 (not 404 — the target exists, the point
is missing):

```bash
# delete her own department (no dept:delete point)
curl -s -H "authorization: Bearer $CAROL" -X DELETE "http://localhost:8799/admin/departments/$ENG_ID"
# → 403 {"error":"forbidden"}

# delete an out-of-scope department (Sales)
curl -s -H "authorization: Bearer $CAROL" -X DELETE "http://localhost:8799/admin/departments/$SALES_ID"
# → 403 {"error":"forbidden"}
```

## D. Built-in roles are non-deletable (409)

An `org_admin` (which *does* hold `role:delete`, org-wide scope) tries to delete
a built-in role:

```bash
curl -s -H "authorization: Bearer $ORG_ADMIN" -X DELETE "http://localhost:8799/admin/roles/$SUPER_ADMIN_ROLE_ID"
```

```
status 409 → {"error":"builtin_role"}
```

The built-in guard fires *after* the permission gate (a `dept_admin` would 403
first, as in §C) and returns a distinct `409 builtin_role`, so built-ins can
never be removed even by a high-privileged caller.

## E. Cross-org isolation → 404 (never mutated, never leaked)

A token whose `orgId` differs from the target's org gets **404**, not 403 — the
target is neither mutated nor its existence disclosed:

```bash
# token signed for org "other-org-xxxx" (super_admin there), targeting our org's user
curl -s -H "authorization: Bearer $OTHER_ORG" "http://localhost:8799/admin/users/$BOB_ID"
# → 404 {"error":"not_found"}

curl -s -H "authorization: Bearer $OTHER_ORG" -X PATCH \
  -H 'content-type: application/json' -d '{"displayName":"evil"}' \
  "http://localhost:8799/admin/users/$BOB_ID"
# → 404 {"error":"not_found"}
```

## F. Every 403 is audited (`admin_access_denied`)

```bash
curl -s -H "authorization: Bearer $SUPER" "http://localhost:8799/admin/audit?orgId=$ORG&limit=40"
```

The B/C/E refusals each wrote an `admin_access_denied` row (9 total in this run),
with the reason distinguishing the two axes:

```
target_type=user   target=<dave>  payload.reason="outside_scope"   ← data-scope axis
target_type=route  target=/admin/departments/<sales>               ← permission axis (no dept:delete)
target_type=route  target=/admin/users/batch  reason="outside_scope" ← data-scope axis (target user out of scope)
```

(Both a per-user scope denial and the batch denial are the *data-scope* axis —
the caller has the `user:edit` point but the target is outside its scope; the
audit row marks this with `payload.reason="outside_scope"`. The *permission*
axis fires when the point itself is missing, e.g. a `dept_admin` deleting a
department — `target_type=route` with no `reason`.)

## G. A legitimate in-scope batch is audited too (not just denials)

Carol batch-disables an **in-scope** user (bob), then re-enables to leave state clean:

```bash
curl -s -H "authorization: Bearer $CAROL" -X POST \
  -H 'content-type: application/json' \
  -d '{"action":"disable","userIds":["'$BOB_ID'"]}' \
  "http://localhost:8799/admin/users/batch"
# → 200 {"ok":true,"affected":1}

curl -s -H "authorization: Bearer $CAROL" -X POST "http://localhost:8799/admin/users/$BOB_ID/enable"
# → 200 {"ok":true}
```

Audit trail shows both positive events for bob: `user_batch` and `user_enable`
(actor `carol`). Mutations are audited on success and on denial alike.

## H. "Hidden buttons are not the control"

The SPA hides an affordance when the caller lacks the fine point (gated on
`/me.permissions`, not the coarse JWT roles). But hiding a button is a UX
convenience, **not** the security boundary: the same request issued directly
(`curl`, bypassing the UI entirely) 403s, as shown in §B–§E. The server-side
gate — not the client — is the control. A `dept_admin` with no `user:delete`
cannot delete a user by hitting `DELETE /admin/users/:id` directly; there is no
such route at all, and the write paths that exist all enforce scope + point.

## I. Provider keys: masked only, no plaintext (regression pin)

A `provider:view`-only caller lists keys and receives only `api_key_masked`
(never the plaintext); a non-view caller 403s; a view-only caller's `POST` 403s
and writes nothing. Pinned by `enterprise_server/tests/routes/providerKeysGating.test.ts`.

## Visual baselines

`web/tests/visual/{departments,roles,users}.spec.ts` render the three
organization pages **against a real seeded backend** (a properly signed token,
real org id) and snapshot:

- `departments-tree.png` — the 5-level tree (Engineering → Platform → Backend →
  Backend-Core → Storage) fully expanded, per-node member counts, detail panel.
- `departments-drawer.png` — the create-department drawer.
- `roles-grid.png` / `roles-drawer.png` — built-in role card grid (member counts
  + data-scope labels) and the 3-step "Add role" drawer (Basic info / Data scope /
  Permission points).
- `users-list.png` / `users-batch-bar.png` / `users-drawer.png` — the user table
  (role chips each carrying a data-scope label), the floating batch bar after a
  row is checked (4 actions), and the create-user drawer (basic info /
  organization affiliation with primary + concurrent departments / roles &
  permissions).

These differ from the pre-existing `console.spec.ts` baselines, which were
captured with no backend (unsigned token → empty states). Regenerate with
`WEB_PORT=<spare> WEB_PROXY_TARGET=<backend> WEB_ORG_ID=<org> \
npx playwright test tests/visual/{departments,roles,users}.spec.ts --update-snapshots`
from `enterprise_server/web/`.

## Result

```
A. Carol user list scoped to ENG subtree (no dave)     ✅ 200 [carol,bob,alice]
B. Carol PATCH out-of-scope user → 403                 ✅ 403
C. Carol batch on out-of-scope user → 403              ✅ 403
D. Carol delete dept (no dept:delete) → 403            ✅ 403
E. Carol delete out-of-scope dept → 403                ✅ 403
F. org_admin delete builtin role → 409 builtin_role    ✅ 409
G. Carol GET out-of-scope user detail → 403            ✅ 403
H. admin_access_denied audit rows present after 403s   ✅ 9 rows
X1/X2. cross-org GET/PATCH user (different org)        ✅ 404 (not 403)
X3/X4. in-scope batch-disable + re-enable (cleanup)    ✅ 200 + user_batch/user_enable audit
```

**8/8 core 越权 checks pass against live Postgres.** The 越权 boundary is
fail-closed on read and write; every denial is audited with a reason that
identifies which axis (point vs. scope) fired; cross-org targets 404; built-in
roles are 409-locked; the SPA's hidden buttons are corroborated, not substituted,
by the server-side gate.
