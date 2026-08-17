# Zero Trust Extension Automation

Playwright-based regression test suite for the **Zero Trust Browser (ZTB)** extension by Zscaler/SquareX. Automates extension loading, popup state verification, and dashboard login across Chrome, Firefox, and Safari on macOS — with Windows (Chrome, Edge, Firefox) support documented in [SETUP.md](SETUP.md).

---

## Test coverage

| Test | Chrome | Firefox | Safari |
|---|:---:|:---:|:---:|
| Extension loads | ✅ | ✅ | ✅ |
| Extension popup opens | ✅ | ✅ | ✅ |
| Popup shows unauthenticated state | ✅ | ✅ | ✅ |
| Popup shows connected state after login | ✅ | ✅ | ✅ |
| Dashboard login page loads | ✅ | — | — |
| Login fails with wrong password | ✅ | — | — |
| Login succeeds with valid credentials | ✅ | — | — |
| Session persists after page reload | ✅ | — | — |

---

## Architecture

Each Playwright **project** (`system-chrome`, `system-firefox`, `system-safari`) launches its browser **once** per run via worker-scoped fixtures and shares that session across all tests. A `beforeEach` hook calls `clearAuth()` to reset cookies before every test.

```
Worker starts → browser launches once
  beforeEach: clearAuth()
  Test 1 – Extension loads
  beforeEach: clearAuth()
  Test 2 – Popup opens
  beforeEach: clearAuth()
  Test 3 – Unauthenticated state
  beforeEach: clearAuth()
  Test 4 – Connected state after login
Worker teardown → browser closed
```

The `PopupSession` interface in [fixtures/extension.ts](fixtures/extension.ts) abstracts all browser differences so the single spec drives all three browsers without per-browser conditionals.

---

## Prerequisites (macOS)

- Node.js 20+
- Chrome, Firefox, Safari (built-in)
- `brew install chromedriver geckodriver`
- `safaridriver --enable`
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
  current/               # Chrome unpacked
  firefox-1.4.3/build/   # Firefox unpacked
  safari-1.4.3/          # Safari app bundle
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
npx playwright test --project=system-safari

# Smoke suite only
npm run test:smoke

# Open HTML report after a run
npx playwright show-report reports/html
```

---

## Project structure

```
fixtures/
  extension.ts        # Unified worker-scoped fixture (PopupSession interface)
  base.ts             # Chrome CDP fixture
  firefox.ts          # Firefox geckodriver helpers
  safari.ts           # Safari safaridriver helpers

tests/
  extension-load-and-login.spec.ts   # Cross-browser extension spec
  02-dashboard-login.spec.ts         # Chrome dashboard login spec
  helpers/
    webdriver-login.ts               # Shared login helpers

utils/
  system-chrome.ts    # Chrome launch + NSOpenPanel AX automation
  system-firefox.ts   # geckodriver + GdSession WebDriver client
  system-safari.ts    # safaridriver + SdSession + AX popup automation

scripts/
  global-setup.ts     # Download/verify extension build before test run
  download-extension.ts

playwright.config.ts
```

---

## Windows support

See [SETUP.md](SETUP.md) for full instructions on adding `windows-chrome`, `windows-edge`, and `windows-firefox` projects including driver setup, extension loading via CRX/policy, and platform path constants.

---

## Environment variables

| Variable | Description |
|---|---|
| `EXTENSION_LOGIN_EMAIL` | Dashboard login email |
| `EXTENSION_LOGIN_PASSWORD` | Dashboard login password |
| `SQRX_BASE_URL` | Tenant base URL |
| `EXTENSION_PATH` | Path to unpacked Chrome extension |
| `FIREFOX_EXTENSION_PATH` | Path to unpacked Firefox extension |
| `EXTENSION_DEPLOYMENT_PAGE_URL` | GPO deployment settings page (for auto-download) |
| `DASHBOARD_ACCESS_API` | Dashboard API key (`id:secret`) |

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.
