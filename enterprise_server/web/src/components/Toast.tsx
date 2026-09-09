import type { JSX } from 'react';

import { useToastStore } from './toastStore';

export function ToastViewport(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return <></>;
  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2">
      {toasts.map((t) => {
        const color =
          t.kind === 'error'
            ? 'bg-[var(--danger-primary)]'
            : t.kind === 'success'
              ? 'bg-[var(--success-primary)]'
              : 'bg-[var(--text-primary)]';
        return (
          <div
            key={t.id}
            className={`${color} text-white px-4 py-2 rounded-lg shadow-lg cursor-pointer`}
            onClick={() => dismiss(t.id)}
            role="status"
          >
            {t.text}
          </div>
        );
      })}
    </div>
  );
}
