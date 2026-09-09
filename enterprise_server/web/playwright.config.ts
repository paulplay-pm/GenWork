import { defineConfig } from '@playwright/test';

// The visual baseline run needs a dev server whose proxy points at a *running*
// backend (the isolated acceptance server) on a port that won't collide with a
// developer's `npm run dev` (:5173 → :8787). Both are overridable via env:
//   WEB_PORT        — vite dev port (default 5173)
//   WEB_PROXY_TARGET — backend the dev proxy forwards to (default :8787)
// `npm run dev` / manual baseline capture keep the defaults; only the CI
// visual run sets these to a spare port + the throwaway backend.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const WEB_PROXY_TARGET =
  process.env.WEB_PROXY_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  testDir: './tests/visual',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    port: WEB_PORT,
    // Forward vite's dev proxy at the backend the baselines are captured
    // against. Defaults match the normal dev setup.
    env: { VITE_DEV_PORT: String(WEB_PORT), VITE_PROXY_TARGET: WEB_PROXY_TARGET },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  snapshotPathTemplate: '{testDir}/screenshots/{testFilePath}/{arg}{ext}',
});
