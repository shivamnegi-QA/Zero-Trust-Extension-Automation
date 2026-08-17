/**
 * Quick one-off script to discover login selectors on the dashboard and extension popup.
 * Run: npm run inspect-login
 */
import { chromium } from '@playwright/test';
import * as path from 'path';
import { env } from '../utils/env';

async function main() {
  const extensionPath = path.resolve(env.EXTENSION_PATH);
  const profilePath   = path.resolve('extension builds/ztb-test-profile');

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chrome',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await context.newPage();

  console.log('\n=== Dashboard login page ===');
  await page.goto(env.SQRX_BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const inputs = await page.$$eval('input', (els) =>
    els.map((el) => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      'data-testid': el.getAttribute('data-testid'),
      'aria-label': el.getAttribute('aria-label'),
    }))
  );
  console.log('Inputs:', JSON.stringify(inputs, null, 2));

  const buttons = await page.$$eval('button', (els) =>
    els.map((el) => ({
      text: el.innerText.trim(),
      type: el.type,
      id: el.id,
      'data-testid': el.getAttribute('data-testid'),
      'aria-label': el.getAttribute('aria-label'),
    }))
  );
  console.log('Buttons:', JSON.stringify(buttons, null, 2));

  console.log('\nURL after load:', page.url());
  await page.screenshot({ path: 'extension builds/screenshots/login-page-step1.png', fullPage: true });

  // Submit email and observe step 2
  console.log('\n=== Submitting email ===');
  await page.fill('[data-testid="input-email"]', env.EXTENSION_LOGIN_EMAIL);
  await page.click('[data-testid="button-submit"]');
  await page.waitForTimeout(3000);

  const inputs2 = await page.$$eval('input', (els) =>
    els.map((el) => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      'data-testid': el.getAttribute('data-testid'),
      'aria-label': el.getAttribute('aria-label'),
    }))
  );
  console.log('Step 2 inputs:', JSON.stringify(inputs2, null, 2));

  const buttons2 = await page.$$eval('button', (els) =>
    els.map((el) => ({
      text: el.innerText.trim(),
      type: el.type,
      id: el.id,
      'data-testid': el.getAttribute('data-testid'),
    }))
  );
  console.log('Step 2 buttons:', JSON.stringify(buttons2, null, 2));
  console.log('URL after email submit:', page.url());
  await page.screenshot({ path: 'extension builds/screenshots/login-page-step2.png', fullPage: true });

  // Click "Sign in with password"
  const pwToggle = await page.$('button:has-text("Sign in with password")');
  if (pwToggle) {
    console.log('\n=== Clicking Sign in with password ===');
    await pwToggle.click();
    await page.waitForTimeout(2000);

    const inputs3 = await page.$$eval('input', (els) =>
      els.map((el) => ({
        type: el.type,
        name: el.name,
        placeholder: el.placeholder,
        'data-testid': el.getAttribute('data-testid'),
      }))
    );
    console.log('Password step inputs:', JSON.stringify(inputs3, null, 2));

    const buttons3 = await page.$$eval('button', (els) =>
      els.map((el) => ({ text: el.innerText.trim(), 'data-testid': el.getAttribute('data-testid') }))
    );
    console.log('Password step buttons:', JSON.stringify(buttons3, null, 2));
    await page.screenshot({ path: 'extension builds/screenshots/login-page-step2b.png', fullPage: true });

    // Submit password
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      console.log('\n=== Submitting password ===');
      await pwInput.fill(env.EXTENSION_LOGIN_PASSWORD);
      await page.click('[data-testid="button-submit"]');
      await page.waitForTimeout(5000);
      console.log('URL after password submit:', page.url());

      const bodyText = await page.$eval('body', (el) => el.innerText.slice(0, 800));
      console.log('Body text snippet:\n', bodyText);

      // Look for nav / sidebar elements that indicate logged-in state
      const navItems = await page.$$eval('[data-testid], nav a, [role="navigation"] a', (els) =>
        els.slice(0, 20).map((el) => ({
          tag: el.tagName,
          text: (el as HTMLElement).innerText?.trim().slice(0, 60),
          'data-testid': el.getAttribute('data-testid'),
          href: (el as HTMLAnchorElement).href,
        }))
      );
      console.log('Nav/testid elements:', JSON.stringify(navItems, null, 2));
      await page.screenshot({ path: 'extension builds/screenshots/login-page-step3.png', fullPage: true });
    }
  }

  await page.waitForTimeout(2000);
  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
