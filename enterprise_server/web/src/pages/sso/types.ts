// web/src/pages/sso/types.ts
// Wire types for the SSO federation admin routes (T11) and the public login
// providers route (T17). Admin rows are REDACTED on the wire: no
// `client_secret_encrypted`, no plaintext secret — only `client_secret_masked`
// + `has_secret`. Responses are snake_case; create/patch bodies are camelCase
// (server schemas: enterprise_server/src/routes/sso.ts).

export type ProviderType =
  | 'generic-oidc'
  | 'generic-oauth2'
  | 'azure-ad'
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'saml2';

export type SsoProtocol = 'oidc' | 'oauth2' | 'saml2';

/** One admin-visible (redacted) SSO connection row — snake_case wire shape. */
export interface SsoConnection {
  id: string;
  org_id: string;
  name: string;
  provider_type: ProviderType;
  protocol: SsoProtocol;
  authorize_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  client_id: string | null;
  client_secret_masked: string | null;
  scopes: string | null;
  identity_id_field: string;
  login_name_field: string | null;
  email_field: string;
  email_domain_whitelist: string[];
  /** Per-connection logo URL override. NULL means "no override"; the
   *  public endpoint falls back to a built-in default for known
   *  provider types. Admin sees the raw stored value here, NOT the
   *  resolved public URL. */
  logo_url: string | null;
  enabled: boolean;
  sort_order: number;
  has_secret: boolean;
  /** When true, SSO logins on this connection that arrive without a stored
   *  `users.sso_*` row are bounced to the password-proof /bind-sso page
   *  instead of JIT-creating an account. Admins and self-bound users are
   *  unaffected. */
  require_prebinding: boolean;
}

/** Create/patch body — camelCase. `clientSecret` blank = none on create,
 * keep the stored secret on patch. `orgId` is only sent on create (the list
 * and id-scoped routes scope by the token's org). The per-connection logo
 * is uploaded via `POST /admin/sso-connections/:id/logo` and cleared via
 * `DELETE` on the same path — it is NOT part of the JSON create/patch body. */
export interface SsoConnectionInput {
  orgId?: string;
  name: string;
  providerType: ProviderType;
  protocol: SsoProtocol;
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  identityIdField: string;
  loginNameField?: string;
  emailField: string;
  emailDomainWhitelist: string[];
  enabled: boolean;
  sortOrder: number;
  /** Optional on patch; the server defaults to the stored value when
   *  omitted. */
  requirePrebinding?: boolean;
}

/** One entry of `GET /auth/sso/providers?orgName=...` (public login page). */
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
