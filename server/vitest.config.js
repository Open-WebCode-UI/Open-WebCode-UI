import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-test-data-'));
// PostgreSQL and MariaDB runs (TEST_ENGINE) create and empty server databases, which is slower than in-memory SQLite: allow more time per hook.
const serverDb = !!process.env.TEST_ENGINE && process.env.TEST_ENGINE !== 'sqlite';
export default defineConfig({ test: { include: ['test/**/*.test.js'], pool: 'forks', testTimeout: serverDb ? 60000 : 30000, hookTimeout: serverDb ? 120000 : 10000, env: { DATA_DIR: data, ALLOW_INSECURE_DEV: '1', BASE_URL: 'http://localhost:3000' } } });
