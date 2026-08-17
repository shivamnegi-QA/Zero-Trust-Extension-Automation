// Purpose: Load ZTB extension into system Chrome via the "Load unpacked" UI flow.
//
// Background:
//   --load-extension is hardcoded-disabled in official Google Chrome (extension_service.cc:419).
//   However, the UI "Load unpacked" button calls chrome.developerPrivate.loadUnpacked() which
//   is NOT blocked — it opens a native macOS NSOpenPanel directory picker. When the user selects
//   a folder, Chrome loads it as a developer extension without any MDM interference.
//
// Automation strategy:
//   1. Launch system Chrome via ChromeDriver (no --load-extension flag)
//   2. Navigate to chrome://extensions/ and enable developer mode
//   3. Click the "Load unpacked" button (triggers native OS directory picker)
//   4. Use AppleScript to type the extension path into the picker and confirm
//
// Requirement: Accessibility permission for osascript
//   To grant: System Settings → Privacy & Security → Accessibility → add Terminal.app or VS Code
//
// Usage: npx tsx scripts/appium-load-extension.ts

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as net from 'net';
import * as cp from 'child_process';

const EXTENSION_PATH = path.resolve(process.env.EXTENSION_PATH ?? 'extension builds/extension-unpacked');
const HELPER_PATH    = path.resolve('extension builds/popup-helper-extension');

const CHROME_BINARY  = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROMEDRIVER   = '/opt/homebrew/bin/chromedriver';

// ── helpers ───────────────────────────────────────────────────────────────────

function extensionIdFromManifestKey(extPath: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    if (!manifest.key) return '';
    const der  = Buffer.from(manifest.key, 'base64');
    const hash = crypto.createHash('sha256').update(der).digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
      id += String.fromCharCode(97 + (hash[i] >> 4));
      id += String.fromCharCode(97 + (hash[i] & 0xf));
    }
    return id;
  } catch {
    return '';
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Path to the compiled Swift AX helper that opens the Go to Folder sub-sheet
// and focuses its text field so System Events keystrokes can land in it.
const SWIFT_AX_HELPER = '/tmp/open-goto-folder';

/** Compile the Swift AX helper if it doesn't exist yet. */
function ensureSwiftAXHelper(): boolean {
  if (fs.existsSync(SWIFT_AX_HELPER)) return true;
  const swiftSrc = SWIFT_AX_HELPER + '.swift';
  // On macOS 26 (Tahoe), CGEvent keystrokes from an external process do NOT
  // reach native OS dialogs (NSOpenPanel). System Events osascript CAN reach
  // them, but the Go to Folder sub-sheet must first be open and its text field
  // focused. This helper:
  //   1. Finds the NSOpenPanel (AXSheet on Chrome)
  //   2. Opens Go to Folder via Cmd+Shift+G (CGEvent is enough to open the sheet)
  //   3. Waits for the sub-sheet to appear
  //   4. Sets focus on its AXTextField via AX API
  // System Events then types the path and presses Return.
  const code = `
import Cocoa

func getAttr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v
}
func children(_ e: AXUIElement) -> [AXUIElement] {
    (getAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func role(_ e: AXUIElement) -> String {
    (getAttr(e, kAXRoleAttribute) as? String) ?? ""
}
func findAll(_ e: AXUIElement, role r: String) -> [AXUIElement] {
    var res = [AXUIElement]()
    if role(e) == r { res.append(e) }
    for c in children(e) { res.append(contentsOf: findAll(c, role: r)) }
    return res
}
func findSheet(_ e: AXUIElement) -> AXUIElement? {
    if role(e) == "AXSheet" { return e }
    for c in children(e) { if let s = findSheet(c) { return s } }
    return nil
}

let chromePid = pid_t(Int(CommandLine.arguments[1]) ?? 0)
let app = AXUIElementCreateApplication(chromePid)

// Wait up to 5s for NSOpenPanel to appear
var sheet: AXUIElement? = nil
for _ in 0..<50 {
    sheet = findSheet(app)
    if sheet != nil { break }
    Thread.sleep(forTimeInterval: 0.1)
}
guard let mainSheet = sheet else { print("error: no sheet"); exit(1) }

// If Go to Folder sub-sheet is not yet open, send Cmd+Shift+G to open it
var subSheets = children(mainSheet).filter { role($0) == "AXSheet" }
if subSheets.isEmpty {
    let src = CGEventSource(stateID: .hidSystemState)!
    func pressKey(_ kc: CGKeyCode, flags: CGEventFlags) {
        if let d = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: true) {
            d.flags = flags; d.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: 0.03)
        if let u = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: false) {
            u.flags = flags; u.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    pressKey(5, flags: [.maskCommand, .maskShift])  // Cmd+Shift+G
    // Wait for sub-sheet
    for _ in 0..<20 {
        Thread.sleep(forTimeInterval: 0.1)
        subSheets = children(mainSheet).filter { role($0) == "AXSheet" }
        if !subSheets.isEmpty { break }
    }
}
guard let subSheet = subSheets.first else { print("error: no sub-sheet"); exit(1) }

// Find and focus the text field in the sub-sheet
let tfs = findAll(subSheet, role: "AXTextField")
guard let tf = tfs.first else { print("error: no TF in sub-sheet"); exit(1) }
let fr = AXUIElementSetAttributeValue(tf, kAXFocusedAttribute as CFString, kCFBooleanTrue)
Thread.sleep(forTimeInterval: 0.3)
print("focused: \\(fr.rawValue)")
`;
  fs.writeFileSync(swiftSrc, code, 'utf8');
  const res = cp.spawnSync('swiftc', [swiftSrc, '-o', SWIFT_AX_HELPER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  if (res.status !== 0) {
    console.warn('[load-extension] Failed to compile Swift AX helper:', res.stderr?.toString().slice(0, 200));
    return false;
  }
  return true;
}

/** Check if System Events keystroke automation is available. */
async function checkAccessibility(): Promise<boolean> {
  try {
    const r = cp.spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke ""'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
    });
    const stderr = r.stderr?.toString() ?? '';
    return !stderr.includes('not allowed') && !stderr.includes('1002') && !stderr.includes('(-1743)');
  } catch {
    return false;
  }
}

/**
 * Fill the NSOpenPanel via the Go to Folder sheet.
 *
 * Working mechanism (macOS 26 Tahoe):
 *   - CGEvent keystrokes from external processes do NOT reach NSOpenPanel text fields.
 *   - System Events `keystroke` via osascript DOES reach them.
 *   - Strategy:
 *     1. Swift AX helper opens the Go to Folder sub-sheet and focuses its text field.
 *     2. osascript clears the field, types the path, and presses Return to navigate.
 *     3. osascript presses Return again to confirm the NSOpenPanel selection.
 */
async function fillNativeFilePicker(chromePid: number, folderPath: string): Promise<boolean> {
  if (!ensureSwiftAXHelper()) {
    console.warn('[load-extension] Swift AX helper unavailable');
    return false;
  }

  // Step 1: open Go to Folder sub-sheet and focus its text field
  const axResult = cp.spawnSync(SWIFT_AX_HELPER, [String(chromePid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  const axOut = axResult.stdout?.toString().trim() ?? '';
  const axErr = axResult.stderr?.toString().trim() ?? '';
  if (axResult.status !== 0 || axErr) {
    console.warn(`[load-extension] AX helper failed (exit ${axResult.status}): ${axErr.slice(0, 200)}`);
    return false;
  }
  console.log(`[load-extension] AX helper: ${axOut}`);
  await sleep(400);

  // Step 2: use System Events to type the path into the now-focused text field
  // Escape any double-quotes in the path for AppleScript string embedding
  const safePath = folderPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  tell process "Google Chrome"',
    '    keystroke "a" using command down',
    '    delay 0.15',
    `    keystroke "${safePath}"`,
    '    delay 0.4',
    '    key code 36',  // Return → confirm Go to Folder
    '  end tell',
    'end tell',
  ].join('\n');

  const osResult = cp.spawnSync('osascript', ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const osErr = osResult.stderr?.toString().trim() ?? '';
  if (osResult.status !== 0 || osErr) {
    console.warn(`[load-extension] osascript failed: ${osErr.slice(0, 200)}`);
    return false;
  }

  // Give NSOpenPanel time to navigate to the folder
  await sleep(1500);

  // Step 3: press Return/Select to confirm the NSOpenPanel selection
  const confirmScript = [
    'tell application "System Events"',
    '  tell process "Google Chrome"',
    '    key code 36',  // Return → press Select
    '  end tell',
    'end tell',
  ].join('\n');
  cp.spawnSync('osascript', ['-e', confirmScript], { stdio: 'ignore', timeout: 5000 });
  return true;
}

// ── W3C WebDriver client (uses Node built-in fetch — axios has a response body bug on Node 25) ──

class WdClient {
  private base: string;
  public sessionId = '';
  public debuggerAddress = '';

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async waitReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { await this.json('GET', '/status'); return; }
      catch { await sleep(300); }
    }
    throw new Error('ChromeDriver did not become ready in time');
  }

  async newSession(caps: object): Promise<string> {
    const data = await this.json('POST', '/session', { capabilities: { alwaysMatch: caps } }) as { value: { sessionId?: string; capabilities?: { 'goog:chromeOptions'?: { debuggerAddress?: string } } } };
    if (!data?.value?.sessionId) throw new Error(`Session creation failed: ${JSON.stringify(data).slice(0, 200)}`);
    this.sessionId = data.value.sessionId;
    this.debuggerAddress = data.value.capabilities?.['goog:chromeOptions']?.debuggerAddress ?? '';
    return this.sessionId;
  }

  async navigate(url: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/url`, { url });
  }

  async executeSync<T>(script: string, args: unknown[] = []): Promise<T> {
    const d = await this.json('POST', `/session/${this.sessionId}/execute/sync`, { script, args }) as { value: T };
    return d.value;
  }

  async executeAsync<T>(script: string, args: unknown[] = [], timeoutMs = 15_000): Promise<T> {
    await this.json('POST', `/session/${this.sessionId}/timeouts`, { script: timeoutMs });
    const d = await this.json('POST', `/session/${this.sessionId}/execute/async`, { script, args }) as { value: T };
    return d.value;
  }

  async deleteSession(): Promise<void> {
    if (this.sessionId) {
      await this.json('DELETE', `/session/${this.sessionId}`).catch(() => {});
      this.sessionId = '';
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<{ extensionId: string }> {
  console.log(`[load-extension] System Chrome: ${CHROME_BINARY}`);
  console.log(`[load-extension] Extension path: ${EXTENSION_PATH}`);

  const extensionId = extensionIdFromManifestKey(EXTENSION_PATH);
  if (extensionId) console.log(`[load-extension] Extension ID: ${extensionId}`);

  // Check Accessibility permission (required for the AppleScript file picker automation)
  const hasAccessibility = await checkAccessibility();
  if (!hasAccessibility) {
    console.warn('[load-extension] WARNING: Accessibility permission not granted for this process.');
    console.warn('[load-extension] Cannot automate the native file picker without it.');
    console.warn('[load-extension] To grant: System Settings → Privacy & Security → Accessibility');
    console.warn('[load-extension] → add Terminal.app (or VS Code.app for IDE runs)');
    console.warn('[load-extension]');
    console.warn('[load-extension] Will proceed but file picker step will require manual interaction.');
  }

  // Use a fixed high port to avoid timing races with getFreePort
  const port = 59271 + Math.floor(Math.random() * 200);
  const driver = cp.spawn(CHROMEDRIVER, [`--port=${port}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: false,
  });
  let driverLog = '';
  driver.stdout?.on('data', (d: Buffer) => { driverLog += d.toString(); });

  // Use a temp profile — system Chrome's stable-channel profile format differs from CfT
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-ztb-'));

  try {
    const wd = new WdClient(port);
    await wd.waitReady(15_000);
    console.log(`[load-extension] ChromeDriver ready on port ${port}`);

    const caps = {
      browserName: 'chrome',
      'goog:chromeOptions': {
        binary: CHROME_BINARY,
        args: [
          `--user-data-dir=${tmpProfile}`,
          '--no-first-run',
          '--no-default-browser-check',
          // Note: --load-extension is intentionally NOT included here.
          // It is blocked in official Google Chrome (extension_service.cc:419).
          // Instead we use the chrome://extensions/ "Load unpacked" UI flow.
        ],
      },
    };

    console.log('[load-extension] Creating WebDriver session...');
    await wd.newSession(caps);
    console.log(`[load-extension] Session: ${wd.sessionId}`);
    await sleep(1000);

    // Navigate to chrome://extensions/
    await wd.navigate('chrome://extensions/');
    await sleep(2500);

    // Enable developer mode
    await wd.executeAsync<number>('const cb=arguments[0]; chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, ()=>cb(1));');
    console.log('[load-extension] Developer mode enabled');
    await sleep(1000);

    // Confirm dev mode is on
    const config = await wd.executeAsync<{ inDeveloperMode: boolean }>('const cb=arguments[0]; chrome.developerPrivate.getProfileConfiguration(c=>cb(c));');
    if (!config.inDeveloperMode) {
      throw new Error('Developer mode could not be enabled — MDM may be blocking it');
    }

    // Click the "Load unpacked" button
    const clickResult = await wd.executeSync<string>(`
      const mgr = document.querySelector('extensions-manager');
      const tb = mgr?.shadowRoot?.querySelector('extensions-toolbar');
      const btn = tb?.shadowRoot?.querySelector('#loadUnpacked');
      if (!btn) return 'button-not-found';
      btn.click();
      return 'clicked';
    `);

    if (clickResult !== 'clicked') {
      throw new Error(`Load unpacked button not found (got: ${clickResult})`);
    }

    console.log('[load-extension] Clicked "Load unpacked" button — native file picker should open');
    await sleep(1500);

    // Fill the native file picker:
    //   1. Swift AX helper opens Go to Folder sub-sheet (Cmd+Shift+G) and focuses its text field
    //   2. osascript System Events types the path and presses Return
    // NOTE: CGEvent keystrokes do NOT reach NSOpenPanel on macOS 26 Tahoe.
    //       System Events keystroke DOES, but only after the sub-sheet TF is focused via AX.
    const chromePid = parseInt(
      cp.spawnSync('pgrep', ['-n', '-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
        { stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.toString().trim() ?? '0', 10
    );

    if (hasAccessibility && chromePid > 0) {
      console.log(`[load-extension] Filling file picker for Chrome PID ${chromePid}...`);
      const success = await fillNativeFilePicker(chromePid, EXTENSION_PATH);
      if (!success) {
        console.warn('[load-extension] File picker automation failed');
      } else {
        console.log('[load-extension] File picker filled — waiting for extension to load...');
        await sleep(3000);
      }
    } else {
      console.warn('[load-extension] MANUAL ACTION REQUIRED:');
      console.warn(`[load-extension] A file picker dialog is open. Navigate to:`);
      console.warn(`[load-extension]   ${EXTENSION_PATH}`);
      console.warn('[load-extension] and click "Select" / "Open".');
      console.warn('[load-extension] Waiting 30 seconds for manual interaction...');
      await sleep(30000);
    }

    // Check what extensions loaded
    const loadedExtensions = await wd.executeAsync<{ id: string; name: string }[]>(
      'const cb=arguments[0]; chrome.management.getAll(exts=>cb(exts.map(e=>({id:e.id,name:e.name}))));'
    );

    if (loadedExtensions.length > 0) {
      console.log(`[load-extension] Extensions loaded (${loadedExtensions.length}):`);
      for (const e of loadedExtensions) console.log(`  ${e.name} — ${e.id}`);
      const found = extensionId ? loadedExtensions.some(e => e.id === extensionId) : false;
      if (extensionId) {
        console.log(`[load-extension] ZTB extension: ${found ? 'LOADED ✓' : 'not in list'}`);
      }
    } else {
      console.warn('[load-extension] No extensions loaded.');
      if (!hasAccessibility) {
        console.warn('[load-extension] Grant Accessibility permission and retry for automated loading.');
      }
    }

    await wd.deleteSession();
    return { extensionId: extensionId || '' };

  } finally {
    driver.kill('SIGTERM');
    try { cp.spawnSync('pkill', ['-f', tmpProfile], { stdio: 'ignore' }); } catch { /* ok */ }
    await sleep(500);
    try { cp.spawnSync('rm', ['-rf', tmpProfile], { stdio: 'ignore' }); } catch { /* ok */ }
  }
}

main().then(({ extensionId }) => {
  console.log(`[load-extension] Done. Extension ID: ${extensionId || '(unknown)'}`);
  process.exit(0);
}).catch((err: unknown) => {
  console.error('[load-extension] Script error:', err);
  process.exit(1);
});
