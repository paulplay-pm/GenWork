/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
  server: {
    // Port and proxy target default to the standard dev setup (vite :5173 →
    // enterprise server :8787). Both are overridable via env so the Playwright
    // visual-baseline run can bind a spare dev port and point its proxy at an
    // isolated backend (e.g. the throwaway acceptance server on :8799) without
    // touching a developer's running :5173/:8787. Defaults preserve the usual
    // `npm run dev` flow exactly.
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    strictPort: true,
    proxy: {
      // SPA auth/api/admin routes all live at the API root on :8787
      // (Hono mounts them under app.route('/', ...) — no /api prefix).
      // Proxying each top-level prefix keeps the SPA's fetch() calls
      // origin-relative without needing an apiClient baseUrl.
      '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
      '/auth': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
      '/admin': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
      '/usage': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
      // /me supplies the caller's fine permission points + effective data
      // scope; the SPA gates its mutating affordances on it. Without this
      // entry the dev origin serves the SPA index instead, so gated buttons
      // (create/edit/delete) never appear in dev. The server mounts /me at the
      // root (src/server.ts, before static page routing).
      '/me': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
      // /sso-logos forwards to the enterprise server's static-serve
      // route, which serves the runtime upload dir
      // (<stateDir>/sso-logos/uploads/). In production the SPA's
      // <img src> is an absolute URL hitting the API origin; in dev
      // this proxy entry keeps it same-origin on the SPA host.
      '/sso-logos': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
      // /bind-sso is the public, server-rendered SSO prove-with-password
      // form (src/routes/auth/ssoBind.ts). It is mounted on the backend
      // before the SPA wildcard fallback so production traffic reaches
      // it directly. In dev the SPA's index would otherwise swallow it,
      // so proxy to the backend here too.
      '/bind-sso': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // `tests/**` is the historical home for web tests (mirroring src/);
    // `src/**` allows colocated unit tests (e.g. src/pages/sso/presets.test.ts).
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],
  },
});