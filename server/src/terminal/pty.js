import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pty;

// node-pty ships a prebuilt `spawn-helper` that must be executable. Package managers that skip install scripts
// (npm's install-scripts gate, pnpm, --ignore-scripts) leave it non-executable and every spawn then fails with
// "posix_spawnp failed", so repair that one file on first use.
function ensureSpawnHelper() {
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const dir of [path.join(root, 'prebuilds', `${process.platform}-${process.arch}`), path.join(root, 'build', 'Release')]) {
      const f = path.join(dir, 'spawn-helper');
      if (fs.existsSync(f) && (fs.statSync(f).mode & 0o111) === 0) fs.chmodSync(f, 0o755);
    }
  } catch { /* nothing to repair (e.g. Windows) */ }
}

export function loadPty() {
  if (!pty) { ensureSpawnHelper(); pty = require('node-pty'); }
  return pty;
}
