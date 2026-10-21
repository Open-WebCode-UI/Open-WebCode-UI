import { useState } from 'react';
import { Box, ButtonBase, Chip, Dialog, DialogContent, DialogTitle, List, ListItemButton, ListItemText, Menu, MenuItem, TextField, Typography } from '@mui/material';
import { run, setIndent, setEol } from './editorActions.js';

const Item = ({ children, onClick, title, label, ...p }) => (
  <ButtonBase onClick={onClick} disabled={!onClick} title={title} aria-label={label} sx={{ px: 1, height: '100%', fontSize: 12, borderRadius: 0, '&:hover': onClick ? { bgcolor: 'action.hover' } : undefined }} {...p}>{children}</ButtonBase>
);

// Status bar under the editor: cursor, selection, indentation, encoding, line endings, and a language picker.
export default function EditorStatusBar({ editorRef, status, hasFile, readOnly, dirty, langOverride, onLanguage }) {
  const [menu, setMenu] = useState(null); const [langOpen, setLangOpen] = useState(false); const [filter, setFilter] = useState('');
  const ed = () => editorRef.current?.editor, monaco = () => editorRef.current?.monaco;
  const languages = (monaco()?.languages.getLanguages?.() || []).map((l) => ({ id: l.id, name: l.aliases?.[0] || l.id })).sort((a, b) => a.name.localeCompare(b.name));
  const shown = languages.filter((l) => `${l.name} ${l.id}`.toLowerCase().includes(filter.toLowerCase()));
  const langName = languages.find((l) => l.id === status.lang)?.name || status.lang || 'Plain Text';
  const close = () => setMenu(null);
  const indent = (spaces, size) => { close(); setIndent(ed(), { insertSpaces: spaces, tabSize: size }); ed()?.getModel() && onStatus(); };
  const onStatus = () => editorRef.current?.refresh?.();

  return (
    <Box role="status" aria-label="Editor status" sx={{ display: 'flex', alignItems: 'stretch', height: 24, borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', color: 'text.secondary', overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {!status.hasEditor ? <Box sx={{ px: 1, display: 'flex', alignItems: 'center' }}><Typography variant="caption">{hasFile ? 'Loading editor…' : 'No file open'}</Typography></Box> : (
        <>
          <Item onClick={() => run(ed(), 'editor.action.gotoLine')} label="Go to line" title="Go to line (Ctrl+G)">Ln {status.line}, Col {status.col}{status.selChars > 0 ? ` (${status.selChars} selected${status.selLines > 1 ? `, ${status.selLines} lines` : ''})` : ''}</Item>
          {status.cursors > 1 && <Item>{status.cursors} cursors</Item>}
          <Item onClick={(e) => setMenu({ kind: 'indent', anchor: e.currentTarget })} label="Indentation" title="Select indentation">{status.insertSpaces ? 'Spaces' : 'Tab Size'}: {status.tabSize}</Item>
          <Item title="Files are read and saved as UTF-8" label="Encoding">UTF-8</Item>
          <Item onClick={(e) => setMenu({ kind: 'eol', anchor: e.currentTarget })} label="End of line sequence" title="Select end of line sequence">{status.eol}</Item>
          <Item onClick={() => { setFilter(''); setLangOpen(true); }} label="Language mode" title="Select language mode">{langName}{langOverride ? ' •' : ''}</Item>
          <Box sx={{ flexGrow: 1 }} />
          {dirty && <Item title="Unsaved changes" label="Unsaved changes">● Unsaved</Item>}
          {readOnly && <Chip size="small" label="Read-only" sx={{ my: 'auto', mr: 1, height: 18, fontSize: 11 }} />}
        </>
      )}
      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={close} MenuListProps={{ dense: true }}>
        {menu?.kind === 'indent' && [[true, 2], [true, 4], [true, 8], [false, 4]].map(([sp, n]) => (
          <MenuItem key={`${sp}${n}`} selected={status.insertSpaces === sp && status.tabSize === n} onClick={() => indent(sp, n)}>{sp ? `Indent using spaces: ${n}` : `Indent using tabs (size ${n})`}</MenuItem>))}
        {menu?.kind === 'eol' && [['LF', false], ['CRLF', true]].map(([n, crlf]) => (
          <MenuItem key={n} selected={status.eol === n} onClick={() => { close(); setEol(ed(), monaco(), crlf); onStatus(); }}>{n === 'LF' ? 'LF (Unix, macOS)' : 'CRLF (Windows)'}</MenuItem>))}
      </Menu>
      <Dialog open={langOpen} onClose={() => setLangOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Select language mode</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth size="small" placeholder="Search languages" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ mb: 1 }} slotProps={{ htmlInput: { 'aria-label': 'Search languages' } }} />
          <List dense sx={{ maxHeight: 320, overflow: 'auto' }}>
            {langOverride && <ListItemButton onClick={() => { setLangOpen(false); onLanguage(null); }}><ListItemText primary="Auto-detect from file name" /></ListItemButton>}
            {shown.map((l) => <ListItemButton key={l.id} selected={l.id === status.lang} onClick={() => { setLangOpen(false); onLanguage(l.id); }}><ListItemText primary={l.name} secondary={l.id !== l.name.toLowerCase() ? l.id : undefined} /></ListItemButton>)}
            {!shown.length && <ListItemText sx={{ p: 2 }} primary="No matching language" />}
          </List>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
