import type { LucideIcon } from 'lucide-react';
import { BarChart3, Bot, Code2, FileText, Globe, Megaphone, Mic, Sparkles } from 'lucide-react';

/** Glyph names offered by the icon picker. Each maps to a lucide icon in the
 *  tile renderer. Matches the prototype's small glyph set. */
export const AGENT_GLYPHS: string[] = ['bot', 'chart', 'doc', 'code', 'meg', 'mic', 'globe', 'spark'];

/** 8-tint palette for the tile (app tokens where they exist, else the
 *  prototype's hues). Indexed by `icon_color`. */
export const AGENT_COLORS: string[] = [
  '#2563eb', '#0f766e', '#b45309', '#7c3aed', '#dc2626', '#0ea5e9', '#16a34a', '#db2777',
];

/** Maps the icon-picker glyph names (AGENT_GLYPHS) to lucide icons. Single
 *  source of truth for the glyph→icon rule, shared by the card, the drawer
 *  tile, and the icon/color picker. */
export const GLYPH_ICON: Record<string, LucideIcon> = {
  bot: Bot,
  chart: BarChart3,
  doc: FileText,
  code: Code2,
  meg: Megaphone,
  mic: Mic,
  globe: Globe,
  spark: Sparkles,
};

export function isUrlIcon(icon: string): boolean {
  return /^(https?:|data:)/i.test(icon);
}

/** Arbitrary-value Tailwind classes for a tinted tile at `iconColor`. */
export function tileClass(iconColor: number): string {
  const c = AGENT_COLORS[((iconColor % AGENT_COLORS.length) + AGENT_COLORS.length) % AGENT_COLORS.length];
  return `bg-[${c}]1a text-[${c}]`;
}
