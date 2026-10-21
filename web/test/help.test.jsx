import { describe, it, expect } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, useLocation } from 'react-router-dom';
import Help from '../src/pages/Help.jsx';
import Layout from '../src/components/Layout.jsx';
import { TOPICS, GROUPS } from '../src/help/content.js';
import { PROVIDER_TYPES } from '../../server/src/llm/provider.js';
import { PERMISSION_TEXT } from '../src/help/permissions.js';
import { visibleTopics, bodyOf, linkVisible, allowed } from '../src/help/visible.js';
import { ALL_PERMISSIONS, BUILTIN_ROLES } from '../../server/src/permissions.js';
import { renderApp, userWith, ADMIN, ALL } from './helpers.jsx';

const canOf = (perms) => (p) => perms.includes(p);
const ids = (perms) => visibleTopics(canOf(perms)).map((t) => t.id);
const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
const page = (user, route = '/help') => renderApp(<><Routes><Route path="/help/:topic?" element={<Help />} /></Routes><Where /></>, { user, route });

describe('the documentation itself', () => {
  it('has unique topics in known groups, each with content', () => {
    expect(new Set(TOPICS.map((t) => t.id)).size).toBe(TOPICS.length);
    for (const t of TOPICS) { expect(GROUPS, t.id).toContain(t.group); expect(t.title.length, t.id).toBeGreaterThan(2); if (!t.dynamic) expect(t.body.trim().length, t.id).toBeGreaterThan(40); }
  });
  it('only asks for permissions that exist, and describes every one of them', () => {
    const asked = TOPICS.flatMap((t) => (!t.requires ? [] : typeof t.requires === 'string' ? [t.requires] : t.requires.any || t.requires.all));
    for (const p of asked) expect(ALL_PERMISSIONS, p).toContain(p);
    expect(Object.keys(PERMISSION_TEXT).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
  it('uses the active voice (no "is/are + past participle" constructions)', () => {
    const passive = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(?:\w+(?:ed|en)|shown|made|done|given|kept|set|run|built|sent|written|held|seen|left|lost)\b/gi;
    for (const t of TOPICS.filter((x) => !x.dynamic)) expect([...t.body.matchAll(passive)].map((m) => m[0]), t.id).toEqual([]);
  });
  it('speaks to the reader in a friendly way and avoids jargon-heavy filler', () => {
    const personal = TOPICS.filter((t) => !t.dynamic && /\b(you|your)\b/i.test(t.body)).length; expect(personal / TOPICS.filter((t) => !t.dynamic).length).toBeGreaterThan(0.6);
    for (const t of TOPICS.filter((x) => !x.dynamic)) expect(t.body, t.id).not.toMatch(/\b(utilize|leverage|in order to|please note that|it should be noted)\b/i);
  });
  it('every link between topics points at a topic that exists', () => {
    const known = new Set(TOPICS.map((t) => t.id));
    for (const t of TOPICS) for (const m of t.body.matchAll(/\]\(#([a-z0-9-]+)\)/g)) expect(known, `${t.id} -> ${m[1]}`).toContain(m[1]);
  });
  it('documents every built-in skill and the slash commands by name', () => {
    const all = TOPICS.map((t) => t.body).join('\n');
    for (const c of ['/code-review', '/security-review', '/write-tests', '/debug', '/refactor', '/explain-code', '/document', '/compact', '/clear']) expect(all, c).toContain(c);
  });
});

describe('integration guides', () => {
  const guides = TOPICS.filter((t) => t.group === 'Integration guides');
  const GUIDE_FOR = { openai: 'ai-openai', anthropic: 'ai-anthropic', gemini: 'ai-gemini', mistral: 'ai-mistral', bedrock: 'ai-bedrock', vertex: 'ai-vertex', azure: 'ai-azure', lmstudio: 'ai-lmstudio', ollama: 'ai-ollama', generic: 'ai-generic' };
  it('cover every provider type the server supports, so a new type cannot ship without a guide', () => {
    expect(Object.keys(GUIDE_FOR).sort()).toEqual([...PROVIDER_TYPES].sort());
    for (const id of Object.values(GUIDE_FOR)) expect(guides.map((g) => g.id), id).toContain(id);
  });
  it('are linked from the chooser, which comes first, and each tells the admin where to go', () => {
    expect(guides[0].id).toBe('ai-providers');
    for (const id of Object.values(GUIDE_FOR)) expect(guides[0].body, id).toContain(`](#${id})`);
    for (const id of Object.values(GUIDE_FOR)) expect(guides.find((g) => g.id === id).body, id).toContain('Go to **Admin**, then **Server (AI services)**, and select **Add connection**.');
  });
  it('are visible to people who manage AI connections, and to nobody else', () => {
    expect(ids(['provider.read'])).toEqual(expect.arrayContaining(guides.map((g) => g.id)));
    expect(ids(['settings.read', 'user.read'])).not.toContain('ai-openai');
    expect(ids(BUILTIN_ROLES.developer.permissions).filter((i) => guides.some((g) => g.id === i))).toEqual([]);
  });
  it('name the credential format the server expects', () => {
    const body = (id) => guides.find((g) => g.id === id).body;
    expect(body('ai-bedrock')).toContain('ACCESS_KEY_ID:SECRET_ACCESS_KEY:SESSION_TOKEN'); expect(body('ai-vertex')).toContain('roles/aiplatform.user'); expect(body('ai-azure')).toContain('https://<resource>.openai.azure.com');
    expect(body('ai-ollama')).toContain('http://localhost:11434/v1'); expect(body('ai-lmstudio')).toContain('http://localhost:1234/v1');
  });
});

describe('who sees which topics', () => {
  const dev = BUILTIN_ROLES.developer.permissions, admin = ALL_PERMISSIONS;
  it('everyone gets the basics, even with no permissions', () => { expect(ids([])).toEqual(['welcome', 'signing-in', 'your-access', 'ai-basics', 'agentic-coding', 'ai-safety', 'profile', 'appearance', 'glossary', 'troubleshooting']); });
  it('a developer gets building help but no administration help', () => {
    const d = ids(dev);
    for (const t of ['workspace', 'projects', 'editor', 'files', 'git-download', 'agent-basics', 'plan-act', 'sessions', 'skills', 'my-skills', 'checkpoints', 'subagents', 'chat', 'prompts', 'shortcuts']) expect(d, t).toContain(t);
    expect(d.filter((t) => t.startsWith('admin-'))).toEqual([]); expect(d).not.toContain('terminal'); expect(d).not.toContain('permissions'); // shell access is not part of the developer role
  });
  it('an administrator gets everything', () => { expect(ids(admin).length).toBe(TOPICS.length); });
  it('topics follow individual permissions', () => {
    expect(ids(['files.read'])).toEqual(expect.arrayContaining(['editor', 'files', 'shortcuts'])); expect(ids(['files.read'])).not.toContain('agent-basics');
    expect(ids(['chat.use'])).toEqual(expect.arrayContaining(['chat', 'skills'])); expect(ids(['chat.use'])).not.toContain('plan-act');
    expect(ids(['terminal.use'])).toContain('terminal'); expect(ids(['agent.shell.run'])).toContain('terminal');
    expect(ids(['download.code'])).toContain('git-download'); expect(ids(['git.commit'])).toContain('git-download');
    expect(ids(['idp.read'])).toEqual(expect.arrayContaining(['admin-overview', 'admin-saml'])); expect(ids(['idp.read'])).not.toContain('admin-ai');
    expect(ids(['settings.write'])).toContain('admin-shell'); expect(ids(['settings.read'])).not.toContain('admin-shell');
    expect(ids(['role.read'])).toEqual(expect.arrayContaining(['admin-users', 'permissions']));
    expect(ids(['profile.skills.edit'])).toContain('my-skills'); expect(ids(['profile.prompt.edit'])).toContain('prompts');
    expect(allowed({ requires: { any: ['a', 'b'] } }, canOf(['b']))).toBe(true);
    expect(allowed({ requires: { all: ['a', 'b'] } }, canOf(['b']))).toBe(false);
    expect(allowed({ requires: { all: ['a', 'b'] } }, canOf(['a', 'b']))).toBe(true);
  });
  it('links to hidden topics become plain text instead of dead links', () => {
    const md = 'See [Plan mode](#plan-act) and [Shell](#admin-shell).'; expect(linkVisible(md, new Set(['plan-act']))).toBe('See [Plan mode](#plan-act) and Shell.');
  });
});

describe('generated topics', () => {
  it('"What you can do" lists exactly the abilities of the reader, in plain words', () => {
    const md = bodyOf(TOPICS.find((t) => t.id === 'your-access'), { permissions: ['project.read', 'files.read', 'agent.plan'], roles: ['reviewer'] });
    expect(md).toContain('**reviewer**'); expect(md).toContain('See your projects'); expect(md).toContain('Open and read project files'); expect(md).toContain('Plan with the agent'); expect(md).not.toContain('Let the agent change your files'); expect(md).not.toMatch(/Administration/);
  });
  it('says so kindly when a role has no permissions, and handles several roles', () => {
    expect(bodyOf(TOPICS.find((t) => t.id === 'your-access'), { permissions: [], roles: ['empty'] })).toMatch(/doesn't include any permissions yet. Ask an administrator/);
    expect(bodyOf(TOPICS.find((t) => t.id === 'your-access'), { permissions: ['chat.use'], roles: ['a', 'b'] })).toContain('the roles **a, b**');
  });
  it('the permission reference marks the permissions you hold', () => {
    const md = bodyOf(TOPICS.find((t) => t.id === 'permissions'), { permissions: ['files.read'] });
    expect(md).toMatch(/\| `files.read` \| Open and read project files \| ✓ \|/); expect(md).toMatch(/\| `files.write` \| [^|]+ \| {2}\|/); expect(md.split('\n').filter((l) => l.startsWith('| `')).length).toBe(ALL_PERMISSIONS.length);
  });
});

describe('Help page', () => {
  it('opens on the first topic and lists topics by group, for a developer', async () => {
    page(userWith(ALL));
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Help topics' });
    expect(within(nav).getByText('Get started')).toBeInTheDocument(); expect(within(nav).getByText('Work with the agent')).toBeInTheDocument(); expect(within(nav).queryByText('Administer')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Plan mode and Act mode' })).toBeInTheDocument(); expect(within(nav).queryByRole('link', { name: 'Single sign-on (SAML)' })).toBeNull();
  });
  it('shows administration help to administrators', async () => {
    page(userWith(ADMIN)); const nav = await screen.findByRole('navigation', { name: 'Help topics' });
    expect(within(nav).getByText('Administer')).toBeInTheDocument(); expect(within(nav).getByRole('link', { name: 'Single sign-on (SAML)' })).toBeInTheDocument(); expect(within(nav).getByRole('link', { name: 'Permission reference' })).toBeInTheDocument();
  });
  it('a user with no permissions still gets useful help', async () => {
    page(userWith([], { roles: ['nobody'] })); const nav = await screen.findByRole('navigation', { name: 'Help topics' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Welcome', 'Sign in and stay secure', 'What you can do', 'AI models, tokens, and context', 'What is agentic coding?', 'Use AI safely', 'Your profile', 'Appearance and accessibility', 'Glossary', 'Troubleshooting']);
  });
  it('opens a topic from its address, and navigates when you click', async () => {
    page(userWith(ALL), '/help/sessions'); expect(await screen.findByRole('heading', { level: 1, name: 'Sessions and long conversations' })).toBeInTheDocument(); expect(screen.getByText('Work with the agent', { selector: 'span' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Help topics' })).getByRole('link', { name: 'Checkpoints and rollback' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Checkpoints and rollback' })).toBeInTheDocument(); expect(screen.getByTestId('where')).toHaveTextContent('/help/checkpoints');
  });
  it('falls back to the first topic for an unknown or hidden one (no peeking at admin help)', async () => {
    page(userWith(ALL), '/help/admin-saml'); expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
  });
  it('renders Markdown: lists, bold, code, and tables', async () => {
    page(userWith(ADMIN), '/help/admin-overview'); expect(await screen.findByRole('table')).toBeInTheDocument(); expect(screen.getByRole('cell', { name: 'Audit log' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Help topics' })).getByRole('link', { name: 'Keyboard shortcuts' })); expect(await screen.findByRole('cell', { name: 'Ctrl / ⌘ + S' })).toBeInTheDocument();
  });
  it('links between topics navigate inside the page and never open a new tab', async () => {
    page(userWith(ALL)); const link = await screen.findByRole('link', { name: 'What you can do' }, { selector: 'main a' }).catch(() => null);
    const inline = screen.getAllByRole('link', { name: 'What you can do' }).find((a) => a.closest('main')); expect(inline).toBeTruthy(); expect(inline).not.toHaveAttribute('target');
    await userEvent.click(inline); expect(await screen.findByRole('heading', { level: 1, name: 'What you can do' })).toBeInTheDocument(); expect(screen.getByTestId('where')).toHaveTextContent('/help/your-access');
    void link;
  });
  it('shows a personalized "What you can do" with the reader\'s roles', async () => {
    page(userWith(['project.read', 'files.read', 'agent.plan'], { roles: ['reviewer'] }), '/help/your-access'); expect(await screen.findByText('reviewer')).toBeInTheDocument(); expect(screen.getByText('See your projects')).toBeInTheDocument(); expect(screen.queryByText('Let the agent change your files (Act mode)')).toBeNull();
  });
  it('has previous and next links through the visible topics only', async () => {
    page(userWith([], { roles: ['nobody'] }), '/help/signing-in'); await screen.findByRole('heading', { level: 1, name: 'Sign in and stay secure' });
    expect(screen.getByRole('link', { name: '← Welcome' })).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'What you can do →' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: '← Welcome' })); expect(screen.queryByRole('link', { name: /^←/ })).toBeNull();
  });
  it('searches titles and text, only among topics you can see', async () => {
    page(userWith(ALL)); const box = await screen.findByLabelText('Search help'); const nav = screen.getByRole('navigation', { name: 'Help topics' });
    await userEvent.type(box, 'compact'); expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(expect.arrayContaining(['Sessions and long conversations', 'Skills and slash commands'])); expect(within(nav).queryByRole('link', { name: 'Your profile' })).toBeNull();
    await userEvent.clear(box); await userEvent.type(box, 'adfs'); expect(within(nav).queryByRole('link', { name: 'Single sign-on (SAML)' })).toBeNull(); expect(within(nav).getByText(/No topics match/)).toBeInTheDocument();
    await userEvent.clear(box); await userEvent.type(box, 'layout drag'); expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toContain('Your workspace and layout');
  });
});

describe('Help in the header', () => {
  it('every signed-in user sees a Help link, whatever their role', async () => {
    renderApp(<Layout><div /></Layout>, { user: userWith([], { roles: ['nobody'] }) });
    expect(await screen.findByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
  });
  it('shows it alongside the other pages for a developer', async () => {
    renderApp(<Layout><div /></Layout>, { user: userWith(ALL) }); await screen.findByRole('link', { name: 'Help' });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link').map((l) => l.textContent)).toEqual(['Agent', 'Chat', 'Profile', 'Help']);
  });
});
