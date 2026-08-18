// Minimal duck-type interface shared by GdSession (Firefox), SdSession (Safari), and PopupSession (Chrome/Edge).
export interface WebDriverSession {
  navigate(url: string): Promise<unknown>;
  findElement(strategy: string, selector: string): Promise<string | null>;
  clickElement(id: string): Promise<void>;
  execute<T>(script: string, args?: unknown[]): Promise<T>;
  sendKeys(elementId: string, text: string): Promise<void>;
  poll<T>(fn: () => Promise<T>, cond: (v: T) => boolean, opts: { timeout: number; interval: number; message: string }): Promise<T>;
}

export function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

/**
 * Log into the dashboard using the raw WebDriver JSON-wire protocol.
 * Works with both GdSession (Firefox) and SdSession (Safari).
 */
export async function webdriverLogin(
  session: WebDriverSession,
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  await session.navigate(baseUrl);
  await sleep(5_000);

  // If already logged in (email input not visible), log out first so the login form appears.
  const alreadyLoggedIn = await session.findElement('css selector', '[data-testid="input-email"]')
    .then(el => el === null)
    .catch(() => false);
  if (alreadyLoggedIn) {
    console.log('  [webdriverLogin] Already logged in — logging out first');
    const logoutUrl = baseUrl.replace(/\/?$/, '/api/logout?ext=t');
    await session.navigate(logoutUrl);
    await sleep(5_000);
    await session.navigate(baseUrl);
    await sleep(8_000);
  }

  // Step 1: email
  const emailInput = await session.poll(
    () => session.findElement('css selector', '[data-testid="input-email"]'),
    el => el !== null,
    { timeout: 30_000, interval: 1_500, message: 'Email input not found on dashboard' },
  );
  if (!emailInput) throw new Error('Email input not found');
  await session.sendKeys(emailInput, email);

  const submitBtn1 = await session.findElement('css selector', '[data-testid="button-submit"]');
  if (!submitBtn1) throw new Error('Submit button not found after email input');
  await session.clickElement(submitBtn1);
  await sleep(3_000);

  // Step 2: optional SSO → password button
  const ssoBtn = await session.findElement('xpath',
    '//button[contains(translate(text(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"sign in with password")]',
  );
  if (ssoBtn) { await session.clickElement(ssoBtn); await sleep(2_000); }

  // Step 3: password
  const pwInput = await session.poll(
    () => session.findElement('css selector', '[data-testid="input-password"]'),
    el => el !== null,
    { timeout: 10_000, interval: 1_000, message: 'Password input not found' },
  );
  if (!pwInput) throw new Error('Password input not found');

  await session.execute<void>(
    'const el = document.querySelector(\'[data-testid="input-password"]\'); if(el){el.value=""; el.dispatchEvent(new Event("input",{bubbles:true}));}',
    [],
  );
  await session.sendKeys(pwInput, password);

  const submitBtn2 = await session.findElement('css selector', '[data-testid="button-submit"]');
  if (!submitBtn2) throw new Error('Submit button not found after password input');
  await session.clickElement(submitBtn2);

  console.log('  Submitted login form');
  await sleep(5_000);
}

/**
 * Returns true when the popup body shows a connected (non-auth) state.
 * Treats loading/initialising/empty/sentinel as not-ready.
 */
export function isConnectedState(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || trimmed === '__popup_no_webarea__') return false;
  if (/^loading\.{0,3}$/i.test(trimmed) || /initializ/i.test(trimmed)) return false;
  if (/authenticate/i.test(body)) return false;
  if (/login to the management console/i.test(body) || /welcome back to zero trust/i.test(body)) return false;
  return true;
}

export interface SessionWithBodyText extends WebDriverSession {
  bodyText(): Promise<string>;
  screenshot(path: string): Promise<void>;
  getElementText(id: string): Promise<string>;
}

/**
 * Open the more-options → Profile flow and verify the email.
 * Used by Firefox (GdSession implements SessionWithBodyText).
 */
export async function verifyProfileEmail(
  session: SessionWithBodyText,
  expectedEmail: string,
  screenshotPathFail: string,
): Promise<void> {
  const moreBtn = await session.findElement('css selector', '[data-testid="header-more-options-button"]');
  if (!moreBtn) {
    const body = await session.bodyText().catch(() => '');
    await session.screenshot(screenshotPathFail);
    throw new Error(`More button not found — popup may not be in connected state. Body: "${body.trim().slice(0, 200)}"`);
  }
  await session.clickElement(moreBtn);
  await sleep(500);

  const profileBtn = await session.findElement('xpath',
    '//button[contains(text(),"Profile") or contains(@aria-label,"Profile")]')
    ?? await session.findElement('css selector', '[data-testid*="profile"]');
  if (!profileBtn) throw new Error('Profile button not found in menu');
  await session.clickElement(profileBtn);
  await sleep(1_500);

  const emailEl = await session.findElement('css selector', '[data-testid="profile-user-email"]');
  if (!emailEl) throw new Error('Profile email element not found');
  const displayed = (await session.getElementText(emailEl)).trim().toLowerCase();
  if (displayed !== expectedEmail.trim().toLowerCase()) {
    throw new Error(`Profile email mismatch: expected "${expectedEmail}" but got "${displayed}"`);
  }
  console.log(`  Popup profile email: ${displayed}`);
}
