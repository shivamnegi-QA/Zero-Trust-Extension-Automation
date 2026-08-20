// Windows browser launcher: loads an unpacked extension via the "Load unpacked"
// developer-mode UI flow, then returns a CDP endpoint for Playwright to attach.
//
// Why not --load-extension?
//   Compile-time disabled in official Google Chrome and Microsoft Edge.
//   The developer-mode UI flow is not blocked.
//
// File-picker automation (Windows):
//   After clicking "Load unpacked", Chrome/Edge opens a standard Windows
//   folder-picker dialog.  We use PowerShell SendKeys to type the extension
//   path into the dialog's filename field and press Enter.
//
// Edge support:
//   Pass capsKey:'ms:edgeOptions' and the Edge binary/driver via opts.
//   Everything else is identical — Edge is Chromium-based.

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { CHROME_BINARY, CHROMEDRIVER } from './platform';
import { sleep, getFreePort, extensionIdFromManifestKey, WdClient, killProcessTree } from './shared';

// ── Windows file-picker automation ────────────────────────────────────────────

// Fill Chrome's "Load unpacked" folder-picker.
// Strategy: WM_SETTEXT puts the path in the address-bar edit (no focus required),
// then BM_CLICK on the "Select Folder" button submits it (also focus-free).
async function fillWindowsFilePicker(extensionPath: string): Promise<void> {
  // Escape for PowerShell single-quoted string: only ' → ''
  const psSinglePath = extensionPath.replace(/'/g, "''");

  const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class WinFilePicker {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wP, string lP);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr wP, IntPtr lP);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  const uint WM_SETTEXT = 0x000C;

  public static IntPtr FindDialog() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (cls.ToString() == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string GetTitle(IntPtr h) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }

  // Set text in the folder-name Edit via WM_SETTEXT.
  // The dialog's subclass processes this as "navigate to path"; subsequent BM_CLICK confirms.
  public static bool SetEditText(IntPtr dialog, string text) {
    IntPtr edit = FindWindowEx(dialog, IntPtr.Zero, "Edit", null);
    if (edit == IntPtr.Zero) return false;
    SendMessage(edit, WM_SETTEXT, IntPtr.Zero, text);
    return true;
  }

  // Find the "Select Folder" / "Open" submit button by name
  public static IntPtr FindSelectButton(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (h, p) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(32);
      GetClassName(h, cls, 32);
      if (cls.ToString() != "Button") return true;
      var txt = new StringBuilder(64);
      GetWindowText(h, txt, 64);
      string s = txt.ToString();
      if (s.IndexOf("Select", System.StringComparison.OrdinalIgnoreCase) >= 0
       || s.IndexOf("Open",   System.StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // BM_CLICK simulates a button click cross-process without requiring focus
  public static bool ClickButton(IntPtr btn) {
    if (btn == IntPtr.Zero) return false;
    PostMessage(btn, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
    return true;
  }

  // Fallback: WM_COMMAND(IDOK) in case BM_CLICK didn't close the dialog
  public static bool PostIdOk(IntPtr dialog) {
    return PostMessage(dialog, 0x0111, new IntPtr(1), IntPtr.Zero); // WM_COMMAND, IDOK=1
  }
}
'@

$p = '${psSinglePath}'

# Wait up to 10s for Chrome's "Select extension directory" dialog (#32770) to appear
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 100
  $hwnd = [WinFilePicker]::FindDialog()
  if ($hwnd -ne [IntPtr]::Zero) { break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'result=ERROR:no_dialog'; exit 1 }

Write-Output "result=dialog_found:$([WinFilePicker]::GetTitle($hwnd))"

# 1. Set the extension path in the folder-name Edit (WM_SETTEXT triggers navigation)
[WinFilePicker]::SetEditText($hwnd, $p) | Out-Null
Start-Sleep -Milliseconds 200

# 2. BM_CLICK "Select Folder" — works cross-process, no focus required
#    BM_CLICK may first trigger navigation (if path text is set), then we
#    need a second BM_CLICK / IDOK to confirm the navigated-to folder.
$btn = [WinFilePicker]::FindSelectButton($hwnd)
$clicked = [WinFilePicker]::ClickButton($btn)
Write-Output "result=bm_click:$clicked"
Start-Sleep -Milliseconds 800

# 3. Second submit: if dialog is still open (navigated but not confirmed), close it
$idok = [WinFilePicker]::PostIdOk($hwnd)
Write-Output "result=idok2:$idok"
Start-Sleep -Milliseconds 500
Write-Output 'result=done'
`;

  const r = cp.spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000, windowsHide: true }
  );

  const stdout = r.stdout?.toString().trim() ?? '';
  const stderr = r.stderr?.toString().trim() ?? '';
  console.log(`[win-file-picker] out=${stdout} err=${stderr.slice(0, 200)}`);

  if (r.status !== 0) {
    throw new Error(`PowerShell file-picker failed (exit ${r.status}): ${stderr.slice(0, 300)}`);
  }
  if (stdout.includes('ERROR:')) {
    throw new Error(`File picker dialog not found. PS output: ${stdout}`);
  }

  await sleep(2500);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WinLaunchOptions {
  extensionPath: string;
  profilePath: string;
  tag?: string;
  /** Override browser binary (default: Chrome from platform.ts) */
  binary?: string;
  /** Override WebDriver binary (default: chromedriver from platform.ts) */
  driverBin?: string;
  /** Capability key for browser options: 'goog:chromeOptions' | 'ms:edgeOptions' */
  capsKey?: 'goog:chromeOptions' | 'ms:edgeOptions';
}

export interface WinLaunchResult {
  cdpEndpoint: string;
  extensionId: string;
  teardown: () => Promise<void>;
}

export async function launchWindowsBrowserWithExtension(opts: WinLaunchOptions): Promise<WinLaunchResult> {
  const {
    extensionPath,
    profilePath,
    binary    = CHROME_BINARY,
    driverBin = CHROMEDRIVER,
    capsKey   = 'goog:chromeOptions',
  } = opts;
  const tag = opts.tag ?? `[win-${capsKey === 'ms:edgeOptions' ? 'edge' : 'chrome'}]`;

  fs.mkdirSync(profilePath, { recursive: true });

  const extensionId = extensionIdFromManifestKey(extensionPath);
  if (extensionId) console.log(`${tag} Extension ID: ${extensionId}`);

  const port = await getFreePort();

  const driver = cp.spawn(driverBin, [`--port=${port}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: false,
  });

  let browserPid: number | null = null;

  const teardown = async (): Promise<void> => {
    // Kill ChromeDriver with /T FIRST — this terminates ChromeDriver, the Chrome
    // browser process, and all Chrome sub-processes (renderers, GPU, crashpad) in
    // one shot while the process tree is still intact.
    // Killing Chrome by PID first would orphan its children before the tree-kill runs.
    if (driver.pid != null) killProcessTree(driver.pid);
    else driver.kill();
    // Belt-and-suspenders: also kill Chrome by its own PID in case it was not in
    // ChromeDriver's process tree at teardown time.
    killProcessTree(browserPid ?? undefined);
    await sleep(400);
  };

  try {
    const wd = new WdClient(port);
    await wd.waitReady(20_000);
    console.log(`${tag} WebDriver ready on port ${port}`);

    await wd.newSession({
      browserName: capsKey === 'ms:edgeOptions' ? 'MicrosoftEdge' : 'chrome',
      [capsKey]: {
        binary,
        args: [
          `--user-data-dir=${profilePath}`,
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
          '--start-maximized',
        ],
      },
    });
    console.log(`${tag} Session: ${wd.sessionId}`);
    await sleep(1500);

    // Navigate to extensions page and enable developer mode
    const isEdge = capsKey === 'ms:edgeOptions';
    const extensionsUrl = isEdge ? 'edge://extensions/' : 'chrome://extensions/';
    await wd.navigate(extensionsUrl);
    await sleep(2500);

    if (!isEdge) {
      // Chrome: use privileged API to enable developer mode, then verify
      await wd.executeAsync<number>(
        'const cb=arguments[0]; chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, ()=>cb(1));'
      );
      console.log(`${tag} Developer mode enabled`);
      await sleep(800);
      const config = await wd.executeAsync<{ inDeveloperMode: boolean }>(
        'const cb=arguments[0]; chrome.developerPrivate.getProfileConfiguration(c=>cb(c));'
      );
      if (!config.inDeveloperMode) throw new Error('Developer mode could not be enabled — policy may be blocking it');
    }
    // Edge: developer mode will be toggled via UI in the polling script below

    // Poll up to 12s for the "Load unpacked" button (WD script timeout set to 18s for margin).
    // Chrome: extensions-manager > extensions-toolbar#shadowRoot > #loadUnpacked
    // Edge:   root-app (Vue.js SPA) with specific shadow DOM paths:
    //   Developer mode toggle:  root-app.sr→router-view→side-nav-pane.sr→profile-toggles.sr
    //                           →developer-mode-switch.sr→fluent-switch#dev-switch
    //   Load unpacked button:   fluent-button[title="Load unpacked"] in navigation-menu after toggle
    const clickResult = await wd.executeAsync<string>(`
      const cb = arguments[0];
      const deadline = Date.now() + 12000;
      let devModeToggled = false;

      function chromeLoadBtn() {
        const mgr = document.querySelector('extensions-manager');
        return mgr?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#loadUnpacked') ?? null;
      }

      function deepScan(root, pred) {
        for (const el of root.querySelectorAll('*')) {
          if (pred(el)) return el;
          if (el.shadowRoot) { const f = deepScan(el.shadowRoot, pred); if (f) return f; }
        }
        return null;
      }
      function edgeLoadBtn() {
        return deepScan(document.body, el =>
          (el.tagName === 'FLUENT-BUTTON' || el.tagName === 'BUTTON' || el.tagName === 'CR-BUTTON') &&
          (/load\\s+unpacked/i.test(el.getAttribute('title') || '') ||
           /load\\s+unpacked/i.test(el.textContent || ''))
        );
      }

      function edgeDevSwitch() {
        const ra = document.querySelector('root-app');
        const snp = ra?.shadowRoot?.querySelector('router-view')?.querySelector('side-nav-pane');
        const pt = snp?.shadowRoot?.querySelector('profile-toggles');
        const dms = pt?.shadowRoot?.querySelector('developer-mode-switch');
        return dms?.shadowRoot?.querySelector('#dev-switch') ?? null;
      }

      (function poll() {
        const btn = chromeLoadBtn() ?? edgeLoadBtn();
        if (btn) { btn.click(); cb(devModeToggled ? 'clicked-after-toggle' : 'clicked'); return; }

        if (!devModeToggled) {
          const sw = edgeDevSwitch();
          if (sw) {
            const checked = sw.getAttribute('checked');
            const isOn = checked !== null && checked !== 'false';
            if (!isOn) { sw.click(); devModeToggled = true; }
          }
        }

        if (Date.now() > deadline) { cb('timeout'); return; }
        setTimeout(poll, 400);
      })();
    `, [], 18_000);
    if (typeof clickResult !== 'string' || !clickResult.startsWith('clicked')) throw new Error(`Load unpacked button not found (${JSON.stringify(clickResult)}) — developer mode may be blocked by policy`);
    if (isEdge) console.log(`${tag} Developer mode ${clickResult === 'clicked-after-toggle' ? 'toggled on' : 'was already on'}`);
    console.log(`${tag} Clicked "Load unpacked" — Windows file picker should open`);

    // Get browser PID by finding which process owns the remote debugging port.
    // ChromeDriver does not expose processId in session capabilities, so we
    // query the OS for the process listening on the debug port instead.
    const debugPort = parseInt(wd.debuggerAddress?.split(':')[1] ?? '0', 10);
    if (debugPort) {
      const pidResult = cp.spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `try{(Get-NetTCPConnection -LocalPort ${debugPort} -State Listen -EA Stop|Select-Object -First 1).OwningProcess}catch{0}`,
      ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true });
      const pid = parseInt(pidResult.stdout?.toString().trim() ?? '', 10);
      if (pid > 0) browserPid = pid;
    }
    if (browserPid) console.log(`${tag} Browser PID: ${browserPid}`);

    // Fill the Windows file picker via PowerShell
    const absExtPath = path.resolve(extensionPath);
    console.log(`${tag} Filling file picker for: ${absExtPath}`);
    await fillWindowsFilePicker(absExtPath);
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

    // Get CDP WebSocket URL
    if (!wd.debuggerAddress) throw new Error('WebDriver did not return a debuggerAddress');
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
