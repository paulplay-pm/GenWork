import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, testPool, runMigrations } from '../../src/db/testDb';
import { providerKeyVault } from '../../src/vault/providerKeyVault';
import { modelCatalog } from '../../src/models/modelCatalog';
import { tokenUsage } from '../../src/models/tokenUsage';

describe('models/modelCatalog + tokenUsage', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`
    );
  });

  test('list 不返回 provider_key_id', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      displayName: 'GPT-4o',
      quotaPerDay: 100000,
    });
    const list = await modelCatalog.list('o1');
    expect(list[0]).not.toHaveProperty('provider_key_id');
    expect(list[0].model).toBe('gpt-4o');
    expect(list[0].quota_per_user_per_day).toBe(100000);
  });

  test('tokenUsage.write + usageInWindow 按日聚合', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1', 'o1', 'a', 'x')`
    );
    await tokenUsage.write({
      orgId: 'o1',
      userId: 'u1',
      modelId: m.id,
      provider: 'openai',
      tokenIn: 100,
      tokenOut: 50,
      resultCode: 200,
      durationMs: 1000,
    });
    const today = new Date().toISOString().slice(0, 10);
    const used = await tokenUsage.usageInWindow('u1', m.id, today);
    expect(used).toBe(150);
  });

  test('getById 返回 quota_per_user_per_day', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      quotaPerDay: 5000,
    });
    const row = await modelCatalog.getById(m.id);
    expect(row?.quota_per_user_per_day).toBe(5000);
  });

  test('list 排除被管理员 policy 禁用的模型', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
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
    // 管理员禁用 gpt-4o（写 model_policies.disabled=true）
    await modelCatalog.setModelDisabled('o1', m.id, true, 'root');

    const list = await modelCatalog.list('o1');
    const names = list.map((x) => x.model);
    expect(names).not.toContain('gpt-4o');
    expect(names).toContain('gpt-4o-mini');
    // 未禁用模型的 flag 为 false
    expect(list.find((x) => x.model === 'gpt-4o-mini')?.disabled_by_admin).toBe(false);
  });

  test('listForAdmin 保留被禁用的模型并标记 disabled_by_admin', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    await modelCatalog.setModelDisabled('o1', m.id, true, 'root');

    const all = await modelCatalog.listForAdmin('o1');
    expect(all.find((x) => x.model === 'gpt-4o')?.disabled_by_admin).toBe(true);

    // 重新启用后 flag 归零
    await modelCatalog.setModelDisabled('o1', m.id, false, 'root');
    const after = await modelCatalog.listForAdmin('o1');
    expect(after.find((x) => x.model === 'gpt-4o')?.disabled_by_admin).toBe(false);
  });

  test('listForAdmin ordering is stable across enabled toggles (no row reordering)', async () => {
    // The admin enable/disable switch flips `c.enabled`. If `listForAdmin`
    // sorted by `enabled`, a refetch after a toggle would re-sort the whole
    // list and every row would physically jump — the UI symptom was a toggle
    // that "looks like" it hit the wrong checkbox. The order must therefore be
    // independent of `enabled`: seed two models, flip one, and the relative
    // order (by model name) must not change.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'root',
    });
    const aaa = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'aaa-model',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'zzz-model',
    });

    const before = (await modelCatalog.listForAdmin('o1')).map((x) => x.model);
    expect(before).toEqual(['aaa-model', 'zzz-model']);

    // Disable the alphabetically-first model: with an `enabled`-keyed sort it
    // would drop below 'zzz-model'; a stable order keeps it in place.
    await modelCatalog.patch('o1', aaa.id, { enabled: false });
    const after = (await modelCatalog.listForAdmin('o1')).map((x) => x.model);
    // Order is unchanged (stable by model name, independent of `enabled`).
    expect(after).toEqual(['aaa-model', 'zzz-model']);
    // The toggle itself still applied — the flag just no longer drives order.
    const toggled = (await modelCatalog.listForAdmin('o1')).find(
      (x) => x.model === 'aaa-model',
    );
    expect(toggled?.enabled).toBe(false);
  });

  test('upsertMany inserts new models and skips existing', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk',
      createdBy: 'root',
    });
    const first = await modelCatalog.upsertMany({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      modelIds: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
    });
    expect(first.added).toBe(3);
    expect(first.unchanged).toBe(0);
    expect(first.addedIds).toHaveLength(3);

    // Second call with overlap: 1 unchanged + 2 new
    const second = await modelCatalog.upsertMany({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      modelIds: ['gpt-4o', 'o1-mini', 'gpt-4-turbo', 'o1-preview'],
    });
    expect(second.added).toBe(2);
    expect(second.unchanged).toBe(2);
  });

  test('upsertMany preserves existing capabilities / quota on conflict', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk',
      createdBy: 'root',
    });
    // Seed a model with a custom quota + image support, then disable it.
    const created = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      quotaPerDay: 1000,
      capabilities: { supports_image: true, context_window: 8000 },
    });
    await modelCatalog.setModelDisabled('o1', created.id, true, 'root');

    // Re-upsert with the same id — must not overwrite, must not duplicate.
    const r = await modelCatalog.upsertMany({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      modelIds: ['gpt-4o'],
    });
    expect(r.added).toBe(0);
    expect(r.unchanged).toBe(1);

    const row = (await modelCatalog.getById(created.id))!;
    expect(row.quota_per_user_per_day).toBe(1000);
    expect(row.supports_image).toBe(true);
    expect(row.context_window).toBe(8000);
    const admin = await modelCatalog.listForAdmin('o1');
    expect(admin.find((x) => x.id === created.id)?.disabled_by_admin).toBe(true);
  });

  test('upsertMany with empty / deduped input', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk',
      createdBy: 'root',
    });
    const empty = await modelCatalog.upsertMany({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      modelIds: [],
    });
    expect(empty).toEqual({ added: 0, unchanged: 0, addedIds: [] });

    const dedup = await modelCatalog.upsertMany({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      modelIds: ['a', 'a', 'b', 'a', 'b'],
    });
    expect(dedup.added).toBe(2);
    expect(dedup.unchanged).toBe(0);
  });
});