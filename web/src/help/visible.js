import { TOPICS, GROUPS } from './content.js';
import { PERMISSION_TEXT } from './permissions.js';

export const allowed = (t, can) => !t.requires || (typeof t.requires === 'string' ? can(t.requires) : t.requires.all ? t.requires.all.every(can) : t.requires.any.some(can));
export const visibleTopics = (can) => TOPICS.filter((t) => allowed(t, can));
export const groupsOf = (topics) => GROUPS.map((g) => ({ group: g, topics: topics.filter((t) => t.group === g) })).filter((g) => g.topics.length);

// Topics whose text depends on who is reading.
export function bodyOf(topic, { permissions = [], roles = [] } = {}) {
  if (topic.dynamic === 'access') {
    const has = new Set(permissions), byGroup = new Map();
    for (const [perm, [group, text]] of Object.entries(PERMISSION_TEXT)) if (has.has(perm)) byGroup.set(group, [...(byGroup.get(group) || []), text]);
    if (!byGroup.size) return `Your role${roles.length === 1 ? '' : 's'} (${roles.join(', ') || 'none'}) ${roles.length === 1 ? "doesn't" : "don't"} include any permissions yet. Ask an administrator to update your access.`;
    return `You hold ${roles.length === 1 ? 'the role' : 'the roles'} **${roles.join(', ') || 'none'}**. That lets you:\n\n${[...byGroup].map(([g, items]) => `## ${g}\n${items.map((i) => `- ${i}`).join('\n')}`).join('\n\n')}\n\nMissing something? Ask an administrator to change your role or group.`;
  }
  if (topic.dynamic === 'permissions') {
    const has = new Set(permissions);
    return `Every permission is separate, so you can grant exactly what a role needs. A ✓ marks the ones you hold.\n\n| Permission | What it allows | You |\n|---|---|---|\n${Object.entries(PERMISSION_TEXT).map(([p, [, text]]) => `| \`${p}\` | ${text} | ${has.has(p) ? '✓' : ''} |`).join('\n')}`;
  }
  return topic.body.trim();
}

// Links to topics this user cannot see become plain text, so the page never has a dead link.
export function linkVisible(md, visibleIds) {
  return md.replace(/\[([^\]]+)\]\(#([a-z0-9-]+)\)/g, (m, text, id) => (visibleIds.has(id) ? m : text));
}
export function matches(topic, q, text) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${topic.title} ${text}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
