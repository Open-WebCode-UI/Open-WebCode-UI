import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import CoursesPage from '../src/pages/Courses.jsx';
import { renderApp, userWith } from './helpers.jsx';

afterEach(cleanup);
const open = (route, perms, routes) => renderApp(<Routes><Route path="/courses/*" element={<CoursesPage />} /></Routes>, { route, user: userWith(perms), routes });
const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
const course = { id: 7, title: 'JS', description: '', status: 'published', canEdit: false, completed: [], subpanels: [], pages: [{ id: 1, title: 'One', layout: 'content', content: doc, config: {} }] };
const quizPage = (id, assessmentId, title) => ({ id, title, layout: 'assessment', assessmentId, content: doc, config: {} });
const summary = { id: 5, courseId: 7, pageId: 1, title: 'Quiz 1', passPct: 60, maxAttempts: 2, questionCount: 3, totalPoints: 5, attemptsUsed: 0, inProgress: false, awaitingGrade: false, bestScore: null, passed: false };
const questions = [
  { id: 11, type: 'mcq', prompt: 'Pick primes', options: ['2', '4', '5'], multi: true, points: 2 },
  { id: 12, type: 'tf', prompt: 'Water is wet', options: [], points: 1 },
  { id: 13, type: 'text', prompt: 'Explain scope', options: [], points: 2 },
];

describe('taking an assessment', () => {
  it('shows an assessment as a page among the others, and runs it there', async () => {
    open('/courses/7/2', ['course.learn'], { '/api/courses/7': { ...course, pages: [...course.pages, quizPage(2, 5, 'Quiz 1')] }, '/api/courses/7/assessments': [summary] });
    expect(await screen.findByRole('link', { name: 'Quiz 1' })).toHaveAttribute('href', '/courses/7/2');
    expect(screen.getByRole('link', { name: 'One' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument(); // finishing the assessment completes the page
  });

  it('runs an attempt: answers each type, submits, and shows the score', async () => {
    const result = { id: 99, status: 'submitted', score: 40, passPct: 60, passed: null, questions: questions.map((q) => ({ ...q, earned: q.type === 'text' ? null : q.points, feedback: '' })) };
    const { fetch } = open('/courses/7/assessment/5', ['course.learn'], {
      '/api/courses/7/assessments': [summary],
      'POST /api/courses/7/assessments/5/attempts': { id: 99, status: 'in_progress', questions },
      'POST /api/courses/7/attempts/99/submit': result,
    });
    expect(await screen.findByText(/3 questions, 5 points/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: '2' })); await userEvent.click(screen.getByRole('checkbox', { name: '5' }));
    await userEvent.click(screen.getByRole('radio', { name: 'True' }));
    await userEvent.type(screen.getByLabelText('Your answer'), 'Where names live');
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(await screen.findByText(/Submitted\. Your score so far is 40%/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for your instructor')).toBeInTheDocument();
    expect(fetch.calls.find((c) => c.url.endsWith('/submit')).body).toEqual({ answers: { 11: { choices: [0, 2] }, 12: { value: true }, 13: { text: 'Where names live' } } });
  });

  it('explains when no attempts are left', async () => {
    open('/courses/7/assessment/5', ['course.learn'], { '/api/courses/7/assessments': [{ ...summary, attemptsUsed: 2, bestScore: 50 }] });
    expect(await screen.findByText(/2 of 2 attempts used/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start another attempt' })).toBeDisabled();
  });
});

describe('authoring and grading', () => {
  const manage = [{ id: 5, courseId: 7, pageId: 1, title: 'Quiz 1', passPct: 60, maxAttempts: 2, locked: false, questions: [{ id: 12, type: 'tf', prompt: 'Water is wet', points: 1, options: [], correct: true }] }];

  it('adds a multiple-choice question with several correct options', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course, canEdit: true, pages: [quizPage(2, 5, 'Quiz 1')] }, '/api/courses/7/assessments/manage': manage, '/api/courses/7/assessments/5/attempts': [],
      'POST /api/courses/7/assessments/5/questions': { id: 20 },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add question' }));
    await userEvent.type(screen.getByLabelText('Question'), 'Pick primes');
    await userEvent.type(screen.getByLabelText('Option 1'), '2'); await userEvent.type(screen.getByLabelText('Option 2'), '4');
    await userEvent.click(screen.getByRole('button', { name: 'Add option' })); await userEvent.type(screen.getByLabelText('Option 3'), '5');
    expect(screen.getByRole('button', { name: 'Add question' })).toBeDisabled(); // no correct option ticked yet
    await userEvent.click(screen.getByRole('checkbox', { name: 'Option 1 is correct' })); await userEvent.click(screen.getByRole('checkbox', { name: 'Option 3 is correct' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/questions'))).toBe(true));
    expect(fetch.calls.find((c) => c.url.endsWith('/questions')).body).toEqual({ type: 'mcq', prompt: 'Pick primes', points: 1, options: ['2', '4', '5'], correct: [0, 2] });
  });

  it('locked assessments cannot have questions changed', async () => {
    open('/courses/7/edit', ['course.author'], { '/api/courses/7': { ...course, canEdit: true, pages: [quizPage(2, 5, 'Quiz 1')] }, '/api/courses/7/assessments/manage': [{ ...manage[0], locked: true }], '/api/courses/7/assessments/5/attempts': [] });
    expect(await screen.findByText(/questions are locked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('grades a written answer', async () => {
    const att = { id: 99, status: 'submitted', score: 20, questions: [{ id: 13, type: 'text', prompt: 'Explain scope', points: 4, response: { text: 'Names are visible in blocks' }, earned: null, feedback: '', rubric: 'Mentions blocks' }] };
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course, canEdit: true, pages: [quizPage(2, 5, 'Quiz 1')] }, '/api/courses/7/assessments/manage': manage,
      '/api/courses/7/assessments/5/attempts': [{ id: 99, status: 'submitted', score: 20, learner: 'Sam Student' }],
      'GET /api/courses/7/attempts/99': att,
      'PUT /api/courses/7/attempts/99/answers/13/grade': { ...att, status: 'graded', score: 75 },
    });
    expect(await screen.findByText('Needs grading')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Grade' }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('Names are visible in blocks')).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('Score out of 4'), '3');
    await userEvent.type(within(dlg).getByLabelText('Feedback for the learner'), 'Nice');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save grade' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/grade'))).toBe(true));
    expect(fetch.calls.find((c) => c.url.endsWith('/grade')).body).toEqual({ score: 3, feedback: 'Nice' });
    expect(await within(dlg).findByText('Saved')).toBeInTheDocument();
  });
});

describe('agentic-coding exercises', () => {
  const ex = { brief: 'Ask the agent to add a notes file.', rules: ['Shell commands and the terminal are off.', 'Git and downloads are off.'], canUseAgent: true, workspace: { projectId: 42 },
    criteria: [{ label: 'Notes file created', points: 2, kind: 'check' }, { label: 'Planned first', points: 1, kind: 'check' }, { label: 'Clear prompts', points: 4, kind: 'rubric' }] };
  const exQ = { id: 30, type: 'exercise', prompt: 'Notes exercise', points: 7, options: [], exercise: ex };
  const exSummary = { ...summary, id: 6, title: 'Exercise 1', questionCount: 1, totalPoints: 7, maxAttempts: 0 };

  it('shows the brief and criteria, links to the workspace, and submits without any typed answer', async () => {
    const result = { id: 98, status: 'submitted', score: 28.6, passPct: 60, passed: null, questions: [{ ...exQ, earned: null, feedback: '', response: { autoScore: 2, rubricScores: null, checks: [{ label: 'Notes file created', passed: true, points: 2, detail: '' }, { label: 'Planned first', passed: false, points: 1, detail: 'Not used enough' }] } }] };
    const { fetch } = open('/courses/7/assessment/6', ['course.learn'], {
      '/api/courses/7/assessments': [exSummary],
      'POST /api/courses/7/assessments/6/attempts': { id: 98, status: 'in_progress', questions: [exQ] },
      'POST /api/courses/7/attempts/98/submit': result,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Ask the agent to add a notes file.')).toBeInTheDocument();
    expect(screen.getByText('Shell commands and the terminal are off.')).toBeInTheDocument(); // the rules are shown before the learner starts
    expect(screen.getByText(/Clear prompts \(4 points, marked by your instructor\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open your workspace in the agent' })).toHaveAttribute('href', '/?project=42');
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(await screen.findByText(/Submitted\. Your score so far is 28\.6%/)).toBeInTheDocument();
    expect(screen.getByText(/✓ Notes file created/)).toBeInTheDocument();
    expect(screen.getByText(/✗ Planned first/)).toBeInTheDocument(); expect(screen.getByText('Not used enough')).toBeInTheDocument();
    expect(fetch.calls.find((c) => c.url.endsWith('/submit')).body).toEqual({ answers: {} });
  });

  it('warns when the learner cannot use the agent', async () => {
    open('/courses/7/assessment/6', ['course.learn'], { '/api/courses/7/assessments': [exSummary], 'POST /api/courses/7/assessments/6/attempts': { id: 98, status: 'in_progress', questions: [{ ...exQ, exercise: { ...ex, canUseAgent: false } }] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/does not include the agent/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open your workspace/ })).toBeNull();
  });

  it('instructors build an exercise with starter files, checks and a rubric', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course, canEdit: true, pages: [quizPage(3, 6, 'Exercise 1')] }, '/api/courses/7/assessments/manage': [{ id: 6, courseId: 7, pageId: null, title: 'Exercise 1', passPct: 60, maxAttempts: 0, locked: false, questions: [] }],
      '/api/courses/7/assessments/6/attempts': [], 'POST /api/courses/7/assessments/6/questions': { id: 31 },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add question' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Question type' })); await userEvent.click(screen.getByRole('option', { name: 'Agentic-coding exercise' }));
    await userEvent.type(screen.getByLabelText('Question'), 'Notes exercise');
    await userEvent.type(screen.getByLabelText(/Brief for the learner/), 'Add a notes file');
    await userEvent.click(screen.getByRole('button', { name: 'Add starter file' }));
    await userEvent.type(screen.getByLabelText('Starter file 1 path'), 'README.md'); await userEvent.type(screen.getByLabelText('Starter file 1 content'), '# Hi');
    await userEvent.click(screen.getByRole('button', { name: 'Add check' })); // file exists
    await userEvent.type(screen.getByLabelText('Check 1 name'), 'Notes file created'); await userEvent.type(screen.getByLabelText('Check 1 file path'), 'notes.md');
    expect(screen.getByRole('button', { name: 'Add question' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add rubric item' })); await userEvent.type(screen.getByLabelText('Rubric item 1'), 'Clear prompts');
    expect(screen.getByText('2 points in total (from the items below)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/questions'))).toBe(true));
    expect(fetch.calls.find((c) => c.url.endsWith('/questions')).body).toEqual({ type: 'exercise', prompt: 'Notes exercise', spec: {
      brief: 'Add a notes file', starterFiles: [{ path: 'README.md', content: '# Hi' }],
      checks: [{ type: 'file_exists', label: 'Notes file created', points: 1, path: 'notes.md' }], rubric: [{ label: 'Clear prompts', points: 1 }], policy: expect.objectContaining({ preset: 'guided', mode: 'act', requirePlan: true, shell: false }) } });
  });

  it('grades the rubric and lets the instructor read the evidence', async () => {
    const att = { id: 98, status: 'submitted', score: 28.6, questions: [{ ...exQ, earned: null, feedback: '', rubric: undefined, response: { autoScore: 2, rubricScores: null, checks: [{ label: 'Notes file created', passed: true, points: 2, detail: '' }, { label: 'Planned first', passed: false, points: 1, detail: 'Not used enough' }] } }] };
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course, canEdit: true, pages: [quizPage(3, 6, 'Exercise 1')] },
      '/api/courses/7/assessments/manage': [{ id: 6, courseId: 7, pageId: null, title: 'Exercise 1', passPct: 60, maxAttempts: 0, locked: true, questions: [] }],
      '/api/courses/7/assessments/6/attempts': [{ id: 98, status: 'submitted', score: 28.6, learner: 'Sam Student' }],
      'GET /api/courses/7/attempts/98': att,
      'GET /api/courses/7/attempts/98/exercises/30/files': { files: [{ path: 'notes.md', size: 9 }] },
      'GET /api/courses/7/attempts/98/exercises/30/file': { path: 'notes.md', content: 'add tests' },
      'GET /api/courses/7/attempts/98/exercises/30/transcript': { messages: [{ role: 'user', content: 'write tests please' }, { role: 'assistant', content: 'Plan ready', tools: [{ name: 'propose_plan', args: '{}' }] }] },
      'PUT /api/courses/7/attempts/98/answers/30/grade': { ...att, status: 'graded' },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Grade' }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('✗ Planned first (1) — Not used enough')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'View submitted files' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'notes.md' }));
    expect(await within(dlg).findByText('add tests')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'View agent sessions' }));
    expect(await within(dlg).findByText(/used propose_plan/)).toBeInTheDocument(); expect(within(dlg).getByText('write tests please')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Save grade' })).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText('Clear prompts (out of 4)'), '3');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save grade' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/grade'))).toBe(true));
    expect(fetch.calls.find((c) => c.url.endsWith('/grade')).body).toEqual({ rubric: [3], feedback: '' });
  });
});

describe('agent rules editor', () => {
  const preview = (init) => {
    const { policy } = JSON.parse(init.body);
    return { summary: [], abilities: [
      { label: 'Let the agent change files', role: true, allowed: policy.mode === 'act' },
      { label: 'Git push', role: true, allowed: policy.git },
      { label: 'Web search', role: false, allowed: false },
    ] };
  };
  async function openBuilder() {
    const r = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course, canEdit: true, pages: [quizPage(3, 6, 'Exercise 1')] }, '/api/courses/7/assessments/manage': [{ id: 6, courseId: 7, pageId: null, title: 'Exercise 1', passPct: 60, maxAttempts: 0, locked: false, questions: [] }],
      '/api/courses/7/assessments/6/attempts': [], '/api/models': { models: [{ id: 3, label: 'Fake', provider: 'p' }] }, '/api/courses-roles': ['developer', 'instructor'],
      'POST /api/courses-policy-preview': preview, 'POST /api/courses/7/assessments/6/questions': { id: 31 },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add question' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Question type' })); await userEvent.click(screen.getByRole('option', { name: 'Agentic-coding exercise' }));
    await userEvent.type(screen.getByLabelText('Question'), 'Rules exercise'); await userEvent.type(screen.getByLabelText(/Brief for the learner/), 'Do it');
    await userEvent.click(screen.getByRole('button', { name: 'Add rubric item' })); await userEvent.type(screen.getByLabelText('Rubric item 1'), 'Quality');
    return r;
  }

  it('starts from the Guided preset and previews what the chosen role can do', async () => {
    await openBuilder();
    expect(screen.getByRole('button', { name: 'Guided' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/Let the agent change files$/)).toBeInTheDocument();
    expect(screen.getByText(/✗ Web search \(this role does not have it\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Plan only' }));
    expect(await screen.findByText(/✗ Let the agent change files \(turned off by these rules\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Require an approved plan before it changes files')).toBeDisabled();
  });

  it('switching a setting makes it Custom; protected files and the shell exclude each other; the rules are sent with the question', async () => {
    const { fetch } = await openBuilder();
    await userEvent.type(screen.getByLabelText(/Protected files and folders/), 'tests');
    expect(screen.getByLabelText('Allow shell commands and the terminal')).toBeDisabled(); // a shell could edit any file
    await userEvent.type(screen.getByLabelText('Time limit (minutes)'), '45');
    await userEvent.click(screen.getByLabelText('Allow Git and downloads'));
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/questions'))).toBe(true));
    expect(fetch.calls.find((c) => c.url.endsWith('/questions')).body.spec.policy).toMatchObject({ preset: 'custom', mode: 'act', requirePlan: true, shell: false, git: true, protectedFiles: ['tests'], timeLimitMin: 45, maxSteps: null });
  });

  it('a Full preset with files protected is refused by the form: the shell must be off first', async () => {
    await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Full agent' }));
    expect(screen.getByLabelText(/Protected files and folders/)).toBeDisabled();
    expect(screen.getByText(/Turn the shell off to protect files/)).toBeInTheDocument();
  });
});
