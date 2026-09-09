/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    fontSize: {
      xs: ['var(--genwork-text-xs)', { lineHeight: 'var(--genwork-leading-xs)' }],
      sm: ['var(--genwork-text-sm)', { lineHeight: 'var(--genwork-leading-sm)' }],
      base: ['var(--genwork-text-base)', { lineHeight: 'var(--genwork-leading-base)' }],
      lg: ['var(--genwork-text-lg)', { lineHeight: 'var(--genwork-leading-lg)' }],
      xl: ['var(--genwork-text-xl)', { lineHeight: 'var(--genwork-leading-xl)' }],
      '2xl': ['var(--genwork-text-2xl)', { lineHeight: 'var(--genwork-leading-2xl)' }],
      '3xl': ['var(--genwork-text-3xl)', { lineHeight: 'var(--genwork-leading-3xl)' }],
      '4xl': ['var(--genwork-text-4xl)', { lineHeight: 'var(--genwork-leading-4xl)' }],
      '5xl': ['calc(var(--genwork-text-4xl) * 1.333)', { lineHeight: '1' }],
      '6xl': ['calc(var(--genwork-text-4xl) * 1.667)', { lineHeight: '1' }],
      '7xl': ['calc(var(--genwork-text-4xl) * 2)', { lineHeight: '1' }],
      '8xl': ['calc(var(--genwork-text-4xl) * 2.667)', { lineHeight: '1' }],
      '9xl': ['calc(var(--genwork-text-4xl) * 3.556)', { lineHeight: '1' }],
    },
    fontWeight: {
      thin: '100',
      extralight: '200',
      light: '300',
      normal: 'var(--genwork-ui-font-weight-normal, 445)',
      medium: 'var(--genwork-ui-font-weight-medium, 500)',
      semibold: '600',
      bold: '700',
      extrabold: '800',
      black: '900',
    },
    extend: {
      boxShadow: {
        subtle: '0 1px 2px rgba(0,0,0,0.05)',
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        elevated: '0 4px 12px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.04)',
        modal: '0 8px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)',
        popover: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.05)',
        'glow-accent': '0 0 20px var(--genwork-primary-muted)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-3px)' },
          '40%': { transform: 'translateX(3px)' },
          '60%': { transform: 'translateX(-2px)' },
          '80%': { transform: 'translateX(2px)' },
        },
        'message-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.25s ease-out',
        'fade-in-down': 'fade-in-down 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        shimmer: 'shimmer 1.5s infinite',
        shake: 'shake 0.4s ease-in-out',
        // No fill mode on purpose: a filled opacity/transform animation keeps
        // the element a stacking context forever, which traps in-message
        // popovers (z-50) below later sibling messages. The entry animation
        // has no delay and ends at the natural state, so no fill is needed.
        'message-in': 'message-in 0.25s ease-out',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      typography: {
        DEFAULT: {
          css: {
            color: 'var(--genwork-text-primary)',
            a: {
              color: 'var(--genwork-primary)',
              '&:hover': {
                color: 'var(--genwork-primary-hover)',
              },
            },
            code: {
              color: 'var(--genwork-text-primary)',
              backgroundColor: 'var(--genwork-surface-raised)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            'code::before': {
              content: '""',
            },
            'code::after': {
              content: '""',
            },
            pre: {
              backgroundColor: 'var(--genwork-surface-raised)',
              color: 'var(--genwork-text-primary)',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: 'var(--genwork-primary)',
              color: 'var(--genwork-text-secondary)',
            },
            h1: { color: 'var(--genwork-text-primary)' },
            h2: { color: 'var(--genwork-text-primary)' },
            h3: { color: 'var(--genwork-text-primary)' },
            h4: { color: 'var(--genwork-text-primary)' },
            strong: { color: 'var(--genwork-text-primary)' },
            table: { marginTop: '0', marginBottom: '0' },
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('./src/renderer/theme/tailwind/plugin.cjs'),
  ],
}
