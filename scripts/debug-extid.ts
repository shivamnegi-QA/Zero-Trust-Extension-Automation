import { chromium } from '@playwright/test';
import * as path from 'path';
import { env } from '../utils/env';

const EXTENSION_PATH = path.resolve(env.EXTENSION_PATH);
const PROFILE_PATH   = path.resolve('extension builds/ztb-test-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_PATH, {
    channel: 'chrome', headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  });

  const p = await ctx.newPage();
  await p.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  // Try via chrome-extension:// background page request interception
  console.log('Pages open:', ctx.pages().map(pg => pg.url()));
  console.log('Service workers:', ctx.serviceWorkers().map(w => w.url()));

  // Try chrome://version to see what extensions are loaded
  const versionPage = await ctx.newPage();
  await versionPage.goto('chrome://version/', { waitUntil: 'domcontentloaded' });
  await versionPage.waitForTimeout(1000);
  const versionText = await versionPage.$eval('#variations-seed-version', (el: any) => el?.innerText ?? '').catch(() => '');
  const profilePath = await versionPage.$eval('#profile_path', (el: any) => el?.innerText ?? '').catch(() => '');
  console.log('Profile path from chrome://version:', profilePath);
  await versionPage.close();

  const info = await p.evaluate((): string => {
    const results: string[] = [];
    const mgr = document.querySelector('extensions-manager') as any;
    if (!mgr?.shadowRoot) { results.push('no mgr'); return results.join('\n'); }

    const viewMgr = mgr.shadowRoot.querySelector('cr-view-manager') as any;
    results.push('cr-view-manager: ' + !!viewMgr);

    // cr-view-manager is a light DOM container — its children are light DOM
    const listViaViewMgr = viewMgr?.querySelector('extensions-item-list') as any;
    results.push('list via viewMgr.querySelector: ' + !!listViaViewMgr);
    if (listViaViewMgr?.shadowRoot) {
      const items = listViaViewMgr.shadowRoot.querySelectorAll('extensions-item');
      results.push('items count (via viewMgr light): ' + items.length);
      items.forEach((item: any) => results.push('  id: ' + item.getAttribute('id')));
    }

    // Also try: the list IS a direct child of the view-manager light children
    if (viewMgr) {
      const lightChildren = Array.from(viewMgr.children).map((el: any) => el.tagName + '#' + (el.id||''));
      results.push('viewMgr light children: ' + lightChildren.join(', '));
      // The first one is EXTENSIONS-ITEM-LIST#itemsList
      const itemsList = viewMgr.querySelector('#itemsList') as any;
      results.push('itemsList found: ' + !!itemsList);
      if (itemsList?.shadowRoot) {
        const items = itemsList.shadowRoot.querySelectorAll('extensions-item');
        results.push('items in itemsList shadow: ' + items.length);
        items.forEach((item: any) => results.push('  id: ' + item.getAttribute('id')));
        // Also check for cr-lazy-render-lit wrapping
        const lazyItems = itemsList.shadowRoot.querySelectorAll('cr-lazy-render-lit');
        results.push('lazy-render-lit count: ' + lazyItems.length);
      }
    }
    return results.join('\n');
  });
  console.log(info);

  const workers = ctx.serviceWorkers();
  console.log('\nService workers:', workers.map((w) => w.url()));

  await p.screenshot({ path: 'extension builds/screenshots/debug-extensions.png', fullPage: true });
  console.log('Screenshot: extension builds/screenshots/debug-extensions.png');
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
