import { defineConfig } from '@playwright/test';

// Separate config for testing the UI server itself (no Chrome, no extension, no live dashboard).
// Run with: npx playwright test --config=playwright.ui.config.ts
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'reports/ui-html', open: 'never' }]],
  globalSetup: './scripts/ui-server-setup.ts',
  globalTeardown: './scripts/ui-server-teardown.ts',
  use: {
    baseURL: 'http://localhost:4321',
  },
  projects: [{ name: 'ui-server' }],
});
