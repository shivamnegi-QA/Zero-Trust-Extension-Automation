import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT, '.ui-server.pid');

export default async function globalTeardown() {
  if (!fs.existsSync(PID_FILE)) return;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  fs.rmSync(PID_FILE, { force: true });
  console.log(`  [ui-teardown] Server (pid ${pid}) stopped`);
}
