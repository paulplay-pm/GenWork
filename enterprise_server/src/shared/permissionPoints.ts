export const PermissionPoint = {
  UserView: 'user:view', UserCreate: 'user:create', UserEdit: 'user:edit',
  UserDelete: 'user:delete', UserExport: 'user:export',
  RoleView: 'role:view', RoleCreate: 'role:create', RoleEdit: 'role:edit', RoleDelete: 'role:delete',
  DeptView: 'dept:view', DeptCreate: 'dept:create', DeptEdit: 'dept:edit',
  DeptDelete: 'dept:delete', DeptAdjustMember: 'dept:adjust_member',
  ModelView: 'model:view', ModelCreate: 'model:create', ModelEdit: 'model:edit', ModelDelete: 'model:delete',
  ProviderView: 'provider:view', ProviderEdit: 'provider:edit', ProviderRotate: 'provider:rotate',
  SkillView: 'skill:view', SkillCreate: 'skill:create', SkillEdit: 'skill:edit', SkillToggle: 'skill:toggle',
  AuditView: 'audit:view', AuditExport: 'audit:export',
  VersionView: 'version:view', VersionCreate: 'version:create', VersionEdit: 'version:edit',
  VersionPublish: 'version:publish', VersionRollback: 'version:rollback',
  McpView: 'mcp:view', McpCreate: 'mcp:create', McpEdit: 'mcp:edit', McpDelete: 'mcp:delete',
  AgentView: 'agent:view', AgentCreate: 'agent:create', AgentEdit: 'agent:edit',
  AgentDelete: 'agent:delete', AgentPublish: 'agent:publish',
  KitView: 'kit:view', KitCreate: 'kit:create', KitEdit: 'kit:edit', KitToggle: 'kit:toggle', KitDelete: 'kit:delete',
  SsoView: 'sso:view', SsoCreate: 'sso:create', SsoEdit: 'sso:edit',
} as const;
export type PermissionPoint = (typeof PermissionPoint)[keyof typeof PermissionPoint];

export const PERMISSION_POINTS: PermissionPoint[] = Object.values(PermissionPoint);

export const DataScope = {
  OrgWide: 'org_wide',
  DeptAndBelow: 'dept_and_below',
  Dept: 'dept',
  Self: 'self',
  CustomDeptTree: 'custom_dept_tree',
} as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];
export const DATA_SCOPE_VALUES: DataScope[] = [
  'org_wide', 'dept_and_below', 'dept', 'self', 'custom_dept_tree',
];

// Module grouping for the SPA grouped-permission picker (order = render order).
const user = [PermissionPoint.UserView, PermissionPoint.UserCreate, PermissionPoint.UserEdit, PermissionPoint.UserDelete, PermissionPoint.UserExport];
const role = [PermissionPoint.RoleView, PermissionPoint.RoleCreate, PermissionPoint.RoleEdit, PermissionPoint.RoleDelete];
const dept = [PermissionPoint.DeptView, PermissionPoint.DeptCreate, PermissionPoint.DeptEdit, PermissionPoint.DeptDelete, PermissionPoint.DeptAdjustMember];
const model = [PermissionPoint.ModelView, PermissionPoint.ModelCreate, PermissionPoint.ModelEdit, PermissionPoint.ModelDelete];
const provider = [PermissionPoint.ProviderView, PermissionPoint.ProviderEdit, PermissionPoint.ProviderRotate];
const skill = [PermissionPoint.SkillView, PermissionPoint.SkillCreate, PermissionPoint.SkillEdit, PermissionPoint.SkillToggle];
const audit = [PermissionPoint.AuditView, PermissionPoint.AuditExport];
const version = [PermissionPoint.VersionView, PermissionPoint.VersionCreate, PermissionPoint.VersionEdit, PermissionPoint.VersionPublish, PermissionPoint.VersionRollback];
const mcp = [PermissionPoint.McpView, PermissionPoint.McpCreate, PermissionPoint.McpEdit, PermissionPoint.McpDelete];
const agent = [PermissionPoint.AgentView, PermissionPoint.AgentCreate, PermissionPoint.AgentEdit, PermissionPoint.AgentDelete, PermissionPoint.AgentPublish];
const kit = [PermissionPoint.KitView, PermissionPoint.KitCreate, PermissionPoint.KitEdit, PermissionPoint.KitToggle, PermissionPoint.KitDelete];
const sso = [PermissionPoint.SsoView, PermissionPoint.SsoCreate, PermissionPoint.SsoEdit];

export const PERMISSION_MODULES: ReadonlyArray<{ key: string; name: string; desc: string; points: PermissionPoint[] }> = [
  { key: 'user', name: '用户管理', desc: '创建、编辑、禁用、归档用户与组织归属', points: user },
  { key: 'role', name: '角色管理', desc: '管理角色及每个角色被授予的权限点', points: role },
  { key: 'dept', name: '部门管理', desc: '管理部门组织树、负责人与成员', points: dept },
  { key: 'model', name: '模型与密钥管理', desc: '管理模型配置：服务商、模型与配额', points: model },
  { key: 'provider', name: '供应商密钥管理', desc: '管理供应商 API 密钥（在「模型配置」中）', points: provider },
  { key: 'skill', name: '技能管理', desc: '管理技能：启用/禁用及作用域设置', points: skill },
  { key: 'audit', name: '查看审计日志', desc: '查看组织审计日志', points: audit },
  { key: 'version', name: '版本管理', desc: '管理应用版本发布：新增、编辑、设为最新', points: version },
  { key: 'mcp', name: 'MCP 管理', desc: '管理 MCP 服务器市场', points: mcp },
  { key: 'agent', name: '智能体管理', desc: '管理企业智能体模板：新增、编辑、删除及可用角色', points: agent },
  { key: 'kit', name: '套件管理', desc: '管理企业专家套件：新增、编辑、删除及启用/禁用与授权范围', points: kit },
  { key: 'sso', name: 'SSO / 身份提供商', desc: '管理企业 SSO / 身份提供商：创建、编辑、启用/禁用', points: sso },
];

// Fine-grained point sets per built-in role (spec §8). Single source used by
// migration 029 seed and the built-in re-assertion guard.
const orgAdmin: PermissionPoint[] = [
  ...user, ...role, ...dept, ...skill, ...version, ...mcp, ...agent, ...kit, ...sso,
];
export const BUILTIN_ROLE_POINTS: Record<string, PermissionPoint[]> = {
  super_admin: PERMISSION_POINTS,
  org_admin: orgAdmin,
  dept_admin: [
    PermissionPoint.DeptView, PermissionPoint.DeptCreate, PermissionPoint.DeptEdit,
    PermissionPoint.DeptAdjustMember, PermissionPoint.UserView, PermissionPoint.UserEdit,
    PermissionPoint.RoleView,
  ],
  auditor: [PermissionPoint.AuditView, PermissionPoint.AuditExport],
  dev: [
    PermissionPoint.SkillView, PermissionPoint.SkillCreate, PermissionPoint.SkillEdit,
    PermissionPoint.McpView, PermissionPoint.McpCreate,
    PermissionPoint.AgentView, PermissionPoint.AgentCreate, PermissionPoint.AgentEdit,
  ],
  member: [PermissionPoint.AgentView, PermissionPoint.SkillView, PermissionPoint.KitView],
  model_admin: [...model, ...provider],
  policy_admin: [...skill, PermissionPoint.RoleView],
  agent_admin: agent,
};
