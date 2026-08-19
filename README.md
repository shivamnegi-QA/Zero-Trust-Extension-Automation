# Zero Trust Extension Automation

Playwright-based regression test suite for the **Zero Trust Browser (ZTB)** extension by Zscaler/SquareX. Automates extension loading, popup state verification, and dashboard login across Chrome and Firefox on macOS — with Windows (Chrome, Edge, Firefox) support documented in [SETUP.md](SETUP.md).

Includes a browser-based [test runner UI](#test-runner-ui) for selecting suites, watching live output, and browsing past runs.

---

## Test coverage

| Test | Chrome | Firefox |
|---|:---:|:---:|
| Extension loads | ✅ | ✅ |
| Extension popup opens | ✅ | ✅ |
| Popup shows unauthenticated state | ✅ | ✅ |
| Popup shows connected state after login | ✅ | ✅ |
| Dashboard login page loads | ✅ | — |
| Login fails with wrong password | ✅ | — |
| Login succeeds with valid credentials | ✅ | — |
| Session persists after page reload | ✅ | — |

---

## Architecture

Each Playwright **project** (`system-chrome`, `system-firefox`) launches its browser **once** per run via worker-scoped fixtures and shares that session across all tests. The extension spec is `describe.serial`, so the cases run in order and build on each other — the login test depends on the unauthenticated test having run first. `clearAuth()` runs in `afterAll`, leaving the session clean for the next run rather than resetting between cases.

```
Worker starts → browser launches once
  Test 1 – Extension loads
  Test 2 – Popup opens
  Test 3 – Unauthenticated state    (no dashboard session yet)
  Test 4 – Connected state after login
  afterAll: clearAuth()
Worker teardown → browser closed
```

Two abstractions keep the specs browser-agnostic:

- **`PopupSession`** ([fixtures/extension.ts](fixtures/extension.ts)) — one interface implemented per engine, so a single spec drives every browser with no per-browser conditionals in test code.
- **A project descriptor table** in the same file maps each Playwright project to its engine (`chromium` | `firefox`), extension path, and launcher. Adding a browser means adding a table entry, not another branch.

---

## Prerequisites (macOS)

- Node.js 20+
- Chrome, Firefox
- `brew install chromedriver geckodriver`
- **Accessibility permission** for the terminal app: System Settings → Privacy & Security → Accessibility

## Setup

```bash
git clone https://github.com/shivamnegi-QA/Zero-Trust-Extension-Automation.git
cd Zero-Trust-Extension-Automation
npm install
cp .env.example .env   # fill in credentials
```

Place extension builds at the paths set in `.env`:
```
extension builds/
  chrome-1.4.3/build/    # Chrome + Edge unpacked (EXTENSION_PATH)
  firefox-1.4.3/build/   # Firefox unpacked (FIREFOX_EXTENSION_PATH)
```

Or download automatically from the deployment page:
```bash
npm run download-extension
```

---

## Running tests

```bash
# All browsers
npx playwright test

# Single browser
npx playwright test --project=system-chrome
npx playwright test --project=system-firefox

# Smoke suite only
npm run test:smoke

# Open HTML report after a run
npx playwright show-report reports/html
```

Current inventory: **12 tests** — 8 on `system-chrome` (extension spec + dashboard login spec) and 4 on `system-firefox` (extension spec only).

---

## Test runner UI

A browser UI for driving the suite without the CLI:

```bash
npm run ui          # http://localhost:4321
PORT=5000 npm run ui   # override the port
```

- **Select suites and browsers**, then Run — the sidebar shows which browsers each spec will actually run on, derived from the `testMatch` rules in `playwright.config.ts`.
- **Live output** streams over SSE, grouped per test with pass/fail status and durations.
- **Stop** terminates the whole process tree, so no `chromedriver` or browser is left running.
- **History tab** lists past runs newest-first. Expanding one shows per-test results and, for failures, the failing spec line, the error, and an archived screenshot. Playwright wipes `test-results/` at the start of every run, so artifacts are copied into `run-history/<timestamp>/` to stay viewable later. Retention is capped at 50 runs.
- The Run button is **disabled when the selected OS doesn't match the host**, since those projects cannot execute there.

Ctrl-C on the server also tears down any in-flight run.

---

## Project structure

```
fixtures/
  extension.ts        # Project descriptor table + PopupSession fixture (all browsers)
  base.ts             # Chrome CDP fixture for the dashboard spec
  firefox.ts          # Firefox popup helpers used by extension.ts

tests/
  extension-load-and-login.spec.ts   # Cross-browser extension spec
  02-dashboard-login.spec.ts         # Chrome dashboard login spec
  helpers/
    webdriver-login.ts               # Shared login helpers (webdriverLogin, isConnectedState)

pages/
  LoginPage.ts        # Page objects for the dashboard spec
  DashboardPage.ts

utils/
  system-chrome.ts          # macOS: ChromeDriver + Swift AX / NSOpenPanel automation
  system-firefox.ts         # Cross-platform: geckodriver + GdSession WebDriver client
  system-windows-chrome.ts  # Windows: ChromeDriver/MSEdgeDriver + PowerShell file picker
  system-windows-edge.ts    # Windows: thin Edge wrapper over the above
  platform.ts               # OS-aware binary paths, reads .env overrides
  shared.ts                 # WdClient, sleep, getFreePort, extensionIdFromManifestKey, killProcessTree
  chrome-profile.ts         # Profile helpers for the download script
  env.ts                    # Zod-validated environment schema

ui/
  server.ts           # Test runner API + SSE stream + run history
  public/index.html   # Single-page runner UI

scripts/
  global-setup.ts     # Download/verify extension build before test run
  download-extension.ts
  inspect-login.ts    # Manual login-flow inspector
  load-profile.ts

playwright.config.ts  # Defines all projects; only the current OS's are active
```

---

## Windows support

`playwright.config.ts` defines `windows-chrome`, `windows-edge`, and `windows-firefox`, and activates them automatically when `process.platform === 'win32'` — the macOS projects are excluded there, and vice versa. No manual config edits when moving between machines.

- [SETUP.md](SETUP.md) — drivers, binaries, `.env` values, and extension build layout for Windows.
- [WINDOWS-CHANGES.md](WINDOWS-CHANGES.md) — what the recent fixture/teardown refactor changed, before/after code, and Windows-specific troubleshooting. Worth reading first if a Windows run misbehaves, since that work was written on macOS where the `windows-*` projects cannot execute.

---

## Environment variables

Validated on startup by [utils/env.ts](utils/env.ts) — a missing or malformed **required** value fails fast rather than surfacing mid-run.

| Variable | Required | Description |
|---|:---:|---|
| `EXTENSION_LOGIN_EMAIL` | ✅ | Dashboard login email |
| `EXTENSION_LOGIN_PASSWORD` | ✅ | Dashboard login password |
| `SQRX_BASE_URL` | ✅ | Tenant base URL |
| `EXTENSION_PATH` | ✅ | Unpacked Chrome/Edge extension (default `extension builds/chrome-1.4.3/build`) |
| `EXTENSION_DEPLOYMENT_PAGE_URL` | ✅ | GPO deployment settings page, used by `download-extension` |
| `DASHBOARD_ACCESS_API` | ✅ | Dashboard API key (`id:secret`) |
| `FIREFOX_EXTENSION_PATH` | — | Unpacked Firefox extension. Defaults to `extension builds/firefox-1.4.3/build` on macOS and `extension builds/firefox-1.4.3` on Windows, so it's only needed to override those. |
| `PORT` | — | Test runner UI port (default `4321`) |

Per-machine binary overrides (`CHROME_BINARY`, `CHROMEDRIVER`, `EDGE_BINARY`, `EDGEDRIVER`, `FIREFOX_BINARY`, `GECKODRIVER`) are optional and documented in [SETUP.md](SETUP.md); [utils/platform.ts](utils/platform.ts) auto-detects standard install locations.

Copy `.env.example` to `.env` and fill in values. Never commit `.env` — it is covered by `.gitignore`.
