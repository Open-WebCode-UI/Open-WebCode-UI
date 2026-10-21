import { useEffect, useState } from 'react';

const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
export const findTarget = (name) => [...document.querySelectorAll(`[data-tour="${CSS.escape(name)}"]`)].find(visible) || null;

// Finds the element carrying data-tour="<name>", waiting for it to render (route changes, async data) and following
// it if React replaces the node. Returns { el, timedOut }; after `timeoutMs` without a match the UI falls back to a centered card.
export function useTourTarget(name, { timeoutMs = 2500, enabled = true } = {}) {
  const [found, setFound] = useState({ name: null, el: null, timedOut: false });
  useEffect(() => {
    if (!enabled || !name) return undefined;
    let raf = 0, timer = 0, el = null;
    const scan = () => {
      raf = 0;
      const next = findTarget(name);
      if (next === el) return;
      el = next;
      if (el) clearTimeout(timer);
      setFound({ name, el, timedOut: false });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(scan); };
    scan();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tour', 'hidden', 'style', 'class'] });
    if (!el) timer = setTimeout(() => { if (!el) setFound({ name, el: null, timedOut: true }); }, timeoutMs);
    return () => { mo.disconnect(); cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [name, enabled, timeoutMs]);
  // Ignore results that belong to a previous step's target.
  return found.name === name && enabled ? found : { el: null, timedOut: false };
}
