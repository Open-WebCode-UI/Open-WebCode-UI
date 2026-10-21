import { useEffect } from 'react';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import TitleIcon from '@mui/icons-material/Title';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import DataObjectIcon from '@mui/icons-material/DataObject';
import LinkIcon from '@mui/icons-material/Link';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

// Course page content is stored as a TipTap JSON document and rendered by the same schema, so there is no raw HTML anywhere.
// Links are limited to safe protocols by TipTap's Link extension.
const EXTENSIONS = [StarterKit.configure({ link: { openOnClick: false, autolink: true } }), TableKit.configure({ table: { resizable: false } })];
export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

const TOOLS = [
  ['Bold', FormatBoldIcon, 'bold', (c) => c.toggleBold()],
  ['Italic', FormatItalicIcon, 'italic', (c) => c.toggleItalic()],
  ['Heading', TitleIcon, 'heading', (c) => c.toggleHeading({ level: 2 })],
  ['Bulleted list', FormatListBulletedIcon, 'bulletList', (c) => c.toggleBulletList()],
  ['Numbered list', FormatListNumberedIcon, 'orderedList', (c) => c.toggleOrderedList()],
  ['Quote', FormatQuoteIcon, 'blockquote', (c) => c.toggleBlockquote()],
  ['Code block', DataObjectIcon, 'codeBlock', (c) => c.toggleCodeBlock()],
];

const contentSx = {
  '& .tiptap': { outline: 'none', overflowWrap: 'anywhere' },
  '& .tiptap h2': { fontSize: '1.4em', mt: 2, mb: 1 }, '& .tiptap p': { my: 1 },
  '& .tiptap code': { fontFamily: 'monospace', bgcolor: 'action.hover', px: 0.5, borderRadius: 0.5 },
  '& .tiptap pre': { p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }, '& .tiptap pre code': { bgcolor: 'transparent', p: 0 },
  '& .tiptap table': { borderCollapse: 'collapse', my: 1, maxWidth: '100%' },
  '& .tiptap th, & .tiptap td': { border: 1, borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left', verticalAlign: 'top', minWidth: '4em' }, '& .tiptap th': { bgcolor: 'action.hover', fontWeight: 600 },
  '& .tiptap td > p, & .tiptap th > p': { my: 0 }, '& .tiptap .selectedCell': { bgcolor: 'action.selected' },
  '& .tiptap blockquote': { m: 0, pl: 2, borderLeft: 3, borderColor: 'divider' },
};

function Toolbar({ editor }) {
  const active = useEditorState({ editor, selector: (s) => Object.fromEntries([...TOOLS.map(([, , n]) => [n, s.editor.isActive(n)]), ['link', s.editor.isActive('link')]]) });
  const link = () => {
    const prev = editor.getAttributes('link').href || '';
    const href = window.prompt('Link address (leave empty to remove)', prev);
    if (href === null) return;
    const c = editor.chain().focus().extendMarkRange('link');
    (href ? c.setLink({ href }) : c.unsetLink()).run();
  };
  const inTable = useEditorState({ editor, selector: (s) => s.editor.isActive('table') });
  const btn = (label, Icon, run) => (
    <Tooltip key={label} title={label}><IconButton size="small" aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={run}><Icon fontSize="small" /></IconButton></Tooltip>
  );
  return (
    <Stack direction="row" role="toolbar" aria-label="Formatting" sx={{ px: 0.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
      {TOOLS.map(([label, Icon, name, run]) => (
        <Tooltip key={name} title={label}>
          <IconButton size="small" aria-label={label} aria-pressed={!!active[name]} color={active[name] ? 'primary' : 'default'}
            onMouseDown={(e) => e.preventDefault()} onClick={() => run(editor.chain().focus()).run()}><Icon fontSize="small" /></IconButton>
        </Tooltip>
      ))}
      <Tooltip title="Link"><IconButton size="small" aria-label="Link" aria-pressed={!!active.link} color={active.link ? 'primary' : 'default'} onMouseDown={(e) => e.preventDefault()} onClick={link}><LinkIcon fontSize="small" /></IconButton></Tooltip>
      {btn('Insert table', TableChartOutlinedIcon, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      {inTable && btn('Add row', PlaylistAddIcon, () => editor.chain().focus().addRowAfter().run())}
      {inTable && btn('Add column', ViewColumnIcon, () => editor.chain().focus().addColumnAfter().run())}
      {inTable && btn('Delete table', DeleteOutlineIcon, () => editor.chain().focus().deleteTable().run())}
    </Stack>
  );
}

// `doc` seeds the editor; remount it (key) to load a different document.
// The editable area fills the whole box, so a click anywhere in it starts typing, and an empty editor says where to type.
export function RichEditor({ doc, onChange, label = 'Page content', placeholder = 'Start writing here…', minHeight = 240 }) {
  const editor = useEditor({
    extensions: EXTENSIONS, content: doc?.type ? doc : EMPTY_DOC,
    editorProps: { attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label } },
    onUpdate: ({ editor: e }) => onChange(e.getJSON()),
  });
  const empty = useEditorState({ editor, selector: (st) => st.editor?.isEmpty ?? true });
  if (!editor) return null;
  // Presses on the padding or below the text (outside the editable element) still focus the editor, at the end.
  const focusEnd = (e) => { if (!e.target.closest?.('.tiptap')) { e.preventDefault(); editor.commands.focus('end'); } };
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, '&:focus-within': { borderColor: 'primary.main', outline: 1, outlineColor: 'primary.main' }, ...contentSx }}>
      <Toolbar editor={editor} />
      <Box data-testid="editor-surface" onMouseDown={focusEnd} sx={{ position: 'relative', cursor: 'text', '& .tiptap': { minHeight, px: 2, py: 1, boxSizing: 'border-box' } }}>
        {empty && <Typography aria-hidden="true" color="text.secondary" sx={{ position: 'absolute', top: 0, left: 0, px: 2, py: 2, pointerEvents: 'none' }}>{placeholder}</Typography>}
        <EditorContent editor={editor} />
      </Box>
    </Box>
  );
}

export function RichView({ doc }) {
  const editor = useEditor({ extensions: EXTENSIONS, content: doc?.type ? doc : EMPTY_DOC, editable: false });
  useEffect(() => { if (editor && doc?.type) editor.commands.setContent(doc); }, [editor, doc]);
  if (!editor) return null;
  return <Box sx={contentSx}><EditorContent editor={editor} /></Box>;
}
