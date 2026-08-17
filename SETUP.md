# ZT Extension Policy Regression — Setup Guide

Cross-platform Playwright test suite for the Zero Trust Browser (ZTB) extension.
Automates extension load, popup interaction, and dashboard login across Chrome, Firefox, and Safari (macOS) / Chrome, Edge, and Firefox (Windows).

---

## Repository layout

```
fixtures/
  extension.ts        # Unified worker-scoped fixture — PopupSession interface
  base.ts             # Chrome CDP fixture (used by 02-dashboard-login.spec.ts)
  firefox.ts          # Firefox geckodriver fixture
  safari.ts           # Safari safaridriver fixture

tests/
  extension-load-and-login.spec.ts   # Main spec — runs on all 3 browser projects
  02-dashboard-login.spec.ts         # Chrome-only dashboard login spec
  helpers/
    webdriver-login.ts               # Shared login helpers + isConnectedState()

utils/
  system-chrome.ts    # ChromeDriver + NSOpenPanel automation (macOS)
  system-firefox.ts   # geckodriver + GdSession WebDriver client
  system-safari.ts    # safaridriver + SdSession + AX popup automation (macOS)

playwright.config.ts  # Defines system-chrome / system-firefox / system-safari projects
```

---

## macOS prerequisites

### 1. Node.js
```bash
node -v   # 20+ required
```

### 2. System browsers
- Google Chrome: `/Applications/Google Chrome.app`
- Firefox: `/Applications/Firefox.app`
- Safari: built-in

### 3. Browser drivers
```bash
brew install chromedriver     # Must match installed Chrome major version
brew install geckodriver       # Firefox WebDriver
# Safari: safaridriver is bundled with macOS — enable once:
safaridriver --enable
```

### 4. Accessibility permission
The Chrome extension loader uses AppleScript + Swift AX to automate the NSOpenPanel file picker.

Go to **System Settings → Privacy & Security → Accessibility** and add the app running the tests (Terminal.app, VS Code.app, or iTerm.app).

### 5. Screen Recording permission (for video traces)
Go to **System Settings → Privacy & Security → Screen Recording** and add the same app.

### 6. Install dependencies
```bash
npm install
```

### 7. Environment variables
Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `EXTENSION_LOGIN_EMAIL` | Dashboard login email |
| `EXTENSION_LOGIN_PASSWORD` | Dashboard login password |
| `SQRX_BASE_URL` | Tenant URL, e.g. `https://automation.in.onsquarex.com/` |
| `EXTENSION_PATH` | Path to unpacked Chrome extension (relative to project root) |
| `FIREFOX_EXTENSION_PATH` | Path to unpacked Firefox extension build |
| `EXTENSION_DEPLOYMENT_PAGE_URL` | GPO deployment settings page URL (for auto-download) |

### 8. Extension builds
Place unpacked extension files at the paths set in `.env`:
```
extension builds/
  current/             # Chrome unpacked (EXTENSION_PATH)
  firefox-1.4.3/build/ # Firefox unpacked (FIREFOX_EXTENSION_PATH)
  safari-1.4.3/        # Safari app bundle dir (SAFARI_EXTENSION_DIR)
```

Or use the download script to fetch from the deployment page:
```bash
npm run download-extension
```

---

## Running tests on macOS

```bash
# All browsers
npx playwright test --project=system-chrome --project=system-firefox --project=system-safari

# Single browser
npx playwright test --project=system-chrome
npx playwright test --project=system-firefox
npx playwright test --project=system-safari

# Open the test UI dashboard
npm run ui
# then open http://localhost:3000 in a browser
```

---

## Windows setup

Windows requires different browser drivers and paths. The Safari project does not run on Windows.

### 1. Prerequisites
- Node.js 20+ (download from nodejs.org)
- Git for Windows (includes bash — used for npm scripts)
- PowerShell 7+ or Windows Terminal recommended

### 2. Install browsers
- **Chrome**: standard installer from google.com/chrome
- **Edge**: pre-installed on Windows 10/11
- **Firefox**: standard installer from mozilla.org

### 3. Install WebDriver binaries

**ChromeDriver** (must match installed Chrome version):
```powershell
# Option A — via npm (auto-matched)
npm install -g chromedriver

# Option B — manual download from https://chromedriver.chromium.org
# Place chromedriver.exe somewhere on PATH
```

**EdgeDriver** (msedgedriver):
```powershell
# Download from https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/
# Match the exact Edge version: edge://settings/help
# Place msedgedriver.exe on PATH
```

**geckodriver** (Firefox):
```powershell
# Download from https://github.com/mozilla/geckodriver/releases
# Place geckodriver.exe on PATH
winget install Mozilla.Geckodriver   # or via winget
```

### 4. Windows-specific environment variables
Add to `.env` (in addition to the common ones above):

```env
# Windows browser binary paths (if not on PATH)
CHROME_BINARY=C:\Program Files\Google\Chrome\Application\chrome.exe
EDGE_BINARY=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
FIREFOX_BINARY=C:\Program Files\Mozilla Firefox\firefox.exe

CHROMEDRIVER=chromedriver.exe
EDGEDRIVER=msedgedriver.exe
GECKODRIVER=geckodriver.exe
```

### 5. Windows Chrome extension loading
On macOS the extension is loaded via NSOpenPanel (AX automation).
On Windows, Chrome supports `--load-extension` only in **Chromium** builds — official Chrome blocks it.

**Recommended approach for Windows:** use ChromeDriver's capability to pass the extension as a base64-encoded CRX, or use the `--load-extension` flag with a **system Chrome** launched via a custom policy:

```json
// Place at: C:\Windows\System32\GroupPolicy\Machine\Registry.pol
// OR add via registry:
// HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
// Value: "1" = "<extension-id>;<update-url>"
```

Alternatively, load via ChromeDriver `addExtensions` capability (packed .crx):
```typescript
// In the Chrome fixture for Windows, pass the packed extension:
'goog:chromeOptions': {
  extensions: [fs.readFileSync('extension builds/extension.crx').toString('base64')]
}
```

### 6. Adding Windows projects to playwright.config.ts

Add these projects to the `projects` array:

```typescript
{
  name: 'windows-chrome',
  testMatch: ['**/extension-load-and-login.spec.ts', '**/02-dashboard-login.spec.ts'],
},
{
  name: 'windows-edge',
  testMatch: ['**/extension-load-and-login.spec.ts'],
},
{
  name: 'windows-firefox',
  testMatch: ['**/extension-load-and-login.spec.ts'],
},
```

### 7. Adding Windows fixtures to fixtures/extension.ts

The `extSession` fixture branches on `testInfo.project.name`. Add new branches:

```typescript
} else if (project === 'windows-chrome') {
  // Launch Chrome via ChromeDriver with --load-extension or packed CRX
  // Mirror the system-chrome branch but:
  //   - Use Windows binary paths from env
  //   - Replace fillNativeFilePicker with CRX/policy-based loading
  //   - No Swift AX helper needed

} else if (project === 'windows-edge') {
  // Same as windows-chrome but use msedgedriver + Edge binary
  // Edge is Chromium-based: same CDP connection approach works

} else if (project === 'windows-firefox') {
  // Same as system-firefox — geckodriver approach is cross-platform
  // Only change: binary path from env var
```

### 8. Cross-platform binary path handling

The current `system-chrome.ts` hardcodes macOS paths. For Windows, create a `utils/system-windows-chrome.ts` (or add platform branching):

```typescript
// utils/platform.ts
export const CHROME_BINARY = process.platform === 'win32'
  ? (process.env.CHROME_BINARY ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const CHROMEDRIVER = process.platform === 'win32'
  ? (process.env.CHROMEDRIVER ?? 'chromedriver.exe')
  : '/opt/homebrew/bin/chromedriver';

export const FIREFOX_BINARY = process.platform === 'win32'
  ? (process.env.FIREFOX_BINARY ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe')
  : '/Applications/Firefox.app/Contents/MacOS/firefox';

export const GECKODRIVER = process.platform === 'win32'
  ? (process.env.GECKODRIVER ?? 'geckodriver.exe')
  : '/opt/homebrew/bin/geckodriver';
```

### 9. Windows notes on extension loading

| Browser | Windows loading method |
|---|---|
| Chrome | Packed CRX via ChromeDriver `extensions` capability, or enterprise policy |
| Edge | Same as Chrome (Chromium-based) — use `ms:edgeOptions` instead of `goog:chromeOptions` |
| Firefox | `moz/addon/install` via geckodriver — identical to macOS, no changes needed |

Edge-specific ChromeDriver capability:
```typescript
'ms:edgeOptions': {
  binary: EDGE_BINARY,
  args: ['--user-data-dir=...', '--remote-debugging-port=0'],
  extensions: [base64EncodedCrx],
}
```

---

## Shared test architecture

The test suite uses **worker-scoped fixtures** — each browser project launches its browser **once** for the entire test suite, then runs all tests in that single session. A `beforeEach` hook calls `clearAuth()` to reset cookies before every test.

```
Worker starts → browser launches once
  beforeEach → clearAuth() clears cookies/storage
  test 1: Extension loads
  beforeEach → clearAuth()
  test 2: Extension popup opens
  beforeEach → clearAuth()
  test 3: Unauthenticated state
  beforeEach → clearAuth()
  test 4: Connected state after login
Worker teardown → browser closed
```

The `PopupSession` interface abstracts all browser differences:

| Method | Chrome | Firefox | Safari |
|---|---|---|---|
| `openPopup()` | CDP chrome-extension:// page | geckodriver → moz-extension:// tab | osascript AX click |
| `closePopup()` | close Playwright page | geckodriver close window | osascript Escape key |
| `navigate(url)` | Playwright page.goto | geckodriver /url | safaridriver /url |
| `sendKeys(id, text)` | Playwright locator.fill | WebDriver /element/value | WebDriver /element/value |
| `clearAuth()` | clearCookies + chrome.storage | deleteAllCookies | deleteAllCookies |

---

## Gitignore additions before pushing

Add to `.gitignore`:
```
.env
.ca-bundle.pem
extension builds/
node_modules/
dist/
reports/
test-results/
*.png
```

The `.env` and `extension builds/` directories contain credentials and binary artifacts — never commit them.

---

## Quick start checklist (Windows)

- [ ] Node.js 20+ installed
- [ ] Chrome, Edge, Firefox installed
- [ ] chromedriver, msedgedriver, geckodriver on PATH and version-matched
- [ ] `npm install` run in project root
- [ ] `.env` created from `.env.example` with correct credentials and paths
- [ ] Extension CRX or unpacked build available at `EXTENSION_PATH`
- [ ] Windows projects added to `playwright.config.ts`
- [ ] Windows fixture branches added to `fixtures/extension.ts`
- [ ] Platform path constants added to `utils/system-chrome.ts` and `utils/system-firefox.ts`
