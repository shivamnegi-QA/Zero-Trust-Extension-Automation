/**
 * Unified extension fixture that adapts to the active Playwright project.
 *
 * - system-chrome  → Chrome via CDP (Playwright BrowserContext)
 * - system-firefox → Firefox via geckodriver (GdSession)
 * - system-safari  → Safari via safaridriver + osascript AX (SdSession)
 *
 * Exposes a browser-agnostic `ExtSession` object so the single extension spec
 * can drive all three browsers without per-browser conditionals in test code.
 */

import { test as base, expect, BrowserContext, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

// ── Env vars with runtime guard ───────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required environment variable ${name} is not set. Check your .env file.`);
  return v;
}

export const EMAIL    = requireEnv('EXTENSION_LOGIN_EMAIL');
export const PASSWORD = requireEnv('EXTENSION_LOGIN_PASSWORD');
export const BASE_URL = requireEnv('SQRX_BASE_URL');

// ── Safari UUID resolution ────────────────────────────────────────────────────

async function resolveSafariUuid(): Promise<string> {
  const { shellExec: _shellExec } = await import('../utils/system-safari') as { shellExec?: (cmd: string) => string };
  // Read UUID dynamically from pluginkit rather than using a hardcoded constant
  const { EXTENSION_BUNDLE_ID: bundleId } = await import('../utils/system-safari') as { EXTENSION_BUNDLE_ID?: string };
  if (bundleId) {
    try {
      const { execSync } = await import('child_process');
      const out = execSync(
        `pluginkit -m -v -i "${bundleId}" 2>/dev/null | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1`,
        { timeout: 5_000 }
      ).toString().trim();
      if (out) return out;
    } catch { /* fall through */ }
  }
  // Last resort: use the exported constant (may be wrong after reinstall)
  const { SAFARI_EXTENSION_UUID } = await import('../utils/system-safari');
  return SAFARI_EXTENSION_UUID;
}

// ── Browser-agnostic popup session interface ──────────────────────────────────

export interface PopupSession {
  /** Open the extension popup and return its body text */
  openPopup(): Promise<string>;
  /** Close the popup */
  closePopup(): Promise<void>;
  /** Navigate the main browser window to a URL */
  navigate(url: string): Promise<void>;
  /** Find a DOM element (returns element ID or null) */
  findElement(strategy: string, selector: string): Promise<string | null>;
  /** Click a DOM element by ID */
  clickElement(id: string): Promise<void>;
  /** Execute JavaScript and return the result */
  execute<T>(script: string, args?: unknown[]): Promise<T>;
  /** Type text into an element via the WebDriver sendKeys protocol (more reliable than JS for native inputs) */
  sendKeys(elementId: string, text: string): Promise<void>;
  /** Get the current page URL */
  currentUrl(): Promise<string>;
  /** Clear all cookies and extension storage to reset to unauthenticated state */
  clearAuth(): Promise<void>;
  /** Take a screenshot and save to filePath */
  screenshot(filePath: string): Promise<void>;
  /** Poll until predicate returns true */
  poll<T>(fn: () => Promise<T>, cond: (v: T) => boolean, opts: { timeout: number; interval: number; message: string }): Promise<T>;
  /** The extension's stable identifier (extensionId for Chrome/FF, UUID for Safari) */
  extensionKey: string;
  /** Human-readable browser name */
  browser: 'chrome' | 'firefox' | 'safari';
}

// ── Firefox shared popup helpers ──────────────────────────────────────────────

function makeFirefoxPopupMethods(
  session: any,
  getLastHandle: () => string | null,
  setLastHandle: (h: string | null) => void
) {
  const { openFirefoxExtensionPopup } = require('./firefox') as typeof import('./firefox');
  return {
    async openPopup(): Promise<string> {
      const popup = await openFirefoxExtensionPopup(session).catch(() => null);
      if (!popup) return '';
      await session.switchToWindow(popup.handle).catch(() => {});
      setLastHandle(popup.handle);
      const deadline = Date.now() + 10_000;
      let body = '';
      while (Date.now() < deadline) {
        body = await (session.execute(
          `return (document.body && (document.body.innerText || document.body.textContent)) || document.documentElement.innerText || ""`
        ) as Promise<string>).catch(() => '');
        if (body.trim().length > 0) break;
        await new Promise<void>(r => setTimeout(r, 500));
      }
      return body;
    },
    async closePopup(): Promise<void> {
      const lastHandle = getLastHandle();
      if (lastHandle) {
        await session.switchToWindow(lastHandle).catch(() => {});
        await session.closeWindow().catch(() => {});
      }
      const handles = await session.getWindowHandles().catch(() => [] as string[]);
      if (handles.length > 0) await session.switchToWindow(handles[0]).catch(() => {});
      setLastHandle(null);
    },
    async navigate(url: string): Promise<void> {
      const handles = await session.getWindowHandles().catch(() => [] as string[]);
      const mainHandle = handles.find((h: string) => h !== getLastHandle()) ?? handles[0];
      if (mainHandle) await session.switchToWindow(mainHandle).catch(() => {});
      await session.navigate(url);
    },
  };
}

// ── Chrome adapter ────────────────────────────────────────────────────────────

function makeChromeSession(context: BrowserContext, extensionId: string): PopupSession {
  const { openExtensionPopup } = require('../fixtures/base') as typeof import('../fixtures/base');
  let lastPopup: Page | null = null;

  async function poll<T>(fn: () => Promise<T>, cond: (v: T) => boolean, opts: { timeout: number; interval: number; message: string }): Promise<T> {
    const deadline = Date.now() + opts.timeout;
    let last: T | undefined;
    while (Date.now() < deadline) {
      try { last = await fn(); if (cond(last)) return last as T; } catch { /* retry */ }
      await new Promise<void>(r => setTimeout(r, opts.interval));
    }
    throw new Error(`${opts.message} (last: ${JSON.stringify(last)})`);
  }

  let navPage: Page | null = null;

  return {
    browser: 'chrome',
    extensionKey: extensionId,
    async openPopup() {
      if (lastPopup && !lastPopup.isClosed()) await lastPopup.close().catch(() => {});
      const popup = await openExtensionPopup(context, extensionId);
      lastPopup = popup;
      await popup.waitForTimeout(1_500);
      return popup.locator('body').innerText().catch(() => '');
    },
    async closePopup() {
      if (lastPopup && !lastPopup.isClosed()) await lastPopup.close().catch(() => {});
      lastPopup = null;
    },
    async navigate(url) {
      if (!navPage || navPage.isClosed()) {
        navPage = await context.newPage();
      }
      await navPage.goto(url);
    },
    async findElement(strategy, selector) {
      const pages = context.pages();
      const page = pages[pages.length - 1];
      if (!page) return null;
      try {
        const loc = strategy === 'css selector' ? page.locator(selector) : page.locator(`xpath=${selector}`);
        const el = loc.first();
        const visible = await el.isVisible({ timeout: 2_000 }).catch(() => false);
        return visible ? selector : null;
      } catch { return null; }
    },
    async clickElement(id) {
      const pages = context.pages();
      const page = pages[pages.length - 1];
      if (!page) return;
      const loc = page.locator(id).first();
      await loc.click({ timeout: 5_000 });
    },
    async execute<T>(script: string, args: unknown[] = []) {
      const pages = context.pages();
      const page = pages[pages.length - 1];
      if (!page) throw new Error('No page available');
      // Wrap as a W3C-style execute/sync call: fn receives args as 'arguments'
      return page.evaluate(
        ({ script: s, args: a }: { script: string; args: unknown[] }) =>
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          (new Function(s)).apply(null, a) as T,
        { script, args },
      );
    },
    async sendKeys(elementId: string, text: string) {
      const pages = context.pages();
      const page = pages[pages.length - 1];
      if (!page) return;
      await page.locator(elementId).fill(text);
    },
    async currentUrl() {
      const pages = context.pages();
      const page = pages[pages.length - 1];
      return page?.url() ?? '';
    },
    async clearAuth() {
      await context.clearCookies();
      // Clear localStorage on the dashboard origin
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
      } finally { await page.close(); }
      if (navPage && !navPage.isClosed()) { await navPage.close().catch(() => {}); navPage = null; }
      // Clear extension storage via service worker
      const sw = context.serviceWorkers().find(w => w.url().includes(extensionId))
        ?? context.serviceWorkers()[0];
      if (sw) {
        await sw.evaluate(`Promise.all([
          new Promise(r => chrome.storage.local.clear(r)),
          new Promise(r => chrome.storage.sync.clear(r)),
        ])`).catch(() => {});
        await new Promise<void>(r => setTimeout(r, 1_500));
      }
    },
    async screenshot(filePath) {
      if (lastPopup && !lastPopup.isClosed()) await lastPopup.screenshot({ path: filePath });
    },
    poll,
  };
}

// ── Fixture types ─────────────────────────────────────────────────────────────

type ExtensionFixtures = {
  extSession: PopupSession;
  extId: string;
};

// ── Unified test fixture ──────────────────────────────────────────────────────

export const test = base.extend<{}, ExtensionFixtures>({
  // extId: the extension identifier (extensionId for Chrome/FF, UUID for Safari)
  extId: [async ({}, use, testInfo) => {
    const project = testInfo.project.name;

    if (project === 'system-chrome') {
      const { extensionIdFromManifestKey } = await import('../utils/system-chrome');
      const extPath = process.env.EXTENSION_PATH
        ? path.resolve(process.env.EXTENSION_PATH)
        : path.resolve('extension builds/extension-unpacked');
      await use(extensionIdFromManifestKey(extPath));

    } else if (project === 'system-firefox') {
      const ffExtPath = process.env.FIREFOX_EXTENSION_PATH
        ? path.resolve(process.env.FIREFOX_EXTENSION_PATH)
        : path.resolve('extension builds/firefox-1.4.3/build');
      try {
        const { readFileSync } = await import('fs');
        const manifest = JSON.parse(readFileSync(path.join(ffExtPath, 'manifest.json'), 'utf8'));
        const id = manifest?.browser_specific_settings?.gecko?.id ?? manifest?.applications?.gecko?.id ?? '';
        await use(id);
      } catch { await use(''); }

    } else if (project === 'system-safari') {
      await use(await resolveSafariUuid());

    } else if (project === 'windows-chrome' || project === 'windows-edge') {
      const { extensionIdFromManifestKey } = await import('../utils/system-windows-chrome');
      const extPath = process.env.EXTENSION_PATH
        ? path.resolve(process.env.EXTENSION_PATH)
        : path.resolve('extension builds/chrome-1.4.3/build');
      await use(extensionIdFromManifestKey(extPath));

    } else if (project === 'windows-firefox') {
      const ffExtPath = process.env.FIREFOX_EXTENSION_PATH
        ? path.resolve(process.env.FIREFOX_EXTENSION_PATH)
        : path.resolve('extension builds/firefox-1.4.3');
      try {
        const { readFileSync } = await import('fs');
        const manifest = JSON.parse(readFileSync(path.join(ffExtPath, 'manifest.json'), 'utf8'));
        const id = manifest?.browser_specific_settings?.gecko?.id ?? manifest?.applications?.gecko?.id ?? '';
        await use(id);
      } catch { await use(''); }

    } else {
      await use('');
    }
  }, { scope: 'worker' }],

  extSession: [async ({ extId }, use, testInfo) => {
    const project = testInfo.project.name;

    if (project === 'system-chrome') {
      const { launchSystemChromeWithExtension } = await import('../utils/system-chrome');
      const { chromium } = await import('@playwright/test');
      const { mkdtempSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { rmSync } = await import('fs');

      const extPath = process.env.EXTENSION_PATH
        ? path.resolve(process.env.EXTENSION_PATH)
        : path.resolve('extension builds/extension-unpacked');
      const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-test-'));

      const { cdpEndpoint, teardown } = await launchSystemChromeWithExtension({
        extensionPath: extPath,
        profilePath: tmpProfile,
        tag: '[fixture]',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let browser: any = null;
      try {
        browser = await chromium.connectOverCDP(cdpEndpoint);
        const context = browser.contexts()[0] ?? await browser.newContext();
        await use(makeChromeSession(context, extId));
      } finally {
        await teardown();
        await browser?.close().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        try { rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* Chrome may still hold locks; OS will clean up */ }
      }

    } else if (project === 'system-firefox') {
      const { launchFirefoxWithExtension } = await import('../utils/system-firefox');
      const { mkdtempSync, rmSync } = await import('fs');
      const { tmpdir } = await import('os');

      const ffExtPath = process.env.FIREFOX_EXTENSION_PATH
        ? path.resolve(process.env.FIREFOX_EXTENSION_PATH)
        : path.resolve('extension builds/firefox-1.4.3/build');
      const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-ff-test-'));

      const { session, teardown } = await launchFirefoxWithExtension({
        extensionPath: ffExtPath,
        profilePath: tmpProfile,
        tag: '[fixture:firefox]',
      });

      let lastHandle: string | null = null;

      const ffSession: PopupSession = {
        browser: 'firefox',
        extensionKey: extId,
        ...makeFirefoxPopupMethods(
          session,
          () => lastHandle,
          (h) => { lastHandle = h; }
        ),
        findElement: (s, sel) => session.findElement(s, sel),
        clickElement: (id) => session.clickElement(id),
        execute: <T>(script: string, args: unknown[] = []) => session.execute<T>(script, args),
        sendKeys: (id, text) => session.json('POST', `/session/${session.sessionId}/element/${id}/value`, { value: text.split(''), text }).then(() => {}),
        currentUrl: () => session.currentUrl(),
        screenshot: (p) => session.screenshot(p),
        poll: (fn, cond, opts) => session.poll(fn, cond, opts),
        async clearAuth() {
          await session.deleteAllCookies();
          // Navigate to origin to clear localStorage before going to about:blank
          const handles = await session.getWindowHandles().catch(() => [] as string[]);
          const mainHandle = handles.find(h => h !== lastHandle) ?? handles[0];
          if (mainHandle) await session.switchToWindow(mainHandle).catch(() => {});
          await session.navigate(BASE_URL).catch(() => {});
          await session.execute<void>(
            'try { localStorage.clear(); sessionStorage.clear(); } catch(e) {}'
          ).catch(() => {});
          await session.navigate('about:blank').catch(() => {});
          await new Promise<void>(r => setTimeout(r, 500));
        },
      };

      try {
        await use(ffSession);
      } finally {
        await teardown();
        await session.deleteSession().catch(() => {});
        const { rmSync: rm2 } = await import('fs');
        rm2(tmpProfile, { recursive: true, force: true });
      }

    } else if (project === 'system-safari') {
      const { launchSafariWithExtension, closeSafariPopupViaAX, screenshotSafariPopup } = await import('../utils/system-safari');
      const safari = await import('../fixtures/safari');

      const extractedDir = process.env.SAFARI_EXTENSION_DIR
        ? path.resolve(process.env.SAFARI_EXTENSION_DIR)
        : path.resolve('extension builds/safari-1.4.3');

      const { session, teardown } = await launchSafariWithExtension({
        extractedDir,
        zipPath: process.env.SAFARI_EXTENSION_ZIP ? path.resolve(process.env.SAFARI_EXTENSION_ZIP) : undefined,
        tag: '[fixture:safari]',
      });

      const sfSession: PopupSession = {
        browser: 'safari',
        extensionKey: extId,
        async openPopup() {
          const { bodyText } = await session.openExtensionPopup().catch(() => ({ bodyText: '' }));
          return bodyText;
        },
        async closePopup() {
          closeSafariPopupViaAX();
          await new Promise<void>(r => setTimeout(r, 300));
        },
        navigate: (url) => session.navigate(url).then(() => {}),
        findElement: (s, sel) => session.findElement(s, sel),
        clickElement: (id) => session.clickElement(id),
        execute: <T>(script: string, args: unknown[] = []) => session.execute<T>(script, args),
        sendKeys: (id, text) => session.sendKeys(id, text),
        currentUrl: () => session.currentUrl(),
        screenshot: (p) => { screenshotSafariPopup(p); return Promise.resolve(); },
        poll: (fn, cond, opts) => session.poll(fn, cond, opts),
        async clearAuth() {
          await session.deleteAllCookies();
          await session.navigate('about:blank');
          await new Promise<void>(r => setTimeout(r, 500));
        },
      };

      await use(sfSession);
      await session.deleteSession().catch(() => {});
      await teardown();

    } else if (project === 'windows-chrome') {
      const { launchWindowsBrowserWithExtension } = await import('../utils/system-windows-chrome');
      const { chromium } = await import('@playwright/test');
      const { mkdtempSync, rmSync } = await import('fs');
      const { tmpdir } = await import('os');

      const extPath = process.env.EXTENSION_PATH
        ? path.resolve(process.env.EXTENSION_PATH)
        : path.resolve('extension builds/chrome-1.4.3/build');
      const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-winchrome-'));

      const { cdpEndpoint, teardown } = await launchWindowsBrowserWithExtension({
        extensionPath: extPath,
        profilePath: tmpProfile,
        tag: '[fixture:windows-chrome]',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let browser: any = null;
      try {
        browser = await chromium.connectOverCDP(cdpEndpoint);
        const context = browser.contexts()[0] ?? await browser.newContext();
        await use(makeChromeSession(context, extId));
      } finally {
        await teardown();
        await browser?.close().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        try { rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* Chrome may still hold locks; OS will clean up */ }
      }

    } else if (project === 'windows-edge') {
      const { launchWindowsEdgeWithExtension } = await import('../utils/system-windows-edge');
      const { chromium } = await import('@playwright/test');
      const { mkdtempSync, rmSync } = await import('fs');
      const { tmpdir } = await import('os');

      const extPath = process.env.EXTENSION_PATH
        ? path.resolve(process.env.EXTENSION_PATH)
        : path.resolve('extension builds/chrome-1.4.3/build');
      const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-winedge-'));

      const { cdpEndpoint, teardown } = await launchWindowsEdgeWithExtension({
        extensionPath: extPath,
        profilePath: tmpProfile,
        tag: '[fixture:windows-edge]',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let browser: any = null;
      try {
        browser = await chromium.connectOverCDP(cdpEndpoint);
        const context = browser.contexts()[0] ?? await browser.newContext();
        await use(makeChromeSession(context, extId));
      } finally {
        await teardown();
        await browser?.close().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        try { rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* Chrome may still hold locks; OS will clean up */ }
      }

    } else if (project === 'windows-firefox') {
      const { launchFirefoxWithExtension } = await import('../utils/system-firefox');
      const { mkdtempSync, rmSync } = await import('fs');
      const { tmpdir } = await import('os');

      const ffExtPath = process.env.FIREFOX_EXTENSION_PATH
        ? path.resolve(process.env.FIREFOX_EXTENSION_PATH)
        : path.resolve('extension builds/firefox-1.4.3');
      const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-winff-'));

      const { session, teardown } = await launchFirefoxWithExtension({
        extensionPath: ffExtPath,
        profilePath: tmpProfile,
        tag: '[fixture:windows-firefox]',
      });

      let lastHandle: string | null = null;

      const winFfSession: PopupSession = {
        browser: 'firefox',
        extensionKey: extId,
        ...makeFirefoxPopupMethods(
          session,
          () => lastHandle,
          (h) => { lastHandle = h; }
        ),
        findElement: (s, sel) => session.findElement(s, sel),
        clickElement: (id) => session.clickElement(id),
        execute: <T>(script: string, args: unknown[] = []) => session.execute<T>(script, args),
        sendKeys: (id, text) => session.json('POST', `/session/${session.sessionId}/element/${id}/value`, { value: text.split(''), text }).then(() => {}),
        currentUrl: () => session.currentUrl(),
        screenshot: (p) => session.screenshot(p),
        poll: (fn, cond, opts) => session.poll(fn, cond, opts),
        async clearAuth() {
          await session.deleteAllCookies();
          // Navigate to origin to clear localStorage before going to about:blank
          const handles = await session.getWindowHandles().catch(() => [] as string[]);
          const mainHandle = handles.find(h => h !== lastHandle) ?? handles[0];
          if (mainHandle) await session.switchToWindow(mainHandle).catch(() => {});
          await session.navigate(BASE_URL).catch(() => {});
          await session.execute<void>(
            'try { localStorage.clear(); sessionStorage.clear(); } catch(e) {}'
          ).catch(() => {});
          await session.navigate('about:blank').catch(() => {});
          await new Promise<void>(r => setTimeout(r, 500));
        },
      };

      try {
        await use(winFfSession);
      } finally {
        await teardown();
        await session.deleteSession().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        try { rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* may still hold locks; OS will clean up */ }
      }

    } else {
      throw new Error(`Unknown project: ${testInfo.project.name}`);
    }
  }, { scope: 'worker' }],
});

export { expect };
