import { render } from '@testing-library/react';
import { it, expect } from 'vitest';
import Markdown from '../src/components/Markdown.jsx';

it('renders inline and block LaTeX with KaTeX', () => {
  const { container } = render(<Markdown>{'Inline $x^2$ and\n\n$$\n\\frac{a}{b}\n$$\n\nbad $\\notacommand{$'}</Markdown>);
  expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
  expect(container.querySelector('.katex-display')).not.toBeNull();
});

it('renders a mermaid block as a diagram, falling back to code when it fails', async () => {
  const { vi } = await import('vitest');
  const { waitFor } = await import('@testing-library/react');
  vi.resetModules();
  vi.doMock('mermaid', () => ({ default: { initialize: () => {}, render: async (_id, src) => { if (src.includes('bad')) throw new Error('parse'); return { svg: '<svg data-x="1"></svg>' }; } } }));
  const { default: Md } = await import('../src/components/Markdown.jsx');
  const ok = render(<Md>{'```mermaid\ngraph TD; A-->B\n```'}</Md>);
  await waitFor(() => expect(ok.container.querySelector('[data-testid=mermaid-diagram] svg')).not.toBeNull());
  const bad = render(<Md>{'```mermaid\nbad\n```'}</Md>);
  await new Promise((r) => setTimeout(r, 50));
  expect(bad.container.querySelector('[data-testid=code-block]')).not.toBeNull();
  expect(bad.container.querySelector('[data-testid=mermaid-diagram]')).toBeNull();
});
