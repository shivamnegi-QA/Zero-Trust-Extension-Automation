import * as path from 'path';
import * as fs from 'fs';

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(path.resolve('extension builds/screenshots'), { recursive: true });
  console.log('\n[global-setup] Using local extension build (download skipped)');
}
