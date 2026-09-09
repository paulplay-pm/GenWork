-- Remigrate existing data. Runs at migrate time over orgs present then.
-- Idempotent: guarded by existence checks.
--
-- Plain SQL only (no DO $$ blocks): the production runner
-- (src/db/migrate.ts splitStatements) executes one `;`-delimited statement at
-- a time and cannot apply dollar-quoted DO bodies.

-- 1. Per org, ensure a single ROOT department (always, to anchor the tree).
--    departments(org_id, code) is unique (028), so at most one ROOT per org.
INSERT INTO departments(id, org_id, name, parent_id, path, code, sort)
SELECT gen_random_uuid(), o.id, o.name, NULL, '/' || o.name, 'ROOT', 1
FROM orgs o
WHERE NOT EXISTS (
  SELECT 1 FROM departments d
  WHERE d.org_id = o.id AND d.code = 'ROOT' AND d.parent_id IS NULL
);

-- 2. Re-parent top-level depts (parent_id IS NULL) that are not the ROOT,
--    rewriting their path with the ROOT prefix.
UPDATE departments d
SET parent_id = r.id,
    path = '/' || r.name || d.path
FROM orgs o
JOIN departments r
  ON r.org_id = o.id AND r.code = 'ROOT' AND r.parent_id IS NULL
WHERE d.org_id = o.id
  AND d.parent_id IS NULL
  AND d.id <> r.id;

-- 3. Rewrite the path of every remaining dept whose path still lacks the ROOT
--    prefix (descendants of the re-parented depts): old path -> /<ROOT name> + old path.
UPDATE departments d
SET path = '/' || r.name || d.path
FROM orgs o
JOIN departments r
  ON r.org_id = o.id AND r.code = 'ROOT' AND r.parent_id IS NULL
WHERE d.org_id = o.id
  AND d.id <> r.id
  AND d.path NOT LIKE '/' || r.name || '/%';

-- 4. Backfill user_departments from users.department_id (primary).
INSERT INTO user_departments(user_id, dept_id, is_primary)
SELECT u.id, u.department_id, true FROM users u
WHERE u.department_id IS NOT NULL
ON CONFLICT (user_id, dept_id) DO NOTHING;

-- 5. Remap extra_roles: any role name that has no roles row -> 'member'
--    (fail-closed). Preserve known names; de-duplicate. Empty arrays are left
--    untouched (the column is NOT NULL).
UPDATE users
SET extra_roles = (
  SELECT jsonb_agg(DISTINCT CASE
    WHEN EXISTS (SELECT 1 FROM roles r WHERE r.name = x) THEN x
    ELSE 'member'
  END)
  FROM jsonb_array_elements_text(users.extra_roles) AS x
)
WHERE extra_roles IS DISTINCT FROM '[]'::jsonb;
