import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as dotenv from 'dotenv';
dotenv.config();

const IS_WINDOWS = process.platform === 'win32';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve Playwright failure artifacts (screenshots, traces) under /test-results
app.use('/test-results', express.static(path.join(__dirname, '..', 'test-results')));
// Serve Playwright HTML report under /report
app.use('/report', express.static(path.join(__dirname, '..', 'reports', 'html')));
// Serve archived per-run artifacts (screenshots, videos) under /run-history
app.use('/run-history', express.static(path.join(__dirname, '..', 'run-history')));

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const HISTORY_DIR = path.join(ROOT, 'run-history');
// Playwright wipes test-results/ at the start of every run, so failure artifacts are
// copied into each run's history folder to keep older screenshots viewable.
const HISTORY_LIMIT = 50;

// Active run state
let activeRun: ChildProcess | null = null;
let runLog: string[] = [];
let runStatus: 'idle' | 'running' | 'passed' | 'failed' = 'idle';
let wasStopped = false;
let sseClients: express.Response[] = [];

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((res) => !res.writableEnded);
  sseClients.forEach((res) => res.write(payload));
}

// ── Run history ───────────────────────────────────────────────────────────────

type HistoryTest = {
  suite: string;
  name: string;
  project: string;
  status: string;
  durationMs: number;
  /** Failure message and the spec line it failed on, when Playwright reports one. */
  error?: string;
  failedAt?: string;
  screenshot?: string;
  video?: string;
  stdout?: string[];
};

type HistoryRun = {
  id: string;
  startedAt: string;
  durationMs: number;
  status: string;
  browsers: string[];
  files: string[];
  grep?: string;
  counts: { passed: number; failed: number; skipped: number; flaky: number };
  tests: HistoryTest[];
  log: string[];
};

function readRunIds(): string[] {
  try {
    return fs.readdirSync(HISTORY_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(HISTORY_DIR, e.name, 'run.json')))
      .map((e) => e.name)
      .sort()
      .reverse(); // ids are timestamp-prefixed, so lexical desc == newest first
  } catch { return []; }
}

function pruneHistory() {
  readRunIds().slice(HISTORY_LIMIT).forEach((id) => {
    fs.rmSync(path.join(HISTORY_DIR, id), { recursive: true, force: true });
  });
}

// Flatten the JSON reporter's nested suites. The describe() title lives on the innermost
// parent suite (the outermost one is the spec filename), so carry it down with each spec.
function collectSpecs(node: any, suiteTitle = '', out: Array<{ spec: any; suite: string }> = []) {
  (node.specs ?? []).forEach((spec: any) => out.push({ spec, suite: suiteTitle }));
  (node.suites ?? []).forEach((sub: any) => collectSpecs(sub, sub.title ?? suiteTitle, out));
  return out;
}

function firstAttachment(attachments: any[], kind: string): string | undefined {
  return attachments?.find((a) => a?.name === kind && typeof a.path === 'string')?.path;
}

// Copy an artifact out of test-results/ before the next run deletes it.
function archiveArtifact(srcPath: string, runDir: string): string | undefined {
  try {
    if (!fs.existsSync(srcPath)) return undefined;
    const artifactsDir = path.join(runDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    // Keep the parent folder name — Playwright names it after the test, so it stays unique.
    const unique = `${path.basename(path.dirname(srcPath))}-${path.basename(srcPath)}`.replace(/[^\w.-]+/g, '_');
    fs.copyFileSync(srcPath, path.join(artifactsDir, unique));
    return unique;
  } catch { return undefined; }
}

function recordRun(opts: {
  jsonPath: string;
  status: string;
  browsers: string[];
  files: string[];
  grep?: string;
  log: string[];
}): void {
  let report: any;
  try { report = JSON.parse(fs.readFileSync(opts.jsonPath, 'utf8')); } catch { return; }

  const stats = report.stats ?? {};
  const startedAt: string = stats.startTime ?? new Date().toISOString();
  const id = `${startedAt.replace(/[:.]/g, '-')}`;
  const runDir = path.join(HISTORY_DIR, id);

  try { fs.mkdirSync(runDir, { recursive: true }); } catch { return; }

  const tests: HistoryTest[] = [];
  (report.suites ?? []).forEach((s: any) => {
    collectSpecs(s, s.title ?? '').forEach(({ spec, suite }) => {
      (spec.tests ?? []).forEach((t: any) => {
        const r = (t.results ?? [])[(t.results ?? []).length - 1] ?? {};
        const err = (r.errors ?? [])[0]?.message ?? r.error?.message;
        const shot = firstAttachment(r.attachments, 'screenshot');
        const vid = firstAttachment(r.attachments, 'video');
        tests.push({
          suite,
          name: spec.title,
          project: t.projectName ?? '',
          status: r.status ?? t.status ?? 'unknown',
          durationMs: r.duration ?? 0,
          error: err ? String(err).replace(/\x1B\[[0-9;]*m/g, '').slice(0, 4000) : undefined,
          failedAt: r.status && r.status !== 'passed' ? `${spec.file}:${spec.line}` : undefined,
          screenshot: shot ? archiveArtifact(shot, runDir) : undefined,
          video: vid ? archiveArtifact(vid, runDir) : undefined,
          stdout: (r.stdout ?? []).map((o: any) => (typeof o === 'string' ? o : o?.text ?? '')).slice(-40),
        });
      });
    });
  });

  const run: HistoryRun = {
    id,
    startedAt,
    durationMs: Math.round(stats.duration ?? 0),
    status: opts.status,
    browsers: opts.browsers,
    files: opts.files,
    grep: opts.grep,
    counts: {
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed' || t.status === 'timedOut').length,
      skipped: tests.filter((t) => t.status === 'skipped').length,
      flaky: stats.flaky ?? 0,
    },
    tests,
    log: opts.log.slice(-500),
  };

  try {
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2));
    pruneHistory();
    broadcast('history', { id });
  } catch { /* history is best-effort; never fail a run over it */ }
}

// Validate that a user-supplied relative file path stays inside TESTS_DIR.
// Rejects absolute paths, path traversal, and paths that resolve outside the dir.
function validateTestFilePath(relPath: string): string | null {
  if (typeof relPath !== 'string') return null;
  // Reject obvious traversal and absolute paths
  if (relPath.includes('..') || path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(TESTS_DIR, relPath);
  if (!resolved.startsWith(TESTS_DIR + path.sep) && resolved !== TESTS_DIR) return null;
  return resolved;
}

// Infer browser tag from filename
function fileToBrowser(relPath: string): string {
  const f = relPath.toLowerCase();
  if (f.includes('firefox')) return 'firefox';
  if (f.includes('safari')) return 'safari';
  if (f.includes('chrome') || /\b0*1-extension/.test(f)) return 'chrome';
  return 'all';
}

function canonicalTestName(name: string): string {
  return name.replace(/\s+in\s+(chrome|firefox)$/i, '').trim();
}

// Extract the body of a test's async callback.
// test('name', async ({ ... }) => { BODY }) — we want BODY.
// Strategy: find the last opening brace before the next top-level test() or describe() call,
// then count braces from that point to get the balanced body.
function extractTestBody(src: string, bodyStart: number): string {
  // Find the opening brace of the async callback body.
  // The test call looks like: test('name', async (...) => { body })
  // bodyStart points to the first '{' after 'test('. We want the '{' that opens
  // the arrow function body, which is after the '=>'.
  const arrowIdx = src.indexOf('=>', bodyStart);
  if (arrowIdx === -1) return src.slice(bodyStart, Math.min(bodyStart + 3000, src.length));
  const cbBodyStart = src.indexOf('{', arrowIdx);
  if (cbBodyStart === -1) return '';

  let depth = 0;
  let i = cbBodyStart;
  while (i < src.length && i < cbBodyStart + 8000) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(cbBodyStart + 1, i); }
    i++;
  }
  return src.slice(cbBodyStart + 1, Math.min(cbBodyStart + 3000, src.length));
}

// Extract human-readable test steps from a test body.
// Scans for meaningful patterns: navigations, logins, assertions, polls, clicks, screenshots, waits.
function extractTestSteps(src: string, bodyStart: number): string[] {
  const bodySnippet = extractTestBody(src, bodyStart);
  const lines = bodySnippet.split('\n');
  const steps: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line === '{' || line === '}') continue;

    // Navigate
    const navM = line.match(/(?:goto|navigate|page\.goto)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (navM) { steps.push(`Navigate to ${navM[1]}`); continue; }

    const navVarM = line.match(/(?:goto|navigate)\s*\(\s*(\w[\w.]*)\s*[,)]/);
    if (navVarM) { steps.push(`Navigate to ${navVarM[1]}`); continue; }

    // Login call
    if (/webdriverLogin\s*\(/.test(line)) {
      steps.push('Log in to dashboard via WebDriver (email + password)');
      continue;
    }
    if (/\blogin\s*\(/.test(line)) {
      if (/wrong.password|intentional/i.test(line) || line.includes("'wrong-")) {
        steps.push('Submit login form with incorrect password');
      } else {
        steps.push('Submit login form with valid credentials (email + password)');
      }
      continue;
    }

    // waitForLoginSuccess
    if (/waitForLoginSuccess/.test(line)) { steps.push('Wait for login redirect to complete'); continue; }

    // clearAuth / clearSession
    if (/clearAuth|clearSession/.test(line)) { steps.push('Clear authentication state and extension storage'); continue; }

    // openPopup / openExtensionPopup
    if (/openPopup|openExtensionPopup/.test(line)) { steps.push('Open extension popup'); continue; }
    if (/closePopup/.test(line)) { steps.push('Close extension popup'); continue; }

    // poll
    if (/extSession\.poll|page\.waitFor|expect\.poll/.test(line)) {
      // Look ahead up to 10 lines to determine what this poll is checking
      const lineIdx = lines.indexOf(raw);
      const lookAhead = lines.slice(lineIdx, lineIdx + 12).join(' ');
      if (/isConnectedState|connected.state/i.test(lookAhead)) {
        steps.push('Poll popup every 3–5s until extension shows connected state (up to 3 min)');
      } else if (/authenticate/i.test(lookAhead) && /test/i.test(lookAhead)) {
        steps.push('Poll popup until Authenticate button appears (unauthenticated state confirmed)');
      } else if (/body.*length.*greater|popup.*not.*empty/i.test(lookAhead)) {
        steps.push('Poll popup until it renders visible content (non-empty body)');
      } else if (/isLoaded|dashboard/i.test(lookAhead)) {
        steps.push('Poll until dashboard page has fully loaded');
      } else {
        steps.push('Poll for expected condition');
      }
      continue;
    }

    // Reload
    if (/\.reload\s*\(/.test(line)) { steps.push('Reload page and wait for dashboard to load'); continue; }

    // screenshot
    if (/screenshot\s*\(/.test(line)) {
      const pathM = line.match(/path:\s*['"`]([^'"`]+)['"`]/) || line.match(/screenshots\/([^'"`\s)]+)/);
      steps.push(`Capture screenshot${pathM ? ` (${pathM[1].split('/').pop()})` : ''}`);
      continue;
    }

    // expect assertions
    const expectVisM = line.match(/expect.*getByTestId\(['"`]([^'"`]+)['"`]\).*toBeVisible/);
    if (expectVisM) { steps.push(`Assert "${expectVisM[1]}" element is visible`); continue; }

    const expectUrlM = line.match(/expect.*url.*toMatch.*['"`]([^'"`]+)['"`]/i);
    if (expectUrlM) { steps.push(`Assert URL matches ${expectUrlM[1]}`); continue; }

    const expectTrueM = line.match(/expect\s*\(([^,)]{3,60}),\s*['"`]([^'"`]{5,80})['"`]\s*\)\.toBe\(true\)/);
    if (expectTrueM) { steps.push(`Assert: ${expectTrueM[2]}`); continue; }

    const expectGtM = line.match(/expect\s*\(([^,)]{3,60}),\s*['"`]([^'"`]{5,80})['"`]\s*\)\.toBeGreaterThan/);
    if (expectGtM) { steps.push(`Assert: ${expectGtM[2]}`); continue; }

    const expectFalseM = line.match(/expect\s*\(([^,)]{3,60}),\s*['"`]([^'"`]{5,80})['"`]\s*\)\.toBe\(false\)/);
    if (expectFalseM) { steps.push(`Assert: ${expectFalseM[2]}`); continue; }

    // hasSidebarNav / isLoaded
    if (/hasSidebarNav/.test(line)) { steps.push('Check sidebar navigation is visible'); continue; }
    if (/dashboard\.isLoaded/.test(line)) { steps.push('Check dashboard page has loaded'); continue; }

    // isLoginErrorVisible
    if (/isLoginErrorVisible/.test(line)) { steps.push('Check login error message is visible'); continue; }

    // extSession.navigate
    if (/extSession\.navigate/.test(line)) {
      const u = line.match(/navigate\s*\(\s*(['"`][^'"`]+['"`]|\w+)/);
      steps.push(`Navigate browser to ${u ? u[1].replace(/['"`]/g, '') : 'URL'}`);
      continue;
    }

    // deleteAllCookies / execute localStorage.clear
    if (/deleteAllCookies/.test(line)) { steps.push('Delete all browser cookies'); continue; }
    if (/localStorage\.clear|sessionStorage\.clear/.test(line)) { steps.push('Clear localStorage and sessionStorage'); continue; }

    // logout navigation
    if (/\/api\/logout/.test(line)) { steps.push('Navigate to logout endpoint'); continue; }

    // expect(extId)
    if (/expect\s*\(extId/.test(line)) { steps.push('Assert extension ID is non-empty (extension loaded successfully)'); continue; }

    // skip console.log — debug output, not a test step
  }

  // Deduplicate consecutive identical steps
  const deduped: string[] = [];
  for (const s of steps) {
    if (deduped[deduped.length - 1] !== s) deduped.push(s);
  }

  // Resolve known variable names and template literals to actual values
  const BASE_URL   = (process.env.SQRX_BASE_URL ?? '').replace(/\/$/, '');
  const EMAIL      = process.env.EXTENSION_LOGIN_EMAIL ?? '';

  return deduped.map(s =>
    s
      .replace(/\bBASE_URL\b/g, BASE_URL || 'BASE_URL')
      .replace(/\bEMAIL\b/g, EMAIL || 'EMAIL')
      .replace(/\$\{extSession\.browser\}/g, '[browser]')
      .replace(/\$\{[^}]+\}/g, '[value]')
  );
}

// GET /api/catalogue — parse spec files and return suite/test structure
app.get('/api/catalogue', (_req, res) => {
  const result: Array<{ suite: string; id: number; name: string; canonicalName: string; file: string; description: string; validation: string; browser: string; steps: string[] }> = [];

  function walk(dir: string, rel: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) {
        let src: string;
        try { src = fs.readFileSync(path.join(dir, entry.name), 'utf8'); } catch { continue; }
        const lines = src.split('\n');
        const describeMatch = src.match(/test\.describe(?:\.serial|\.parallel)?\s*\(\s*['"`]([^'"`]+)['"`]/);
        const suite = describeMatch ? describeMatch[1] : relPath.replace(/\.(spec|test)\.ts$/, '');
        const testRe = /^\s*test\s*\(\s*['"`]([^'"`]+)['"`]/gm;
        let m: RegExpExecArray | null;
        let id = 1;
        while ((m = testRe.exec(src)) !== null) {
          const before = src.slice(0, m.index);
          const lineIdx = before.split('\n').length - 1;
          let description = '';
          let validation = '';
          for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 8); i--) {
            const trimmed = lines[i].trim();
            if (!trimmed.startsWith('//')) break;
            const descM = trimmed.match(/^\/\/\s*@desc\s+(.+)/i);
            const valM  = trimmed.match(/^\/\/\s*@validates\s+(.+)/i);
            if (descM && !description) description = descM[1].trim();
            if (valM  && !validation)  validation  = valM[1].trim();
          }
          if (!validation) {
            const bodyStart = src.indexOf('{', m.index);
            if (bodyStart !== -1) {
              const bodySnippet = src.slice(bodyStart, bodyStart + 1200);
              const msgs: string[] = [];
              const msgRe = /expect\s*\([^)]*,\s*['"`]([^'"`]{5,80})['"`]/g;
              let em: RegExpExecArray | null;
              while ((em = msgRe.exec(bodySnippet)) !== null) msgs.push(em[1]);
              if (msgs.length) validation = msgs.join('; ');
            }
          }
          const bodyStart = src.indexOf('{', m.index);
          const steps = bodyStart !== -1 ? extractTestSteps(src, bodyStart) : [];
          result.push({ suite, id: id++, name: m[1], canonicalName: canonicalTestName(m[1]), file: relPath, description, validation, browser: fileToBrowser(relPath), steps });
        }
      }
    }
  }

  walk(TESTS_DIR, '');
  res.json({ catalogue: result });
});

// GET /api/tests — list test files (recursive)
app.get('/api/tests', (_req, res) => {
  const files: string[] = [];
  function walk(dir: string, rel: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) {
        files.push(relPath);
      }
    }
  }
  walk(TESTS_DIR, '');
  files.sort();
  res.json({ files });
});

// GET /api/status
// Only replay log when a run is in progress so a mid-run refresh catches up.
// Completed/idle runs return an empty log — the output section starts clean on page load.
app.get('/api/status', (_req, res) => {
  res.json({ status: runStatus, log: runStatus === 'running' ? runLog : [] });
});

// GET /api/screenshot?suite=…&name=… — finds the failure screenshot for a test
app.get('/api/screenshot', (req, res) => {
  const suite = String(req.query.suite ?? '').replace(/[^a-z0-9 _-]/gi, '');
  const name  = String(req.query.name  ?? '').replace(/[^a-z0-9 _-]/gi, '');
  const testResultsDir = path.join(ROOT, 'test-results');
  if (!fs.existsSync(testResultsDir)) return res.json({ url: null });

  const raw      = `${suite} ${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const nameSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let dirs: string[];
  try { dirs = fs.readdirSync(testResultsDir); } catch { return res.json({ url: null }); }

  const match = dirs.find(d => {
    // Only look at directories, not loose files — avoids ENOTDIR on readdirSync below
    try {
      const stat = fs.statSync(path.join(testResultsDir, d));
      if (!stat.isDirectory()) return false;
    } catch { return false; }
    const dl = d.toLowerCase();
    return dl.includes(nameSlug) || dl.includes(raw.slice(0, 40));
  });

  if (!match) return res.json({ url: null });

  let files: string[];
  try { files = fs.readdirSync(path.join(testResultsDir, match)).filter(f => /\.(png|jpg|jpeg)$/i.test(f)); }
  catch { return res.json({ url: null }); }

  if (!files.length) return res.json({ url: null });
  res.json({ url: `/test-results/${match}/${files[0]}` });
});

// GET /api/events — SSE stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: status\ndata: ${JSON.stringify({ status: runStatus })}\n\n`);
  // Only replay log to reconnecting clients during an active run; idle/finished runs
  // start clean so the suite-overview is not overwritten by old output-rows.
  if (runStatus === 'running') {
    runLog.forEach((line) => {
      res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
    });
  }

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// GET /api/history — run summaries, newest first (no per-test detail)
app.get('/api/history', (_req, res) => {
  const runs = readRunIds().slice(0, HISTORY_LIMIT).flatMap((id) => {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id, 'run.json'), 'utf8'));
      const { tests, log, ...summary } = run;
      return [{ ...summary, testCount: tests?.length ?? 0 }];
    } catch { return []; }
  });
  res.json({ runs });
});

// GET /api/history/:id — full detail for one run
app.get('/api/history/:id', (req, res) => {
  // Reject anything that isn't a known run id, so the param can't escape HISTORY_DIR
  const id = String(req.params.id);
  if (!readRunIds().includes(id)) return res.status(404).json({ error: 'Run not found' });
  try {
    const run = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id, 'run.json'), 'utf8'));
    res.json({ run });
  } catch {
    res.status(500).json({ error: 'Could not read run' });
  }
});

// GET /api/platform — returns the actual OS this server is running on
app.get('/api/platform', (_req, res) => {
  res.json({ platform: process.platform === 'win32' ? 'windows' : 'mac' });
});

// POST /api/run
app.post('/api/run', (req, res) => {
  if (activeRun) {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  const { files, grep, browsers, platform } = req.body as {
    files?: unknown; grep?: unknown; browsers?: unknown; platform?: unknown;
  };

  // Platform guard: if the caller declared a target OS, verify it matches this machine
  const actualPlatform = process.platform === 'win32' ? 'windows' : 'mac';
  if (typeof platform === 'string' && platform !== actualPlatform) {
    const names: Record<string, string> = { windows: 'Windows', mac: 'macOS' };
    return res.status(400).json({
      error: `Platform mismatch: tests are configured for ${names[platform] ?? platform} but this machine is ${names[actualPlatform]}.`,
    });
  }

  // Validate and sanitise browsers — only known values accepted
  const KNOWN_BROWSERS = [
    'chrome', 'firefox', 'safari',
    'windows-chrome', 'windows-edge', 'windows-firefox',
  ];
  const BROWSER_TO_PROJECT: Record<string, string> = {
    chrome:            'system-chrome',
    firefox:           'system-firefox',
    safari:            'system-safari',
    'windows-chrome':  'windows-chrome',
    'windows-edge':    'windows-edge',
    'windows-firefox': 'windows-firefox',
  };

  const activeBrowsers: string[] = Array.isArray(browsers)
    ? (browsers as unknown[]).filter((b): b is string => typeof b === 'string' && KNOWN_BROWSERS.includes(b))
    : KNOWN_BROWSERS;

  if (activeBrowsers.length === 0) {
    return res.status(400).json({ error: 'No valid browsers specified' });
  }

  // Validate and sanitise file paths — must resolve inside TESTS_DIR
  const safeFiles: string[] = [];
  if (Array.isArray(files)) {
    for (const f of files as unknown[]) {
      if (typeof f !== 'string') continue;
      const resolved = validateTestFilePath(f);
      if (!resolved) continue; // silently drop invalid paths
      safeFiles.push(f); // keep the relative form for the CLI arg
    }
  }

  // grep is passed as a single argv entry with shell: false, so no shell interpretation
  // occurs and regex metacharacters ($ | ( ) \) must survive — the UI relies on them to
  // anchor exact test titles and to alternate when re-running several failed tests.
  const safeGrep = typeof grep === 'string' && grep.trim()
    ? grep.slice(0, 2000)
    : undefined;

  runLog = [];
  runStatus = 'running';
  broadcast('status', { status: 'running' });
  broadcast('run-files', { files: safeFiles });

  // list drives the live output stream; json gives history structured results,
  // failure messages, and attachment paths without re-parsing the list text.
  const jsonReportPath = path.join(ROOT, 'reports', 'last-run.json');
  const args = ['playwright', 'test', '--reporter=list,json', '--workers=1'];

  // --project=NAME, not --project NAME: with the space form Playwright treats the
  // following argv entry (a spec path or grep) as another project name and aborts.
  activeBrowsers.forEach((b) => {
    args.push(`--project=${BROWSER_TO_PROJECT[b]}`);
  });

  if (safeFiles.length > 0) {
    safeFiles.forEach((f) => args.push(path.join('tests', f)));
  }
  if (safeGrep) {
    args.push(`--grep=${safeGrep}`);
  }

  // Use shell: false and pass args array to avoid shell injection.
  // detached on POSIX puts the run in its own process group so /api/stop can signal the
  // whole tree: npx spawns npm exec → playwright → chromedriver → Chrome, and none of
  // those descendants inherit a SIGTERM sent to npx alone.
  activeRun = spawn('npx', args, {
    cwd: ROOT,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      PW_TEST_DEBUG_ERRORS: '1',
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportPath,
    },
    shell: false,
    detached: !IS_WINDOWS,
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  function flushLines(buf: string, tag: 'stdout' | 'stderr'): string {
    const parts = buf.split('\n');
    const incomplete = parts.pop() ?? '';
    parts.forEach((line) => {
      const entry = tag === 'stderr' ? `[stderr] ${line}` : line;
      runLog.push(entry);
      broadcast('log', { line: entry, tag });
    });
    return incomplete;
  }

  activeRun.stdout?.on('data', (data: Buffer) => {
    stdoutBuf = flushLines(stdoutBuf + data.toString(), 'stdout');
  });

  activeRun.stderr?.on('data', (data: Buffer) => {
    stderrBuf = flushLines(stderrBuf + data.toString(), 'stderr');
  });

  activeRun.on('close', (code) => {
    if (stdoutBuf) { runLog.push(stdoutBuf); broadcast('log', { line: stdoutBuf, tag: 'stdout' }); }
    if (stderrBuf) { const e = `[stderr] ${stderrBuf}`; runLog.push(e); broadcast('log', { line: e, tag: 'stderr' }); }
    const stopped = wasStopped;
    wasStopped = false;
    runStatus = stopped ? 'idle' : (code === 0 ? 'passed' : 'failed');
    broadcast('status', { status: runStatus });
    activeRun = null;
    // Archive even stopped runs — a partial result is still useful history.
    recordRun({
      jsonPath: jsonReportPath,
      status: stopped ? 'stopped' : runStatus,
      browsers: activeBrowsers,
      files: safeFiles,
      grep: safeGrep,
      log: runLog,
    });
  });

  res.json({ started: true });
});

// POST /api/stop
app.post('/api/stop', (_req, res) => {
  if (!activeRun) {
    return res.status(400).json({ error: 'No run in progress' });
  }
  // Keep activeRun set until the process actually exits — prevents race with /api/run
  const proc = activeRun;
  wasStopped = true;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/F', '/T'], { stdio: 'ignore', timeout: 5_000 });
  } else if (proc.pid) {
    // Negative pid signals the whole process group (see detached in /api/run), so
    // chromedriver and the browser it launched die with the runner instead of being
    // reparented to launchd. Escalate for anything that ignores SIGTERM.
    const pgid = -proc.pid;
    try { process.kill(pgid, 'SIGTERM'); } catch { /* group already gone */ }
    setTimeout(() => {
      try { process.kill(pgid, 'SIGKILL'); } catch { /* exited cleanly */ }
    }, 5_000).unref();
  }
  // runStatus and broadcast are handled in the 'close' handler once the process actually exits
  res.json({ stopped: true });
});

// A detached run survives the server, so take its process group down on the way out.
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    if (activeRun?.pid && !IS_WINDOWS) {
      try { process.kill(-activeRun.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    process.exit(0);
  });
});

const PORT = parseInt(process.env.PORT ?? '4321', 10);
app.listen(PORT, () => {
  console.log(`\n  ZT Extension Test Runner`);
  console.log(`  http://localhost:${PORT}\n`);
});
