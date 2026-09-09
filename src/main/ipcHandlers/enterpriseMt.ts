import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { EnterpriseIpcChannel, EnterpriseModelIpcChannel } from '../../shared/enterprise/constants';
import { enterpriseClient } from '../auth/enterpriseClient';
import { enterpriseModelCache } from '../auth/enterpriseModelCache';
import { enterpriseModelPrefs } from '../auth/enterpriseModelPrefs';
import { enterpriseServerUrlStore } from '../auth/enterpriseServerUrlStore';
import { loginGate } from '../auth/loginGate';
import { sessionStorage } from '../auth/sessionStorage';
import { registerSsoHandlers } from './sso';

/**
 * Hook set by main.ts: the Login handler invokes this after a successful
 * login so the OpenClaw config sync re-collects the freshly-populated
 * enterprise catalog and the gateway restarts with the right env keys.
 * Without this, the gateway started at boot with no JWT, so the cache
 * was empty, so collectSecretEnvVars() emitted no GENWORK_APIKEY_* keys,
 * so the placeholder substitution in openclaw.json failed at gateway
 * startup.
 */
let onLoginSyncHook: (() => Promise<void>) | null = null;
export function setEnterpriseLoginSyncHook(hook: () => Promise<void>): void {
  onLoginSyncHook = hook;
}

export interface BootstrapStatus {
  configured: boolean;
  url: string | null;
}

/**
 * Probe the configured URL by hitting `<url>/health`. Used both at startup
 * (verify the persisted URL is still reachable) and at save-time (don't
 * persist a bad URL). Returns ok=true if the server replies 200 within the
 * timeout.
 */
const HEALTH_PROBE_TIMEOUT_MS = 5000;

export async function probeEnterpriseServerHealth(url: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const trimmed = url.trim().replace(/\/$/, '');
  if (!trimmed) {
    return { ok: false, error: 'empty_url' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${trimmed}/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `http_${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return {
      ok: false,
      error: (e as Error)?.message ?? 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

let bootstrapStatus: BootstrapStatus = { configured: false, url: null };

/**
 * Resolve the active URL: persisted value first, env var as initial seed.
 * Persistence wins once the user has saved at least once. On a fresh
 * install, the env var acts as the first-run default so dev / CI don't
 * have to click through the setup modal.
 */
function resolveActiveUrl(): string | null {
  const persisted = enterpriseServerUrlStore.load();
  if (persisted) return persisted;
  const envUrl = process.env.ENTERPRISE_SERVER_URL;
  return envUrl && envUrl.trim() ? envUrl.trim() : null;
}

function getBootstrapStatus(): BootstrapStatus {
  const url = resolveActiveUrl();
  bootstrapStatus = { configured: !!url, url };
  return bootstrapStatus;
}

export function getEnterpriseBootstrapStatus(): BootstrapStatus {
  return getBootstrapStatus();
}

/**
 * Apply a freshly entered URL: stash in process.env, re-point the
 * enterprise client, and re-bootstrap session plumbing. The IPC handlers
 * registered above are kept in place; only the underlying base URL changes.
 *
 * Persistence: caller must invoke `saveEnterpriseServerUrl` AFTER successful
 * `probeEnterpriseServerHealth` to actually write to SQLite. This split lets
 * the modal show validation feedback before committing.
 *
 * Returns the updated bootstrap status so the renderer can immediately
 * re-render past the setup modal.
 */
export function setEnterpriseServerUrl(url: string): BootstrapStatus {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Enterprise server URL must not be empty');
  }
  const normalized = trimmed.replace(/\/$/, '');
  process.env.ENTERPRISE_SERVER_URL = normalized;
  enterpriseClient.configure(normalized);
  // Re-bootstrap session plumbing so login works against the new URL. The
  // session storage still points at the same SQLite DB, but the persisted
  // token (if any) is bound to the *previous* server — treat it as
  // untrusted and require re-login.
  if (sessionDeps.db) {
    bootstrapSessionFromDeps();
  } else {
    console.warn('[enterpriseMt] setEnterpriseServerUrl: session deps not yet set; login will fail until restart');
  }
  console.log(`[enterpriseMt] re-pointed at ${normalized}`);
  return getBootstrapStatus();
}

/**
 * Persist the URL to SQLite. Should be called AFTER probeEnterpriseServerHealth
 * succeeds so we never persist an unreachable address.
 */
export function saveEnterpriseServerUrl(url: string): BootstrapStatus {
  // setEnterpriseServerUrl also handles the in-memory side effects
  // (process.env, enterpriseClient.configure, session plumbing).
  const status = setEnterpriseServerUrl(url);
  try {
    enterpriseServerUrlStore.save(url.trim().replace(/\/$/, ''));
  } catch (err) {
    console.error('[enterpriseMt] failed to persist enterprise URL:', err);
  }
  return status;
}

/**
 * Module-level handles to runtime dependencies that are wired after the
 * SQLite store is ready. Set once from `bootstrapEnterpriseMt`, which is
 * invoked from `main.ts` after `initStore()` resolves.
 */
const sessionDeps: { db: import('better-sqlite3').Database | null } = { db: null };

function bootstrapSessionFromDeps(): void {
  const db = sessionDeps.db;
  if (!db) return;
  sessionStorage.configure(db);
  enterpriseServerUrlStore.configure(db);
  enterpriseClient.setTokenProvider(() => sessionStorage.load()?.jwt ?? null);
  // Force re-login: any persisted token from a different server is untrusted.
  sessionStorage.clear();
}

/**
 * Multi-tenant enterprise server bridge.
 *
 * Each handler runs loginGate.requireEnterprise() except Login/Logout itself.
 * If the enterprise server returns 401 we lock the gate so the renderer
 * routes back to LoginPage automatically.
 */
export function registerEnterpriseMtHandlers(): void {
  // Refresh bootstrap status on every registration so a later set-url IPC can
  // return an accurate snapshot of the post-mutation state.
  getBootstrapStatus();
  ipcMain.handle(
    EnterpriseIpcChannel.Login,
    async (
      _e: IpcMainInvokeEvent,
      args: { orgId: string; username: string; password: string }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const r = await enterpriseClient.login(args.orgId, args.username, args.password);
        // Default JWT TTL is 1h; expose the timestamp so client can refresh proactively.
        const expiresAt = Date.now() + 60 * 60 * 1000;
        enterpriseClient.persistSession(args.orgId, args.username, r.token, expiresAt);
        // Phase C: a fresh JWT unlocks the per-org catalog. Fire-and-await so
        // the first chat-send after login never has to wait for the cache to
        // populate. Errors are logged, not surfaced — the model selector
        // empty-state still gives the user a usable UI on failure.
        try {
          await enterpriseModelCache.load();
        } catch (cacheErr) {
          console.warn('[enterpriseMt] enterpriseModelCache.load after login failed:', cacheErr);
        }
        // The boot-time sync ran with no JWT, so collectSecretEnvVars()
        // produced an empty GENWORK_APIKEY_* map. After login the cache is
        // populated; re-run the sync so the gateway restarts with the real
        // env keys and the placeholder substitution in openclaw.json
        // succeeds.
        if (onLoginSyncHook) {
          void onLoginSyncHook().catch((err) => {
            console.warn('[enterpriseMt] onLoginSyncHook failed:', err);
          });
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  );

  ipcMain.handle(EnterpriseIpcChannel.Logout, async () => {
    await enterpriseClient.logout();
    // Phase C: drop any cached keys from the previous session. The next
    // successful login will trigger a fresh load.
    enterpriseModelCache.wipe();
  });

  // Public endpoint — pre-login. Mirrors the Login/Logout exemption
  // documented at the top of this registration block: no
  // `loginGate.requireEnterprise()` call.
  ipcMain.handle(EnterpriseIpcChannel.ListOrgs, async () => {
    try {
      return await enterpriseClient.listOrgs();
    } catch (e) {
      // Surface the error to the renderer so the login page can decide
      // whether to fall back to a free-form orgId input. We deliberately
      // do NOT translate this to `{ ok: false, error }` — the rest of the
      // API surface uses raw values for read endpoints.
      throw new Error(`enterprise_client listOrgs failed: ${(e as Error).message}`);
    }
  });

  // Probe the enterprise session. Returns a structured result instead
  // of throwing on the not-logged-in case so the renderer's startup
  // probe (App.tsx, called before LoginPage is shown) doesn't generate
  // "Error occurred in handler for 'enterprise:me'" log lines through
  // Electron's IPC plumbing. `null` payload means unauthenticated;
  // a real profile object means logged in.
  ipcMain.handle(EnterpriseIpcChannel.GetMe, async (): Promise<unknown> => {
    try {
      loginGate.requireEnterprise();
      return await enterpriseClient.getMe();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'not logged in') return { ok: false, error: msg };
      throw e;
    }
  });

  ipcMain.handle(
    EnterpriseIpcChannel.UpdateMe,
    async (_e: IpcMainInvokeEvent, displayName: string) => {
      loginGate.requireEnterprise();
      return enterpriseClient.updateMe(displayName);
    }
  );

  ipcMain.handle(
    EnterpriseIpcChannel.ChangePassword,
    async (
      _e: IpcMainInvokeEvent,
      args: { currentPassword: string; newPassword: string }
    ) => {
      loginGate.requireEnterprise();
      return enterpriseClient.changePassword(args.currentPassword, args.newPassword);
    }
  );

  ipcMain.handle(EnterpriseIpcChannel.GetModels, async () => {
    loginGate.requireEnterprise();
    return enterpriseClient.getModels();
  });

  ipcMain.handle(
    EnterpriseIpcChannel.SetLastSelectedModelId,
    async (_e: IpcMainInvokeEvent, id: string) => {
      if (typeof id !== 'string' || id.length === 0) {
        return; // silent no-op; renderer will dispatch its own validation
      }
      enterpriseModelPrefs.writeLastSelectedModelId(id);
    },
  );

  ipcMain.handle(
    EnterpriseIpcChannel.GetPolicies,
    async (_e: IpcMainInvokeEvent, type: 'mcp' | 'skill') => {
      loginGate.requireEnterprise();
      return enterpriseClient.getPolicies(type);
    }
  );

  ipcMain.handle(
    EnterpriseIpcChannel.PostAudit,
    async (
      _e: IpcMainInvokeEvent,
      events: { action: string; targetType?: string; targetId?: string; payload?: unknown }[]
    ) => {
      loginGate.requireEnterprise();
      await enterpriseClient.postAudit(events);
    }
  );

  ipcMain.handle(EnterpriseIpcChannel.GetUsageToday, async () => {
    loginGate.requireEnterprise();
    return enterpriseClient.getUsageToday();
  });

  ipcMain.handle(EnterpriseModelIpcChannel.ListModels, () => enterpriseModelCache.list());

  ipcMain.handle(EnterpriseModelIpcChannel.Refresh, async () => {
    try {
      const r = await enterpriseModelCache.load();
      return { ok: true, refreshed: r.models.length };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(EnterpriseModelIpcChannel.SetActive, (_e, modelId: string) => {
    enterpriseModelCache.setActive(modelId);
    return { ok: true };
  });

  ipcMain.handle(EnterpriseModelIpcChannel.GetActive, () => ({ modelId: enterpriseModelCache.getActive() }));

  ipcMain.handle(EnterpriseIpcChannel.BootstrapStatus, () => getBootstrapStatus());

  // Read-only: returns the persisted URL from SQLite (no verify, no side
  // effects). Renderer uses this to pre-fill the setup modal when it
  // opens after a failed verify.
  ipcMain.handle(EnterpriseIpcChannel.GetStoredUrl, () => ({
    url: enterpriseServerUrlStore.load(),
  }));

  // Verify reachability. Hit <url>/health with a 5s timeout. Returns
  // ok=false on non-200, timeout, or network error. The renderer shows
  // the error message in the modal without persisting the URL.
  ipcMain.handle(
    EnterpriseIpcChannel.VerifyUrl,
    async (_e, url: unknown) => {
      if (typeof url !== 'string') {
        return { ok: false, error: 'invalid_url' };
      }
      return probeEnterpriseServerHealth(url);
    }
  );

  // Persist + re-point. The renderer must call VerifyUrl first and only
  // call SaveUrl on ok=true. SaveUrl itself does NOT verify (would be
  // wasteful and racy with the modal's own verify).
  ipcMain.handle(
    EnterpriseIpcChannel.SaveUrl,
    (_e, url: unknown) => {
      if (typeof url !== 'string') {
        return { ok: false, error: 'invalid_url' };
      }
      const status = saveEnterpriseServerUrl(url);
      return { ok: true, status };
    }
  );

  ipcMain.handle(
    EnterpriseIpcChannel.SetUrl,
    (_e, url: string): BootstrapStatus => setEnterpriseServerUrl(url)
  );

  ipcMain.handle(EnterpriseIpcChannel.Quit, () => {
    // Defer the actual quit so the IPC reply lands before exit.
    setImmediate(() => app.quit());
  });

  // SSO member-login federation. The login-sync hook is module-private here
  // (set later by main.ts), so thread it in lazily; the SsoLogin handler
  // awaits it after persisting the SSO session, mirroring the password
  // Login handler's post-login plumbing.
  registerSsoHandlers({
    onLoginSync: () => (onLoginSyncHook ? onLoginSyncHook() : Promise.resolve()),
  });
}

/**
 * Wire up enterpriseClient + sessionStorage. Call once at startup after the
 * SQLite DB is available.
 *
 * Per spec §4.4: "every restart reads the user and model list from
 * enterprise_server into desktop memory". To honour that, we deliberately
 * clear any persisted session on bootstrap — the user must re-login after
 * every app launch. The persisted session in SQLite (if any) is wiped.
 * This also guarantees that a token issued for a previous URL cannot leak
 * into a new URL session.
 */
export function bootstrapEnterpriseMt(getDb: () => import('better-sqlite3').Database): void {
  const db = getDb();
  sessionDeps.db = db;
  sessionStorage.configure(db);
  enterpriseModelPrefs.configure(db);
  enterpriseClient.configure(process.env.ENTERPRISE_SERVER_URL ?? 'https://enterprise.local');
  // Wipe any persisted session from a prior launch. Re-login is required.
  sessionStorage.clear();
  enterpriseClient.setTokenProvider(() => sessionStorage.load()?.jwt ?? null);
  // loginGate stays locked until the user logs in via the LoginPage.
}