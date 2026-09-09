import { t } from '../../i18n';

/** Replace `{key}` placeholders in a translated string (t() does not interpolate). */
export function fill(s: string, kv: Record<string, string | number>): string {
  return Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);
}

export { t };
