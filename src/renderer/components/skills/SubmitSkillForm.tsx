import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { buildSkillSubmitRequest, skillService } from '../../services/skill';
import Modal from '../common/Modal';

/**
 * Member 「添加技能」 dialog (enterprise marketplace tab).
 *
 * Collects a skill package (a `.zip`, read as base64) plus an optional
 * description and an `allCompany` toggle, and submits it to the org review
 * queue via `skillService.submitSkill` (POST /api/admin/skill-marketplace/
 * submissions with the org JWT). The member's suggested scope is advisory —
 * the desktop has no dept-tree UI, so the form only offers `allCompany`;
 * the admin re-scopes (sanitizing) when the submission is approved. Kept
 * out of `SkillsManager` — that component is already large.
 */

/** Server-side guard (`MAX_ZIP_BYTES` in enterprise_server `skillZip`). */
const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const DESCRIPTION_MAX = 200;
const ZIP_FILE_RE = /\.zip$/i;

const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

/** Chunked `btoa` — a single `String.fromCharCode(...bytes)` call over a
 * large buffer overflows the call stack. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(arrayBufferToBase64(reader.result as ArrayBuffer));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('failed to read file'));
    };
    reader.readAsArrayBuffer(file);
  });
}

const FIELD_INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60';

interface SubmitSkillFormProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful submit (the marketplace may have changed). */
  onSubmitted?: () => void;
}

const SubmitSkillForm: React.FC<SubmitSkillFormProps> = ({
  open,
  onClose,
  onSubmitted,
}) => {
  const [zipBase64, setZipBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [desc, setDesc] = useState<string>('');
  const [allCompany, setAllCompany] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fresh form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setZipBase64(null);
      setFileName('');
      setDesc('');
      setAllCompany(true);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const handleFilePicked = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Always allow re-picking the same file by resetting the input.
    event.target.value = '';
    if (!file) return;
    if (!ZIP_FILE_RE.test(file.name)) {
      setError(i18nService.t('skillSubmitFileInvalid'));
      return;
    }
    if (file.size > MAX_ZIP_BYTES) {
      setError(i18nService.t('skillSubmitFileTooLarge'));
      return;
    }
    setError(null);
    try {
      const base64 = await readFileAsBase64(file);
      setZipBase64(base64);
      setFileName(file.name);
    } catch {
      setError(i18nService.t('skillSubmitFailed'));
    }
  };

  const submit = async (): Promise<void> => {
    if (!zipBase64) {
      setError(i18nService.t('skillSubmitFileRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const req = buildSkillSubmitRequest({ desc, allCompany, zipBase64 });
      await skillService.submitSkill(req);
      toast(i18nService.t('skillSubmitSuccess'));
      onSubmitted?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // 403 = the org's member-submissions toggle is off; anything else
      // (400/413 zip validation, network) is a generic failure.
      toast(message.includes('http 403')
        ? i18nService.t('skillSubmitDisabled')
        : i18nService.t('skillSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} onEscape={onClose} className="w-full max-w-md bg-surface rounded-2xl shadow-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">
          {i18nService.t('skillSubmitTitle')}
        </h2>
        <p className="mt-1 text-xs text-secondary">
          {i18nService.t('skillSubmitHint')}
        </p>
      </div>
      <div className="px-5 py-4 space-y-3">
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
        <div>
          <label htmlFor="skill-submit-file" className="mb-1 block text-xs font-medium text-secondary">
            {i18nService.t('skillSubmitFile')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="skill-submit-file"
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => { void handleFilePicked(e); }}
            />
            <input
              type="text"
              readOnly
              value={fileName}
              placeholder={i18nService.t('skillSubmitFilePlaceholder')}
              className={`${FIELD_INPUT_CLASS} cursor-default`}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {i18nService.t('skillSubmitFilePlaceholder')}
            </button>
          </div>
        </div>
        <div>
          <label htmlFor="skill-submit-desc" className="mb-1 block text-xs font-medium text-secondary">
            {i18nService.t('skillSubmitDesc')}
          </label>
          <textarea
            id="skill-submit-desc"
            value={desc}
            onChange={(e) => setDesc(e.target.value.slice(0, DESCRIPTION_MAX))}
            placeholder={i18nService.t('skillSubmitDescPlaceholder')}
            rows={3}
            className={`${FIELD_INPUT_CLASS} resize-none`}
          />
        </div>
        <label htmlFor="skill-submit-all-company" className="flex items-center gap-2 text-sm text-foreground">
          <input
            id="skill-submit-all-company"
            type="checkbox"
            checked={allCompany}
            onChange={(e) => setAllCompany(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          {i18nService.t('skillSubmitAllCompany')}
        </label>
        <p className="text-xs text-secondary">
          {i18nService.t('skillSubmitScopeHint')}
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
          {submitting ? i18nService.t('skillSubmitSubmitting') : i18nService.t('skillSubmitSubmit')}
        </button>
      </div>
    </Modal>
  );
};

export default SubmitSkillForm;
