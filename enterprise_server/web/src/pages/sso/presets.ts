// web/src/pages/sso/presets.ts
// Preset endpoints + default field mappings for the 7 v1 provider types.
// Inlined copy of enterprise_server/src/sso/providerPresets.ts (the web build
// does not read enterprise_server/src paths). Named providers ship with the
// documented defaults which the create form pre-fills; the admin can override
// before saving. Generic OIDC/OAuth2 are open-ended (blank endpoints).

import type { ProviderType, SsoProtocol } from './types';

export interface ProviderPreset {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  identityIdField: string;
  loginNameField: string;
  emailField: string;
}

export const PRESETS: Record<ProviderType, ProviderPreset> = {
  'generic-oidc': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: 'openid profile email',
    identityIdField: 'sub', loginNameField: 'preferred_username', emailField: 'email',
  },
  'generic-oauth2': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '',
    identityIdField: 'sub', loginNameField: '', emailField: 'email',
  },
  'azure-ad': {
    authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: 'openid profile email User.Read',
    identityIdField: 'sub', loginNameField: 'preferred_username', emailField: 'email',
  },
  'feishu': {
    authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
    tokenUrl: 'https://open.feishu.cn/open-apis/authen/v1/access_token',
    userinfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    scopes: 'contact:user.id:readonly',
    identityIdField: 'union_id', loginNameField: 'name', emailField: 'email',
  },
  'dingtalk': {
    authorizeUrl: 'https://oapi.dingtalk.com/connect/oauth2/sns_authorize',
    tokenUrl: 'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
    userinfoUrl: 'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
    scopes: 'snsapi_login',
    identityIdField: 'unionid', loginNameField: 'nickname', emailField: 'email',
  },
  'wecom': {
    authorizeUrl: 'https://open.weixin.qq.com/connect/oauth2/authorize',
    tokenUrl: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    userinfoUrl: 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
    scopes: 'snsapi_private_info',
    identityIdField: 'userid', loginNameField: 'name', emailField: 'email',
  },
  'saml2': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '', identityIdField: 'nameID', loginNameField: '', emailField: 'email',
  },
};

/** The wire protocol for a provider type. Only generic-oauth2 speaks plain
 * OAuth2; saml2 rows are stored-but-disabled in v1; everything else is OIDC. */
export function protocolFor(p: ProviderType): SsoProtocol {
  switch (p) {
    case 'generic-oauth2':
      return 'oauth2';
    case 'saml2':
      return 'saml2';
    default:
      return 'oidc';
  }
}
