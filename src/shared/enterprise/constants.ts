export const EnterpriseIpcChannel = {
  Login: 'enterprise:login',
  Logout: 'enterprise:logout',
  SessionRevoked: 'enterprise:session-revoked',
  ListOrgs: 'enterprise:list-orgs',
  Refresh: 'enterprise:refresh',
  GetMe: 'enterprise:me',
  UpdateMe: 'enterprise:update-me',
  ChangePassword: 'enterprise:change-password',
  GetModels: 'enterprise:models',
  GetPolicies: 'enterprise:policies',
  PostAudit: 'enterprise:audit',
  ArchiveUpload: 'enterprise:archive-upload',
  GetUsageToday: 'enterprise:usage-today',
  BootstrapStatus: 'enterprise:bootstrap-status',
  SetUrl: 'enterprise:set-url',
  SaveUrl: 'enterprise:save-url',
  VerifyUrl: 'enterprise:verify-url',
  GetStoredUrl: 'enterprise:get-stored-url',
  Quit: 'enterprise:quit',
  SetLastSelectedModelId: 'enterprise:set-last-selected-model-id',
  SsoProviders: 'enterprise:sso-providers',
  SsoLogin: 'enterprise:sso-login',
} as const;

export type EnterpriseIpcChannel =
  (typeof EnterpriseIpcChannel)[keyof typeof EnterpriseIpcChannel];

export const EnterpriseModelIpcChannel = {
  ListModels: 'enterprise-model:list',
  Refresh: 'enterprise-model:refresh',
  SetActive: 'enterprise-model:setActive',
  GetActive: 'enterprise-model:getActive',
} as const;

export type EnterpriseModelIpcChannel =
  (typeof EnterpriseModelIpcChannel)[keyof typeof EnterpriseModelIpcChannel];

export const EnterpriseRole = {
  SuperAdmin: 'super_admin',
  Admin: 'admin',
  User: 'user',
} as const;
export type EnterpriseRole =
  (typeof EnterpriseRole)[keyof typeof EnterpriseRole];

export const ClientAuditAction = {
  McpCall: 'mcp_call',
  SkillCall: 'skill_call',
  ImSend: 'im_send',
  ImRecv: 'im_recv',
} as const;
export type ClientAuditAction =
  (typeof ClientAuditAction)[keyof typeof ClientAuditAction];

// Environment variable name that seeds the enterprise server base URL at
// runtime. The value is read by `getEnterpriseServerUrl()` (main process) and
// may be supplied either by the launch environment (MDM / terminal) or baked
// into the packaged app at build time (see EnterpriseBuildResource below).
export const EnterpriseServerUrlEnv = {
  Url: 'ENTERPRISE_SERVER_URL',
} as const;
export type EnterpriseServerUrlEnv =
  (typeof EnterpriseServerUrlEnv)[keyof typeof EnterpriseServerUrlEnv];

// Location of the build-time-baked enterprise build-info file. At packaging
// time (scripts/electron-builder-config.cjs) the generator writes
// `enterprise.json` under `.enterprise-build/`, which electron-builder ships
// to `process.resourcesPath/enterprise/`. The runtime seed
// (`seedEnterpriseServerUrl`) reads it in production; in dev it falls back to
// the project `.env` file.
export const EnterpriseBuildResource = {
  Directory: 'enterprise',
  Filename: 'enterprise.json',
  BuildDir: '.enterprise-build',
} as const;