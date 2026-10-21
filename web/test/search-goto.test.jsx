import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockFetch } from './helpers.jsx';
import SearchPanel from '../src/components/ide/SearchPanel.jsx';
import QuickOpen, { flattenFiles, rankFiles } from '../src/components/ide/QuickOpen.jsx';

const wrap = (ui) => render(ui);

describe('go to file ranking', () => {
  const tree = [{ type: 'dir', name: 'src', path: 'src', children: [{ type: 'file', name: 'app.js', path: 'src/app.js' }, { type: 'file', name: 'api.js', path: 'src/api.js' }] }, { type: 'file', name: 'README.md', path: 'README.md' }];
  it('flattens the tree and matches fuzzily, preferring the file name', () => {
    const files = flattenFiles(tree); expect(files).toEqual(['src/app.js', 'src/api.js', 'README.md']);
    expect(rankFiles(files, 'apj').sort()).toEqual(['src/api.js', 'src/app.js']);
    expect(rankFiles(files, 'api')[0]).toBe('src/api.js');
    expect(rankFiles(files, 'readme')[0]).toBe('README.md');
    expect(rankFiles(files, 'zzz')).toEqual([]);
  });
  it('opens the highlighted file with Enter', () => {
    const onOpen = vi.fn(), onClose = vi.fn();
    wrap(<QuickOpen files={flattenFiles(tree)} onOpen={onOpen} onClose={onClose} />);
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'api' } }); fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('src/api.js'); expect(onClose).toHaveBeenCalled();
  });
});

describe('search panel', () => {
  it('searches the project and opens a match', async () => {
    const f = mockFetch({ '/api/projects/7/search': { results: [{ path: 'src/a.js', hits: [{ line: 3, col: 5, length: 3, text: 'let foo = 1' }] }], matches: 1, truncated: false } });
    const onOpenMatch = vi.fn();
    wrap(<SearchPanel project={{ id: 7 }} onOpenMatch={onOpenMatch} />);
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'foo' } });
    fireEvent.click(screen.getByLabelText('Match case'));
    fireEvent.keyDown(screen.getByLabelText('Search files'), { key: 'Enter' });
    expect(await screen.findByText('1 result in 1 file')).toBeTruthy();
    expect(f.calls.at(-1).url).toContain('q=foo'); expect(f.calls.at(-1).url).toContain('case=1');
    fireEvent.click(screen.getByTitle('src/a.js:3'));
    expect(onOpenMatch).toHaveBeenCalledWith('src/a.js', expect.objectContaining({ line: 3, col: 5 }));
  });
  it('explains a bad pattern', async () => {
    mockFetch({ '/api/projects/7/search': () => new Response(JSON.stringify({ error: 'invalid_pattern' }), { status: 400 }) });
    wrap(<SearchPanel project={{ id: 7 }} onOpenMatch={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: '(' } });
    fireEvent.click(screen.getByText('Search'));
    await waitFor(() => expect(screen.getByText('Invalid regular expression')).toBeTruthy());
  });
});
