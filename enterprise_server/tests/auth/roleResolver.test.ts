import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { roleResolver } from '../../src/auth/roleResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleService } from '../../src/org/roleService';

describe('roleResolver', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('unions fine points across multiple roles', async () => {
    const pts = await roleResolver.pointsFor(['org_admin', 'auditor']);
    expect(pts.has('user:view')).toBe(true);      // from org_admin
    expect(pts.has('audit:view')).toBe(true);     // from auditor
    expect(pts.has('model:view')).toBe(false);    // neither org_admin nor auditor
  });

  test('legacy admin alias resolves to org_admin points', async () => {
    const pts = await roleResolver.pointsFor(['admin']);
    expect(pts.has('role:view')).toBe(true);
    expect(pts.has('model:view')).toBe(false);
  });

  test('unknown role names contribute nothing (fail-closed)', async () => {
    const pts = await roleResolver.pointsFor(['ghost']);
    expect(pts.size).toBe(0);
  });

  test('invalidate() picks up a role edit live', async () => {
    expect((await roleResolver.pointsFor(['viewer'])).has('audit:view')).toBe(false);
    const { id } = await roleService.create({ name: 'viewer', permissions: [] });
    await roleService.update(id, { permissions: ['audit:view'] });
    roleResolver.invalidate();
    expect((await roleResolver.pointsFor(['viewer'])).has('audit:view')).toBe(true);
  });

  test('policy_admin grants the skill + role-view points the skill admin page needs', async () => {
    const pts = await roleResolver.pointsFor(['policy_admin']);
    expect(pts.has('skill:view')).toBe(true);
    expect(pts.has('role:view')).toBe(true);
  });
});
