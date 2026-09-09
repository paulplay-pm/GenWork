/**
 * Tailwind CSS v3 plugin — bridges --genwork-* CSS variables into Tailwind utility classes.
 *
 * Usage in tailwind.config.js:
 *   plugins: [require('./src/renderer/theme/tailwind/plugin.cjs')]
 *
 * Provides: bg-background, text-foreground, bg-primary, border-border, etc.
 * Also provides legacy claude.* aliases for backward compatibility.
 *
 * Colors are wrapped in color-mix() with the <alpha-value> placeholder so that
 * Tailwind opacity modifiers (e.g. text-foreground/90, bg-surface-raised/30)
 * generate working CSS. Without this, var()-based colors silently drop any
 * class that uses an opacity modifier.
 */
const plugin = require('tailwindcss/plugin');

const withAlpha = (variable) =>
  `color-mix(in srgb, var(${variable}) calc(<alpha-value> * 100%), transparent)`;

module.exports = plugin(function () {
  // The plugin itself is a no-op; we only extend the theme below.
}, {
  theme: {
    extend: {
      colors: {
        // === Semantic theme colors (driven by CSS variables) ===
        background:    withAlpha('--genwork-background'),
        foreground:    withAlpha('--genwork-foreground'),
        primary: {
          DEFAULT:     withAlpha('--genwork-primary'),
          foreground:  withAlpha('--genwork-primary-foreground'),
          hover:       withAlpha('--genwork-primary-hover'),
          muted:       withAlpha('--genwork-primary-muted'),
          dark:        withAlpha('--genwork-primary-hover'),  // backward compat alias
        },
        accent: {
          DEFAULT:     withAlpha('--genwork-accent'),
          foreground:  withAlpha('--genwork-accent-foreground'),
        },
        surface: {
          DEFAULT:     withAlpha('--genwork-surface'),
          foreground:  withAlpha('--genwork-surface-foreground'),
          raised:      withAlpha('--genwork-surface-raised'),
          overlay:     withAlpha('--genwork-surface-overlay'),
          inset:       withAlpha('--genwork-surface-raised'),  // alias
        },
        border: {
          DEFAULT:     withAlpha('--genwork-border'),
          subtle:      withAlpha('--genwork-border-subtle'),
          input:       withAlpha('--genwork-input-border'),
        },
        muted:         withAlpha('--genwork-text-muted'),
        destructive: {
          DEFAULT:     withAlpha('--genwork-destructive'),
          foreground:  withAlpha('--genwork-destructive-foreground'),
        },
        success:       withAlpha('--genwork-success'),
        warning:       withAlpha('--genwork-warning'),

        // === Legacy claude.* aliases (map to --genwork-* for backward compat) ===
        claude: {
          bg:                withAlpha('--genwork-background'),
          surface:           withAlpha('--genwork-surface'),
          surfaceHover:      withAlpha('--genwork-surface-raised'),
          surfaceMuted:      withAlpha('--genwork-surface-raised'),
          surfaceInset:      withAlpha('--genwork-surface-raised'),
          border:            withAlpha('--genwork-border'),
          borderLight:       withAlpha('--genwork-border-subtle'),
          text:              withAlpha('--genwork-text-primary'),
          textSecondary:     withAlpha('--genwork-text-secondary'),
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            withAlpha('--genwork-background'),
          darkSurface:       withAlpha('--genwork-surface'),
          darkSurfaceHover:  withAlpha('--genwork-surface-raised'),
          darkSurfaceMuted:  withAlpha('--genwork-surface-raised'),
          darkSurfaceInset:  withAlpha('--genwork-surface-raised'),
          darkBorder:        withAlpha('--genwork-border'),
          darkBorderLight:   withAlpha('--genwork-border-subtle'),
          darkText:          withAlpha('--genwork-text-primary'),
          darkTextSecondary: withAlpha('--genwork-text-secondary'),
          // Accent
          accent:            withAlpha('--genwork-primary'),
          accentHover:       withAlpha('--genwork-primary-hover'),
          accentLight:       withAlpha('--genwork-primary'),
          accentMuted:       withAlpha('--genwork-primary-muted'),
        },
        secondary: {
          DEFAULT: withAlpha('--genwork-text-secondary'),
          dark:    withAlpha('--genwork-border'),
        },
      },
      borderRadius: {
        theme: 'var(--genwork-radius)',
      },
    },
  },
});
