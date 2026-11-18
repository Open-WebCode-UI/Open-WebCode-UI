import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createUpdater, runProgram, UpdateError } from '../src/updates/updater.js';
import { compareVersions, latestRelease, updateKind, isVersion } from '../src/updates/semver.js';
import { freshDb, createApp, login, tmpDir } from './helpers.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const writeVersion = (dir, version) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version }, null, 2) + '\n');
const commit = (dir, version, msg) => { writeVersion(dir, version); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };

describe('semantic versions', () => {
  it('accepts only MAJOR.MINOR.PATCH and compares numerically', () => {
    expect(isVersion('1.2.3')).toBe(true);
    for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta.1', '01.2.3', '1.2.3+build', '']) expect(isVersion(bad)).toBe(false);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.9.1', '1.0.0')).toBe(-1);
  });
  it('picks the highest stable release tag and ignores other tags', () => {
    expect(latestRelease(['v1.0.0', 'v1.10.0', 'v1.9.0', 'v2.0.0-beta.1', 'release-9', 'v3.0.0+x'])).toBe('1.10.0');
    expect(latestRelease(['main', 'release-1'])).toBe(null);
  });
  it('names the kind of change', () => {
    expect(updateKind('1.2.3', '2.0.0')).toBe('major');
    expect(updateKind('1.2.3', '1.3.0')).toBe('minor');
    expect(updateKind('1.2.3', '1.2.4')).toBe('patch');
  });
});

describe('updater against a git repository', () => {
  let origin, app, calls, gate, failBuildOnce, updater, v1Commit;

  beforeEach(() => {
    origin = tmpDir('upd-origin-');
    git(origin, 'init', '-q', '-b', 'main');
    commit(origin, '1.0.0', 'release 1.0.0'); git(origin, 'tag', 'v1.0.0');
    commit(origin, '1.1.0', 'release 1.1.0'); git(origin, 'tag', 'v1.1.0');
    git(origin, 'tag', 'v2.0.0-beta.1'); // pre-release: must never be offered
    app = tmpDir('upd-app-');
    git(path.dirname(app), 'clone', '-q', origin, app);
    git(app, 'checkout', '-q', '--detach', 'v1.0.0');
    v1Commit = git(app, 'rev-parse', 'HEAD');

    calls = []; gate = null; failBuildOnce = false;
    const run = async (cmd, args, opts) => {
      if (cmd === 'git') return runProgram(cmd, args, opts);
      calls.push(`${cmd} ${args.join(' ')}`);
      if (gate) await gate;
      if (failBuildOnce && args.join(' ') === 'run build') { failBuildOnce = false; throw new Error('build broke'); }
      return '';
    };
    updater = createUpdater({ root: app, repoUrl: origin, run, runningVersion: '1.0.0' });
  });
  afterEach(() => { fs.rmSync(origin, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true }); });

  it('checks the repository for the newest stable release', async () => {
    await updater.check({ force: true });
    const s = await updater.status();
    expect(s.latest).toBe('1.1.0');
    expect(s.updateAvailable).toBe(true);
    expect(s.updateType).toBe('minor');
    expect(s.currentVersion).toBe('1.0.0');
    expect(s.restartRequired).toBe(false);
  });

  it('applies the newest release: checks out the tag, installs, builds, and asks for a restart', async () => {
    const seen = [];
    const { job, done } = await updater.startApply({ onFinish: (j) => seen.push(j.state) });
    expect(job.to).toBe('1.1.0');
    await done;
    expect(job.state).toBe('succeeded');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'v1.1.0^{commit}'));
    expect(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version).toBe('1.1.0');
    expect(calls).toEqual(['npm ci --no-audit --no-fund', 'npm run build']);
    expect(seen).toEqual(['succeeded']);
    const s = await updater.status();
    expect(s.currentVersion).toBe('1.1.0');
    expect(s.runningVersion).toBe('1.0.0');
    expect(s.restartRequired).toBe(true);
    expect(s.updateAvailable).toBe(false);
  });

  it('refuses when already up to date, and when asked for a version that is not newer or not valid', async () => {
    await updater.startApply().then((r) => r.done);
    await expect(updater.startApply()).rejects.toMatchObject({ code: 'no_update' });
    await expect(updater.startApply({ version: '1.1.0' })).rejects.toMatchObject({ code: 'not_newer' });
    await expect(updater.startApply({ version: '1.0.0' })).rejects.toMatchObject({ code: 'not_newer' });
    await expect(updater.startApply({ version: '1.2' })).rejects.toMatchObject({ code: 'invalid_version' });
  });

  it('refuses to update over local changes to tracked files', async () => {
    fs.appendFileSync(path.join(app, 'package.json'), '\n');
    await expect(updater.startApply()).rejects.toMatchObject({ code: 'dirty_tree', status: 409 });
    git(app, 'checkout', '--', 'package.json');
    const { done } = await updater.startApply(); // the lock was released, so a clean tree can update
    await done;
  });

  it('allows only one update at a time', async () => {
    let release;
    gate = new Promise((r) => { release = r; });
    const { done } = await updater.startApply();
    await expect(updater.startApply()).rejects.toMatchObject({ code: 'update_in_progress', status: 409 });
    release(); gate = null;
    await done;
    expect((await updater.status()).job.state).toBe('succeeded');
  });

  it('rolls back to the previous commit when the build fails', async () => {
    failBuildOnce = true;
    const { job, done } = await updater.startApply();
    await done;
    expect(job.state).toBe('failed');
    expect(job.rolledBack).toBe(true);
    expect(job.error).toMatch(/build broke/);
    expect(git(app, 'rev-parse', 'HEAD')).toBe(v1Commit);
    expect(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(job.log.join('\n')).toMatch(/Rolled back/);
    expect((await updater.status()).restartRequired).toBe(false);
  });

  it('refuses a release whose package.json version does not match its tag', async () => {
    commit(origin, '1.5.0', 'mislabelled'); git(origin, 'tag', 'v1.2.0');
    const { job, done } = await updater.startApply({ version: '1.2.0' });
    await done;
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/must carry the version of its tag/);
    expect(git(app, 'rev-parse', 'HEAD')).toBe(v1Commit);
    expect(calls).toEqual([]); // nothing was installed or built
  });

  it('reports a clear error when the repository cannot be reached', async () => {
    const broken = createUpdater({ root: app, repoUrl: path.join(origin, 'missing'), runningVersion: '1.0.0' });
    await expect(broken.check({ force: true })).rejects.toMatchObject({ code: 'check_failed', status: 502 });
  });

  it('refuses when the server was not installed from a git checkout', async () => {
    const plain = tmpDir('upd-plain-');
    writeVersion(plain, '1.0.0');
    const u = createUpdater({ root: plain, repoUrl: origin, runningVersion: '1.0.0' });
    await expect(u.startApply()).rejects.toBeInstanceOf(UpdateError);
    await expect(u.startApply()).rejects.toMatchObject({ code: 'not_a_checkout', status: 400 });
    expect((await u.status()).isCheckout).toBe(false);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('update routes', () => {
  beforeEach(async () => { await freshDb(); });

  it('lets administrators read the update status, and nobody else', async () => {
    const app = createApp();
    const admin = await login(app, { username: 'updadmin', roles: ['administrator'] });
    const dev = await login(app, { username: 'updDev' });
    expect((await dev.get('/api/admin/update')).status).toBe(403);
    const r = await admin.get('/api/admin/update');
    expect(r.status).toBe(200);
    expect(r.body.currentVersion).toBe('1.0.0');
    expect(r.body.restartRequired).toBe(false);
  });

  it('requires a recent step-up to apply an update', async () => {
    const app = createApp();
    const admin = await login(app, { username: 'updadmin2', roles: ['administrator'], stepup: false });
    const r = await admin.post('/api/admin/update/apply').send({});
    expect(r.status).toBe(403);
    expect(r.body.stepup).toBe(true);
  });
});
