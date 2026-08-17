import * as fs from 'fs';
import * as path from 'path';
import * as unzipper from 'unzipper';

const CRX_PATH = path.resolve('extension builds/extension.crx');
const UNPACKED_PATH = path.resolve('extension builds/extension-unpacked');
const PROFILE_PATH = path.resolve('extension builds/ztb-test-profile');

export function getUnpackedPath(): string {
  return UNPACKED_PATH;
}

export function getProfilePath(): string {
  return PROFILE_PATH;
}

export async function unpackCrx(): Promise<void> {
  if (!fs.existsSync(CRX_PATH)) {
    throw new Error(`CRX not found at ${CRX_PATH} — run npm run download-extension first`);
  }

  // Archive the current unpacked folder under its version before replacing it
  if (fs.existsSync(UNPACKED_PATH)) {
    const manifestPath = path.join(UNPACKED_PATH, 'manifest.json');
    let oldVersion = '';
    if (fs.existsSync(manifestPath)) {
      try {
        oldVersion = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: string }).version ?? '';
      } catch { /* ignore */ }
    }
    // Fall back to the version file if manifest isn't readable
    const versionFile = path.resolve('extension builds/extension.version');
    if (!oldVersion && fs.existsSync(versionFile)) {
      oldVersion = fs.readFileSync(versionFile, 'utf8').trim();
    }

    const archiveDest = oldVersion
      ? path.resolve(`extension builds/extension-unpacked-${oldVersion}`)
      : path.resolve(`extension builds/extension-unpacked-prev`);

    // Remove any stale archive for this version before moving
    if (fs.existsSync(archiveDest)) fs.rmSync(archiveDest, { recursive: true });
    fs.renameSync(UNPACKED_PATH, archiveDest);
    console.log(`  Archived previous extension (${oldVersion || 'unknown'}) to: ${path.basename(archiveDest)}`);
  }
  fs.mkdirSync(UNPACKED_PATH, { recursive: true });

  const raw = fs.readFileSync(CRX_PATH);

  // CRX3 header: magic (4) + version (4) + header_size (4) = 12 bytes minimum
  // Skip the header to reach the zip payload
  let zipOffset = 0;
  const magic = raw.toString('utf8', 0, 4);

  if (magic === 'Cr24') {
    const version = raw.readUInt32LE(4);
    if (version === 2) {
      // CRX2: magic(4) + version(4) + pubkey_len(4) + sig_len(4) + pubkey + sig
      const pubkeyLen = raw.readUInt32LE(8);
      const sigLen = raw.readUInt32LE(12);
      zipOffset = 16 + pubkeyLen + sigLen;
    } else if (version === 3) {
      // CRX3: magic(4) + version(4) + header_size(4) + header_bytes
      const headerSize = raw.readUInt32LE(8);
      zipOffset = 12 + headerSize;
    } else {
      throw new Error(`Unknown CRX version: ${version}`);
    }
  }
  // If not Cr24 magic, treat entire file as zip (already unpacked or plain zip)

  const zipBuffer = raw.slice(zipOffset);

  await new Promise<void>((resolve, reject) => {
    const stream = require('stream');
    const readable = new stream.PassThrough();
    readable.end(zipBuffer);
    readable
      .pipe(unzipper.Extract({ path: UNPACKED_PATH }))
      .on('close', resolve)
      .on('error', reject);
  });

  console.log(`Unpacked extension to: ${UNPACKED_PATH}`);
}

export function ensureProfileDir(): void {
  fs.mkdirSync(PROFILE_PATH, { recursive: true });
  fs.mkdirSync(path.resolve('extension builds/screenshots'), { recursive: true });
}
