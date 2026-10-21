// Callout blocks for documentation, written as a blockquote whose first line names the kind:
//
//   > [!INFO]
//   > A helpful hint.
//
// Kinds: INFO (a hint), WARNING (be careful), DANGER (destructive or irreversible). The marker is case-insensitive and the rest of
// the quote is ordinary Markdown (lists, bold, links, code). Without a marker a blockquote stays a plain quote.
export const ADMONITION_KINDS = ['info', 'warning', 'danger'];
const MARKER = /^\[!(info|warning|danger)\][ \t]*\n?/i;

// remark plugin: turns marked blockquotes into <aside data-kind="…"> (rendered by the Admonition component).
export function remarkAdmonitions() {
  return (tree) => {
    const walk = (node) => {
      if (node.type === 'blockquote') {
        const para = node.children?.[0], first = para?.type === 'paragraph' ? para.children?.[0] : null;
        const m = first?.type === 'text' ? MARKER.exec(first.value) : null;
        if (m) {
          first.value = first.value.slice(m[0].length);
          if (!first.value) para.children.shift();
          if (!para.children.length) node.children.shift();
          node.data = { ...node.data, hName: 'aside', hProperties: { 'data-kind': m[1].toLowerCase() } };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
