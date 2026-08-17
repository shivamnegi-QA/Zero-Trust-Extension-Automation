import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT, '.ui-server.pid');
const PORT = 14321;

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`UI server did not start within ${timeoutMs}ms`);
}

export default async function globalSetup() {
  // Kill any leftover server from a previous run
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    fs.rmSync(PID_FILE, { force: true });
    await new Promise(r => setTimeout(r, 500));
  }

  const proc = spawn('npx', ['tsx', 'ui/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  fs.writeFileSync(PID_FILE, String(proc.pid), 'utf8');

  await waitForServer(`http://localhost:${PORT}/api/status`);
  console.log(`  [ui-setup] Server started on port ${PORT} (pid ${proc.pid})`);
}
