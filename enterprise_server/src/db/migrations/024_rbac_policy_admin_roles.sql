-- v1
-- Grant `roles.manage` to the `policy_admin` role so it can read the role
-- vocabulary the skill 技能管理 page's allowed-roles picker depends on
-- (/api/roles/vocabulary is gated on roles.manage). Fresh DBs already get
-- this from the 019 seed; this covers DBs where 019 + 023 already ran.
-- Guarded by `?` on both codes so it is a no-op once applied (idempotent).
UPDATE roles
   SET permissions = permissions || '["roles.manage"]'::jsonb
 WHERE name = 'policy_admin'
   AND permissions ? 'skills.manage'
   AND NOT permissions ? 'roles.manage';
