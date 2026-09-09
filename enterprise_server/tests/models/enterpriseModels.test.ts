import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { enterpriseModels } from '../../src/models/enterpriseModels';
import { modelCatalog } from '../../src/models/modelCatalog';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

describe('models/enterpriseModels', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`,
    );
  });

  test('empty org returns []', async () => {
    const list = await enterpriseModels.listEnabledForOrg('o1');
    expect(list).toEqual([]);
  });

  test('multi-row returns all with correct shape, sorted by model', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      endpoint: 'https://api.openai.com/v1',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      displayName: 'GPT-4o',
      quotaPerDay: 100,
      // types drives the synthesized booleans; the column here is a legacy
      // leftover and the synthesis deliberately ignores it.
      types: ['chat', 'vision'],
      capabilities: {
        supports_image: false,
        supports_thinking: false,
        context_window: 128000,
        max_tokens: 8192,
      },
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'o1-mini',
      types: ['chat', 'reasoning'],
      capabilities: { supports_image: false, supports_thinking: false },
    });
    const list = await enterpriseModels.listEnabledForOrg('o1');
    expect(list).toHaveLength(2);
    expect(list.map(m => m.model).sort()).toEqual(['gpt-4o', 'o1-mini']);
    const gpt = list.find(m => m.model === 'gpt-4o')!;
    expect(gpt.displayName).toBe('GPT-4o');
    expect(gpt.endpoint).toBe('https://api.openai.com/v1');
    expect(gpt.quotaPerDay).toBe(100);
    expect(gpt.capabilities.supports_image).toBe(true);
    expect(gpt.capabilities.context_window).toBe(128000);
    expect(gpt.capabilities.max_tokens).toBe(8192);
    expect(gpt.capabilities.supports_video).toBe(false);
    expect(gpt.capabilities.supports_thinking).toBe(false);
    expect(gpt).not.toHaveProperty('provider_key_id');
  });

  test('disabled catalog row excluded', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    await modelCatalog.setEnabled(m.id, false);
    const list = await enterpriseModels.listEnabledForOrg('o1');
    expect(list).toEqual([]);
  });

  test('disabled provider key excluded', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    await providerKeyVault.setEnabled(k.id, false);
    const list = await enterpriseModels.listEnabledForOrg('o1');
    expect(list).toEqual([]);
  });

  test('policy-disabled model excluded', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    await modelCatalog.setModelDisabled('o1', m.id, true, 'root');
    const list = await enterpriseModels.listEnabledForOrg('o1');
    expect(list).toEqual([]);
  });

  test('cross-org isolation: other-org models not returned', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const list = await enterpriseModels.listEnabledForOrg('o2');
    expect(list).toEqual([]);
  });

  test('types[] includes vision synthesizes supports_image=true even when column is false', async () => {
    // The admin UI expresses vision capability via the `types` chip grid
    // (not via the `supports_image` column). The desktop reads `supports_image`,
    // so without synthesis the desktop shows vision as disabled for every
    // model whose vision was enabled through the chip. The server must OR
    // the column with the 'vision' membership so both admin paths reach the
    // desktop as a single truth.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'm3',
      types: ['chat', 'vision'],
      capabilities: { supports_image: false, supports_thinking: false },
    });
    const list = await enterpriseModels.listEnabledForOrg('o1');
    const row = list.find(m => m.model === 'm3')!;
    expect(row.capabilities.supports_image).toBe(true);
    expect(row.capabilities.supports_thinking).toBe(false);
  });

  test('types[] includes reasoning synthesizes supports_thinking=true even when column is false', async () => {
    // Same rationale as the vision test above, for the reasoning chip.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'r1',
      types: ['chat', 'reasoning'],
      capabilities: { supports_image: false, supports_thinking: false },
    });
    const list = await enterpriseModels.listEnabledForOrg('o1');
    const row = list.find(m => m.model === 'r1')!;
    expect(row.capabilities.supports_thinking).toBe(true);
    expect(row.capabilities.supports_image).toBe(false);
  });

  test('types[] without vision/reasoning makes the chip the source of truth (column ignored)', async () => {
    // The chip is the only thing the admin UI edits; the supports_image
    // column is legacy and not editable from the drawer. When the chip
    // is off, the read path must report vision as disabled even if the
    // column is true. This guards against the "remove chip but desktop
    // still shows 可读图" desync.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      types: ['chat'],
      capabilities: { supports_image: true, supports_thinking: false },
    });
    const list = await enterpriseModels.listEnabledForOrg('o1');
    const row = list.find(m => m.model === 'gpt-4o')!;
    expect(row.capabilities.supports_image).toBe(false);
    expect(row.capabilities.supports_thinking).toBe(false);
  });

  test('types[] without reasoning makes the chip the source of truth (column ignored)', async () => {
    // Same as above for the reasoning chip. Belt-and-suspenders: the previous
    // test already covers vision; this one pins the reasoning side so a
    // future asymmetric change can't slip through.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'o1-mini',
      types: ['chat'],
      capabilities: { supports_image: false, supports_thinking: true },
    });
    const list = await enterpriseModels.listEnabledForOrg('o1');
    const row = list.find(m => m.model === 'o1-mini')!;
    expect(row.capabilities.supports_thinking).toBe(false);
  });

  test('decryptKeysForOrg returns decrypted keys for enabled models', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-SECRET-1',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const keys = await enterpriseModels.decryptKeysForOrg('o1');
    expect(keys.size).toBe(1);
    expect(keys.get(m.id)).toBe('sk-SECRET-1');
  });

  test('decryptKeysForOrg skips rows where decrypt fails', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-good',
      createdBy: 'root',
    });
    const m1 = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const m2 = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    // Force the catch branch for m2 only: stub getDecrypted to throw when
    // called with m2's provider_key_id, return the real plaintext otherwise.
    const realGet = providerKeyVault.getDecrypted.bind(providerKeyVault);
    vi.spyOn(providerKeyVault, 'getDecrypted').mockImplementation(async (id: string) => {
      // Both models share one provider_key in this test, so we can't key off
      // id. Instead, count calls and fail on the second one to simulate
      // "second model row's key fails to decrypt".
      const calls = (providerKeyVault.getDecrypted as unknown as { mock: { calls: unknown[] } })
        .mock.calls.length;
      if (calls === 2) throw new Error('simulated decrypt failure');
      return realGet(id);
    });

    const keys = await enterpriseModels.decryptKeysForOrg('o1');
    expect(keys.has(m1.id)).toBe(true);
    expect(keys.has(m2.id)).toBe(false);
    expect(keys.size).toBe(1);
  });

  test('decryptKeysForOrg returns empty map for org with no models', async () => {
    const keys = await enterpriseModels.decryptKeysForOrg('o1');
    expect(keys.size).toBe(0);
  });
});
