// Semantic versioning (https://semver.org) for the releases this app publishes. A release is a git tag named vMAJOR.MINOR.PATCH
// whose package.json "version" is the same number. Pre-release and build-metadata tags are never offered as updates.

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;

export const isVersion = (v) => typeof v === 'string' && STABLE.test(v);
export const tagFor = (version) => `v${version}`;

export function parseVersion(v) {
  if (!isVersion(v)) return null;
  return v.split('.').map(Number);
}

// -1, 0 or 1, comparing major, then minor, then patch.
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new TypeError(`not a semantic version: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The highest stable version among git tag names such as "v1.2.0"; null when there is none.
export function latestRelease(tags) {
  let best = null;
  for (const tag of tags) {
    const m = RELEASE_TAG.exec(tag);
    if (m && (best === null || compareVersions(m[1], best) > 0)) best = m[1];
  }
  return best;
}

// Which part of the version changes going from one version to a newer one.
export function updateKind(from, to) {
  const [a, b, c] = parseVersion(from), [x, y, z] = parseVersion(to);
  if (x !== a) return 'major';
  if (y !== b) return 'minor';
  if (z !== c) return 'patch';
  return null;
}
