import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInJail, JailError, isSecretPath } from '../src/workspace/jail.js';
import { tmpDir } from './helpers.js';

let root, outside;
beforeAll(() => {
  root = tmpDir('jail-root-'); outside = tmpDir('jail-out-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'filelink'));
});

describe('workspace jail', () => {
  it('allows nested existing and not-yet-existing paths', () => {
    expect(resolveInJail(root, 'src/a.txt')).toBe(path.join(fs.realpathSync(root), 'src/a.txt'));
    expect(resolveInJail(root, 'src/new/deep/file.js')).toContain('new/deep/file.js');
    expect(resolveInJail(root, '.')).toBe(fs.realpathSync(root));
  });
  it.each(['../x', 'src/../../x', '/etc/passwd', 'C:\\Windows', 'a\0b'])('rejects %j', (p) => {
    expect(() => resolveInJail(root, p)).toThrow(JailError);
  });
  it('rejects symlink escapes (directory and file, existing, and new targets)', () => {
    expect(() => resolveInJail(root, 'link/secret.txt')).toThrow(/Symlink/);
    expect(() => resolveInJail(root, 'link/new.txt')).toThrow(/Symlink/);
    expect(() => resolveInJail(root, 'filelink')).toThrow(/Symlink/);
  });
  it('rejects non-string input', () => { expect(() => resolveInJail(root, null)).toThrow(JailError); });
  it('matches secret globs', () => {
    const g = ['.env', '.env.*', '*.pem', 'id_rsa*'];
    expect(isSecretPath('.env', g)).toBe(true);
    expect(isSecretPath('config/.env.production', g)).toBe(true);
    expect(isSecretPath('keys/server.pem', g)).toBe(true);
    expect(isSecretPath('src/env.js', g)).toBe(false);
  });
});
