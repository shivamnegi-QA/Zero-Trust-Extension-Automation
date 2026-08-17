import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync, ChildProcess } from 'child_process';

const IS_WINDOWS = process.platform === 'win32';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve Playwright failure artifacts (screenshots, traces) under /test-results
app.use('/test-results', express.static(path.join(__dirname, '..', 'test-results')));
// Serve Playwright HTML report under /report
app.use('/report', express.static(path.join(__dirname, '..', 'reports', 'html')));

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');

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
  if (f.includes('safari'))  return 'safari';
  if (f.includes('chrome') || /\b0*1-extension/.test(f)) return 'chrome';
  return 'all';
}

function canonicalTestName(name: string): string {
  return name.replace(/\s+in\s+(chrome|firefox|safari)$/i, '').trim();
}

// GET /api/catalogue — parse spec files and return suite/test structure
app.get('/api/catalogue', (_req, res) => {
  const result: Array<{ suite: string; id: number; name: string; canonicalName: string; file: string; description: string; validation: string; browser: string }> = [];

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
        const describeMatch = src.match(/test\.describe\s*\(\s*['"`]([^'"`]+)['"`]/);
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
          result.push({ suite, id: id++, name: m[1], canonicalName: canonicalTestName(m[1]), file: relPath, description, validation, browser: fileToBrowser(relPath) });
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

  // Sanitise grep — strip shell metacharacters; Playwright --grep is passed as a regex string
  const safeGrep = typeof grep === 'string'
    ? grep.replace(/[`$\\|;&><(){}!]/g, '')
    : undefined;

  runLog = [];
  runStatus = 'running';
  broadcast('status', { status: 'running' });
  broadcast('run-files', { files: safeFiles });

  const args = ['playwright', 'test', '--reporter=list', '--workers=1'];

  activeBrowsers.forEach((b) => {
    args.push('--project', BROWSER_TO_PROJECT[b]);
  });

  if (safeFiles.length > 0) {
    safeFiles.forEach((f) => args.push(path.join('tests', f)));
  }
  if (safeGrep) {
    args.push('--grep', safeGrep);
  }

  // Use shell: false and pass args array to avoid shell injection
  activeRun = spawn('npx', args, {
    cwd: ROOT,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      PW_TEST_DEBUG_ERRORS: '1',
    },
    shell: false,
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
  } else {
    proc.kill('SIGTERM');
  }
  // runStatus and broadcast are handled in the 'close' handler once the process actually exits
  res.json({ stopped: true });
});

const PORT = parseInt(process.env.PORT ?? '4321', 10);
app.listen(PORT, () => {
  console.log(`\n  ZT Extension Test Runner`);
  console.log(`  http://localhost:${PORT}\n`);
});
