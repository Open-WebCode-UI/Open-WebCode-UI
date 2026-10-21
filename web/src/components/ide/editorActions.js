// Menu actions on a Monaco editor instance. Kept free of React so they can be unit-tested with a fake editor.
// Monaco's own commands are triggered by id so their built-in UI (find widget, command palette, go to line) is what opens.
export const run = (editor, id) => { if (!editor) return; editor.focus(); editor.trigger('menu', id, null); };

const writeClipboard = (t) => navigator.clipboard.writeText(t);

// With nothing selected, copy/cut act on the whole current line, like VS Code.
function target(editor) {
  const sel = editor.getSelection(), model = editor.getModel();
  if (sel && !sel.isEmpty()) return { range: sel, text: model.getValueInRange(sel) };
  const line = editor.getPosition().lineNumber, max = model.getLineMaxColumn(line);
  const range = { startLineNumber: line, startColumn: 1, endLineNumber: line < model.getLineCount() ? line + 1 : line, endColumn: line < model.getLineCount() ? 1 : max };
  return { range, text: model.getValueInRange(range) };
}
export async function copy(editor) { if (!editor) return false; try { await writeClipboard(target(editor).text); return true; } catch { return false; } }
export async function cut(editor) {
  if (!editor) return false; // the menu disables Cut for read-only editors
  const t = target(editor);
  try { await writeClipboard(t.text); } catch { return false; }
  editor.executeEdits('menu', [{ range: t.range, text: '', forceMoveMarkers: true }]); editor.pushUndoStop?.(); editor.focus();
  return true;
}
export async function paste(editor) {
  if (!editor) return false;
  let text; try { text = await navigator.clipboard.readText(); } catch { return false; } // permission denied: the user can still press Ctrl+V
  const sels = editor.getSelections?.() || [editor.getSelection()];
  editor.executeEdits('menu', sels.map((range) => ({ range, text, forceMoveMarkers: true }))); editor.pushUndoStop?.(); editor.focus();
  return true;
}

export const baseName = (p) => String(p).split('/').pop();
export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function setIndent(editor, { insertSpaces, tabSize }) { editor?.getModel()?.updateOptions({ insertSpaces, tabSize }); }
export function setEol(editor, monaco, crlf) { editor?.getModel()?.setEOL(crlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF); }

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const mod = () => (isMac() ? '⌘' : 'Ctrl+');
