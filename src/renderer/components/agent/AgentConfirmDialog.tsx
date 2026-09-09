import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React from 'react';

import Modal from '../common/Modal';
import { AgentConfirmDialogVariant } from './constants';

interface AgentConfirmDialogProps {
  variant: AgentConfirmDialogVariant;
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const variantIconClassName: Record<AgentConfirmDialogVariant, string> = {
  [AgentConfirmDialogVariant.Unsaved]: 'bg-surface-raised text-warning',
  [AgentConfirmDialogVariant.Delete]: 'bg-surface-raised text-destructive',
};

const AgentConfirmDialog: React.FC<AgentConfirmDialogProps> = ({
  variant,
  title,
  message,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}) => {
  return (
    <Modal
      onClose={onCancel}
      overlayClassName="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-sm rounded-2xl border border-border bg-surface shadow-modal overflow-hidden"
    >
      <div className="flex items-start gap-3 px-5 py-4">
        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${variantIconClassName[variant]}`}>
          <ExclamationTriangleIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <p className="mt-1.5 text-sm leading-5 text-secondary">
            {message}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
};

export default AgentConfirmDialog;
