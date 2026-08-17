import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

const isCI = !!process.env.CI;
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

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
    // ── macOS projects (skipped on Windows) ────────────────────────────────
    ...(!isWindows ? [
      {
        name: 'system-chrome',
        testIgnore: ['**/ui/**', '**/*firefox*', '**/*safari*', '**/01-extension*', '**/02-firefox*', '**/03-safari*'],
        testMatch: ['**/extension-load-and-login.spec.ts', '**/02-dashboard-login.spec.ts'],
      },
      {
        name: 'system-firefox',
        testMatch: ['**/extension-load-and-login.spec.ts'],
      },
      {
        name: 'system-safari',
        testMatch: ['**/extension-load-and-login.spec.ts'],
      },
    ] : []),

    // ── Windows projects (skipped on macOS) ────────────────────────────────
    ...(!isMac ? [
      {
        name: 'windows-chrome',
        testMatch: ['**/extension-load-and-login.spec.ts', '**/02-dashboard-login.spec.ts'],
      },
      {
        name: 'windows-edge',
        testMatch: ['**/extension-load-and-login.spec.ts'],
      },
      {
        name: 'windows-firefox',
        testMatch: ['**/extension-load-and-login.spec.ts'],
      },
    ] : []),
  ],
});
