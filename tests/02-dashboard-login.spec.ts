import { test, expect, clearSession } from '../fixtures/base';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';

const EMAIL    = process.env.EXTENSION_LOGIN_EMAIL!;
const PASSWORD = process.env.EXTENSION_LOGIN_PASSWORD!;
const BASE_URL = process.env.SQRX_BASE_URL!;

test.describe.serial('Dashboard Login', () => {

  // Clear session once before the entire suite — tests chain from here.
  test.beforeAll(async ({ context }) => {
    await clearSession(context, BASE_URL);
  });

  // @desc Navigates to the base URL and verifies the login form is present and interactive.
  // @validates email input and submit button are visible within 15s — login form rendered correctly on unauthenticated load
  test('Login page loads', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto(BASE_URL);

    await expect(page.getByTestId('input-email')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('button-submit')).toBeVisible();

    console.log(`  Login page URL: ${page.url()}`);
    await page.screenshot({ path: 'extension builds/screenshots/test-login-page.png' });
  });

  // @desc Submits a deliberately wrong password and confirms the user is not redirected to the enterprise dashboard.
  // @validates page URL does not match /enterprise/#/ and an error state or login page is still shown after failed login attempt
  test('Login fails with wrong password', async ({ page }) => {
    test.slow();

    const loginPage = new LoginPage(page);
    await loginPage.goto(BASE_URL);
    await loginPage.login(EMAIL, 'wrong-password-intentional');

    await expect
      .poll(() => loginPage.isLoginErrorVisible().then(v => v || !/\/enterprise\/#\//.test(page.url())), { timeout: 8_000 })
      .toBeTruthy();

    const isOnEnterprise = /\/enterprise\/#\//.test(page.url());
    expect(isOnEnterprise, 'Wrong password should not reach the dashboard').toBe(false);

    const hasError = await loginPage.isLoginErrorVisible();
    if (hasError) {
      const msg = await loginPage.getErrorText();
      console.log(`  Error message: "${msg}"`);
      expect(msg.length, 'Error message should not be empty').toBeGreaterThan(0);
    } else {
      console.log('  Stayed on login page (no explicit error element — still correct)');
    }

    await page.screenshot({ path: 'extension builds/screenshots/test-wrong-password.png' });
  });

  // @desc Logs in with valid credentials and confirms the browser redirects to the enterprise dashboard with navigation visible.
  // @validates URL matches /enterprise/#/ and sidebar nav is visible after successful login
  test('Login succeeds with valid credentials', async ({ page }) => {
    test.slow();

    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto(BASE_URL);
    await loginPage.login(EMAIL, PASSWORD);
    await loginPage.waitForLoginSuccess();

    expect(page.url()).toMatch(/\/enterprise\/#\//);

    const hasNav = await dashboard.hasSidebarNav();
    expect(hasNav, 'Sidebar nav should be visible after login').toBe(true);

    console.log(`  Post-login URL: ${page.url()}`);
    await page.screenshot({ path: 'extension builds/screenshots/test-login-success.png' });
  });

  // @desc Verifies the dashboard session persists across a page reload.
  // Continues from the logged-in state left by the previous test.
  // When run in isolation (beforeAll cleared the session), logs in first.
  // @validates DashboardPage.isLoaded() returns true within 10s after reload
  test('Session persists after page reload', async ({ page }) => {
    test.slow();

    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    // Navigate to BASE_URL. If a session cookie is present the SPA will redirect
    // to /enterprise/ — wait up to 6s for that redirect before deciding to login.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    const alreadyLoggedIn = await page
      .waitForURL(/\/enterprise\//, { timeout: 6_000 })
      .then(() => true)
      .catch(() => false);

    if (!alreadyLoggedIn) {
      // Running in isolation or session expired — login first.
      await loginPage.login(EMAIL, PASSWORD);
      await loginPage.waitForLoginSuccess();
    }

    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect
      .poll(() => dashboard.isLoaded(), { timeout: 10_000, intervals: [500] })
      .toBe(true);

    console.log(`  Post-reload URL: ${page.url()}`);
    await page.screenshot({ path: 'extension builds/screenshots/test-session-persist.png' });
  });

});
