export const HtmlShareIpc = {
  CreateFromHtmlFile: 'htmlShare:createFromHtmlFile',
  CreateFromBakedHtml: 'htmlShare:createFromBakedHtml',
  Get: 'htmlShare:get',
  GetBySource: 'htmlShare:getBySource',
  GetQuota: 'htmlShare:getQuota',
  Delete: 'htmlShare:delete',
  // Used by the deployment / library shared-files flow (not the artifact-file
  // share, which is simplified to create + delete). Kept so both features
  // resolve the same channel constants.
  UpdateStatus: 'htmlShare:updateStatus',
  UpdateAccessMode: 'htmlShare:updateAccessMode',
} as const;

export type HtmlShareIpc = (typeof HtmlShareIpc)[keyof typeof HtmlShareIpc];

export const HtmlShareSourceType = {
  HtmlFile: 'html_file',
  ImageFile: 'image_file',
  SvgFile: 'svg_file',
  DocumentFile: 'document_file',
  MarkdownFile: 'markdown_file',
  MermaidFile: 'mermaid_file',
  NodeServiceDeployment: 'node_service_deployment',
  StaticServiceDeployment: 'static_service_deployment',
} as const;

export type HtmlShareSourceType = (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType];

export const HtmlShareAccessMode = {
  Code: 'code',
  Public: 'public',
  Org: 'org',
} as const;

export type HtmlShareAccessMode = (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];

export const HtmlShareStatus = {
  Live: 'live',
  Disabled: 'disabled',
  Failed: 'failed',
} as const;

export type HtmlShareStatus = (typeof HtmlShareStatus)[keyof typeof HtmlShareStatus];
export type HtmlShareConfigurableStatus =
  | typeof HtmlShareStatus.Live
  | typeof HtmlShareStatus.Disabled;

export const HtmlShareDisabledSource = {
  User: 'user',
  Admin: 'admin',
  Moderation: 'moderation',
  ActiveLimit: 'active_limit',
  System: 'system',
} as const;

export type HtmlShareDisabledSource =
  (typeof HtmlShareDisabledSource)[keyof typeof HtmlShareDisabledSource];

// Public share pages are served by enterprise_server at
// `${origin}/api/pages/<shareId>` (see htmlShares.generatePublicUrl). The
// historical `/s/<shareId>/` alias is no longer routed; keep this as the
// single source of truth for the public base so every URL the desktop builds
// (create / by-source / get / deployment) matches the server's publicUrl.
export const HtmlSharePublicRoute = {
  Root: '/api/pages',
} as const;

export type HtmlSharePublicRoute = (typeof HtmlSharePublicRoute)[keyof typeof HtmlSharePublicRoute];
