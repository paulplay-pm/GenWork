-- Migration 028: v2 two-axis org/permission model. Idempotent (ADD COLUMN IF NOT EXISTS).
-- (First line must not start with `-- v2`: migrate.ts/testDb.ts skip files
--  matching that placeholder heuristic and never apply them.)
ALTER TABLE roles ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS data_scope TEXT NOT NULL DEFAULT 'self';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS custom_dept_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS leader_id TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 100;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_code ON departments(org_id, code);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS level TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_device TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_org_email ON users(org_id, email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_departments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dept_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, dept_id)
);
CREATE INDEX IF NOT EXISTS user_departments_dept ON user_departments(dept_id);

CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  device TEXT,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_user ON login_events(user_id, ts DESC);
