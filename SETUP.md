# ZT Extension Policy Regression — Setup Guide

Cross-platform Playwright test suite for the Zero Trust Browser (ZTB) extension.
Runs on **macOS** (Chrome, Firefox, Safari) and **Windows** (Chrome, Edge, Firefox).

`playwright.config.ts` automatically includes only the projects for the current OS — no manual changes needed when switching between machines.

---

## Repository layout

```
fixtures/
  base.ts             # Worker-scoped CDP fixture for 02-dashboard-login.spec.ts
  extension.ts        # Unified worker-scoped fixture (PopupSession) for all 6 browser projects
  firefox.ts          # Firefox popup helper used by extension.ts

tests/
  extension-load-and-login.spec.ts   # Extension load + popup + login — runs on all browser projects
  02-dashboard-login.spec.ts         # Dashboard login flow — runs on Chrome projects only
  helpers/
    webdriver-login.ts               # Shared login helper (webdriverLogin, isConnectedState)

utils/
  system-chrome.ts          # macOS only: ChromeDriver + Swift AX + AppleScript NSOpenPanel
  system-safari.ts          # macOS only: safaridriver + osascript AX popup automation
  system-firefox.ts         # Cross-platform: geckodriver + GdSession (handles both macOS and Windows)
  system-windows-chrome.ts  # Windows only: ChromeDriver/MSEdgeDriver + PowerShell file-picker
  system-windows-edge.ts    # Windows only: MSEdgeDriver wrapper (delegates to windows-chrome)
  platform.ts               # OS-aware binary paths (auto-detects platform, reads .env overrides)
  shared.ts                 # WdClient HTTP wrapper, sleep, getFreePort, extensionIdFromManifestKey

playwright.config.ts  # Defines all 6 projects; macOS projects excluded on Windows, vice versa
```

### Projects per OS

| Project | OS | Browser | Spec files |
|---|---|---|---|
| `system-chrome` | macOS | Chrome via ChromeDriver + NSOpenPanel AX | both |
| `system-firefox` | macOS | Firefox via geckodriver | extension-load-and-login |
| `system-safari` | macOS | Safari via safaridriver + osascript AX | extension-load-and-login |
| `windows-chrome` | Windows | Chrome via ChromeDriver + PowerShell | both |
| `windows-edge` | Windows | Edge via MSEdgeDriver + PowerShell | extension-load-and-login |
| `windows-firefox` | Windows | Firefox via geckodriver | extension-load-and-login |

---

## Making changes — where things live

This is the most important section for cross-platform development. All macOS and Windows code lives in the **same repo** — you edit here on Mac and the Windows changes stay in the Windows-only files.

### Test logic (assertions, page flows)
Edit files in `tests/` and `tests/helpers/`. These are fully cross-platform — no platform conditionals.

```
tests/extension-load-and-login.spec.ts   ← edit for all browsers
tests/02-dashboard-login.spec.ts         ← edit for Chrome dashboard tests
tests/helpers/webdriver-login.ts         ← edit shared login logic
```

### Popup interaction changes (what the fixture exposes to tests)
Edit `fixtures/extension.ts`. It has separate branches per project name. Changing the `PopupSession` interface or behavior means updating the relevant branch:

| If you're changing... | Update this branch in extension.ts |
|---|---|
| Chrome popup (macOS) | `system-chrome` branch |
| Chrome popup (Windows) | `windows-chrome` and `windows-edge` branches |
| Firefox popup | `system-firefox` / `windows-firefox` branches (shared helper in `fixtures/firefox.ts`) |
| Safari popup | `system-safari` branch |

### Chrome extension loading (macOS)
Edit `utils/system-chrome.ts`.

- Entry point: `launchSystemChromeWithExtension(opts)`
- File picker: Swift AX helper compiled to `/tmp/open-goto-folder` + osascript `System Events`
- Chrome PID: read from ChromeDriver session capabilities (`sessionInfo.value.processId`), with `pgrep -n` as fallback
- **Kill order (macOS): Chrome PID first (SIGTERM), then ChromeDriver (SIGTERM)**
  - On macOS, ChromeDriver and Chrome are separate processes with no parent–child relationship for SIGTERM propagation. Killing ChromeDriver alone leaves Chrome running.
- Returns `{ cdpEndpoint, extensionId, teardown }` — must stay in sync with Windows equivalent

### Chrome extension loading (Windows)
Edit `utils/system-windows-chrome.ts`.

- Entry point: `launchWindowsBrowserWithExtension(opts)` — also handles Edge via `capsKey`
- File picker: PowerShell inline C# (`WM_SETTEXT` + `BM_CLICK` on `#32770` dialog)
- Browser PID: `Get-NetTCPConnection -LocalPort <debugPort>` (OS TCP lookup — ChromeDriver doesn't expose PID)
- **Kill order (Windows): ChromeDriver `/F /T` first (kills full process tree), then browser PID backup**
  - On Windows, ChromeDriver is the parent of Chrome. `taskkill /T` on ChromeDriver terminates Chrome and all its sub-processes atomically. Killing Chrome first would orphan renderers/GPU before the tree-kill.
- Returns `{ cdpEndpoint, extensionId, teardown }` — must stay in sync with macOS equivalent

### Firefox extension loading (both platforms)
Edit `utils/system-firefox.ts`. It handles both macOS and Windows via `IS_WINDOWS`.

- Extension loading: `POST /session/{id}/moz/addon/install` — no file picker needed on either platform
- Kill on macOS: `process.kill(pid, 'SIGTERM')`
- Kill on Windows: `taskkill /F /T`

### Safari extension loading (macOS only)
Edit `utils/system-safari.ts`.

- Installs via `.app` bundle (`open -W appPath`)
- Enables extension via Safari Preferences > Extensions (osascript AX)
- Enables Remote Automation via Safari Develop menu (osascript AX)
- Popup interaction is entirely via osascript (`openAndReadSafariPopup`, `clickInSafariPopup`, etc.) — no CDP or Playwright

### Dashboard test fixture (Chrome-only base fixture)
Edit `fixtures/base.ts`.

- Has an inline `if (IS_WINDOWS)` branch — update BOTH branches if changing how the browser context is managed
- Worker-scoped: one browser session per project, shared across all serial tests

### Platform binary paths
Edit `utils/platform.ts` only if adding a new binary or changing auto-detection logic. For per-machine overrides, use `.env` instead.

---

## macOS setup

### 1. Node.js 20+
```bash
node -v   # must be 20 or higher
```

### 2. System browsers
- **Google Chrome**: `/Applications/Google Chrome.app`
- **Firefox**: `/Applications/Firefox.app`
- **Safari**: built-in (no install needed)

### 3. Browser drivers
```bash
brew install chromedriver     # must match installed Chrome major version
brew install geckodriver       # Firefox WebDriver
safaridriver --enable          # enable Safari WebDriver (one-time, requires sudo)
```

Verify Chrome + ChromeDriver versions match:
```bash
chromedriver --version
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version
```

### 4. Accessibility permission (required for Chrome and Safari)
Both `system-chrome` and `system-safari` use osascript + the AX API to automate native UI (NSOpenPanel, toolbar buttons, popup text). This requires Accessibility access.

**System Settings → Privacy & Security → Accessibility** → add the app you run tests from:
- `Terminal.app`
- `Visual Studio Code.app` (for IDE runs)
- `iTerm.app`
- Or the shell binary directly (e.g. `/bin/zsh`)

Without this, Chrome extension loading and Safari popup interaction will fail or hang.

### 5. Install dependencies
```bash
cd Zero-Trust-Extension-Automation
npm install
```

### 6. Environment variables
```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `EXTENSION_LOGIN_EMAIL` | Dashboard login email |
| `EXTENSION_LOGIN_PASSWORD` | Dashboard login password |
| `SQRX_BASE_URL` | Tenant base URL, e.g. `https://automation.in.onsquarex.com/` |
| `EXTENSION_PATH` | Path to unpacked Chrome extension (relative to project root) |
| `FIREFOX_EXTENSION_PATH` | Path to unpacked Firefox extension build |
| `SAFARI_EXTENSION_DIR` | Path to extracted Safari extension bundle directory |

macOS binary paths (only needed if not at the default locations):
```env
# Optional — defaults work for standard Homebrew + Applications installs
CHROME_BINARY=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
CHROMEDRIVER=/opt/homebrew/bin/chromedriver
FIREFOX_BINARY=/Applications/Firefox.app/Contents/MacOS/firefox
GECKODRIVER=/opt/homebrew/bin/geckodriver
```

### 7. Extension builds
Default layout expected by the fixtures:

```
extension builds/
  extension-unpacked/       # Chrome + Edge unpacked (EXTENSION_PATH default on macOS)
    manifest.json
    ...
  firefox-1.4.3/
    build/                  # Firefox unpacked (FIREFOX_EXTENSION_PATH default on macOS)
      manifest.json
      ...
  safari-1.4.3/             # Safari: must contain Debug/Zero Trust Browser Extension.app
    Debug/
      Zero Trust Browser Extension.app
  screenshots/              # Created automatically; test screenshots saved here
```

Or use the download script:
```bash
npm run download-extension
```

### 8. Run tests on macOS
```bash
# All macOS projects (auto-detected by playwright.config.ts)
npx playwright test

# Single project
npx playwright test --project=system-chrome
npx playwright test --project=system-firefox
npx playwright test --project=system-safari

# Single spec
npx playwright test tests/extension-load-and-login.spec.ts --project=system-chrome
npx playwright test tests/02-dashboard-login.spec.ts --project=system-chrome

# HTML report
npx playwright show-report reports/html
```

---

## Windows setup

### 1. Prerequisites
- Node.js 20+ from nodejs.org
- Git for Windows (includes bash shell used by npm scripts)

### 2. Browsers
- **Chrome**: standard installer
- **Edge**: pre-installed on Windows 10/11
- **Firefox**: standard installer

### 3. Browser drivers
All three drivers must match the installed browser versions.

**ChromeDriver** (must match Chrome major version):
```powershell
# Check Chrome: Help > About in Chrome
# Download matching ChromeDriver: https://chromedriver.chromium.org/downloads
# Place chromedriver.exe on PATH or set CHROMEDRIVER in .env
```

**MSEdgeDriver**:
```powershell
# Check Edge version: edge://settings/help
# Download: https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/
# Place msedgedriver.exe on PATH or set EDGEDRIVER in .env
```

**geckodriver** (Firefox):
```powershell
# global-setup.ts downloads geckodriver automatically via npm package
# Or install manually: winget install Mozilla.Geckodriver
```

### 4. Environment variables
Same common variables as macOS, plus Windows binary paths:
```env
CHROME_BINARY=C:\Program Files\Google\Chrome\Application\chrome.exe
EDGE_BINARY=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
FIREFOX_BINARY=C:\Program Files\Mozilla Firefox\firefox.exe
CHROMEDRIVER=chromedriver.exe
EDGEDRIVER=msedgedriver.exe
GECKODRIVER=geckodriver.exe
```

### 5. Extension builds
Chrome and Edge use `chrome-1.4.3/build` on Windows:

```
extension builds/
  chrome-1.4.3/
    build/                  # Chrome + Edge unpacked (EXTENSION_PATH default on Windows)
      manifest.json
      ...
  firefox-1.4.3/            # Firefox unpacked (FIREFOX_EXTENSION_PATH default on Windows)
    manifest.json
    ...
  screenshots/
```

ZIP files in `builds/` are auto-extracted by `global-setup.ts` on each run.

### 6. Windows extension loading
Chrome/Edge load the extension through the Extensions developer UI:
1. ChromeDriver/MSEdgeDriver navigates to `chrome://extensions/` or `edge://extensions/`
2. Developer mode is enabled (Chrome: via privileged JS API; Edge: via UI shadow DOM toggle)
3. "Load unpacked" is clicked — the browser opens a Windows folder picker
4. A PowerShell script fills the picker path using `WM_SETTEXT` + `BM_CLICK` (no window focus required)

No GPO, CRX files, or registry changes needed. All handled in `utils/system-windows-chrome.ts`.

### 7. Run tests on Windows
```powershell
npx playwright test                                      # all Windows projects
npx playwright test --project=windows-chrome
npx playwright test --project=windows-edge
npx playwright test --project=windows-firefox
npx playwright test tests/02-dashboard-login.spec.ts --project=windows-chrome
npx playwright show-report reports/html
```

---

## Test architecture

### Serial test chains with shared browser session

Each describe block uses `test.describe.serial` with a `beforeAll` that clears auth once. Tests chain — each continues from where the previous one left off:

```
Worker starts → browser + extension loaded once (worker-scoped fixture)
  beforeAll  → clearAuth() resets cookies/storage once for the whole suite
  Test 1: Extension loads                     (verifies extensionKey is present)
  Test 2: Extension popup opens               (continues from loaded-extension state)
  Test 3: Popup shows unauthenticated state   (continues from open-popup state)
  Test 4: Popup shows connected state         (logs into dashboard, verifies extension syncs)
Worker teardown → browser closed, all processes killed
```

Running a single test (e.g. only Test 4) also works — `beforeAll` clears auth and Test 4 logs in itself.

### One browser session per project per spec file

Each `project × spec file` combination gets exactly one worker. The worker opens the browser once, runs all serial tests, then closes. Session cookies persist across the chain.

### Retry behaviour with serial mode

If any test fails, `describe.serial` skips the remaining tests. Playwright retries from Test 1, which re-runs `beforeAll` and rebuilds state cleanly.

---

## Session teardown — platform differences

All browser processes are explicitly killed in a `finally` block.

### macOS Chrome (`system-chrome`, `base.ts`)
Kill order: **Chrome PID first, then ChromeDriver**

```
1. process.kill(chromePid, 'SIGTERM')   ← Chrome browser
2. driver.kill('SIGTERM')               ← ChromeDriver process
```

On macOS, ChromeDriver spawns Chrome as a completely separate process. SIGTERM to ChromeDriver does NOT propagate to Chrome. Chrome must be killed by its own PID.

Chrome PID is obtained from ChromeDriver session capabilities (`sessionInfo.value.processId`), with `pgrep -n` as a fallback.

### Windows Chrome/Edge (`windows-chrome`, `windows-edge`, `base.ts`)
Kill order: **ChromeDriver `/T` first, then browser PID as backup**

```
1. taskkill /PID <driverPid> /F /T      ← kills driver + entire process tree (Chrome + renderers/GPU)
2. taskkill /PID <browserPid> /F /T     ← backup: browser by its own PID
```

On Windows, ChromeDriver is the parent of Chrome. `/T` kills the full tree atomically. Killing Chrome first would orphan its child processes (renderers, GPU process, crashpad) before the tree-kill ran.

Browser PID is obtained via `Get-NetTCPConnection -LocalPort <debugPort>` (ChromeDriver does not expose the browser PID in session capabilities on Windows).

### Firefox (both platforms)
Kill order: **GeckoDriver first, then Firefox PID as backup**

On both platforms, GeckoDriver is the parent of Firefox. The kill order mirrors Windows Chrome: driver first (with `/T` on Windows, `SIGTERM` on macOS), then Firefox PID as backup.

---

## Gitignore

```
.env
extension builds/
node_modules/
dist/
reports/
test-results/
*.png
```

---

## Quick-start checklist

### macOS
- [ ] Node.js 20+ installed
- [ ] Chrome, Firefox, Safari installed
- [ ] `chromedriver` and `geckodriver` installed via Homebrew and version-matched
- [ ] `safaridriver --enable` run once
- [ ] Accessibility permission granted to Terminal / VS Code / iTerm
- [ ] `npm install` run in project root
- [ ] `.env` created from `.env.example` with credentials and paths
- [ ] Extension builds placed under `extension builds/`
- [ ] `npx playwright test` — should run `system-chrome`, `system-firefox`, `system-safari`

### Windows
- [ ] Node.js 20+ installed
- [ ] Chrome, Edge, Firefox installed
- [ ] `chromedriver.exe` and `msedgedriver.exe` downloaded and version-matched
- [ ] `geckodriver.exe` on PATH (or let global-setup auto-download)
- [ ] `npm install` run in project root
- [ ] `.env` created from `.env.example` with credentials and paths
- [ ] Extension ZIPs in `builds/` (or pre-extracted under `extension builds/`)
- [ ] `npx playwright test` — should run `windows-chrome`, `windows-edge`, `windows-firefox`
