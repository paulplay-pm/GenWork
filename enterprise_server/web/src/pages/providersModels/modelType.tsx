import type { JSX } from 'react';

import { ModelTypes, type ModelTypeValue } from '../../api/models';
import { t } from '../../i18n';

export const TYPE_VALUE_LABEL_KEY: Record<ModelTypeValue, string> = {
  [ModelTypes.Chat]: 'providersModels.model.typeChat',
  [ModelTypes.Vision]: 'providersModels.model.typeVision',
  [ModelTypes.Reasoning]: 'providersModels.model.typeReasoning',
  [ModelTypes.ImageGen]: 'providersModels.model.typeImageGen',
  [ModelTypes.Embedding]: 'providersModels.model.typeEmbedding',
  [ModelTypes.Rerank]: 'providersModels.model.typeRerank',
  [ModelTypes.Asr]: 'providersModels.model.typeAsr',
  [ModelTypes.Tts]: 'providersModels.model.typeTts',
};
export function typeValueLabel(v: ModelTypeValue): string {
  return t(TYPE_VALUE_LABEL_KEY[v] ?? 'providersModels.model.typeChat');
}

// PRD §4.3.1 colors: chat=blue, vision=cyan, reasoning=purple, others=gray.
const TYPE_BG: Record<ModelTypeValue, string> = {
  'chat': 'bg-[var(--accent-light)] text-[var(--accent-primary)]',
  'vision': 'bg-cyan-50 text-cyan-700',
  'reasoning': 'bg-purple-50 text-purple-700',
  'image-gen': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'embedding': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'rerank': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'asr': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  'tts': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
};
export function ModelTypesBadges({ types }: { types: ModelTypeValue[] }): JSX.Element {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {types.map((v) => (
        <span key={v} className={`inline-flex rounded-full px-2 py-0.5 text-xs ${TYPE_BG[v]}`}>{typeValueLabel(v)}</span>
      ))}
    </span>
  );
}
// 5-stop context picker (tokens). Off-ladder values sit at the nearest stop.
export const CONTEXT_STOPS = [
  { tokens: 32000, label: '32K' }, { tokens: 64000, label: '64K' }, { tokens: 200000, label: '200K' },
  { tokens: 1000000, label: '1M' }, { tokens: 2000000, label: '2M' },
] as const;
export function contextLabel(tokens: number | null): string {
  if (tokens == null) return '—';
  const fmt = (n: number): string => (n >= 1000000 ? `${n / 1000000}M` : `${Math.round(n / 1000)}K`);
  return fmt(tokens);
}
export function nearestStopIndex(tokens: number | null): number {
  if (tokens == null) return 2;
  let best = 0, bestD = Infinity;
  CONTEXT_STOPS.forEach((s, i) => { const d = Math.abs(s.tokens - tokens); if (d < bestD) { bestD = d; best = i; } });
  return best;
}
