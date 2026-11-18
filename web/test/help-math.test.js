import { describe, it, expect } from 'vitest';
import { TOPICS } from '../src/help/content.js';

// Help text is Markdown with math enabled, so a bare dollar sign can open a formula.
// Every dollar sign in prose must be escaped as \$. Code blocks and inline code are literal and are skipped.
describe('help text shows dollar signs as text, not math', () => {
  it('escapes each dollar sign outside code', () => {
    for (const t of TOPICS) {
      const prose = t.body
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]*`/g, '');
      const bare = prose.match(/(^|[^\\])\$/g);
      expect(bare, `${t.id} has an unescaped dollar sign`).toBeNull();
    }
  });
});
