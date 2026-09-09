import { X } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface FormField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'textarea' | 'checkbox' | 'header';
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  rows?: number;
  /** Optional helper text shown below the field. */
  hint?: string;
}

interface Props {
  open: boolean;
  title: string;
  fields: FormField[];
  initialValues?: Record<string, string>;
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  onClose: () => void;
  children?: ReactNode;
}

export function FormDrawer({
  open,
  title,
  fields,
  initialValues = {},
  submitLabel = 'Save',
  onSubmit,
  onClose,
  children,
}: Props): JSX.Element | null {
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setValues(initialValues);
      setErr(null);
      setBusy(false);
    }
    wasOpen.current = open;
  }, [open, initialValues]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      await onSubmit(values);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[var(--bg-secondary)] h-full shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-md p-1 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          {children}
          {fields.map((f) => (
            <div key={f.name} className="mb-3">
              {f.type === 'header' ? (
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mt-4 mb-2 first:mt-0">
                  {f.label}
                </div>
              ) : f.type === 'checkbox' ? (
                <label className="flex items-start gap-2 cursor-pointer select-none py-1">
                  <input
                    id={`f-${f.name}`}
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-[var(--border-default)] text-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/30"
                    checked={values[f.name] === '1'}
                    onChange={(e) =>
                      setValues({ ...values, [f.name]: e.target.checked ? '1' : '' })
                    }
                  />
                  <span className="flex-1">
                    <span className="block text-sm font-medium text-[var(--text-primary)]">
                      {f.label}
                    </span>
                    {f.hint && (
                      <span className="block text-xs text-[var(--text-tertiary)] mt-0.5">
                        {f.hint}
                      </span>
                    )}
                  </span>
                </label>
              ) : (
                <>
                  <label
                    htmlFor={`f-${f.name}`}
                    className="block text-sm font-medium text-[var(--text-secondary)] mb-1"
                  >
                    {f.label}
                    {f.required && <span className="text-[var(--danger-primary)] ml-1">*</span>}
                  </label>
                  {f.type === 'select' ? (
                    <select
                      id={`f-${f.name}`}
                      className="w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)]"
                      value={values[f.name] ?? ''}
                      onChange={(e) =>
                        setValues({ ...values, [f.name]: e.target.value })
                      }
                    >
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea
                      id={`f-${f.name}`}
                      className="w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)]"
                      placeholder={f.placeholder}
                      rows={f.rows ?? 4}
                      value={values[f.name] ?? ''}
                      onChange={(e) =>
                        setValues({ ...values, [f.name]: e.target.value })
                      }
                    />
                  ) : (
                    <input
                      id={`f-${f.name}`}
                      className="w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)]"
                      type={f.type}
                      placeholder={f.placeholder}
                      value={values[f.name] ?? ''}
                      onChange={(e) =>
                        setValues({ ...values, [f.name]: e.target.value })
                      }
                    />
                  )}
                  {f.hint && (
                    <p className="text-xs text-[var(--text-tertiary)] mt-1">{f.hint}</p>
                  )}
                </>
              )}
            </div>
          ))}
          {err && <p className="text-[var(--danger-primary)] text-sm mb-2">{err}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={onClose}
              className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-lg bg-[var(--accent-primary)] text-white px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-[var(--accent-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/40 disabled:opacity-50 transition-colors"
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { Props as FormDrawerProps };
export type _FormChild = ReactNode;
