/**
 * Ensures the Safari extension popup is authenticated against the "automation" tenant,
 * not "qatenant". Call this after clearAuth, before the main test body.
 *
 * Flow:
 *  1. Open popup → click ⋯ (more options / three-dots header button)
 *  2. Click "Info" in the menu that appears
 *  3. Read the tenant name from the info page body text
 *  4. If tenant is "qatenant":
 *     a. Navigate to qatenant logout URL to invalidate that session
 *     b. Close popup, wait, reopen popup
 *     c. Click "Authenticate"
 *     d. Fill email, click Next / Continue
 *     e. If org/tenant field appears, type "automation"
 *     f. Fill password, submit
 *  5. If already on "automation" (or popup shows Authenticate with no wrong tenant), do nothing.
 */

import {
  openAndReadSafariPopup,
  closeSafariPopupViaAX,
  getSafariPopupBodyText,
  clickInSafariPopupDeep,
  typeInSafariPopup,
  activateSafari,
} from '../../utils/system-safari';

export function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

export interface TenantSession {
  navigate(url: string): Promise<unknown>;
  findElement(strategy: string, selector: string): Promise<string | null>;
  clickElement(id: string): Promise<void>;
  sendKeys(id: string, text: string): Promise<void>;
  poll<T>(fn: () => Promise<T>, cond: (v: T) => boolean, opts: { timeout: number; interval: number; message: string }): Promise<T>;
}

const QATENANT_LOGOUT = 'https://qatenant.in.onsquarex.com/api/logout?ext=t';

export async function ensureAutomationTenant(
  session: TenantSession,
  email: string,
  password: string,
  tag = '[tenant-fix]',
): Promise<void> {
  // ── Step 1: open popup and read current state ──────────────────────────────
  activateSafari();
  await sleep(400);
  closeSafariPopupViaAX();
  await sleep(400);
  const initialBody = openAndReadSafariPopup();
  console.log(`${tag} Initial popup: ${initialBody.trim().slice(0, 100)}`);

  // If popup shows Authenticate already (no session at all), nothing to fix re: tenant.
  // But we still proceed to check — maybe it's stuck on qatenant.
  // If popup is connected, we need to check which tenant.

  // ── Step 2: click the three-dots / more-options button ────────────────────
  // The button description is typically "more options", "⋯", or contains "options"
  let clickedMore = false;
  for (const label of ['more options', '⋯', 'options', '...', 'menu']) {
    if (clickInSafariPopupDeep(label)) {
      clickedMore = true;
      console.log(`${tag} Clicked more-options button ("${label}")`);
      break;
    }
  }
  if (!clickedMore) {
    console.log(`${tag} Could not find more-options button — skipping tenant check`);
    closeSafariPopupViaAX();
    return;
  }
  await sleep(800);

  // ── Step 3: click "Info" in the dropdown ──────────────────────────────────
  const clickedInfo = clickInSafariPopupDeep('Info');
  if (!clickedInfo) {
    console.log(`${tag} Could not find Info menu item — skipping tenant check`);
    closeSafariPopupViaAX();
    return;
  }
  await sleep(800);

  // ── Step 4: read tenant name from info page ────────────────────────────────
  const infoBody = getSafariPopupBodyText();
  console.log(`${tag} Info page body: ${infoBody.trim().slice(0, 200)}`);

  // Check for qatenant in the body text (case-insensitive)
  const isWrongTenant = /qatenant/i.test(infoBody);
  if (!isWrongTenant) {
    console.log(`${tag} Tenant looks correct (not qatenant) — no fix needed`);
    closeSafariPopupViaAX();
    return;
  }

  console.log(`${tag} Wrong tenant detected (qatenant) — logging out and re-authenticating`);

  // ── Step 5: hit qatenant logout URL ───────────────────────────────────────
  closeSafariPopupViaAX();
  await sleep(300);
  await session.navigate(QATENANT_LOGOUT);
  await sleep(3000);
  console.log(`${tag} Navigated to qatenant logout URL`);

  // ── Step 6: open popup → should now show Authenticate ────────────────────
  closeSafariPopupViaAX();
  await sleep(500);
  let popupBody = '';
  for (let i = 0; i < 10; i++) {
    closeSafariPopupViaAX();
    await sleep(300);
    popupBody = openAndReadSafariPopup();
    console.log(`${tag} Post-logout popup (${i}): ${popupBody.trim().slice(0, 80)}`);
    if (/authenticate/i.test(popupBody)) break;
    await sleep(3000);
  }
  if (!/authenticate/i.test(popupBody)) {
    console.log(`${tag} Popup did not show Authenticate after logout — continuing anyway`);
  }

  // ── Step 7: click Authenticate ────────────────────────────────────────────
  const clickedAuth = clickInSafariPopupDeep('Authenticate');
  if (!clickedAuth) {
    console.log(`${tag} Could not click Authenticate button — aborting tenant fix`);
    closeSafariPopupViaAX();
    return;
  }
  await sleep(1500);
  console.log(`${tag} Clicked Authenticate`);

  // ── Step 8: fill email ────────────────────────────────────────────────────
  const typedEmail = typeInSafariPopup(email);
  console.log(`${tag} Typed email: ${typedEmail}`);
  await sleep(400);
  let clickedNext = false;
  for (const label of ['Next', 'Continue', 'Sign in', 'Submit']) {
    if (clickInSafariPopupDeep(label)) { clickedNext = true; break; }
  }
  console.log(`${tag} Clicked next/continue: ${clickedNext}`);
  await sleep(2000);

  // ── Step 9: check if org/tenant name field appeared ───────────────────────
  const afterEmailBody = getSafariPopupBodyText();
  console.log(`${tag} After email body: ${afterEmailBody.trim().slice(0, 150)}`);
  if (/org|tenant|organization|workspace/i.test(afterEmailBody)) {
    console.log(`${tag} Org/tenant field detected — typing "automation"`);
    typeInSafariPopup('automation');
    await sleep(300);
    for (const label of ['Next', 'Continue', 'Submit']) {
      if (clickInSafariPopupDeep(label)) break;
    }
    await sleep(2000);
  }

  // ── Step 10: fill password ────────────────────────────────────────────────
  const typedPw = typeInSafariPopup(password);
  console.log(`${tag} Typed password: ${typedPw}`);
  await sleep(400);
  for (const label of ['Sign in', 'Submit', 'Login', 'Next']) {
    if (clickInSafariPopupDeep(label)) break;
  }
  await sleep(3000);
  closeSafariPopupViaAX();
  console.log(`${tag} Tenant fix complete`);
}
