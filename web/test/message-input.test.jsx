import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageInput, { looksLikeMarkdown, editorEnterSends } from '../src/components/MessageInput.jsx';

function Harness({ onSubmit = () => {}, initial = '' }) {
  const [v, setV] = useState(initial);
  return <><MessageInput value={v} onChange={setV} onSubmit={() => onSubmit(v)} /><output data-testid="val">{v}</output></>;
}

describe('MessageInput', () => {
  it('detects markdown', () => {
    for (const s of ['# Title', '- item', '1. one', '> q', '```js\nx\n```', 'a **b** c', 'use `x`', '[a](http://b)']) expect(looksLikeMarkdown(s), s).toBe(true);
    for (const s of ['hello', 'a - b', '2 * 3 * 4', 'what is 1.5?', '#hashtag', '# ', '- ', '```js', '```\nopen', '/code-review ']) expect(looksLikeMarkdown(s), s).toBe(false);
  });
  it('is plain with no formatting controls by default', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText('Message'), 'just text');
    expect(screen.getByLabelText('Message').tagName).toBe('TEXTAREA');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
  it('switches to the WYSIWYG editor with pre-formatted markdown', async () => {
    render(<Harness initial={"**bold** and a list:\n\n- one\n- two"} />);
    expect(await screen.findByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => { expect(box.querySelector('strong')).toHaveTextContent('bold'); expect(box.querySelectorAll('li')).toHaveLength(2); });
  });
  it('switches when the user types markdown, keeps the text, and submits on Enter', async () => {
    const submit = vi.fn();
    render(<Harness onSubmit={submit} />);
    await userEvent.type(screen.getByLabelText('Message'), '# H');
    const box = await screen.findByRole('textbox', { name: 'Message' });
    expect(box.tagName).not.toBe('TEXTAREA');
    await waitFor(() => expect(box.querySelector('h1')).toBeTruthy());
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith(expect.stringMatching(/^# H/));
  });
  it('lets Enter add lines inside an unclosed code fence instead of sending', async () => {
    const submit = vi.fn();
    render(<Harness onSubmit={submit} />);
    const box = screen.getByLabelText('Message');
    await userEvent.type(box, '```{Enter}Error: boom{Enter}  at x');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByTestId('val').textContent).toBe('```\nError: boom\n  at x');
    await userEvent.type(box, '{Control>}{Enter}{/Control}');
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('Enter in a WYSIWYG code block adds a line; Ctrl+Enter and Enter elsewhere send', () => {
    const inBlock = { selection: { $from: { parent: { type: { name: 'codeBlock' } } } } };
    const inPara = { selection: { $from: { parent: { type: { name: 'paragraph' } } } } };
    expect(editorEnterSends(inBlock, { key: 'Enter' })).toBe(false);
    expect(editorEnterSends(inBlock, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(editorEnterSends(inBlock, { key: 'Enter', metaKey: true })).toBe(true);
    expect(editorEnterSends(inPara, { key: 'Enter' })).toBe(true);
    expect(editorEnterSends(inPara, { key: 'Enter', shiftKey: true })).toBe(false);
    const inItem = { selection: { $from: { parent: { type: { name: 'paragraph' } }, depth: 2, node: (d) => ({ type: { name: ['doc', 'bulletList', 'listItem'][d] } }) } } };
    expect(editorEnterSends(inItem, { key: 'Enter' })).toBe(false);
    expect(editorEnterSends(inItem, { key: 'Enter', ctrlKey: true })).toBe(true);
  });
  it('lands with no active marks after a closing marker so following text is not bold', async () => {
    render(<Harness initial="**bold**" />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box.querySelector('strong')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false'));
  });
  it('does not escape literal markdown characters it did not convert', async () => {
    const text = '**b** 5 > 3 and x_y and a_b_c';
    render(<Harness initial={text} />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box.querySelector('strong')).toBeTruthy());
    expect(box).toHaveTextContent('b 5 > 3 and x_y and a_b_c');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('val').textContent).toBe(text);
  });
  it.each([['> quote', 'blockquote'], ['- item', 'ul'], ['1. item', 'ol']])('keeps no empty paragraph after %s so typing continues inside the block', async (initial, tag) => {
    render(<Harness initial={initial} />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box.querySelector(tag)).toBeTruthy());
    expect(box.lastElementChild.tagName.toLowerCase()).toBe(tag);
  });
});
