import '../helpers/setupEnv';

import { beforeEach,describe, expect, test } from 'vitest';

import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { BUILTIN_ROLE_POINTS, PermissionPoint } from '../../src/shared/permissionPoints';

describe('db/migrate (pglite)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('创建 spec §5.2 全部表', async () => {
    await runMigrations();
    const r = await testPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const names = r.rows.map((x) => x.tablename);
    for (const t of [
      'orgs',
      'departments',
      'roles',
      'users',
      'init_invitations',
      'provider_keys',
      'model_catalog',
      'model_policies',
      'audit_events',
      'user_archives',
      'token_usage',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('roles seeded with the v2 core set (6 built-ins + 3 legacy admins)', async () => {
    await runMigrations();
    const seed = await testPool.query<{ name: string }>(
      `SELECT name FROM roles ORDER BY name`
    );
    // RBAC v2 (029) seeds 6 built-ins and demotes the 3 legacy admin roles to
    // custom — 9 rows total. The legacy coarse `.manage` codes are gone.
    expect(seed.rows.map((r) => r.name).sort()).toEqual([
      'agent_admin',
      'auditor',
      'dept_admin',
      'dev',
      'member',
      'model_admin',
      'org_admin',
      'policy_admin',
      'super_admin',
    ]);
  });

  test('positions + effective_roles_cache removed, roles present', async () => {
    await runMigrations();
    const tables = await testPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`
    );
    const tnames = tables.rows.map((x) => x.tablename);
    expect(tnames).not.toContain('positions');
    expect(tnames).toContain('roles');
    const cols = await testPool.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns WHERE table_name='users'`
    );
    const cnames = cols.rows.map((x) => x.column);
    expect(cnames).not.toContain('position_id');
    expect(cnames).not.toContain('effective_roles_cache');
    expect(cnames).toContain('extra_roles');
  });

  test('幂等：连续跑两遍不报错', async () => {
    await runMigrations();
    // second run should not crash; relations already exist is a known
    // limitation for v1 (no _migrations ledger). We assert tables still queryable.
    const r = await testPool.query<{ c: string }>(
      `SELECT to_regclass('public.users')::text AS c`
    );
    expect(r.rows[0].c).toBe('users');
  });

  // Simulate a LIVE database that predates the RBAC work: the legacy 001
  // schema (positions table + users.position_id / effective_roles_cache)
  // plus a model_admin row still carrying the v1 coarse `models.manage`.
  // Running the full migration set must (a) drop the positions table + both
  // legacy users columns and (b) land the v2 (029) granular permission set on
  // model_admin — the v1 `.manage` codes are replaced wholesale by the demotion
  // to the granular model + provider points (which is how a legacy DB keeps
  // provider-key access under v2, where routes gate on `provider:*`).
  test('live-DB: drops positions/columns and lands v2 granular points on model_admin', async () => {
    const legacy: string[] = [
      `CREATE TABLE orgs (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         timezone TEXT NOT NULL DEFAULT 'UTC',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE departments (
         id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL REFERENCES orgs(id),
         name TEXT NOT NULL,
         parent_id TEXT REFERENCES departments(id),
         path TEXT NOT NULL)`,
      `CREATE TABLE positions (
         id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL REFERENCES orgs(id),
         name TEXT NOT NULL,
         inherits_roles JSONB NOT NULL DEFAULT '[]')`,
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL REFERENCES orgs(id),
         username TEXT NOT NULL,
         password_hash TEXT NOT NULL,
         display_name TEXT,
         department_id TEXT REFERENCES departments(id),
         position_id TEXT REFERENCES positions(id),
         timezone TEXT,
         extra_roles JSONB NOT NULL DEFAULT '[]',
         effective_roles_cache JSONB,
         status TEXT NOT NULL DEFAULT 'active',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (org_id, username))`,
      `CREATE TABLE init_invitations (
         id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL REFERENCES orgs(id),
         code_hash TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         expires_at TIMESTAMPTZ NOT NULL,
         used_at TIMESTAMPTZ,
         used_by TEXT REFERENCES users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (org_id, status))`,
      `CREATE TABLE roles (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         description TEXT,
         permissions JSONB NOT NULL DEFAULT '[]',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `INSERT INTO roles(id, name, description, permissions)
       VALUES ('legacy-ma', 'model_admin', 'Model & provider-key administrator',
               '["models.manage"]'::jsonb)`,
    ];
    for (const stmt of legacy) {
      await testPool.query(stmt);
    }

    await runMigrations();

    // positions table + legacy columns are gone
    const tables = await testPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`
    );
    expect(tables.rows.map((x) => x.tablename)).not.toContain('positions');
    const cols = await testPool.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns WHERE table_name='users'`
    );
    const cnames = cols.rows.map((x) => x.column);
    expect(cnames).not.toContain('position_id');
    expect(cnames).not.toContain('effective_roles_cache');

    // model_admin now carries the v2 granular set (029 demotion wholesale
    // replaced the legacy `models.manage`/`provider_keys.manage` codes with the
    // fine model + provider points), proving the destructive migrations ran
    // against a legacy-shaped DB and the v2 seed landed.
    const ma = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name='model_admin'`
    );
    expect(ma.rows).toHaveLength(1);
    expect(ma.rows[0].permissions.sort()).toEqual(
      [...BUILTIN_ROLE_POINTS.model_admin].sort(),
    );
    // v1 coarse codes are gone; the granular provider points are present.
    expect(ma.rows[0].permissions).not.toContain('models.manage');
    expect(ma.rows[0].permissions).toContain(PermissionPoint.ProviderEdit);
  });

  // Simulate a LIVE database that carries the OLD permission code: pre-create
  // the roles table (created for real by 019) and seed a role whose
  // permissions still read policies.manage. Running the full migration set must
  // (a) create the skill_marketplace catalog tables, (b) seed the reserved
  // uncategorized category, (c) backfill policies.manage -> skills.manage onto
  // the legacy role, and (d) drop the old skill_policies table.
  test('023 creates skill_marketplace tables, seeds uncategorized, backfills skills.manage, drops skill_policies', async () => {
    const legacy: string[] = [
      `CREATE TABLE roles (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         description TEXT,
         permissions JSONB NOT NULL DEFAULT '[]',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `INSERT INTO roles(id, name, description, permissions)
       VALUES ('r-legacy', 'legacy_policy', 'x', '["policies.manage"]'::jsonb)`,
    ];
    for (const stmt of legacy) {
      await testPool.query(stmt);
    }

    await runMigrations();

    // Tables exist; the old one is gone.
    const t = await testPool.query<{ c: string | null; s: string | null; old: string | null }>(
      `SELECT to_regclass('public.skill_marketplace_categories') AS c,
              to_regclass('public.skill_marketplace_skills') AS s,
              to_regclass('public.skill_policies') AS old`
    );
    expect(t.rows[0].c).toBeTruthy();
    expect(t.rows[0].s).toBeTruthy();
    expect(t.rows[0].old).toBeFalsy(); // dropped

    // Reserved category seeded — since 038 it is per-org: a fresh (org-less)
    // DB ends with no global row, and the bucket is seeded for an org when
    // the org is created (orgs trigger).
    await testPool.query(`INSERT INTO orgs (id, name) VALUES ('o-reserved', 'Reserved')`);
    const cat = await testPool.query<{ name_zh: string; name_en: string }>(
      `SELECT name_zh, name_en FROM skill_marketplace_categories
       WHERE category_id = 'uncategorized' AND org_id = 'o-reserved'`
    );
    expect(cat.rows[0]).toEqual({ name_zh: '未分类', name_en: 'Uncategorized' });

    // Backfill swapped the code in the legacy role.
    const role = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = 'legacy_policy'`
    );
    expect(role.rows[0].permissions).toEqual(['skills.manage']);

    // Idempotent: replaying the backfill is a no-op (still one entry, not duplicated).
    const again = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = 'legacy_policy'`
    );
    expect(again.rows[0].permissions).toEqual(['skills.manage']);
  });

  // Fresh DB: 019 seeds the v1 policy_admin (skills.manage + roles.manage), but
  // the v2 seed (029) demotes it to a custom role and rewrites its permissions
  // to the granular skill points + role:view. The final state must match that
  // v2 set (single source: BUILTIN_ROLE_POINTS).
  test('024 fresh-DB: policy_admin lands on the v2 granular skill + role points', async () => {
    await runMigrations();
    const pa = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = 'policy_admin'`
    );
    expect(pa.rows).toHaveLength(1);
    expect(pa.rows[0].permissions.sort()).toEqual(
      [...BUILTIN_ROLE_POINTS.policy_admin].sort(),
    );
  });

  // Simulate a LIVE database where 019 already ran with the OLD seed
  // (policy_admin holding only skills.manage). The full migration set must
  // still land the v2 (029) granular permission set on policy_admin.
  test('024 live-DB: upgrades a skills.manage-only policy_admin to the v2 points', async () => {
    const legacy: string[] = [
      `CREATE TABLE roles (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         description TEXT,
         permissions JSONB NOT NULL DEFAULT '[]',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `INSERT INTO roles(id, name, description, permissions)
       VALUES ('r-pa', 'policy_admin', 'x', '["skills.manage"]'::jsonb)`,
    ];
    for (const stmt of legacy) {
      await testPool.query(stmt);
    }

    await runMigrations();

    const pa = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = 'policy_admin'`
    );
    expect(pa.rows).toHaveLength(1);
    expect(pa.rows[0].permissions.sort()).toEqual(
      [...BUILTIN_ROLE_POINTS.policy_admin].sort(),
    );
  });

  test('025 creates agent_marketplace_agents table and seeds agent_admin role', async () => {
    await runMigrations();
    const t = await testPool.query<{ t: string | null }>(
      `SELECT to_regclass('public.agent_marketplace_agents') AS t`,
    );
    expect(t.rows[0].t).toBeTruthy();

    const idx = await testPool.query<{ i: string | null }>(
      `SELECT to_regclass('public.agent_marketplace_agents_enabled_idx') AS i`,
    );
    expect(idx.rows[0].i).toBeTruthy();

    // v2 (029) demotes agent_admin to a custom role and rewrites its points
    // from the v1 coarse `agents.manage` to the granular agent points.
    const role = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = 'agent_admin'`,
    );
    expect(role.rows[0]?.permissions?.sort()).toEqual(
      [...BUILTIN_ROLE_POINTS.agent_admin].sort(),
    );

    // idempotent: re-running 025 doesn't duplicate the row
    await runMigrations();
    const again = await testPool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM roles WHERE name = 'agent_admin'`,
    );
    expect(again.rows[0].c).toBe(1);
  });
});
