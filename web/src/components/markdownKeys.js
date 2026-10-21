// Keyboard keys in documentation, written as <kbd>Ctrl</kbd>. Raw HTML is never rendered, so this plugin recognises exactly that
// pattern (an opening <kbd>, plain text, a closing </kbd>) and turns it into a real kbd element. Any other HTML stays ignored.
const OPEN = /^<kbd>$/i, CLOSE = /^<\/kbd>$/i;

export function remarkKeys() {
  return (tree) => {
    const walk = (node) => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i += 1) {
        if (kids[i].type === 'html' && OPEN.test(kids[i].value.trim()) && kids[i + 1]?.type === 'text' && kids[i + 2]?.type === 'html' && CLOSE.test(kids[i + 2].value.trim())) {
          kids.splice(i, 3, { type: 'key', data: { hName: 'kbd' }, children: [{ type: 'text', value: kids[i + 1].value }] });
        } else walk(kids[i]);
      }
    };
    walk(tree);
  };
}
