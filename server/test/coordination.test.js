import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as co from '../src/workspace/coordination.js';
import { executeTool } from '../src/agent/tools.js';
import { tmpDir } from './helpers.js';

const mk = (root, projectId, convId) => ({ root, projectId, agentMode: 'act', execMode: 'files_only', permissions: new Set(), coord: co.forTurn(projectId, convId) });

describe('concurrent session coordination', () => {
  let root;
  beforeEach(() => { root = tmpDir(); fs.writeFileSync(path.join(root, 'a.txt'), 'one\n'); co.release(9, 1); co.release(9, 2); co.register(9, 1, 'First'); co.register(9, 2, 'Second'); });

  it('refuses a file another running session has changed, until that session ends', async () => {
    const a = mk(root, 9, 1), b = mk(root, 9, 2);
    expect(await executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' }, a)).toMatch(/^Edited/);
    expect(await executeTool('write_file', { path: 'a.txt', content: 'x' }, b)).toMatch(/being changed by another running session \("First"\)/);
    expect(await executeTool('delete_file', { path: 'a.txt' }, b)).toMatch(/^Error: a.txt is being changed/);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('two\n');
    co.release(9, 1);
    expect(await executeTool('write_file', { path: 'a.txt', content: 'x' }, b)).toMatch(/^Wrote/);
  });
  it('refuses a write over changes the session has not seen, and allows it after re-reading', async () => {
    const a = mk(root, 9, 1);
    await executeTool('read_file', { path: 'a.txt' }, a);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed elsewhere\n');
    expect(await executeTool('write_file', { path: 'a.txt', content: 'mine' }, a)).toMatch(/changed since you last read it/);
    await executeTool('read_file', { path: 'a.txt' }, a);
    expect(await executeTool('write_file', { path: 'a.txt', content: 'mine' }, a)).toMatch(/^Wrote/);
    expect(await executeTool('edit_file', { path: 'a.txt', old_string: 'mine', new_string: 'again' }, a)).toMatch(/^Edited/); // its own write is not "stale"
  });
  it('tells each session about the others and the files they hold', async () => {
    expect(co.note(9, 1)).toMatch(/"Second" \(no files changed yet\)/);
    await executeTool('write_file', { path: 'b.txt', content: 'y' }, mk(root, 9, 2));
    expect(co.note(9, 1)).toMatch(/"Second" has changed: b\.txt/);
    co.release(9, 2); expect(co.note(9, 1)).toBe('');
  });
});
