import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelCatalog } from '../../src/models/modelCatalog';
import { seedBuiltinProviders } from '../../src/org/builtinProviders';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

/**
 * Coexistence of a built-in provider and a custom provider of the SAME vendor.
 *
 * `provider_keys` already allows this: the unique index is partial
 * (`UNIQUE (org_id, provider) WHERE is_builtin`), so a custom `deepseek` key
 * can sit next to the seeded built-in `deepseek` key. But `model_catalog`'s
 * `UNIQUE (org_id, provider, model)` does NOT: it is key-agnostic, so a custom
 * `deepseek` model with the same upstream name as a built-in row (e.g.
 * `deepseek-v4-pro`) collides and can't be added — the two providers can't both
 * offer the same model, which violates "各自都能独立提供服务,互相不干扰".
 *
 * The constraint must be scoped per provider key so the same-named model is
 * keyed to each provider independently.
 */
describe('builtin + custom provider coexistence (same vendor)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1', 'o1', 'u', 'x')`,
    );
    await seedBuiltinProviders('o1');
  });

  test('both builtin and custom deepseek provider keys can exist for one org', async () => {
    // Custom deepseek key, same provider slug as the built-in.
    await providerKeyVault.add({
      orgId: 'o1',
      provider: 'deepseek',
      plaintextKey: 'sk-custom',
      label: 'my deepseek',
      createdBy: 'u1',
    });
    const rows = await testPool.query<{ is_builtin: boolean }>(
      `SELECT is_builtin FROM provider_keys WHERE org_id = 'o1' AND provider = 'deepseek' ORDER BY is_builtin DESC`,
    );
    // Built-in (seeded) + custom = two independent rows.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.is_builtin).sort()).toEqual([false, true]);
  });

  test('a custom deepseek model with the same name as a builtin model can be added alongside it', async () => {
    // Built-in deepseek seeds deepseek-v4-pro (id builtin:o1:deepseek:deepseek-v4-pro).
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'deepseek',
      plaintextKey: 'sk-custom',
      label: 'my deepseek',
      createdBy: 'u1',
    });
    // Same upstream model name, bound to the CUSTOM provider key.
    const { id: customModelId } = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });

    // Two distinct model rows for the same (org, provider, model): one per key.
    const rows = await testPool.query<{
      id: string;
      provider_key_id: string;
    }>(
      `SELECT id, provider_key_id FROM model_catalog
       WHERE org_id = 'o1' AND provider = 'deepseek' AND model = 'deepseek-v4-pro'
       ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    const ids = rows.rows.map((r) => r.id).sort();
    expect(ids).toEqual(
      [customModelId, 'builtin:o1:deepseek:deepseek-v4-pro'].sort(),
    );
    // Each row is keyed to its own provider_key (builtin row → builtin key).
    const byId = new Map(rows.rows.map((r) => [r.id, r.provider_key_id]));
    expect(byId.get(customModelId)).toBe(k.id);
    expect(byId.get('builtin:o1:deepseek:deepseek-v4-pro')).toBe('builtin:o1:deepseek');
  });

  test('the same-named model within one provider key is still rejected as a duplicate', async () => {
    // The coexistence relaxation must not weaken the real duplicate guard:
    // adding the same model twice to the SAME custom key is still a duplicate.
    // Uses a name the builtin deepseek does NOT seed, so the only collision is
    // the within-key duplicate (caught by the app-level model_duplicate check)
    // rather than the cross-key coexistence the previous test exercises.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'deepseek',
      plaintextKey: 'sk-custom',
      label: 'my deepseek',
      createdBy: 'u1',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'deepseek',
      model: 'deepseek-custom-only',
    });
    await expect(
      modelCatalog.add({
        orgId: 'o1',
        providerKeyId: k.id,
        provider: 'deepseek',
        model: 'deepseek-custom-only',
      }),
    ).rejects.toThrow('model_duplicate');
  });

  // The admin console scopes a provider's models by provider slug (`deepseek`),
  // but two keys can share a slug. Without the provider_key_id on the admin
  // list the console can't tell a built-in deepseek row from a custom one, so
  // it merges them into one duplicated list (the reported "模型列表都一模一样").
  // listForAdmin must expose provider_key_id so the UI can group by KEY, not slug.
  test('listForAdmin exposes provider_key_id so same-slug keys are distinguishable', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'deepseek',
      plaintextKey: 'sk-custom',
      label: 'my deepseek',
      createdBy: 'u1',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });

    const list = await modelCatalog.listForAdmin('o1');
    const pro = list.filter((m) => m.model === 'deepseek-v4-pro');
    // Two rows for the same (org, provider, model): one per key.
    expect(pro).toHaveLength(2);
    // Every row must carry the key it belongs to.
    const keyIds = pro.map((m) => m.provider_key_id).sort();
    expect(keyIds).toEqual([k.id, 'builtin:o1:deepseek'].sort());
    // The custom row is keyed to the custom key, not the builtin.
    const customRow = pro.find((m) => m.provider_key_id === k.id);
    expect(customRow).toBeDefined();
    expect(customRow?.provider).toBe('deepseek');
  });

  test('user-facing list() still hides provider_key_id (trust boundary unchanged)', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'deepseek',
      plaintextKey: 'sk-custom',
      label: 'my deepseek',
      createdBy: 'u1',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'deepseek',
      model: 'deepseek-custom-only',
    });
    const list = await modelCatalog.list('o1');
    for (const m of list) {
      expect(m).not.toHaveProperty('provider_key_id');
    }
  });
});
