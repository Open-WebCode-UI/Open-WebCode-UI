// Pure helpers for the notebook editor: parse/serialize nbformat 4 JSON and edit its cells. The raw JSON text stays the single
// source of truth (it is the file tab's content); the visual editor only ever reads it and writes a new text back.
export const isNotebookPath = (p) => /\.ipynb$/i.test(p || '');

const EMPTY_NB = () => ({ cells: [], metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 });

// -> { nb } on success, { error } when the text is not a usable notebook. Blank text is a new, empty notebook.
export function parseNotebook(text) {
  if (!text || !text.trim()) return { nb: EMPTY_NB(), blank: true };
  let nb;
  try { nb = JSON.parse(text); } catch (e) { return { error: `Invalid JSON: ${e.message}` }; }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb)) return { error: 'Not a notebook: the top level must be a JSON object.' };
  if (!Array.isArray(nb.cells)) return { error: 'Not a notebook: missing a "cells" array.' };
  if (nb.cells.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) return { error: 'Not a notebook: every cell must be a JSON object.' };
  return { nb };
}

// nbformat writes indent 1 and a trailing newline, which keeps diffs of notebooks stable.
export const serializeNotebook = (nb) => `${JSON.stringify(nb, null, 1)}\n`;

// A cell's source is a string or an array of lines.
export const sourceText = (cell) => (Array.isArray(cell.source) ? cell.source.join('') : typeof cell.source === 'string' ? cell.source : '');
const toLines = (text) => text.split(/(?<=\n)/);

let counter = 0;
const newId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`.slice(0, 64);

export function newCell(nb, type = 'code') {
  const cell = type === 'code' ? { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [] } : { cell_type: type, metadata: {}, source: [] };
  if ((nb.nbformat_minor ?? 0) >= 5) cell.id = newId();
  return cell;
}

const withCells = (nb, cells) => ({ ...nb, cells });
const at = (nb, i) => (i >= 0 && i < nb.cells.length);

export const setSource = (nb, i, text) => withCells(nb, nb.cells.map((c, j) => (j === i ? { ...c, source: toLines(text) } : c)));
export const insertCell = (nb, index, type) => withCells(nb, [...nb.cells.slice(0, index), newCell(nb, type), ...nb.cells.slice(index)]);
export const deleteCell = (nb, i) => (at(nb, i) ? withCells(nb, nb.cells.filter((_, j) => j !== i)) : nb);
export const moveCell = (nb, i, d) => {
  const k = i + d; if (!at(nb, i) || !at(nb, k)) return nb;
  const cells = [...nb.cells]; [cells[i], cells[k]] = [cells[k], cells[i]]; return withCells(nb, cells);
};
export const clearOutputs = (nb, i) => withCells(nb, nb.cells.map((c, j) => (j === i && c.cell_type === 'code' ? { ...c, outputs: [], execution_count: null } : c)));

// Changing the type keeps the text; the fields belonging only to code cells are added or dropped.
export function setCellType(nb, i, type) {
  if (!at(nb, i) || nb.cells[i].cell_type === type) return nb;
  const { outputs, execution_count, ...rest } = nb.cells[i]; // eslint-disable-line no-unused-vars
  const cell = type === 'code' ? { ...rest, cell_type: 'code', execution_count: null, outputs: [] } : { ...rest, cell_type: type };
  return withCells(nb, nb.cells.map((c, j) => (j === i ? cell : c)));
}

// ---- outputs ----
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => s.replace(ANSI, '');
const text = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
const SAFE_IMAGE = /^[A-Za-z0-9+/=\s]+$/;

// -> [{ kind: 'text'|'error'|'image'|'html'|'markdown', ... }]. A rich result is shown in its best form: raster image, SVG (as an <img>, so it
// cannot run script), HTML (the viewer puts it in a sandboxed, script-less, network-less frame), Markdown, then plain text.
export function outputsOf(cell) {
  if (cell.cell_type !== 'code' || !Array.isArray(cell.outputs)) return [];
  return cell.outputs.flatMap((o) => {
    if (!o || typeof o !== 'object') return [];
    if (o.output_type === 'stream') return [{ kind: 'text', stream: o.name === 'stderr' ? 'stderr' : 'stdout', text: stripAnsi(text(o.text)) }];
    if (o.output_type === 'error') return [{ kind: 'error', text: stripAnsi(Array.isArray(o.traceback) && o.traceback.length ? o.traceback.join('\n') : `${o.ename || 'Error'}: ${o.evalue || ''}`) }];
    if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
      const d = o.data || {};
      for (const mime of ['image/png', 'image/jpeg']) {
        const b64 = text(d[mime]);
        if (b64 && SAFE_IMAGE.test(b64)) return [{ kind: 'image', src: `data:${mime};base64,${b64.replace(/\s/g, '')}` }];
      }
      const svg = text(d['image/svg+xml']); if (svg) return [{ kind: 'image', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }];
      const html = text(d['text/html']); if (html) return [{ kind: 'html', html }];
      const md = text(d['text/markdown']); if (md) return [{ kind: 'markdown', text: md }];
      if ('text/plain' in d) return [{ kind: 'text', stream: 'stdout', text: stripAnsi(text(d['text/plain'])) }];
      if ('text/latex' in d) return [{ kind: 'text', stream: 'stdout', text: text(d['text/latex']) }];
    }
    return [];
  });
}

// ---- running a cell: kernel events -> nbformat outputs ----
// Folds one kernel event (stream / result / display / error) into a list of nbformat outputs. Consecutive output of one stream is merged.
export function appendEvent(outputs, ev) {
  if (ev.t === 'stream') {
    const last = outputs[outputs.length - 1];
    if (last?.output_type === 'stream' && last.name === ev.name) return [...outputs.slice(0, -1), { ...last, text: toLines(last.text.join('') + ev.text) }];
    return [...outputs, { output_type: 'stream', name: ev.name, text: toLines(ev.text) }];
  }
  if (ev.t === 'result' || ev.t === 'display') {
    const data = ev.data || { 'text/plain': ev.text ?? '' };
    return [...outputs, ev.t === 'result' ? { output_type: 'execute_result', execution_count: null, metadata: {}, data } : { output_type: 'display_data', metadata: {}, data }];
  }
  if (ev.t === 'error') return [...outputs, { output_type: 'error', ename: ev.ename, evalue: ev.evalue, traceback: ev.traceback }];
  return outputs;
}
// Stores a finished run on the cell identified by its id (or its position, for notebooks whose cells have no ids).
export function applyRun(nb, key, outputs, count) {
  const i = nb.cells.findIndex((c, j) => (c.id !== undefined ? c.id === key : j === key));
  if (i < 0 || nb.cells[i].cell_type !== 'code') return nb;
  const outs = outputs.map((o) => (o.output_type === 'execute_result' ? { ...o, execution_count: count } : o));
  return withCells(nb, nb.cells.map((c, j) => (j === i ? { ...c, outputs: outs, execution_count: count } : c)));
}
export const cellKey = (cell, i) => cell.id ?? i;
export const isPython = (nb) => { const l = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name; return !l || String(l).toLowerCase() === 'python'; };
