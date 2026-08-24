import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for CRM SaaS E2E tests.
 *
 * Before running:
 *  npm run seed:e2e       -- populates test database with fixtures
 *  npm run dev:backend    -- starts API on :3000
 *  npm run dev:frontend   -- starts UI on :5173
 */
export default defineConfig({
  testDir: './workflows',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: 'html',

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: undefined, // started manually: npm run dev
});
