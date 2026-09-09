-- Seed 6 built-ins (idempotent ON CONFLICT (name) DO NOTHING) and demote legacy
-- admins to custom. Fine point sets are inline JSON; kept in lockstep with
-- enterprise_server/src/shared/permissionPoints.ts (BUILTIN_ROLE_POINTS).
INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'super_admin', '超级管理员', '平台 Owner，拥有所有权限', 'org_wide', '[]', true,
  '["user:view","user:create","user:edit","user:delete","user:export","role:view","role:create","role:edit","role:delete","dept:view","dept:create","dept:edit","dept:delete","dept:adjust_member","model:view","model:create","model:edit","model:delete","provider:view","provider:edit","provider:rotate","skill:view","skill:create","skill:edit","skill:toggle","audit:view","audit:export","version:view","version:create","version:edit","version:publish","version:rollback","mcp:view","mcp:create","mcp:edit","mcp:delete","agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'org_admin', '组织管理员', 'IT/HR 管理员，管理用户、角色、部门', 'org_wide', '[]', true,
  '["user:view","user:create","user:edit","user:delete","user:export","role:view","role:create","role:edit","role:delete","dept:view","dept:create","dept:edit","dept:delete","dept:adjust_member","skill:view","skill:create","skill:edit","skill:toggle","version:view","version:create","version:edit","version:publish","version:rollback","mcp:view","mcp:create","mcp:edit","mcp:delete","agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'dept_admin', '部门管理员', '部门负责人，管理本部门及下级', 'dept_and_below', '[]', true,
  '["dept:view","dept:create","dept:edit","dept:adjust_member","user:view","user:edit","role:view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'auditor', '安全审计员', '只读审计日志与登录记录', 'org_wide', '[]', true,
  '["audit:view","audit:export"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'dev', '应用开发者', '研发与算法同学，使用技能、MCP、智能体模板', 'dept_and_below', '[]', true,
  '["skill:view","skill:create","skill:edit","mcp:view","mcp:create","agent:view","agent:create","agent:edit"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'member', '普通成员', '默认角色，使用已发布的智能体与技能', 'self', '[]', true,
  '["agent:view","skill:view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Re-assert existing built-ins (org_admin, auditor existed in 019 with coarse
-- points): upgrade them in place (is_builtin, display_name, fine points, data_scope).
UPDATE roles SET is_builtin=true, data_scope='org_wide',
  display_name=COALESCE(display_name,'组织管理员'),
  permissions='["user:view","user:create","user:edit","user:delete","user:export","role:view","role:create","role:edit","role:delete","dept:view","dept:create","dept:edit","dept:delete","dept:adjust_member","skill:view","skill:create","skill:edit","skill:toggle","version:view","version:create","version:edit","version:publish","version:rollback","mcp:view","mcp:create","mcp:edit","mcp:delete","agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb
WHERE name='org_admin' AND is_builtin=false;
UPDATE roles SET is_builtin=true, data_scope='org_wide',
  display_name=COALESCE(display_name,'安全审计员'),
  permissions='["audit:view","audit:export"]'::jsonb
WHERE name='auditor' AND is_builtin=false;

-- Demote legacy admin roles to custom (keep machine codes so extra_roles /
-- marketplace allowed_roles / JWT role names keep working).
UPDATE roles SET is_builtin=false, data_scope='org_wide',
  display_name=COALESCE(display_name,'模型管理员'),
  permissions='["model:view","model:create","model:edit","model:delete","provider:view","provider:edit","provider:rotate"]'::jsonb
WHERE name='model_admin' AND is_builtin=false;
UPDATE roles SET is_builtin=false, data_scope='org_wide',
  display_name=COALESCE(display_name,'技能管理员'),
  permissions='["skill:view","skill:create","skill:edit","skill:toggle","role:view"]'::jsonb
WHERE name='policy_admin' AND is_builtin=false;
UPDATE roles SET is_builtin=false, data_scope='org_wide',
  display_name=COALESCE(display_name,'智能体管理员'),
  permissions='["agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb
WHERE name='agent_admin' AND is_builtin=false;

-- Backfill display_name for any still-null role.
UPDATE roles SET display_name=name WHERE display_name IS NULL;
