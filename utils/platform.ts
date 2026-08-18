// Cross-platform constants for browser binaries and WebDriver executables.
// All launcher utils import from here instead of hardcoding paths.
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

export const IS_WINDOWS = process.platform === 'win32';

export const CHROME_BINARY = IS_WINDOWS
  ? (process.env.CHROME_BINARY ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  : (process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

// Default Chrome extension path — same layout on both macOS and Windows.
export const DEFAULT_CHROME_EXT_PATH = 'extension builds/chrome-1.4.3/build';

// Resolve chromedriver: env var → local npm package → system PATH
function resolveChromedriverWin(): string {
  if (process.env.CHROMEDRIVER) return process.env.CHROMEDRIVER;
  // Try the local npm-installed chromedriver (node_modules/chromedriver/...)
  // __dirname is utils/, so ../node_modules/... is always the project root.
  const candidate = path.resolve(__dirname, '..', 'node_modules', 'chromedriver', 'lib', 'chromedriver', 'chromedriver.exe');
  if (fs.existsSync(candidate)) return candidate;
  return 'chromedriver.exe';
}

function resolveChromedriverMac(): string {
  if (process.env.CHROMEDRIVER) return process.env.CHROMEDRIVER;
  return '/opt/homebrew/bin/chromedriver';
}

export const CHROMEDRIVER = IS_WINDOWS
  ? resolveChromedriverWin()
  : resolveChromedriverMac();

// Edge is Windows-only (Chromium-based — same extension build as Chrome)
export const EDGE_BINARY = process.env.EDGE_BINARY
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function resolveEdgedriverWin(): string {
  const fromEnv = process.env.EDGEDRIVER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const cached = path.resolve(__dirname, '..', 'node_modules', '.cache', 'edgedriver', 'msedgedriver.exe');
  if (fs.existsSync(cached)) return cached;
  return fromEnv ?? 'msedgedriver.exe';
}

export const EDGEDRIVER = IS_WINDOWS ? resolveEdgedriverWin() : 'msedgedriver';

export const FIREFOX_BINARY = IS_WINDOWS
  ? (process.env.FIREFOX_BINARY ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe')
  : (process.env.FIREFOX_BINARY ?? '/Applications/Firefox.app/Contents/MacOS/firefox');

function resolveGeckodriverWin(): string {
  const fromEnv = process.env.GECKODRIVER;
  // Only trust the env var if it points to an actual file (not a bare exe name like "geckodriver.exe")
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  // geckodriver npm package caches to GECKODRIVER_CACHE_DIR or os.tmpdir()
  const cacheDir = process.env.GECKODRIVER_CACHE_DIR ?? (require('os') as typeof import('os')).tmpdir();
  if (fs.existsSync(cacheDir)) {
    const hit = fs.readdirSync(cacheDir).find(f => /^geckodriver[-.]\d/.test(f) && f.endsWith('.exe'));
    if (hit) return path.join(cacheDir, hit);
  }
  return fromEnv ?? 'geckodriver.exe';
}

export const GECKODRIVER = IS_WINDOWS
  ? resolveGeckodriverWin()
  : (process.env.GECKODRIVER ?? '/opt/homebrew/bin/geckodriver');
