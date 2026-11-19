// Adds a stylesheet for editor decorations once. Monaco decorations reference CSS classes, and the classes are not part of the app's CSS.
export function ensureStyle(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id; el.textContent = css; document.head.appendChild(el);
}
