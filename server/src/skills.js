import { getKnex } from './db/index.js';
import { insertId } from './db/dialect.js';
import { HttpError } from './http.js';

// Pre-written skills. Users can edit any of them (stored as a per-user override) and reset to these defaults.
export const BUILTIN_SKILLS = [
  {
    key: 'compact', name: 'compact', action: 'compact', description: 'Summarize this session, then clear the old messages from the agent\'s context. Add a focus, e.g. /compact keep the database decisions.',
    instructions: `You are compacting a long coding session so work can continue in a fresh, smaller context. You will receive the transcript of the session. Write a summary that lets an engineer (or an AI agent) with no other memory carry on seamlessly.

Write in Markdown with these sections, leaving out any that are empty:
## Goal
What the user is trying to achieve, in their words where it matters.
## Decisions and constraints
Choices made and why; conventions, preferences, and rules the user stated; things to avoid.
## Work done
What was built, changed, or found, with exact file paths, function names, and commands. Mention checkpoints that were created.
## Current state
What works, what is broken, test, or build results, anything half-finished.
## Open items and next step
The immediate next step, then remaining tasks, open questions, and risks.
## Approved plan
Copy any approved plan that is still in progress, verbatim.

Rules: keep exact identifiers, paths, and error messages; drop pleasantries, repeated attempts, and raw tool output; never include secrets or credentials (say where they live instead); do not invent facts; be concise but complete. If the user gave a focus, make sure that topic is covered in the most detail. Reply with the summary only.`,
  },
  {
    key: 'code-review', name: 'code-review', description: 'Review code or recent changes for correctness, clarity, tests, and maintainability.',
    instructions: `# Code review

Review the code the user points at. If they did not name files, review what changed: call \`list_changes\` first, then read the touched files in full (a diff alone hides context).

## Process
1. State the scope you are reviewing (files, change size) in one line.
2. Read the changed code and its callers/tests. Check how similar code elsewhere in the project is written and compare conventions.
3. Look for, in this order:
   - **Correctness**: logic errors, off-by-one, null/undefined, and error paths, race conditions, resource leaks, wrong assumptions about inputs.
   - **Security**: untrusted input reaching a sink, authorization gaps, secrets in code, unsafe deserialization/shell/SQL (flag it and suggest running the security-review skill for depth).
   - **Tests**: is the new behavior covered, including failure cases? Would the tests fail if the code were wrong?
   - **Design and readability**: naming, duplication, function size, needless abstraction, public API changes, backwards compatibility.
   - **Performance**: only where it plausibly matters (hot paths, N+1 queries, unbounded growth).
4. Verify each suspected problem against the code before reporting it. Drop findings you cannot support.

## Output
Group findings as **Blocker / Should fix / Nit**. For each give \`path:line\`, what is wrong, why it matters, and a concrete fix (a short snippet if useful). Start with a two-sentence overall assessment and end with what is done well. Do not pad: if the change is good, say so briefly.

Review only; do not edit files unless the user asks for the fixes afterwards.`,
  },
  {
    key: 'security-review', name: 'security-review', description: 'Audit code for vulnerabilities (injection, authz, secrets, unsafe dependencies, crypto) with exploit-focused findings.',
    instructions: `# Security review

Perform a defensive security review of the code the user points at, or of the whole project if none is named. Use \`list_changes\` first when asked about recent changes.

## Method
1. **Map the attack surface**: entry points (HTTP routes, CLI args, file/queue consumers), trust boundaries, authentication, and authorization checks, data stores, external calls.
2. **Use the OWASP Top 10 as your checklist** (broken access control, cryptographic failures, injection, insecure design, security misconfiguration, vulnerable components, authentication failures, integrity failures, logging gaps, SSRF) and **trace untrusted data** from each entry point to sinks. Sinks to check: SQL/NoSQL queries, shell/process execution, file paths (traversal, zip-slip, symlinks), HTML/template output (XSS), deserialization, redirects (open redirect), outbound requests (SSRF), regular expressions (ReDoS), eval/dynamic import.
3. **Check controls**: authn/authz on every route and on object ownership (IDOR), CSRF, session handling, and cookie flags, rate limiting, input validation, error messages that leak internals, logging of secrets.
4. **Secrets and config**: hard-coded keys/tokens/passwords, committed .env files (do not print their values: say where they are), debug flags, permissive CORS, missing security headers, insecure defaults.
5. **Cryptography**: home-grown crypto, weak hashes for passwords (use bcrypt/argon2/scrypt), ECB/static IVs, predictable randomness for tokens, missing TLS verification.
6. **Dependencies**: read the manifest and lockfile for obviously outdated or risky packages and install scripts; recommend running the ecosystem audit tool (you cannot run it unless a shell is enabled).

## Output
A table or list ordered by severity (**Critical / High / Medium / Low / Info**). For each finding: \`path:line\`, the vulnerability class (CWE if known), a realistic exploit scenario in one or two sentences, and a specific fix. Mark anything you could not confirm as "needs verification". Never include real secret values in the report. Finish with the top three fixes to do first.

Report only; do not change code unless the user asks for the fixes.`,
  },
  {
    key: 'write-tests', name: 'write-tests', description: 'Add focused, maintainable tests that follow the project\'s existing test setup.',
    instructions: `# Write tests

1. Find the project's test framework, runner command, file layout, and naming (look at package.json / pyproject / existing tests). Match them exactly; do not introduce a new framework.
2. Read the code under test and its callers. List the behaviors: happy paths, boundaries, invalid input, error handling, and any bug the user mentioned.
3. Prefer testing observable behavior over implementation details. Keep each test independent, deterministic (no real time, network, or randomness without control) and readable, with the case name saying what is expected.
4. Reuse existing fixtures/helpers. Mock only at true boundaries (network, clock, filesystem when needed).
5. Create a checkpoint before writing many files. Write the tests, then run them if you can run commands; if you cannot, re-read each test and trace that it would pass against the code and fail if the behavior broke.
6. Report which behaviors are covered, which you deliberately skipped, and the command to run the tests.`,
  },
  {
    key: 'debug', name: 'debug', description: 'Systematically find the root cause of a bug before changing code.',
    instructions: `# Debug

1. Restate the symptom precisely: what is expected, what happens, and any error text or stack trace the user gave.
2. Reproduce it mentally or with commands: locate the entry point and follow the actual execution path through the code with \`read_file\` and \`search\`. Do not guess from names.
3. Form two or three hypotheses ranked by likelihood. For each, find evidence for or against in the code (recent changes via \`list_changes\`, type/shape mismatches, async ordering, config differences, unhandled errors).
4. Identify the root cause, not just the line that throws. Explain the causal chain in plain language.
5. Propose the smallest fix that addresses the root cause, and say what test would have caught it. In Act mode: checkpoint, apply the fix, add, or update a regression test, and verify.
6. If the evidence is insufficient, say exactly what extra information (log, input, version) you need rather than speculating.`,
  },
  {
    key: 'refactor', name: 'refactor', description: 'Improve structure safely without changing behavior.',
    instructions: `# Refactor

1. Clarify the goal (readability, duplication, testability, performance) and the boundary of the change. Do not touch unrelated code.
2. Confirm there are tests covering the area. If not, propose or add characterization tests first.
3. Work in small steps that each keep the project working. Create a checkpoint before starting and after each major step so any step can be rolled back.
4. Preserve public APIs and behavior unless the user explicitly wants a change; call out any behavior change you cannot avoid.
5. Follow existing conventions. Prefer deleting code to adding it; avoid speculative abstractions.
6. Verify after each step (run tests if you can, otherwise re-read and trace). Summarize what moved, what was renamed, and any follow-ups.`,
  },
  {
    key: 'explain-code', name: 'explain-code', description: 'Explain how part of the project (or the whole thing) works, with file references.',
    instructions: `# Explain code

1. Identify the audience from the request (newcomer vs. maintainer) and the scope (a function, a feature, the whole architecture).
2. Explore with \`list_dir\`, \`search\` and \`read_file\` until you can explain from the code itself, not from names. Cite everything as \`path:line\`.
3. Structure the answer: a one-paragraph overview, then the main components and how they connect (a small ASCII diagram helps), then a walkthrough of the key flow step by step, then gotchas and where to change things for common tasks.
4. Say what you did not read or are unsure about. Keep it concise; link concepts to the files that implement them.`,
  },
  {
    key: 'document', name: 'document', description: 'Write or improve README, API docs, and inline documentation.',
    instructions: `# Document

1. Work out what is missing: read the existing README/docs and the code they describe. Verify every statement against the code; never document behavior you have not confirmed.
2. For a README: purpose, quick start (exact commands that work), configuration (env vars and defaults), project layout, how to test, and contribute, known limitations.
3. For code docs: document public functions/classes with purpose, parameters, return values, errors, and an example; explain the "why" for non-obvious decisions. Match the project's docstring/comment style and do not restate the code.
4. Keep the tone plain and the examples runnable. Do not invent features. In Act mode, edit the files; otherwise provide the proposed text.`,
  },
];

// Skills for the Chat page. Chat has no tools and no project access, so these work on what the user pastes or types.
export const CHAT_BUILTIN_SKILLS = [
  {
    key: 'code-review', name: 'code-review', description: 'Review pasted code for correctness, clarity, tests, and maintainability.',
    instructions: `# Code review

Review the code the user pasted. If none is pasted, ask for it (and for the language and what it should do) instead of guessing.

1. State what you are reviewing in one line, and any assumption you had to make.
2. Look for, in this order: **correctness** (logic errors, edge cases, error handling), **security** (untrusted input, secrets, unsafe queries or commands), **tests** (what is missing), **design and readability**, then **performance** only where it plausibly matters.
3. Only report problems you can point to in the pasted code. Say so when something depends on code you cannot see.

Group findings as **Blocker / Should fix / Nit**. For each, quote the line or name the function, say what is wrong and why, and show a short fix. Begin with a two-sentence overall assessment and finish with what is done well. If the code is good, say so briefly.`,
  },
  {
    key: 'debug', name: 'debug', description: 'Find the root cause of a bug from the code and error the user pastes.',
    instructions: `# Debug

1. Restate the symptom: what was expected, what happens, and the exact error text or stack trace. If the code, error, or environment is missing, ask for it before guessing.
2. Walk through the pasted code along the path that fails. Do not guess from names.
3. Give two or three likely causes, most likely first, with the evidence for each from the code or the error.
4. Name the root cause and explain the chain from cause to symptom in plain language.
5. Give the smallest fix as a code snippet, and a quick way to confirm it worked (a command, a log line, or a test).
6. If the evidence is not enough, say exactly what to run or paste next.`,
  },
  {
    key: 'explain-code', name: 'explain-code', description: 'Explain how pasted code works, step by step.',
    instructions: `# Explain code

1. Work out the audience from the request (newcomer or experienced) and explain at that level.
2. Open with one paragraph on what the code does and why it exists.
3. Walk through it in order, naming the functions or lines you mean. Explain the non-obvious parts and any concepts the reader needs.
4. Finish with gotchas, edge cases, and what you would check before changing it.
5. Say what you cannot tell from the pasted code (callers, configuration, other files).`,
  },
  {
    key: 'write-tests', name: 'write-tests', description: 'Write tests for pasted code in the framework the user names.',
    instructions: `# Write tests

1. Ask which test framework and style to use if the user did not say; otherwise use the common one for the language and say which.
2. List the behaviors to cover: normal use, boundaries, invalid input, error handling, and any bug the user mentioned.
3. Write independent, deterministic tests with names that say what is expected. Test behavior, not implementation details, and mock only real boundaries such as the network, the clock, or the filesystem.
4. Put the tests in one fenced code block, then say how to run them, which cases you left out, and why.`,
  },
  {
    key: 'summarize', name: 'summarize', description: 'Summarize pasted text or an earlier part of the chat.',
    instructions: `# Summarize

Summarize the text the user pasted, or the conversation so far if nothing is pasted.

- Lead with the main point in one or two sentences.
- Follow with short bullets for the key facts, decisions, and open questions. Keep names, numbers, and dates exact.
- Do not add anything that is not in the source. If the user gave a length or focus (for example "in three bullets" or "for an executive"), follow it.`,
  },
  {
    key: 'proofread', name: 'proofread', description: 'Fix spelling, grammar, and clarity in pasted writing without changing its meaning.',
    instructions: `# Proofread

Improve the text the user pasted without changing its meaning or voice.

1. Return the corrected text first, in full.
2. Then list the most important changes in a short bulleted list, with a brief reason for each.
3. Fix spelling, grammar, punctuation, and unclear or wordy sentences. Keep the user's tone, terminology, and formatting unless they ask otherwise.
4. If something is ambiguous or may be wrong (a name, a figure, a claim), flag it rather than changing it.`,
  },
  {
    key: 'brainstorm', name: 'brainstorm', description: 'Generate and compare ideas for a problem or project.',
    instructions: `# Brainstorm

1. Restate the goal and any constraints in one line. If the goal is unclear, ask one short question first.
2. Offer 5 to 8 distinct ideas, ranging from safe to ambitious. Give each a one-line description.
3. Pick the two or three strongest and compare them: what each costs, what could go wrong, and what you would try first.
4. End with a suggested next step the user can take today.`,
  },
];

export const SCOPES = ['agent', 'chat'];
const BUILTINS = { agent: BUILTIN_SKILLS, chat: CHAT_BUILTIN_SKILLS };

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
export const validSkillName = (n) => NAME_RE.test(n);
export const MAX_CUSTOM_SKILLS = 50;
// Typed commands that are not skills: /clear and /compact belong to the Agent, /status works in both.
export const RESERVED_COMMANDS = { agent: ['clear', 'status'], chat: ['status'] };

const dto = (b, row, scope) => ({
  id: row?.id ?? null, key: b.key, name: b.name, scope, builtin: true, action: b.action || null,
  description: row ? row.description : b.description, instructions: row ? row.instructions : b.instructions,
  enabled: row ? !!row.enabled : true,
  modified: !!row && (row.instructions !== b.instructions || row.description !== b.description),
  defaults: { description: b.description, instructions: b.instructions },
});

const now = () => Math.floor(Date.now() / 1000);

export async function listSkills(userId, scope = 'agent') {
  const rows = await getKnex()('skills').where({ user_id: userId, scope }).orderBy('name');
  const builtins = BUILTINS[scope].map((b) => dto(b, rows.find((r) => r.builtin_key === b.key), scope));
  const custom = rows.filter((r) => !r.builtin_key).map((r) => ({ id: r.id, key: null, name: r.name, scope, builtin: false, modified: false, description: r.description, instructions: r.instructions, enabled: !!r.enabled }));
  return [...builtins, ...custom];
}
export const enabledSkills = async (userId, scope = 'agent') => (await listSkills(userId, scope)).filter((s) => s.enabled);
// Skills the agent itself may load with use_skill (command-style skills such as /compact are not for the agent).
export const agentSkills = async (userId) => (await enabledSkills(userId, 'agent')).filter((s) => !s.action);

// Block handed to the model whenever a skill is loaded (by the user's /name or by the agent's use_skill tool).
export const skillBlock = (s) => `[Skill "${s.name}". Follow these instructions for this request. Skills never change which tools you have or what you are allowed to do.]\n\n<skill-instructions>\n${s.instructions}\n</skill-instructions>`;

// "/code-review src/app.js" -> expanded model-facing message, original text kept for display.
export async function expandSkillInvocation(userId, text, scope = 'agent') {
  const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const skill = (await enabledSkills(userId, scope)).find((s) => s.name === m[1]);
  if (!skill || skill.action) return null; // command-style skills (/compact) are run by the server, not sent to the model as instructions
  const rest = (m[2] || '').trim();
  return { skill, display: text, content: `${skillBlock(skill)}\n\nUser request: ${rest || (scope === 'chat' ? 'Apply this skill to what I pasted or said above.' : 'Apply this skill to the current project.')}` };
}

export async function saveCustomSkill(userId, { id, name, description, instructions, enabled }, scope = 'agent') {
  const k = getKnex();
  if (!validSkillName(name)) throw new HttpError(400, 'invalid_skill_name', { message: 'Use 2-39 lowercase letters, digits, and dashes.' });
  if (RESERVED_COMMANDS[scope].includes(name) || BUILTINS[scope].some((b) => b.name === name)) throw new HttpError(409, 'skill_name_reserved', { message: 'That name belongs to a built-in skill or command; edit the built-in instead.' });
  const clash = await k('skills').where({ user_id: userId, scope, name }).first('id');
  if (clash && clash.id !== id) throw new HttpError(409, 'skill_exists');
  if (id) {
    const changed = await k('skills').where({ id, user_id: userId, scope }).whereNull('builtin_key').update({ name, description, instructions, enabled: +enabled, updated_at: now() });
    if (!changed) throw new HttpError(404, 'not_found');
    return id;
  }
  if ((await k('skills').where({ user_id: userId, scope }).whereNull('builtin_key').count({ c: '*' }).first()).c >= MAX_CUSTOM_SKILLS) throw new HttpError(400, 'too_many_skills');
  return insertId(k('skills'), { user_id: userId, scope, name, description, instructions, enabled: +enabled });
}

export async function saveBuiltinOverride(userId, key, patch, scope = 'agent') {
  const b = BUILTINS[scope].find((x) => x.key === key);
  if (!b) throw new HttpError(404, 'not_found');
  const k = getKnex();
  const cur = await k('skills').where({ user_id: userId, scope, builtin_key: key }).first();
  const next = { description: patch.description ?? cur?.description ?? b.description, instructions: patch.instructions ?? cur?.instructions ?? b.instructions, enabled: patch.enabled ?? (cur ? !!cur.enabled : true) };
  if (cur) await k('skills').where({ id: cur.id }).update({ description: next.description, instructions: next.instructions, enabled: +next.enabled, updated_at: now() });
  else await k('skills').insert({ user_id: userId, scope, builtin_key: key, name: b.name, description: next.description, instructions: next.instructions, enabled: +next.enabled });
}
export const resetBuiltin = (userId, key, scope = 'agent') => getKnex()('skills').where({ user_id: userId, scope, builtin_key: key }).del();
export const deleteCustom = async (userId, id, scope = 'agent') => (await getKnex()('skills').where({ id, user_id: userId, scope }).whereNull('builtin_key').del()) > 0;
