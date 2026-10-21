import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { config } from '../config.js';

// Git run on behalf of a user against a project directory. The project's own .git/config is untrusted (it can come from an
// uploaded zip or be edited by the user or the agent), and several of its keys name programs git will execute (core.fsmonitor,
// core.hooksPath, diff.external, credential.helper, ...). So: config passed through the environment overrides them, the environment is scrubbed
// (no server secrets, no system/global config), and callers add only what they need (e.g. an Authorization header).
export const OVERRIDES = {
  'core.fsmonitor': 'false', 'core.hooksPath': '/dev/null', 'core.pager': 'cat', 'core.editor': 'true', 'core.askPass': '',
  'credential.helper': '', 'diff.external': '', 'protocol.ext.allow': 'never', 'protocol.file.allow': 'never',
};

// simple-git refuses to let callers set these keys; the values used here are the safe ones, never user input.
const UNSAFE_OK = Object.fromEntries(['ConfigEnvCount', 'FsMonitor', 'HooksPath', 'Pager', 'Editor', 'AskPass', 'CredentialHelper', 'DiffExternal', 'ProtocolOverride'].map((n) => [`allowUnsafe${n}`, true]));

// Overrides travel as GIT_CONFIG_COUNT/KEY_n/VALUE_n (same precedence as -c, above the repo's own config). An Authorization
// header for http(s) remotes is appended the same way, so a token is never written to .git/config or the command line.
export function safeGit(baseDir, { token } = {}) {
  const home = path.join(config.dataDir, 'git-home');
  fs.mkdirSync(home, { recursive: true });
  const entries = Object.entries(OVERRIDES);
  if (token) entries.push(['http.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]);
  const cfg = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => { cfg[`GIT_CONFIG_KEY_${i}`] = k; cfg[`GIT_CONFIG_VALUE_${i}`] = v; });
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: home, GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8', ...cfg };
  const git = simpleGit({ ...(baseDir ? { baseDir } : {}), unsafe: UNSAFE_OK, allowEnvironment: Object.keys(env).filter((k) => k.startsWith('GIT_')) });
  git.env(env);
  return git;
}
