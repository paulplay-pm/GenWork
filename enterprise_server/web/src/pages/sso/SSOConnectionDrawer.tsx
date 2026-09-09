import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { ssoApi } from '../../api/sso';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { PRESETS, protocolFor } from './presets';
import type { ProviderType, SsoConnection, SsoConnectionInput, SsoProtocol } from './types';

/** The 7 selectable provider types (server enum). */
const PROVIDER_TYPES: ProviderType[] = [
  'generic-oidc',
  'generic-oauth2',
  'azure-ad',
  'feishu',
  'dingtalk',
  'wecom',
  'saml2',
];

/** Single form state for the create/edit drawer. `clientSecret` is ALWAYS
 * blank on load — the masked value is only used for the placeholder (never a
 * pre-filled value); a blank secret on edit means "keep the stored one".
 * The per-connection logo is uploaded via a separate endpoint
 * (POST /admin/sso-connections/:id/logo) and never lives in this form's
 * body; only the edit-mode drawer shows the upload affordance. */
interface SsoFormState {
  name: string;
  providerType: ProviderType;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  identityIdField: string;
  loginNameField: string;
  emailField: string;
  /** Comma-separated text; split on submit. */
  emailDomainWhitelist: string;
  enabled: boolean;
  sortOrder: number;
  /** When enabled, SSO logins without a stored binding are bounced to the
   *  password-verification form. The toggle is only shown in edit (a
   *  connection has to exist before the choice makes sense; create defaults
   *  to false). */
  requirePrebinding: boolean;
}

interface Props {
  mode: 'create' | 'edit';
  /** The caller's own org (from the token claims) — only sent on create. */
  orgId: string;
  /** The loaded (redacted) row in edit mode. */
  connection?: SsoConnection;
  onClose: () => void;
  onSaved: () => void;
}

function initState(mode: 'create' | 'edit', connection: SsoConnection | undefined): SsoFormState {
  if (mode === 'edit' && connection) {
    return {
      name: connection.name,
      providerType: connection.provider_type,
      clientId: connection.client_id ?? '',
      clientSecret: '',
      authorizeUrl: connection.authorize_url ?? '',
      tokenUrl: connection.token_url ?? '',
      userinfoUrl: connection.userinfo_url ?? '',
      scopes: connection.scopes ?? '',
      identityIdField: connection.identity_id_field,
      loginNameField: connection.login_name_field ?? '',
      emailField: connection.email_field,
      emailDomainWhitelist: (connection.email_domain_whitelist ?? []).join(', '),
      enabled: connection.enabled,
      sortOrder: connection.sort_order,
      requirePrebinding: connection.require_prebinding,
    };
  }
  const preset = PRESETS['generic-oidc'];
  return {
    name: '',
    providerType: 'generic-oidc',
    clientId: '',
    clientSecret: '',
    authorizeUrl: preset.authorizeUrl,
    tokenUrl: preset.tokenUrl,
    userinfoUrl: preset.userinfoUrl,
    scopes: preset.scopes,
    identityIdField: preset.identityIdField,
    loginNameField: '',
    emailField: preset.emailField,
    emailDomainWhitelist: '',
    enabled: true,
    sortOrder: 0,
    // Create-mode default follows the new DB default (migration 044):
    // a brand-new connection is strict-by-default. Admins who want the
    // legacy JIT-on-first-login behavior can flip the toggle off in the
    // drawer before saving.
    requirePrebinding: true,
  };
}

/** Map a thrown SSO error to a localized message. */
function ssoErrorMessage(e: unknown): string {
  if (e instanceof ApiError && typeof e.body?.detail === 'string' && e.body.detail) {
    return e.body.detail;
  }
  return e instanceof Error ? e.message : String(e);
}

export function SSOConnectionDrawer(p: Props): JSX.Element {
  const toast = useToast();
  const [state, setState] = useState<SsoFormState>(() => initState(p.mode, p.connection));
  const [busy, setBusy] = useState(false);
  // Per-connection logo upload lives outside the create/patch body, so the
  // drawer's form state does not track it. The row's current `logo_url`
  // (server-relative path or null) is the source of truth; we keep a
  // local mirror so the thumbnail + button state update immediately after
  // upload/clear without a parent refetch. The hidden <input type=file>
  // is triggered programmatically by the "Replace logo…" button.
  const [logoUrl, setLogoUrl] = useState<string | null>(p.connection?.logo_url ?? null);
  const [logoUploading, setLogoUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-init when the page reuses this drawer for a different connection
  // (keyed on the row id so a list refetch while editing does not clobber
  // in-progress form values).
  const connectionId = p.connection?.id;
  useEffect(() => {
    setState(initState(p.mode, p.connection));
    setLogoUrl(p.connection?.logo_url ?? null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mode, connectionId]);

  const onChange = (patch: Partial<SsoFormState>): void => {
    setState((s) => ({ ...s, ...patch }));
  };

  /** Provider-type change pre-fills the preset endpoint/field values
   * (create only — an edit keeps the row's own values). v1 stores saml2
   * rows as stored-but-disabled, so selecting it defaults `enabled` off. */
  const onProviderTypeChange = (pt: ProviderType): void => {
    if (p.mode !== 'create') {
      onChange({ providerType: pt });
      return;
    }
    const preset = PRESETS[pt];
    onChange({
      providerType: pt,
      authorizeUrl: preset.authorizeUrl,
      tokenUrl: preset.tokenUrl,
      userinfoUrl: preset.userinfoUrl,
      scopes: preset.scopes,
      identityIdField: preset.identityIdField,
      emailField: preset.emailField,
      enabled: pt === 'saml2' ? false : state.enabled,
    });
  };

  // The wire protocol: derived from the provider type on create, preserved
  // from the loaded row on edit (the form does not expose it).
  const protocol: SsoProtocol =
    p.mode === 'edit' && p.connection ? p.connection.protocol : protocolFor(state.providerType);

  // Whether the stored row has a secret (drives the "keep existing"
  // placeholder). Masked values are never placed in the input.
  const hasSecret =
    p.connection?.has_secret === true || (typeof p.connection?.client_secret_masked === 'string' && p.connection.client_secret_masked.length > 0);

  /** Map an upload error to a localized message. The server returns a
   *  plain `{ error }` envelope; the message keys are picked to be
   *  user-readable without leaking server internals. */
  const logoErrorMessage = (e: unknown): string => {
    if (e instanceof ApiError) {
      const code = e.body?.error;
      if (code === 'too_large') return t('sso.logo.error.tooLarge');
      if (code === 'unsupported_mime' || code === 'missing_file') return t('sso.logo.error.unsupported');
    }
    return t('sso.logo.error.uploadFailed');
  };

  const onPickFile = (): void => {
    fileInputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // Always reset the input's value so picking the same file twice still
    // fires the change event.
    e.target.value = '';
    if (!file || !p.connection) return;
    if (logoUploading) return;
    setLogoUploading(true);
    try {
      const { logoUrl: newPath } = await ssoApi.uploadLogo(p.connection.id, file);
      setLogoUrl(newPath);
      toast.success(t('sso.logo.replace'));
    } catch (err) {
      toast.error(logoErrorMessage(err));
    } finally {
      setLogoUploading(false);
    }
  };

  const onClearLogo = async (): Promise<void> => {
    if (!p.connection || logoUploading) return;
    setLogoUploading(true);
    try {
      await ssoApi.clearLogo(p.connection.id);
      setLogoUrl(null);
    } catch (err) {
      toast.error(logoErrorMessage(err));
    } finally {
      setLogoUploading(false);
    }
  };

  const doSubmit = async (): Promise<void> => {
    if (busy) return;
    // The prebinding toggle is the one field where flipping it has an
    // externally visible effect (unbound users get bounced to the
    // password-proof page on their next SSO login), so confirm before
    // PATCHing when the value is moving from false → true. False → true
    // is the only direction that warrants a confirmation; disabling the
    // gate is a non-event for already-bound users.
    if (
      p.mode === 'edit' &&
      p.connection &&
      state.requirePrebinding === true &&
      p.connection.require_prebinding === false &&
      !window.confirm(t('sso.connection.requirePrebinding.confirm'))
    ) {
      return;
    }
    setBusy(true);
    try {
      const s = state;
      const input: SsoConnectionInput = {
        name: s.name.trim(),
        providerType: s.providerType,
        protocol,
        authorizeUrl: s.authorizeUrl.trim(),
        tokenUrl: s.tokenUrl.trim(),
        userinfoUrl: s.userinfoUrl.trim(),
        clientId: s.clientId.trim(),
        // Blank = none (create) / keep the stored secret (patch).
        clientSecret: s.clientSecret.trim(),
        scopes: s.scopes.trim(),
        identityIdField: s.identityIdField.trim(),
        loginNameField: s.loginNameField.trim(),
        emailField: s.emailField.trim(),
        emailDomainWhitelist: s.emailDomainWhitelist
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d.length > 0),
        enabled: s.enabled,
        sortOrder: Number.isFinite(s.sortOrder) ? s.sortOrder : 0,
        requirePrebinding: s.requirePrebinding,
      };
      if (p.mode === 'create') {
        await ssoApi.create({ ...input, orgId: p.orgId });
      } else if (p.connection) {
        await ssoApi.patch(p.connection.id, input);
      }
      p.onSaved();
    } catch (e) {
      toast.error(ssoErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const { onClose } = p;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = p.mode === 'create' ? t('sso.create') : t('sso.edit');

  const inputCls =
    'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';
  const req = <span className="text-[var(--danger-primary)]">*</span>;
  const helpCls = 'text-xs text-[var(--text-tertiary)]';

  return (
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
        <div className="grid grid-cols-2 gap-3.5">
          <div className={`col-span-2 ${labelCls}`}>
            {t('sso.name.label')} {req}
            <input
              className={inputCls}
              aria-label={t('sso.name.label')}
              value={state.name}
              onChange={(e) => onChange({ name: e.target.value })}
            />
            <span className={helpCls}>{t('sso.name.help')}</span>
          </div>

          <label className={labelCls}>
            {t('sso.providerType.label')} {req}
            <select
              className={inputCls}
              aria-label={t('sso.providerType.label')}
              value={state.providerType}
              onChange={(e) => onProviderTypeChange(e.target.value as ProviderType)}
            >
              {PROVIDER_TYPES.map((pt) => (
                <option key={pt} value={pt}>
                  {pt}
                </option>
              ))}
            </select>
          </label>
          <div className={labelCls}>
            {t('sso.protocol.label')}
            <input className={inputCls} aria-label={t('sso.protocol.label')} value={protocol} disabled />
          </div>

          <label className={labelCls}>
            {t('sso.clientId.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.clientId.label')}
              value={state.clientId}
              onChange={(e) => onChange({ clientId: e.target.value })}
            />
          </label>
          <label className={labelCls}>
            {t('sso.clientSecret.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.clientSecret.label')}
              type="password"
              value={state.clientSecret}
              placeholder={
                p.mode === 'edit' && hasSecret ? t('sso.clientSecret.keepPlaceholder') : undefined
              }
              onChange={(e) => onChange({ clientSecret: e.target.value })}
            />
          </label>

          <label className={`col-span-2 ${labelCls}`}>
            {t('sso.authorizeUrl.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.authorizeUrl.label')}
              value={state.authorizeUrl}
              onChange={(e) => onChange({ authorizeUrl: e.target.value })}
            />
          </label>
          <label className={`col-span-2 ${labelCls}`}>
            {t('sso.tokenUrl.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.tokenUrl.label')}
              value={state.tokenUrl}
              onChange={(e) => onChange({ tokenUrl: e.target.value })}
            />
          </label>
          <label className={`col-span-2 ${labelCls}`}>
            {t('sso.userinfoUrl.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.userinfoUrl.label')}
              value={state.userinfoUrl}
              onChange={(e) => onChange({ userinfoUrl: e.target.value })}
            />
          </label>
          <label className={`col-span-2 ${labelCls}`}>
            {t('sso.scopes.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.scopes.label')}
              value={state.scopes}
              onChange={(e) => onChange({ scopes: e.target.value })}
            />
          </label>

          <label className={labelCls}>
            {t('sso.identityIdField.label')} {req}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.identityIdField.label')}
              value={state.identityIdField}
              onChange={(e) => onChange({ identityIdField: e.target.value })}
            />
          </label>
          <label className={labelCls}>
            {t('sso.loginNameField.label')}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.loginNameField.label')}
              value={state.loginNameField}
              onChange={(e) => onChange({ loginNameField: e.target.value })}
            />
          </label>

          <label className={labelCls}>
            {t('sso.emailField.label')} {req}
            <input
              className={`${inputCls} font-mono`}
              aria-label={t('sso.emailField.label')}
              value={state.emailField}
              onChange={(e) => onChange({ emailField: e.target.value })}
            />
          </label>
          <div className={labelCls}>
            {t('sso.emailDomainWhitelist.label')}
            <input
              className={inputCls}
              aria-label={t('sso.emailDomainWhitelist.label')}
              value={state.emailDomainWhitelist}
              onChange={(e) => onChange({ emailDomainWhitelist: e.target.value })}
            />
            <span className={helpCls}>{t('sso.emailDomainWhitelist.help')}</span>
          </div>

          <div className={`col-span-2 ${labelCls}`}>
            {t('sso.logo.label')}
            {/* Logo upload lives in the edit drawer only: the row has to
                exist before we have an id to upload under. The server
                stores the file at <stateDir>/sso-logos/uploads/<id>.<ext>
                and returns the server-relative path; the public endpoint
                resolves it to an absolute <img src>. */}
            {p.mode === 'edit' && p.connection ? (
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[6px] border border-[var(--border-subtle)] bg-white">
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt=""
                      className="h-10 w-10 rounded object-contain"
                    />
                  ) : (
                    <span className="text-[10px] font-medium text-[var(--text-tertiary)]">
                      {p.connection.provider_type.slice(0, 3).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={onPickFile}
                      disabled={logoUploading || busy}
                      className="rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    >
                      {logoUploading ? t('sso.logo.uploading') : t('sso.logo.replace')}
                    </button>
                    {logoUrl ? (
                      <button
                        type="button"
                        onClick={() => void onClearLogo()}
                        disabled={logoUploading || busy}
                        className="rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                      >
                        {t('sso.logo.clear')}
                      </button>
                    ) : null}
                  </div>
                  <span className={helpCls}>
                    {logoUrl ? t('sso.logo.help') : t('sso.logo.builtInHint')}
                  </span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={(e) => void onFileChange(e)}
                />
              </div>
            ) : (
              <span className={helpCls}>{t('sso.logo.builtInHint')}</span>
            )}
          </div>

          <label className="col-span-2 flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent-primary)]"
              aria-label={t('sso.enabled.label')}
              checked={state.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            {t('sso.enabled.label')}
          </label>
          <label className={labelCls}>
            {t('sso.sortOrder.label')}
            <input
              className={inputCls}
              aria-label={t('sso.sortOrder.label')}
              type="number"
              value={state.sortOrder}
              onChange={(e) =>
                onChange({ sortOrder: e.target.value === '' ? 0 : Number(e.target.value) })
              }
            />
          </label>

          {p.mode === 'edit' && (
            <div className="col-span-2 flex flex-col gap-1">
              <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent-primary)]"
                  aria-label={t('sso.connection.requirePrebinding')}
                  checked={state.requirePrebinding}
                  onChange={(e) => onChange({ requirePrebinding: e.target.checked })}
                />
                {t('sso.connection.requirePrebinding')}
              </label>
              <p className="text-xs text-[var(--text-tertiary)]">
                {t('sso.connection.requirePrebinding.help')}
              </p>
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3">
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
          onClick={() => void doSubmit()}
          disabled={busy}
          className="rounded-[6px] bg-[var(--accent-primary)] px-3 py-1.5 text-[13px] text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
        >
          {busy ? t('common.loading') : t('mcp.save')}
        </button>
      </footer>
    </aside>
  );
}
