import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { previewPath, isMarkdownPath, sourceOf } from '../src/components/ide/markdownPreview.js';

vi.mock('@monaco-editor/react', () => ({ default: (p) => <div data-testid="monaco" data-path={p.path} />, DiffEditor: () => <div /> }));
const { default: EditorPane } = await import('../src/components/ide/EditorPane.jsx');

const MD = { path: 'docs/guide.md', content: '# Hi\n\n**bold** <script>x</script>', saved: '# Hi\n\n**bold** <script>x</script>' };
const JS = { path: 'a.js', content: '1', saved: '1' };
const PV = { path: previewPath('docs/guide.md'), source: 'docs/guide.md', preview: true, content: 'old', saved: 'old' };
function pane(tabs, active, over = {}) {
  const p = { project: { id: 1 }, tabs, active, canWrite: true, defaultTheme: 'vs', onSelect: vi.fn(), onClose: vi.fn(), onCloseAll: vi.fn(), onChange: vi.fn(), onTabPatch: vi.fn(), onSave: vi.fn(), onSaveAll: vi.fn(), onNewFile: vi.fn(), onPreview: vi.fn(), ...over };
  return { p, ...render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><EditorPane {...p} /></ThemeProvider>) };
}

describe('markdown preview', () => {
  it('recognizes markdown paths and maps previews to their source', () => {
    expect(['a.md', 'B.MARKDOWN', 'x/y.mdx'].every(isMarkdownPath)).toBe(true);
    expect(['a.js', 'md', undefined].some(isMarkdownPath)).toBe(false);
    expect(sourceOf(PV)).toBe('docs/guide.md'); expect(sourceOf(JS)).toBe('a.js');
  });
  it('offers the preview for a markdown tab (button and View menu) and opens it', async () => {
    const { p } = pane([MD], MD.path);
    await userEvent.click(screen.getByRole('button', { name: 'Open Markdown preview' }));
    expect(p.onPreview).toHaveBeenCalledWith('docs/guide.md');
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Open Markdown preview/ }));
    await vi.waitFor(() => expect(p.onPreview).toHaveBeenCalledTimes(2));
  });
  it('does not offer it for other files, and disables the menu item', async () => {
    pane([JS], JS.path);
    expect(screen.queryByRole('button', { name: 'Open Markdown preview' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByRole('menuitem', { name: /^Open Markdown preview/ })).toHaveAttribute('aria-disabled', 'true');
  });
  it('renders a preview tab read-only from the live source tab, with no editor and no raw HTML', () => {
    pane([MD, PV], PV.path);
    const view = screen.getByTestId('markdown-preview');
    expect(within(view).getByRole('heading', { name: 'Hi' })).toBeInTheDocument();
    expect(within(view).getByText('bold').tagName).toBe('STRONG');
    expect(view.querySelector('script')).toBeNull();
    expect(screen.queryByTestId('monaco')).toBeNull();
    expect(screen.getByText('Preview guide.md')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Markdown preview' })).toBeNull();
  });
  it('falls back to the snapshot when the source tab is closed', () => {
    pane([PV], PV.path);
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('old');
  });
});
