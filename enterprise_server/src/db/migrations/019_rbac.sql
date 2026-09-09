-- v1
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'org_admin', 'Organization administrator',
        '["users.manage","roles.manage","departments.manage","releases.manage","mcp.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'model_admin', 'Model & provider-key administrator',
        '["models.manage","provider_keys.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'policy_admin', 'Skill catalog administrator',
        '["skills.manage","roles.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'auditor', 'Auditor',
        '["audit.view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;
