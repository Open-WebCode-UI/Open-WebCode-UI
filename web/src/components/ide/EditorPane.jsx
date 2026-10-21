import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import Editor from '@monaco-editor/react';
import CloseIcon from '@mui/icons-material/Close';
import EditorMenuBar from './EditorMenuBar.jsx';
import EditorStatusBar from './EditorStatusBar.jsx';
import PreviewIcon from '@mui/icons-material/PreviewOutlined';
import MarkdownPreview from './MarkdownPreview.jsx';
import NotebookEditor from './NotebookEditor.jsx';
import { isMarkdownPath } from './markdownPreview.js';
import { isNotebookPath } from './notebook.js';
import { loadPrefs, savePrefs, monacoOptions } from './editorPrefs.js';

const LANG = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', py: 'python', html: 'html', css: 'css', yml: 'yaml', yaml: 'yaml', sh: 'shell', java: 'java', go: 'go', rs: 'rust', c: 'c', cpp: 'cpp', sql: 'sql', xml: 'xml', rb: 'ruby', php: 'php' };
export const langOf = (p) => LANG[p.split('.').pop().toLowerCase()] || 'plaintext';
const EMPTY = { hasEditor: false, line: 1, col: 1, selChars: 0, selLines: 0, cursors: 1, tabSize: 2, insertSpaces: true, eol: 'LF', lang: 'plaintext' };

// Editor area: menu bar, file tabs, the Monaco editor, and a status bar.
export default function EditorPane({ project, tabs, active, canWrite, defaultTheme, onSelect, onClose, onCloseAll, onChange, onTabPatch, onSave, onSaveAll, onNewFile, onPreview, onQuickOpen, onSearch, goto, note, onNoteClose }) {
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [status, setStatus] = useState(EMPTY);
  const [nbActions, setNbActions] = useState(null); // Run all / Restart / Save of the open notebook editor, shown in the Notebook menu
  const editorRef = useRef({}); const saveRef = useRef(); const tab = tabs.find((t) => t.path === active);
  saveRef.current = () => tab && onSave(tab.path);
  const previewRef = useRef();
  const setPrefs = (p) => { setPrefsState(p); savePrefs(p); };
  const prefsRef = useRef(); prefsRef.current = { prefs, setPrefs };

  const refresh = useCallback(() => {
    const ed = editorRef.current.editor, model = ed?.getModel?.();
    if (!ed || !model) { setStatus(EMPTY); return; }
    const pos = ed.getPosition(), sel = ed.getSelection(), o = model.getOptions();
    setStatus({ hasEditor: true, line: pos.lineNumber, col: pos.column, selChars: sel && !sel.isEmpty() ? model.getValueInRange(sel).length : 0, selLines: sel && !sel.isEmpty() ? sel.endLineNumber - sel.startLineNumber + 1 : 0,
      cursors: ed.getSelections?.().length || 1, tabSize: o.tabSize, insertSpaces: o.insertSpaces, eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF', lang: model.getLanguageId() });
  }, []);
  editorRef.current.refresh = refresh;
  useEffect(() => { if (!tab) setStatus(EMPTY); else refresh(); }, [active, tab?.lang]); // eslint-disable-line

  // Follow the agent as it writes a file: keep the newest lines in view.
  useEffect(() => {
    if (!tab?.streaming) return;
    const ed = editorRef.current.editor, n = ed?.getModel?.()?.getLineCount?.();
    if (n) ed.revealLine(tab.revealLine || n); // a line edit scrolls to where it lands, a streamed file to its end
  }, [tab?.content, tab?.streaming]); // eslint-disable-line
  // A search result (or another "go to") asks for a position in a file: select the match and bring it to the middle of the view.
  const gotoDone = useRef();
  const applyGoto = () => {
    const ed = editorRef.current.editor; if (!goto || goto.path !== active || gotoDone.current === goto.n || !ed?.getModel?.()) return;
    gotoDone.current = goto.n; // each request is applied once, so returning to the tab later does not jump again
    const range = { startLineNumber: goto.line, startColumn: goto.col, endLineNumber: goto.line, endColumn: goto.col + (goto.length || 0) };
    ed.setSelection(range); ed.revealRangeInCenter(range); ed.focus();
  };
  const gotoRef = useRef(); gotoRef.current = applyGoto;
  useEffect(applyGoto, [goto, active]); // eslint-disable-line
  const switchTab = (d) => { const i = tabs.findIndex((t) => t.path === active); if (i >= 0 && tabs.length) onSelect(tabs[(i + d + tabs.length) % tabs.length].path); };
  const dirty = !!tab && tab.content !== tab.saved;
  // A preview shows its source tab's live text while that tab is open, otherwise the snapshot taken when it was opened.
  const previewText = tab?.preview ? (tabs.find((t) => t.path === tab.source)?.content ?? tab.content) : '';
  const isNb = (p) => isNotebookPath(p);
  const canPreview = !!tab && !tab.preview && (isMarkdownPath(tab.path) || isNb(tab.path));
  const previewLabel = tab && isNb(tab.preview ? tab.source : tab.path) ? 'Open notebook editor' : 'Open Markdown preview';
  // A notebook tab edits its source tab's JSON in place, so it is editable only while that tab is open.
  const nbSource = tab?.preview && isNb(tab.source) ? tabs.find((t) => t.path === tab.source) : undefined;
  previewRef.current = () => canPreview && onPreview?.(tab.path);

  // Alt+W closes the active tab. Ctrl/Cmd+W is the browser's own close-tab, so it can't be used. Matched on e.code because Option
  // changes e.key on a Mac. Handled on the pane rather than in Monaco so it also works from a preview or notebook tab.
  const onKeyDown = (e) => { if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyW' && tab) { e.preventDefault(); onClose(tab.path); } };

  return (
    <Box onKeyDown={onKeyDown} sx={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, minHeight: 0 }}>
      <EditorMenuBar editorRef={editorRef} project={project} tab={tab} tabs={tabs} canWrite={canWrite} dirty={dirty} prefs={prefs} setPrefs={setPrefs}
        onSave={onSave} onSaveAll={onSaveAll} onNewFile={onNewFile} onCloseTab={onClose} onCloseAll={onCloseAll} onSwitchTab={switchTab} onQuickOpen={onQuickOpen} onSearch={onSearch} notebook={tab?.preview && isNb(tab.source) ? nbActions : null} previewLabel={previewLabel} onPreview={canPreview ? () => onPreview(tab.path) : undefined} />
      {note}
      <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
      <Tabs value={active || false} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 34, flexGrow: 1, minWidth: 0 }} onChange={(_, v) => onSelect(v)}>
        {tabs.map((t) => (
          <Tab key={t.path} value={t.path} sx={{ minHeight: 34, py: 0, textTransform: 'none' }} component="div"
            label={<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, height: 34 }}>{t.preview && <PreviewIcon fontSize="inherit" titleAccess="Preview" />}<span style={{ display: 'flex', alignItems: 'center', height: '100%' }}>{t.preview ? `${isNb(t.source) ? 'Notebook' : 'Preview'} ${t.source.split('/').pop()}` : t.path.split('/').pop()}{t.content !== t.saved ? ' •' : ''}{t.streaming ? ' ✎ writing…' : ''}</span>
              <IconButton size="small" aria-label={`Close ${t.path}`} onClick={(e) => { e.stopPropagation(); onClose(t.path); }}><CloseIcon fontSize="inherit" /></IconButton></Box>} />
        ))}
      </Tabs>
      {canPreview && <Tooltip title={previewLabel}><IconButton size="small" aria-label={previewLabel} sx={{ mx: 0.5 }} onClick={() => onPreview(tab.path)}><PreviewIcon fontSize="small" /></IconButton></Tooltip>}
      </Box>
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        {tab?.preview && isNb(tab.source)
          ? <NotebookEditor project={project} source={tab.source} content={previewText} editable={!!nbSource && canWrite && !nbSource.streaming} dirty={!!nbSource && nbSource.content !== nbSource.saved}
              onChange={(json) => onChange(tab.source, json)} onSave={() => onSave(tab.source)} onActions={setNbActions} />
          : tab?.preview ? <MarkdownPreview source={tab.source} content={previewText} /> : tab ? (
          <Editor path={`${project.id}/${tab.path}`} language={tab.lang || langOf(tab.path)} value={tab.content} theme={prefs.theme || defaultTheme}
            options={monacoOptions(prefs, !canWrite || !!tab.streaming)} onChange={(v) => onChange(tab.path, v ?? '')}
            onMount={(ed, monaco) => {
              editorRef.current.editor = ed; editorRef.current.monaco = monaco;
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
              ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => { const { prefs: p, setPrefs: sp } = prefsRef.current; sp({ ...p, wordWrap: !p.wordWrap }); });
              if (monaco.KeyCode.KeyV !== undefined) ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV, () => previewRef.current?.());
              const subs = [ed.onDidChangeCursorPosition(refresh), ed.onDidChangeCursorSelection(refresh), ed.onDidChangeModel(refresh), ed.onDidChangeModelLanguage?.(refresh), ed.onDidChangeModelOptions?.(refresh), ed.onDidChangeModelContent(refresh)].filter(Boolean);
              ed.onDidDispose?.(() => subs.forEach((s) => s.dispose?.()));
              refresh(); gotoRef.current(); // the editor was only just created for a file opened from a search result
            }} />
        ) : <Box sx={{ p: 4, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'text.secondary' }}><Typography sx={{ fontStyle: 'italic' }}>Open a file from the Explorer, or use the Agent panel to plan and build.</Typography></Box>}
      </Box>
      <EditorStatusBar editorRef={editorRef} hasFile={!!tab && !tab.preview} status={tab && !tab.preview ? status : EMPTY} readOnly={!canWrite} dirty={dirty} langOverride={!!tab?.lang} onLanguage={(id) => tab && onTabPatch(tab.path, { lang: id || undefined })} />
    </Box>
  );
}
