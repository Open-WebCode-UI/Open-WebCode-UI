import { describe, it, expect } from 'vitest';
import { systemPromptFor, effortNote, EFFORT_LEVELS } from '../src/agent/prompts.js';

describe('effort level in the system prompt', () => {
  it('balanced (or nothing) leaves the prompt unchanged', () => {
    for (const kind of ['plan', 'act', 'chat']) {
      expect(systemPromptFor(kind, '', { effort: 'balanced' })).toBe(systemPromptFor(kind, ''));
      expect(systemPromptFor(kind, '', { effort: undefined })).toBe(systemPromptFor(kind, ''));
    }
  });
  it('quick and thorough add their instruction at the very end, after the platform rules and the approved plan', () => {
    const quick = systemPromptFor('act', '', { effort: 'quick', approvedPlan: 'PLAN-X' });
    expect(quick).toMatch(/# Effort\nThe user chose QUICK/);
    expect(quick.indexOf('PLAN-X')).toBeLessThan(quick.indexOf('# Effort'));
    expect(quick.indexOf('PLATFORM RULES')).toBeLessThan(quick.indexOf('# Effort'));
    expect(systemPromptFor('plan', '', { effort: 'thorough' })).toMatch(/THOROUGH/);
    expect(systemPromptFor('chat', 'custom prompt', { effort: 'thorough' })).toMatch(/^custom prompt[\s\S]*THOROUGH/);
  });
  it('ignores unknown values and lists the three levels', () => {
    expect(effortNote('extreme')).toBe('');
    expect(EFFORT_LEVELS).toEqual(['quick', 'balanced', 'thorough']);
  });
});

describe('persona name', () => {
  it('is added to the default prompt for every mode', () => {
    for (const kind of ['plan', 'act', 'general']) expect(systemPromptFor(kind, null, { personaName: 'Ada' })).toContain('Your name is Ada.');
  });
  it('gets -Code in the code assistance chat and -Course in the course design chat', () => {
    expect(systemPromptFor('chat', null, { personaName: 'Ada' })).toContain('Your name is Ada-Code.');
    expect(systemPromptFor('course', null, { personaName: 'Ada' })).toContain('Your name is Ada-Course.');
  });
  it('is omitted when blank', () => {
    for (const kind of ['plan', 'act', 'chat']) expect(systemPromptFor(kind, null, { personaName: '  ' })).toBe(systemPromptFor(kind, null));
  });
  it('is replaced by a user-written prompt', () => {
    expect(systemPromptFor('act', 'Be terse.', { personaName: 'Ada' })).not.toContain('Ada');
  });
});
