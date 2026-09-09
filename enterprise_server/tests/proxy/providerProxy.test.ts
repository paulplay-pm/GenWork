import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool, type TxClient } from '../../src/db/testDb';
import { modelCatalog } from '../../src/models/modelCatalog';
import { idempotency } from '../../src/proxy/idempotency';
import { providerProxy } from '../../src/proxy/providerProxy';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

describe('proxy/providerProxy', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    idempotency.clear();
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1', 'o1', 'a', 'x')`
    );
  });

  test('JWT 缺失返回 401', async () => {
    const res = await providerProxy.handle(
      'openai',
      { model_id: 'm1', body: {} },
      null
    );
    expect(res.status).toBe(401);
  });

  test('JWT 有效 + 模型被禁用返回 403', async () => {
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
    const res = await providerProxy.handle(
      'openai',
      { model_id: m.id, body: { messages: [] } },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    expect(res.status).toBe(403);
  });

  test('JWT 有效 + 模型可用 + 上游返回 200 → 写 token_usage', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-real',
      label: 'p',
      createdBy: 'root',
      endpoint: 'https://api.openai.com/v1',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const res = await providerProxy.handle(
      'openai',
      { model_id: m.id, body: { messages: [] } },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    expect(res.status).toBe(200);
    const r = await testPool.query<{ token_in: number; token_out: number; result_code: number }>(
      `SELECT token_in, token_out, result_code FROM token_usage WHERE user_id='u1'`
    );
    expect(r.rows[0].token_in).toBe(10);
    expect(r.rows[0].token_out).toBe(20);
    expect(r.rows[0].result_code).toBe(200);
  });

  test('配额超额返回 429 不转发上游', async () => {
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
      quotaPerDay: 100,
    });
    const today = new Date().toISOString().slice(0, 10);
    await testPool.query(
      `INSERT INTO token_usage(org_id, user_id, model_id, provider, token_in, token_out, total_tokens, result_code, quota_window_date)
       VALUES ('o1', 'u1', $1, 'openai', 60, 40, 100, 200, $2)`,
      [m.id, today]
    );

    const res = await providerProxy.handle(
      'openai',
      { model_id: m.id, body: { messages: [] } },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('配额超额的 429 body 携带结构化 reason，供桌面端区分精确文案', async () => {
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
      quotaPerDay: 100,
    });
    const today = new Date().toISOString().slice(0, 10);
    await testPool.query(
      `INSERT INTO token_usage(org_id, user_id, model_id, provider, token_in, token_out, total_tokens, result_code, quota_window_date)
       VALUES ('o1', 'u1', $1, 'openai', 60, 40, 100, 200, $2)`,
      [m.id, today]
    );

    const res = await providerProxy.handle(
      'openai',
      { model_id: m.id, body: { messages: [] } },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    expect(res.status).toBe(429);
    const body = JSON.parse(await res.text()) as {
      error: string;
      reason: string;
    };
    expect(body.error).toBe('quota_exceeded');
    expect(body.reason).toBe('daily_quota_exhausted');
  });

  test('幂等键不重复计数', async () => {
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
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 }
      )
    );

    const headers = { 'idempotency-key': 'idem-1' };
    await providerProxy.handle(
      'openai',
      { model_id: m.id, body: {} },
      { sub: 'u1', orgId: 'o1', roles: [] },
      headers
    );
    await providerProxy.handle(
      'openai',
      { model_id: m.id, body: {} },
      { sub: 'u1', orgId: 'o1', roles: [] },
      headers
    );
    const r = await testPool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_usage WHERE user_id='u1'`
    );
    expect(r.rows[0].c).toBe('1');
  });

  test('跨 org 的 model_id 返回 404', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'O2')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('r2', 'o2', 'r', 'x')`
    );
    const k = await providerKeyVault.add({
      orgId: 'o2',
      provider: 'openai',
      plaintextKey: 'k',
      label: 'p',
      createdBy: 'r2',
    });
    const m = await modelCatalog.add({
      orgId: 'o2',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const res = await providerProxy.handle(
      'openai',
      { model_id: m.id, body: {} },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    expect(res.status).toBe(404);
  });

  // Admin-configured sampling params must be injected into the outbound
  // request (admin-wins), while capability flags / context_window stay out of
  // the wire body.
  test('管理员配置的采样参数注入到上游请求体（admin wins）', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-real',
      label: 'p',
      createdBy: 'root',
      endpoint: 'https://api.openai.com/v1',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'deepseek-flash',
      capabilities: {
        supports_image: true,
        supports_video: true,
        supports_thinking: true,
        context_window: 1111111,
        max_tokens: 2,
        temperature: 0.2,
        top_p: 0.1,
        max_output_tokens: 1,
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const res = await providerProxy.handle(
      'openai',
      // Client already sent its own values — admin values must win.
      { model_id: m.id, body: { model: 'deepseek-flash', temperature: 0.9, top_p: 1, max_tokens: 9999 } },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Admin sampling params applied, overriding the client.
    expect(sent.temperature).toBe(0.2);
    expect(sent.top_p).toBe(0.1);
    expect(sent.max_tokens).toBe(1); // max_output_tokens(1) → max_tokens, overrides client 9999
    // Catalog metadata is NOT written into the request body.
    expect('supports_image' in sent).toBe(false);
    expect('supports_video' in sent).toBe(false);
    expect('supports_thinking' in sent).toBe(false);
    expect('context_window' in sent).toBe(false);
  });

  test('管理员未配置（全 null）时透传客户端原始参数', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-real',
      label: 'p',
      createdBy: 'root',
      endpoint: 'https://api.openai.com/v1',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } } ], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await providerProxy.handle(
      'openai',
      { model_id: m.id, body: { model: 'gpt-4o', temperature: 0.7, max_tokens: 512 } },
      { sub: 'u1', orgId: 'o1', roles: [] }
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.temperature).toBe(0.7);
    expect(sent.max_tokens).toBe(512);
    expect('top_p' in sent).toBe(false);
  });

  // ---- Ruling F1 regression: the quota reservation runs on the REAL pg code
  // path (`_isPg === true`). The original implementation used
  // `SELECT ... SUM(...) ... FOR UPDATE`, which PostgreSQL rejects
  // (error 0A000 feature_not_supported) — that made every quota-gated proxied
  // request 500 on a real database. pglite enforces the identical
  // `FOR UPDATE is not allowed with aggregate functions` restriction, so
  // forcing the isPg path here is a faithful reproduction. These tests would
  // have caught that bug.
  test('isPg 路径：配额内请求成功（advisory lock 代替非法的 FOR UPDATE 聚合）', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-real',
      label: 'p',
      endpoint: 'https://api.openai.com/v1',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      quotaPerDay: 1000,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    // Force the real-pg transaction path by stamping _isPg onto the tx client.
    const realTx = testPool.transaction;
    (testPool as unknown as { transaction: typeof realTx }).transaction = async <T>(
      fn: (tx: TxClient) => Promise<T>
    ) => {
      return realTx(async (tx: TxClient) => {
        tx._isPg = true;
        return fn(tx);
      });
    };
    try {
      const res = await providerProxy.handle(
        'openai',
        { model_id: m.id, body: { messages: [] } },
        { sub: 'u1', orgId: 'o1', roles: [] }
      );
      // Before the fix this threw → 500. Now the advisory-lock path is valid SQL.
      expect(res.status).toBe(200);
    } finally {
      (testPool as unknown as { transaction: typeof realTx }).transaction = realTx;
    }
  });

  test('isPg 路径：配额超额返回 429（非法 FOR UPDATE 修复后仍可拦截）', async () => {
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
      quotaPerDay: 100,
    });
    const today = new Date().toISOString().slice(0, 10);
    await testPool.query(
      `INSERT INTO token_usage(org_id, user_id, model_id, provider, token_in, token_out, total_tokens, result_code, quota_window_date)
       VALUES ('o1', 'u1', $1, 'openai', 60, 40, 100, 200, $2)`,
      [m.id, today]
    );

    const realTx = testPool.transaction;
    (testPool as unknown as { transaction: typeof realTx }).transaction = async <T>(
      fn: (tx: TxClient) => Promise<T>
    ) => {
      return realTx(async (tx: TxClient) => {
        tx._isPg = true;
        return fn(tx);
      });
    };
    try {
      const res = await providerProxy.handle(
        'openai',
        { model_id: m.id, body: { messages: [] } },
        { sub: 'u1', orgId: 'o1', roles: [] }
      );
      expect(res.status).toBe(429);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (testPool as unknown as { transaction: typeof realTx }).transaction = realTx;
    }
  });
});