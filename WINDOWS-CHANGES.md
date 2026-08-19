# Windows Changes — Context for Running the Suite on Windows

> **Why this file exists.** All the work described here was written and verified on a
> **macOS** machine. The `windows-chrome`, `windows-edge`, and `windows-firefox` projects
> could not be executed there, because `playwright.config.ts` only defines them when
> `process.platform !== 'darwin'`. Everything below is therefore **typecheck-verified and
> wiring-verified, but never runtime-verified on Windows.** This document exists so the
> Claude Code instance on the Windows machine knows exactly what changed, what to expect,
> and how to diagnose a failure.
>
> **Filename note:** this is `WINDOWS-CHANGES.md`, not `setup.md`, on purpose. Windows
> filesystems are case-insensitive, so a file named `setup.md` would collide with the
> existing `SETUP.md` and one would silently overwrite the other. `SETUP.md` still holds
> the general install instructions (drivers, binaries, `.env`); read it first, then this.

---

## 1. What to verify first, in order

Run these before debugging anything. They isolate "did the refactor break Windows?" from
"is the Windows environment itself misconfigured?"

```powershell
# 1. Does the code compile at all?
npx tsc --noEmit
# Expect: no output.

# 2. Do the Windows projects even exist on this machine?
npx playwright test --list
# Expect: [windows-chrome], [windows-edge], [windows-firefox] — and NO [system-chrome].
# If you see system-chrome instead, playwright.config.ts thinks this is macOS.

# 3. Do the Windows launcher modules load?
npx tsx -e "import('./utils/system-windows-chrome').then(m=>console.log(Object.keys(m)))"
npx tsx -e "import('./utils/system-windows-edge').then(m=>console.log(Object.keys(m)))"
# Expect: launchWindowsBrowserWithExtension / launchWindowsEdgeWithExtension present.

# 4. Smallest real run — one test, one browser.
npx playwright test --project=windows-chrome --grep "Extension Load And Login Extension loads$"
```

Step 4 is the first thing that can genuinely fail on Windows. Steps 1–3 were all confirmed
working from macOS.

---

## 2. Changes that affect Windows

There are four. Three are shared refactors that Windows now flows through; one is
Windows-only behaviour in the UI server that was left deliberately untouched.

### 2.1 `killWin()` was replaced by a shared `killProcessTree()`

**Risk: LOW.** Same syscall, same flags, same order.

`utils/system-windows-chrome.ts` had its own private kill helper. Firefox and macOS Chrome
each had their own near-identical copies. All three now call one function in
`utils/shared.ts`.

**Before** (`utils/system-windows-chrome.ts`):

```ts
// ── Kill helper (Windows uses taskkill for reliable tree kill) ────────────────

function killWin(pid: number): void {
  try {
    cp.spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
      stdio: 'ignore', timeout: 5_000,
    });
  } catch { /* already gone */ }
}
```

...used in teardown as:

```ts
if (driver.pid != null) killWin(driver.pid);
else driver.kill();
if (browserPid) killWin(browserPid);
```

**After** (`utils/shared.ts` — new shared function):

```ts
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (IS_WINDOWS) {
      cp.spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', timeout: 5_000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}
```

...used in `utils/system-windows-chrome.ts` teardown as:

```ts
if (driver.pid != null) killProcessTree(driver.pid);
else driver.kill();
killProcessTree(browserPid ?? undefined);
```

**The invariant that must not break.** Windows and macOS use *opposite* kill orders, and
this is deliberate:

| OS | Order | Reason |
|---|---|---|
| **Windows** | ChromeDriver **first** (`taskkill /T`) | The driver parents the browser. `/T` tears down driver + browser + renderers + GPU + crashpad atomically. Killing the browser first would orphan its children before the tree-kill runs. |
| macOS | Browser PID first, then driver | The driver and browser are unrelated for signal purposes; SIGTERM to the driver never reaches the browser. |

The Windows order is unchanged. If you touch this, preserve it.

### 2.2 The fixture's per-project `if/else` chain became a descriptor table

**Risk: MEDIUM — this is the change most likely to surface a Windows-only problem.**

`fixtures/extension.ts` had 11 branches. `windows-chrome` and `windows-edge` were
near-identical 28-line blocks; `system-firefox` and `windows-firefox` were near-identical
~50-line blocks. That is now one lookup table plus two engine flows.

**Before** — one block per project (abridged; the `windows-edge` block was the same 28
lines with a different launcher and temp prefix):

```ts
} else if (project === 'windows-chrome') {
  const { launchWindowsBrowserWithExtension } = await import('../utils/system-windows-chrome');
  const { chromium } = await import('@playwright/test');
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');

  const extPath = process.env.EXTENSION_PATH
    ? path.resolve(process.env.EXTENSION_PATH)
    : path.resolve('extension builds/chrome-1.4.3/build');
  const tmpProfile = mkdtempSync(path.join(tmpdir(), 'ztb-winchrome-'));

  const { cdpEndpoint, teardown } = await launchWindowsBrowserWithExtension({
    extensionPath: extPath, profilePath: tmpProfile, tag: '[fixture:windows-chrome]',
  });
  let browser: any = null;
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint);
    const context = browser.contexts()[0] ?? await browser.newContext();
    await use(makeChromeSession(context, extId, cdpEndpoint));
  } finally {
    await teardown();
    await browser?.close().catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    try { rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }

} else if (project === 'windows-edge') {
  /* ...same 28 lines, different launcher + 'ztb-winedge-' prefix... */
```

**After** — the per-project values live in a table, the flow lives once per engine:

```ts
const PROJECTS: Record<string, ProjectSpec> = {
  'windows-chrome': {
    engine: 'chromium',
    extPathEnv: 'EXTENSION_PATH',
    defaultExtPath: CHROME_EXT_DEFAULT,          // 'extension builds/chrome-1.4.3/build'
    tmpPrefix: 'ztb-winchrome-',
    tag: '[fixture:windows-chrome]',
    launch: async (o) => (await import('../utils/system-windows-chrome')).launchWindowsBrowserWithExtension(o),
  },
  'windows-edge': {
    engine: 'chromium',
    extPathEnv: 'EXTENSION_PATH',
    defaultExtPath: CHROME_EXT_DEFAULT,
    tmpPrefix: 'ztb-winedge-',
    tag: '[fixture:windows-edge]',
    launch: async (o) => (await import('../utils/system-windows-edge')).launchWindowsEdgeWithExtension(o),
  },
  'windows-firefox': {
    engine: 'firefox',
    extPathEnv: 'FIREFOX_EXTENSION_PATH',
    // Windows builds ship unpacked at the bundle root, not under build/.
    defaultExtPath: 'extension builds/firefox-1.4.3',
    tmpPrefix: 'ztb-winff-',
    tag: '[fixture:windows-firefox]',
    launch: async (o) => (await import('../utils/system-firefox')).launchFirefoxWithExtension(o),
  },
  /* system-chrome, system-firefox omitted here — see the file */
};
```

Three behaviours were preserved carefully, and each is a thing to re-check if Windows
misbehaves:

1. **`windows-firefox` uses a different default path.** It is
   `extension builds/firefox-1.4.3` (bundle root), whereas `system-firefox` uses
   `extension builds/firefox-1.4.3/build`. This asymmetry existed before and is
   intentional — Windows Firefox builds ship unpacked at the root. Preserved in
   `defaultExtPath`.
2. **Lazy launcher imports.** `launch` is an `async` arrow that imports the module only
   when that project runs. This matters: it stops the Windows-only modules from being
   imported on macOS and vice versa. Do not convert these to top-level imports.
3. **Temp-profile prefixes are unchanged** (`ztb-winchrome-`, `ztb-winedge-`,
   `ztb-winff-`), so any external cleanup scripts matching those names still work.

The `windows-chrome` and `windows-edge` projects now execute this shared flow:

```ts
if (spec.engine === 'chromium') {
  const { chromium } = await import('@playwright/test');
  const { cdpEndpoint, teardown } = await spec.launch({ extensionPath, profilePath, tag: spec.tag });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint);
    const context = browser.contexts()[0] ?? await browser.newContext();
    await use(makeChromeSession(context, extId, cdpEndpoint));
  } finally {
    await teardown();
    await browser?.close().catch(() => {});
    // Give the browser time to release profile locks before removing the dir.
    await new Promise(r => setTimeout(r, 1500));
    try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch { /* OS will clean up */ }
  }
}
```

The 1500 ms wait before `rmSync` is load-bearing on Windows — Chrome/Edge hold locks on the
profile directory after exit, and removing it too early throws `EBUSY`/`EPERM`. It is
wrapped in try/catch so a failed cleanup cannot fail the test.

### 2.3 `extensionIdFromManifestKey` is now imported from `utils/shared`

**Risk: LOW.** Pure function, no platform behaviour.

`utils/system-windows-chrome.ts` used to re-export it:

```ts
export { extensionIdFromManifestKey } from './shared';   // ← removed
```

That re-export is gone (the same one was removed from `utils/system-chrome.ts`). Nothing
imported through it. `fixtures/base.ts` also stopped doing this pointless OS branch:

```ts
// BEFORE — loaded an entire platform-specific launcher for one pure function
const { extensionIdFromManifestKey } = IS_WINDOWS
  ? await import('../utils/system-windows-chrome')
  : await import('../utils/system-chrome');

// AFTER
const { extensionIdFromManifestKey } = await import('../utils/shared');
```

`utils/system-windows-edge.ts` **still re-exports it** and was left alone.

### 2.4 UI server: Windows stop path deliberately unchanged

**Risk: NONE on Windows — the change was macOS-only.**

`ui/server.ts` had a bug where pressing **Stop** left `chromedriver` and the browser alive
as orphans. That was a **macOS-only** bug: SIGTERM went to `npx`, and on macOS the
descendants don't inherit it. The fix added POSIX process-group handling and left the
Windows branch exactly as it was, because `taskkill /T` already killed the whole tree
correctly.

```ts
if (IS_WINDOWS) {
  // unchanged — taskkill /T already tears down the whole tree
  spawnSync('taskkill', ['/PID', String(proc.pid), '/F', '/T'], { stdio: 'ignore', timeout: 5_000 });
} else if (proc.pid) {
  // NEW, macOS only: signal the process group, then escalate
  const pgid = -proc.pid;
  try { process.kill(pgid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(pgid, 'SIGKILL'); } catch {} }, 5_000).unref();
}
```

Two related lines are also guarded so they are inert on Windows:

```ts
detached: !IS_WINDOWS,                          // in /api/run — POSIX process group only
if (activeRun?.pid && !IS_WINDOWS) { ... }      // server shutdown handler
```

**Expected Windows behaviour:** Stop should already work. If orphaned `chromedriver.exe` /
`chrome.exe` survive a Stop on Windows, that is a **new, separate bug** — not a regression
from this work, since this code path is byte-for-byte unchanged.

---

## 3. Other changes on this branch (not Windows-specific, but present)

Context so nothing looks unexplained:

- **A History tab** in the UI runner. Adds `run-history/` on disk, `/api/history` and
  `/api/history/:id`, and a `json` reporter alongside `list`. Run history is **committed to
  git** by request, with `!run-history/**/*.png` added to `.gitignore` so archived failure
  screenshots aren't excluded by the existing `*.png` rule.
- **Run button disabled on OS mismatch.** If the UI's OS selector doesn't match the host,
  Run is disabled and all three run entry points are guarded. On the Windows machine, pick
  **Windows** in the UI or Run will be greyed out.
- **`--project=NAME` / `--grep=NAME`** are now passed with `=`. With the space-separated
  form, Playwright consumed the *next* argv entry as another project name and every
  UI-triggered run aborted with `Error: Project(s) "tests/..." not found`.
- **Sidebar browser badges** are rendered from the live browser selection, so on Windows
  the extension suite shows `CHR`, `EDG`, `FF` per what's checked.
- **Deleted 5 unreachable files** (~750 lines): `scripts/appium-load-extension.ts`,
  `scripts/check-shortcuts.ts`, `scripts/debug-extid.ts`, `scripts/debug-helper.ts`,
  `utils/DashboardApiClient.ts`. All recoverable via `git show`. None were imported by any
  entry point. Note `appium-load-extension.ts` referenced Appium, which was never in
  `package.json`.

**Untouched Windows internals.** None of this modified the actual Windows launch mechanics:
the PowerShell `WM_SETTEXT` + `BM_CLICK` file-picker automation, the
`Get-NetTCPConnection` browser-PID lookup, the `capsKey: 'ms:edgeOptions'` Edge wiring, or
`utils/platform.ts` binary resolution. If the file picker misbehaves, it is not because of
this refactor.

---

## 4. If something fails on Windows

### `Error: Project(s) "..." not found`
`--project` was passed space-separated somewhere. Every internal caller now uses
`--project=NAME`. Check any hand-written command.

### Playwright lists `system-chrome` instead of `windows-*`
`playwright.config.ts` gates on `process.platform`. Confirm:
```powershell
node -e "console.log(process.platform)"   # expect: win32
```

### `Cannot find module '../utils/system-windows-chrome'`
The lazy `launch` import failed. Confirm the file exists and compiles:
```powershell
npx tsc --noEmit
npx tsx -e "import('./utils/system-windows-chrome').then(m=>console.log(Object.keys(m)))"
```

### Extension never loads / file picker times out
Unrelated to these changes — that code is unmodified. Expect
`[win-file-picker] out=result=... err=...` in the log. Check driver/browser version match
first (`chromedriver --version` vs Chrome's `Help > About`).

### `EBUSY` / `EPERM` removing the temp profile
Chrome/Edge still hold profile locks. Already tolerated (try/catch, 1500 ms delay) and
cannot fail a test. If it's noisy, raise the delay in the chromium flow in
`fixtures/extension.ts`.

### Orphaned `chromedriver.exe` after Stop
The Windows stop path is unchanged, so this is a pre-existing or new issue rather than a
regression. Inspect with:
```powershell
Get-Process chromedriver,chrome,msedge,firefox -ErrorAction SilentlyContinue
```

### Reverting a specific change
Everything is in git. The refactor touched:
`fixtures/extension.ts`, `fixtures/base.ts`, `utils/shared.ts`,
`utils/system-chrome.ts`, `utils/system-firefox.ts`, `utils/system-windows-chrome.ts`.
```powershell
git log --oneline -- fixtures/extension.ts
git diff HEAD~1 -- fixtures/extension.ts
git checkout HEAD~1 -- fixtures/extension.ts   # revert one file
```

---

## 5. Verification already done (and not done)

**Done on macOS:**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Full `system-chrome` suite | **8/8 passed** (1.9m) |
| Full `system-firefox` suite | **4/4 passed** (1.0m) |
| Test count vs. pre-refactor baseline | 12 before, 12 after |
| Windows launcher modules load + export | confirmed via `tsx` |
| `windows-*` projects resolve through the new fixture | confirmed — temporarily forced the config to expose them on macOS, all 3 enumerated (28 tests), then reverted |

**Not done — needs the Windows machine:**

- No `windows-chrome`, `windows-edge`, or `windows-firefox` test has ever been *executed*.
- The PowerShell file picker has not run against this refactor.
- Windows teardown / orphan behaviour has not been observed.
- The UI runner's Windows browser pills have not been exercised against a real run.

**Suggested first run on Windows:**

```powershell
npx playwright test --project=windows-chrome --grep "Extension Load And Login Extension loads$"
npx playwright test --project=windows-chrome     # full spec
npx playwright test --project=windows-edge
npx playwright test --project=windows-firefox
npm run ui                                        # then pick Windows in the UI, port 4321
```

---

## 6. Note on the git remote

`git remote get-url origin` on the macOS machine returns a URL with an **embedded GitHub
personal access token**. If this repo is cloned to the Windows machine by copying the git
config, that token travels with it. Prefer cloning fresh and authenticating with the
credential manager or SSH, and consider rotating the token if it has been copied around.
