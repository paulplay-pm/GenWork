import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { BUILTIN_PROVIDERS, seedBuiltinProviders, seedBuiltinProvidersForAllOrgs } from '../../src/org/builtinProviders';

describe('builtin provider seed', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A'), ('o2','B')`);
  });

  test('exposes exactly 9 built-in providers', () => {
    expect(BUILTIN_PROVIDERS).toHaveLength(9);
    expect(BUILTIN_PROVIDERS.map((p) => p.slug).sort()).toEqual(
      ['anthropic', 'deepseek', 'minimax', 'moonshot', 'openai', 'qwen', 'volc', 'xiaomi', 'zhipu'].sort(),
    );
  });

  test('seeds the PRD-matched OpenAI-compatible Base URLs', () => {
    // The seeded (default OpenAI-protocol) endpoints match the reference UI /
    // PRD §provider table. Pins the domain/path fixes (MiniMax → minimaxi.com,
    // Qwen → /compatible-mode/v1, Xiaomi → full /v1/chat/completions path).
    const bySlug = Object.fromEntries(BUILTIN_PROVIDERS.map((p) => [p.slug, p.endpoint]));
    expect(bySlug.deepseek).toBe('https://api.deepseek.com');
    expect(bySlug.moonshot).toBe('https://api.moonshot.cn/v1');
    expect(bySlug.qwen).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(bySlug.zhipu).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(bySlug.minimax).toBe('https://api.minimaxi.com/v1');
    expect(bySlug.xiaomi).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(bySlug.volc).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });

  test('seeds 9 builtins + their models for an org, idempotently', async () => {
    await seedBuiltinProviders('o1');
    await seedBuiltinProviders('o1'); // re-seed must be a no-op
    const pk = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_keys WHERE org_id='o1' AND is_builtin`,
    );
    expect(pk.rows[0].n).toBe(9);
    const mc = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM model_catalog WHERE org_id='o1'`,
    );
    const expectedModels = BUILTIN_PROVIDERS.reduce((s, p) => s + p.models.length, 0);
    expect(mc.rows[0].n).toBe(expectedModels);
    // A seeded builtin has no key and no creator, and starts DISABLED (a
    // keyless provider cannot authenticate; the operator adds a key + enables).
    const oai = await testPool.query<{
      api_key_encrypted: string | null;
      created_by: string | null;
      enabled: boolean;
    }>(
      `SELECT api_key_encrypted, created_by, enabled FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    );
    expect(oai.rows[0].api_key_encrypted).toBeNull();
    expect(oai.rows[0].created_by).toBeNull();
    expect(oai.rows[0].enabled).toBe(false);
    // Seeded models carry a types array and a legal legacy type.
    const m = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE org_id='o1' AND model='gpt-4o'`,
    );
    expect(m.rows[0].types).toEqual(['chat', 'vision']);
    expect(m.rows[0].type).toBe('chat');
  });

  test('backfills all orgs', async () => {
    await seedBuiltinProvidersForAllOrgs();
    for (const o of ['o1', 'o2']) {
      const pk = await testPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM provider_keys WHERE org_id='${o}' AND is_builtin`,
      );
      expect(pk.rows[0].n).toBe(9);
    }
  });
});
