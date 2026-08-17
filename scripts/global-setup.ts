import '../utils/env';
import * as path from 'path';
import * as fs from 'fs';
import * as unzipper from 'unzipper';

const ROOT = path.resolve(__dirname, '..');

// Extract a ZIP archive to a destination directory.
// If the ZIP contains a single top-level folder, extract its contents directly
// into destDir so manifest.json ends up at destDir/manifest.json.
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  return new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', (entry: unzipper.Entry) => {
        const fullPath = entry.path;
        const type     = entry.type;

        // Strip a leading single-directory prefix if present
        // e.g. "chrome-1.4.3/manifest.json" → "manifest.json"
        const parts = fullPath.split('/');
        const strippedPath = parts.length > 1 && parts[0].match(/^[\w.-]+$/)
          ? parts.slice(1).join('/')
          : fullPath;

        if (!strippedPath) { entry.autodrain(); return; }

        const target = path.join(destDir, strippedPath);

        // Prevent path traversal
        if (!target.startsWith(destDir + path.sep) && target !== destDir) {
          entry.autodrain();
          return;
        }

        if (type === 'Directory') {
          fs.mkdirSync(target, { recursive: true });
          entry.autodrain();
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          entry.pipe(fs.createWriteStream(target));
        }
      })
      .on('finish', resolve)
      .on('error', reject);
  });
}

async function ensureExtractedBuild(zipName: string, destName: string): Promise<void> {
  const zipPath  = path.join(ROOT, 'builds', zipName);
  const destPath = path.join(ROOT, 'extension builds', destName);

  if (!fs.existsSync(zipPath)) {
    console.log(`[global-setup] ZIP not found, skipping extraction: ${zipPath}`);
    return;
  }

  // Skip if already extracted and contains a manifest
  if (
    fs.existsSync(destPath) &&
    fs.existsSync(path.join(destPath, 'manifest.json'))
  ) {
    console.log(`[global-setup] Already extracted: ${destPath}`);
    return;
  }

  console.log(`[global-setup] Extracting ${zipName} → ${destPath}`);
  await extractZip(zipPath, destPath);
  console.log(`[global-setup] Extracted OK: ${destPath}`);
}

async function ensureGeckodriver(): Promise<void> {
  if (process.platform !== 'win32') return;
  // Download geckodriver binary via npm package if not already cached.
  // The package caches it in GECKODRIVER_CACHE_DIR or os.tmpdir().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { download } = require('geckodriver') as { download: (ver?: string, cacheDir?: string) => Promise<string> };
  const gdPath = await download().catch((e: Error) => {
    console.warn(`[global-setup] geckodriver download failed (Edge/Firefox tests may skip): ${e.message}`);
    return null;
  });
  if (gdPath) console.log(`[global-setup] geckodriver: ${gdPath}`);
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(path.join(ROOT, 'extension builds', 'screenshots'), { recursive: true });

  // Extract packed ZIP builds to extension builds/ if not already done
  await ensureExtractedBuild('chrome-1.4.3.zip',  'chrome-1.4.3');
  await ensureExtractedBuild('firefox-1.4.3.zip', 'firefox-1.4.3');

  // Ensure geckodriver is downloaded for windows-firefox
  await ensureGeckodriver();

  console.log('[global-setup] Ready.');
}
