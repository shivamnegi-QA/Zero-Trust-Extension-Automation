import { test, expect } from '@playwright/test';
import * as path from 'path';
import {
  launchExtensionApp,
  forceQuitExtensionApp,
  clickOpenSafariPreferences,
  verifyExtensionInSettings,
  closeExtensionSettings,
  openExtensionPopup,
  closeExtensionPopup,
  screenshotSafariWindow,
} from '../utils/system-safari';

const SAFARI_APP_PATH = process.env.SAFARI_EXTENSION_APP_PATH
  ? path.resolve(process.env.SAFARI_EXTENSION_APP_PATH)
  : path.resolve('extension builds/safari-1.4.3/Debug/Zero Trust Browser Extension.app');

test.describe.serial('Safari Extension Load', () => {

  test.afterAll(async () => {
    forceQuitExtensionApp();
  });

  // @desc Launches the extension's container app, clicks through to Safari Extensions settings, and verifies it registered.
  // @validates extension row is present in Safari Extensions settings and its checkbox is checked
  test('Extension loads', async () => {
    await launchExtensionApp(SAFARI_APP_PATH);
    await clickOpenSafariPreferences();

    const { found, enabled } = await verifyExtensionInSettings();
    expect(found, 'Extension should appear in Safari Extensions settings — check the build and quarantine flag').toBeTruthy();
    expect(enabled, 'Extension should be enabled in Safari Extensions settings').toBeTruthy();

    console.log(`  [safari] Extension registered: found=${found} enabled=${enabled}`);
    await closeExtensionSettings();
  });

  // @desc Opens the extension popup from Safari's toolbar and verifies it renders visible content.
  // Continues from the loaded-and-enabled state left by the previous test.
  // @validates popover text preview length is greater than 0
  test('Extension popup opens', async () => {
    const preview = await openExtensionPopup();
    expect(preview.trim().length, 'Popup preview should not be empty').toBeGreaterThan(0);
    console.log(`  [safari] Popup preview: ${preview.trim().slice(0, 120)}`);

    screenshotSafariWindow('extension builds/screenshots/safari-test-popup.png');
    await closeExtensionPopup();
  });

});
