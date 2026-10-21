import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getToolsFor, executeTool, PlanModeViolation, runShell } from '../src/agent/tools.js';
import { tmpDir } from './helpers.js';
import { listCheckpoints } from '../src/workspace/checkpoints.js';

let root, data;
const base = (o = {}) => ({ root, projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(['agent.act', 'agent.shell.run']), secretGlobs: ['.env', '*.pem'], shell: { timeoutSec: 5, outputCap: 1000 }, dataDir: data, ...o });
beforeEach(() => { root = tmpDir('proj-'); data = tmpDir('data-'); fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo\nthree\n'); fs.writeFileSync(path.join(root, '.env'), 'KEY=secret'); });
const names = (c) => getToolsFor(c).map((t) => t.name);

describe('file tools', () => {
  it('list/read/search/write/edit/delete inside the jail', async () => {
    const c = base();
    expect(await executeTool('list_dir', { path: '.' }, c)).toContain('a.js');
    expect(await executeTool('read_file', { path: 'a.js', start_line: 2, end_line: 2 }, c)).toBe('2\ttwo');
    expect(await executeTool('search', { pattern: 'thr' }, c)).toBe('a.js:3: three');
    await executeTool('write_file', { path: 'src/new.txt', content: 'hi' }, c);
    expect(fs.readFileSync(path.join(root, 'src/new.txt'), 'utf8')).toBe('hi');
    expect(await executeTool('edit_file', { path: 'a.js', old_string: 'two', new_string: 'TWO' }, c)).toMatch(/Edited/);
    expect(fs.readFileSync(path.join(root, 'a.js'), 'utf8')).toContain('TWO');
    await executeTool('delete_file', { path: 'src/new.txt' }, c);
    expect(fs.existsSync(path.join(root, 'src/new.txt'))).toBe(false);
  });
  it('edit_file requires a unique match', async () => {
    fs.writeFileSync(path.join(root, 'd.txt'), 'x x');
    expect(await executeTool('edit_file', { path: 'd.txt', old_string: 'x', new_string: 'y' }, base())).toMatch(/matches 2/);
    expect(await executeTool('edit_file', { path: 'd.txt', old_string: 'zzz', new_string: 'y' }, base())).toMatch(/not found/);
    expect(fs.readFileSync(path.join(root, 'd.txt'), 'utf8')).toBe('x x');
  });
  it('replace_lines / delete_lines / insert_lines edit by line number', async () => {
    const c = base(), f = path.join(root, 'a.js'), rd = () => fs.readFileSync(f, 'utf8');
    expect(await executeTool('replace_lines', { path: 'a.js', start_line: 2, content: 'TWO' }, c)).toMatch(/Replaced 1 line .*with 1 line/);
    expect(rd()).toBe('one\nTWO\nthree\n');
    await executeTool('replace_lines', { path: 'a.js', start_line: 1, end_line: 2, content: 'x\ny\nz\n' }, c);
    expect(rd()).toBe('x\ny\nz\nthree\n');
    expect(await executeTool('insert_lines', { path: 'a.js', after_line: 0, content: 'top' }, c)).toMatch(/Inserted 1 line after line 0/);
    await executeTool('insert_lines', { path: 'a.js', after_line: 5, content: 'end1\nend2' }, c);
    expect(rd()).toBe('top\nx\ny\nz\nthree\nend1\nend2\n');
    expect(await executeTool('delete_lines', { path: 'a.js', start_line: 2, end_line: 4 }, c)).toMatch(/Deleted 3 lines/);
    await executeTool('delete_lines', { path: 'a.js', start_line: 1 }, c);
    expect(rd()).toBe('three\nend1\nend2\n');
  });
  it('line edits validate ranges, keep CRLF, and a missing final newline', async () => {
    const c = base();
    expect(await executeTool('delete_lines', { path: 'a.js', start_line: 4 }, c)).toMatch(/^Error: start_line 4 is out of range/);
    expect(await executeTool('delete_lines', { path: 'a.js', start_line: 3, end_line: 2 }, c)).toMatch(/^Error: end_line 2 is before/);
    expect(await executeTool('replace_lines', { path: 'a.js', start_line: 1, end_line: 9, content: 'x' }, c)).toMatch(/^Error: end_line 9 is out of range/);
    expect(await executeTool('insert_lines', { path: 'a.js', after_line: 4, content: 'x' }, c)).toMatch(/^Error: after_line must be between 0 and 3/);
    expect(fs.readFileSync(path.join(root, 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
    fs.writeFileSync(path.join(root, 'w.txt'), 'a\r\nb\r\nc');
    await executeTool('replace_lines', { path: 'w.txt', start_line: 2, content: 'B1\nB2' }, c);
    expect(fs.readFileSync(path.join(root, 'w.txt'), 'utf8')).toBe('a\r\nB1\r\nB2\r\nc');
    await executeTool('insert_lines', { path: 'w.txt', after_line: 3, content: 'd' }, c);
    expect(fs.readFileSync(path.join(root, 'w.txt'), 'utf8')).toBe('a\r\nB1\r\nB2\r\nd\r\nc');
  });
  it('steers the model: rewriting an existing file suggests line tools, a failed line edit suggests a full rewrite', async () => {
    const c = base();
    expect(await executeTool('write_file', { path: 'fresh.txt', content: 'x' }, c)).not.toMatch(/prefer replace_lines/);
    expect(await executeTool('write_file', { path: 'a.js', content: 'new' }, c)).toMatch(/Wrote a\.js[\s\S]*prefer replace_lines[\s\S]*read_file/);
    expect(await executeTool('replace_lines', { path: 'a.js', start_line: 9, content: 'x' }, c)).toMatch(/^Error:[\s\S]*read_file[\s\S]*rewrite the whole file with write_file/);
  });
  it('turns file-system errors into actionable results', async () => {
    const c = base();
    fs.mkdirSync(path.join(root, 'dir')); fs.writeFileSync(path.join(root, 'dir', 'f.txt'), 'x'); fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    expect(await executeTool('replace_lines', { path: 'dir', start_line: 1, content: 'x' }, c)).toMatch(/^Error: EISDIR.*list_dir/);
    expect(await executeTool('write_file', { path: 'dir', content: 'x' }, c)).toMatch(/^Error: EISDIR.*directory/);
    expect(await executeTool('delete_lines', { path: 'nope.txt', start_line: 1 }, c)).toMatch(/^Error: no such file or directory.*write_file/);
    expect(await executeTool('insert_lines', { path: 'a.js/x', after_line: 0, content: 'x' }, c)).toMatch(/^Error: /);
    expect(await executeTool('delete_file', { path: 'dir' }, c)).toMatch(/^Error: ENOTEMPTY.*delete the files inside/);
    expect(await executeTool('replace_lines', { path: 'bin.dat', start_line: 1, content: 'x' }, c)).toMatch(/^Error: binary file/);
    expect(fs.readFileSync(path.join(root, 'bin.dat'))).toEqual(Buffer.from([1, 0, 2]));
  });
  it('expected / after_text catch stale line numbers and say where the text is now', async () => {
    const c = base(), f = path.join(root, 'a.js'), rd = () => fs.readFileSync(f, 'utf8');
    const stale = await executeTool('replace_lines', { path: 'a.js', start_line: 1, expected: 'two', content: 'X' }, c);
    expect(stale).toMatch(/^Error: .*nothing was changed[\s\S]*1\tone[\s\S]*now at line 2/);
    expect(await executeTool('delete_lines', { path: 'a.js', start_line: 3, expected: 'nowhere' }, c)).toMatch(/does not appear anywhere/);
    expect(await executeTool('insert_lines', { path: 'a.js', after_line: 1, after_text: 'three', content: 'Y' }, c)).toMatch(/now at line 3/);
    expect(rd()).toBe('one\ntwo\nthree\n');
    expect(await executeTool('replace_lines', { path: 'a.js', start_line: 2, expected: 'two  ', content: 'A\nB' }, c)).toMatch(/file now 4 lines; lines below shifted by \+1; new text is at lines 2–3/);
    expect(await executeTool('insert_lines', { path: 'a.js', after_line: 3, after_text: 'B', content: 'C' }, c)).toMatch(/after line 3 in a\.js \(file now 5 lines/);
    expect(await executeTool('delete_lines', { path: 'a.js', start_line: 2, end_line: 3, expected: 'A\nB' }, c)).toMatch(/Deleted 2 lines.*file now 3 lines; lines below shifted by -2/);
    expect(rd()).toBe('one\nC\nthree\n');
  });
  it('get_file_metadata reports what is on disk now; errors from file tools end with the same state', async () => {
    const c = base();
    const m = await executeTool('get_file_metadata', { path: 'a.js' }, c);
    expect(m).toMatch(/^a\.js: 3 lines, 14 bytes, hash [0-9a-f]{16}, LF, ends with a newline$/);
    const hash = m.match(/hash ([0-9a-f]{16})/)[1];
    const err = await executeTool('replace_lines', { path: 'a.js', start_line: 9, content: 'x' }, c);
    expect(err).toMatch(/^Error: start_line 9 is out of range/);
    expect(err).toContain(`Current state on disk: a.js: 3 lines, 14 bytes, hash ${hash}`);
    await executeTool('replace_lines', { path: 'a.js', start_line: 1, content: 'ONE' }, c);
    expect(await executeTool('get_file_metadata', { path: 'a.js' }, c)).not.toContain(hash); // the hash follows the content
    fs.mkdirSync(path.join(root, 'dir2')); fs.writeFileSync(path.join(root, 'dir2', 'f'), 'x');
    expect(await executeTool('get_file_metadata', { path: 'dir2' }, c)).toBe('dir2: a directory with 1 entry');
    expect(await executeTool('get_file_metadata', { path: 'dir2/nope/x.txt' }, c)).toBe('dir2/nope/x.txt: does not exist (nearest existing folder: dir2)');
    const isDir = await executeTool('edit_file', { path: 'dir2', old_string: 'a', new_string: 'b' }, c);
    expect(isDir).toMatch(/^Error: EISDIR\. The path 'dir2' was expected to be a file but the OS identified it as a directory[^\n]*\nCurrent state on disk: dir2: a directory with 1 entry/);
    expect(await executeTool('delete_lines', { path: 'gone.txt', start_line: 1 }, c)).toMatch(/^Error: no such file or directory \(ENOENT\)\. The path 'gone\.txt' does not exist[\s\S]*does not exist \(nearest existing folder: \.\)/);
    expect(await executeTool('get_file_metadata', { path: '.env' }, c)).toMatch(/secrets policy/);
    expect(await executeTool('replace_lines', { path: '.env', start_line: 1, content: 'x' }, c)).not.toMatch(/hash/); // nothing about a blocked file leaks
    expect(await executeTool('get_file_metadata', { path: '../x' }, c)).toMatch(/^Error:/);
    expect(names(base({ agentMode: 'plan' }))).toContain('get_file_metadata');
  });
  it('line tools respect the secrets policy', async () => {
    expect(await executeTool('delete_lines', { path: '.env', start_line: 1 }, base())).toMatch(/secrets policy/);
  });
  it('blocks path traversal and secrets', async () => {
    expect(await executeTool('read_file', { path: '../etc/passwd' }, base())).toMatch(/^Error:/);
    expect(await executeTool('write_file', { path: '/tmp/x', content: 'x' }, base())).toMatch(/^Error:/);
    expect(await executeTool('read_file', { path: '.env' }, base())).toMatch(/secrets policy/);
    expect(await executeTool('write_file', { path: 'k.pem', content: 'x' }, base())).toMatch(/secrets policy/);
    expect(await executeTool('search', { pattern: 'KEY' }, base())).toBe('No matches');
  });
  it('rejects binary files and bad regex', async () => {
    fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([0, 1, 2]));
    expect(await executeTool('read_file', { path: 'b.bin' }, base())).toMatch(/binary/);
    expect(await executeTool('search', { pattern: '(' }, base())).toMatch(/invalid/);
  });
  it('search explains fs errors instead of returning a bare code', async () => {
    expect(await executeTool('search', { pattern: 'one', path: 'a.js' }, base())).toMatch(/^Error: ENOTDIR\. The path 'a\.js' is a file[\s\S]*read_file/);
    expect(await executeTool('search', { pattern: 'one', path: 'a.js/x' }, base())).toMatch(/^Error: ENOTDIR\. .*list_dir|^Error: ENOTDIR\. .*search needs a directory/);
    expect(await executeTool('search', { pattern: 'one', path: 'nope' }, base())).toMatch(/ENOENT.*nope/);
  });
  it('create_checkpoint creates an agent-authored checkpoint', async () => {
    const out = await executeTool('create_checkpoint', { label: 'before refactor' }, base());
    expect(out).toMatch(/Checkpoint created/);
    const cps = await listCheckpoints(1, root, data);
    expect(cps[0]).toMatchObject({ label: 'before refactor', author: 'agent' });
  });
});

describe('execution-mode gating', () => {
  it('files_only omits run_command and rejects direct calls', async () => {
    const c = base({ execMode: 'files_only' });
    expect(names(c)).not.toContain('run_command');
    expect(await executeTool('run_command', { command: 'echo hi' }, { ...c, approve: async () => true }).catch((e) => e.message)).toMatch(/unavailable/);
  });
  it('workspace_shell includes run_command only with agent.shell.run', () => {
    expect(names(base({ execMode: 'workspace_shell' }))).toContain('run_command');
    expect(names(base({ execMode: 'workspace_shell', permissions: new Set(['agent.act']) }))).not.toContain('run_command');
  });
  it('run_command needs approval, is scrubbed, capped, and checkpoints first', async () => {
    process.env.SUPER_SECRET_VAR = 'leak';
    const c = base({ execMode: 'workspace_shell', approve: async () => true });
    const out = await executeTool('run_command', { command: 'echo hello; echo "[$SUPER_SECRET_VAR]"; pwd' }, c);
    expect(out).toContain('exit=0'); expect(out).toContain('hello'); expect(out).toContain('[]');
    expect(out).toContain(fs.realpathSync(root));
    expect((await listCheckpoints(1, root, data))[0].label).toMatch(/^Before: echo hello/);
    const denied = await executeTool('run_command', { command: 'touch nope' }, { ...c, approve: async () => false });
    expect(denied).toMatch(/denied/); expect(fs.existsSync(path.join(root, 'nope'))).toBe(false);
  });
  it('passes the sidecar message back with either answer; only an explicit allow runs the command', async () => {
    const c = base({ execMode: 'workspace_shell' });
    const allowed = await executeTool('run_command', { command: 'echo hi' }, { ...c, approve: async () => ({ allowed: true, message: 'be careful' }) });
    expect(allowed).toContain('exit=0'); expect(allowed).toMatch(/Message from the user: be careful/);
    const denied = await executeTool('run_command', { command: 'touch nope2' }, { ...c, approve: async () => ({ allowed: false, message: 'use npm ci' }) });
    expect(denied).toMatch(/denied/); expect(denied).toMatch(/Message from the user: use npm ci/); expect(fs.existsSync(path.join(root, 'nope2'))).toBe(false);
    expect(await executeTool('run_command', { command: 'touch nope3' }, { ...c, approve: async () => ({ message: 'x' }) })).toMatch(/denied/); // no explicit allow
    expect(fs.existsSync(path.join(root, 'nope3'))).toBe(false);
  });
  it('shell enforces timeout and output cap', async () => {
    const t = await runShell('sleep 5', root, { timeoutSec: 1, outputCap: 100 });
    expect(t.timedOut).toBe(true);
    const o = await runShell('yes | head -c 5000', root, { timeoutSec: 5, outputCap: 100 });
    expect(o.output).toContain('[output truncated]');
  });
});

describe('plan mode is read-only', () => {
  const mutating = ['write_file', 'edit_file', 'replace_lines', 'delete_lines', 'insert_lines', 'delete_file', 'create_checkpoint', 'run_command'];
  it.each(['files_only', 'workspace_shell'])('registry excludes every mutating tool (%s)', (execMode) => {
    const n = names(base({ agentMode: 'plan', execMode }));
    for (const m of mutating) expect(n).not.toContain(m);
    expect(n).toEqual(expect.arrayContaining(['read_file', 'list_dir', 'search', 'propose_plan']));
  });
  it('direct execution throws PlanModeViolation and leaves disk unchanged', async () => {
    const violations = [];
    const c = base({ agentMode: 'plan', execMode: 'workspace_shell', approve: async () => true, onViolation: (t) => violations.push(t) });
    const before = fs.readdirSync(root).sort();
    for (const [tool, args] of [['write_file', { path: 'x.txt', content: 'x' }], ['edit_file', { path: 'a.js', old_string: 'one', new_string: 'ONE' }],
      ['delete_file', { path: 'a.js' }], ['create_checkpoint', { label: 'x' }], ['run_command', { command: 'touch pwned' }]]) {
      await expect(executeTool(tool, args, c)).rejects.toBeInstanceOf(PlanModeViolation);
    }
    expect(violations).toEqual(mutating.slice(0, 0).concat(['write_file', 'edit_file', 'delete_file', 'create_checkpoint', 'run_command']));
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(root, 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(await listCheckpoints(1, root, data)).toEqual([]);
  });
  it('act mode cannot propose_plan; plan mode can', () => {
    expect(names(base({ agentMode: 'act' }))).not.toContain('propose_plan');
  });
});
