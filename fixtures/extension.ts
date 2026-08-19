/**
 * Unified extension fixture that adapts to the active Playwright project.
 *
 * - system-chrome  → Chrome via CDP (Playwright BrowserContext)
 * - system-firefox → Firefox via geckodriver (GdSession)
 *
 * Exposes a browser-agnostic `ExtSession` object so the single extension spec
 * can drive all browsers without per-browser conditionals in test code.
 */

import { test as base, expect, BrowserContext, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { GdSession } from '../utils/system-firefox';

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
  /** The extension's stable identifier (extensionId for Chrome/FF) */
  extensionKey: string;
  /** Human-readable browser name */
  browser: 'chrome' | 'firefox';
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

function makeChromeSession(context: BrowserContext, extensionId: string, _cdpEndpoint: string): PopupSession {
  const { openExtensionPopupBodyText, closeExtensionPopup } = require('../fixtures/base') as typeof import('../fixtures/base');

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
  let lastPopupPage: Page | null = null;

  return {
    browser: 'chrome',
    extensionKey: extensionId,
    async openPopup() {
      await closeExtensionPopup(context, extensionId).catch(() => {});
      if (lastPopupPage && !lastPopupPage.isClosed()) { await lastPopupPage.close().catch(() => {}); lastPopupPage = null; }
      const anchor = (navPage && !navPage.isClosed()) ? navPage : undefined;
      const body = await openExtensionPopupBodyText(context, extensionId, anchor);
      // Open a navigated page for subsequent findElement/clickElement calls on the popup
      const popupUrl = `chrome-extension://${extensionId}/popup.html`;
      lastPopupPage = await context.newPage();
      await lastPopupPage.goto(popupUrl).catch(() => {});
      await lastPopupPage.waitForLoadState('networkidle').catch(() => {});
      return body;
    },
    async closePopup() {
      await closeExtensionPopup(context, extensionId).catch(() => {});
      if (lastPopupPage && !lastPopupPage.isClosed()) { await lastPopupPage.close().catch(() => {}); lastPopupPage = null; }
    },
    async navigate(url) {
      if (!navPage || navPage.isClosed()) {
        navPage = await context.newPage();
      }
      await navPage.goto(url);
    },
    async findElement(strategy, selector) {
      const pg = (lastPopupPage && !lastPopupPage.isClosed()) ? lastPopupPage
               : (navPage && !navPage.isClosed()) ? navPage : null;
      if (!pg) return null;
      try {
        const loc = strategy === 'css selector' ? pg.locator(selector) : pg.locator(`xpath=${selector}`);
        const visible = await loc.first().isVisible({ timeout: 2_000 }).catch(() => false);
        return visible ? selector : null;
      } catch { return null; }
    },
    async clickElement(id) {
      const pg = (lastPopupPage && !lastPopupPage.isClosed()) ? lastPopupPage
               : (navPage && !navPage.isClosed()) ? navPage : null;
      if (!pg) return;
      await pg.locator(id).first().click({ timeout: 5_000 });
    },
    async execute<T>(script: string, args: unknown[] = []) {
      const pg = (lastPopupPage && !lastPopupPage.isClosed()) ? lastPopupPage
               : (navPage && !navPage.isClosed()) ? navPage : null;
      if (!pg) throw new Error('No page available');
      return pg.evaluate(
        ({ script: s, args: a }: { script: string; args: unknown[] }) =>
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          (new Function(s)).apply(null, a) as T,
        { script, args },
      );
    },
    async sendKeys(elementId: string, text: string) {
      const pg = (lastPopupPage && !lastPopupPage.isClosed()) ? lastPopupPage
               : (navPage && !navPage.isClosed()) ? navPage : null;
      if (!pg) return;
      await pg.locator(elementId).fill(text);
    },
    async currentUrl() {
      return navPage?.url() ?? '';
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
      // Screenshot not available with CDP-based popup reading
    },
    poll,
  };
}

// ── Fixture types ─────────────────────────────────────────────────────────────

type ExtensionFixtures = {
  extSession: PopupSession;
  extId: string;
};

// ── Per-project browser descriptors ───────────────────────────────────────────
//
// Every project differs only in which launcher to call and which paths to use, so the
// launch/teardown flow lives once per engine and the per-project values live here.
// Windows entries stay in the table on macOS (and vice versa) so the same fixture keeps
// working when the suite runs on a real Windows machine — playwright.config.ts decides
// which projects are active for the current OS, not this table.

type LaunchOptions = { extensionPath: string; profilePath: string; tag: string };

interface ProjectSpecBase {
  /** Env var that overrides the extension path, with the fallback used when unset. */
  extPathEnv: 'EXTENSION_PATH' | 'FIREFOX_EXTENSION_PATH';
  defaultExtPath: string;
  tmpPrefix: string;
  tag: string;
}

// Lazy launcher imports keep Windows-only modules from loading on macOS, and vice versa.
interface ChromiumProjectSpec extends ProjectSpecBase {
  engine: 'chromium';
  launch: (opts: LaunchOptions) => Promise<{ cdpEndpoint: string; teardown: () => Promise<void> }>;
}

interface FirefoxProjectSpec extends ProjectSpecBase {
  engine: 'firefox';
  launch: (opts: LaunchOptions) => Promise<{ session: GdSession; teardown: () => Promise<void> }>;
}

type ProjectSpec = ChromiumProjectSpec | FirefoxProjectSpec;

const CHROME_EXT_DEFAULT = 'extension builds/chrome-1.4.3/build';

const PROJECTS: Record<string, ProjectSpec> = {
  'system-chrome': {
    engine: 'chromium',
    extPathEnv: 'EXTENSION_PATH',
    defaultExtPath: CHROME_EXT_DEFAULT,
    tmpPrefix: 'ztb-test-',
    tag: '[fixture]',
    launch: async (o) => (await import('../utils/system-chrome')).launchSystemChromeWithExtension(o),
  },
  'system-firefox': {
    engine: 'firefox',
    extPathEnv: 'FIREFOX_EXTENSION_PATH',
    defaultExtPath: 'extension builds/firefox-1.4.3/build',
    tmpPrefix: 'ztb-ff-test-',
    tag: '[fixture:firefox]',
    launch: async (o) => (await import('../utils/system-firefox')).launchFirefoxWithExtension(o),
  },
  'windows-chrome': {
    engine: 'chromium',
    extPathEnv: 'EXTENSION_PATH',
    defaultExtPath: CHROME_EXT_DEFAULT,
    tmpPrefix: 'ztb-winchrome-',
    tag: '[fixture:windows-chrome]',
    launch: async (o) => (await import('../utils/system-windows-chrome')).launchWindowsBrowserWithExtension(o),
  },
  'windows-edge': {
    engine: 'chromium',
    extPathEnv: 'EXTENSION_PATH',
    defaultExtPath: CHROME_EXT_DEFAULT,
    tmpPrefix: 'ztb-winedge-',
    tag: '[fixture:windows-edge]',
    launch: async (o) => (await import('../utils/system-windows-edge')).launchWindowsEdgeWithExtension(o),
  },
  'windows-firefox': {
    engine: 'firefox',
    extPathEnv: 'FIREFOX_EXTENSION_PATH',
    // Windows builds ship unpacked at the bundle root, not under build/.
    defaultExtPath: 'extension builds/firefox-1.4.3',
    tmpPrefix: 'ztb-winff-',
    tag: '[fixture:windows-firefox]',
    launch: async (o) => (await import('../utils/system-firefox')).launchFirefoxWithExtension(o),
  },
};

function resolveExtPath(spec: ProjectSpec): string {
  const override = process.env[spec.extPathEnv];
  return path.resolve(override ? override : spec.defaultExtPath);
}

/** Firefox reports its extension id from the manifest rather than a hashed key. */
function firefoxExtensionId(extPath: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    return manifest?.browser_specific_settings?.gecko?.id ?? manifest?.applications?.gecko?.id ?? '';
  } catch { return ''; }
}

// ── Unified test fixture ──────────────────────────────────────────────────────

export const test = base.extend<{}, ExtensionFixtures>({
  // extId: the extension identifier (extensionId for Chrome/FF)
  extId: [async ({}, use, workerInfo) => {
    const spec = PROJECTS[workerInfo.project.name];
    if (!spec) { await use(''); return; }

    const extPath = resolveExtPath(spec);
    if (spec.engine === 'firefox') {
      await use(firefoxExtensionId(extPath));
    } else {
      const { extensionIdFromManifestKey } = await import('../utils/shared');
      await use(extensionIdFromManifestKey(extPath));
    }
  }, { scope: 'worker' }],

  extSession: [async ({ extId }, use, workerInfo) => {
    const spec = PROJECTS[workerInfo.project.name];
    if (!spec) throw new Error(`Unknown project: ${workerInfo.project.name}`);

    const extensionPath = resolveExtPath(spec);
    const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), spec.tmpPrefix));

    if (spec.engine === 'chromium') {
      // Chromium engines (Chrome on either OS, Edge on Windows) all expose CDP, so the
      // popup is driven through a Playwright context regardless of which driver launched it.
      const { chromium } = await import('@playwright/test');
      const { cdpEndpoint, teardown } = await spec.launch({ extensionPath, profilePath, tag: spec.tag });

      let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
      try {
        browser = await chromium.connectOverCDP(cdpEndpoint);
        const context = browser.contexts()[0] ?? await browser.newContext();
        await use(makeChromeSession(context, extId, cdpEndpoint));
      } finally {
        await teardown();
        await browser?.close().catch(() => {});
        // Give the browser time to release profile locks before removing the dir.
        await new Promise(r => setTimeout(r, 1500));
        try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch { /* OS will clean up */ }
      }

    } else {
      // Firefox has no CDP, so the popup is driven over geckodriver's WebDriver session.
      const { session, teardown } = await spec.launch({ extensionPath, profilePath, tag: spec.tag });

      let lastHandle: string | null = null;
      const ffSession: PopupSession = {
        browser: 'firefox',
        extensionKey: extId,
        ...makeFirefoxPopupMethods(session, () => lastHandle, (h) => { lastHandle = h; }),
        findElement: (s, sel) => session.findElement(s, sel),
        clickElement: (id) => session.clickElement(id),
        execute: <T>(script: string, args: unknown[] = []) => session.execute<T>(script, args),
        sendKeys: (id, text) => session
          .json('POST', `/session/${session.sessionId}/element/${id}/value`, { value: text.split(''), text })
          .then(() => {}),
        currentUrl: () => session.currentUrl(),
        screenshot: (p) => session.screenshot(p),
        poll: (fn, cond, opts) => session.poll(fn, cond, opts),
        async clearAuth() {
          await session.deleteAllCookies();
          // localStorage is origin-scoped, so switch off the popup window before clearing.
          const handles = await session.getWindowHandles().catch(() => [] as string[]);
          const mainHandle = handles.find(h => h !== lastHandle) ?? handles[0];
          if (mainHandle) await session.switchToWindow(mainHandle).catch(() => {});
          await session.navigate(BASE_URL).catch(() => {});
          await session.execute<void>('try { localStorage.clear(); sessionStorage.clear(); } catch(e) {}').catch(() => {});
        },
      };

      try {
        await use(ffSession);
      } finally {
        await teardown();
        await session.deleteSession().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch { /* OS will clean up */ }
      }
    }
  }, { scope: 'worker' }],
});

export { expect };
