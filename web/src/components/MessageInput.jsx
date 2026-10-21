import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Box, IconButton, Stack, TextField, Tooltip } from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS';
import CodeIcon from '@mui/icons-material/Code';
import TitleIcon from '@mui/icons-material/Title';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import DataObjectIcon from '@mui/icons-material/DataObject';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

// Markdown the user has deliberately typed: a block marker plus some text (# Title, - item, 1. item, > quote), a complete code fence (an unclosed one stays plain so Enter can add lines),
// or a completed inline span (**bold**, *italic*, ~~strike~~, `code`, [text](url)).
export const looksLikeMarkdown = (s) => /^ {0,3}(#{1,6}|[-*+]|\d+[.)]|>)[ \t]+\S/m.test(s) || /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1/m.test(s)
  || /\*\*[^*\s](?:[^*]*[^*\s])?\*\*|~~[^~\s](?:[^~]*[^~\s])?~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s](?:[^*\n]*[^*\s])?\*(?![\w*])/.test(s);

const TOOLS = [
  ['Bold', FormatBoldIcon, 'bold', (c) => c.toggleBold()],
  ['Italic', FormatItalicIcon, 'italic', (c) => c.toggleItalic()],
  ['Strikethrough', StrikethroughSIcon, 'strike', (c) => c.toggleStrike()],
  ['Inline code', CodeIcon, 'code', (c) => c.toggleCode()],
  ['Heading', TitleIcon, 'heading', (c) => c.toggleHeading({ level: 2 })],
  ['Bulleted list', FormatListBulletedIcon, 'bulletList', (c) => c.toggleBulletList()],
  ['Numbered list', FormatListNumberedIcon, 'orderedList', (c) => c.toggleOrderedList()],
  ['Quote', FormatQuoteIcon, 'blockquote', (c) => c.toggleBlockquote()],
  ['Code block', DataObjectIcon, 'codeBlock', (c) => c.toggleCodeBlock()],
];

function Toolbar({ editor, disabled }) {
  const active = useEditorState({ editor, selector: (s) => Object.fromEntries(TOOLS.map(([, , name]) => [name, s.editor.isActive(name)])) });
  return (
    <Stack direction="row" role="toolbar" aria-label="Formatting" sx={{ px: 0.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
      {TOOLS.map(([label, Icon, name, run]) => (
        <Tooltip key={name} title={label}>
          <span><IconButton size="small" aria-label={label} aria-pressed={!!active[name]} color={active[name] ? 'primary' : 'default'} disabled={disabled}
            onMouseDown={(e) => e.preventDefault()} onClick={() => run(editor.chain().focus()).run()}><Icon fontSize="small" /></IconButton></span>
        </Tooltip>
      ))}
    </Stack>
  );
}

// Enter sends, except inside a code block or list item where it adds a line/item (multi-line logs, bullet and numbered lists); Ctrl/Cmd+Enter always sends.
const inMultiline = ({ $from }) => $from.parent.type.name === 'codeBlock'
  || Array.from({ length: $from.depth + 1 }, (_, d) => $from.node(d).type.name).includes('listItem');
export const editorEnterSends = (state, e) => e.key === 'Enter' && !e.shiftKey && !e.isComposing
  && (e.metaKey || e.ctrlKey || !inMultiline(state.selection));

function Wysiwyg({ value, onChange, onSubmit, placeholder, disabled, maxRows, ref }) {
  const cb = useRef({}); cb.current = { onChange, onSubmit };
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false }, trailingNode: false }), Markdown],
    content: value, contentType: 'markdown', autofocus: 'end', editable: !disabled,
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Message', 'data-placeholder': placeholder || '' },
      handleKeyDown: (view, e) => {
        // "```" or "```js" + Enter opens a code block (TipTap's own rule only fires on space).
        const para = view.state.selection.$from.parent;
        const fence = e.key === 'Enter' && !e.shiftKey && !e.isComposing && para.type.name === 'paragraph' && /^```([\w+#-]*)$/.exec(para.textContent);
        if (fence) {
          e.preventDefault();
          const { $from } = view.state.selection;
          view.dispatch(view.state.tr.delete($from.start(), $from.end()).setBlockType($from.start(), $from.start(), view.state.schema.nodes.codeBlock, { language: fence[1] || null }));
          return true;
        }
        if (!editorEnterSends(view.state, e)) return false;
        e.preventDefault(); cb.current.onSubmit?.(); return true;
      },
    },
    // The draft is what the user typed, so don't let the serializer rewrite literal text ("> x" -> "&gt; x", "```" -> "\`\`\`").
    onBeforeCreate: ({ editor: ed }) => { ed.markdown.encodeTextForMarkdown = (text) => text; },
    onUpdate: ({ editor: ed }) => cb.current.onChange(ed.getMarkdown()),
  });
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  // We arrive here the moment the user types a closing marker (e.g. the second ** of **bold**): park the caret after the
  // formatted text with no active marks so the next keystrokes are plain.
  useEffect(() => { if (editor) editor.chain().focus('end').command(({ tr }) => { tr.setStoredMarks([]); return true; }).run(); }, [editor]);
  // Sync outside changes (skill picker, follow-up, send clearing the draft) without clobbering our own edits.
  useEffect(() => {
    if (editor && value !== editor.getMarkdown()) editor.commands.setContent(value, { contentType: 'markdown' });
  }, [editor, value]);
  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus('end') }), [editor]);
  if (!editor) return null;
  return (
    <Box data-testid="wysiwyg-editor" sx={{ flexGrow: 1, minWidth: 0, border: 1, borderColor: 'divider', borderRadius: 1, '&:focus-within': { borderColor: 'primary.main' } }}>
      <Toolbar editor={editor} disabled={disabled} />
      <Box sx={{ px: 1.5, py: 1, maxHeight: `${maxRows * 1.5}em`, overflowY: 'auto', cursor: 'text',
        '& .tiptap': { outline: 'none', minHeight: '1.5em', overflowWrap: 'anywhere' },
        '& .tiptap p': { m: 0 }, '& .tiptap h1,& .tiptap h2,& .tiptap h3': { m: 0, fontSize: '1.1em' },
        '& .tiptap ul,& .tiptap ol': { my: 0, pl: 3 }, '& .tiptap blockquote': { m: 0, pl: 1.5, borderLeft: 3, borderColor: 'divider' },
        '& .tiptap code': { fontFamily: 'monospace', bgcolor: 'action.hover', px: 0.5, borderRadius: 0.5 },
        '& .tiptap pre': { m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }, '& .tiptap pre code': { bgcolor: 'transparent', p: 0 } }}>
        <EditorContent editor={editor} />
      </Box>
    </Box>
  );
}

// Plain text box until the user types markdown, then a WYSIWYG editor seeded with (and formatting) that markdown.
// The value is always a markdown string. Emptying the draft (e.g. after send) returns to the plain box.
export default function MessageInput({ value, onChange, onSubmit, placeholder, disabled, maxRows = 8, size, ref }) {
  const [rich, setRich] = useState(() => looksLikeMarkdown(value));
  if (rich && !value) setRich(false);
  if (!rich && value && looksLikeMarkdown(value)) setRich(true);
  // Inside an unclosed ``` fence Enter adds a line so a multi-line block can be written; Ctrl/Cmd+Enter always sends.
  const inOpenFence = () => ((value.match(/^ {0,3}(```|~~~)/gm) || []).length % 2) === 1;
  const submitKey = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent?.isComposing) return;
    if (!(e.metaKey || e.ctrlKey) && inOpenFence()) return;
    e.preventDefault(); onSubmit?.();
  };
  if (rich) return <Wysiwyg value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} disabled={disabled} maxRows={maxRows} ref={ref} />;
  return <TextField fullWidth multiline maxRows={maxRows} size={size} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={submitKey} disabled={disabled}
    inputRef={ref} slotProps={{ htmlInput: { 'aria-label': 'Message' } }} />;
}
