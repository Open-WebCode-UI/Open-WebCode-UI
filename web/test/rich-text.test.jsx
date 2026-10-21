import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { RichEditor } from '../src/components/RichText.jsx';

afterEach(cleanup);
// The parent re-renders on every change, as the course editor does.
function Host({ onDoc }) { const [, set] = useState(null); return <RichEditor doc={{}} onChange={(d) => { onDoc(d); set(d); }} />; }

describe('rich text editor', () => {
  it('can be typed into, and keeps what you type while the parent re-renders', async () => {
    let doc = null;
    render(<Host onDoc={(d) => { doc = d; }} />);
    const box = await screen.findByRole('textbox', { name: 'Page content' });
    box.focus(); await userEvent.keyboard('first line');
    expect(box.textContent).toBe('first line');
    expect(JSON.stringify(doc)).toContain('first line');
  });

  it('says where to type while empty, and stops once there is text', async () => {
    render(<Host onDoc={() => {}} />);
    const box = await screen.findByRole('textbox', { name: 'Page content' });
    expect(screen.getByText('Start writing here…')).toBeInTheDocument();
    box.focus(); await userEvent.keyboard('x');
    expect(screen.queryByText('Start writing here…')).toBeNull();
  });

  it('a press on the empty area around the text (outside the editable line) puts the cursor in the editor', async () => {
    render(<Host onDoc={() => {}} />);
    const box = await screen.findByRole('textbox', { name: 'Page content' });
    expect(document.activeElement).not.toBe(box);
    fireEvent.mouseDown(screen.getByTestId('editor-surface'));
    await waitFor(() => expect(document.activeElement).toBe(box)); // TipTap applies focus on the next frame
    await userEvent.keyboard('typed after clicking the blank area');
    expect(box.textContent).toBe('typed after clicking the blank area');
  });

  it('the editable area fills the box, so the whole box is clickable', async () => {
    render(<Host onDoc={() => {}} />);
    const box = await screen.findByRole('textbox', { name: 'Page content' });
    expect(getComputedStyle(box).minHeight).toBe('240px');
  });
});
