// Purpose: Download and unpack the ZTB extension from the tenant's deployment page.
//
// URL resolution chain (all URLs are dynamic per-tenant):
//   1. Log in → navigate to EXTENSION_DEPLOYMENT_PAGE_URL
//   2. Scrape the update XML URL shown on that page
//   3. Fetch the XML → extract codebase= (the CRX download URL)
//   4. Download and unpack the CRX

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';
import { chromium } from '@playwright/test';
import { env } from '../utils/env';
import { unpackCrx } from '../utils/chrome-profile';

const CRX_PATH      = path.resolve('extension builds/extension.crx');
const VERSION_FILE  = path.resolve('extension builds/extension.version');
const UNPACKED_PATH = path.resolve('extension builds/extension-unpacked');

interface ExtensionUrls {
  xmlUrl: string;
  crxUrl: string;
  version: string;
}

/** Log in and scrape the update XML URL from the deployment page, then resolve to CRX URL. */
async function resolveExtensionUrls(): Promise<ExtensionUrls> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Step 1: log in
    await page.goto(env.SQRX_BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="input-email"]').fill(env.EXTENSION_LOGIN_EMAIL);
    await page.locator('[data-testid="button-submit"]').click();
    const hasSso = await page.getByRole('button', { name: /sign in with password/i })
      .isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasSso) await page.getByRole('button', { name: /sign in with password/i }).click();
    await page.locator('[data-testid="input-password"]').fill(env.EXTENSION_LOGIN_PASSWORD);
    await page.locator('[data-testid="button-submit"]').click();
    await page.waitForURL(/enterprise\/#\//, { timeout: 20_000 });

    // Step 2: navigate to deployment page.
    // Use a full goto — after login the SPA accepts the hash route without redirecting.
    // networkidle ensures the React component has finished fetching and rendering.
    await page.goto(env.EXTENSION_DEPLOYMENT_PAGE_URL, { waitUntil: 'networkidle' });

    // The XML URL appears as a plain text node — search via TreeWalker (not innerText)
    const xmlUrl: string = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, 0x4 /* SHOW_TEXT */);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const t = node.textContent?.trim() ?? '';
        const m = t.match(/https?:\/\/\S+update\.xml\b/);
        if (m) return m[0];
      }
      // Also check input values
      for (const el of Array.from(document.querySelectorAll('input'))) {
        if ((el as HTMLInputElement).value.includes('update.xml')) return (el as HTMLInputElement).value.trim();
      }
      return '';
    });

    if (!xmlUrl) throw new Error('Could not find update XML URL on deployment page');
    console.log(`  XML URL:      ${xmlUrl}`);

    // Step 3: fetch the XML and extract codebase= and version=
    const xmlRes = await axios.get<string>(xmlUrl, { timeout: 15_000 });
    const crxMatch = xmlRes.data.match(/codebase=['"]([^'"]+)['"]/);
    const verMatch = xmlRes.data.match(/<updatecheck[^>]+\bversion=['"]([^'"]+)['"]/);
    if (!crxMatch) throw new Error('Could not find codebase= in update XML');
    if (!verMatch) throw new Error('Could not find version= in update XML');

    return { xmlUrl, crxUrl: crxMatch[1], version: verMatch[1] };
  } finally {
    await browser.close();
  }
}

/** Read the version that is currently unpacked on disk, or '' if not present. */
function localVersion(): string {
  if (fs.existsSync(VERSION_FILE)) {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  }
  const manifest = path.join(UNPACKED_PATH, 'manifest.json');
  if (fs.existsSync(manifest)) {
    try {
      return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }).version ?? '';
    } catch { return ''; }
  }
  return '';
}

async function downloadCrx(crxUrl: string): Promise<void> {
  const res = await axios.get<ArrayBuffer>(crxUrl, {
    responseType: 'arraybuffer',
    timeout: 120_000,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from CRX URL`);

  // Validate: a real CRX starts with "Cr24"
  const buf = Buffer.from(res.data);
  if (buf.slice(0, 4).toString('utf8') !== 'Cr24') {
    throw new Error(`Invalid CRX response (got: ${buf.slice(0, 40).toString()})`);
  }

  fs.mkdirSync(path.dirname(CRX_PATH), { recursive: true });
  fs.writeFileSync(CRX_PATH, buf);

  const sizeKb = (buf.byteLength / 1024).toFixed(1);
  const hash   = crypto.createHash('sha256').update(buf).digest('hex');
  console.log(`  Downloaded: ${CRX_PATH}`);
  console.log(`  Size:       ${sizeKb} KB`);
  console.log(`  SHA-256:    ${hash}`);
}

export async function ensureExtensionUpToDate(opts: { force?: boolean } = {}): Promise<{
  action: 'downloaded' | 'skipped';
  remoteVersion: string;
  localVersion: string;
}> {
  console.log('Checking extension version...');

  let urls: ExtensionUrls;
  try {
    urls = await resolveExtensionUrls();
    console.log(`  Remote version: ${urls.version}`);
    console.log(`  CRX URL:      ${urls.crxUrl}`);
  } catch (err) {
    console.warn(`  Could not resolve extension URLs: ${String(err)}`);
    console.warn('  Proceeding with whatever is already unpacked.');
    return { action: 'skipped', remoteVersion: '(unknown)', localVersion: localVersion() };
  }

  const localVer = localVersion();
  console.log(`  Local version:  ${localVer || '(none)'}`);

  if (!opts.force && localVer === urls.version) {
    console.log(`  Already up to date (${urls.version}) — skipping download.`);
    return { action: 'skipped', remoteVersion: urls.version, localVersion: localVer };
  }

  // Don't downgrade
  if (!opts.force && localVer && localVer !== urls.version) {
    const parse = (v: string) => v.split('.').map(Number);
    const [lMaj, lMin = 0, lPatch = 0, lBuild = 0] = parse(localVer);
    const [rMaj, rMin = 0, rPatch = 0, rBuild = 0] = parse(urls.version);
    const localNewer =
      lMaj > rMaj ||
      (lMaj === rMaj && lMin > rMin) ||
      (lMaj === rMaj && lMin === rMin && lPatch > rPatch) ||
      (lMaj === rMaj && lMin === rMin && lPatch === rPatch && lBuild > rBuild);
    if (localNewer) {
      console.log(`  Local (${localVer}) is newer than remote (${urls.version}) — skipping download.`);
      return { action: 'skipped', remoteVersion: urls.version, localVersion: localVer };
    }
  }

  if (opts.force) {
    console.log('  Force-download requested.');
  } else {
    console.log(`  New version available: ${localVer || '(none)'} → ${urls.version}`);
  }

  console.log('Downloading extension...');
  await downloadCrx(urls.crxUrl);

  console.log('Unpacking extension...');
  await unpackCrx();

  fs.writeFileSync(VERSION_FILE, urls.version, 'utf8');
  console.log(`  Unpacked to:    ${UNPACKED_PATH}`);
  console.log(`  Version locked: ${urls.version}`);

  return { action: 'downloaded', remoteVersion: urls.version, localVersion: localVer };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  const force = process.argv.includes('--force');
  ensureExtensionUpToDate({ force })
    .then(({ action, remoteVersion, localVersion }) => {
      if (action === 'downloaded') {
        console.log(`\nExtension updated to ${remoteVersion}.`);
      } else {
        console.log(`\nNo update needed — running ${localVersion}.`);
      }
    })
    .catch((err: unknown) => {
      console.error(`\nFailed: ${String(err)}`);
      process.exit(1);
    });
}
