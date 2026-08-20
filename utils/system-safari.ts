// Utilities for loading the ZTB Safari App Extension and verifying it via
// Accessibility (System Events) — Safari has no CDP/WebDriver popup API, so both
// loading and popup verification go through the OS accessibility tree instead.
//
// Flow:
//   1. Launch the extension's container app with `open` after clearing its
//      quarantine flag — otherwise Gatekeeper App Translocation runs it from a
//      randomized read-only path and its Safari App Extension never registers
//      with pluginkit, so it never shows up in Safari.
//   2. Click "Quit and Open Safari Extensions Preferences…" inside its window.
//      The button lives inside a WKWebView (AXGroup > AXScrollArea > AXWebArea),
//      not as a direct child of the window, so it's found via `entire contents`
//      rather than the window's `buttons` collection.
//   3. The app quits itself; Safari opens its Extensions settings window.
//   4. Confirm the extension's row is present and enable its checkbox if needed.
//   5. Click the extension's toolbar icon — identified by AXDescription, since
//      its AXTitle is empty — and read the resulting popover's content.

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { sleep, checkAccessibility } from './shared';

export { checkAccessibility };

const APP_PROCESS_NAME = 'Zero Trust Browser Extension';
const EXTENSION_DISPLAY_NAME = 'Zero Trust Browser by Zscaler';

function runAppleScript(script: string, timeoutMs = 15_000): string {
  const res = cp.spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: timeoutMs });
  if (res.status !== 0) {
    throw new Error(`osascript failed: ${(res.stderr || res.stdout || res.error?.message || '').toString().trim().slice(0, 400)}`);
  }
  return (res.stdout ?? '').trim();
}

/**
 * Retries an AppleScript a few times with a delay between attempts. Safari's own
 * accessibility tree isn't always ready immediately after activating/raising a
 * window, so a single attempt occasionally finds nothing even though the same
 * script succeeds a moment later.
 */
async function runAppleScriptRetry(
  script: string,
  opts: { attempts?: number; delayMs?: number; okWhen?: (out: string) => boolean } = {},
): Promise<string> {
  const { attempts = 3, delayMs = 800, okWhen = () => true } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = runAppleScript(script);
      if (okWhen(out)) return out;
      lastErr = new Error(`unexpected output: ${out}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function clearQuarantine(appPath: string): void {
  cp.spawnSync('xattr', ['-dr', 'com.apple.quarantine', appPath], { stdio: 'ignore' });
}

async function isProcessRunning(name: string): Promise<boolean> {
  try {
    const out = runAppleScript(`tell application "System Events" to get name of every process whose name is "${name}"`);
    return out.includes(name);
  } catch { return false; }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, interval = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(interval);
  }
  return false;
}

/** Launches the extension's container app and waits for its window to appear. */
export async function launchExtensionApp(appPath: string): Promise<void> {
  if (!fs.existsSync(appPath)) throw new Error(`Safari extension app not found: ${appPath}`);
  if (!checkAccessibility()) {
    throw new Error(
      'Accessibility permission not granted for this process.\n' +
      'Go to System Settings → Privacy & Security → Accessibility\n' +
      'and add Terminal.app (or VS Code.app for IDE runs).',
    );
  }

  clearQuarantine(appPath);
  console.log(`  [safari] Launching ${appPath}`);
  cp.spawn('open', [appPath], { stdio: 'ignore', detached: true }).unref();

  const appeared = await waitUntil(() => isProcessRunning(APP_PROCESS_NAME), 15_000);
  if (!appeared) throw new Error(`${APP_PROCESS_NAME} did not launch within 15s`);
  console.log(`  [safari] ${APP_PROCESS_NAME} process is running`);

  const hasWindow = await waitUntil(async () => {
    try {
      const out = runAppleScript(`tell application "System Events" to tell process "${APP_PROCESS_NAME}" to count of windows`);
      return parseInt(out, 10) > 0;
    } catch { return false; }
  }, 10_000);
  if (!hasWindow) throw new Error(`${APP_PROCESS_NAME} launched but showed no window`);
  console.log(`  [safari] ${APP_PROCESS_NAME} window is visible`);
}

/** Force-quits the extension app — used as cleanup if the click step fails partway. */
export function forceQuitExtensionApp(): void {
  cp.spawnSync('pkill', ['-x', APP_PROCESS_NAME], { stdio: 'ignore' });
}

/**
 * Clicks "Quit and Open Safari Extensions Preferences…" inside the app's window,
 * which quits the app and opens Safari's Extensions settings window.
 */
export async function clickOpenSafariPreferences(): Promise<void> {
  const clicked = runAppleScript(`
    tell application "System Events"
      tell process "${APP_PROCESS_NAME}"
        set allEls to entire contents of window 1
        repeat with el in allEls
          try
            if (role of el) is "AXButton" then
              if (name of el) contains "Safari" then
                click el
                return "clicked"
              end if
            end if
          end try
        end repeat
        return "not-found"
      end tell
    end tell
  `);
  if (clicked !== 'clicked') throw new Error('"Quit and Open Safari…" button not found in extension window');
  console.log(`  [safari] Clicked "Quit and Open Safari Extensions Preferences…" in ${APP_PROCESS_NAME}`);

  const quit = await waitUntil(async () => !(await isProcessRunning(APP_PROCESS_NAME)), 10_000);
  if (!quit) throw new Error(`${APP_PROCESS_NAME} did not quit after clicking the preferences button`);
  console.log(`  [safari] ${APP_PROCESS_NAME} quit — Safari should now be opening Extensions settings`);
}

/**
 * Reads the extension's row from Safari's Extensions settings window (normally opened
 * by clickOpenSafariPreferences). That native call doesn't always surface the window,
 * so if it hasn't appeared after a few seconds this falls back to driving Safari's own
 * Settings menu directly and selecting the Extensions tab.
 */
export async function verifyExtensionInSettings(): Promise<{ found: boolean; enabled: boolean }> {
  let hasWindow = await waitUntil(async () => {
    try {
      const out = runAppleScript('tell application "System Events" to tell process "Safari" to get name of every window');
      return out.includes('Extensions');
    } catch { return false; }
  }, 8_000);

  if (!hasWindow) {
    console.log('  [safari] Extensions window did not open automatically — falling back to Safari > Settings… menu');
    try {
      runAppleScript(`
        tell application "System Events"
          tell process "Safari"
            set frontmost to true
            click menu item "Settings…" of menu "Safari" of menu bar 1
            delay 0.6
            click button "Extensions" of toolbar 1 of window 1
          end tell
        end tell
      `);
    } catch { /* fall through — hasWindow stays false */ }
    hasWindow = await waitUntil(async () => {
      try {
        const out = runAppleScript('tell application "System Events" to tell process "Safari" to get name of every window');
        return out.includes('Extensions');
      } catch { return false; }
    }, 8_000);
  }
  console.log(`  [safari] Extensions settings window ${hasWindow ? 'opened' : 'never appeared'}`);
  if (!hasWindow) return { found: false, enabled: false };

  await sleep(500);

  // The row's checkbox precedes its label in accessibility traversal order, so the
  // last checkbox value seen before the matching label is that row's checkbox.
  const readRow = () => runAppleScript(`
    tell application "System Events"
      tell process "Safari"
        set allEls to entire contents of window "Extensions"
        set lastCbVal to "none"
        repeat with el in allEls
          try
            set r to (role of el)
            if r is "AXCheckBox" then
              set lastCbVal to (value of el) as string
            else if r is "AXStaticText" then
              if (value of el) as string is "${EXTENSION_DISPLAY_NAME}" then return lastCbVal
            end if
          end try
        end repeat
        return "not-found"
      end tell
    end tell
  `);

  let cbVal = readRow();
  console.log(`  [safari] "${EXTENSION_DISPLAY_NAME}" row in Extensions settings: ${cbVal === 'not-found' ? 'not found' : cbVal === '1' ? 'enabled' : 'disabled'}`);
  if (cbVal === 'not-found') return { found: false, enabled: false };

  if (cbVal !== '1') {
    console.log(`  [safari] Clicking the checkbox to enable "${EXTENSION_DISPLAY_NAME}"`);
    runAppleScript(`
      tell application "System Events"
        tell process "Safari"
          set allEls to entire contents of window "Extensions"
          set lastCb to missing value
          repeat with el in allEls
            try
              set r to (role of el)
              if r is "AXCheckBox" then
                set lastCb to el
              else if r is "AXStaticText" then
                if (value of el) as string is "${EXTENSION_DISPLAY_NAME}" then
                  if lastCb is not missing value then click lastCb
                  exit repeat
                end if
              end if
            end try
          end repeat
        end tell
      end tell
    `);
    await sleep(500);
    cbVal = readRow();
  }

  return { found: true, enabled: cbVal === '1' };
}

/** Closes Safari's Extensions settings window. */
export async function closeExtensionSettings(): Promise<void> {
  try {
    runAppleScript('tell application "System Events" to tell process "Safari" to click button 1 of window "Extensions"');
  } catch { /* already closed */ }
}

/**
 * Raises the frontmost Safari browser window (creating one if none exist), clicks
 * the extension's toolbar icon, and returns a text preview of the popover that
 * opens. Throws if the icon or its popover can't be found.
 */
export async function openExtensionPopup(): Promise<string> {
  // Talking to Safari directly (e.g. `tell application "Safari" to activate`) can hang
  // for a long time right after closeExtensionSettings() closes a window via UI scripting
  // — Safari's Apple Event handling is briefly unresponsive while it tears the window down.
  // Going through System Events instead (as every other function here does) avoids that.
  await runAppleScriptRetry(`
    tell application "System Events"
      tell process "Safari"
        set frontmost to true
        if (count of windows) is 0 then keystroke "n" using command down
      end tell
    end tell
  `, { attempts: 3, delayMs: 800 });
  await sleep(500);

  const clickToolbarIcon = `
    tell application "System Events"
      tell process "Safari"
        set w to window 1
        perform action "AXRaise" of w
        set frontmost to true
        delay 0.3
        set allEls to entire contents of toolbar 1 of w
        repeat with el in allEls
          try
            if (role of el) is "AXButton" then
              if (description of el) contains "Zero Trust" then
                click el
                return "clicked"
              end if
            end if
          end try
        end repeat
        return "not-found"
      end tell
    end tell
  `;

  // Find the popover by its AXDescription, then read only its own subtree —
  // bounding the search this way avoids picking up unrelated toolbar text that
  // follows it in the window's flattened accessibility tree.
  const findPopover = `
    tell application "System Events"
      tell process "Safari"
        set thePopover to missing value
        set allEls to entire contents of window 1
        repeat with el in allEls
          try
            if (role of el) is "AXPopover" then
              if (description of el) contains "${EXTENSION_DISPLAY_NAME}" then
                set thePopover to el
                exit repeat
              end if
            end if
          end try
        end repeat
        if thePopover is missing value then return "no-popover"
        set previewText to ""
        set popEls to entire contents of thePopover
        repeat with el in popEls
          try
            set r to (role of el)
            if r is "AXStaticText" or r is "AXLink" then
              set previewText to previewText & (name of el) & " | "
            end if
          end try
        end repeat
        return previewText
      end tell
    end tell
  `;

  // The toolbar icon toggles the popover open/closed, so a single click can land on
  // either state depending on whether a previous run left it open. Each attempt below
  // re-clicks before checking, so a click that happens to close it is corrected by the
  // next attempt's click reopening it, instead of just waiting longer for the same click.
  let preview: string | null = null;
  for (let attempt = 0; attempt < 4 && preview === null; attempt++) {
    const clicked = runAppleScript(clickToolbarIcon);
    if (clicked !== 'clicked') throw new Error('Extension toolbar icon not found in Safari toolbar');
    console.log(`  [safari] Clicked the "${EXTENSION_DISPLAY_NAME}" toolbar icon (attempt ${attempt + 1})`);
    await sleep(1_500);
    const result = runAppleScript(findPopover);
    console.log(`  [safari] Popover check (attempt ${attempt + 1}): ${result === 'no-popover' ? 'not found' : 'found'}`);
    if (result !== 'no-popover') preview = result;
  }
  if (preview === null) throw new Error('Clicked the extension icon but no popover appeared');

  console.log(`  [safari] Popover preview: ${preview.trim().slice(0, 150)}`);
  return preview.trim();
}

/** Dismisses the extension popover. */
export async function closeExtensionPopup(): Promise<void> {
  try { runAppleScript('tell application "System Events" to key code 53'); } catch { /* ignore */ }
}

/** Captures a screenshot of just the frontmost Safari window's bounds. Best-effort. */
export function screenshotSafariWindow(filePath: string): void {
  try {
    const bounds = runAppleScript(`
      tell application "System Events"
        tell process "Safari"
          set {px, py} to position of window 1
          set {sw, sh} to size of window 1
          return (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string)
        end tell
      end tell
    `);
    const [x, y, w, h] = bounds.split(',').map(Number);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    cp.spawnSync('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, filePath], { stdio: 'ignore' });
  } catch { /* screenshot is best-effort */ }
}
