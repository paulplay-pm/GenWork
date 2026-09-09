import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { providerKeyVault, maskKey } from '../../src/vault/providerKeyVault';

describe('providerKeyVault', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'A')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`
    );
  });

  test('maskKey keeps first3 + last4 and masks the middle', () => {
    const m = maskKey('sk-abcdef1234567890xyz999');
    expect(m.startsWith('sk-')).toBe(true);
    expect(m.endsWith('z999')).toBe(true);
    expect(m).toContain('•');
    expect(maskKey('short')).toBe('••••');
  });

  test('add writes a populated api_key_masked', async () => {
    await providerKeyVault.add({ orgId: 'o1', provider: 'custom-x', plaintextKey: 'sk-abcdef1234567890xyz999', endpoint: 'https://e.example/v1' });
    const row = await testPool.query<{ api_key_masked: string | null }>(
      `SELECT api_key_masked FROM provider_keys WHERE org_id='o1' AND provider='custom-x'`,
    );
    expect(row.rows[0].api_key_masked).toContain('•');
    expect(row.rows[0].api_key_masked).toBe(maskKey('sk-abcdef1234567890xyz999'));
  });

  test('add: a keyless provider starts disabled; a keyed one starts enabled', async () => {
    // Keyless → disabled (a keyless provider can't authenticate and must be
    // enabled by the operator once a key is set).
    await providerKeyVault.add({ orgId: 'o1', provider: 'keyless-x', endpoint: 'https://e.example/v1' });
    const keyless = await testPool.query<{ enabled: boolean }>(
      `SELECT enabled FROM provider_keys WHERE org_id='o1' AND provider='keyless-x'`,
    );
    expect(keyless.rows[0].enabled).toBe(false);

    // Keyed → enabled (the default "has a key" shortcut).
    await providerKeyVault.add({ orgId: 'o1', provider: 'keyed-x', plaintextKey: 'sk-real' });
    const keyed = await testPool.query<{ enabled: boolean }>(
      `SELECT enabled FROM provider_keys WHERE org_id='o1' AND provider='keyed-x'`,
    );
    expect(keyed.rows[0].enabled).toBe(true);
  });

  test('coding_plan round-trips: add defaults off, patch flips it, list echoes it', async () => {
    // Off by default (no coding plan).
    const { id } = await providerKeyVault.add({ orgId: 'o1', provider: 'cp-x', plaintextKey: 'sk-x' });
    const off = await testPool.query<{ coding_plan: boolean }>(
      `SELECT coding_plan FROM provider_keys WHERE id=$1`, [id]);
    expect(off.rows[0].coding_plan).toBe(false);
    expect((await providerKeyVault.list('o1')).find((r) => r.id === id)?.coding_plan).toBe(false);

    // Patch on → persists + echoed.
    await providerKeyVault.patch(id, { codingPlan: true });
    const on = await testPool.query<{ coding_plan: boolean }>(
      `SELECT coding_plan FROM provider_keys WHERE id=$1`, [id]);
    expect(on.rows[0].coding_plan).toBe(true);
    expect((await providerKeyVault.list('o1')).find((r) => r.id === id)?.coding_plan).toBe(true);
  });

  test('list lazy-derives a mask when stored mask is NULL (legacy row)', async () => {
    // Insert a legacy row with an encrypted key but NULL mask.
    const { encrypt } = await import('../../src/vault/crypto');
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, api_key_encrypted, is_builtin)
       VALUES ('lg','o1','openai', $1, true)`,
      [encrypt('sk-legacy-secret-000')],
    );
    const list = await providerKeyVault.list('o1');
    const lg = list.find((r) => r.id === 'lg');
    expect(lg?.api_key_masked).toBe(maskKey('sk-legacy-secret-000'));
  });

  test('setApiKey re-encrypts and refreshes the mask', async () => {
    const { id } = await providerKeyVault.add({ orgId: 'o1', provider: 'c1', plaintextKey: 'sk-first' });
    await providerKeyVault.setApiKey(id, 'sk-second-new-key');
    const row = await testPool.query<{ api_key_masked: string | null }>(
      `SELECT api_key_masked FROM provider_keys WHERE id=$1`, [id]);
    expect(row.rows[0].api_key_masked).toBe(maskKey('sk-second-new-key'));
  });

  test('getRow exposes protocol', async () => {
    const { id } = await providerKeyVault.add({ orgId: 'o1', provider: 'c2', plaintextKey: 'sk-x', protocol: 'anthropic' });
    const row = await providerKeyVault.getRow(id);
    expect(row?.protocol).toBe('anthropic');
  });

  test('add 加密后 list 不含明文', async () => {
    const { id } = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-secret-1',
      label: 'prod',
      createdBy: 'root',
    });
    const list = await providerKeyVault.list('o1');
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('api_key_encrypted');
    expect(list[0].id).toBe(id);
  });

  test('getDecrypted 拿到原始 key', async () => {
    const { id } = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-secret-2',
      label: 'p',
      createdBy: 'root',
    });
    expect(await providerKeyVault.getDecrypted(id)).toBe('sk-secret-2');
  });

  test('setEnabled(false) 后 getDecrypted 抛错', async () => {
    const { id } = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await providerKeyVault.setEnabled(id, false);
    await expect(providerKeyVault.getDecrypted(id)).rejects.toThrow(/disabled/i);
  });
});
