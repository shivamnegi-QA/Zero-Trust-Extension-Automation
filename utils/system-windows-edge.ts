// Windows Edge launcher — thin wrapper over the Windows Chrome launcher.
// Edge is Chromium-based so the Load Unpacked UI flow and Windows file-picker
// automation are identical to Chrome; only the binary, driver, and caps key differ.

import { EDGE_BINARY, EDGEDRIVER } from './platform';
import {
  launchWindowsBrowserWithExtension,
  WinLaunchOptions,
  WinLaunchResult,
} from './system-windows-chrome';
import { extensionIdFromManifestKey } from './shared';
export { extensionIdFromManifestKey };
export type { WinLaunchResult };

export async function launchWindowsEdgeWithExtension(
  opts: Omit<WinLaunchOptions, 'binary' | 'driverBin' | 'capsKey'> & {
    binary?: string;
    driverBin?: string;
  }
): Promise<WinLaunchResult> {
  return launchWindowsBrowserWithExtension({
    ...opts,
    binary:    opts.binary    ?? EDGE_BINARY,
    driverBin: opts.driverBin ?? EDGEDRIVER,
    capsKey:   'ms:edgeOptions',
  });
}
