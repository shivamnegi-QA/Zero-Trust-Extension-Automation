import { Page, Locator } from '@playwright/test';

export class DashboardPage {
  private readonly navLink: Locator;

  constructor(private readonly page: Page) {
    // Nav links in the SPA use hash routes — any nav anchor confirms the authenticated shell
    this.navLink = page.locator('a[href="#/"], nav a, [role="navigation"] a').first();
  }

  /** True when the post-login enterprise dashboard is loaded */
  async isLoaded(): Promise<boolean> {
    return /\/enterprise\/#\//.test(this.page.url());
  }

  /** Wait until the dashboard shell is fully visible */
  async waitForReady(timeout = 20_000): Promise<void> {
    await this.page.waitForURL(/\/enterprise\/#\//, { timeout });
    await this.navLink.waitFor({ state: 'visible', timeout });
  }

  /** Returns true if the sidebar navigation is present (confirms authenticated shell) */
  async hasSidebarNav(): Promise<boolean> {
    return this.navLink.isVisible().catch(() => false);
  }

  /** Logged-in user indicator — avatar, email, or username shown in nav */
  async getLoggedInUser(): Promise<string> {
    const candidates = [
      this.page.getByTestId('user-menu'),
      this.page.getByTestId('user-avatar'),
      this.page.getByRole('button', { name: /user menu/i }),
      this.page.locator('button').filter({ hasText: '@' }).first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        return (await locator.innerText()).trim();
      }
    }
    return '';
  }

  url(): string {
    return this.page.url();
  }
}
