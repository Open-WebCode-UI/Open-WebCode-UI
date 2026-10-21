import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import Markdown from '../src/components/Markdown.jsx';
import { buildTheme } from '../src/theme.js';
import { TOPICS } from '../src/help/content.js';
import { bodyOf } from '../src/help/visible.js';

const show = (md, props = { docs: true }, mode = 'light') => render(<ThemeProvider theme={buildTheme(undefined, mode)}><Markdown {...props}>{md}</Markdown></ThemeProvider>);

describe('emphasis syntax', () => {
  it('*one star* and _underscores_ are italic; **two stars** are bold; ***three*** are both', () => {
    const { container } = show('An *italic*, an _also italic_, a **bold**, and ***both*** word.');
    expect([...container.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['italic', 'also italic', 'both']);
    expect([...container.querySelectorAll('strong')].map((e) => e.textContent)).toEqual(['bold', 'both']);
  });
  it('does not italicize snake_case words or a lone asterisk', () => {
    const { container } = show('Set max_agent_steps to 5 * 3 and keep going.');
    expect(container.querySelector('em')).toBeNull();
  });
  it('italic works inside bold, lists, and table cells', () => {
    const { container } = show('**Bold with *italic* inside**\n\n- a *list* item\n\n| A | B |\n|---|---|\n| *cell* | x |');
    expect([...container.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['italic', 'list', 'cell']);
  });
});

describe('headings', () => {
  it('# to ###### render as h1 to h6', () => {
    show('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six');
    for (const [level, name] of [[1, 'One'], [2, 'Two'], [3, 'Three'], [4, 'Four'], [5, 'Five'], [6, 'Six']]) expect(screen.getByRole('heading', { level, name })).toBeInTheDocument();
  });
  it('seven hashes, or no space after them, are not headings', () => {
    show('####### Seven\n\n##NoSpace');
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });
  it('headings can hold bold, italic, and code', () => {
    show('## Press **Save** for *every* `page`');
    const h = screen.getByRole('heading', { level: 2 });
    expect(within(h).getByText('Save').tagName).toBe('STRONG'); expect(within(h).getByText('every').tagName).toBe('EM'); expect(within(h).getByText('page').tagName).toBe('CODE');
  });
});

describe('info, warning, and danger blocks', () => {
  it.each([['INFO', 'Info'], ['WARNING', 'Warning'], ['DANGER', 'Danger']])('> [!%s] renders a labelled note block', (marker, label) => {
    show(`> [!${marker}]\n> Be careful with **this**.`);
    const note = screen.getByRole('note', { name: label });
    expect(note).toHaveAttribute('data-admonition', marker.toLowerCase());
    expect(within(note).getByText(label)).toBeInTheDocument();                 // the label is text, so meaning never depends on color alone
    expect(within(note).getByText('this').tagName).toBe('STRONG');
    expect(note.textContent).not.toContain('[!');                              // the marker itself is not shown
    expect(note.closest('blockquote')).toBeNull();
  });
  it('the marker is case-insensitive and the block can hold lists, links, and code', () => {
    show('> [!warning]\n> Before you go:\n>\n> - step one\n> - step `two`\n>\n> See [the guide](#guide).');
    const note = screen.getByRole('note', { name: 'Warning' });
    expect(within(note).getAllByRole('listitem')).toHaveLength(2); expect(within(note).getByRole('link', { name: 'the guide' })).toBeInTheDocument(); expect(within(note).getByText('two').tagName).toBe('CODE');
  });
  it('the marker can sit on the same line as the text', () => {
    show('> [!INFO] Text on the first line.');
    expect(screen.getByRole('note', { name: 'Info' })).toHaveTextContent('Text on the first line.');
  });
  it('unknown markers and ordinary quotes stay plain blockquotes', () => {
    show('> [!NOTE]\n> nope\n\n> just a quote');
    expect(screen.queryByRole('note')).toBeNull(); expect(document.querySelectorAll('blockquote')).toHaveLength(2);
  });
  it('is only recognised in documentation, not in chat replies', () => {
    show('> [!DANGER]\n> model output', {});
    expect(screen.queryByRole('note')).toBeNull(); expect(document.querySelector('blockquote')).not.toBeNull();
  });
  it('is blue for info, amber for warning, and red for danger, in light and dark mode', () => {
    const edge = (kind, mode) => { const { unmount } = show(`> [!${kind}]\n> x`, { docs: true }, mode); const c = getComputedStyle(screen.getByRole('note')).borderLeftColor; unmount(); return c.match(/\d+/g).map(Number); };
    const hue = ([r, g, b]) => { const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max === min) return 0; const d = max - min; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round((h * 60 + 360) % 360); };
    for (const mode of ['light', 'dark']) {
      expect(hue(edge('INFO', mode)), `info ${mode}`).toBeGreaterThan(190); expect(hue(edge('INFO', mode))).toBeLessThan(250);       // blue
      expect(hue(edge('WARNING', mode)), `warning ${mode}`).toBeGreaterThan(30); expect(hue(edge('WARNING', mode))).toBeLessThan(55);  // amber
      const red = hue(edge('DANGER', mode)); expect(red === 0 || red > 345 || red < 10, `danger ${mode}`).toBe(true);                    // red
    }
  });
});

describe('the help articles follow the style rules', () => {
  const articles = TOPICS.map((t) => [t.id, bodyOf(t, { permissions: ['files.read', 'agent.plan'], roles: ['dev'] })]);
  const lines = (md) => { let fence = false; return md.split('\n').filter((l) => { if (l.trim().startsWith('```')) { fence = !fence; return false; } return !fence; }); };

  it('never use H1 (the article title is the only H1)', () => {
    for (const [id, md] of articles) expect(lines(md).filter((l) => /^#\s/.test(l)), id).toEqual([]);
  });
  it('start at H2 and never skip a level going down', () => {
    for (const [id, md] of articles) {
      let prev = 1;
      for (const l of lines(md)) { const m = /^(#{2,6})\s+\S/.exec(l); if (!m) continue; expect(m[1].length, `${id}: "${l}"`).toBeLessThanOrEqual(prev + 1); prev = m[1].length; }
    }
  });
  it('use headings, not a line of bold text, to start a section', () => {
    for (const [id, md] of articles) expect(lines(md).filter((l) => /^\*\*[^*]+\*\*:?$/.test(l.trim())), id).toEqual([]);
  });
  it('write callouts with a known kind', () => {
    for (const [id, md] of articles) for (const l of lines(md).filter((x) => /^>\s*\[!/.test(x))) expect(l, id).toMatch(/^>\s*\[!(INFO|WARNING|DANGER)\]/);
  });
  it('use callouts where they help: Administer has all three kinds', () => {
    const admin = articles.filter(([id]) => id.startsWith('admin-')).map(([, md]) => md).join('\n');
    for (const k of ['INFO', 'WARNING', 'DANGER']) expect(admin).toContain(`> [!${k}]`);
  });
});

describe('Administer articles tell the admin exactly where to go', () => {
  const body = (id) => TOPICS.find((t) => t.id === id).body;
  const adminIds = TOPICS.filter((t) => t.group === 'Administer').map((t) => t.id);

  it('are ordered as the work goes: orient, set up, sign-in and access, extend, monitor', () => {
    expect(adminIds).toEqual(['admin-overview', 'admin-how-it-works', 'admin-start', 'admin-general', 'admin-ai', 'admin-https', 'admin-branding', 'admin-saml', 'admin-users', 'admin-security', 'admin-extensions', 'admin-courses', 'admin-web-search', 'admin-shell', 'admin-reports', 'admin-audit']);
  });
  it('say how to create and update roles', () => {
    expect(body('admin-users')).toContain('Go to **Admin**, then **Users & roles**, then the **Roles** tab.');
  });
  it('say where IdP groups map to roles and where the default role is', () => {
    expect(body('admin-users')).toContain('Go to **Admin**, then **SAML**, then the **Group mapping** tab.');
    expect(body('admin-users')).toContain('**Default role (users with no mapped group)**');
  });
  it('say how to find the SAML service provider settings', () => {
    expect(body('admin-saml')).toContain('Go to **Admin**, then **SAML**, then the **Service provider** tab.');
  });
  it('name the Admin page for every page-level article', () => {
    for (const id of ['admin-general', 'admin-ai', 'admin-https', 'admin-branding', 'admin-saml', 'admin-users', 'admin-security', 'admin-courses', 'admin-web-search', 'admin-audit']) expect(body(id), id).toMatch(/Go to \*\*Admin\*\*, then \*\*[^*]+\*\*/);
  });
  it('use the real page names from the Admin list', () => {
    const real = ['General', 'Server (AI services)', 'MCP servers', 'Web search', 'HTTPS', 'Branding', 'Users & roles', 'SAML', 'Security (MFA)', 'Courses', 'Audit log'];
    const named = [...adminIds.map(body).join('\n').matchAll(/then \*\*([^*]+)\*\*/g)].map((m) => m[1]);
    for (const n of named) if (!/tab$/.test(n)) expect(real, n).toContain(n);
  });
  it('put buttons, toggles, tabs, and fields in bold', () => {
    const text = adminIds.map(body).join('\n');
    for (const label of ['Save SAML settings', 'Show users what each session costs', 'Add local user', 'New role', 'Save mappings', 'Run test sign-in', 'Auto-populate IdP metadata', 'Connect & load models', 'Test saved settings', 'Allow web search for this organization', 'Create a new certificate', 'Load older entries', 'Require MFA for everyone']) {
      expect(text, label).toContain(`**${label}**`);
      expect(text.replace(new RegExp(`\\*\\*${label.replace(/[()]/g, '\\$&')}\\*\\*`, 'g'), ''), `${label} appears without bold`).not.toContain(label);
    }
  });
});

describe('keyboard keys', () => {
  it('<kbd>Key</kbd> renders a real kbd element, inline, in text, lists, tables, and headings', () => {
    const { container } = show('Press <kbd>Ctrl</kbd> + <kbd>S</kbd> now.\n\n- hit <kbd>F2</kbd>\n\n| a | b |\n|---|---|\n| <kbd>Enter</kbd> | x |\n\n## Use <kbd>Esc</kbd>');
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'S', 'F2', 'Enter', 'Esc']);
    expect(container.querySelector('p').textContent).toBe('Press Ctrl + S now.');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Use Esc');
  });
  it('looks different from code: a raised key cap in the body font, not flat monospace', () => {
    const { container } = show('Press <kbd>Ctrl</kbd> or type `Ctrl`.');
    const key = getComputedStyle(container.querySelector('kbd')), code = getComputedStyle(container.querySelector('code'));
    expect(key.fontFamily).not.toBe(code.fontFamily); expect(code.fontFamily).toMatch(/monospace/); expect(key.fontFamily).not.toMatch(/monospace/);
    expect(key.borderBottomWidth).toBe('3px'); expect(key.borderTopWidth).toBe('1px'); expect(parseFloat(code.borderTopWidth || '0')).toBe(0);
    expect(key.backgroundColor).not.toBe(code.backgroundColor); expect(key.whiteSpace).toBe('nowrap'); expect(key.boxShadow).not.toBe('none');
  });
  it('stays distinct in dark mode too', () => {
    const { container } = show('<kbd>Ctrl</kbd> `x`', { docs: true }, 'dark');
    const key = getComputedStyle(container.querySelector('kbd'));
    expect(key.borderBottomWidth).toBe('3px'); expect(key.backgroundColor).not.toBe(getComputedStyle(container.querySelector('code')).backgroundColor);
  });
  it('is the only HTML that renders: other tags, and malformed kbd, stay inert', () => {
    const { container } = show('<script>alert(1)</script> <b>bold?</b> <kbd class="x" onclick="y">A</kbd> <kbd><b>B</b></kbd> <kbd>unclosed');
    expect(container.querySelector('script')).toBeNull(); expect(container.querySelector('b')).toBeNull();
    expect(container.querySelectorAll('kbd')).toHaveLength(0);
  });
  it('is not recognised outside documentation (chat replies)', () => {
    const { container } = show('Press <kbd>Ctrl</kbd>', {});
    expect(container.querySelector('kbd')).toBeNull();
  });
  it('the shortcuts article shows every key in a kbd, and the articles never bold a key name', () => {
    const md = TOPICS.find((t) => t.id === 'shortcuts').body;
    const rows = md.split('\n').filter((l) => /^\| (?!Action|---)/.test(l));
    expect(rows.length).toBeGreaterThan(8);
    for (const r of rows) expect(r.split('|')[2], r).toMatch(/<kbd>[^<]+<\/kbd>/);
    for (const t of TOPICS) expect(t.body, t.id).not.toMatch(/\*\*(Ctrl|Shift|Alt|Esc|Enter|F\d{1,2}|⌘)(\/⌘| [A-Z])?\*\*/);   // (Delete and Tab can be buttons or tabs, which are bold)
  });
});
