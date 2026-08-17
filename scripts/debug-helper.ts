import { chromium } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const EXTENSION_PATH = path.resolve(process.env.EXTENSION_PATH!);
const HELPER_PATH    = path.resolve('extension builds/popup-helper-extension');
const PROFILE_PATH   = path.resolve('extension builds/ztb-test-profile');
const ZTB_ID         = 'kpgdheeifhfpkehmcmafbnmlgnlndgph';

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    channel: 'chrome', headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH},${HELPER_PATH}`,
      `--load-extension=${EXTENSION_PATH},${HELPER_PATH}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  });

  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));

  console.log('Service workers:', context.serviceWorkers().map(w => w.url()));
  console.log('Background pages:', context.backgroundPages().map(p => p.url()));

  const extPage = await context.newPage();
  await extPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // Use arrow function to avoid __name injection from TypeScript named function transform
  const ids: string[] = await extPage.evaluate(() => {
    const collect = (root: any, sel: string): Element[] => {
      const found: Element[] = Array.from(root.querySelectorAll(sel));
      for (const node of Array.from(root.querySelectorAll('*')) as Element[]) {
        if ((node as any).shadowRoot) found.push(...collect((node as any).shadowRoot, sel));
      }
      return found;
    };
    return collect(document, 'extensions-item').map((el: any) => el.getAttribute('id') ?? '');
  });

  console.log('Extensions in chrome://extensions:', ids);
  console.log('Helper ID (non-ZTB):', ids.filter(id => id !== ZTB_ID));

  await extPage.screenshot({ path: 'extension builds/screenshots/debug-helper.png' });
  await context.close();
})().catch(e => { console.error(e.message); process.exit(1); });
