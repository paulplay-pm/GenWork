import '../helpers/setupEnv';

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { kitCatalog } from '../../src/models/kitCatalog';

async function org(): Promise<string> {
  const id = `org-${randomUUID().slice(0, 8)}`;
  const r = await testPool.query('INSERT INTO orgs(id, name) VALUES ($1,$2) RETURNING id', [id, id]);
  return r.rows[0].id as string;
}
const scope = () => ({ allCompany: true, deptIds: [], userIds: [] });
const zip = { size: 10, sha256: 'x', fileName: 'a.zip' };

describe('kitCatalog service', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('add rejects duplicate slug with a sentinel error', async () => {
    const orgId = await org();
    await kitCatalog.add(orgId, { slug: 'engineering', scope: scope(), zip }, 'tester');
    await expect(
      kitCatalog.add(orgId, { slug: 'engineering', scope: scope(), zip }, 'tester'),
    ).rejects.toThrow('kit_duplicate');
  });

  test('list hides disabled kits; listForAdmin includes them', async () => {
    const orgId = await org();
    await kitCatalog.add(orgId, { slug: 'a', scope: scope(), zip }, 't');
    await kitCatalog.add(orgId, { slug: 'b', scope: scope(), zip }, 't');
    await kitCatalog.setEnabled(orgId, 'b', false, 't');
    expect((await kitCatalog.list(orgId)).map((k) => k.slug)).toEqual(['a']);
    expect((await kitCatalog.listForAdmin(orgId)).map((k) => k.slug).sort()).toEqual(['a', 'b']);
  });

  test('is org-scoped: another org sees nothing', async () => {
    const o1 = await org(); const o2 = await org();
    await kitCatalog.add(o1, { slug: 'a', scope: scope(), zip }, 't');
    expect((await kitCatalog.list(o2)).length).toBe(0);
    expect((await kitCatalog.listForAdmin(o2)).length).toBe(0);
  });
});
