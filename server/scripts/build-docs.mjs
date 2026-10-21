// Builds the API documentation with Redocly (openapi/openapi.yaml -> openapi/dist/index.html).
// Redocly's page loads the Redoc bundle and web fonts from public CDNs. This app runs offline and its pages may not load third-party
// scripts, so the bundle is copied next to the page (the server serves it at /api/docs/redoc.js) and the page is pointed at the copy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'openapi/dist'), page = path.join(dist, 'index.html');
const require = createRequire(import.meta.url);

fs.mkdirSync(dist, { recursive: true });
execFileSync(process.execPath, [require.resolve('@redocly/cli/bin/cli.js'), 'build-docs', 'openapi/openapi.yaml', '-o', page, '--disableGoogleFont', '--title', 'Open WebCode UI API'], { cwd: root, stdio: 'inherit' });

const bundle = path.join(path.dirname(require.resolve('redoc/package.json')), 'bundles/redoc.standalone.js');
fs.copyFileSync(bundle, path.join(dist, 'redoc.js'));

let html = fs.readFileSync(page, 'utf8');
const tag = /<script src="https:\/\/cdn\.redocly\.com\/[^"]*"[^>]*><\/script>/;
if (!tag.test(html)) throw new Error('build-docs: could not find the Redoc script tag to localise; has the Redocly page layout changed?');
html = html.replace(tag, '<script src="/api/docs/redoc.js"></script>');
if (/https:\/\/(cdn\.redocly\.com|fonts\.googleapis\.com)/.test(html)) throw new Error('build-docs: the page still refers to an external host');
fs.writeFileSync(page, html);
console.log('API documentation written to openapi/dist/index.html');
