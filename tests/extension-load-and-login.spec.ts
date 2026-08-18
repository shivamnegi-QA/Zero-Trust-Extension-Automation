import { test, expect, EMAIL, PASSWORD, BASE_URL } from '../fixtures/extension';
import { isConnectedState, webdriverLogin, sleep } from './helpers/webdriver-login';
import { ensureAutomationTenant } from './helpers/safari-tenant';

test.describe.serial('Extension Load And Login', () => {

  // Safari only: ensure the extension is pointed at the automation tenant (not qatenant).
  // Run before tests so the login flow works against the right tenant.
  test.beforeAll(async ({ extSession }) => {
    if (extSession.browser === 'safari') {
      await Promise.race([
        ensureAutomationTenant(extSession as any, EMAIL, PASSWORD, '[safari-tenant]'),
        new Promise<void>(r => setTimeout(r, 60_000)),
      ]);
    }
  });

  // Clear auth after all cases complete so the session is clean for the next run.
  test.afterAll(async ({ extSession }) => {
    await Promise.race([
      extSession.clearAuth(),
      new Promise<void>(r => setTimeout(r, 60_000)),
    ]);
  });

  // @desc Launches the browser with the extension installed and verifies it is registered.
  // @validates extensionKey is a non-empty string — confirms the extension loaded without errors
  test('Extension loads', async ({ extSession, extId }) => {
    await sleep(1_500);
    expect(extId, `Extension should load in ${extSession.browser} — check extension build and fixture`).toBeTruthy();
    console.log(`  [${extSession.browser}] Extension key: ${extId}`);
  });

  // @desc Opens the extension popup and verifies it renders visible content.
  // Continues from the loaded-extension state left by the previous test.
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
  // Continues from the open-popup state left by the previous test (popup is closed).
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
        return /authenticate/i.test(body) || /continue/i.test(body) || /login to the management console/i.test(body);
      },
      v => v === true,
      { timeout: 60_000, interval: 3_000, message: 'Popup did not show Authenticate button' },
    );

    console.log(`  [${extSession.browser}] Popup shows Authenticate — unauthenticated state confirmed`);
    await extSession.screenshot(`extension builds/screenshots/${extSession.browser}-test-popup-unauthenticated.png`);
    await extSession.closePopup().catch(() => {});
  });

  // @desc Logs into the dashboard and verifies the popup transitions to connected state.
  // Continues from the confirmed-unauthenticated state left by the previous test.
  // When run in isolation, beforeAll cleared auth so the login step still works correctly.
  // @validates popup shows connected state (non-empty, no Authenticate button) after dashboard login
  test('Extension popup shows connected state after dashboard login', async ({ extSession, extId }) => {
    test.slow();
    test.skip(!extId, 'Extension not loaded');

    await webdriverLogin(extSession as any, BASE_URL, EMAIL, PASSWORD);

    // For Chrome: give the extension extra time to pick up the auth cookie after login.
    if (extSession.browser === 'chrome') {
      await sleep(8_000);
    }

    // For Safari: navigate to the dashboard multiple times after login so the extension's
    // tab-update event fires and it re-reads the auth cookie.
    if (extSession.browser === 'safari') {
      // Give the login redirect time to complete and cookies to settle
      await sleep(3_000);
      await extSession.navigate(BASE_URL);
      await sleep(8_000);
      await extSession.navigate(BASE_URL);
      await sleep(8_000);
      await extSession.navigate(BASE_URL);
      await sleep(8_000);
    }

    // Poll until popup shows connected state.
    // Safari needs a longer timeout — the extension syncs auth state asynchronously.
    const connectedPollTimeout = extSession.browser === 'safari' ? 180_000 : 90_000;
    const connectedPollInterval = extSession.browser === 'safari' ? 5_000 : 3_000;
    let lastPopupBody = '';
    await extSession.poll(
      async () => {
        await extSession.closePopup().catch(() => {});
        await sleep(500);
        const body = await extSession.openPopup().catch(() => '');
        await sleep(1_500);
        await extSession.closePopup().catch(() => {});
        lastPopupBody = body;
        if (extSession.browser === 'safari') {
          console.log(`  [safari] poll popup preview: ${body.trim().slice(0, 80)}`);
        }
        return isConnectedState(body);
      },
      v => v === true,
      { timeout: connectedPollTimeout, interval: connectedPollInterval, message: `Popup did not reach connected state after dashboard login. Last body: "${lastPopupBody.trim().slice(0, 200)}"` },
    );

    await sleep(2_000);
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
