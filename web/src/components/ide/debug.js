// Debugging support in the editor: which languages get a Debug menu, and breakpoints in the gutter.
// Breakpoints are decorations on the Monaco model, so they move with the lines they sit on when text is inserted or removed above them.
// They are kept for as long as the file's model is open; closing the tab drops them. Running and stepping need a debug adapter
// on the server, which does not exist yet, so the Debug menu's run and step items stay disabled.
import { ensureStyle } from './editorStyles.js';

export const DEBUG_LANGS = ['javascript', 'typescript', 'python'];
export const canDebug = (lang) => DEBUG_LANGS.includes(lang);

const BP = 'ide-breakpoint';
const CSS = `.${BP}{background:#e51400;border-radius:50%;width:10px!important;height:10px!important;margin-left:4px;margin-top:4px}`;

// Toggles a breakpoint on the line the cursor is on (F9 and the Debug menu).
export const toggleAtCursor = (ed, monaco) => (ed?.getPosition ? toggleBreakpoint(ed, monaco, ed.getPosition().lineNumber) : false);

// Adds a breakpoint on a line, or removes the one already there. Returns true when a breakpoint was added.
export function toggleBreakpoint(ed, monaco, line) {
  const model = ed?.getModel?.();
  if (!model || !monaco) return false;
  ensureStyle('ide-breakpoint-style', CSS);
  const existing = model.getLineDecorations(line).filter((d) => d.options.glyphMarginClassName === BP);
  if (existing.length) { model.deltaDecorations(existing.map((d) => d.id), []); return false; }
  model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: BP, glyphMarginHoverMessage: { value: 'Breakpoint' }, stickiness: 1 } }]);
  return true;
}
