// Question types and their grading. Auto-graded types (mcq, tf) score at once; text waits for an instructor (score null = pending).
export const AUTO_TYPES = ['mcq', 'tf'];

// Does this question wait for an instructor? Written answers do, and so do exercises that have rubric items.
export const needsGrader = (type, rubricCount = 0) => type === 'text' || (type === 'exercise' && rubricCount > 0);
export const rowNeedsGrader = (q) => needsGrader(q.type, q.type === 'exercise' ? JSON.parse(q.code_spec_json).rubric?.length ?? 0 : 0);


// A learner's response, checked against the question. Returns the cleaned response, or throws Error('invalid_response').
export function cleanResponse(q, r) {
  if (r == null) return null; // left blank
  const bad = () => { throw new Error('invalid_response'); };
  if (q.type === 'mcq') {
    const opts = JSON.parse(q.options_json);
    if (!r || !Array.isArray(r.choices)) bad();
    const c = [...new Set(r.choices)];
    if (!c.every((i) => Number.isInteger(i) && i >= 0 && i < opts.length)) bad();
    if (!isMulti(q) && c.length > 1) bad();
    return { choices: c.sort((a, b) => a - b) };
  }
  if (q.type === 'tf') { if (typeof r.value !== 'boolean') bad(); return { value: r.value }; }
  if (q.type === 'exercise') return null; // graded from the workspace, never from what the browser sends
  if (q.type === 'text') { if (typeof r.text !== 'string' || r.text.length > 10000) bad(); return r.text.trim() ? { text: r.text } : null; }
  return bad();
}
export const isMulti = (q) => (JSON.parse(q.answer_key_json)?.correct?.length ?? 0) > 1;

// Points earned for an answered question, or null when it needs a person.
export function gradeAuto(q, response) {
  const key = JSON.parse(q.answer_key_json);
  if (q.type === 'text' || q.type === 'exercise') return null;
  if (response == null) return 0;
  if (q.type === 'tf') return response.value === key.correct ? q.points : 0;
  const want = [...key.correct].sort((a, b) => a - b);
  return want.length === response.choices.length && want.every((v, i) => v === response.choices[i]) ? q.points : 0;
}

// Percent of the available points, one decimal. Pending answers count as zero until graded.
export function percent(earned, total) { return total ? Math.round((1000 * earned) / total) / 10 : 0; }
