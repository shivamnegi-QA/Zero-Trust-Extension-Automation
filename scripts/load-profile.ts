import { chromium } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { unpackCrx, getUnpackedPath, getProfilePath, ensureProfileDir } from '../utils/chrome-profile';

const SCREENSHOT_PATH = path.resolve('extension builds/screenshots/extension-loaded.png');

async function main(): Promise<void> {
  console.log('Step 1: Unpacking extension.crx...');
  await unpackCrx();

  const extensionPath = getUnpackedPath();
  const profilePath = getProfilePath();

  console.log('Step 2: Preparing Chrome profile...');
  ensureProfileDir();

  console.log('Step 3: Launching Chrome with extension...');
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chrome',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await context.newPage();

  console.log('Step 4: Navigating to chrome://extensions...');
  await page.goto('chrome://extensions/');
  await page.waitForTimeout(2000);

  // Extract extension ID from the extensions page
  const extensionId = await page.evaluate((): string => {
    const manager = document.querySelector('extensions-manager');
    if (!manager?.shadowRoot) return '';
    const itemList = manager.shadowRoot.querySelector('extensions-item-list');
    if (!itemList?.shadowRoot) return '';
    const item = itemList.shadowRoot.querySelector('extensions-item');
    return item?.getAttribute('id') ?? '';
  });

  if (extensionId) {
    console.log(`Extension ID: ${extensionId}`);
  } else {
    console.log('Extension ID: could not detect (extension may still be loaded)');
  }

  console.log('Step 5: Taking screenshot...');
  fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  console.log(`Screenshot saved: ${SCREENSHOT_PATH}`);

  await context.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
