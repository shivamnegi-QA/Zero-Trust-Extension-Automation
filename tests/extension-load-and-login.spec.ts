import { test, expect, EMAIL, PASSWORD, BASE_URL } from '../fixtures/extension';
import { isConnectedState } from './helpers/webdriver-login';
import type { PopupSession } from '../fixtures/extension';

/**
 * Log into the dashboard using WebDriver sendKeys (most reliable cross-browser input method).
 * Works for Chrome (Playwright-backed), Firefox (geckodriver), and Safari (safaridriver).
 */
async function loginViaDashboard(session: PopupSession): Promise<void> {
  await session.navigate(BASE_URL);
  await sleep(5_000);

  // Wait for and fill email input
  const emailEl = await session.poll(
    () => session.findElement('css selector', '[data-testid="input-email"]'),
    el => el !== null,
    { timeout: 15_000, interval: 1_000, message: 'Email input not found on dashboard' },
  );
  if (!emailEl) throw new Error('Email input not found');
  await session.sendKeys(emailEl, EMAIL);
  await sleep(500);

  const submitBtn1 = await session.findElement('css selector', '[data-testid="button-submit"]');
  if (submitBtn1) await session.clickElement(submitBtn1);
  await sleep(4_000);

  // Optional SSO → password button
  const ssoBtn = await session.findElement('xpath',
    '//button[contains(translate(text(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"sign in with password")]',
  );
  if (ssoBtn) { await session.clickElement(ssoBtn); await sleep(2_000); }

  // Wait for and fill password input
  const pwEl = await session.poll(
    () => session.findElement('css selector', '[data-testid="input-password"]'),
    el => el !== null,
    { timeout: 15_000, interval: 1_000, message: 'Password input not found' },
  );
  if (!pwEl) throw new Error('Password input not found');
  await session.sendKeys(pwEl, PASSWORD);
  await sleep(500);

  const submitBtn2 = await session.findElement('css selector', '[data-testid="button-submit"]');
  if (submitBtn2) await session.clickElement(submitBtn2);

  // Wait for redirect to confirm login completed
  await sleep(3_000);
  const postLoginUrl = await session.currentUrl().catch(() => '');
  console.log(`  Submitted login form — post-login URL: ${postLoginUrl}`);

  // Give the extension time to receive the auth token.
  // Safari needs extra time: the extension reads the dashboard cookie asynchronously.
  await sleep(session.browser === 'chrome' ? 2_000 : session.browser === 'safari' ? 15_000 : 7_000);
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

test.describe('Extension Load And Login', () => {

  // Clear auth state before each test so the shared browser session always starts unauthenticated.
  test.beforeEach(async ({ extSession }) => {
    await extSession.clearAuth();
  });

  // @desc Launches the browser with the extension installed and verifies it is registered.
  // @validates extensionKey is a non-empty string — confirms the extension loaded without errors
  test('Extension loads', async ({ extSession, extId }) => {
    await sleep(1_500);
    expect(extId, `Extension should load in ${extSession.browser} — check extension build and fixture`).toBeTruthy();
    console.log(`  [${extSession.browser}] Extension key: ${extId}`);
  });

  // @desc Opens the extension popup and verifies it renders visible content.
  // @validates popup body text length is greater than 0
  test('Extension popup opens', async ({ extSession, extId }) => {
    test.skip(!extId, 'Extension not loaded');

    await sleep(extSession.browser === 'safari' ? 3_000 : 1_500);

    const body = await extSession.poll(
      async () => {
        await extSession.closePopup().catch(() => {});
        await sleep(300);
        return extSession.openPopup().catch(() => '');
      },
      b => b.trim().length > 0 && b.trim() !== '__popup_no_webarea__',
      { timeout: 45_000, interval: 3_000, message: 'Popup body should not be empty' },
    );

    expect(body.trim().length, 'Popup body should not be empty').toBeGreaterThan(0);
    console.log(`  [${extSession.browser}] Popup preview: ${body.trim().slice(0, 120)}`);

    await extSession.screenshot(`extension builds/screenshots/${extSession.browser}-test-popup.png`);
    await extSession.closePopup().catch(() => {});
  });

  // @desc Opens the popup without a dashboard session and verifies Authenticate button is present.
  // @validates Authenticate button text visible in popup body within 60s
  test('Extension popup shows unauthenticated state without dashboard session', async ({ extSession, extId }) => {
    test.skip(!extId, 'Extension not loaded');

    await sleep(extSession.browser === 'safari' ? 3_000 : 1_500);

    await extSession.poll(
      async () => {
        await extSession.closePopup().catch(() => {});
        await sleep(300);
        const body = await extSession.openPopup().catch(() => '');
        await sleep(1_000);
        await extSession.closePopup().catch(() => {});
        return /authenticate/i.test(body);
      },
      v => v === true,
      { timeout: 60_000, interval: 3_000, message: 'Popup did not show Authenticate button' },
    );

    console.log(`  [${extSession.browser}] Popup shows Authenticate — unauthenticated state confirmed`);
    await extSession.screenshot(`extension builds/screenshots/${extSession.browser}-test-popup-unauthenticated.png`);
    await extSession.closePopup().catch(() => {});
  });

  // @desc Logs into the dashboard, opens the popup, and verifies it shows connected state.
  // @validates popup shows connected state (non-empty, no Authenticate button) after dashboard login
  test('Extension popup shows connected state after dashboard login', async ({ extSession, extId }) => {
    test.slow();
    test.skip(!extId, 'Extension not loaded');

    await loginViaDashboard(extSession);

    // For Safari: navigate to the dashboard once more after login so the extension's
    // tab-update event fires and it re-reads the auth cookie.
    if (extSession.browser === 'safari') {
      await extSession.navigate(BASE_URL);
      await sleep(5_000);
    }

    // Poll until popup shows connected state.
    // Safari needs a longer timeout — the extension syncs auth state asynchronously.
    const connectedPollTimeout = extSession.browser === 'safari' ? 120_000 : 90_000;
    const connectedPollInterval = extSession.browser === 'safari' ? 5_000 : 3_000;
    await extSession.poll(
      async () => {
        await extSession.closePopup().catch(() => {});
        await sleep(500);
        const body = await extSession.openPopup().catch(() => '');
        await sleep(1_500);
        await extSession.closePopup().catch(() => {});
        return isConnectedState(body);
      },
      v => v === true,
      { timeout: connectedPollTimeout, interval: connectedPollInterval, message: 'Popup did not reach connected state after dashboard login' },
    );

    const connectedBody = await extSession.openPopup();
    await extSession.screenshot(`extension builds/screenshots/${extSession.browser}-test-popup-connected.png`);

    expect(connectedBody.trim().length, 'Popup body should not be empty in connected state').toBeGreaterThan(0);
    expect(
      /authenticate/i.test(connectedBody),
      `Popup should not show Authenticate in connected state. Got: "${connectedBody.trim().slice(0, 200)}"`,
    ).toBe(false);

    console.log(`  [${extSession.browser}] Connected state confirmed. Preview: ${connectedBody.trim().slice(0, 120)}`);

    // For Chrome and Firefox: verify profile email via more-button → Profile
    if (extSession.browser !== 'safari') {
      const moreBtn = await extSession.findElement('css selector', '[data-testid="header-more-options-button"]');
      if (!moreBtn) {
        await extSession.screenshot(`extension builds/screenshots/${extSession.browser}-test-popup-connected-fail.png`);
        throw new Error(`More button not visible — popup may not be in connected state. Body: "${connectedBody.trim().slice(0, 200)}"`);
      }
      await extSession.clickElement(moreBtn);
      await sleep(500);

      const profileBtn = await extSession.findElement('xpath',
        '//button[contains(text(),"Profile") or contains(@aria-label,"Profile")]')
        ?? await extSession.findElement('css selector', '[data-testid*="profile"]');
      if (!profileBtn) throw new Error('Profile button not found in menu');
      await extSession.clickElement(profileBtn);
      await sleep(1_500);

      const emailEl = await extSession.findElement('css selector', '[data-testid="profile-user-email"]');
      if (!emailEl) throw new Error('Profile email element not found');
      const displayed = (await extSession.execute<string>(
        `return document.querySelector('[data-testid="profile-user-email"]')?.innerText?.trim() ?? ''`,
      )).toLowerCase();
      expect(displayed, 'Profile email should match the login email').toBe(EMAIL.trim().toLowerCase());
      console.log(`  [${extSession.browser}] Profile email: ${displayed}`);
    }

    await extSession.closePopup().catch(() => {});
  });

});
