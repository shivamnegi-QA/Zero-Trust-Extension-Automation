// Utilities for Safari extension testing via safaridriver + osascript AX.
//
// Safari does not allow navigating to safari-web-extension:// URLs via WebDriver.
// The extension popup is an NSPopover opened by a toolbar button and is not a
// WebDriver window. Popup content is read via macOS Accessibility (osascript AX).
//
// Flow:
//   1. Extract zip if needed; skip if same version already installed
//   2. Run .app to install extension; dismiss "Quit and Open Safari Extensions Preferences" dialog
//   3. Enable extension checkbox in Safari Extensions preferences
//   4. Enable "Allow Remote Automation" in Safari Developer Settings
//   5. Start safaridriver on a free port; create a WebDriver session
//   6. Return an SdSession + teardown

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as net from 'net';
import * as os from 'os';

export const EXTENSION_BUNDLE_ID = 'com.squarex.enterprise.SquareX-Enterprise.Extension';
const SAFARIDRIVER = '/usr/bin/safaridriver';

// Resolve the Safari extension UUID dynamically from pluginkit.
// Falls back to a cached value after first successful lookup.
let _resolvedUuid = '';
export function resolveSafariExtensionUuid(): string {
  if (_resolvedUuid) return _resolvedUuid;
  try {
    const out = cp.execSync(
      `pluginkit -m -v -i ${JSON.stringify(EXTENSION_BUNDLE_ID)} 2>/dev/null | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1`,
      { timeout: 5_000 }
    ).toString().trim();
    if (out) { _resolvedUuid = out; return out; }
  } catch { /* fall through */ }
  return '';
}

// Kept for backward compatibility — prefer resolveSafariExtensionUuid() for fresh lookups.
export const SAFARI_EXTENSION_UUID = 'F09C77DE-6518-4142-B8B0-4E3CCF837ED4';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function runOsa(script: string): string {
  // osascript -e does not support multi-line scripts; write to a temp file instead.
  const tmp = path.join(os.tmpdir(), `osa-${process.pid}-${Date.now()}.scpt`);
  try {
    fs.writeFileSync(tmp, script, 'utf8');
    return cp.execSync(`osascript ${JSON.stringify(tmp)}`, { timeout: 15_000 }).toString().trim();
  } catch {
    return '';
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function runOsaFile(scriptPath: string): string {
  try {
    // Pass path as an argument array to avoid shell splitting on spaces
    return cp.execFileSync('osascript', [scriptPath], { timeout: 15_000 }).toString().trim();
  } catch {
    return '';
  }
}

function shellExec(cmd: string, timeoutMs = 10_000): string {
  try {
    return cp.execSync(cmd, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// ── Version helpers ────────────────────────────────────────────────────────────

function readInfoPlistVersion(appexPath: string): string {
  const plistPath = path.join(appexPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return '';
  try {
    return cp.execSync(
      `/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" ${JSON.stringify(plistPath)}`,
      { timeout: 5_000 }
    ).toString().trim();
  } catch { return ''; }
}

function getInstalledExtensionPath(): string {
  const out = shellExec(`pluginkit -m -v -p "com.apple.Safari.web-extension" 2>/dev/null | grep -i squarex`);
  const match = out.match(/\t(\/[^\t\n]+\.appex)/);
  return match ? match[1] : '';
}

// ── Extension install ──────────────────────────────────────────────────────────

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  cp.execSync(`unzip -qo ${JSON.stringify(zipPath)} -d ${JSON.stringify(destDir)}`, { timeout: 30_000 });
}

async function installSafariExtension(appPath: string, tag: string): Promise<void> {
  console.log(`${tag} Launching installer app: ${appPath}`);
  const proc = cp.spawn('open', ['-W', appPath], { stdio: 'ignore', detached: true });
  proc.unref();

  // Auto-dismiss the "Quit and Open Safari Extensions Preferences…" dialog
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(800);
    const dismissed = runOsa(`
tell application "System Events"
  tell process "Zero Trust Browser Extension"
    if exists window 1 then
      set btns to every button of window 1
      repeat with btn in btns
        set bname to name of btn
        if bname contains "Quit" or bname contains "Open" or bname contains "OK" then
          click btn
          return "clicked"
        end if
      end repeat
    end if
  end tell
end tell
`);
    if (dismissed === 'clicked') {
      console.log(`${tag} Dismissed installer dialog`);
      break;
    }
  }

  await sleep(2000);
}

async function ensureExtensionEnabled(tag: string): Promise<void> {
  // Open the Extensions window via Safari menu: View > Show Extensions (or Safari > Settings > Extensions)
  runOsa(`
tell application "Safari" to activate
delay 0.5
tell application "System Events"
  tell process "Safari"
    set frontmost to true
  end tell
end tell
`);
  await sleep(500);

  // Open Safari Settings via Cmd+, (works regardless of menu item name)
  runOsa(`
tell application "System Events"
  tell process "Safari"
    keystroke "," using {command down}
  end tell
end tell
`);
  await sleep(1500);

  // Click Extensions tab in the Settings/Preferences window
  runOsa(`
tell application "System Events"
  tell process "Safari"
    repeat with w in (every window)
      try
        set tb to toolbar 1 of w
        repeat with btn in (every button of tb)
          try
            set bdesc to description of btn
            if bdesc contains "xtension" then
              click btn
              delay 0.5
              return "ok"
            end if
          end try
        end repeat
      end try
    end repeat
  end tell
end tell
`);
  await sleep(1000);

  // The Extensions table path (verified interactively):
  // table 1 of scroll area 1 of group 2 of group 1 of group 1 of <settings window>
  // Find the settings window by listing all window names with a newline delimiter
  const winNames = runOsa(`
tell application "System Events"
  tell process "Safari"
    set wc to count of windows
    set names to ""
    repeat with i from 1 to wc
      try
        set wn to name of window i
        if names is "" then
          set names to wn
        else
          set names to names & linefeed & wn
        end if
      end try
    end repeat
    return names
  end tell
end tell
`);

  const candidates = [...new Set(winNames.split('\n').map(n => n.trim()))].filter(n =>
    n && !n.includes('about:blank') && !n.includes('Personal —') && n.length > 0
  );

  console.log(`${tag} Looking for Extensions in windows: ${candidates.join(', ')}`);

  let found = false;
  for (const winName of candidates) {
    const tablePath = `table 1 of scroll area 1 of group 2 of group 1 of group 1 of window "${winName}"`;
    const rowCount = runOsa(`tell application "System Events" to tell process "Safari" to return count of every row of ${tablePath}`);
    const n = parseInt(rowCount, 10) || 0;
    if (n === 0) continue;

    console.log(`${tag} Found extensions table in window "${winName}" with ${n} rows`);

    for (let i = 1; i <= n; i++) {
      const cellPath = `UI element 1 of row ${i} of ${tablePath}`;
      const rowName = runOsa(`tell application "System Events" to tell process "Safari" to return value of static text 1 of ${cellPath}`);
      if (!rowName.includes('Zero Trust')) continue;

      const cbVal = runOsa(`tell application "System Events" to tell process "Safari" to return value of checkbox 1 of ${cellPath}`);
      if (cbVal !== '1') {
        console.log(`${tag} Enabling extension in row ${i} of "${winName}"`);
        runOsa(`tell application "System Events" to tell process "Safari" to click checkbox 1 of ${cellPath}`);
        await sleep(500);
        // Handle permission dialog
        runOsa(`
tell application "System Events"
  tell process "Safari"
    repeat with w in (every window)
      try
        repeat with sht in (every sheet of w)
          repeat with btn in (every button of sht)
            set bname to name of btn
            if bname contains "Turn On" or bname contains "Allow" or bname contains "OK" then
              click btn
              return "dismissed"
            end if
          end repeat
        end repeat
      end try
    end repeat
  end tell
end tell
`);
      } else {
        console.log(`${tag} Extension already enabled in row ${i}`);
      }
      found = true;
    }
    if (found) break;
  }

  if (!found) {
    console.log(`${tag} Could not find ZT extension in Extensions table — may already be enabled`);
  }

  // Close settings/preferences window
  runOsa(`
tell application "System Events"
  tell process "Safari"
    repeat with w in (every window)
      set wname to name of w
      if wname is not missing value and wname does not contain "Personal" and wname does not contain "blank" then
        try
          click button 1 of w
        end try
        exit repeat
      end if
    end repeat
  end tell
end tell
`);
  await sleep(500);
}

async function enableRemoteAutomation(tag: string): Promise<void> {
  // Open Develop > Developer Settings… via menu bar
  runOsa(`
tell application "System Events"
  tell process "Safari"
    set frontmost to true
    tell menu bar 1
      tell menu bar item "Develop"
        tell menu "Develop"
          click menu item "Developer Settings…"
        end tell
      end tell
    end tell
  end tell
end tell
`);
  await sleep(1500);

  // Find "Allow remote automation" checkbox in Developer Settings window.
  // Verified path (macOS 26): checkboxes are direct children of group 1 of group 1 of window "Developer"
  // The checkbox has title "Allow remote automation" and desc "tickbox"
  const result = runOsa(`
tell application "System Events"
  tell process "Safari"
    repeat with w in (every window)
      if (name of w) contains "Developer" then
        -- Walk up to 4 group levels to find checkboxes (structure varies across macOS versions)
        set foundCheckbox to false
        set levelList to {w}
        repeat 4 times
          set nextLevel to {}
          repeat with container in levelList
            try
              repeat with cb in (every checkbox of container)
                try
                  set cbTitle to title of cb as string
                on error
                  set cbTitle to ""
                end try
                if cbTitle contains "remote automation" or cbTitle contains "Remote Automation" then
                  if (value of cb) as integer is 0 then
                    click cb
                    return "enabled"
                  end if
                  return "already_on"
                end if
              end repeat
            end try
            try
              set subGroups to every group of container
              repeat with sg in subGroups
                set end of nextLevel to sg
              end repeat
            end try
          end repeat
          if (count of nextLevel) is 0 then exit repeat
          set levelList to nextLevel
        end repeat
        return "not_found_in_developer_window"
      end if
    end repeat
    return "developer_window_not_found"
  end tell
end tell
`);
  console.log(`${tag} Remote automation: ${result}`);

  // Close developer settings window
  runOsa(`
tell application "System Events"
  tell process "Safari"
    repeat with w in windows
      if (name of w) contains "Developer" then
        try
          click button 1 of w
        end try
        exit repeat
      end if
    end repeat
  end tell
end tell
`);
  await sleep(300);
}

// ── Popup helpers via osascript AX ────────────────────────────────────────────

// Find the window index that contains the ZT toolbar button (searches all windows)
function findZTWindowIndex(): number {
  const result = runOsa(`
tell application "System Events"
  tell process "Safari"
    set winCount to count of windows
    repeat with i from 1 to winCount
      try
        set tb to toolbar 1 of window i
        repeat with btn in (every button of tb)
          if (description of btn) contains "Zero Trust" then
            return i as string
          end if
        end repeat
      end try
    end repeat
    return "0"
  end tell
end tell
`);
  return parseInt(result, 10) || 0;
}

// Opens the popup AND reads its body text in a single osascript call.
// Returns body text on success, or '__not_found__' if ZT button not found.
export function openAndReadSafariPopup(): string {
  const result = runOsa(`
tell application "System Events"
  tell process "Safari"
    -- Close any open popup first
    key code 53
    delay 0.3
    set winCount to count of windows
    set ztBtn to missing value
    set ztWin to 0
    -- Find the ZT toolbar button
    repeat with wi from 1 to winCount
      try
        set tb to toolbar 1 of window wi
        repeat with bi from 1 to (count of every button of tb)
          set btn to button bi of tb
          if (description of btn) contains "Zero Trust" then
            set ztBtn to btn
            set ztWin to wi
            exit repeat
          end if
        end repeat
      end try
      if ztBtn is not missing value then exit repeat
    end repeat
    if ztBtn is missing value then return "__not_found__"
    -- Bring window to front and open popup via coordinate click
    -- (AXPress opens context menu when multiple windows exist; coordinate click opens the popup)
    set frontmost to true
    perform action "AXRaise" of window ztWin
    delay 0.5
    -- Verify window is front before clicking
    set frontmost to true
    delay 0.2
    set btnPos to position of ztBtn
    set btnSz to size of ztBtn
    set cx to (item 1 of btnPos) + (item 1 of btnSz) / 2
    set cy to (item 2 of btnPos) + (item 2 of btnSz) / 2
    click at {cx, cy}
    delay 2.5
    -- If popup didn't open (popover count is 0), retry click once more
    if (count of every pop over of ztBtn) is 0 then
      -- Ensure window still focused before retry
      set frontmost to true
      perform action "AXRaise" of window ztWin
      delay 0.5
      click at {cx, cy}
      delay 2.5
    end if
    -- Strategy 1: popup as AXPopover on the toolbar button
    set webArea to missing value
    if (count of every pop over of ztBtn) > 0 then
      -- Try double-nested popover first (the common case)
      try
        set webArea to UI element 1 of scroll area 1 of group 1 of pop over 1 of pop over 1 of ztBtn
      end try
      -- Fallback: single-nested popover
      if webArea is missing value then
        try
          set webArea to UI element 1 of scroll area 1 of group 1 of pop over 1 of ztBtn
        end try
      end if
    end if
    -- Strategy 2: search ALL windows (including ones with toolbars) for a popup-like window
    -- The popup may appear as an extra window even when safaridriver is running (all windows have toolbars)
    -- We search windows OTHER than the ZT button's window for a web area
    if webArea is missing value then
      set newWinCount to count of windows
      repeat with wi from 1 to newWinCount
        if wi is not ztWin then
          try
            -- Raise this window so it stays open
            perform action "AXRaise" of window wi
            set frontmost to true
            delay 0.1
            set c1 to every UI element of window wi
            repeat with e1 in c1
              if (role of e1) is "AXWebArea" then
                set webArea to e1
                exit repeat
              end if
              try
                set c2 to every UI element of e1
                repeat with e2 in c2
                  if (role of e2) is "AXWebArea" then
                    set webArea to e2
                    exit repeat
                  end if
                  try
                    set c3 to every UI element of e2
                    repeat with e3 in c3
                      if (role of e3) is "AXWebArea" then
                        set webArea to e3
                        exit repeat
                      end if
                      try
                        set c4 to every UI element of e3
                        repeat with e4 in c4
                          if (role of e4) is "AXWebArea" then
                            set webArea to e4
                            exit repeat
                          end if
                        end repeat
                      end try
                    end repeat
                  end try
                  if webArea is not missing value then exit repeat
                end repeat
              end try
              if webArea is not missing value then exit repeat
            end repeat
          end try
          if webArea is not missing value then exit repeat
        end if
      end repeat
    end if
    if webArea is missing value then
      return "__popup_no_webarea__"
    end if
    -- Collect text
    set allText to {}
    set childCount to count of every UI element of webArea
    set i to 1
    repeat while i <= childCount
      set el to UI element i of webArea
      try
        repeat with t in (every static text of el)
          set v to value of t
          if v is not "" and v is not missing value then
            set end of allText to v
          end if
        end repeat
      end try
      try
        repeat with btn2 in (every button of el)
          try
            set bt to title of btn2
            if bt is not "" and bt is not missing value then
              set end of allText to bt
            end if
          end try
        end repeat
      end try
      try
        set elTitle to title of el
        if elTitle is not "" and elTitle is not missing value then
          set end of allText to elTitle
        end if
      end try
      try
        set subCount to count of every UI element of el
        set j to 1
        repeat while j <= subCount
          set sub to UI element j of el
          try
            repeat with t in (every static text of sub)
              set v to value of t
              if v is not "" and v is not missing value then
                set end of allText to v
              end if
            end repeat
          end try
          try
            set subTitle to title of sub
            if subTitle is not "" and subTitle is not missing value then
              set end of allText to subTitle
            end if
          end try
          set j to j + 1
        end repeat
      end try
      set i to i + 1
    end repeat
    return allText as string
  end tell
end tell
`);
  return result;
}

export function openSafariPopupViaAX(): boolean {
  // Find the ZT toolbar button, ensure popup is closed (if already open AXPress would toggle it off),
  // then AXPress to open it.
  const result = runOsa(`
tell application "System Events"
  tell process "Safari"
    -- First close any already-open popup by pressing Escape
    key code 53
    delay 0.2
    set winCount to count of windows
    repeat with i from 1 to winCount
      try
        set tb to toolbar 1 of window i
        repeat with btn in (every button of tb)
          if (description of btn) contains "Zero Trust" then
            -- Also close via AXPress if popover is still open
            if (count of every pop over of btn) > 0 then
              perform action "AXPress" of btn
              delay 0.3
            end if
            -- Bring this window to front and open the popup
            set frontmost to true
            perform action "AXRaise" of window i
            delay 0.3
            perform action "AXPress" of btn
            delay 1
            -- Verify popup opened (popover count OR window count increased)
            set popCount to count of every pop over of btn
            set newWinCount to count of windows
            if popCount > 0 then
              return "clicked:" & (i as string)
            else if newWinCount > winCount then
              return "clicked_as_window:" & (i as string)
            else
              return "pressed_no_popup:" & (i as string)
            end if
          end if
        end repeat
      end try
    end repeat
    return "not_found"
  end tell
end tell
`);
  return result.startsWith('clicked');
}

export function closeSafariPopupViaAX(): void {
  // Press Escape to dismiss any open popup/popover
  runOsa(`
tell application "System Events"
  tell process "Safari"
    key code 53
    delay 0.1
    -- Also check toolbar button and AXPress if popover still present
    set winCount to count of windows
    repeat with i from 1 to winCount
      try
        set tb to toolbar 1 of window i
        repeat with btn in (every button of tb)
          if (description of btn) contains "Zero Trust" then
            if (count of every pop over of btn) > 0 then
              perform action "AXPress" of btn
            end if
            return "closed"
          end if
        end repeat
      end try
    end repeat
  end tell
end tell
`);
}

// Shared fragment: finds the ZT popup web area.
// Two cases:
//   1. Popup is an AXPopover attached to the toolbar button (older macOS / single-window)
//   2. Popup is an AXDialog window (macOS 26, multiple windows open)
const FIND_WEBAREA_FRAGMENT = `
set webArea to missing value
set winCount to count of windows
-- Case 1: Popup as AXPopover on toolbar button
repeat with wi from 1 to winCount
  try
    set tb to toolbar 1 of window wi
    set btnCount to count of every button of tb
    repeat with bi from 1 to btnCount
      set tbBtn to button bi of tb
      if (description of tbBtn) contains "Zero Trust" then
        if (count of every pop over of tbBtn) > 0 then
          -- Focus the window so the popup stays open and clicks land
          set frontmost to true
          perform action "AXRaise" of window wi
          delay 0.1
          -- Try double-nested popover first, fallback to single-nested
          try
            set webArea to UI element 1 of scroll area 1 of group 1 of pop over 1 of pop over 1 of tbBtn
          end try
          if webArea is missing value then
            try
              set webArea to UI element 1 of scroll area 1 of group 1 of pop over 1 of tbBtn
            end try
          end if
          if webArea is not missing value then exit repeat
        end if
      end if
    end repeat
  end try
  if webArea is not missing value then exit repeat
end repeat
-- Case 2: Popup rendered as a floating/dialog window — search AXWebArea at depth 1-4
if webArea is missing value then
  repeat with wi from 1 to winCount
    try
      -- Skip windows that have a browser toolbar (those are browser windows, not the popup)
      set hasToolbar to false
      try
        set tb2 to toolbar 1 of window wi
        set hasToolbar to true
      end try
      if not hasToolbar then
        -- Focus this window to keep it open during interaction
        perform action "AXRaise" of window wi
        set frontmost to true
        delay 0.1
        -- Search depth-first for AXWebArea up to 4 levels
        set c1 to every UI element of window wi
        repeat with e1 in c1
          if (role of e1) is "AXWebArea" then
            set webArea to e1
            exit repeat
          end if
          try
            set c2 to every UI element of e1
            repeat with e2 in c2
              if (role of e2) is "AXWebArea" then
                set webArea to e2
                exit repeat
              end if
              try
                set c3 to every UI element of e2
                repeat with e3 in c3
                  if (role of e3) is "AXWebArea" then
                    set webArea to e3
                    exit repeat
                  end if
                  try
                    set c4 to every UI element of e3
                    repeat with e4 in c4
                      if (role of e4) is "AXWebArea" then
                        set webArea to e4
                        exit repeat
                      end if
                    end repeat
                  end try
                end repeat
              end try
              if webArea is not missing value then exit repeat
            end repeat
          end try
          if webArea is not missing value then exit repeat
        end repeat
      end if
    end try
    if webArea is not missing value then exit repeat
  end repeat
end if
`;

export function getSafariPopupBodyText(): string {
  return runOsa(`
tell application "System Events"
  tell process "Safari"
    ${FIND_WEBAREA_FRAGMENT}
    if webArea is missing value then return ""
    set allText to {}
    set childCount to count of every UI element of webArea
    set i to 1
    repeat while i <= childCount
      set el to UI element i of webArea
      try
        repeat with t in (every static text of el)
          set v to value of t
          if v is not "" and v is not missing value then
            set end of allText to v
          end if
        end repeat
      end try
      try
        repeat with btn in (every button of el)
          try
            set bt to title of btn
            if bt is not "" and bt is not missing value then
              set end of allText to bt
            end if
          end try
        end repeat
      end try
      try
        set elTitle to title of el
        if elTitle is not "" and elTitle is not missing value then
          set end of allText to elTitle
        end if
      end try
      try
        set subCount to count of every UI element of el
        set j to 1
        repeat while j <= subCount
          set sub to UI element j of el
          try
            repeat with t in (every static text of sub)
              set v to value of t
              if v is not "" and v is not missing value then
                set end of allText to v
              end if
            end repeat
          end try
          try
            set subTitle to title of sub
            if subTitle is not "" and subTitle is not missing value then
              set end of allText to subTitle
            end if
          end try
          set j to j + 1
        end repeat
      end try
      set i to i + 1
    end repeat
    return allText as string
  end tell
end tell
`);
}

// Escape a string for safe embedding inside an AppleScript double-quoted string literal.
function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function clickInSafariPopup(textMatch: string): boolean {
  const safe = escapeAppleScriptString(textMatch);
  const result = runOsa(`
tell application "System Events"
  tell process "Safari"
    ${FIND_WEBAREA_FRAGMENT}
    if webArea is missing value then return "not_found"
    repeat with btn in (every button of webArea)
      try
        if (description of btn) contains "${safe}" then
          click btn
          return "clicked"
        end if
      end try
    end repeat
    set elCount to count of every UI element of webArea
    set i to 1
    repeat while i <= elCount
      set el to UI element i of webArea
      try
        repeat with t in (every static text of el)
          if (value of t) contains "${safe}" then
            click el
            return "clicked_el"
          end if
        end repeat
      end try
      set i to i + 1
    end repeat
    return "not_found"
  end tell
end tell
`);
  return result.startsWith('clicked');
}

export function screenshotSafariPopup(filePath: string): void {
  // Use screencapture to grab the popover area
  try {
    cp.execSync(`screencapture -x ${JSON.stringify(filePath)}`, { timeout: 5_000 });
  } catch { /* ignore */ }
}

// ── WebDriver session (SdSession) ─────────────────────────────────────────────

export class SdSession {
  private base: string;
  public sessionId = '';
  public extensionUuid = resolveSafariExtensionUuid() || SAFARI_EXTENSION_UUID;

  constructor(sdPort: number) {
    this.base = `http://127.0.0.1:${sdPort}`;
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

  async navigate(url: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/url`, { url });
  }

  async currentUrl(): Promise<string> {
    const d = await this.json('GET', `/session/${this.sessionId}/url`) as { value: string };
    return d.value;
  }

  async execute<T>(script: string, args: unknown[] = []): Promise<T> {
    const d = await this.json('POST', `/session/${this.sessionId}/execute/sync`, { script, args }) as { value: T };
    return d.value;
  }

  async findElement(strategy: string, selector: string): Promise<string | null> {
    try {
      const d = await this.json('POST', `/session/${this.sessionId}/element`, { using: strategy, value: selector }) as {
        value: Record<string, string> | { error: string }
      };
      if ('error' in d.value) return null;
      return Object.values(d.value)[0];
    } catch { return null; }
  }

  async getElementText(elementId: string): Promise<string> {
    const d = await this.json('GET', `/session/${this.sessionId}/element/${elementId}/text`) as { value: string };
    return d.value ?? '';
  }

  async clickElement(elementId: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/element/${elementId}/click`, {});
  }

  async bodyText(): Promise<string> {
    return this.execute<string>('return document.body.innerText || document.body.textContent || ""');
  }

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

  async closeWindow(): Promise<void> {
    await this.json('DELETE', `/session/${this.sessionId}/window`).catch(() => {});
  }

  async sendKeys(elementId: string, text: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/element/${elementId}/value`, { value: text.split(''), text });
  }

  async deleteAllCookies(): Promise<void> {
    await this.json('DELETE', `/session/${this.sessionId}/cookie`).catch(() => {});
  }

  async deleteSession(): Promise<void> {
    if (this.sessionId) {
      await this.json('DELETE', `/session/${this.sessionId}`).catch(() => {});
      this.sessionId = '';
    }
  }

  async screenshot(filePath: string): Promise<void> {
    const d = await this.json('GET', `/session/${this.sessionId}/screenshot`) as { value: string };
    if (d.value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(d.value, 'base64'));
    }
  }

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

  // Opens the extension popup via AX and returns the body text.
  // Click + read happen in a single osascript call so the popup doesn't close between them.
  async openExtensionPopup(): Promise<{ bodyText: string }> {
    const bodyText = openAndReadSafariPopup();
    if (bodyText === '__not_found__') {
      throw new Error('Could not click Zero Trust toolbar button — extension may not be in toolbar');
    }
    return { bodyText };
  }

  async closePopup(): Promise<void> {
    closeSafariPopupViaAX();
    await sleep(300);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface SafariLaunchResult {
  session: SdSession;
  teardown: () => Promise<void>;
}

export async function launchSafariWithExtension(opts: {
  // Pass either a .zip file path OR a pre-extracted directory containing "Debug/Zero Trust Browser Extension.app"
  zipPath?: string;
  extractedDir?: string;
  tag?: string;
}): Promise<SafariLaunchResult> {
  const tag = opts.tag ?? '[system-safari]';

  // ── 1. Determine extract destination and version ──────────────────────────
  let extractDir: string;
  let appPath: string;

  if (opts.extractedDir) {
    // Pre-extracted directory provided (e.g. "extension builds/safari-1.4.3")
    extractDir = opts.extractedDir;
    appPath = path.join(extractDir, 'Debug', 'Zero Trust Browser Extension.app');
  } else if (opts.zipPath) {
    const zipPath = opts.zipPath;
    const zipName = path.basename(zipPath, '.zip');
    extractDir = path.join(path.dirname(zipPath), zipName);
    appPath = path.join(extractDir, 'Debug', 'Zero Trust Browser Extension.app');
    if (!fs.existsSync(appPath)) {
      console.log(`${tag} Extracting zip...`);
      await extractZip(zipPath, extractDir);
    }
  } else {
    throw new Error('launchSafariWithExtension: provide either zipPath or extractedDir');
  }

  const appexPath = path.join(
    appPath,
    'Contents', 'PlugIns', 'Zero Trust Browser Extension Extension.appex'
  );

  const zipVersion = readInfoPlistVersion(appexPath);
  console.log(`${tag} Extension version: ${zipVersion}`);

  // ── 2. Check installed version ────────────────────────────────────────────
  const installedPath = getInstalledExtensionPath();
  let needsInstall = true;

  if (installedPath) {
    const installedVersion = readInfoPlistVersion(installedPath);
    console.log(`${tag} Installed version: ${installedVersion}`);
    if (installedVersion && installedVersion === zipVersion) {
      console.log(`${tag} Same version already installed — skipping reinstall`);
      needsInstall = false;
    } else {
      console.log(`${tag} Different version — will reinstall`);
    }
  } else {
    console.log(`${tag} No existing installation found`);
  }

  // ── 3. Install extension if needed ────────────────────────────────────────
  if (needsInstall) {
    await installSafariExtension(appPath, tag);
  }

  // ── 5. Ensure extension is enabled in Safari prefs ───────────────────────
  await ensureExtensionEnabled(tag);

  // ── 6. Enable "Allow Remote Automation" ──────────────────────────────────
  await enableRemoteAutomation(tag);

  // ── 7. Kill any stale safaridriver / Safari pairing ──────────────────────
  shellExec('pkill -f safaridriver', 5_000);
  await sleep(500);

  // Restart Safari to clear any stale WebDriver pairing
  const safariPids = shellExec("pgrep -x Safari").split('\n').filter(Boolean);
  for (const pid of safariPids) {
    try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch { /* gone */ }
  }
  await sleep(1000);
  cp.exec('open -a Safari', () => {});
  await sleep(2000);

  // Navigate to about:blank so the extension toolbar button appears
  runOsa(`tell application "Safari" to set URL of front document to "about:blank"`);
  await sleep(1000);

  // ── 8. Start safaridriver ─────────────────────────────────────────────────
  const sdPort = await getFreePort();
  const driver = cp.spawn(SAFARIDRIVER, [`--port=${sdPort}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: false,
  });

  const teardown = async (): Promise<void> => {
    driver.kill('SIGTERM');
    await sleep(400);
  };

  try {
    // Wait for safaridriver to be ready
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${sdPort}/status`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) break;
      } catch { await sleep(300); }
    }
    console.log(`${tag} safaridriver ready on port ${sdPort}`);

    const session = new SdSession(sdPort);

    // ── 9. Start background osascript poller to auto-dismiss "remotely controlled" banner
    const bannerDismissScript = `
repeat
  tell application "System Events"
    tell process "Safari"
      set wc to count of windows
      repeat with wi from 1 to wc
        try
          -- Check for sheets attached to windows
          repeat with sht in (every sheet of window wi)
            repeat with btn in (every button of sht)
              set bname to name of btn
              if bname contains "Continue" or bname contains "Allow" or bname is "OK" or bname is "Close" then
                -- Focus the sheet's parent window before clicking
                set frontmost to true
                perform action "AXRaise" of window wi
                delay 0.1
                click btn
                exit repeat
              end if
            end repeat
          end repeat
        end try
        try
          -- Check for the banner as a standalone AXDialog window
          if (subrole of window wi) is "AXDialog" then
            repeat with btn in (every button of window wi)
              set bname to name of btn
              if bname contains "Continue" or bname contains "Allow" or bname is "OK" then
                -- Raise and focus the dialog before clicking
                set frontmost to true
                perform action "AXRaise" of window wi
                delay 0.1
                click btn
                exit repeat
              end if
            end repeat
          end if
        end try
        try
          -- Check for "Continue Session" button anywhere in the window (banner style)
          repeat with btn in (every button of window wi)
            try
              set bname to name of btn
              if bname is "Continue Session" then
                -- Raise and focus the window before clicking
                set frontmost to true
                perform action "AXRaise" of window wi
                delay 0.1
                click btn
                exit repeat
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
  end tell
  delay 0.5
end repeat
`;
    const bannerScriptPath = path.join(os.tmpdir(), `safari-banner-dismiss-${sdPort}.scpt`);
    fs.writeFileSync(bannerScriptPath, bannerDismissScript, 'utf8');
    const bannerProc = cp.spawn('osascript', [bannerScriptPath], { stdio: 'ignore', detached: true });
    bannerProc.unref();

    const originalTeardown = teardown;
    const teardownWithCleanup = async (): Promise<void> => {
      bannerProc.kill('SIGTERM');
      fs.rmSync(bannerScriptPath, { force: true });
      await originalTeardown();
    };

    // ── 10. Create WebDriver session ──────────────────────────────────────────
    const data = await session.json('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'safari',
        },
      },
    }) as { value: { sessionId?: string; message?: string } };

    if (!data?.value?.sessionId) {
      throw new Error(`Safari session creation failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    session.sessionId = data.value.sessionId;
    console.log(`${tag} Session: ${session.sessionId}`);

    // Give Safari time to show the "remotely controlled" banner, then dismiss it
    await sleep(2000);
    runOsa(`
tell application "System Events"
  tell process "Safari"
    set wc to count of windows
    repeat with wi from 1 to wc
      try
        repeat with btn in (every button of window wi)
          try
            set bname to name of btn
            if bname contains "Continue" or bname contains "Allow" or bname is "OK" then
              set frontmost to true
              perform action "AXRaise" of window wi
              delay 0.1
              click btn
              exit repeat
            end if
          end try
        end repeat
      end try
    end repeat
  end tell
end tell
`);
    await sleep(500);

    return { session, teardown: teardownWithCleanup };

  } catch (err) {
    await teardown();
    throw err;
  }
}
