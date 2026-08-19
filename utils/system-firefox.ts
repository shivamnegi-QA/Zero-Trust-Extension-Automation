// Utilities for launching system Firefox via geckodriver and loading the ZTB extension.
//
// Flow:
//   1. Start geckodriver on a free port
//   2. Create a WebDriver session with system Firefox
//   3. Install the extension via POST /session/{id}/moz/addon/install (no NSOpenPanel)
//   4. Read the extension's internal UUID from prefs.js
//   5. Return a GdSession that wraps geckodriver's WebDriver API for test use

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { FIREFOX_BINARY, GECKODRIVER, IS_WINDOWS } from './platform';
import { sleep, getFreePort, killProcessTree } from './shared';

export { FIREFOX_BINARY, GECKODRIVER };

// ── WebDriver client ──────────────────────────────────────────────────────────

export class GdSession {
  private base: string;
  public sessionId = '';
  public profilePath = '';

  // Internal UUID assigned by Firefox for this session (moz-extension://<uuid>/)
  public extensionUuid = '';
  // Manifest extension ID (browser_specific_settings.gecko.id)
  public extensionId = '';

  constructor(gdPort: number) {
    this.base = `http://127.0.0.1:${gdPort}`;
  }

  async json(method: string, p: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/url`, { url });
  }

  async currentUrl(): Promise<string> {
    const d = await this.json('GET', `/session/${this.sessionId}/url`) as { value: string };
    return d.value;
  }

  // ── Script execution ────────────────────────────────────────────────────────

  async execute<T>(script: string, args: unknown[] = []): Promise<T> {
    const d = await this.json('POST', `/session/${this.sessionId}/execute/sync`, { script, args }) as { value: T };
    return d.value;
  }

  async executeAsync<T>(script: string, args: unknown[] = []): Promise<T> {
    const d = await this.json('POST', `/session/${this.sessionId}/execute/async`, { script, args }) as { value: T };
    return d.value;
  }

  // ── Element finding ─────────────────────────────────────────────────────────

  async findElement(strategy: string, selector: string): Promise<string | null> {
    try {
      const d = await this.json('POST', `/session/${this.sessionId}/element`, { using: strategy, value: selector }) as {
        value: Record<string, string> | { error: string }
      };
      if ('error' in d.value) return null;
      return Object.values(d.value)[0];
    } catch { return null; }
  }

  async findElements(strategy: string, selector: string): Promise<string[]> {
    const d = await this.json('POST', `/session/${this.sessionId}/elements`, { using: strategy, value: selector }) as {
      value: Array<Record<string, string>>
    };
    return (d.value ?? []).map(e => Object.values(e)[0]);
  }

  async getElementText(elementId: string): Promise<string> {
    const d = await this.json('GET', `/session/${this.sessionId}/element/${elementId}/text`) as { value: string };
    return d.value ?? '';
  }

  async isElementDisplayed(elementId: string): Promise<boolean> {
    try {
      const d = await this.json('GET', `/session/${this.sessionId}/element/${elementId}/displayed`) as { value: boolean };
      return d.value ?? false;
    } catch { return false; }
  }

  async clickElement(elementId: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/element/${elementId}/click`, {});
  }

  // ── Page text ───────────────────────────────────────────────────────────────

  async bodyText(): Promise<string> {
    return this.execute<string>('return document.body.innerText || document.body.textContent || ""');
  }

  // ── Windows/tabs ────────────────────────────────────────────────────────────

  async getWindowHandles(): Promise<string[]> {
    const d = await this.json('GET', `/session/${this.sessionId}/window/handles`) as { value: string[] };
    return d.value ?? [];
  }

  async switchToWindow(handle: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/window`, { handle });
  }

  async newWindow(type: 'window' | 'tab' = 'tab'): Promise<string> {
    const d = await this.json('POST', `/session/${this.sessionId}/window/new`, { type }) as { value: { handle: string } };
    return d.value.handle;
  }

  async getCurrentWindow(): Promise<string> {
    const d = await this.json('GET', `/session/${this.sessionId}/window`) as { value: string };
    return d.value;
  }

  async closeWindow(): Promise<void> {
    await this.json('DELETE', `/session/${this.sessionId}/window`).catch(() => {});
  }

  // ── Cookies ──────────────────────────────────────────────────────────────────

  async deleteAllCookies(): Promise<void> {
    await this.json('DELETE', `/session/${this.sessionId}/cookie`).catch(() => {});
  }

  // ── Session ──────────────────────────────────────────────────────────────────

  async deleteSession(): Promise<void> {
    if (this.sessionId) {
      await this.json('DELETE', `/session/${this.sessionId}`).catch(() => {});
      this.sessionId = '';
    }
  }

  // ── Screenshot ───────────────────────────────────────────────────────────────

  async screenshot(filePath: string): Promise<void> {
    const d = await this.json('GET', `/session/${this.sessionId}/screenshot`) as { value: string };
    if (d.value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(d.value, 'base64'));
    }
  }

  // ── Poll helper ──────────────────────────────────────────────────────────────

  async poll<T>(
    fn: () => Promise<T>,
    predicate: (v: T) => boolean,
    opts: { timeout?: number; interval?: number; message?: string } = {}
  ): Promise<T> {
    const { timeout = 30_000, interval = 2_000, message = 'poll timed out' } = opts;
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    while (Date.now() < deadline) {
      try { last = await fn(); if (predicate(last)) return last; } catch { /* retry */ }
      await sleep(interval);
    }
    throw new Error(`${message} (last value: ${JSON.stringify(last)})`);
  }

  // ── Open extension popup ─────────────────────────────────────────────────────

  async openExtensionPopup(): Promise<{ handle: string; popupUrl: string }> {
    if (!this.extensionUuid) throw new Error('extensionUuid not set — call installExtension() first');
    const popupUrl = `moz-extension://${this.extensionUuid}/popup.html`;

    // Check if popup is already open
    const handles = await this.getWindowHandles();
    for (const h of handles) {
      await this.switchToWindow(h);
      const url = await this.currentUrl().catch(() => '');
      if (url.startsWith(`moz-extension://${this.extensionUuid}`)) return { handle: h, popupUrl };
    }

    // Open in a new tab
    const handle = await this.newWindow('tab');
    await this.switchToWindow(handle);
    await this.navigate(popupUrl);
    await sleep(1000);
    return { handle, popupUrl };
  }

  async closeOtherWindows(keepHandle: string): Promise<void> {
    const handles = await this.getWindowHandles();
    for (const h of handles) {
      if (h !== keepHandle) {
        await this.switchToWindow(h).catch(() => {});
        await this.closeWindow().catch(() => {});
      }
    }
    await this.switchToWindow(keepHandle).catch(() => {});
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FirefoxLaunchResult {
  session: GdSession;
  teardown: () => Promise<void>;
}

export async function launchFirefoxWithExtension(opts: {
  extensionPath: string;
  profilePath: string;
  tag?: string;
}): Promise<FirefoxLaunchResult> {
  const { extensionPath, profilePath } = opts;
  const tag = opts.tag ?? '[system-firefox]';
  const manifestPath = path.join(extensionPath, 'manifest.json');

  // Read extension ID from manifest
  let extensionId = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    extensionId = manifest?.browser_specific_settings?.gecko?.id
      ?? manifest?.applications?.gecko?.id
      ?? '';
  } catch { /* no ID — temporary addons use a generated UUID */ }

  fs.mkdirSync(profilePath, { recursive: true });

  const gdPort = await getFreePort();

  // --allow-system-access is required (Firefox 138+) to allow WebDriver to navigate
  // to privileged URLs such as moz-extension:// pages.
  const driver = cp.spawn(GECKODRIVER, [`--port=${gdPort}`, '--allow-system-access'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: false,
  });

  let ffPid: number | null = null;

  const teardown = async (): Promise<void> => {
    // Kill GeckoDriver with /T FIRST — this terminates GeckoDriver, Firefox, and
    // all Firefox sub-processes while the tree is intact.
    // Killing Firefox by PID first would orphan its content/GPU processes.
    if (driver.pid != null) killProcessTree(driver.pid);
    else driver.kill('SIGTERM');
    // Belt-and-suspenders: also kill Firefox by its own PID.
    killProcessTree(ffPid ?? undefined);
    await sleep(800);
  };

  try {
    // Wait for geckodriver to be ready
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${gdPort}/status`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) break;
      } catch { await sleep(300); }
    }
    console.log(`${tag} geckodriver ready on port ${gdPort}`);

    const session = new GdSession(gdPort);

    // Create WebDriver session with system Firefox
    const data = await session.json('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            binary: FIREFOX_BINARY,
            args: ['--no-remote', '--profile', profilePath],
            prefs: {
              'devtools.debugger.remote-enabled': true,
              'devtools.debugger.prompt-connection': false,
              'devtools.chrome.enabled': true,
            },
          },
        },
      },
    }) as { value: { sessionId?: string; capabilities?: Record<string, unknown> } };

    if (!data?.value?.sessionId) {
      throw new Error(`Session creation failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    session.sessionId = data.value.sessionId;
    session.profilePath = profilePath;
    session.extensionId = extensionId;
    ffPid = (data.value.capabilities?.['moz:processID'] as number | undefined) ?? null;
    console.log(`${tag} Session: ${session.sessionId}, FF PID: ${ffPid}`);

    await sleep(2000);

    // Install extension via geckodriver's moz/addon/install — no NSOpenPanel needed
    console.log(`${tag} Installing extension via moz/addon/install...`);
    const installData = await session.json(
      'POST',
      `/session/${session.sessionId}/moz/addon/install`,
      { path: extensionPath, temporary: true }
    ) as { value: unknown };

    const addonResult = installData?.value;
    if (typeof addonResult === 'object' && addonResult !== null && 'error' in addonResult) {
      throw new Error(`Extension install failed: ${JSON.stringify(addonResult).slice(0, 300)}`);
    }
    console.log(`${tag} Extension installed: ${addonResult}`);
    await sleep(2000);

    // Read extension UUID from prefs.js
    const prefsPath = path.join(profilePath, 'prefs.js');
    if (fs.existsSync(prefsPath)) {
      const prefs = fs.readFileSync(prefsPath, 'utf8');
      const match = prefs.match(/"extensions\.webextensions\.uuids", "(.+?)"\)/);
      if (match) {
        const raw = match[1].replace(/\\"/g, '"');
        const uuids = JSON.parse(raw) as Record<string, string>;
        session.extensionUuid = uuids[extensionId] ?? uuids[String(addonResult)] ?? '';
        console.log(`${tag} Extension UUID: ${session.extensionUuid}`);
      }
    }

    if (!session.extensionUuid) {
      throw new Error('Could not determine extension UUID from prefs.js — extension may not have loaded');
    }

    return { session, teardown };

  } catch (err) {
    await teardown();
    throw err;
  }
}
