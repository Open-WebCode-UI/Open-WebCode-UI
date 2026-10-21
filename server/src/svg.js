// Conservative SVG sanitizer: allow-list of elements/attributes; anything scriptable is dropped.
const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc', 'text', 'tspan', 'clippath', 'mask']);
const ALLOWED_ATTRS = new Set(['d', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'viewbox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'points', 'offset', 'stop-color', 'stop-opacity', 'id', 'xmlns', 'preserveaspectratio', 'fill-rule', 'clip-rule', 'gradientunits', 'gradienttransform', 'font-size', 'font-family', 'text-anchor', 'class']);

export function sanitizeSvg(src) {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(src)) return null;
  const s = src.replace(/<\?xml[^>]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^<svg[\s>]/i.test(s)) return null;
  let bad = false;
  const out = s.replace(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g, (_m, close, tag, attrs, selfClose) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) { bad = true; return ''; }
    if (close) return `</${t}>`;
    const kept = [];
    for (const m of attrs.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = m[1].toLowerCase(), val = m[3] ?? m[4] ?? '';
      if (!ALLOWED_ATTRS.has(name) || /javascript:|data:|url\s*\(\s*['"]?(?!#)/i.test(val) || /[<>]/.test(val)) continue;
      kept.push(`${name}="${val.replace(/"/g, '&quot;')}"`);
    }
    return `<${t}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose ? '/' : ''}>`;
  });
  return bad ? null : out;
}
