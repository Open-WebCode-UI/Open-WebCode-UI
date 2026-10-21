import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-test-data-'));
export default defineConfig({ test: { include: ['test/**/*.test.js'], pool: 'forks', testTimeout: 30000, env: { DATA_DIR: data, ALLOW_INSECURE_DEV: '1', BASE_URL: 'http://localhost:3000' } } });
