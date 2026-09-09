import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS = join(__dirname, '../../src/db/migrations');

/** Execute one migration file through the same single-statement path production uses. */
async function applyMigrationFile(file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  for (const stmt of splitStatements(sql)) {
    await testPool.query(stmt);
  }
}

/**
 * Simulates a pre-v2-remap production DB: run the full migration chain first
 * (orgs empty, so 030 is a no-op), then seed legacy data as if it existed
 * before 029/030 ran, and re-execute 029 + 030 onto it.
 */
async function seedLegacyAndRemap(): Promise<void> {
  await resetSchema();
  await runMigrations();

  // Legacy org + department tree + users (old-style: no ROOT dept,
  // top-level dept with un-prefixed paths, unknown role names in extra_roles).
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','Acme')`);
  await testPool.query(`INSERT INTO departments(id,org_id,name,parent_id,path) VALUES
    ('d1','o1','Eng',NULL,'/Eng'),
    ('d2','o1','TeamA','d1','/Eng/TeamA')`);
  await testPool.query(`INSERT INTO users(id,org_id,username,password_hash,department_id,extra_roles) VALUES
    ('u1','o1','alice','hash1','d1','["ghost","member"]'::jsonb),
    ('u2','o1','bob','hash2','d1','["model_admin","ghost2"]'::jsonb),
    ('u3','o1','carol','hash3',NULL,'[]'::jsonb)`);

  await applyMigrationFile('029_seed_roles_v2.sql');
  await applyMigrationFile('030_org_v2_remap.sql');
}

/** Order-insensitive view of a jsonb role array (jsonb_agg(DISTINCT …) order is nondeterministic). */
function sortRoles(roles: string[] | null): string[] {
  return [...(roles ?? [])].sort();
}

interface RemapState {
  rootIds: string[];
  depts: { id: string; parent_id: string | null; path: string }[];
  userDepartments: { user_id: string; dept_id: string; is_primary: boolean }[];
  extraRoles: [string, string[]][];
}

async function captureRemapState(): Promise<RemapState> {
  const root = await testPool.query<{ id: string }>(
    `SELECT id FROM departments WHERE org_id='o1' AND code='ROOT'`);
  const depts = await testPool.query<{ id: string; parent_id: string | null; path: string }>(
    `SELECT id, parent_id, path FROM departments WHERE org_id='o1' ORDER BY id`);
  const userDepartments = await testPool.query<{ user_id: string; dept_id: string; is_primary: boolean }>(
    `SELECT user_id, dept_id, is_primary FROM user_departments ORDER BY user_id`);
  const users = await testPool.query<{ user_id: string; extra_roles: string[] }>(
    `SELECT id AS user_id, extra_roles FROM users ORDER BY id`);
  return {
    rootIds: root.rows.map((r) => r.id),
    depts: depts.rows,
    userDepartments: userDepartments.rows,
    extraRoles: users.rows.map((r) => [r.user_id, sortRoles(r.extra_roles)] as [string, string[]]),
  };
}

describe('migration 030 — legacy remap on pre-existing data', () => {
  test('creates ROOT, re-parents + rewrites paths, backfills user_departments, remaps extra_roles', async () => {
    await seedLegacyAndRemap();

    // Exactly one ROOT dept per org, anchored at the top level.
    const root = await testPool.query<{ id: string; name: string; path: string; parent_id: string | null }>(
      `SELECT id, name, path, parent_id FROM departments WHERE org_id='o1' AND code='ROOT'`);
    expect(root.rows).toHaveLength(1);
    expect(root.rows[0].parent_id).toBeNull();
    expect(root.rows[0].path).toBe('/Acme');

    // Top-level dept re-parented under ROOT with rewritten path.
    const d1 = await testPool.query<{ parent_id: string; path: string }>(
      `SELECT parent_id, path FROM departments WHERE id='d1'`);
    expect(d1.rows[0].parent_id).toBe(root.rows[0].id);
    expect(d1.rows[0].path.startsWith('/Acme/')).toBe(true);
    expect(d1.rows[0].path).toBe('/Acme/Eng');

    // Descendant path rewritten with the ROOT prefix.
    const d2 = await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id='d2'`);
    expect(d2.rows[0].path).toBe('/Acme/Eng/TeamA');

    // user_departments backfilled from department_id (primary); NULL dept excluded.
    const userDepartments = await testPool.query<{ user_id: string; dept_id: string; is_primary: boolean }>(
      `SELECT user_id, dept_id, is_primary FROM user_departments ORDER BY user_id`);
    expect(userDepartments.rows).toEqual([
      { user_id: 'u1', dept_id: 'd1', is_primary: true },
      { user_id: 'u2', dept_id: 'd1', is_primary: true },
    ]);

    // extra_roles: unknown -> 'member' (fail-closed), known preserved, de-duped.
    const u1 = await testPool.query<{ extra_roles: string[] }>(`SELECT extra_roles FROM users WHERE id='u1'`);
    expect(sortRoles(u1.rows[0].extra_roles)).toEqual(['member']);

    const u2 = await testPool.query<{ extra_roles: string[] }>(`SELECT extra_roles FROM users WHERE id='u2'`);
    expect(sortRoles(u2.rows[0].extra_roles)).toEqual(['member', 'model_admin']);

    // NOT NULL trap: an empty array must stay '[]', never NULL.
    const u3 = await testPool.query<{ extra_roles: string[] | null }>(`SELECT extra_roles FROM users WHERE id='u3'`);
    expect(u3.rows[0].extra_roles).not.toBeNull();
    expect(u3.rows[0].extra_roles).toEqual([]);

    // Built-ins seeded exactly once.
    const builtins = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM roles WHERE is_builtin=true`);
    expect(builtins.rows[0].n).toBe(6);
  });

  test('remap is idempotent on pre-existing data (second apply changes nothing)', async () => {
    await seedLegacyAndRemap();
    const before = await captureRemapState();

    // Re-execute 029 + 030 a second time, exactly as a re-apply would.
    await applyMigrationFile('029_seed_roles_v2.sql');
    await applyMigrationFile('030_org_v2_remap.sql');

    const after = await captureRemapState();
    // ROOT count stable, paths unchanged (no double-prefix /Acme/Acme/...),
    // user_departments stable, extra_roles unchanged.
    expect(after).toEqual(before);
    expect(after.rootIds).toHaveLength(1);
    const d1 = after.depts.find((d) => d.id === 'd1')!;
    expect(d1.path).toBe('/Acme/Eng');
    const d2 = after.depts.find((d) => d.id === 'd2')!;
    expect(d2.path).toBe('/Acme/Eng/TeamA');
  });
});
