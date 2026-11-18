import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { compareVersions, isVersion, latestRelease, tagFor, updateKind } from './semver.js';

// The checkout this server runs from (server/src/updates -> repository root).
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GIT_TIMEOUT_MS = 2 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const CHECK_TTL_MS = 10 * 60_000;
const LOG_LIMIT = 300;

const STATUS = { not_a_checkout: 400, invalid_version: 400, update_in_progress: 409, dirty_tree: 409, no_update: 409, not_newer: 409, check_failed: 502 };

export class UpdateError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.status = STATUS[code] ?? 500; }
}

// Runs a program directly, without a shell, so arguments are never interpreted. Rejects with the end of its error output.
export function runProgram(cmd, args, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const detail = `${stderr || stdout || err.message}`.trim().split('\n').slice(-12).join('\n');
      reject(new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${detail}`));
    });
  });
}

const publicJob = (j) => ({ ...j, log: [...j.log] });

// The update flow. Checking lists the release tags of the repository (git ls-remote). Applying fetches one tag, checks it out,
// verifies its package.json version matches the tag, installs and builds. If any step fails the previous commit is restored.
// The running process keeps the code it started with, so a restart is needed after a successful apply (status.restartRequired).
export function createUpdater({ root = APP_ROOT, repoUrl = config.updateRepo, run = runProgram, now = () => Date.now(), runningVersion } = {}) {
  const readVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const running = runningVersion ?? readVersion();
  const git = (args, timeout = GIT_TIMEOUT_MS) => run('git', args, { cwd: root, timeout });
  const npm = (args) => run(NPM, args, { cwd: root, timeout: INSTALL_TIMEOUT_MS });
  const isCheckout = () => fs.existsSync(path.join(root, '.git'));
  const isDirty = async () => (await git(['status', '--porcelain', '--untracked-files=no'], 30_000)).trim() !== '';
  let lastCheck = null, job = null, busy = false;

  async function check({ force = false } = {}) {
    if (!force && lastCheck && now() - lastCheck.at < CHECK_TTL_MS) return lastCheck;
    let out;
    try {
      out = await run('git', ['ls-remote', '--tags', '--refs', repoUrl], { cwd: root, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
      throw new UpdateError('check_failed', `Could not reach the release repository: ${e.message}`);
    }
    const tags = out.split('\n').map((line) => line.split('\t')[1]?.replace('refs/tags/', '')).filter(Boolean);
    lastCheck = { at: now(), latest: latestRelease(tags) };
    return lastCheck;
  }

  async function status() {
    const current = readVersion();
    const checkout = isCheckout();
    let dirty = null;
    if (checkout) { try { dirty = await isDirty(); } catch { dirty = null; } }
    const latest = lastCheck?.latest ?? null;
    const updateAvailable = !!latest && compareVersions(latest, current) > 0;
    return {
      currentVersion: current,
      runningVersion: running,
      restartRequired: current !== running,
      isCheckout: checkout,
      dirty,
      latest,
      checkedAt: lastCheck ? new Date(lastCheck.at).toISOString() : null,
      updateAvailable,
      updateType: updateAvailable ? updateKind(current, latest) : null,
      job: job ? publicJob(job) : null,
    };
  }

  // Validates the request and starts the job in the background. Resolves with the job and a promise that settles when it ends.
  // onFinish(job) is called once the job ends, with its final state.
  async function startApply({ version, onFinish = () => {} } = {}) {
    if (busy) throw new UpdateError('update_in_progress', 'An update is already running.');
    busy = true;
    let from, target, prev;
    try {
      if (!isCheckout()) throw new UpdateError('not_a_checkout', 'This server was not installed from a git checkout, so it cannot update itself. Reinstall it from the repository.');
      if (version !== undefined && !isVersion(version)) throw new UpdateError('invalid_version', 'The version must look like 1.2.3.');
      from = readVersion();
      if (await isDirty()) throw new UpdateError('dirty_tree', 'Tracked files have local changes, which an update would overwrite. Commit or discard them first.');
      if (version !== undefined) {
        if (compareVersions(version, from) <= 0) throw new UpdateError('not_newer', `${version} is not newer than the installed ${from}.`);
        target = version;
      } else {
        target = (await check({ force: true })).latest;
        if (!target || compareVersions(target, from) <= 0) throw new UpdateError('no_update', `Already up to date (${from}).`);
      }
      prev = (await git(['rev-parse', 'HEAD'])).trim();
    } catch (e) {
      busy = false;
      throw e;
    }
    job = { state: 'running', from, to: target, startedAt: new Date(now()).toISOString(), finishedAt: null, log: [], error: null, rolledBack: false };
    const done = runJob(job, prev, onFinish).finally(() => { busy = false; });
    return { job, done }; // the live object: its state and log change while the job runs
  }

  async function runJob(j, prev, onFinish) {
    const log = (msg) => {
      j.log.push(`${new Date(now()).toISOString()} ${msg}`);
      if (j.log.length > LOG_LIMIT) j.log.shift();
    };
    const tag = tagFor(j.to);
    let depsTouched = false;
    try {
      log(`Fetching ${tag}`);
      await git(['fetch', '--no-tags', repoUrl, `+refs/tags/${tag}:refs/tags/${tag}`]);
      await git(['-c', 'advice.detachedHead=false', 'checkout', '--detach', `refs/tags/${tag}`]);
      log(`Checked out ${tag}`);
      const tagged = readVersion();
      if (tagged !== j.to) throw new Error(`${tag} has package.json version ${tagged}; a release must carry the version of its tag`);
      depsTouched = true;
      log('Installing dependencies (npm ci)');
      await npm(['ci', '--no-audit', '--no-fund']);
      log('Building (npm run build)');
      await npm(['run', 'build']);
      j.state = 'succeeded';
      log(`Updated to ${j.to}. Restart the server to run it.`);
    } catch (e) {
      j.error = e.message;
      log(`Update failed: ${e.message}`);
      try {
        log(`Rolling back to ${prev.slice(0, 12)}`);
        await git(['checkout', '--detach', prev]);
        if (depsTouched) { await npm(['ci', '--no-audit', '--no-fund']); await npm(['run', 'build']); }
        j.rolledBack = true;
        log('Rolled back; the previous version is still in place.');
      } catch (e2) {
        log(`Rollback failed: ${e2.message}. Restore it by hand: git checkout ${prev}, then npm ci and npm run build.`);
      }
      j.state = 'failed';
    } finally {
      j.finishedAt = new Date(now()).toISOString();
    }
    try { await onFinish(publicJob(j)); } catch { /* auditing must not change the outcome */ }
  }

  return { check, status, startApply, readVersion, runningVersion: running };
}

export const updater = createUpdater();
