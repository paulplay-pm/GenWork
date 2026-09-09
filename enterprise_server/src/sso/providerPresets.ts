// enterprise_server/src/sso/providerPresets.ts
// Preset endpoints + default field mappings for the 5 v1 providers.
// Generic OIDC/OAuth2 are open-ended (the admin fills them in); named
// providers ship with the documented defaults which the form pre-fills
// (admin can override before saving).

export interface ProviderPreset {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  identityIdField: string;
  loginNameField: string;
  emailField: string;
}

export const PRESETS: Record<string, ProviderPreset> = {
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
  saml2: {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '', identityIdField: 'nameID', loginNameField: '', emailField: 'email',
  },
};
