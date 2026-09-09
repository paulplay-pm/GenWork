import { t } from '../../i18n';
export function fill(s: string, kv: Record<string, string | number>): string {
  return Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);
}
export { t };
