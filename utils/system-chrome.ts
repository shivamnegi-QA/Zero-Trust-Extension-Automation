// Utilities for launching system Chrome via ChromeDriver, loading the ZTB extension
// via the "Load unpacked" UI flow, and returning the CDP debugger address so
// Playwright can attach with connectOverCDP.
//
// Why not --load-extension?
//   It is compile-time disabled in official Google Chrome (extension_service.cc:419).
//   The UI flow is not blocked.
//
// Why not Chrome for Testing?
//   Enterprise MDM policies block extension service workers in system Chrome. CfT
//   bypasses those, but the user explicitly wants system Chrome.
//
// NSOpenPanel automation (macOS 26 Tahoe):
//   CGEvent.post / postToPid do NOT reach NSOpenPanel text fields from external
//   processes. System Events keystroke DOES, but the text field must be focused
//   first via the AX API. Strategy:
//     1. Swift AX helper sends Cmd+Shift+G (CGEvent — sufficient to open the sheet)
//        then sets AXFocused=true on the Go to Folder text field.
//     2. osascript System Events types the path and presses Return.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { CHROME_BINARY, CHROMEDRIVER } from './platform';
import { sleep, getFreePort, extensionIdFromManifestKey, WdClient } from './shared';

export { CHROME_BINARY, CHROMEDRIVER };
export { extensionIdFromManifestKey } from './shared';

const SWIFT_AX_HELPER = '/tmp/open-goto-folder';

function ensureSwiftAXHelper(): boolean {
  if (fs.existsSync(SWIFT_AX_HELPER)) return true;
  const swiftSrc = SWIFT_AX_HELPER + '.swift';
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

var sheet: AXUIElement? = nil
for _ in 0..<50 {
    sheet = findSheet(app)
    if sheet != nil { break }
    Thread.sleep(forTimeInterval: 0.1)
}
guard let mainSheet = sheet else { print("error: no sheet"); exit(1) }

var subSheets = children(mainSheet).filter { role($0) == "AXSheet" }
if subSheets.isEmpty {
    // Raise/activate our Chrome window so Cmd+Shift+G (sent via cghidEventTap) lands on it
    AXUIElementPerformAction(mainSheet, kAXRaiseAction as CFString)
    let chromeApps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome")
    let ourApp = chromeApps.first(where: { $0.processIdentifier == chromePid })
    ourApp?.activate(options: .activateIgnoringOtherApps)
    Thread.sleep(forTimeInterval: 0.4)

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
    pressKey(5, flags: [.maskCommand, .maskShift])
    for _ in 0..<20 {
        Thread.sleep(forTimeInterval: 0.1)
        subSheets = children(mainSheet).filter { role($0) == "AXSheet" }
        if !subSheets.isEmpty { break }
    }
}
guard let subSheet = subSheets.first else { print("error: no sub-sheet"); exit(1) }

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
    console.warn('[system-chrome] Failed to compile Swift AX helper:', res.stderr?.toString().slice(0, 200));
    return false;
  }
  return true;
}

export function checkAccessibility(): boolean {
  const r = cp.spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke ""'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5000,
  });
  const stderr = r.stderr?.toString() ?? '';
  return !stderr.includes('not allowed') && !stderr.includes('1002') && !stderr.includes('(-1743)');
}

async function fillNativeFilePicker(chromePid: number, folderPath: string): Promise<void> {
  if (!ensureSwiftAXHelper()) throw new Error('Swift AX helper could not be compiled');

  const axResult = cp.spawnSync(SWIFT_AX_HELPER, [String(chromePid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  const axErr = axResult.stderr?.toString().trim() ?? '';
  if (axResult.status !== 0 || axErr) {
    throw new Error(`AX helper failed (exit ${axResult.status}): ${axErr.slice(0, 200)}`);
  }
  await sleep(400);

  // Target by PID so keystrokes go to our specific Chrome, not another concurrent instance
  // Escape all characters that have special meaning inside an AppleScript double-quoted string
  const safePath = folderPath
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  const typeScript = [
    'tell application "System Events"',
    `  tell (first process whose unix id is ${chromePid})`,
    '    keystroke "a" using command down',
    '    delay 0.15',
    `    keystroke "${safePath}"`,
    '    delay 0.4',
    '    key code 36',
    '  end tell',
    'end tell',
  ].join('\n');

  const osResult = cp.spawnSync('osascript', ['-e', typeScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const osErr = osResult.stderr?.toString().trim() ?? '';
  if (osResult.status !== 0 || osErr) {
    throw new Error(`osascript failed: ${osErr.slice(0, 200)}`);
  }

  await sleep(1500);

  const confirmScript = [
    'tell application "System Events"',
    `  tell (first process whose unix id is ${chromePid})`,
    '    key code 36',
    '  end tell',
    'end tell',
  ].join('\n');
  cp.spawnSync('osascript', ['-e', confirmScript], { stdio: 'ignore', timeout: 5000 });
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface LaunchResult {
  /** ws://… or http://… CDP endpoint for Playwright connectOverCDP */
  cdpEndpoint: string;
  extensionId: string;
  /** Call this to shut down ChromeDriver + Chrome cleanly */
  teardown: () => Promise<void>;
}

/**
 * Launch system Chrome via ChromeDriver, load the ZTB extension via the
 * "Load unpacked" UI flow, and return a CDP endpoint for Playwright to attach to.
 *
 * The caller is responsible for calling teardown() when done.
 */
export async function launchSystemChromeWithExtension(opts: {
  extensionPath: string;
  profilePath: string;
  tag?: string;
}): Promise<LaunchResult> {
  const { extensionPath, profilePath } = opts;
  const tag = opts.tag ?? '[system-chrome]';

  fs.mkdirSync(profilePath, { recursive: true });

  const extensionId = extensionIdFromManifestKey(extensionPath);
  if (extensionId) console.log(`${tag} Extension ID: ${extensionId}`);

  if (!checkAccessibility()) {
    throw new Error(
      'Accessibility permission not granted for this process.\n' +
      'Go to System Settings → Privacy & Security → Accessibility\n' +
      'and add Terminal.app (or VS Code.app for IDE runs).'
    );
  }

  const port = await getFreePort();
  const driver = cp.spawn(CHROMEDRIVER, [`--port=${port}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: false,
  });

  let chromePidForTeardown: number | null = null;

  const teardown = async (): Promise<void> => {
    // Kill Chrome directly by PID first — on macOS ChromeDriver spawns Chrome as a
    // separate process, so SIGTERM to ChromeDriver alone does not reach Chrome.
    if (chromePidForTeardown) {
      try { process.kill(chromePidForTeardown, 'SIGTERM'); } catch { /* already gone */ }
      await sleep(400);
    }
    driver.kill('SIGTERM');
    await sleep(400);
  };

  try {
    const wd = new WdClient(port);
    await wd.waitReady(15_000);
    console.log(`${tag} ChromeDriver ready on port ${port}`);

    // --remote-debugging-port=0 lets Chrome auto-assign a free port.
    // ChromeDriver returns the actual address in capabilities['goog:chromeOptions'].debuggerAddress.
    await wd.newSession({
      browserName: 'chrome',
      'goog:chromeOptions': {
        binary: CHROME_BINARY,
        args: [
          `--user-data-dir=${profilePath}`,
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      },
    });
    console.log(`${tag} Session: ${wd.sessionId}`);
    await sleep(1000);

    // Enable developer mode and click Load unpacked
    await wd.navigate('chrome://extensions/');
    await sleep(2500);

    await wd.executeAsync<number>(
      'const cb=arguments[0]; chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, ()=>cb(1));'
    );
    console.log(`${tag} Developer mode enabled`);
    await sleep(800);

    const config = await wd.executeAsync<{ inDeveloperMode: boolean }>(
      'const cb=arguments[0]; chrome.developerPrivate.getProfileConfiguration(c=>cb(c));'
    );
    if (!config.inDeveloperMode) throw new Error('Developer mode could not be enabled — MDM may be blocking it');

    const clickResult = await wd.executeSync<string>(`
      const mgr = document.querySelector('extensions-manager');
      const tb  = mgr?.shadowRoot?.querySelector('extensions-toolbar');
      const btn = tb?.shadowRoot?.querySelector('#loadUnpacked');
      if (!btn) return 'button-not-found';
      btn.click();
      return 'clicked';
    `);
    if (clickResult !== 'clicked') throw new Error(`Load unpacked button not found (got: ${clickResult})`);
    console.log(`${tag} Clicked "Load unpacked" — NSOpenPanel should open`);
    await sleep(1500);

    // Get Chrome PID via ChromeDriver's /session/:id endpoint — more reliable than pgrep
    // because pgrep -n finds the newest Chrome process which may be a Helper from a prior test.
    const sessionInfo = await (async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/session/${wd.sessionId}`,
          { signal: AbortSignal.timeout(5000) });
        return await r.json() as { value?: { processId?: number } };
      } catch { return null; }
    })();
    const chromePid = sessionInfo?.value?.processId
      ?? parseInt(
           cp.spawnSync('pgrep', ['-n', '-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
             { stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.toString().trim() ?? '0', 10
         );
    if (!chromePid) throw new Error('Could not determine Chrome PID');
    chromePidForTeardown = chromePid;

    console.log(`${tag} Filling file picker for Chrome PID ${chromePid}...`);
    await fillNativeFilePicker(chromePid, extensionPath);
    console.log(`${tag} File picker filled`);
    await sleep(3000);

    // Verify extension loaded
    const loaded = await wd.executeAsync<{ id: string; name: string }[]>(
      'const cb=arguments[0]; chrome.management.getAll(exts=>cb(exts.map(e=>({id:e.id,name:e.name}))));'
    );
    const found = loaded.find(e => e.id === extensionId);
    if (!found) {
      throw new Error(
        `Extension not loaded after file picker interaction. Loaded: ${JSON.stringify(loaded)}`
      );
    }
    console.log(`${tag} Extension loaded: ${found.name} — ${found.id}`);

    // Do NOT delete the WebDriver session — Chrome exits when the session is deleted.
    // Instead we just abandon it; Chrome stays running with its CDP port open.
    // teardown() kills ChromeDriver (and Chrome) when the test is done.

    // debuggerAddress is e.g. "localhost:53529".
    // Playwright's connectOverCDP rejects the HTTP form on Chrome 151 / macOS 26 —
    // it gets an empty JSON response. Fetch /json/version to get the WS URL and
    // pass that directly instead.
    if (!wd.debuggerAddress) throw new Error('ChromeDriver did not return a debuggerAddress');
    const versionResp = await fetch(`http://${wd.debuggerAddress}/json/version`,
      { signal: AbortSignal.timeout(5000) });
    const versionJson = await versionResp.json() as { webSocketDebuggerUrl?: string };
    const cdpEndpoint = versionJson.webSocketDebuggerUrl;
    if (!cdpEndpoint) throw new Error('Could not get webSocketDebuggerUrl from /json/version');
    console.log(`${tag} CDP WS endpoint: ${cdpEndpoint}`);

    return { cdpEndpoint, extensionId, teardown };

  } catch (err) {
    await teardown();
    throw err;
  }
}
