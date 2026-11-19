import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executeTool } from '../src/agent/tools.js';
import { tmpDir } from './helpers.js';

let root, data;
const base = () => ({ root, projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(['agent.act']), secretGlobs: [], shell: { timeoutSec: 5, outputCap: 1000 }, dataDir: data });
beforeEach(() => { root = tmpDir('fargs-'); data = tmpDir('fargs-data-'); fs.writeFileSync(path.join(root, 'b.txt'), 'keep'); });

describe('write_file / edit_file argument checks', () => {
  it('refuses a write with no content instead of creating an empty file', async () => {
    const r = await executeTool('write_file', { path: 'a.txt' }, base());
    expect(r).toMatch(/^Error: write_file was not run: "content" is missing/);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });

  it('names the argument keys the model sent when content was misnamed', async () => {
    const r = await executeTool('write_file', { path: 'a.txt', contents: 'hello' }, base());
    expect(r).toMatch(/Arguments received: path, contents/);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });

  it('refuses non-string content with a clear reason', async () => {
    const r = await executeTool('write_file', { path: 'd.json', content: { a: 1 } }, base());
    expect(r).toMatch(/must be the file text as a single string/);
    expect(fs.existsSync(path.join(root, 'd.json'))).toBe(false);
  });

  it('still allows an intentionally empty file', async () => {
    expect(await executeTool('write_file', { path: 'empty.txt', content: '' }, base())).toMatch(/^Wrote empty\.txt \(0 bytes\)/);
  });

  it('edit_file refuses a missing new_string without touching the file', async () => {
    const r = await executeTool('edit_file', { path: 'b.txt', old_string: 'keep' }, base());
    expect(r).toMatch(/^Error: edit_file was not run: "new_string" is missing/);
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('keep');
  });

  it('edit_file still allows an empty new_string (deleting text)', async () => {
    expect(await executeTool('edit_file', { path: 'b.txt', old_string: 'keep', new_string: '' }, base())).toBe('Edited b.txt');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('');
  });

  it('explains how to fix an absolute path', async () => {
    expect(await executeTool('write_file', { path: '/src/e.js', content: 'x' }, base())).toMatch(/relative to the project root.*src\/app\.js/);
  });
});
