import { BrowserWindow, ipcMain } from 'electron';
import { EnterpriseIpcChannel } from '../../shared/enterprise/constants';
import { enterpriseClient } from '../auth/enterpriseClient';
import { enterpriseModelCache } from '../auth/enterpriseModelCache';
import { getEnterpriseServerUrl } from '../libs/endpoints';
import { startSsoMemberLogin } from '../sso/genericSsoLogin';

/**
 * Desktop SSO member-login IPC handlers (R20-corrected wiring).
 *
 * - SsoProviders: pre-login public fetch of the org's enabled SSO
 *   connections, mirroring the listOrgs handler (no loginGate gate).
 * - SsoLogin: drives the Task 13 OAuth dance (startSsoMemberLogin) in a
 *   child window of the calling window, then persists the session and
 *   runs the post-login plumbing (model cache load + login-sync hook)
 *   exactly like the password Login handler in enterpriseMt.ts.
 *
 * The login-sync hook is module-private in enterpriseMt.ts, so it is
 * threaded in via `deps.onLoginSync` as a lazy closure over
 * `onLoginSyncHook` (null at registration time, set later by main.ts).
 */
export function registerSsoHandlers(deps: { onLoginSync: () => Promise<void> }): void {
  ipcMain.handle(EnterpriseIpcChannel.SsoProviders, async (_e, orgName: string) => {
    try {
      return await enterpriseClient.listSsoProviders(orgName);
    } catch (e) {
      console.warn('[sso] listSsoProviders failed:', e);
      return { providers: [] };
    }
  });

  ipcMain.handle(
    EnterpriseIpcChannel.SsoLogin,
    async (
      e,
      args: { orgName: string; connectionId: string }
    ): Promise<{ ok: true; token: string } | { ok: false; error: string }> => {
      try {
        const token = await startSsoMemberLogin({
          enterpriseBaseUrl: getEnterpriseServerUrl(),
          orgName: args.orgName,
          connectionId: args.connectionId,
          parentWindow: BrowserWindow.fromWebContents(e.sender),
        });
        // The SSO JWT payload is { sub: userId, orgId, roles } — it already
        // carries orgId, so no listOrgs lookup is needed. persistSession
        // handles sessionStorage + loginGate internally.
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url').toString()
        ) as { sub: string; orgId: string; roles: string[] };
        enterpriseClient.persistSession(
          payload.orgId,
          payload.sub,
          token,
          Date.now() + 60 * 60 * 1000
        );
        // Mirror the password Login handler (enterpriseMt.ts): populate the
        // per-org model catalog so the first chat-send after login doesn't
        // wait on it.
        try {
          await enterpriseModelCache.load();
        } catch (cacheErr) {
          console.warn('[sso] enterpriseModelCache.load after login failed:', cacheErr);
        }
        try {
          await deps.onLoginSync();
        } catch (err) {
          console.warn('[sso] onLoginSync failed:', err);
        }
        return { ok: true, token };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );
}
