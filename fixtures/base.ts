import { test as base, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const IS_WINDOWS = process.platform === 'win32';

const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? path.resolve(process.env.EXTENSION_PATH)
  : path.resolve(IS_WINDOWS ? 'extension builds/chrome-1.4.3/build' : 'extension builds/extension-unpacked');

// _launchedContext is worker-scoped: one browser session per project run.
// context (test-scoped) returns the same BrowserContext each time so state
// (cookies, storage) persists across tests within describe.serial blocks.
type TestFixtures = {
  page: Page;
  extensionId: string;
};

type WorkerFixtures = {
  _launchedContext: BrowserContext;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  _launchedContext: [async ({}, use) => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-test-'));

    let cdpEndpoint: string;
    let teardown: () => Promise<void>;

    if (IS_WINDOWS) {
      const { launchWindowsBrowserWithExtension } = await import('../utils/system-windows-chrome');
      ({ cdpEndpoint, teardown } = await launchWindowsBrowserWithExtension({
        extensionPath: EXTENSION_PATH,
        profilePath: tmpProfile,
        tag: '[fixture:win-chrome]',
      }));
    } else {
      const { launchSystemChromeWithExtension } = await import('../utils/system-chrome');
      ({ cdpEndpoint, teardown } = await launchSystemChromeWithExtension({
        extensionPath: EXTENSION_PATH,
        profilePath: tmpProfile,
        tag: '[fixture]',
      }));
    }

    // Browser is now running — wrap in try/finally so teardown always fires
    // even if connectOverCDP or newContext throws before use() is called.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let browser: any = null;
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
      const ctx = browser.contexts()[0] ?? await browser.newContext();
      await use(ctx);
    } finally {
      // Kill processes BEFORE browser.close(): browser.close() starts Chrome's
      // graceful shutdown which can reparent sub-processes before the tree-kill runs.
      await teardown();
      await browser?.close().catch(() => {});
      const { rmSync } = await import('fs');
      await new Promise(r => setTimeout(r, 1500));
      try { rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* Chrome may still hold locks */ }
    }
  }, { scope: 'worker' }],

  // Returns the shared context — same BrowserContext instance for every test,
  // so session cookies and storage persist across the describe.serial chain.
  context: async ({ _launchedContext }, use) => {
    await use(_launchedContext);
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close().catch(() => {});
  },

  extensionId: async ({}, use) => {
    const { extensionIdFromManifestKey } = IS_WINDOWS
      ? await import('../utils/system-windows-chrome')
      : await import('../utils/system-chrome');
    await use(extensionIdFromManifestKey(EXTENSION_PATH));
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
