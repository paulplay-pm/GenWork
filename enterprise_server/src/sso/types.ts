// enterprise_server/src/sso/types.ts
export type SsoProviderType =
  | 'generic-oidc' | 'generic-oauth2' | 'azure-ad'
  | 'feishu' | 'dingtalk' | 'wecom' | 'saml2';

export type SsoProtocol = 'oidc' | 'oauth2' | 'saml2';

export interface SsoConnectionRow {
  id: string;
  org_id: string;
  name: string;
  provider_type: string;
  protocol: string;
  authorize_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  client_id: string | null;
  client_secret_encrypted: string | null;
  client_secret_masked: string | null;
  scopes: string | null;
  identity_id_field: string;
  login_name_field: string | null;
  email_field: string;
  email_domain_whitelist: string[];
  /** When true, an IdP identity not in users.sso_(connection,external) is
   *  sent to /bind-sso (must verify password) instead of JIT-resolving. */
  require_prebinding: boolean;
  /** Optional per-connection logo URL. When set, the login pages use it
   *  as the SSO button's <img src>. When null, the server falls back to
   *  the built-in default for the provider_type (see sso/logos.ts). */
  logo_url: string | null;
  enabled: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SsoPublicProvider {
  id: string;
  name: string;
  provider_type: string;
  sort_order: number;
  /** Absolute URL the login UI uses as the SSO button's <img src>, or
   *  null when neither a per-connection logo_url nor a built-in default
   *  exists for this provider type. */
  logoUrl: string | null;
}

export interface SsoAdminConnection extends Omit<SsoConnectionRow, 'client_secret_encrypted'> {
  has_secret: boolean;
}

export interface SsoStateRow {
  state: string;
  org_id: string;
  sso_connection_id: string;
  return_target: 'console' | 'desktop' | 'web';
  code_verifier: string | null;
  redirect_uri: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface SsoIdentityClaims {
  externalId: string;
  loginName: string | null;
  email: string | null;
  raw: Record<string, unknown>;
}

export const STATE_TTL_MS = 2 * 60 * 1000;  // 2 minutes
