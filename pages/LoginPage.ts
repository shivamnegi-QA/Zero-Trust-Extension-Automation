import { Page, Locator } from '@playwright/test';

export class LoginPage {
  private readonly emailInput: Locator;
  private readonly submitButton: Locator;
  private readonly passwordInput: Locator;
  private readonly signInWithPasswordButton: Locator;
  private readonly errorMessage: Locator;

  constructor(private readonly page: Page) {
    this.emailInput          = page.getByTestId('input-email');
    this.submitButton        = page.getByTestId('button-submit');
    this.passwordInput       = page.getByTestId('input-password');
    this.signInWithPasswordButton = page.getByRole('button', { name: /sign in with password/i });
    this.errorMessage        = page.locator('[data-testid="error-message"], [role="alert"], .text-destructive').first();
  }

  async goto(baseUrl: string): Promise<void> {
    await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    console.log(`  Navigated to ${baseUrl}`);
  }

  async login(email: string, password: string): Promise<void> {
    // Step 1: email
    await this.emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await this.emailInput.fill(email);
    console.log(`  Filled email input with "${email}"`);
    await this.submitButton.click();
    console.log('  Clicked submit button');

    // Step 2: SSO list — optional, absent on tenants that go straight to password
    const hasSso = await this.signInWithPasswordButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasSso) {
      await this.signInWithPasswordButton.click();
      console.log('  Clicked "Sign in with password"');
    }

    // Step 3: password — clear first in case autofill pre-populated it
    await this.passwordInput.waitFor({ state: 'visible', timeout: 10_000 });
    await this.passwordInput.clear();
    await this.passwordInput.fill(password);
    console.log(`  Filled password input (${password.length} characters)`);
    await this.submitButton.click();
    console.log('  Clicked submit button');
  }

  async waitForLoginSuccess(): Promise<void> {
    await this.page.waitForURL(/\/enterprise\/#\//, { timeout: 20_000 });
    console.log(`  Login redirect completed — now at ${this.page.url()}`);
  }

  async isLoginErrorVisible(): Promise<boolean> {
    return this.errorMessage.isVisible().catch(() => false);
  }

  async getErrorText(): Promise<string> {
    try {
      await this.errorMessage.waitFor({ state: 'visible', timeout: 3_000 });
      return (await this.errorMessage.innerText()).trim();
    } catch {
      return '';
    }
  }
}
