import { memo, useEffect, useState } from 'react';
import { useTheme } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ReportOutlinedIcon from '@mui/icons-material/ReportOutlined';
import { remarkAdmonitions } from './markdownAdmonitions.js';
import { remarkKeys } from './markdownKeys.js';

// Plain text of a React node tree (code blocks are highlighted into nested spans, but copy needs the raw text).
const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children));

// Mermaid diagrams: the library is loaded on first use. Source that does not parse (including a half-streamed block) stays a plain code block,
// and `securityLevel: 'strict'` makes mermaid sanitise the labels and disable click handlers in the SVG it produces.
let mermaidSeq = 0;
function Mermaid({ source, fallback }) {
  const dark = useTheme().palette.mode === 'dark';
  const [svg, setSvg] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        const out = await mermaid.render(`mermaid-${++mermaidSeq}`, source);
        if (live) setSvg(out.svg);
      } catch { if (live) setSvg(null); document.getElementById(`dmermaid-${mermaidSeq}`)?.remove(); }
    })();
    return () => { live = false; };
  }, [source, dark]);
  if (!svg) return fallback;
  return <Box data-testid="mermaid-diagram" role="img" aria-label="Diagram" sx={{ my: 1.5, overflowX: 'auto', textAlign: 'center', '& svg': { maxWidth: '100%', height: 'auto' } }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const code = children?.props || {};
  const lang = /language-([\w+#-]+)/.exec(code.className || '')?.[1];
  const copy = async () => { try { await navigator.clipboard.writeText(textOf(code.children).replace(/\n$/, '')); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } };
  const block = (
    <Box sx={{ position: 'relative', my: 1.5 }} data-testid="code-block">
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.25, bgcolor: 'action.selected', borderTopLeftRadius: 6, borderTopRightRadius: 6 }}>
        <Typography variant="caption" sx={{ flexGrow: 1, fontFamily: 'monospace' }}>{lang || 'text'}</Typography>
        <Tooltip title={copied ? 'Copied' : 'Copy code'}><IconButton size="small" aria-label="Copy code" onClick={copy}>{copied ? <CheckIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}</IconButton></Tooltip>
      </Box>
      <Box component="pre" sx={{ m: 0, p: 1.5, overflow: 'auto', bgcolor: 'action.hover', borderBottomLeftRadius: 6, borderBottomRightRadius: 6, fontSize: 13, lineHeight: 1.5 }}>{children}</Box>
    </Box>
  );
  return lang === 'mermaid' ? <Mermaid source={textOf(code.children).trim()} fallback={block} /> : block;
}

// Model output is untrusted: no raw HTML is rendered, remote images are never loaded (they would be a data-exfiltration channel),
// and links open in a new tab only for http(s)/mailto targets.
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const components = {
  pre: CodeBlock,
  a: ({ href, children }) => (href?.startsWith('#') ? <a href={href}>{children}</a> : SAFE_HREF.test(href || '') ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> : <span>{children}</span>),
  img: ({ alt }) => <em>[image{alt ? `: ${alt}` : ''}]</em>,
  table: ({ children }) => <Box sx={{ overflowX: 'auto', my: 1 }}><table>{children}</table></Box>,
};

const tokenColors = (dark) => ({
  '& .hljs-comment, & .hljs-quote': { color: dark ? '#8b949e' : '#6a737d', fontStyle: 'italic' },
  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-literal, & .hljs-doctag': { color: dark ? '#ff7b72' : '#d73a49' },
  '& .hljs-string, & .hljs-regexp, & .hljs-addition': { color: dark ? '#a5d6ff' : '#032f62' },
  '& .hljs-number, & .hljs-attr, & .hljs-attribute, & .hljs-variable, & .hljs-template-variable': { color: dark ? '#79c0ff' : '#005cc5' },
  '& .hljs-title, & .hljs-section, & .hljs-name, & .hljs-selector-id, & .hljs-selector-class': { color: dark ? '#d2a8ff' : '#6f42c1' },
  '& .hljs-built_in, & .hljs-type, & .hljs-class .hljs-title': { color: dark ? '#ffa657' : '#e36209' },
  '& .hljs-meta, & .hljs-symbol, & .hljs-bullet, & .hljs-link': { color: dark ? '#7ee787' : '#22863a' },
  '& .hljs-deletion': { color: dark ? '#ffa198' : '#b31d28' },
  '& .hljs-emphasis': { fontStyle: 'italic' }, '& .hljs-strong': { fontWeight: 700 },
});

// Callout blocks (see markdownAdmonitions.js): blue for info, amber for warning, red for danger. The label and icon carry the meaning too,
// so it never depends on color alone.
const ADMONITION = {
  info: { label: 'Info', Icon: InfoOutlinedIcon, light: { fg: '#0d47a1', edge: '#1976d2', bg: '#e8f1fc' }, dark: { fg: '#90caf9', edge: '#42a5f5', bg: 'rgba(66,165,245,0.14)' } },
  warning: { label: 'Warning', Icon: WarningAmberIcon, light: { fg: '#7a4b00', edge: '#f5a000', bg: '#fff5d9' }, dark: { fg: '#ffd54f', edge: '#ffb300', bg: 'rgba(255,179,0,0.14)' } },
  danger: { label: 'Danger', Icon: ReportOutlinedIcon, light: { fg: '#a31515', edge: '#d32f2f', bg: '#fdecec' }, dark: { fg: '#ef9a9a', edge: '#ef5350', bg: 'rgba(239,83,80,0.16)' } },
};
function Admonition({ 'data-kind': kind, children }) {
  const a = ADMONITION[kind] || ADMONITION.info;
  return (
    <Box component="aside" role="note" aria-label={a.label} data-admonition={kind} sx={(t) => { const c = a[t.palette.mode === 'dark' ? 'dark' : 'light']; return { my: 1.5, py: 1, px: 1.5, borderLeft: 4, borderColor: c.edge, borderRadius: 1, bgcolor: c.bg, '& .admonition-label': { color: c.fg } }; }}>
      <Box className="admonition-label" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.4 }}><a.Icon fontSize="small" aria-hidden />{a.label}</Box>
      <Box sx={{ '& > :first-of-type': { mt: 0.5 }, '& > :last-child': { mb: 0 } }}>{children}</Box>
    </Box>
  );
}
// A keyboard key: drawn like a key cap (sans-serif, raised border) so it never looks like a code snippet (monospace, flat tint).
const keySx = (t) => {
  const dark = t.palette.mode === 'dark';
  return {
    display: 'inline-block', minWidth: '1.6em', px: '0.5em', py: '0.1em', mx: '0.1em', textAlign: 'center', whiteSpace: 'nowrap', verticalAlign: 'baseline',
    fontFamily: t.typography.fontFamily, fontSize: '0.85em', fontWeight: 600, lineHeight: 1.4, letterSpacing: 0.2,
    color: 'text.primary', bgcolor: dark ? '#2b2f36' : '#f6f7f9', border: 1, borderColor: dark ? '#5b6270' : '#b9bfc9', borderBottomWidth: 3, borderRadius: '5px',
    boxShadow: dark ? 'inset 0 -1px 0 #14171c' : 'inset 0 -1px 0 #dfe3e8',
  };
};
const Key = ({ children }) => <Box component="kbd" sx={keySx}>{children}</Box>;
const docsComponents = { ...components, aside: Admonition, kbd: Key };

// Inline variant for short labels (chips, alerts): only phrasing elements, paragraphs unwrapped, no block styling.
const INLINE = ['p', 'code', 'strong', 'em', 'del', 'a'];
// Math: `$..$` / `$$..$$`. KaTeX output is generated from the parsed TeX (not model-supplied HTML); bad TeX renders as red source instead of throwing.
const katexOpts = { throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' };
const remarkBase = [remarkGfm, remarkMath];
const rehypeMath = [[rehypeKatex, katexOpts]];
const inlineComponents = { ...components, p: ({ children }) => <>{children}</> };
const inlineSx = { '& code': { fontFamily: 'monospace', fontSize: '0.9em', px: 0.5, borderRadius: 0.5, bgcolor: 'action.hover' }, '& a': { color: 'primary.main' } };

// `docs` is for the help articles: callout blocks and <kbd> keys are recognised and headings get their full H2-H6 styling.
function Markdown({ children, inline, docs }) {
  if (inline) {
    return (
      <Box component="span" sx={inlineSx}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={INLINE} unwrapDisallowed components={inlineComponents}>{children || ''}</ReactMarkdown>
      </Box>
    );
  }
  return (
    <Box className="markdown-body" sx={(t) => ({
      fontSize: 14, lineHeight: 1.6, wordBreak: 'break-word',
      '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 },
      '& p': { my: 1 }, '& ul, & ol': { my: 1, pl: 3 }, '& li': { my: 0.25 }, '& li > p': { my: 0 },
      '& h1, & h2, & h3, & h4, & h5, & h6': { mt: 2, mb: 1, lineHeight: 1.3, fontWeight: 600 }, '& h1': { fontSize: 20 }, '& h2': { fontSize: 18 }, '& h3': { fontSize: 16 }, '& h4': { fontSize: 14 }, '& h5': { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.4 }, '& h6': { fontSize: 13, fontStyle: 'italic', color: 'text.secondary' },
      ...(docs ? { fontSize: 15, '& h2': { fontSize: 20, mt: 3.5, pb: 0.5, borderBottom: 1, borderColor: 'divider' }, '& h3': { fontSize: 17, mt: 3 }, '& h4': { fontSize: 15, mt: 2.5 }, '& h2:first-child': { mt: 0 } } : {}),
      '& blockquote': { m: 0, my: 1, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
      '& hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 2 },
      '& a': { color: 'primary.main' },
      '& table': { borderCollapse: 'collapse', fontSize: 13 }, '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left' }, '& th': { bgcolor: 'action.hover' },
      '& :not(pre) > code': { fontFamily: 'monospace', fontSize: '0.9em', px: 0.5, py: 0.1, borderRadius: 0.5, bgcolor: 'action.hover' },
      '& pre code': { fontFamily: 'monospace', bgcolor: 'transparent', p: 0 },
      '& input[type=checkbox]': { mr: 0.75 },
      ...tokenColors(t.palette.mode === 'dark'),
    })}>
      <ReactMarkdown remarkPlugins={docs ? [...remarkBase, remarkAdmonitions, remarkKeys] : remarkBase} rehypePlugins={[...rehypeMath, [rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={docs ? docsComponents : components}>{children || ''}</ReactMarkdown>
    </Box>
  );
}
export default memo(Markdown);
