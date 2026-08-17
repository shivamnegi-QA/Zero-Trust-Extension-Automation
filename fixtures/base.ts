import { test as base, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { launchSystemChromeWithExtension } from '../utils/system-chrome';

dotenv.config();

const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? path.resolve(process.env.EXTENSION_PATH)
  : path.resolve('extension builds/extension-unpacked');

const PROFILE_PATH = path.resolve('extension builds/ztb-test-profile');

type ExtensionFixtures = {
  context: BrowserContext;
  page: Page;
  extensionId: string;
};

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    // Use a unique temp profile per test so concurrent/sequential runs don't collide
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-test-'));

    const { cdpEndpoint, teardown } = await launchSystemChromeWithExtension({
      extensionPath: EXTENSION_PATH,
      profilePath: tmpProfile,
      tag: '[fixture]',
    });

    // cdpEndpoint is a ws:// URL from Chrome's /json/version.
    // connectOverCDP with a WS URL works on Chrome 151 / macOS 26;
    // the HTTP form returns empty JSON and fails.
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const context = browser.contexts()[0] ?? await browser.newContext();

    await use(context);

    // browser.close() signals teardown but Chrome is actually killed by teardown() below.
    await browser.close().catch(() => {});
    await teardown();

    // Clean up temp profile after Chrome exits
    const { rmSync } = await import('fs');
    rmSync(tmpProfile, { recursive: true, force: true });
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },

  extensionId: async ({}, use) => {
    // Derived deterministically from the manifest key — no browser needed
    const { extensionIdFromManifestKey } = await import('../utils/system-chrome');
    const id = extensionIdFromManifestKey(EXTENSION_PATH);
    await use(id);
  },
});

export { expect } from '@playwright/test';

/**
 * Open the ZTB extension popup programmatically.
 *
 * Direct chrome-extension:// navigation is blocked by ZTB (ERR_BLOCKED_BY_CLIENT).
 * We call chrome.action.openPopup() from ZTB's own service worker, which creates a
 * popup CDP target. We then navigate a new page to the popup URL.
 */
export async function openExtensionPopup(context: BrowserContext, ztbExtensionId: string): Promise<Page> {
  let sw = context.serviceWorkers().find(w => w.url().includes(ztbExtensionId));
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', {
      predicate: w => w.url().includes(ztbExtensionId),
      timeout: 8_000,
    });
  }

  const popupUrl = `chrome-extension://${ztbExtensionId}/popup.html`;

  // Check if there's already an open popup page before doing anything
  const already = context.pages().find(p => p.url().startsWith(popupUrl) && !p.isClosed());
  if (already) return already;

  // Use a fresh page as the anchor for focus + CDP discovery
  const anchorPage = await context.newPage();
  await anchorPage.goto('about:blank');
  await anchorPage.bringToFront();

  const cdp = await context.newCDPSession(anchorPage);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  // Trigger the popup via the service worker
  await sw.evaluate(`
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
      const windowId = tabs[0]?.windowId;
      if (!windowId) return;
      chrome.windows.update(windowId, { focused: true }, () =>
        chrome.action.openPopup({ windowId })
      );
    });
  `);

  // Poll CDP Target.getTargets until the popup target appears (it's a separate window target
  // not surfaced as a Playwright page event when connecting via connectOverCDP)
  let found = false;
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    if (targetInfos.find(t => t.url?.startsWith(popupUrl) && t.type === 'page')) {
      found = true;
      break;
    }
    await new Promise<void>(r => setTimeout(r, 250));
  }

  await cdp.detach().catch(() => {});

  if (!found) {
    await anchorPage.close().catch(() => {});
    throw new Error('Popup CDP target did not appear after openPopup()');
  }

  // Navigate the anchor page to the popup URL — this is the reliable way to get a
  // Playwright Page object for the popup when connectOverCDP doesn't surface new windows.
  await anchorPage.goto(popupUrl);
  await anchorPage.waitForLoadState('domcontentloaded').catch(() => {});
  return anchorPage;
}

/** Clear all cookies, localStorage, and extension chrome.storage so a test starts unauthenticated. */
export async function clearSession(context: BrowserContext, origin: string): Promise<void> {
  // 1. Clear dashboard web session (cookies + localStorage)
  await context.clearCookies();
  const page = await context.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
    await page.evaluate(() => {
      try { localStorage.clear(); } catch { /* ignore */ }
      try { sessionStorage.clear(); } catch { /* ignore */ }
    });
  } finally {
    await page.close();
  }

  // 2. Clear the extension's chrome.storage (local + sync) via the ZTB service worker.
  // Find ZTB's worker by the extension ID in its URL rather than positional index,
  // so other installed extensions don't interfere.
  const ztbSw = context.serviceWorkers().find(w => w.url().includes('popup.html') || w.url().includes('background'));
  const sw = ztbSw ?? context.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(`
      Promise.all([
        new Promise(r => chrome.storage.local.clear(r)),
        new Promise(r => chrome.storage.sync.clear(r)),
      ])
    `).catch(() => {});
    // Give the extension a moment to re-evaluate its auth state after storage wipe
    await new Promise<void>(r => setTimeout(r, 1_500));
  }
}
