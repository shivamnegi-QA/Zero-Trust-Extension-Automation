import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { IS_WINDOWS } from './platform';

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Terminate a browser or driver process.
 *
 * On Windows the driver parents the browser, so taskkill /T tears the tree down
 * atomically. On POSIX the two are unrelated for signal purposes, so callers must kill
 * the browser PID before the driver's or the browser is left running.
 */
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

/** True if this process has Accessibility permission (required for System Events GUI scripting). */
export function checkAccessibility(): boolean {
  const r = cp.spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke ""'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5000,
  });
  const stderr = r.stderr?.toString() ?? '';
  return !stderr.includes('not allowed') && !stderr.includes('1002') && !stderr.includes('(-1743)');
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

export function extensionIdFromManifestKey(extPath: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    if (!manifest.key) return '';
    const der  = Buffer.from(manifest.key, 'base64');
    const hash = crypto.createHash('sha256').update(der).digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
      id += String.fromCharCode(97 + (hash[i] >> 4));
      id += String.fromCharCode(97 + (hash[i] & 0xf));
    }
    return id;
  } catch {
    return '';
  }
}

export class WdClient {
  private base: string;
  public sessionId = '';
  public debuggerAddress = '';

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  async json(method: string, p: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async waitReady(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { await this.json('GET', '/status'); return; }
      catch { await sleep(300); }
    }
    throw new Error('WebDriver did not become ready in time');
  }

  async newSession(caps: object): Promise<void> {
    const data = await this.json('POST', '/session', { capabilities: { alwaysMatch: caps } }) as {
      value: {
        sessionId?: string;
        capabilities?: {
          'goog:chromeOptions'?: { debuggerAddress?: string };
          'ms:edgeOptions'?: { debuggerAddress?: string };
        }
      }
    };
    if (!data?.value?.sessionId) throw new Error(`Session creation failed: ${JSON.stringify(data).slice(0, 200)}`);
    this.sessionId = data.value.sessionId;
    this.debuggerAddress =
      data.value.capabilities?.['goog:chromeOptions']?.debuggerAddress
      ?? data.value.capabilities?.['ms:edgeOptions']?.debuggerAddress
      ?? '';
  }

  async navigate(url: string): Promise<void> {
    await this.json('POST', `/session/${this.sessionId}/url`, { url });
  }

  async executeSync<T>(script: string, args: unknown[] = []): Promise<T> {
    const d = await this.json('POST', `/session/${this.sessionId}/execute/sync`, { script, args }) as { value: T };
    return d.value;
  }

  async executeAsync<T>(script: string, args: unknown[] = [], timeoutMs = 15_000): Promise<T> {
    await this.json('POST', `/session/${this.sessionId}/timeouts`, { script: timeoutMs });
    const d = await this.json('POST', `/session/${this.sessionId}/execute/async`, { script, args }) as { value: T };
    return d.value;
  }
}
