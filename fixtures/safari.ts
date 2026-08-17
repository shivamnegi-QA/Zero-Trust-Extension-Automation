import { test as base } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { launchSafariWithExtension, SdSession } from '../utils/system-safari';

dotenv.config();

// Accepts either a pre-extracted directory (SAFARI_EXTENSION_DIR) or a zip (SAFARI_EXTENSION_ZIP).
// Default: the pre-extracted safari-1.4.3 directory.
const SAFARI_EXTENSION_DIR = process.env.SAFARI_EXTENSION_DIR
  ? path.resolve(process.env.SAFARI_EXTENSION_DIR)
  : null;
const SAFARI_EXTENSION_ZIP = process.env.SAFARI_EXTENSION_ZIP
  ? path.resolve(process.env.SAFARI_EXTENSION_ZIP)
  : null;
const DEFAULT_EXTRACTED_DIR = path.resolve('extension builds/safari-1.4.3');

type SafariFixtures = {
  sfSession: SdSession;
  extensionUuid: string;
};

export { expect } from '@playwright/test';

export const test = base.extend<SafariFixtures>({
  sfSession: async ({}, use) => {
    const { session, teardown } = await launchSafariWithExtension({
      extractedDir: SAFARI_EXTENSION_DIR ?? DEFAULT_EXTRACTED_DIR,
      zipPath: SAFARI_EXTENSION_ZIP ?? undefined,
      tag: '[fixture:safari]',
    });

    await use(session);

    await session.deleteSession().catch(() => {});
    await teardown();
  },

  extensionUuid: async ({}, use) => {
    const { SAFARI_EXTENSION_UUID } = await import('../utils/system-safari');
    await use(SAFARI_EXTENSION_UUID);
  },
});
