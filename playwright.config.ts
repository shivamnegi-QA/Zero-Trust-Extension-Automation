import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/ui/**'],
  globalSetup: './scripts/global-setup.ts',
  timeout: 120_000, // system browser launch + AX automation adds ~15s per test
  retries: isCI ? 2 : 1,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'reports/html', open: 'never' }]],

  use: {
    baseURL: process.env.SQRX_BASE_URL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'system-chrome',
      // All launch logic is in fixtures/extension.ts (Chrome branch).
      testIgnore: ['**/ui/**', '**/*firefox*', '**/*safari*', '**/01-extension*', '**/02-firefox*', '**/03-safari*'],
      testMatch: ['**/extension-load-and-login.spec.ts', '**/02-dashboard-login.spec.ts'],
    },
    {
      name: 'system-firefox',
      // All launch logic is in fixtures/extension.ts (Firefox branch).
      testMatch: ['**/extension-load-and-login.spec.ts'],
    },
    {
      name: 'system-safari',
      // All launch logic is in fixtures/extension.ts (Safari branch).
      testMatch: ['**/extension-load-and-login.spec.ts'],
    },
  ],
});
