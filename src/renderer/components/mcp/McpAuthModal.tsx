import React, { useEffect, useState } from 'react';

import { McpAuthMethod } from '../../../shared/mcp/constants';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { McpServerConfig } from '../../types/mcp';
import Modal from '../common/Modal';
import {
  buildSaveCredentialPayload,
  getAuthDotClass,
  mapProbeResultToUiState,
  type McpAuthProbeResult,
  type McpAuthUiState,
} from './mcpAuthModalHelpers';

interface McpAuthModalProps {
  server: McpServerConfig;
  mode: 'connect' | 'reauthorize';
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Auto-close delay after a successful probe so the user has time to see the
 * green pill before the modal disappears. Matches the brief.
 */
const SUCCESS_AUTO_CLOSE_MS = 600;

const inputClass =
  'w-full px-3 py-2 text-sm rounded-lg bg-background text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary';

const pillBaseClass =
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium';

const McpAuthModal: React.FC<McpAuthModalProps> = ({
  server,
  mode,
  onClose,
  onSuccess,
}) => {
  const [bearerValue, setBearerValue] = useState('');
  const [apiKeyName, setApiKeyName] = useState(server.apiKeyHeaderName?.trim() || 'X-Api-Key');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uiState, setUiState] = useState<McpAuthUiState | null>(null);

  const authMethod = server.authMethod;

  // Reset form state whenever the modal opens for a new server.
  useEffect(() => {
    setBearerValue('');
    setApiKeyValue('');
    setUiState(null);
    setSubmitting(false);
    // The header NAME defaults from the persisted admin-configured value
    // (or X-Api-Key when absent); the header VALUE is always user-entered.
    setApiKeyName(server.apiKeyHeaderName?.trim() || 'X-Api-Key');
  }, [server.id]);

  const handleSubmit = async () => {
    if (submitting) return;
    const payload = buildSaveCredentialPayload(authMethod, {
      bearer: bearerValue,
      headerName: apiKeyName,
      value: apiKeyValue,
      serverKey: server.serverKey,
      oauthConfig: server.oauthConfig,
    });
    if (!payload) {
      setUiState({
        kind: 'missing-credential',
        message:
          authMethod === McpAuthMethod.OAuth
            ? i18nService.t('mcpAuthOAuthNotConfigured')
            : i18nService.t('mcpAuthFailedMissing'),
      });
      return;
    }
    setSubmitting(true);
    setUiState(null);
    const saveRes = await mcpService.saveCredential(server.id, payload);
    if (!saveRes.ok) {
      setUiState(mapProbeResultToUiState(null, saveRes.error ?? i18nService.t('mcpAuthFailedConnect')));
      setSubmitting(false);
      return;
    }
    const probeRes = await mcpService.probeAuthorization(server.id);
    const probe = probeRes.result as McpAuthProbeResult | undefined;
    const next = mapProbeResultToUiState(probe, null);
    setUiState(next);
    setSubmitting(false);
    if (next.kind === 'success') {
      window.setTimeout(() => onSuccess(), SUCCESS_AUTO_CLOSE_MS);
    }
  };

  const modalTitle = mode === 'reauthorize'
    ? i18nService.t('mcpAuthReauthorize')
    : i18nService.t('mcpAuthConnect');

  const renderAuthMethodFields = () => {
    if (authMethod === McpAuthMethod.None) {
      return (
        <p className="text-sm text-secondary">
          {i18nService.t('mcpAuthNoMethod')}
        </p>
      );
    }
    if (authMethod === McpAuthMethod.Bearer) {
      return (
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold tracking-wide text-secondary">
            {i18nService.t('mcpAuthFieldBearer')}
          </span>
          <input
            type="password"
            value={bearerValue}
            onChange={(event) => setBearerValue(event.target.value)}
            autoFocus
            className={inputClass}
          />
        </label>
      );
    }
    if (authMethod === McpAuthMethod.ApiKey) {
      return (
        <>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold tracking-wide text-secondary">
              {i18nService.t('mcpAuthFieldApiKeyName')}
            </span>
            <input
              type="text"
              value={apiKeyName}
              onChange={(event) => setApiKeyName(event.target.value)}
              placeholder="X-Api-Key"
              autoFocus
              className={inputClass}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold tracking-wide text-secondary">
              {i18nService.t('mcpAuthFieldApiKeyValue')}
            </span>
            <input
              type="password"
              value={apiKeyValue}
              onChange={(event) => setApiKeyValue(event.target.value)}
              className={inputClass}
            />
          </label>
        </>
      );
    }
    if (authMethod === McpAuthMethod.OAuth) {
      if (server.serverKey && !server.oauthConfig) {
        return (
          <div className="space-y-1.5">
            <span className="text-xs font-semibold tracking-wide text-secondary">
              {i18nService.t('mcpAuthFieldOAuthProvider')}
            </span>
            <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-secondary">
              {i18nService.t('mcpAuthOAuthNotConfigured')}
            </p>
          </div>
        );
      }
      return (
        <div className="space-y-1.5">
          <span className="text-xs font-semibold tracking-wide text-secondary">
            {i18nService.t('mcpAuthFieldOAuthProvider')}
          </span>
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
            {server.name}
          </p>
        </div>
      );
    }
    return null;
  };

  const renderResultPill = () => {
    if (!uiState) return null;
    if (uiState.kind === 'success') {
      return (
        <div className={`${pillBaseClass} bg-green-500/10 text-green-600 dark:text-green-400`}>
          {i18nService.t('mcpAuthSuccess')}
        </div>
      );
    }
    const messageKey =
      uiState.kind === 'unauthorized'
        ? 'mcpAuthFailedUnauthorized'
        : uiState.kind === 'missing-credential' || uiState.kind === 'missing-save'
          ? 'mcpAuthFailedMissing'
          : 'mcpAuthFailedConnect';
    return (
      <div className={`${pillBaseClass} bg-red-500/10 text-red-600 dark:text-red-400`}>
        <span className="text-red-500 dark:text-red-400">{i18nService.t('mcpAuthProbeFailed')}:</span>
        <span>{i18nService.t(messageKey)}</span>
        {uiState.message && uiState.kind !== 'unauthorized' && uiState.kind !== 'missing-credential' && uiState.kind !== 'missing-save' && (
          <span className="text-secondary">· {uiState.message}</span>
        )}
      </div>
    );
  };

  const showRetry = uiState !== null && uiState.kind !== 'success' && !submitting;
  const dotClass = getAuthDotClass(server.authStatus, server.enabled);

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
    >
      <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
        {dotClass && (
          <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
        )}
        <span>{modalTitle}</span>
      </div>
      <p className="mt-1 text-xs text-secondary">
        {server.name}
      </p>

      <div className="mt-4 space-y-3">
        {renderAuthMethodFields()}
        {renderResultPill()}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {i18nService.t(uiState?.kind === 'success' ? 'close' : 'mcpAuthCancel')}
        </button>
        {showRetry && (
          <button
            type="button"
            onClick={handleSubmit}
            className="px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            {i18nService.t('mcpAuthRetry')}
          </button>
        )}
        {!showRetry && authMethod !== McpAuthMethod.None && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting
              ? i18nService.t('mcpQichachaConnecting')
              : i18nService.t('mcpAuthSubmit')}
          </button>
        )}
      </div>
    </Modal>
  );
};

export default McpAuthModal;
