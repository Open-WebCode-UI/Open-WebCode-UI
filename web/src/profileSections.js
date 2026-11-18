// The profile pages. The account menu under the user's name lists the ones the user can open.
export const PROFILE_SECTIONS = [
  { path: 'account', label: 'Account' },
  { path: 'prompts', label: 'System prompts', anyOf: ['agent.plan', 'chat.use', 'chat.general.use', 'chat.course.use'] },
  { path: 'skills', label: 'Agent skills', perm: 'agent.plan' },
  { path: 'chat-skills', label: 'Chat skills', anyOf: ['chat.use', 'chat.general.use', 'chat.course.use'] },
  { path: 'mcp', label: 'MCP servers', perm: 'mcp.use' },
  { path: 'memory', label: 'Memory', perm: 'memory.use' },
  { path: 'web-search', label: 'Web search', perm: 'websearch.use' },
  { path: 'security', label: 'Security' },
];

export const profileSectionsFor = (can) => PROFILE_SECTIONS.filter((s) => (s.perm ? can(s.perm) : s.anyOf ? s.anyOf.some(can) : true));
