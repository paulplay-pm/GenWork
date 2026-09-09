import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Prevent vite from looking for PostCSS config in the parent monorepo root.
  // enterprise_server has no CSS, so we disable the PostCSS pipeline entirely.
  css: { postcss: { plugins: [] } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
