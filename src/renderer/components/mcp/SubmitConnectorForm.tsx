import React, { useEffect, useMemo, useState } from 'react';

import { type ConnectorSubmitRequest } from '../../../shared/mcp/constants';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { McpEnterpriseMarketCategory } from '../../types/mcp';
import Modal from '../common/Modal';

/**
 * Member 「申请连接器」 dialog (enterprise market tab).
 *
 * Collects a connector config and submits it to the org review queue via
 * `mcpService.submitConnectorRequest` (POST /admin/mcp-connectors/submissions
 * with the org JWT). The server re-runs the create guards on submit, so the
 * form only pre-validates the cheap client-side bits (server key format, URL
 * presence, per-auth-mode required secret) and lets server errors surface as
 * toasts. Kept out of `McpManager` — that component is already large.
 */

const SERVER_KEY_RE = /^[a-z0-9-]+$/;
const DESCRIPTION_MAX = 200;

const AUTH_MODES = ['none', 'shared-key', 'user-key', 'user-oauth', 'client-creds', 'sso'] as const;
type AuthMode = (typeof AUTH_MODES)[number];

// SSO is org/admin-level config (endpoints set in the admin console), so members
// cannot propose an SSO connector here; the server still rejects sso submissions
// via missingAuthField as a safety net.
const SUBMIT_AUTH_MODES = AUTH_MODES.filter((m) => m !== 'sso');

const AUTH_MODE_LABEL_KEYS: Record<AuthMode, string> = {
  none: 'mcpSubmitAuthNone',
  'shared-key': 'mcpSubmitAuthSharedKey',
  'user-key': 'mcpSubmitAuthUserKey',
  'user-oauth': 'mcpSubmitAuthUserOAuth',
  'client-creds': 'mcpSubmitAuthClientCreds',
  sso: 'mcpSubmitAuthSso',
};

/** Per-mode required secret fields — mirrors the server's `missingAuthField`
 * (a submit that omits one of these 400s with `missing_auth_field`). */
const AUTH_REQUIRED_FIELDS: Record<AuthMode, string[]> = {
  none: [],
  'shared-key': ['apiKey'],
  'user-key': [],
  'user-oauth': ['clientId', 'clientSecret'],
  'client-creds': ['clientId', 'clientSecret'],
  sso: [],
};

/** The server 400s `sse_oauth_not_supported` for sse + these modes
 * (mirrors the server's `sseOauthCombination`). */
const SSE_INCOMPATIBLE_AUTH_MODES: readonly AuthMode[] = ['user-oauth', 'client-creds', 'sso'];

const FIELD_LABEL_KEYS: Record<string, string> = {
  apiKey: 'mcpSubmitApiKey',
  clientId: 'mcpSubmitClientId',
  clientSecret: 'mcpSubmitClientSecret',
};

interface FormState {
  serverKey: string;
  url: string;
  nameEn: string;
  nameZh: string;
  version: string;
  categoryId: string; // '' = no category
  description: string;
  transport: 'http' | 'sse';
  authMode: AuthMode;
  apiKey: string;
  clientId: string;
  clientSecret: string;
}

const INITIAL_FORM: FormState = {
  serverKey: '',
  url: '',
  nameEn: '',
  nameZh: '',
  version: '1.0.0',
  categoryId: '',
  description: '',
  transport: 'http',
  authMode: 'none',
  apiKey: '',
  clientId: '',
  clientSecret: '',
};

interface SubmitConnectorFormProps {
  open: boolean;
  categories: McpEnterpriseMarketCategory[];
  onClose: () => void;
  /** Called after a successful submit (the marketplace may have changed). */
  onSubmitted?: () => void;
}

const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const FIELD_INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60';

const FieldLabel: React.FC<{ htmlFor: string; children: React.ReactNode }> = ({
  htmlFor,
  children,
}) => (
  <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-secondary">
    {children}
  </label>
);

const SubmitConnectorForm: React.FC<SubmitConnectorFormProps> = ({
  open,
  categories,
  onClose,
  onSubmitted,
}) => {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fresh form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setForm(INITIAL_FORM);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const requiredAuthFields = useMemo(
    () => AUTH_REQUIRED_FIELDS[form.authMode],
    [form.authMode],
  );
  const missingAuthFields = useMemo(
    () => requiredAuthFields.filter((field) => !(form[field as keyof FormState] as string).trim()),
    [requiredAuthFields, form],
  );

  const submit = async (): Promise<void> => {
    const key = form.serverKey.trim();
    if (!key) {
      setError(i18nService.t('mcpSubmitKeyRequired'));
      return;
    }
    if (!SERVER_KEY_RE.test(key)) {
      setError(i18nService.t('mcpSubmitKeyInvalid'));
      return;
    }
    if (!form.url.trim()) {
      setError(i18nService.t('mcpUrlRequired'));
      return;
    }
    if (form.transport === 'sse' && SSE_INCOMPATIBLE_AUTH_MODES.includes(form.authMode)) {
      setError(i18nService.t('mcpSubmitSseOAuthUnsupported'));
      return;
    }
    if (missingAuthFields.length > 0) {
      const names = missingAuthFields
        .map((field) => i18nService.t(FIELD_LABEL_KEYS[field] ?? field))
        .join(' / ');
      setError(i18nService.t('mcpSubmitAuthFieldMissing').replace('{fields}', names));
      return;
    }

    setSubmitting(true);
    setError(null);

    // Build the cfg the server's `connectorCfgSchema` expects (no orgId —
    // the org comes from the caller's JWT). Secrets are sent as typed: the
    // server stores the cfg and encrypts them when the connector is built.
    const authConfig: Record<string, unknown> = {};
    if (form.authMode === 'shared-key') authConfig.apiKey = form.apiKey.trim();
    if (form.authMode === 'user-oauth' || form.authMode === 'client-creds') {
      authConfig.clientId = form.clientId.trim();
      authConfig.clientSecret = form.clientSecret.trim();
    }
    const cfg: ConnectorSubmitRequest = {
      serverKey: key,
      url: form.url.trim(),
      version: form.version.trim() || '1.0.0',
      categoryId: form.categoryId || null,
      transport: form.transport,
      authMode: form.authMode,
      authConfig,
      // Minimal scope for P1: available to the whole company; the admin can
      // narrow it when the connector is published.
      scope: { allCompany: true },
    };
    if (form.nameEn.trim()) cfg.nameEn = form.nameEn.trim();
    if (form.nameZh.trim()) cfg.nameZh = form.nameZh.trim();
    if (form.description.trim()) cfg.description = form.description.trim();

    try {
      await mcpService.submitConnectorRequest(cfg);
      toast(i18nService.t('mcpSubmitConnectorSuccess'));
      onSubmitted?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // 403 = the org's member-submissions toggle is off; anything else
      // (400 guard violation, network) is a generic failure.
      toast(message.includes('http 403')
        ? i18nService.t('mcpSubmitConnectorDisabled')
        : i18nService.t('mcpSubmitConnectorFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const lang = i18nService.getLanguage();

  return (
    <Modal isOpen={open} onClose={onClose} onEscape={onClose} className="w-full max-w-md bg-surface rounded-2xl shadow-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">
          {i18nService.t('mcpSubmitConnectorTitle')}
        </h2>
        <p className="mt-1 text-xs text-secondary">
          {i18nService.t('mcpSubmitConnectorHint')}
        </p>
      </div>
      <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <FieldLabel htmlFor="mcp-submit-key">{i18nService.t('mcpSubmitKey')}</FieldLabel>
            <input
              id="mcp-submit-key"
              type="text"
              value={form.serverKey}
              onChange={(e) => set('serverKey', e.target.value)}
              placeholder={i18nService.t('mcpSubmitKeyPlaceholder')}
              className={`${FIELD_INPUT_CLASS} font-mono`}
            />
          </div>
          <div className="col-span-2">
            <FieldLabel htmlFor="mcp-submit-url">{i18nService.t('mcpUrl')}</FieldLabel>
            <input
              id="mcp-submit-url"
              type="text"
              value={form.url}
              onChange={(e) => set('url', e.target.value)}
              placeholder={i18nService.t('mcpUrlPlaceholder')}
              className={`${FIELD_INPUT_CLASS} font-mono`}
            />
          </div>
          <div>
            <FieldLabel htmlFor="mcp-submit-name-en">{i18nService.t('mcpSubmitNameEn')}</FieldLabel>
            <input
              id="mcp-submit-name-en"
              type="text"
              value={form.nameEn}
              onChange={(e) => set('nameEn', e.target.value)}
              className={FIELD_INPUT_CLASS}
            />
          </div>
          <div>
            <FieldLabel htmlFor="mcp-submit-name-zh">{i18nService.t('mcpSubmitNameZh')}</FieldLabel>
            <input
              id="mcp-submit-name-zh"
              type="text"
              value={form.nameZh}
              onChange={(e) => set('nameZh', e.target.value)}
              className={FIELD_INPUT_CLASS}
            />
          </div>
          <div>
            <FieldLabel htmlFor="mcp-submit-version">{i18nService.t('mcpSubmitVersion')}</FieldLabel>
            <input
              id="mcp-submit-version"
              type="text"
              value={form.version}
              onChange={(e) => set('version', e.target.value)}
              className={FIELD_INPUT_CLASS}
            />
          </div>
          <div>
            <FieldLabel htmlFor="mcp-submit-category">{i18nService.t('mcpSubmitCategory')}</FieldLabel>
            <select
              id="mcp-submit-category"
              value={form.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
              className={FIELD_INPUT_CLASS}
            >
              <option value="">{i18nService.t('mcpSubmitCategoryNone')}</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {lang === 'zh' ? cat.name_zh : cat.name_en}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <FieldLabel htmlFor="mcp-submit-description">{i18nService.t('mcpSubmitDescription')}</FieldLabel>
            <textarea
              id="mcp-submit-description"
              value={form.description}
              onChange={(e) => set('description', e.target.value.slice(0, DESCRIPTION_MAX))}
              placeholder={i18nService.t('mcpSubmitDescriptionPlaceholder')}
              rows={3}
              className={`${FIELD_INPUT_CLASS} resize-none`}
            />
          </div>
          <div>
            <FieldLabel htmlFor="mcp-submit-transport">{i18nService.t('mcpSubmitTransport')}</FieldLabel>
            <select
              id="mcp-submit-transport"
              value={form.transport}
              onChange={(e) => set('transport', e.target.value as 'http' | 'sse')}
              className={FIELD_INPUT_CLASS}
            >
              <option value="http">{i18nService.t('mcpTransportHttp')}</option>
              <option value="sse">{i18nService.t('mcpTransportSse')}</option>
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="mcp-submit-auth-mode">{i18nService.t('mcpSubmitAuthMode')}</FieldLabel>
            <select
              id="mcp-submit-auth-mode"
              value={form.authMode}
              onChange={(e) => set('authMode', e.target.value as AuthMode)}
              className={FIELD_INPUT_CLASS}
            >
              {SUBMIT_AUTH_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {i18nService.t(AUTH_MODE_LABEL_KEYS[mode])}
                </option>
              ))}
            </select>
          </div>
          {requiredAuthFields.map((field) => (
            <div key={field}>
              <FieldLabel htmlFor={`mcp-submit-${field}`}>{i18nService.t(FIELD_LABEL_KEYS[field])}</FieldLabel>
              <input
                id={`mcp-submit-${field}`}
                type={field === 'clientSecret' || field === 'apiKey' ? 'password' : 'text'}
                value={form[field as keyof FormState] as string}
                onChange={(e) => set(field as keyof FormState, e.target.value)}
                className={`${FIELD_INPUT_CLASS} font-mono`}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-secondary">
          {i18nService.t('mcpSubmitScopeHint')}
        </p>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? i18nService.t('mcpSubmitSubmitting') : i18nService.t('mcpSubmitConnector')}
        </button>
      </div>
    </Modal>
  );
};

export default SubmitConnectorForm;
