/**
 * Token Contract — defines all semantic variables a theme must provide.
 *
 * Naming: --genwork-{category}-{name}
 * Convention: shadcn/ui background/foreground pairing + Radix 12-step gray scale
 *
 * Every theme (ThemeDefinition.tokens) must supply a value for each key.
 */
export const TOKEN_CONTRACT = {
  // ── Brand ──
  'primary':            '--genwork-primary',
  'primary-foreground': '--genwork-primary-foreground',
  'primary-hover':      '--genwork-primary-hover',
  'primary-muted':      '--genwork-primary-muted',

  // ── Accent ──
  'accent':             '--genwork-accent',
  'accent-foreground':  '--genwork-accent-foreground',

  // ── Surface / Background ──
  'background':         '--genwork-background',
  'foreground':         '--genwork-foreground',
  'surface':            '--genwork-surface',
  'surface-foreground': '--genwork-surface-foreground',
  'surface-raised':     '--genwork-surface-raised',
  'surface-overlay':    '--genwork-surface-overlay',

  // ── Chat bubbles ──
  'chat-user':              '--genwork-chat-user',
  'chat-user-foreground':   '--genwork-chat-user-foreground',
  'chat-bot':               '--genwork-chat-bot',
  'chat-bot-foreground':    '--genwork-chat-bot-foreground',

  // ── Text hierarchy ──
  'text-primary':       '--genwork-text-primary',
  'text-secondary':     '--genwork-text-secondary',
  'text-muted':         '--genwork-text-muted',

  // ── Borders ──
  'border':             '--genwork-border',
  'border-subtle':      '--genwork-border-subtle',
  'input-border':       '--genwork-input-border',

  // ── Scrollbar ──
  'scroll-thumb':       '--genwork-scroll-thumb',
  'scroll-thumb-hover': '--genwork-scroll-thumb-hover',

  // ── Decorative gradients ──
  'gradient-1':         '--genwork-gradient-1',
  'gradient-2':         '--genwork-gradient-2',

  // ── Status ──
  'destructive':            '--genwork-destructive',
  'destructive-foreground': '--genwork-destructive-foreground',
  'success':                '--genwork-success',
  'warning':                '--genwork-warning',

  // ── Gray scale 11 steps (gray-1=lightest → gray-11=darkest, all themes) ──
  'gray-1':  '--genwork-gray-1',
  'gray-2':  '--genwork-gray-2',
  'gray-3':  '--genwork-gray-3',
  'gray-4':  '--genwork-gray-4',
  'gray-5':  '--genwork-gray-5',
  'gray-6':  '--genwork-gray-6',
  'gray-7':  '--genwork-gray-7',
  'gray-8':  '--genwork-gray-8',
  'gray-9':  '--genwork-gray-9',
  'gray-10': '--genwork-gray-10',
  'gray-11': '--genwork-gray-11',

  // ── Radius ──
  'radius':  '--genwork-radius',
} as const;

export type TokenName = keyof typeof TOKEN_CONTRACT;
export type CSSVarName = (typeof TOKEN_CONTRACT)[TokenName];

/** All token keys as an array */
export const TOKEN_NAMES = Object.keys(TOKEN_CONTRACT) as TokenName[];
