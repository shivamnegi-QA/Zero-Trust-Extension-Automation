import { test as base, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const IS_WINDOWS = process.platform === 'win32';

const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? path.resolve(process.env.EXTENSION_PATH)
  : path.resolve('extension builds/chrome-1.4.3/build');

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
    // Manifest-key hashing is platform-independent, so read it from shared directly
    // rather than pulling in an OS-specific launcher module for one pure function.
    const { extensionIdFromManifestKey } = await import('../utils/shared');
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
/**
 * Open the extension popup and return its body text, read directly from the real popup
 * window via CDP Target.attachToTarget + Runtime.evaluate.
 * The popup cannot be loaded in a regular tab (renders empty without extension runtime),
 * so we attach a flattened CDP session to the popup target and evaluate body text there.
 */
export async function openExtensionPopupBodyText(
  context: BrowserContext,
  ztbExtensionId: string,
  existingPage?: import('@playwright/test').Page,
): Promise<string> {
  const popupUrl = `chrome-extension://${ztbExtensionId}/popup.html`;

  let sw = context.serviceWorkers().find(w => w.url().includes(ztbExtensionId));
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', {
      predicate: w => w.url().includes(ztbExtensionId),
      timeout: 8_000,
    });
  }

  // Prefer an existing page (e.g. navPage on the dashboard) so Chrome's lastFocusedWindow
  // is already set correctly. Only open a new page if none is available.
  let anchorPage: import('@playwright/test').Page;
  let anchorIsOwned = false;
  if (existingPage && !existingPage.isClosed()) {
    anchorPage = existingPage;
  } else {
    anchorPage = await context.newPage();
    anchorIsOwned = true;
    const baseUrl = process.env.SQRX_BASE_URL ?? '';
    await anchorPage.goto(baseUrl || 'about:blank').catch(() => {});
  }
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

  await new Promise<void>(r => setTimeout(r, 2_000));

  // Poll for popup target
  let popupTargetId: string | null = null;
  let pollAttempts = 0;
  for (let i = 0; i < 40; i++) {
    pollAttempts = i + 1;
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find(t => t.url?.startsWith(popupUrl) && t.type === 'page');
    if (t) { popupTargetId = t.targetId; break; }
    await new Promise<void>(r => setTimeout(r, 250));
  }

  if (!popupTargetId) {
    console.log(`  [chrome] Popup CDP target for ${popupUrl} did not appear after ${pollAttempts} poll attempts`);
    await cdp.detach().catch(() => {});
    await anchorPage.close().catch(() => {});
    throw new Error('Popup CDP target did not appear after openPopup()');
  }
  console.log(`  [chrome] Popup CDP target for ${popupUrl} found after ${pollAttempts} poll attempt(s)`);

  // Attach to the popup target with flatten:true — this gives us a CDP session
  // routed directly into the popup window's JS context (not a new tab).
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: popupTargetId,
    flatten: true,
  }) as { sessionId: string };

  // Give the popup's React app time to mount and render
  await new Promise<void>(r => setTimeout(r, 2_000));

  // Evaluate body text inside the popup's real JS context via the flattened session
  let body = '';
  try {
    const result = await cdp.send('Runtime.evaluate' as any, {
      expression: `(document.body && (document.body.innerText || document.body.textContent)) || ''`,
      returnByValue: true,
      sessionId,
    } as any) as any;
    body = String(result?.result?.value ?? '');
  } catch { /* ignore */ }

  await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  await cdp.detach().catch(() => {});
  if (anchorIsOwned) await anchorPage.close().catch(() => {});
  return body;
}

export async function closeExtensionPopup(
  context: BrowserContext,
  ztbExtensionId: string,
): Promise<void> {
  const popupUrl = `chrome-extension://${ztbExtensionId}/popup.html`;
  const existing = context.pages().find(p => p.url().startsWith(popupUrl) && !p.isClosed());
  if (existing) await existing.close().catch(() => {});

  // Close popup window via service worker
  const sw = context.serviceWorkers().find(w => w.url().includes(ztbExtensionId));
  if (sw) {
    await sw.evaluate(`
      chrome.windows.getAll({ populate: true }, wins => {
        wins.forEach(w => {
          if (w.type === 'popup') chrome.windows.remove(w.id);
        });
      });
    `).catch(() => {});
  }
}

export async function openExtensionPopup(context: BrowserContext, ztbExtensionId: string): Promise<Page> {
  const popupUrl = `chrome-extension://${ztbExtensionId}/popup.html`;
  const already = context.pages().find(p => p.url().startsWith(popupUrl) && !p.isClosed());
  if (already) return already;
  const page = await context.newPage();
  await page.goto(popupUrl);
  await page.waitForLoadState('networkidle').catch(() => {});
  return page;
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
