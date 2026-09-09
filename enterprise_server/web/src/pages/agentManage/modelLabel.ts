import type { ProviderKeyView } from '../../api/providers';

/**
 * Resolve a stored model ref (`providerId/modelId`) to a human-friendly
 * `vendor · modelId` label for display. The vendor name is the org-configured
 * provider label (模型配置); the ref's provider segment is the same `provider`
 * slug the model picker builds and stores. Falls back to the raw ref when the
 * slug has no configured provider, the matched provider has no label, or the
 * ref has no `provider/model` slash.
 */
export function modelLabel(ref: string, providers?: ProviderKeyView[]): string {
  if (!ref) return '';
  const list = Array.isArray(providers) ? providers : [];
  const idx = ref.indexOf('/');
  if (idx <= 0) return ref;
  const slug = ref.slice(0, idx);
  const modelId = ref.slice(idx + 1);
  const label = list.find(p => p.provider === slug)?.label;
  return label ? `${label} · ${modelId}` : ref;
}
