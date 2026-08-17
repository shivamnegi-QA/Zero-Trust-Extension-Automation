import { test as base } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { launchFirefoxWithExtension, GdSession } from '../utils/system-firefox';

dotenv.config();

const FIREFOX_EXTENSION_PATH = process.env.FIREFOX_EXTENSION_PATH
  ? path.resolve(process.env.FIREFOX_EXTENSION_PATH)
  : path.resolve('extension builds/firefox-1.4.3/build');

type FirefoxFixtures = {
  ffSession: GdSession;
  extensionId: string;
};

export { expect } from '@playwright/test';

export const test = base.extend<FirefoxFixtures>({
  ffSession: async ({}, use) => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-ff-test-'));

    const { session, teardown } = await launchFirefoxWithExtension({
      extensionPath: FIREFOX_EXTENSION_PATH,
      profilePath: tmpProfile,
      tag: '[fixture:firefox]',
    });

    await use(session);

    await session.deleteSession().catch(() => {});
    await teardown();

    const { rmSync } = await import('fs');
    rmSync(tmpProfile, { recursive: true, force: true });
  },

  extensionId: async ({}, use) => {
    try {
      const { readFileSync } = await import('fs');
      const manifest = JSON.parse(
        readFileSync(path.join(FIREFOX_EXTENSION_PATH, 'manifest.json'), 'utf8')
      );
      const id = manifest?.browser_specific_settings?.gecko?.id
        ?? manifest?.applications?.gecko?.id
        ?? '';
      await use(id);
    } catch {
      await use('');
    }
  },
});

/**
 * Open the ZTB extension popup in Firefox.
 * Returns a handle + popup URL (geckodriver window handle).
 */
export async function openFirefoxExtensionPopup(
  session: GdSession
): Promise<{ handle: string; popupUrl: string }> {
  return session.openExtensionPopup();
}

/** Clear cookies so a test starts in an unauthenticated state. */
export async function clearFirefoxSession(
  session: GdSession,
  origin: string
): Promise<void> {
  await session.deleteAllCookies();
  // Clear localStorage by navigating to the origin and running JS
  await session.navigate(origin).catch(() => {});
  await session.execute<void>(
    'try { localStorage.clear(); } catch(e) {} try { sessionStorage.clear(); } catch(e) {}'
  ).catch(() => {});
}
