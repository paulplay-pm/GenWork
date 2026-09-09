import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AuthMode6 } from '../../api/connectors';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import type { ConnectorFormState } from './ConnectorDrawer';
import { fill } from './types';

/** SSO app options stored in `authConfig.ssoApp`. */
export const SSO_APP_OPTIONS = ['oidc', 'feishu', 'dingtalk', 'wecom'] as const;

/** Preset OAuth scope list (grouped, from the admin prototype). */
function scopeGroups(): { title: string; scopes: { name: string; desc: string }[] }[] {
  const d = (k: string): string => t(k);
  return [
    {
      title: t('mcpDrawer.auth.scopeGroup.oidc'),
      scopes: [
        { name: 'openid', desc: d('mcpDrawer.auth.scopeDesc.openid') },
        { name: 'profile', desc: d('mcpDrawer.auth.scopeDesc.profile') },
        { name: 'email', desc: d('mcpDrawer.auth.scopeDesc.email') },
        { name: 'offline_access', desc: d('mcpDrawer.auth.scopeDesc.offline_access') },
      ],
    },
    {
      title: t('mcpDrawer.auth.scopeGroup.google'),
      scopes: [
        { name: 'gmail.readonly', desc: d('mcpDrawer.auth.scopeDesc.gmail.readonly') },
        { name: 'gmail.send', desc: d('mcpDrawer.auth.scopeDesc.gmail.send') },
        { name: 'drive', desc: d('mcpDrawer.auth.scopeDesc.drive') },
        { name: 'drive.readonly', desc: d('mcpDrawer.auth.scopeDesc.drive.readonly') },
      ],
    },
    {
      title: t('mcpDrawer.auth.scopeGroup.graph'),
      scopes: [
        { name: 'User.Read', desc: d('mcpDrawer.auth.scopeDesc.User.Read') },
        { name: 'Mail.Read', desc: d('mcpDrawer.auth.scopeDesc.Mail.Read') },
        { name: 'Mail.Send', desc: d('mcpDrawer.auth.scopeDesc.Mail.Send') },
        { name: 'Files.Read.All', desc: d('mcpDrawer.auth.scopeDesc.Files.Read.All') },
      ],
    },
    {
      title: t('mcpDrawer.auth.scopeGroup.salesforce'),
      scopes: [
        { name: 'api', desc: d('mcpDrawer.auth.scopeDesc.api') },
        { name: 'refresh_token', desc: d('mcpDrawer.auth.scopeDesc.refresh_token') },
      ],
    },
    {
      title: t('mcpDrawer.auth.scopeGroup.github'),
      scopes: [
        { name: 'repo', desc: d('mcpDrawer.auth.scopeDesc.repo') },
        { name: 'public_repo', desc: d('mcpDrawer.auth.scopeDesc.public_repo') },
        { name: 'read:org', desc: d('mcpDrawer.auth.scopeDesc.read:org') },
      ],
    },
    {
      title: t('mcpDrawer.auth.scopeGroup.slack'),
      scopes: [
        { name: 'chat:write', desc: d('mcpDrawer.auth.scopeDesc.chat:write') },
        { name: 'channels:read', desc: d('mcpDrawer.auth.scopeDesc.channels:read') },
      ],
    },
    {
      title: t('mcpDrawer.auth.scopeGroup.jira'),
      scopes: [
        { name: 'read:jira-work', desc: d('mcpDrawer.auth.scopeDesc.read:jira-work') },
        { name: 'write:jira-work', desc: d('mcpDrawer.auth.scopeDesc.write:jira-work') },
      ],
    },
  ];
}

interface Props {
  mode: 'create' | 'edit';
  authMode: AuthMode6;
  state: ConnectorFormState;
  onChange: (patch: Partial<ConnectorFormState>) => void;
  hasSecret: { apiKey: boolean; clientSecret: boolean };
  /** Pre-formatted secret metadata (null in create mode). */
  secretMeta: { by: string; time: string } | null;
}

/** Mode-specific auth fields rendered under the auth-mode select. Secrets are
 * blank inputs with a masked placeholder; a blank secret on submit means "keep
 * the stored value" (backend encrypt-at-write). */
export function ConnectorAuthFields(p: Props): JSX.Element {
  const toast = useToast();
  const [scopePopOpen, setScopePopOpen] = useState(false);
  const [scopeSearch, setScopeSearch] = useState('');
  const [customScope, setCustomScope] = useState('');
  const [copied, setCopied] = useState(false);

  // Reset popover/transient state when the mode (and thus the block) changes.
  useEffect(() => {
    setScopePopOpen(false);
    setScopeSearch('');
    setCustomScope('');
    setCopied(false);
  }, [p.authMode]);

  const inputCls =
    'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';
  const req = <span className="text-[var(--danger-primary)]">*</span>;

  const metaLine = (visible: boolean): JSX.Element | null =>
    visible && p.secretMeta ? (
      <div className="mt-1.5 rounded-[6px] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
        {fill(t('mcpDrawer.secret.meta'), { by: p.secretMeta.by, time: p.secretMeta.time })}
      </div>
    ) : null;

  const toggleScope = (name: string): void => {
    p.onChange({
      scopes: p.state.scopes.includes(name)
        ? p.state.scopes.filter((s) => s !== name)
        : [...p.state.scopes, name],
    });
  };

  const addCustomScope = (): void => {
    const v = customScope.trim();
    if (!v) {
      toast.error(t('mcpDrawer.auth.scope.required'));
      return;
    }
    if (!p.state.scopes.includes(v)) p.onChange({ scopes: [...p.state.scopes, v] });
    setCustomScope('');
  };

  const copyCallback = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(p.state.callbackUrl)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  if (p.authMode === 'none') {
    return (
      <div className="rounded-[7px] border border-[var(--warning-primary)]/40 bg-[var(--warning-light)] px-3 py-2.5 text-[13px] leading-relaxed text-[#92400E]">
        {t('mcpDrawer.auth.none.warn')}
      </div>
    );
  }

  if (p.authMode === 'shared-key') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.orgApiKey')} {req}
          <input
            type="password"
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.orgApiKey')}
            placeholder={
              p.mode === 'edit' && p.hasSecret.apiKey
                ? t('mcpDrawer.secret.keepPlaceholder')
                : t('mcpDrawer.auth.orgApiKey.placeholder')
            }
            value={p.state.apiKey}
            onChange={(e) => p.onChange({ apiKey: e.target.value })}
          />
        </label>
        {metaLine(p.hasSecret.apiKey)}
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>
          {t('mcpDrawer.auth.orgApiKey.hint')}
        </p>
      </div>
    );
  }

  if (p.authMode === 'user-key') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.userKeyHeaderName')}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.userKeyHeaderName')}
            placeholder={t('mcpDrawer.auth.userKeyHeaderName.placeholder')}
            value={p.state.apiKeyHeaderName}
            onChange={(e) => p.onChange({ apiKeyHeaderName: e.target.value })}
          />
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.userKeyHeaderName.hint')}</span>
        </label>
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>{t('mcpDrawer.auth.userKey.note')}</p>
      </div>
    );
  }

  if (p.authMode === 'client-creds') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.tokenUrl')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.tokenUrl')}
            placeholder={t('mcpDrawer.auth.tokenUrl.placeholder')}
            value={p.state.tokenUrl}
            onChange={(e) => p.onChange({ tokenUrl: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.clientId')} {req}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.clientId')}
            placeholder={t('mcpDrawer.auth.clientId.placeholder')}
            value={p.state.clientId}
            onChange={(e) => p.onChange({ clientId: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.clientSecret')} {req}
          <input
            type="password"
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.clientSecret')}
            placeholder={
              p.mode === 'edit' && p.hasSecret.clientSecret
                ? t('mcpDrawer.secret.keepPlaceholder')
                : t('mcpDrawer.auth.clientSecret.placeholder')
            }
            value={p.state.clientSecret}
            onChange={(e) => p.onChange({ clientSecret: e.target.value })}
          />
        </label>
        {metaLine(p.hasSecret.clientSecret)}
      </div>
    );
  }

  if (p.authMode === 'sso') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.ssoApp')} {req}
          <select
            className={inputCls}
            aria-label={t('mcpDrawer.auth.ssoApp')}
            value={p.state.ssoApp}
            onChange={(e) => p.onChange({ ssoApp: e.target.value })}
          >
            {SSO_APP_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {t(`mcpDrawer.auth.sso.${v}`)}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.sso.hint')}</span>
        </label>
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.ssoAuthorizeUrl')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.ssoAuthorizeUrl')}
            placeholder={t('mcpDrawer.auth.ssoAuthorizeUrl.placeholder')}
            value={p.state.ssoAuthorizeUrl}
            onChange={(e) => p.onChange({ ssoAuthorizeUrl: e.target.value })}
          />
        </label>
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.ssoTokenUrl')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.ssoTokenUrl')}
            placeholder={t('mcpDrawer.auth.ssoTokenUrl.placeholder')}
            value={p.state.ssoTokenUrl}
            onChange={(e) => p.onChange({ ssoTokenUrl: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.ssoClientId')} {req}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.ssoClientId')}
            placeholder={t('mcpDrawer.auth.ssoClientId.placeholder')}
            value={p.state.ssoClientId}
            onChange={(e) => p.onChange({ ssoClientId: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.ssoClientSecret')}
          <input
            type="password"
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.ssoClientSecret')}
            placeholder={t('mcpDrawer.auth.ssoClientSecret.placeholder')}
            value={p.state.ssoClientSecret}
            onChange={(e) => p.onChange({ ssoClientSecret: e.target.value })}
          />
        </label>
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>{t('mcpDrawer.auth.ssoPublicHint')}</p>
      </div>
    );
  }

  // user-oauth
  const q = scopeSearch.trim().toLowerCase();
  const groups = scopeGroups().map((g) => ({
    ...g,
    scopes: g.scopes.filter((s) => !q || s.name.toLowerCase().includes(q)),
  }));

  return (
    <div className="grid grid-cols-2 gap-3.5">
      <label className={`col-span-2 ${labelCls}`}>
        {t('mcpDrawer.auth.callbackUrl')}
        <div className="flex gap-2">
          <input
            className={`${inputCls} min-w-0 flex-1 bg-[var(--success-light)] font-mono text-[#047857]`}
            aria-label={t('mcpDrawer.auth.callbackUrl')}
            value={p.state.callbackUrl}
            readOnly
          />
          <button
            type="button"
            onClick={copyCallback}
            className="shrink-0 rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            {copied ? t('mcpDrawer.auth.copied') : t('mcpDrawer.auth.copy')}
          </button>
        </div>
        <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.callbackUrl.hint')}</span>
      </label>

      <label className={labelCls}>
        {t('mcpDrawer.auth.authorizeUrl')} {req}
        <input
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.authorizeUrl')}
          placeholder={t('mcpDrawer.auth.authorizeUrl.placeholder')}
          value={p.state.authorizeUrl}
          onChange={(e) => p.onChange({ authorizeUrl: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        {t('mcpDrawer.auth.tokenUrl')} {req}
        <input
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.tokenUrl')}
          placeholder={t('mcpDrawer.auth.tokenUrl.placeholder')}
          value={p.state.tokenUrl}
          onChange={(e) => p.onChange({ tokenUrl: e.target.value })}
        />
      </label>

      <label className={labelCls}>
        {t('mcpDrawer.auth.clientId')} {req}
        <input
          className={inputCls}
          aria-label={t('mcpDrawer.auth.clientId')}
          placeholder={t('mcpDrawer.auth.clientId.placeholder')}
          value={p.state.clientId}
          onChange={(e) => p.onChange({ clientId: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        {t('mcpDrawer.auth.clientSecret')} {req}
        <input
          type="password"
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.clientSecret')}
          placeholder={
            p.mode === 'edit' && p.hasSecret.clientSecret
              ? t('mcpDrawer.secret.keepPlaceholder')
              : t('mcpDrawer.auth.clientSecret.placeholder')
          }
          value={p.state.clientSecret}
          onChange={(e) => p.onChange({ clientSecret: e.target.value })}
        />
      </label>
      {metaLine(p.hasSecret.clientSecret)}

      <div className={`col-span-2 ${labelCls}`}>
        {t('mcpDrawer.auth.scopes')}
        <div className="relative">
          <button
            type="button"
            onClick={() => setScopePopOpen((o) => !o)}
            className="flex min-h-[42px] w-full flex-wrap items-center gap-1.5 rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2 text-left"
            aria-label={t('mcpDrawer.auth.scopes')}
          >
            {p.state.scopes.length === 0 ? (
              <span className="text-[12.5px] text-[var(--text-tertiary)]">
                {t('mcpDrawer.auth.scopes')}
              </span>
            ) : (
              p.state.scopes.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-[5px] bg-[var(--accent-light)] px-2 py-0.5 font-mono text-[12px] text-[var(--accent-primary)]"
                >
                  {s}
                  <span
                    role="button"
                    aria-label={`${s} ×`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleScope(s);
                    }}
                    className="cursor-pointer opacity-60 hover:opacity-100"
                  >
                    ×
                  </span>
                </span>
              ))
            )}
          </button>
          {scopePopOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setScopePopOpen(false)} />
              <div className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-[340px] w-full overflow-y-auto rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2 shadow-lg">
                <input
                  className={`${inputCls} mb-2`}
                  placeholder={t('mcpDrawer.auth.scope.search')}
                  value={scopeSearch}
                  onChange={(e) => setScopeSearch(e.target.value)}
                />
                <div className="flex gap-1.5 px-1 pb-2">
                  <input
                    className={`${inputCls} flex-1 font-mono`}
                    placeholder={t('mcpDrawer.auth.scope.customPlaceholder')}
                    value={customScope}
                    onChange={(e) => setCustomScope(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomScope();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={addCustomScope}
                    className="shrink-0 rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[12.5px] hover:bg-[var(--bg-tertiary)]"
                  >
                    {t('mcpDrawer.auth.scope.add')}
                  </button>
                </div>
                {groups.map(
                  (g) =>
                    g.scopes.length > 0 && (
                      <div key={g.title}>
                        <div className="px-1 py-1 text-[11.5px] font-semibold text-[var(--text-tertiary)]">
                          {g.title}
                        </div>
                        {g.scopes.map((s) => {
                          const selected = p.state.scopes.includes(s.name);
                          return (
                            <button
                              type="button"
                              key={s.name}
                              onClick={() => toggleScope(s.name)}
                              className={`flex w-full items-center justify-between gap-3 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] ${
                                selected
                                  ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
                                  : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                              }`}
                            >
                              <b className="font-mono">{s.name}</b>
                              <span className="text-right text-[11.5px] text-[var(--text-tertiary)]">
                                {s.desc}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ),
                )}
              </div>
            </>
          )}
        </div>
        <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.scopes.hint')}</span>
      </div>
    </div>
  );
}
