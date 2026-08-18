/**
 * Diagnostic: login via Safari main window (not WebDriver) to test if extension
 * can detect auth state from the main browser session vs the WebDriver isolated session.
 */
import { launchSafariWithExtension, openAndReadSafariPopup, closeSafariPopupViaAX } from './system-safari';
import * as dotenv from 'dotenv';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
dotenv.config();

const BASE_URL = process.env.SQRX_BASE_URL ?? '';
const EMAIL = process.env.EXTENSION_LOGIN_EMAIL ?? '';
const PASSWORD = process.env.EXTENSION_LOGIN_PASSWORD ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function runOsa(script: string): string {
  const tmp = path.join(os.tmpdir(), `osa-diag-${Date.now()}.scpt`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    return cp.execSync(`osascript ${JSON.stringify(tmp)}`, { timeout: 30_000 }).toString().trim();
  } catch (e: any) {
    return `error: ${String(e.message).slice(0, 100)}`;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

async function loginViaMainWindow(): Promise<string> {
  // Open a main Safari tab and login using do JavaScript
  // Step 1: navigate to the login page in a main (non-WebDriver) tab
  const navScript = `
tell application "Safari"
  set allWins to windows
  set targetWin to missing value
  repeat with w in allWins
    try
      set tabURL to URL of current tab of w
      if tabURL contains "onsquarex.com" or tabURL is "about:blank" then
        set targetWin to w
        set URL of current tab of w to "${BASE_URL}"
        exit repeat
      end if
    end try
  end repeat
  if targetWin is missing value then
    make new document with properties {URL:"${BASE_URL}"}
  end if
  return "navigated"
end tell
`;
  const navResult = runOsa(navScript);
  console.log('Navigate result:', navResult);
  await sleep(5000);

  // Step 2: fill email
  const emailScript = `
tell application "Safari"
  repeat with w in windows
    try
      set tabURL to URL of current tab of w
      if tabURL contains "onsquarex.com" then
        set r to do JavaScript "var el = document.querySelector('[data-testid=\\"input-email\\"]'); if(el){el.value='${EMAIL}'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'found';} return 'missing';" in w
        return r
      end if
    end try
  end repeat
  return "no_win"
end tell
`;
  const emailResult = runOsa(emailScript);
  console.log('Email fill result:', emailResult);
  await sleep(1000);

  // Step 3: click submit (step 1 form)
  const submit1Script = `
tell application "Safari"
  repeat with w in windows
    try
      set tabURL to URL of current tab of w
      if tabURL contains "onsquarex.com" then
        set r to do JavaScript "var btn = document.querySelector('[data-testid=\\"button-submit\\"]'); if(btn){btn.click(); return 'clicked';} return 'missing';" in w
        return r
      end if
    end try
  end repeat
  return "no_win"
end tell
`;
  const submit1Result = runOsa(submit1Script);
  console.log('Submit1 result:', submit1Result);
  await sleep(3000);

  // Step 4: fill password
  const pwScript = `
tell application "Safari"
  repeat with w in windows
    try
      set tabURL to URL of current tab of w
      if tabURL contains "onsquarex.com" then
        set r to do JavaScript "var el = document.querySelector('[data-testid=\\"input-password\\"]'); if(el){el.value='${PASSWORD}'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'found';} return 'missing';" in w
        return r
      end if
    end try
  end repeat
  return "no_win"
end tell
`;
  const pwResult = runOsa(pwScript);
  console.log('Password fill result:', pwResult);
  await sleep(1000);

  // Step 5: click submit (step 2 form)
  const submit2Script = `
tell application "Safari"
  repeat with w in windows
    try
      set tabURL to URL of current tab of w
      if tabURL contains "onsquarex.com" then
        set r to do JavaScript "var btn = document.querySelector('[data-testid=\\"button-submit\\"]'); if(btn){btn.click(); return 'clicked';} return 'missing';" in w
        return r
      end if
    end try
  end repeat
  return "no_win"
end tell
`;
  const submit2Result = runOsa(submit2Script);
  console.log('Submit2 result:', submit2Result);
  await sleep(8000);

  // Check URL
  const urlScript = `
tell application "Safari"
  repeat with w in windows
    try
      set u to URL of current tab of w
      if u contains "onsquarex.com" then return u
    end try
  end repeat
  return "not_found"
end tell
`;
  return runOsa(urlScript);
}

async function main(): Promise<void> {
  const { session, teardown } = await launchSafariWithExtension({
    extractedDir: path.resolve('extension builds/safari-1.4.3'),
    tag: '[diag]',
  });
  try {
    // Get initial popup state (should be Authenticate)
    console.log('\n--- Initial popup state ---');
    closeSafariPopupViaAX();
    await sleep(500);
    const initialPopup = openAndReadSafariPopup();
    console.log('Initial popup:', initialPopup.slice(0, 120));

    // Now login via MAIN SAFARI WINDOW (not WebDriver)
    console.log('\n--- Logging in via main Safari window ---');
    const mainUrl = await loginViaMainWindow();
    console.log('Main window URL after login:', mainUrl.slice(0, 120));

    // Poll popup state after main-window login
    console.log('\n--- Polling popup after main-window login ---');
    for (let i = 0; i < 8; i++) {
      closeSafariPopupViaAX();
      await sleep(500);
      const body = openAndReadSafariPopup();
      console.log(`Popup (${i}):`, body.slice(0, 150));
      closeSafariPopupViaAX();
      await sleep(3000);
    }

    // Now ALSO login via WebDriver session (same profile?)
    console.log('\n--- Logging in via WebDriver session ---');
    await session.navigate(BASE_URL);
    await sleep(5000);
    const emailInput = await session.findElement('css selector', '[data-testid="input-email"]');
    if (emailInput) await session.sendKeys(emailInput, EMAIL);
    const s1 = await session.findElement('css selector', '[data-testid="button-submit"]');
    if (s1) { await session.clickElement(s1); await sleep(3000); }
    const pwInput = await session.findElement('css selector', '[data-testid="input-password"]');
    if (pwInput) {
      await session.sendKeys(pwInput, PASSWORD);
      const s2 = await session.findElement('css selector', '[data-testid="button-submit"]');
      if (s2) { await session.clickElement(s2); await sleep(8000); }
    }
    const wdUrl = await session.currentUrl();
    console.log('WebDriver session URL after login:', wdUrl.slice(0, 100));

    // Poll popup after WebDriver login
    console.log('\n--- Polling popup after WebDriver login ---');
    for (let i = 0; i < 5; i++) {
      closeSafariPopupViaAX();
      await sleep(500);
      const body = openAndReadSafariPopup();
      console.log(`Popup (${i}):`, body.slice(0, 150));
      closeSafariPopupViaAX();
      await sleep(3000);
    }

  } finally {
    await teardown();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
