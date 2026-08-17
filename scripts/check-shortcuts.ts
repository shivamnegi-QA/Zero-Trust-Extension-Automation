import { chromium } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const EXTENSION_PATH = path.resolve(process.env.EXTENSION_PATH!);
const PROFILE_PATH = path.resolve('extension builds/ztb-test-profile');
const EXT_ID = 'kpgdheeifhfpkehmcmafbnmlgnlndgph';

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    channel: 'chrome', headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const shortcutsPage = await context.newPage();
  await shortcutsPage.goto('chrome://extensions/shortcuts', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));
  console.log('shortcuts page title:', await shortcutsPage.title());
  await shortcutsPage.screenshot({ path: 'extension builds/screenshots/shortcuts-page.png' });
  console.log('Screenshot saved.');
  await context.close();
})().catch(e => { console.error(e.message); process.exit(1); });
