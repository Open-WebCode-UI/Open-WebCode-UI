// Short hints shown while the agent works (like Cline's rotating tips). Built from what the user can actually do,
// so nobody is told about a command their role or settings do not allow.
export function buildTips({ skills = [], can = () => false, mode = 'plan', fun = false } = {}) {
  const on = new Set(skills.filter((s) => s.enabled).map((s) => s.name)), tips = [];
  const skillTips = {
    'code-review': 'Type /code-review to have the agent review your latest changes.',
    'security-review': 'Type /security-review to check your code for vulnerabilities.',
    'write-tests': 'Try /write-tests src/utils.js to add tests for a file.',
    debug: 'Hit an error? Type /debug followed by the error message to find the root cause.',
    refactor: 'Type /refactor and name a file or goal to clean code up safely, with checkpoints.',
    'explain-code': 'Type /explain-code to get a guided tour of how part of the project works.',
    document: 'Type /document to write or refresh the README and code comments.',
    start: 'It might take a minute for your first prompt to start in a session as the model loads. Patience, young Padawan.',
    end: 'It might take a few seconds after the model stops talking for the block to be released.'
  };
  if (on.has('compact')) tips.push('Long session? Type /compact to summarize it and free up context. Add a focus, like /compact keep the API decisions.');
  tips.push('Type /clear to wipe the agent\'s memory of this session but keep working in it.');
  for (const [name, tip] of Object.entries(skillTips)) if (on.has(name)) tips.push(tip);
  const custom = skills.filter((s) => s.enabled && !s.builtin).slice(0, 2); for (const c of custom) tips.push(`Your /${c.name} skill is ready: ${String(c.description || 'type it to run it').replace(/\.$/, '')}.`);
  tips.push('Press the skills button next to the message box to browse every /command.');
  if (can('agent.act')) {
    tips.push(mode === 'plan' ? 'Happy with the plan? Switch to Act: if a plan is waiting, it starts right away.' : 'In Act mode, the agent saves a checkpoint at the start of every turn.');
    tips.push('Plan mode is read-only, so it is a safe place to explore an idea.');
  }
  if (can('checkpoint.write')) tips.push('Open the Checkpoints tab to compare changes or roll back to an earlier state.');
  if (can('terminal.use')) tips.push('Use the Terminal panel to run your own commands; the Agent tab shows what the agent runs.');
  tips.push('Drag a panel by its header to rearrange your workspace.', 'Use the Sessions panel to pick up an earlier conversation.', 'Press Stop to interrupt the agent at any time.');
  if (fun) return weave(tips, FUN_FACTS);
  return tips;
}

// Fun mode: every useful tip is kept; a fun fact follows every second one so the helpful tips still lead.
export const FUN_FACTS = [
  'Fun fact: the first computer bug was a real moth, found in a Harvard Mark II relay in 1947.',
  'Fun fact: the "@" sign in email addresses was chosen by Ray Tomlinson in 1971.',
  'Fun fact: Python (the programming language) is named after Monty Python, not the snake.',
  'Fun fact: the first 1 GB hard drive, from 1980, weighed over 200 kg.',
  'Fun fact: JavaScript was written in about ten days in 1995.',
  'Fun fact: Honey never spoils; edible honey has been found in ancient Egyptian tombs.',
  'Fun fact: Octopuses have three hearts and blue blood.',
  'Fun fact: The first website is still online at info.cern.ch.',
  'Fun fact: A group of crows is called a murder, and they can remember human faces.',
  'Fun fact: Bananas are berries, but strawberries are not.'
];
function weave(tips, facts) {
  const out = []; let f = 0;
  tips.forEach((t, i) => { out.push(t); if (i % 2 === 1 && f < facts.length) out.push(facts[f++]); });
  return out;
}
