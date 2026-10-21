import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { config } from '../config.js';

// Shadow git repo kept OUTSIDE the project (GIT_DIR) so the user's own .git is never touched.
const ID = /^[0-9a-f]{40}$/;
const active = new Map(); // projectId -> number of running agent turns (sessions may overlap)

export const setTurnActive = (projectId, on) => { const n = (active.get(projectId) || 0) + (on ? 1 : -1); if (n > 0) active.set(projectId, n); else active.delete(projectId); };
export const isTurnActive = (projectId) => active.has(projectId);

function gitFor(projectId, workTree, dataDir = config.dataDir) {
  const gitDir = path.join(dataDir, 'checkpoints', `${projectId}.git`);
  const fresh = !fs.existsSync(path.join(gitDir, 'HEAD'));
  fs.mkdirSync(gitDir, { recursive: true });
  const base = simpleGit({ baseDir: workTree, unsafe: { allowUnsafeConfigPaths: true } }); // paths are server-generated, never user input
  base.env({
    PATH: process.env.PATH, HOME: gitDir,
  });
  // Global flags (not env vars) select the shadow repo; the project's own .git is never consulted.
  const git = { raw: (args) => base.raw([`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args]) };
  return { git, gitDir, fresh };
}

async function ensure(projectId, workTree, dataDir) {
  const g = gitFor(projectId, workTree, dataDir);
  if (g.fresh) {
    await g.git.raw(['init', '-q']);
    await g.git.raw(['config', 'user.name', 'Checkpoint']);
    await g.git.raw(['config', 'user.email', 'checkpoint@localhost']);
    await g.git.raw(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(g.gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(g.gitDir, 'info', 'exclude'), '.git/\nnode_modules/\n');
  }
  return g;
}

export async function createCheckpoint(projectId, workTree, { label = 'Checkpoint', author = 'user', dataDir } = {}) {
  const { git } = await ensure(projectId, workTree, dataDir);
  await git.raw(['add', '-A']);
  const msg = `${label}\n\nauthor: ${author}`;
  await git.raw(['commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', msg]);
  const id = (await git.raw(['rev-parse', 'HEAD'])).trim();
  return { id, label, author };
}

export async function listCheckpoints(projectId, workTree, dataDir) {
  const { git, fresh } = gitFor(projectId, workTree, dataDir);
  if (fresh) return [];
  const out = await git.raw(['log', '--format=%H%x1f%ct%x1f%B%x1e']).catch(() => '');
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [id, ts, body] = rec.split('\x1f');
    const m = /\n\s*author: (\w+)\s*$/.exec(body);
    return { id, ts: Number(ts), label: body.split('\n')[0], author: m ? m[1] : 'user' };
  });
}

export async function diffCheckpoint(projectId, workTree, id, dataDir) {
  if (!ID.test(id)) throw new Error('Invalid checkpoint id');
  const { git } = await ensure(projectId, workTree, dataDir);
  await git.raw(['add', '-A']);
  const files = (await git.raw(['diff', '--name-status', '--cached', id])).trim().split('\n').filter(Boolean)
    .map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; });
  const show = async (p) => git.raw(['show', `${id}:${p}`]).catch(() => '');
  return { files, show };
}

export async function restoreCheckpoint(projectId, workTree, id, { dataDir } = {}) {
  if (!ID.test(id)) throw new Error('Invalid checkpoint id');
  if (isTurnActive(projectId)) throw new Error('Cannot restore while the agent is running');
  const { git } = await ensure(projectId, workTree, dataDir);
  await git.raw(['cat-file', '-e', `${id}^{commit}`]);
  const before = await createCheckpoint(projectId, workTree, { label: 'Before restore', author: 'system', dataDir });
  await git.raw(['read-tree', '--reset', '-u', id]);
  await git.raw(['clean', '-fdq']); // untracked, non-ignored files created after the checkpoint
  const after = await createCheckpoint(projectId, workTree, { label: `Restored to ${id.slice(0, 8)}`, author: 'system', dataDir });
  return { before, after };
}

// Read-only: what differs between the working tree and a checkpoint (default: the latest). Never writes to the project
// or to the shadow repo, so it is safe in Plan mode.
export async function changesSince(projectId, workTree, id, { dataDir, maxDiffBytes = 60_000 } = {}) {
  const { git, fresh } = gitFor(projectId, workTree, dataDir);
  if (fresh) return { base: null, files: [], diff: '', note: 'No checkpoints exist yet, so there is nothing to compare against.' };
  if (id && !ID.test(id)) throw new Error('Invalid checkpoint id');
  const base = id || (await git.raw(['rev-parse', 'HEAD'])).trim();
  const tracked = (await git.raw(['diff', '--name-status', base])).trim().split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; });
  const untracked = (await git.raw(['ls-files', '--others', '--exclude-standard'])).trim().split('\n').filter(Boolean).map((path) => ({ status: 'A', path }));
  let diff = await git.raw(['diff', '--no-color', '-U3', base]);
  if (diff.length > maxDiffBytes) diff = diff.slice(0, maxDiffBytes) + '\n[diff truncated]';
  return { base, files: [...tracked, ...untracked], diff, note: untracked.length ? 'New untracked files are listed but their contents are not in the diff; read them with read_file.' : '' };
}
