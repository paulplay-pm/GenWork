CREATE TABLE IF NOT EXISTS skill_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  skill_id TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '"org-wide"',
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, skill_id)
);
