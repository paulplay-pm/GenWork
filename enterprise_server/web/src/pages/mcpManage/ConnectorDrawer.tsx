import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';

import type {
  AuthMode6,
  Connector,
  ConnectorDraftWire,
  ConnectorInput,
  ConnectorScope,
  ConnectorWorkingCopy,
  VersionRow,
} from '../../api/connectors';
import { connectorApi } from '../../api/connectors';
import { ApiError } from '../../api/client';
import type { DeptNode } from '../../api/departments';
import type { UserRow } from '../../api/users';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { ConnectorBasicInfo } from './ConnectorBasicInfo';
import { ConnectorConnConfig, AUTH_MODE_LABEL, SSE_INCOMPATIBLE_AUTH_MODES } from './ConnectorConnConfig';
import { SSO_APP_OPTIONS } from './ConnectorAuthFields';
import { ConnectorScopeSelector } from './ConnectorScopeSelector';
import { ConnectorToolPermissions } from './ConnectorToolPermissions';
import { ConnectorVersionHistory } from './ConnectorVersionHistory';
import { DeleteConnectorModal } from './DeleteConnectorModal';
import { fill } from './types';

/** Default OAuth callback endpoint issued by the enterprise server. */
export const CALLBACK_URL_DEFAULT = 'https://oauth.genwork.cn/mcp/callback';

const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 300;
const TIMEOUT_DEFAULT = 30;
const RETRY_MIN = 0;
const RETRY_MAX = 5;
const RETRY_DEFAULT = 2;
const DESCRIPTION_MAX = 200;

/** Single form state for the whole create/edit drawer: basic fields, scope,
 * tool toggles and the per-mode `authConfig` sub-fields (secrets stay blank
 * when the form should "keep the stored value"). */
export interface ConnectorFormState {
  serverKey: string;
  url: string;
  nameEn: string;
  nameZh: string;
  version: string;
  categoryId: string;
  description: string;
  transport: 'http' | 'sse';
  authMode: AuthMode6;
  scope: ConnectorScope;
  toolToggles: Record<string, boolean>;
  // authConfig sub-fields (stored under `authConfig` in the wire body).
  apiKey: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  authorizeUrl: string;
  callbackUrl: string;
  scopes: string[];
  ssoApp: string;
  ssoAuthorizeUrl: string;
  ssoTokenUrl: string;
  ssoClientId: string;
  ssoScopes: string[];
  ssoClientSecret: string;
  apiKeyHeaderName: string;
  timeoutSeconds: number;
  retryCount: number;
}

interface Props {
  mode: 'create' | 'edit';
  orgId: string;
  connector?: Connector;
  depts: DeptNode[];
  members: UserRow[];
  categories: { id: string; name: string }[];
  /** Version history (edit mode; fed by the page's detail fetch). */
  versions?: VersionRow[];
  /** The staged draft from the detail fetch (MASKED on the wire), when one is
   * pending. The form re-seeds from it (edit mode) and publish applies it. */
  draft?: ConnectorDraftWire | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  /** After a draft is saved (the drawer stays open). */
  onDraftSaved?: () => void;
  /** After a successful rollback (refetch list + version history). */
  onRolledBack?: () => void;
  /** After a completed server probe (test-connection) — refetch the row so the
   * tool list + publish working-copy reflect the synced manifest. */
  onTested?: () => void;
}

function clampTimeout(n: number): number {
  if (!Number.isFinite(n)) return TIMEOUT_DEFAULT;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(n)));
}

function clampRetry(n: number): number {
  if (!Number.isFinite(n)) return RETRY_DEFAULT;
  return Math.min(RETRY_MAX, Math.max(RETRY_MIN, Math.round(n)));
}

function initState(mode: 'create' | 'edit', connector: Connector | undefined): ConnectorFormState {
  void mode;
  const cfg = connector?.authConfig ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const scope: ConnectorScope = connector?.scope ?? { allCompany: false, deptIds: [], userIds: [] };
  return {
    serverKey: connector?.serverKey ?? '',
    url: connector?.url ?? '',
    nameEn: connector?.nameEn ?? '',
    nameZh: connector?.nameZh ?? '',
    version: connector?.version ?? '1.0.0',
    categoryId: connector?.categoryId ?? '',
    description: connector?.description ?? '',
    transport: connector?.transport ?? 'http',
    authMode: connector?.authMode ?? 'none',
    scope: {
      allCompany: !!scope.allCompany,
      deptIds: [...(scope.deptIds ?? [])],
      userIds: [...(scope.userIds ?? [])],
    },
    toolToggles: Object.fromEntries(
      (connector?.tools ?? []).map((tool): [string, boolean] => [tool.name, tool.enabled]),
    ),
    // Secrets are never pre-filled: a blank secret on edit means "keep the
    // stored ciphertext" (the backend preserves it); the masked value is shown
    // as a placeholder instead.
    apiKey: '',
    clientId: str(cfg.clientId),
    clientSecret: '',
    tokenUrl: str(cfg.tokenUrl),
    authorizeUrl: str(cfg.authorizeUrl),
    callbackUrl: str(cfg.callbackUrl) || CALLBACK_URL_DEFAULT,
    scopes: Array.isArray(cfg.scopes) ? cfg.scopes.filter((s): s is string => typeof s === 'string') : [],
    ssoApp: str(cfg.ssoApp) || SSO_APP_OPTIONS[0],
    ssoAuthorizeUrl: str(cfg.ssoAuthorizeUrl),
    ssoTokenUrl: str(cfg.ssoTokenUrl),
    ssoClientId: str(cfg.ssoClientId),
    ssoScopes: Array.isArray(cfg.ssoScopes) ? (cfg.ssoScopes as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    ssoClientSecret: '',
    apiKeyHeaderName: str(cfg.apiKeyHeaderName),
    timeoutSeconds: typeof cfg.timeoutSeconds === 'number' ? cfg.timeoutSeconds : TIMEOUT_DEFAULT,
    retryCount: typeof cfg.retryCount === 'number' ? cfg.retryCount : RETRY_DEFAULT,
  };
}

/** Override a connector-based form state with the fields the staged (masked)
 * draft carries — only the keys the draft has; absent keys keep the base
 * value. The draft's `authConfig` is masked on the wire, so the non-secret
 * sub-fields (clientId, tokenUrl, authorizeUrl, callbackUrl, scopes, ssoApp,
 * timeouts) can
 * be seeded safely; `apiKey`/`clientSecret` are ALWAYS left blank (the masked
 * value only feeds `hasSecret` / the placeholder — never a pre-filled value). */
function applyDraft(base: ConnectorFormState, draft: ConnectorDraftWire): ConnectorFormState {
  const cfg = draft.authConfig ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const scope = draft.scope ?? base.scope;
  return {
    ...base,
    url: draft.url !== undefined ? draft.url : base.url,
    version: draft.version !== undefined ? draft.version : base.version,
    nameEn: draft.nameEn !== undefined ? (draft.nameEn ?? '') : base.nameEn,
    nameZh: draft.nameZh !== undefined ? (draft.nameZh ?? '') : base.nameZh,
    categoryId: draft.categoryId !== undefined ? (draft.categoryId ?? '') : base.categoryId,
    description: draft.description !== undefined ? (draft.description ?? '') : base.description,
    transport: draft.transport ?? base.transport,
    authMode: draft.authMode ?? base.authMode,
    scope: {
      allCompany: !!scope.allCompany,
      deptIds: [...(scope.deptIds ?? [])],
      userIds: [...(scope.userIds ?? [])],
    },
    toolToggles: draft.tools
      ? Object.fromEntries(draft.tools.map((tool): [string, boolean] => [tool.name, tool.enabled]))
      : base.toolToggles,
    clientId: str(cfg.clientId),
    clientSecret: '',
    tokenUrl: str(cfg.tokenUrl),
    authorizeUrl: str(cfg.authorizeUrl),
    callbackUrl: str(cfg.callbackUrl) || CALLBACK_URL_DEFAULT,
    scopes: Array.isArray(cfg.scopes) ? cfg.scopes.filter((s): s is string => typeof s === 'string') : base.scopes,
    ssoApp: str(cfg.ssoApp) || base.ssoApp,
    ssoAuthorizeUrl: str(cfg.ssoAuthorizeUrl),
    ssoTokenUrl: str(cfg.ssoTokenUrl),
    ssoClientId: str(cfg.ssoClientId),
    ssoScopes: Array.isArray(cfg.ssoScopes) ? (cfg.ssoScopes as unknown[]).filter((s): s is string => typeof s === 'string') : base.ssoScopes,
    ssoClientSecret: '',
    apiKeyHeaderName: str(cfg.apiKeyHeaderName) || base.apiKeyHeaderName,
    timeoutSeconds: typeof cfg.timeoutSeconds === 'number' ? cfg.timeoutSeconds : base.timeoutSeconds,
    retryCount: typeof cfg.retryCount === 'number' ? cfg.retryCount : base.retryCount,
    apiKey: '',
  };
}

/** Build the `authConfig` payload for the current mode. Blank secrets are
 * omitted so the backend keeps the stored ciphertext (encrypt-at-write
 * contract — no client-side encryption). */
function buildAuthConfig(s: ConnectorFormState): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    timeoutSeconds: clampTimeout(s.timeoutSeconds),
    retryCount: clampRetry(s.retryCount),
  };
  if (s.authMode === 'shared-key') {
    if (s.apiKey.trim()) cfg.apiKey = s.apiKey.trim();
  } else if (s.authMode === 'user-oauth') {
    cfg.callbackUrl = s.callbackUrl.trim() || CALLBACK_URL_DEFAULT;
    cfg.clientId = s.clientId.trim();
    cfg.authorizeUrl = s.authorizeUrl.trim();
    cfg.tokenUrl = s.tokenUrl.trim();
    if (s.clientSecret.trim()) cfg.clientSecret = s.clientSecret.trim();
    cfg.scopes = s.scopes;
  } else if (s.authMode === 'client-creds') {
    cfg.tokenUrl = s.tokenUrl.trim();
    cfg.clientId = s.clientId.trim();
    if (s.clientSecret.trim()) cfg.clientSecret = s.clientSecret.trim();
  } else if (s.authMode === 'sso') {
    cfg.ssoApp = s.ssoApp;
    cfg.ssoClientId = s.ssoClientId.trim();
    cfg.ssoAuthorizeUrl = s.ssoAuthorizeUrl.trim();
    cfg.ssoTokenUrl = s.ssoTokenUrl.trim();
    if (s.ssoClientSecret.trim()) cfg.ssoClientSecret = s.ssoClientSecret.trim();
    if (s.ssoScopes.length > 0) cfg.ssoScopes = s.ssoScopes;
  } else if (s.authMode === 'user-key') {
    if (s.apiKeyHeaderName.trim()) cfg.apiKeyHeaderName = s.apiKeyHeaderName.trim();
  }
  return cfg;
}

const FIELD_LABEL: Record<string, string> = {
  apiKey: 'mcpDrawer.auth.orgApiKey',
  clientId: 'mcpDrawer.auth.clientId',
  clientSecret: 'mcpDrawer.auth.clientSecret',
  ssoClientId: 'mcpDrawer.auth.ssoClientId',
  ssoAuthorizeUrl: 'mcpDrawer.auth.ssoAuthorizeUrl',
  ssoTokenUrl: 'mcpDrawer.auth.ssoTokenUrl',
};

/** Map a thrown connector error to a localized message. */
function connectorErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body?.error;
    if (code === 'server_key_taken') return t('mcpDrawer.error.serverKeyTaken');
    if (code === 'sse_oauth_not_supported') return t('mcpDrawer.error.sseOAuth');
    if (code === 'missing_auth_field' && typeof e.body?.field === 'string') {
      return fill(t('mcpDrawer.error.authField'), {
        field: t(FIELD_LABEL[e.body.field] ?? '') || e.body.field,
      });
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export function ConnectorDrawer(p: Props): JSX.Element {
  const toast = useToast();
  const [state, setState] = useState<ConnectorFormState>(() => initState(p.mode, p.connector));
  const [busy, setBusy] = useState(false);
  const [authSwitchOpen, setAuthSwitchOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // The 授权范围 picker modal is up — the drawer's own Esc must not fire then
  // (Esc closes the picker first).
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  // True until the user types anything. Guards the draft re-seed: once the
  // user has edited the form, a (late) draft arriving from the detail fetch
  // must not clobber their in-progress edits.
  const pristineRef = useRef(true);

  // Re-init when the page reuses this drawer for a different connector.
  // (Keyed on the connector id only, so a list refetch while editing does not
  // clobber in-progress form values.)
  const connectorId = p.connector?.id;
  useEffect(() => {
    setState(initState(p.mode, p.connector));
    pristineRef.current = true;
    setBusy(false);
    setAuthSwitchOpen(false);
    setDeleteOpen(false);
    setDeleting(false);
    setVersionsOpen(false);
    setScopePickerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mode, connectorId]);

  // Re-seed the form from the staged draft once the detail fetch lands (edit
  // mode, pristine only): the staged change is what the form should show —
  // and what publish applies — not the live row. A reopen with a draft goes
  // through the re-init effect above (pristine restored) and lands here.
  useEffect(() => {
    const draft = p.draft;
    if (p.mode !== 'edit' || !draft || !pristineRef.current) return;
    setState((s) => applyDraft(s, draft));
  }, [p.draft, p.mode, connectorId]);

  const onChange = (patch: Partial<ConnectorFormState>): void => {
    pristineRef.current = false;
    setState((s) => ({ ...s, ...patch }));
  };

  /** The full working copy (save-draft / publish body): the form state mapped
   * to the wire, with tools from the live connector and the per-tool toggles
   * applied. Secrets are blank = keep the stored ciphertext. */
  const workingCopy = (): ConnectorWorkingCopy => {
    const s = state;
    return {
      ...(p.connector ? { serverKey: p.connector.serverKey } : {}),
      url: s.url.trim(),
      version: s.version.trim() || (p.connector?.version ?? '1.0.0'),
      nameEn: s.nameEn.trim() || null,
      nameZh: s.nameZh.trim() || null,
      categoryId: s.categoryId || null,
      description: s.description.slice(0, DESCRIPTION_MAX).trim() || null,
      transport: s.transport,
      authMode: s.authMode,
      authConfig: buildAuthConfig(s),
      scope: s.scope,
      tools: (p.connector?.tools ?? []).map((tool) => ({
        ...tool,
        enabled: s.toolToggles[tool.name] ?? tool.enabled,
      })),
    };
  };

  // Which stored secrets exist (masked values returned by the admin wire).
  // When a draft is staged, the MASKED draft authConfig is the truth (the
  // draft may have changed the auth mode); both are masked on the wire, so
  // this only ever reads `••••xxxx` markers, never plaintext.
  const hasSecret = useMemo(() => {
    const cfg = p.draft?.authConfig ?? p.connector?.authConfig ?? {};
    return {
      apiKey: typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
      clientSecret: typeof cfg.clientSecret === 'string' && cfg.clientSecret.length > 0,
    };
  }, [p.draft, p.connector]);

  // "Configured by X at T" line (human-readable name + time).
  const secretMeta = useMemo(() => {
    const meta = p.connector?.secretMeta;
    if (!meta?.lastUpdatedAt || !meta.lastUpdatedBy) return null;
    const by = p.members.find((m) => m.id === meta.lastUpdatedBy);
    return {
      by: by?.display_name || by?.username || meta.lastUpdatedBy,
      time: dayjs(meta.lastUpdatedAt).format('YYYY-MM-DD HH:mm'),
    };
  }, [p.connector, p.members]);

  const displayName = state.nameZh.trim() || state.nameEn.trim() || state.serverKey.trim();

  /** Client-side validation; returns a localized error or null. */
  const validate = (): string | null => {
    if (!state.serverKey.trim() || !state.url.trim()) return t('mcpDrawer.error.required');
    if (state.transport === 'sse' && SSE_INCOMPATIBLE_AUTH_MODES.includes(state.authMode)) {
      return t('mcpDrawer.error.sseOAuth');
    }
    if (state.authMode === 'shared-key' && !state.apiKey.trim() && !hasSecret.apiKey) {
      return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.orgApiKey') });
    }
    if (state.authMode === 'user-oauth' || state.authMode === 'client-creds') {
      if (!state.clientId.trim()) {
        return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.clientId') });
      }
      if (state.authMode === 'client-creds') {
        if (!state.clientSecret.trim() && !hasSecret.clientSecret) {
          return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.clientSecret') });
        }
      } else {
        // user-oauth: public client (PKCE) is valid with endpoints + no secret;
        // the confidential client still needs a secret when endpoints are absent.
        const hasPublicEndpoints = Boolean(state.authorizeUrl.trim()) && Boolean(state.tokenUrl.trim());
        if (!hasPublicEndpoints && !state.clientSecret.trim() && !hasSecret.clientSecret) {
          return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.clientSecret') });
        }
      }
    }
    if (state.authMode === 'sso') {
      if (!state.ssoClientId.trim()) {
        return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.ssoClientId') });
      }
      const hasSsoEndpoints = Boolean(state.ssoAuthorizeUrl.trim()) && Boolean(state.ssoTokenUrl.trim());
      if (!hasSsoEndpoints) {
        return fill(t('mcpDrawer.error.authField'), { field: t('mcpDrawer.auth.ssoAuthorizeUrl') });
      }
    }
    return null;
  };

  /** The single submit path: create → POST, edit → publish (the two-step
   * publish-with-version flow; a version bump records a rollback-able row). */
  const doSubmit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const s = state;
      const serverKey = s.serverKey.trim();
      const url = s.url.trim();
      const authConfig = buildAuthConfig(s);
      if (p.mode === 'create') {
        const input: ConnectorInput = {
          serverKey,
          url,
          nameEn: s.nameEn.trim() || undefined,
          nameZh: s.nameZh.trim() || undefined,
          version: s.version.trim() || '1.0.0',
          categoryId: s.categoryId || undefined,
          description: s.description.slice(0, DESCRIPTION_MAX).trim() || undefined,
          transport: s.transport,
          authMode: s.authMode,
          authConfig,
          scope: s.scope,
        };
        // The backend requires `orgId` in the create body; the api client's
        // ConnectorInput type omits it, so it is added here at the boundary.
        await connectorApi.create({ ...input, orgId: p.orgId } as ConnectorInput);
        toast.success(fill(t('mcpDrawer.toast.created'), { name: displayName }));
      } else if (p.connector) {
        const res = await connectorApi.publish(p.connector.id, workingCopy());
        toast.success(fill(t('mcpDrawer.toast.published'), { name: displayName }));
        // The client-side auth-switch confirm already gates a mode change;
        // surface the server's flag too (e.g. a secret rotation on the same
        // mode) so the member impact is not silent.
        if (res.destructiveAuthSwitch) {
          toast.info(t('mcpDrawer.toast.destructiveAuthSwitch'));
        }
      }
      p.onSaved();
    } catch (e) {
      toast.error(connectorErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** 存草稿: stage the working copy (no live effect); the drawer stays open. */
  const onSaveDraft = async (): Promise<void> => {
    if (p.mode !== 'edit' || !p.connector || busy) return;
    setBusy(true);
    try {
      await connectorApi.saveDraft(p.connector.id, workingCopy());
      toast.success(t('mcpDrawer.toast.draftSaved'));
      p.onDraftSaved?.();
    } catch (e) {
      toast.error(connectorErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** 创建并发布 / 发布. Gates a destructive auth-mode change behind a confirm. */
  const onPublish = (): void => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    // Any auth-mode change vs the live row invalidates member authorizations,
    // so publishing it is gated behind a destructive confirm (P0 has no
    // `authUsers` count to refine the gate; the prototype's
    // `authStatus==='configured' && authUsers>0` check maps to this).
    if (p.mode === 'edit' && p.connector && state.authMode !== p.connector.authMode) {
      setAuthSwitchOpen(true);
      return;
    }
    void doSubmit();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!p.connector || deleting) return;
    setDeleting(true);
    try {
      await connectorApi.del(p.connector.id);
      toast.success(fill(t('mcpDrawer.toast.deleted'), { name: displayName }));
      p.onDeleted();
    } catch (e) {
      toast.error(connectorErrorMessage(e));
      setDeleting(false);
    }
  };

  const { onClose } = p;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (authSwitchOpen || deleteOpen || scopePickerOpen) return; // inner dialogs handle their own Esc
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [authSwitchOpen, deleteOpen, scopePickerOpen, onClose]);

  const title =
    p.mode === 'create' ? t('mcpDrawer.create.title') : fill(t('mcpDrawer.edit.title'), { name: displayName });

  return (
    <>
      <aside className="fixed inset-y-0 right-0 z-[101] flex w-[560px] max-w-[94vw] flex-col border-l border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
        <header className="flex items-center justify-between border-b border-[var(--border-default)] p-5">
          <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {p.mode === 'create' && (
            <p className="mb-4 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
              {t('mcpDrawer.create.hint')}
            </p>
          )}
          {/* A draft is staged (per the list row's hasDraft): the form shows
              the staged values; publish applies them to members. It clears
              after a successful publish (the drawer closes) and is absent on
              a reopen with no draft. */}
          {p.mode === 'edit' && p.connector?.hasDraft && (
            <p className="mb-4 rounded-[6px] border border-[#B45309]/30 bg-[var(--bg-tertiary)] px-3 py-2 text-[12.5px] leading-relaxed text-[#B45309]">
              {t('mcp.draft.banner')}
            </p>
          )}

          <ConnectorBasicInfo
            mode={p.mode}
            connectorId={p.connector?.id}
            state={state}
            onChange={onChange}
            categories={p.categories}
            onTested={p.onTested}
          />
          <ConnectorConnConfig
            mode={p.mode}
            state={state}
            onChange={onChange}
            secretMeta={secretMeta}
            hasSecret={hasSecret}
          />
          <ConnectorToolPermissions
            mode={p.mode}
            tools={p.connector?.tools ?? []}
            toolToggles={state.toolToggles}
            onToggle={(name, enabled) => onChange({ toolToggles: { ...state.toolToggles, [name]: enabled } })}
          />

          <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
            <h4 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              {t('mcpDrawer.scope.section')}
            </h4>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
              {p.mode === 'create' ? t('mcpDrawer.scope.hintCreate') : t('mcpDrawer.scope.hintEdit')}
            </p>
            <ConnectorScopeSelector
              value={state.scope}
              onChange={(scope) => onChange({ scope })}
              depts={p.depts}
              members={p.members}
              onOpenChange={setScopePickerOpen}
            />
          </section>

          {p.mode === 'edit' && p.connector && (
            <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
              <button
                type="button"
                onClick={() => setVersionsOpen((o) => !o)}
                className="flex w-full items-center justify-between text-left"
              >
                <h4 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  {t('mcpDrawer.versions.title')}
                </h4>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {versionsOpen ? '▲' : '▼'}
                </span>
              </button>
              {versionsOpen && (
                <div className="mt-2">
                  <ConnectorVersionHistory
                    connectorId={p.connector.id}
                    versions={p.versions ?? []}
                    members={p.members}
                    onInvalidated={() => p.onRolledBack?.()}
                  />
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3">
          {p.mode === 'edit' && (
            <>
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                disabled={busy}
                className="rounded-[6px] border border-[var(--danger-primary)]/40 px-3 py-1.5 text-[13px] text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10 disabled:opacity-50"
              >
                {t('mcp.delete')}
              </button>
              <button
                type="button"
                onClick={() => void onSaveDraft()}
                disabled={busy}
                className="rounded-[6px] border border-[var(--border-default)] px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
              >
                {t('mcpDrawer.footer.saveDraft')}
              </button>
            </>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[6px] border border-[var(--border-default)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {t('mcp.cancel')}
          </button>
          <button
            type="button"
            onClick={onPublish}
            disabled={busy}
            className="rounded-[6px] bg-[var(--accent-primary)] px-3 py-1.5 text-[13px] text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
          >
            {busy ? t('common.loading') : p.mode === 'create' ? t('mcpDrawer.footer.create') : t('mcpDrawer.footer.publish')}
          </button>
        </footer>
      </aside>

      {/* Destructive confirm: publishing an auth-mode change invalidates member authorizations.
          Wrapped in a z-[110] positioned layer so it stacks above the drawer's z-[101] aside —
          ConfirmDialog's own overlay is z-50, which sits behind the drawer and would occlude the
          confirm button on narrow viewports. (Matches DeleteConnectorModal's z-[110] convention.) */}
      <div className="relative z-[110]">
        <ConfirmDialog
          open={authSwitchOpen}
          title={t('mcpDrawer.authSwitch.title')}
          message={
            p.connector
              ? fill(t('mcpDrawer.authSwitch.body'), {
                  from: t(AUTH_MODE_LABEL[p.connector.authMode]),
                  to: t(AUTH_MODE_LABEL[state.authMode]),
                })
              : ''
          }
          confirmLabel={t('mcpDrawer.authSwitch.confirm')}
          cancelLabel={t('mcp.cancel')}
          destructive
          onConfirm={() => {
            setAuthSwitchOpen(false);
            void doSubmit();
          }}
          onCancel={() => setAuthSwitchOpen(false)}
        />
      </div>

      <DeleteConnectorModal
        open={deleteOpen}
        connector={p.connector ?? null}
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
