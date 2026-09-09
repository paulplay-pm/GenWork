// enterprise_server/tests/sso/finishCallbackSelfBinding.test.ts
// Pins the self_binding pre-check in finishCallback.ts:
//
//   * When the IdP's externalId is already bound to a DIFFERENT user, the
//     function returns `{ error: 'bind_external_id_exists' }` and leaves
//     the other user's binding row untouched (the unique index would
//     otherwise have raised 23505 and the row would not have changed
//     anyway, but the explicit pre-check returns a friendlier code and
//     also avoids auditing the user as "sso_binding_duplicate_race").
//   * When the externalId is already bound to the SAME user (overwrite),
//     the function returns `{ kind: 'web_self_binding_success', ... }`
//     for `returnTarget === 'web'` and `{ token }` for other surfaces.
//
// Note: `finishSsoCallback` does NOT take an `externalId` argument — the
// externalId is derived from the IdP's userinfo response (the `sub`
// claim, since the seeded connection sets `identity_id_field = 'sub'`).
// We control it by mocking `fetch` (the same harness the existing
// tests/sso/finishCallback.test.ts uses).
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { finishSsoCallback } from '../../src/sso/finishCallback';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';
import { consumeState, createState } from '../../src/sso/state';
import { STATE_TTL_MS } from '../../src/sso/types';

describe('finishCallback self_binding — externalId pre-check + web return shape', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    ssoLoginContextStore.delete('st-sb-dup');
    ssoLoginContextStore.delete('st-sb-overwrite');
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes,
         identity_id_field, email_field, require_prebinding, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc',
               'https://idp/a','https://idp/t','https://idp/u','cid','openid email',
               'sub','email', false, '[]'::jsonb)`,
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash)
       VALUES ('u-current','o1','alice','x'), ('u-other','o1','bob','x')`,
    );
    fetchMock.mockReset();
  });

  // Park a self_binding context for `userId` with the requested returnTarget
  // and consume the state row in the same shape the production /me/sso-binding
  // flow hands off to finishSsoCallback.
  async function parkCtx(
    userId: string,
    returnTarget: 'web' | 'desktop' | 'console',
  ): Promise<NonNullable<Awaited<ReturnType<typeof consumeState>>>> {
    const { state } = await createState({
      orgId: 'o1', connectionId: 'c1', returnTarget,
      codeVerifier: 'v', redirectUri: 'http://test/cb',
    });
    // createState writes a fresh random state into the DB; we use the same
    // key for the in-memory park below so the callback lookup hits.
    ssoLoginContextStore.set(state, {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1', userId,
      redirectUri: 'http://test/cb', codeVerifier: 'v',
      returnTarget,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const consumed = await consumeState(state);
    if (!consumed) throw new Error('consumeState returned null');
    return consumed;
  }

  test('returns bind_external_id_exists when externalId is bound to a different user (no row mutation)', async () => {
    // Pre-seed u-other with (c1, ext-bob) — the IdP will return sub=ext-bob.
    await testPool.query(
      `UPDATE users SET sso_connection_id='c1', sso_external_id='ext-bob' WHERE id='u-other'`,
    );

    const consumed = await parkCtx('u-current', 'web');

    // IdP token exchange + userinfo returning sub=ext-bob (the one bound to u-other).
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: 'ext-bob', email: 'whoever@x.com' }), { status: 200 }),
      );

    const result = await finishSsoCallback({ code: 'CODE', state: consumed, redirectUri: 'http://test/cb' });
    expect(result).toEqual({ error: 'bind_external_id_exists' });

    // u-other's binding row is UNCHANGED (the pre-check must not mutate).
    const u = await testPool.query<{ sso_external_id: string | null }>(
      `SELECT sso_external_id FROM users WHERE id='u-other'`,
    );
    expect(u.rows[0]?.sso_external_id).toBe('ext-bob');

    // u-current is UNCHANGED (no sso_* columns populated).
    const uc = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u-current'`,
    );
    expect(uc.rows[0]).toEqual({ sso_connection_id: null, sso_external_id: null });

    // user_idp_identities: no row for u-current.
    const ids = await testPool.query(
      `SELECT 1 FROM user_idp_identities WHERE user_id='u-current'`,
    );
    expect(ids.rowCount).toBe(0);

    // Audit row with reason='external_id_bound_to_other_user'.
    const audit = await testPool.query<{ payload: unknown }>(
      `SELECT payload FROM audit_events
        WHERE action='sso_user_self_bound_denied' AND user_id='u-current'
        ORDER BY ts DESC LIMIT 1`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.payload).toMatchObject({
      reason: 'external_id_bound_to_other_user',
      ssoConnectionId: 'c1',
      externalId: 'ext-bob',
    });
  });

  test('overwrite succeeds and returns web_self_binding_success when externalId is already bound to the SAME user', async () => {
    // u-current is already bound to (c1, ext-alice). Same-user overwrite path.
    await testPool.query(
      `UPDATE users SET sso_connection_id='c1', sso_external_id='ext-alice' WHERE id='u-current'`,
    );

    const consumed = await parkCtx('u-current', 'web');

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: 'ext-alice', email: 'a@x.com' }), { status: 200 }),
      );

    const result = await finishSsoCallback({ code: 'CODE', state: consumed, redirectUri: 'http://test/cb' });
    // FinishResult is a union; TypeScript can't narrow it via `kind` because
    // the other variants don't carry that discriminant. We assert shape first,
    // then cast to the new variant for the field-level checks.
    expect(result).toMatchObject({ kind: 'web_self_binding_success' });
    if ('kind' in result && result.kind === 'web_self_binding_success') {
      const webResult = result as {
        kind: 'web_self_binding_success'; token: string; userId: string;
        orgId: string; connectionId: string; externalId: string;
      };
      expect(webResult.userId).toBe('u-current');
      expect(webResult.orgId).toBe('o1');
      expect(webResult.connectionId).toBe('c1');
      expect(webResult.externalId).toBe('ext-alice');
      // Token non-empty: the brief's web_self_binding_success MUST carry
      // a usable JWT (the bind-callback HTML sets sessionStorage from it).
      expect(typeof webResult.token).toBe('string');
      expect(webResult.token.length).toBeGreaterThan(0);
    } else {
      // Make the failure explicit if the narrowing ever fails to enter the
      // block above — the shape match alone would otherwise pass silently.
      throw new Error(`expected kind=web_self_binding_success, got ${JSON.stringify(result)}`);
    }

    // u-current row still has the binding (overwrite, same row).
    const uc = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u-current'`,
    );
    expect(uc.rows[0]).toEqual({ sso_connection_id: 'c1', sso_external_id: 'ext-alice' });

    // Audit row with the success action (NOT sso_user_self_bound_denied).
    const audit = await testPool.query<{ action: string; payload: unknown }>(
      `SELECT action, payload FROM audit_events
        WHERE user_id='u-current' ORDER BY ts DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe('sso_user_self_bound');
    expect(audit.rows[0]?.payload).toMatchObject({
      source: 'self_binding',
      ssoConnectionId: 'c1',
      externalId: 'ext-alice',
    });
  });

  test('overwrite for returnTarget=console preserves the legacy { token } shape (web variant is opt-in)', async () => {
    await testPool.query(
      `UPDATE users SET sso_connection_id='c1', sso_external_id='ext-alice' WHERE id='u-current'`,
    );

    const consumed = await parkCtx('u-current', 'console');

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: 'ext-alice', email: 'a@x.com' }), { status: 200 }),
      );

    const result = await finishSsoCallback({ code: 'CODE', state: consumed, redirectUri: 'http://test/cb' });
    // The new variant is gated on returnTarget === 'web'. Console keeps the
    // legacy shape so the existing /auth/sso/callback render path is
    // untouched (no regression for callers that read `result.token`).
    expect(result).toEqual({ token: expect.any(String) } as { token: string });
    expect('kind' in result).toBe(false);
  });
});