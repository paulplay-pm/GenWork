import { openOauthFlow } from '../mcp/oauthBrowserFlow';
import { createSsoLoginProbe,startCallbackServer } from './genericSsoLogin';

const SSO_DESKTOP_REDIRECT_PORT = 53231;

export async function startSsoMemberBind(args: {
  enterpriseBaseUrl: string;
  authorizeUrl: string;
}): Promise<string> {
  // 自助绑定复用 login 流程的 loopback + 探针(端口 + startCallbackServer
  // + createSsoLoginProbe)。区别只在入口:login 是 desktop 自己拼
  // authorizeUrl(经 buildAuthorizeUrl),bind 是 server 通过
  // /me/sso-binding/start 返 authorizeUrl 后直接传进来。Probe 的
  // pendingBind 分支不会触发,因为 server 端走 ready_to_finalize
  // finalize 路径,没有 pending_bind 状态。
  const cb = await startCallbackServer(SSO_DESKTOP_REDIRECT_PORT, args.enterpriseBaseUrl);
  try {
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: args.enterpriseBaseUrl,
      cb,
    });
    const token = await openOauthFlow({
      title: 'SSO self-binding',
      authorizeUrl: args.authorizeUrl,
      probe,
    });
    if (!token) throw new Error('sso_bind_failed');
    return token;
  } finally {
    cb.close();
  }
}
