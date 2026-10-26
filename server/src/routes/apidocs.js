import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineRoutes } from '../http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../openapi');
export const SPEC_FILE = path.join(root, 'openapi.yaml');
const HTML_FILE = path.join(root, 'dist/index.html'); // written by `npm run docs:build` (Redocly)

// The page Redocly builds has inline scripts (including the Redoc bundle), which the app-wide CSP forbids. Instead of loosening that policy
// for every page, this one response gets a policy that allows the inline scripts present in the file (by hash), and nothing else.
function cspFor(html) {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:", "worker-src blob:", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
}

export function apiDocsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  route.get('/docs', 'api.docs.read', (_req, res) => {
    let html;
    try { html = fs.readFileSync(HTML_FILE, 'utf8'); } catch { return res.status(503).json({ error: 'docs_not_built', message: 'Run "npm run docs:build" to generate the API documentation.' }); }
    res.set('Content-Security-Policy', cspFor(html)).type('html').send(html);
  });
  route.get('/docs/openapi.yaml', 'api.docs.read', (_req, res) => res.type('application/yaml').sendFile(SPEC_FILE));
  return r;
}
