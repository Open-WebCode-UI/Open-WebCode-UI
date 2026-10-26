// Builds the API documentation with Redocly (openapi/openapi.yaml -> openapi/dist/index.html).
// Redocly's page loads the Redoc bundle and web fonts from public CDNs. This app runs offline and its pages may not load third-party
// scripts, so the bundle is embedded in the page (--inlineBundle) and the result is checked for external script, style and font hosts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'openapi/dist'), page = path.join(dist, 'index.html');
const require = createRequire(import.meta.url);

fs.mkdirSync(dist, { recursive: true });
execFileSync(process.execPath, [require.resolve('@redocly/cli/bin/cli.js'), 'build-docs', 'openapi/openapi.yaml', '-o', page, '--inlineBundle', '--title', 'Open WebCode UI API'], { cwd: root, stdio: 'inherit' });

const html = fs.readFileSync(page, 'utf8');
if (/<(script|link)\b[^>]*\b(src|href)="https?:\/\/|from "https?:\/\/|fonts\.googleapis\.com/.test(html)) throw new Error('build-docs: the page still loads from an external host');
console.log('API documentation written to openapi/dist/index.html');
