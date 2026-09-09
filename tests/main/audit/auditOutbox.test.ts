import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/main/auth/enterpriseClient', () => ({
  enterpriseClient: { postAudit: vi.fn() },
}));

import { auditOutbox } from '../../../src/main/audit/auditOutbox';
import { enterpriseClient } from '../../../src/main/auth/enterpriseClient';

interface FakeRow {
  id: number;
  ts: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: string | null;
  delivered: number;
}

interface FakeDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    all(limit?: number): FakeRow[];
  };
}

function makeFakeDb(): FakeDb {
  const rows: FakeRow[] = [];
  let nextId = 1;
  // Two statements share the table; route by SQL keyword.
  return {
    exec() { /* no-op */ },
    prepare(sql: string) {
      const isUpdate = sql.toUpperCase().startsWith('UPDATE');
      const isInsert = sql.toUpperCase().startsWith('INSERT');
      return {
        run(...args: unknown[]): unknown {
          if (isInsert) {
            const row: FakeRow = {
              id: nextId++,
              ts: args[0] as number,
              action: args[1] as string,
              target_type: (args[2] as string | null) ?? null,
              target_id: (args[3] as string | null) ?? null,
              payload: (args[4] as string | null) ?? null,
              delivered: 0,
            };
            rows.push(row);
          } else if (isUpdate) {
            const id = args[0] as number;
            const r = rows.find((r) => r.id === id);
            if (r) r.delivered = 1;
          }
          return undefined;
        },
        all(limit?: number): FakeRow[] {
          return rows.filter((r) => r.delivered === 0).slice(0, limit ?? 50);
        },
      };
    },
  };
}

describe('main/audit/auditOutbox (fake DB)', () => {
  test('push 后 flush 调 postAudit', async () => {
    const db = makeFakeDb();
    auditOutbox.configure(db as unknown as Parameters<typeof auditOutbox.configure>[0]);
    vi.mocked(enterpriseClient.postAudit).mockResolvedValueOnce(undefined);
    auditOutbox.push({ action: 'mcp_call', targetId: 'm1' });
    await auditOutbox.flush();
    expect(enterpriseClient.postAudit).toHaveBeenCalledTimes(1);
  });

  test('flush 失败保留未 delivered 行', async () => {
    const db = makeFakeDb();
    auditOutbox.configure(db as unknown as Parameters<typeof auditOutbox.configure>[0]);
    vi.mocked(enterpriseClient.postAudit).mockReset();
    vi.mocked(enterpriseClient.postAudit).mockImplementation(() => {
      throw new Error('network');
    });
    auditOutbox.push({ action: 'mcp_call' });
    await auditOutbox.flush();
    expect(enterpriseClient.postAudit).toHaveBeenCalledTimes(1);
  });
});