import { defineConfig } from '@playwright/test';

/**
 * The screens, walked by a browser.
 *
 * These are not the unit tests - `npm test` covers the engine far more thoroughly than anything here.
 * What this covers is the one thing a vitest cannot: that a real browser loads a real floor, that the
 * buttons a person sees are the buttons that fire, and that the tape on the screen agrees with the
 * audit room after the desk has been used.
 *
 * It talks to a running server. `npm run dev` on the default port is enough; set E2E_BASE_URL to point
 * somewhere else, including a deployed one.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
});
