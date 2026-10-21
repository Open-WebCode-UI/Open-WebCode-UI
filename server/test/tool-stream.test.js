import { describe, it, expect, vi, afterEach } from 'vitest';
import { partialStrings, createToolStreamer } from '../src/agent/tool-stream.js';

afterEach(() => vi.useRealTimers());

describe('partialStrings', () => {
  it('reads complete and truncated string values, decoding escapes', () => {
    const closed = new Set();
    const r = partialStrings('{"path":"src/a.js","content":"line1\\nline2 \\"q\\" \\u00e9 tail', ['path', 'content'], closed);
    expect(r).toEqual({ path: 'src/a.js', content: 'line1\nline2 "q" é tail' });
    expect([...closed]).toEqual(['path']);
  });
  it('does not emit half an escape sequence', () => {
    expect(partialStrings('{"content":"a\\', ['content'])).toEqual({ content: 'a' });
    expect(partialStrings('{"content":"a\\u00', ['content'])).toEqual({ content: 'a' });
  });
  it('skips other values and finds fields after them', () => {
    expect(partialStrings('{"n":12,"o":{"x":"}"},"content":"hi', ['content'])).toEqual({ content: 'hi' });
  });
  it('reports numbers as text, closed only once they end', () => {
    const c = new Set();
    expect(partialStrings('{"path":"a","start_line":1', ['path', 'start_line'], c)).toEqual({ path: 'a', start_line: '1' });
    expect(c.has('start_line')).toBe(false);
    expect(partialStrings('{"path":"a","start_line":12,"content":"x', ['start_line', 'content'], c)).toEqual({ start_line: '12', content: 'x' });
    expect(c.has('start_line')).toBe(true);
  });
  it('copes with empty and partial input', () => {
    expect(partialStrings('', ['path'])).toEqual({});
    expect(partialStrings('{"pa', ['path'])).toEqual({});
    expect(partialStrings('{"path":', ['path'])).toEqual({});
  });
});

describe('createToolStreamer', () => {
  it('batches deltas, sends only new characters, and reports closed fields', () => {
    vi.useFakeTimers();
    const out = []; const s = createToolStreamer((e) => out.push(e), { intervalMs: 50 });
    s.delta({ id: 'a', name: 'write_file', delta: '' });
    expect(out).toEqual([{ type: 'tool_progress', id: 'a', name: 'write_file', fields: {} }]);
    s.delta({ id: 'a', name: 'write_file', delta: '{"path":"x.js","content":"ab' });
    s.delta({ id: 'a', name: 'write_file', delta: 'c' });
    expect(out).toHaveLength(1); // nothing until the timer fires
    vi.advanceTimersByTime(60);
    expect(out[1]).toEqual({ type: 'tool_progress', id: 'a', name: 'write_file', fields: { path: 'x.js', content: 'abc' }, closed: ['path'] });
    s.delta({ id: 'a', name: 'write_file', delta: 'd"}' });
    s.close();
    expect(out[2]).toEqual({ type: 'tool_progress', id: 'a', name: 'write_file', fields: { content: 'd' }, closed: ['path', 'content'] });
  });
  it('ignores tools whose arguments are not worth showing', () => {
    const out = []; const s = createToolStreamer((e) => out.push(e));
    s.delta({ id: 'b', name: 'read_file', delta: '{"path":"x"}' }); s.close();
    expect(out).toEqual([]);
  });
});

describe('unknown argument names', () => {
  it('falls back to streaming the raw JSON so the UI is never blank', () => {
    const out = []; const s = createToolStreamer((e) => out.push(e));
    s.delta({ id: 'c', name: 'write_file', delta: '{"file_path":"a.js","text":"hi' }); s.close();
    expect(out.at(-1)).toMatchObject({ fields: { raw: '{"file_path":"a.js","text":"hi' } });
  });
});
