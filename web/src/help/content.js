// Help topics. Each lists the permissions that make it relevant, so people only see help for what their role can do.
//   requires: null            -> everyone
//   requires: 'perm'          -> users with that permission
//   requires: { any: [...] }  -> users with at least one of them
//   requires: { all: [...] }  -> users with every one of them
// Style: short, friendly, active voice.
import { INTEGRATION_TOPICS } from './integrations.js';

export const GROUPS = ['Get started', 'Key concepts', 'Projects and files', 'Work with the agent', 'Courses', 'Your account', 'Administer', 'Integration guides', 'Reference'];

const ANY_ADMIN = { any: ['course.admin', 'settings.read', 'provider.read', 'user.read', 'role.read', 'idp.read', 'branding.read', 'security.read', 'audit.read'] };

export const TOPICS = [
  // ───────────────────────────── Get started
  { id: 'welcome', group: 'Get started', title: 'Welcome', requires: null, body: `
This app puts an AI agent next to your code. You plan with it, let it make changes, and review everything it does.

## Find your way around
- **Agent** is your workspace: files, editor, chat, sessions, and terminal in one window.
- **Chat** is a plain assistant with no access to your projects.
- **Courses** (if your role includes it) holds the courses you take or teach.
- **Profile** holds your account details, appearance, prompts, skills, and security options.
- **Help** is this page. Use the search box to jump to a topic.

**New to AI?** Read **Key concepts**: [models and tokens](#ai-basics), [agentic coding](#agentic-coding) and [using AI safely](#ai-safety). The [Glossary](#glossary) defines each term.

Not sure what your role allows? Read [What you can do](#your-access).` },

  { id: 'signing-in', group: 'Get started', title: 'Sign in and stay secure', requires: null, body: `
## Username and password

Sign in with the account your administrator created for you. Local accounts always ask for a second factor, so scan the QR code with an authenticator app the first time.

## Single sign-on

If your organization has set it up, a button under the form (by default **Log in with SSO**; your administrator can rename it) signs you in with your organization account. Your groups decide your role.

## Stay safe
- Your session ends after a period of inactivity. The next thing you do, or coming back to the tab, takes you to the sign-in page with a note that your session expired. Sign in again to carry on where you were.
- Sensitive actions, like changing settings or opening a terminal, ask you to confirm it's you.
- Sign out of every other device from **Profile**.` },

  { id: 'your-access', group: 'Get started', title: 'What you can do', requires: null, dynamic: 'access', body: '' },

  { id: 'workspace', group: 'Get started', title: 'Your workspace and layout', requires: 'agent.plan', body: `
The workspace has five panels: **Explorer**, **Sessions**, **Editor**, **Terminal**, and **Agent**.

## Rearrange them
- Drag a panel by its header. Drop it on another panel's edge to split that panel, on its middle to swap places, or on a window edge to dock it along the whole side.
- Prefer the keyboard? Open a panel's **⋮** menu and choose **Move to … edge** or **Hide panel**.
- Press **Layout** in the header for ready-made arrangements, to show or hide panels, and to reset everything.

### Resize

Drag a divider, or focus it and press the <kbd>←</kbd> or <kbd>→</kbd> arrow keys (hold <kbd>Shift</kbd> for bigger steps). Double-click a divider to even out the two panels.

Your layout stays in this browser. Moving a panel never interrupts the agent.` },

  // ───────────────────────────── Key concepts
  { id: 'ai-basics', group: 'Key concepts', title: 'AI models, tokens, and context', requires: null, body: `
An AI **model**, also called a large language model (LLM), learns from large amounts of text and code. It writes one small piece at a time and picks what fits best. That lets it answer questions, draft code, and explain errors.

## Know the limits
- **Models make mistakes.** A model can sound sure and still invent a function or package. Check its work.
- **Answers vary.** The same question can produce different answers.
- **Tokens** are the chunks of text a model reads and writes. One page is about 500 tokens. Providers charge per token.
- **The context window** is how much the model holds in mind at once: your messages, the files it read, and its replies. When the window fills, the agent slows and forgets early details. See [Sessions](#sessions).
- **Providers** host the models. Larger models reason better but cost more and run slower. Your administrator chooses which ones you can use.

### Write a good prompt

A *prompt* is the text you send. State the goal, name the files, and list any rules, such as "keep the existing style".` },

  { id: 'agentic-coding', group: 'Key concepts', title: 'What is agentic coding?', requires: null, body: `
**To get started, ask the agent for a small task in [Plan mode](#plan-act).** Explain a function, find a bug, or add a test.

A chatbot replies with text. An **agent** also acts: it reads files, edits code, runs tests, and uses the results to choose its next step. This approach is **agentic coding**.

## The agent loop
1. **Look.** Read your request and the relevant files.
2. **Decide.** Choose the next small step.
3. **Act.** Use a **tool**: read a file, edit a file, search, run a command, or call an [MCP server](#mcp-explained).
4. **Check.** Read the result. Repeat until the job ends or the agent needs you.

### Tools limit the agent

It can only use the tools the app provides, and your role narrows them further. A read-only role never changes files.

### Your role

Set the goal, read the plan, approve risky steps, and review the result. Treat the agent like a fast junior colleague: capable, but needs review.

### Good first tasks

Explain unfamiliar code, find a bug, add a test, or tidy one function. Start in [Plan mode](#plan-act), where nothing changes.

### Safety nets

[Plan mode](#plan-act), [checkpoints](#checkpoints), command approval, and protected files limit the damage from a wrong turn.` },

  { id: 'context-compact-clear', group: 'Key concepts', title: 'Context, compact, and clear', requires: 'agent.plan', body: `
> [!INFO]
> To free up space in a long session, type \`/compact\`. The agent keeps the gist and drops the clutter.

**Context** is everything the agent holds in mind during a session: your messages, the files it read, the commands it ran, and its replies. The model reads all of it again with every step. Context has a size limit, called the [context window](#ai-basics), and you measure it in tokens.

## Why it matters

A full context makes the agent slower and more expensive. Near the limit, it forgets early details and repeats itself. The Sessions panel shows how full the session is, and a banner appears when it grows long.

## Compact: keep the gist
- Type \`/compact\`. The agent writes a summary of the session: your goal, decisions, changed files, and open tasks.
- The summary replaces the old messages in the agent's context, and the session carries on from it.
- Add a focus to protect what matters: \`/compact keep the database decisions\`.
- Use it in the middle of a task, when the agent still needs the background.

## Clear: start over
- Type \`/clear\`. The agent forgets the whole session, with no summary. The old messages stay on screen so you can still read them.
- You stay in the same session and project, and your files do not change.
- Use it when you switch to an unrelated task and the old conversation would only distract.

## Which one?

| Situation | Use |
|---|---|
| Same task, but the session feels long | /compact |
| The agent must remember a few key decisions | /compact with a focus |
| New, unrelated task | /clear or a new session |
| You want to keep the old session as it stands | New session |

## Good to know
- Compact costs a little, because the agent reads the session once to summarize it.
- Neither command touches your files, [checkpoints](#checkpoints) or [memory](#memory).
- A summary can miss a detail. If something matters, repeat it after you compact.
- A new session leaves the old one untouched, so you can reopen it later.

See [Sessions and long conversations](#sessions) for the Sessions panel.` },

  { id: 'mcp-explained', group: 'Key concepts', title: 'MCP in plain terms', requires: { any: ['mcp.use', 'mcp.read', 'mcp.write'] }, body: `
**MCP** (Model Context Protocol) is an open standard that connects AI apps to tools and data. Any MCP server works with any MCP app, with no custom code.

## MCP server

A service that offers tools, such as "search the wiki" or "create a ticket". The agent reads the tool list, decides when a tool helps, and calls it. The server returns the result.

## Connection

This app connects to remote servers over HTTPS. It encrypts any sign-in headers, such as an API token.

## Trust

The agent reads everything a server returns. Hidden text in a ticket or web page can try to steer the agent. This attack is *prompt injection*. To protect yourself:
- Connect only to servers your organization trusts.
- Prefer read-only tools.
- Read each approval prompt before you select **Allow**.

> [!DANGER]
> Only connect to trusted MCP servers.

## Administrators

Give each token the narrowest access it needs. See [MCP servers](#mcp) and [MCP servers, attachments, and memory](#admin-extensions).` },

  { id: 'ai-safety', group: 'Key concepts', title: 'Use AI safely', requires: null, body: `
You remain responsible for the work, whoever writes it. Follow these habits:

- **Review every change.** Read the diff and run the tests. Compare with a [checkpoint](#checkpoints) when something looks wrong.
- **Keep secrets out.** Don't paste passwords, API keys, or sensitive data. Your administrator can tell you what data can go into what models or providers.
- **Verify new names.** Check that any library, command, or setting you don't recognize exists. Models sometimes invent them.
- **Watch for hidden instructions.** Files, web pages, and tool results can contain text that tries to steer the agent. If it does something unrelated to your request, select **Stop**.
- **Approve only commands you understand.** Nothing runs until you select **Allow**. If you don't understand a command, select **Deny** and ask the agent to explain it.
- **Work in small steps.** Request one change at a time and commit when it works.
- **Start in Plan mode** for unfamiliar tasks or important code.

If something goes wrong, roll back to a checkpoint.` },

  // ───────────────────────────── Projects and files
  { id: 'projects', group: 'Projects and files', title: 'Projects', requires: 'project.read', body: `
A project is a folder of code that lives on the server, not on your computer. The agent works on that copy. Select a project from the list at the top of the Explorer.

**Start one** (needs permission to create projects)
- Choose **+**, name it, and create an empty project.
- Upload a \`.zip\` to open existing code.
- Paste an \`https\` Git URL to clone a repository. Add a token for private repositories; the app never stores it.

Each project keeps its own sessions, checkpoints, and terminal, and the agent only sees the project you have open. Deleting a project removes all of that, so double-check first.` },

  { id: 'editor', group: 'Projects and files', title: 'The editor', requires: 'files.read', body: `
The editor is Monaco, the engine behind VS Code.

## Menu bar
- **File:** new, save, save all, download the file or the project, close tabs.
- **Edit:** undo, redo, cut, copy, paste, find, replace, comment, format.
- **View:** command palette, word wrap, minimap, whitespace, zoom, themes, fold.
- **Go:** jump to a line or symbol, switch tabs.

### Status bar

Click an item to change it: line and column (go to line), indentation, line endings, and the language. Pick another language when the file name fools the editor.

A dot on a tab means unsaved changes. Press <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>S</kbd> to save. If your role can't edit files, the editor opens read-only.` },

  { id: 'files', group: 'Projects and files', title: 'Manage files', requires: 'files.read', body: `
Right-click a file or folder, or use the **⋮** on its row.

- **Open and download.** Download a file, or a folder as a zip.
- **Create.** Make a new file or folder where you clicked. (Needs permission to edit files.)
- **Rename.** Press <kbd>F2</kbd> or choose **Rename**.
- **Move.** Drag an item onto a folder, or onto the empty area to move it to the top level.
- **Upload.** Drop files or whole folders from your desktop onto the tree, or use the upload button.
- **Delete.** Press <kbd>Delete</kbd>. Folders go with everything inside them.

The app asks before it replaces a file, and it never moves a folder into itself. Open tabs follow their files when you rename or move them.` },

  { id: 'git-download', group: 'Projects and files', title: 'Git and downloads', requires: { any: ['git.commit', 'download.code'] }, body: `
## Git basics

Git records your code history as *commits*: labeled snapshots you can compare or restore. A *remote* is a copy of the repository on a server such as GitHub. A *branch* is a separate line of work.

## Download

Choose the download icon above the file tree to get the whole project as a zip. \`node_modules\` stays out.

## Commit

Open **Git**, write a message, and commit all changes. The app starts a repository for you if the project doesn't have one.

## Push

Enter the remote's \`https\` URL, the branch, and an access token. The token goes straight to Git and the app never saves it.

The agent's checkpoints live in a separate hidden repository, so they never touch your own Git history.

## Access tokens

A token works like a password limited to certain repositories. Create one in your Git host with only the access you need, and delete it when you finish.` },

  // ───────────────────────────── Work with the agent
  { id: 'agent-basics', group: 'Work with the agent', title: 'Talk to the agent', requires: 'agent.plan', body: `
Describe what you want in the message box and press <kbd>Enter</kbd>. Press <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line.

## Watch it work
- Each step the agent takes appears as its own card: reading a file, editing, searching, running a command. Click a card for the details.
- When a model shows its reasoning, a **Thinking** panel streams it. It collapses when the answer starts.
- Replies render as Markdown, with a copy button on every code block.
- The agent ends each turn with a **Conclusion** card: what it did, which files changed, how it checked, and what to do next.

### Stay in control

Press **Stop** at any time. Pick a different model from the list at the top of the panel.

While the agent thinks, small tips suggest commands you may not know.` },

  { id: 'plan-act', group: 'Work with the agent', title: 'Plan mode and Act mode', requires: 'agent.plan', body: `
**Plan mode** is read-only. The agent explores your project and proposes a plan. It can't change anything, even if you ask.

**Act mode** lets the agent edit files (and run commands when your administrator allows it). It saves a checkpoint at the start of every turn.

## From plan to action
1. Ask for what you want in Plan mode. The agent explores and proposes a plan.
2. Read the plan. Reply to adjust it, or switch to Act.
3. Switch to **Act** (or press **Approve & switch to Act**). With a plan waiting, the work starts at once, and you don't need to type anything.

### Switching runs your message

Type something, then change modes: the app sends your text in the new mode right away.

The agent can suggest Act mode when a change is small, and you confirm first. If Act mode turns risky, the agent can drop back to Plan mode and tell you why.

> [!INFO]
> In a course exercise, your instructor can switch Act off, or ask for a plan you approve first. See [Agentic-coding exercises](#courses-exercises).` },

  { id: 'sessions', group: 'Work with the agent', title: 'Sessions and long conversations', requires: 'agent.plan', body: `
A **session** is one conversation with the agent. The **Sessions** panel lists every session in the project.

- **New session** starts fresh. Sessions save when you send your first message.
- **Click a session** to reopen it and carry on, including its steps and any plan waiting for approval.
- **⋮ menu** renames or deletes a session.

Leave the page and come back: your session is still there, and a running turn keeps going.

## Keep the context small

The agent remembers everything in a session within its [context window](#ai-basics), and long sessions slow it down and cost more. The panel shows how full a session is. When it fills up:
- **/compact** summarizes the session, then clears the old messages. Add a focus: \`/compact keep the database decisions\`.
- **/clear** wipes the agent's memory of the session and starts over in the same place.
- **/status** shows your connection, the server you reached, who you are, and the project.
- **New session** leaves the old one untouched.

A banner suggests these steps when a session grows long.` },

  { id: 'skills', group: 'Work with the agent', title: 'Skills and slash commands', requires: { any: ['agent.plan', 'chat.use', 'chat.general.use'] }, body: `
A **skill** is a saved set of instructions you run with a slash command. Type \`/\` or press the **skills** button next to the message box.

## The Agent and Chat have separate skills

The skills button on each page lists only that page's skills. You manage them in **Profile → Agent skills** and **Profile → Chat skills**. Changing one set never changes the other, so you can have a \`/code-review\` for each.

## Agent skills

These work on your project, so they can read files and see your changes:
- \`/code-review\` reviews your latest changes.
- \`/security-review\` hunts for vulnerabilities.
- \`/write-tests\` adds tests that match your project.
- \`/debug\` finds the root cause of a bug.
- \`/refactor\` cleans up code safely.
- \`/explain-code\` tours part of the project.
- \`/document\` writes docs.
- \`/compact\` summarizes a long session. \`/clear\` wipes it.

Add details after the command: \`/code-review src/auth.js\`. The agent can also load a skill itself when your request matches it.

## Chat skills

Chat can't see your projects, so these work on what you paste or type. They are the same in the General and Coding tabs:
- \`/code-review\`, \`/debug\`, \`/explain-code\`, and \`/write-tests\` work on code you paste.
- \`/summarize\` condenses pasted text or the chat so far.
- \`/proofread\` fixes spelling and grammar without changing your meaning.
- \`/brainstorm\` suggests and compares ideas.

Add what to work on after the command: \`/summarize\` followed by the text. \`/status\` works on both pages.

Skills never give the model new powers. Plan mode stays read-only, and Chat still has no tools.` },

  { id: 'my-skills', group: 'Work with the agent', title: 'Write your own skills', requires: 'profile.skills.edit', body: `
Open **Profile → Agent skills** for the Agent, or **Profile → Chat skills** for Chat. Each page has its own list, and the steps are the same.

- **New skill.** Pick a short name (lowercase letters, digits, dashes), describe when to use it, and write the instructions in Markdown.
- **Edit a built-in.** Change any built-in skill to fit your team. Choose **Reset** to bring back the original.
- **Turn one off** with its switch.

## Write good instructions

Say what to look at, what steps to follow, and what the answer should look like. A short checklist beats a long essay.

Example: \`/api-review\` could tell the agent to check route names, status codes, and error formats, and to report issues by severity.` },

  { id: 'attachments', group: 'Work with the agent', title: 'Attach files and images', requires: 'provider.use', body: `
Some models can read **images, PDFs, and data files**. When yours can, a **paperclip** button appears next to the message box, in the Agent panel and in Chat.

- Pick up to five files. Each one uploads right away, and you can remove it before you send.
- Images (PNG, JPEG, GIF, WebP) and PDFs reach the model as they are. Text and data files (CSV, JSON, logs, code) go in as text.
- Other file types do not work, and your administrator sets a size limit.

No paperclip? Your current model does not take files or images. Pick another model, or ask an administrator to switch on **Files** or **Images** for it. Some models take files but not images, so the paperclip only accepts what the model can read.

Treat an attached file like anything you paste: leave out secrets.` },

  { id: 'memory', group: 'Work with the agent', title: 'Memory', requires: 'memory.use', body: `
**Memory** lets the agent remember lasting things between sessions, such as "uses pnpm" or "likes short answers". It starts **off**.

- **For you.** Turn it on under **Profile → Memory** to keep general preferences across all projects.
- **For a project.** Choose a project there, or press the **Memory** button in the Agent panel, to keep notes about that project only.

The agent reads your notes at the start of each session, so you don't repeat yourself. It forgets the conversation itself when you start a new session.

When the agent saves a note, a "Remembered" tag appears in the conversation. You can read, edit, add, delete, or clear every note at any time. Notes never include secrets, and they never override your request or the platform's safety rules.

An administrator can turn memory off for everyone.` },

  { id: 'choose-model', group: 'Work with the agent', title: 'Choose a model and its settings', requires: 'provider.use', body: `
Press the model button at the top of the Agent panel or Chat to open the **Model & settings** window.

- **Pick a model.** The window groups models by provider. If your administrator wrote a note about a provider, it appears above its models. A note about one model appears on its card. Each card shows the model's name and ID, what it can do (**Thinking**, **Files & images**), its context size, and whether it's the default for Plan, Act or Chat. When your administrator turns it on, the card also shows the price per million tokens.
- **Effort.** **Quick** makes the smallest change that works. **Balanced** is the normal level. **Thorough** reads more code and checks its work.
- **Thinking.** Lets a model that supports it reason before it answers.
- **Web search.** Appears if you have access to it. See *Web search*.

Press **Done** to close the window. The app remembers your choices.` },

  { id: 'web-search', group: 'Work with the agent', title: 'Web search', requires: 'websearch.use', body: `
**Web search** lets the model look things up on the web, such as a new library version, an error message, or a recent announcement. It starts **off** in every chat.

## Turn it on for a chat
1. Press the model button (it shows the model's name) in the Agent panel or in Chat. The **Settings** part of the window that opens has a **Web search** switch, next to **Thinking**.
2. Switch it on, then send your message.
3. When the model searches, each query appears as a badge in the thinking step. The answer cites the pages it used.

Each chat or session remembers its own choice. A new chat starts with it off again.

### Switch it off for good

Go to **Profile → Web search** and turn off **Let the model search the web**. The switch in each chat then stays gray.

### If the switch is gray

Hover over it to see why. Either you turned web search off in your profile, an administrator turned it off for everyone, or an administrator has not added a search service yet.

## Keep in mind
- The model sends its search words to your organization's search service. Leave secrets and private details out of your requests.
- Web pages can contain text that tries to give the model orders. The model treats results as information, never as instructions. Still, check important facts at the source.` },

  { id: 'mcp', group: 'Work with the agent', title: 'MCP servers', requires: 'mcp.use', body: `
**MCP servers** give the agent extra tools, such as searching documentation or filing tickets. New to the idea? Read [MCP in plain terms](#mcp-explained).

- Open **Profile → MCP servers**. Your organization's servers show first. Switch any off for yourself with **Use**.
- Add your own with **Add server** (needs permission). Give it a name, a public https address, and any sign-in headers. Press **Test** to see its tools. A list of tools means success. An error usually means a wrong address or token.
- Plan mode only gets tools marked read-only. In Act mode the agent asks you before each call to any other tool.

Your sign-in headers stay encrypted and hidden. Connect only to servers you trust, because their results reach the agent.` },

  { id: 'checkpoints', group: 'Work with the agent', title: 'Checkpoints and rollback', requires: 'checkpoint.read', body: `
A checkpoint is a snapshot of your project that you can return to.

The agent saves one at the start of each Act turn, before it runs a command, and whenever it feels a change is risky. Open the **Checkpoints** tab in the Agent panel to see them all.

- **Diff** shows what changed since a checkpoint.
- **Rollback** (needs permission to write checkpoints) restores the project to that point. The app saves a **Before restore** checkpoint first, so you can undo the rollback.

Checkpoints skip \`node_modules\` and never touch your own \`.git\` folder.` },

  { id: 'subagents', group: 'Work with the agent', title: 'Subagents', requires: 'agent.plan', body: `
For big jobs, the agent can start **subagents**: focused helpers that each take one task and report back.

- Each subagent appears as a card with its own steps. Click it to read the task and the report.
- Several subagents can work at once, which speeds up wide investigations.
- Subagents are **read-only** by default. In Act mode, the agent can start one that edits files; those run one at a time, after a checkpoint.
- A subagent can't talk to you, start more subagents, or run a command without your approval.

If a model can't handle subagents well, your administrator can turn them off for it.` },

  { id: 'terminal', group: 'Work with the agent', title: 'Terminal and command approval', requires: { any: ['terminal.use', 'agent.shell.run'] }, body: `
A *shell* is a text window for typing commands. Shell access stays off until your administrator turns it on.

## Terminal tab

A real shell in your project folder. Click **Start terminal**, confirm it's you, and type away. Your session survives a page reload.

## Agent tab

A live, read-only view of the shell the agent uses. It remembers \`cd\` and exported variables between commands.

## Your terminal and the agent's shell

They are separate. Commands you type in the **Terminal** tab run at once, with no approval, because you typed them. Commands the agent wants to run always wait for your answer.

## Allow or deny

Before the agent runs any command, a prompt shows the exact command with **Allow** and **Deny** buttons. It appears in the chat and in the terminal panel, and answering in one place clears it from the other. Nothing runs until you press **Allow**. If you don't answer, the command stays on hold, and stopping the turn cancels it.

- **Allow** runs the command once. The next command asks again.
- **Deny** skips the command. The agent is told you said no, and it carries on without it or tries another way.
- **Several waiting.** If the agent queues more than one, the prompt shows how many more are waiting. You answer them one at a time, oldest first.
- **Subagents.** A prompt that starts with "Subagent" comes from a helper the agent started. Treat it like any other command.
- **MCP tools.** A tool from a connected server that can change things asks the same way, every time. Tools the server marks read-only don't ask.

## Add a message with your answer

Both buttons send whatever you type in the box labeled *Add a message for the agent (optional)*. The agent reads it together with your answer. Use it to:
- Explain a denial: "Deny: don't delete anything in \`data/\`."
- Redirect the work: "Deny: use \`npm test\` instead."
- Add a condition to an approval: "Allow: but only run it in the \`web\` folder."

Type the message first, then press the button. The box clears after each answer. A message can run up to 1,000 characters. Leave it empty to send a plain Allow or Deny.

## Before you press Allow

Read the whole command, including anything after \`&&\`, \`;\` or \`|\`. Be careful with commands that delete files (\`rm\`), change history (\`git reset\`, \`git push --force\`), install software, or send data over the network. If you aren't sure, deny and ask the agent what the command does and why.

The shell runs as the server's account. Keep secrets out of it, and don't run commands you don't understand.` },

  { id: 'chat', group: 'Work with the agent', title: 'Chat', requires: { any: ['chat.use', 'chat.general.use', 'chat.course.use'] }, body: `
**Chat** is a plain assistant. It can't see your projects, so paste the code you want help with.

The page has a tab for each kind of chat your role allows. **General** is for everyday questions, writing, and planning. **Coding** is for code questions and reviews. Each tab has its own chats and its own system prompt, and your role can allow or deny each one (and its web search and memory) separately. You only see the tabs your role allows.

Use it to explain ideas, review snippets, or draft text. Slash skills like \`/code-review\` work here too. They are the Chat skills, which are separate from the Agent's.

## While you wait

After you send a message, a card shows **Sending…** and then **Processing prompt** with a timer while the model reads your message. Long messages and models that are loading can take a while. For a model it has run before, the card also shows a rough time left. The answer replaces the card as soon as it starts to arrive. Choose **Stop** to cancel.

## Manage your chats

Choose **⋮** on a chat to rename or delete it. Choose **Select** to tick several chats, then **Delete** the ticked ones or **Delete all** in that tab. Sessions in the Agent page's session list work the same way.

Need the assistant to read or change your files? Switch to the **Agent** page.` },

  { id: 'prompts', group: 'Work with the agent', title: 'Your system prompts', requires: 'profile.prompt.edit', body: `
Open **Profile → System prompts** to see the instructions that shape each mode: Plan, Act, and each chat tab you can use.

- Type in the box to override a prompt. Leave it empty to keep the default.
- Choose **Load default to edit** to start from the original text.
- Choose **Reset to default** to undo your changes.

Plan mode always stays read-only, whatever you write: the server enforces it.

## What a system prompt is

A *system prompt* is a set of standing instructions the model reads before your first message, in every conversation. You don't see it in the chat, but it shapes everything the agent does. It tells the model what role it plays, what tools it has, and how to behave. Your own messages then say what to do right now.

Each mode has its own prompt:
- **Plan** tells the agent to investigate and propose, without changing anything.
- **Act** tells the agent how to make changes, run commands, and report back.
- **Chat** sets up a plain assistant that can't see your projects.

The default prompts work well for most people. Override one when you want the same behavior every time, such as a house style, a preferred language or framework, or a team rule, so you don't have to repeat it in each message.

## How to write a good one

- **Start from the default.** Choose **Load default to edit**, then change only what you need. The default carries instructions about tools and safety that you probably want to keep.
- **State the role and the goal.** Open with one or two sentences: who the agent is and what a good result looks like.
- **Be specific.** "Use TypeScript strict mode and named exports" beats "write clean code". Give the reason when it isn't obvious, so the agent can handle cases you didn't list.
- **Say what to do, not only what to avoid.** "Ask before adding a dependency" works better than "don't add dependencies", and it leaves room for the agent to use judgment.
- **Keep it short and organized.** Short paragraphs or a bulleted list work best. Every line competes for the model's attention, so cut anything that isn't needed.
- **Include an example when the format matters.** Show one sample commit message or code comment instead of describing it at length.
- **Don't put secrets in it.** The text goes to the AI provider with every request.
- **Don't fight the safety rules.** Plan mode stays read-only and commands still need your approval, whatever the prompt says.

### Test and refine

Change one thing at a time, then run a typical task and see what changes. If the agent ignores a rule, make that rule clearer instead of adding more rules. If a change makes things worse, choose **Reset to default** and try again.` },

  { id: 'courses-learn', group: 'Courses', title: 'Take a course', requires: 'course.learn', body: `
Select **Courses** in the top bar. Under **My courses** you see every course you're enrolled in, with a progress bar. Select **Start** (or **Continue**) to open one.

> [!INFO]
> You see a course once your instructor publishes it and enrolls you, or enrolls a role or group you belong to. Missing a course? Ask your instructor.

## Move through a course
The pages run down the left. Some courses group their pages into modules: the module's name appears as a heading with a count of finished pages, such as “Basics (1/3)”, and its pages sit beneath it. A ✓ marks each page you finish. Read a page, then select **Mark complete**, or select **Next page** to finish it and move on. Select **← All courses** to go back.

## Pages with a chat or a tutor
Some pages put a panel beside the text.
- A **chat panel** answers questions about the page. Type in **Ask a question** and select **Send**.
- A **tutor panel** adds tabs next to the chat. Your instructor chooses which ones you get. You may see **My notes** (private to you; select **Save notes**), **Hints** (select **Show a hint** to reveal them one at a time), **Resources** (helpful links), and **My progress**.

The chat remembers your conversation on that page. Select **New conversation** to start fresh. The tutor knows the text of the page and follows your instructor's guidance. It can't browse the web or change files, and it can be wrong, so check what it says. See [Use AI safely](#ai-safety).

## Assessments
An assessment is a page in the course. It sits in the page list with the others, in reading order, and gets a ✓ once you finish it. Open it to read any introduction, and to see how many questions it has, the pass score if there is one, and how many attempts you have.
1. Select **Start**. Answer what you can. A blank answer scores zero.
2. Select **Submit answers**. You can't change your answers afterward.
3. Read your score. (Some assessments are practice only: they show which answers were right but no score.) Multiple choice and true/false questions score at once. Written answers wait for your instructor, and they show **Waiting for your instructor** until it's graded.
4. Select **Try again** (or **Start another attempt**) if you have attempts left. If your instructor limits the attempts, your best score counts.

When you finish an assessment that belongs to a page, or reach its pass score if it has one, that page counts as complete.

A question with round buttons has one right answer. A question with tick boxes has several, and you need every right one and none of the wrong ones.

Some assessments are [agentic-coding exercises](#courses-exercises), where you work with the agent in your own workspace.` },

  { id: 'courses-exercises', group: 'Courses', title: 'Agentic-coding exercises', requires: 'course.learn', body: `
An **agentic-coding exercise** is an assessment where you practice working with the agent. Your instructor gives you a task, and you complete it by directing the agent in your own workspace. It tests how you work with the agent, not only what code comes out.

## How it works
1. Open the assessment and select **Start**. The app creates a workspace just for this attempt. It's a normal project, named like \`course-7-a12-q5\`, with any starter files your instructor provided.
2. Read the brief, the **Rules for the agent**, and **How you will score**.
3. Select **Open your workspace in the agent**. Plan, approve, and review as usual. Your work saves as you go.
4. Come back to the assessment and select **Submit answers**.

You can leave and come back. Select **Resume attempt** to carry on.

## How you score
The exercise has two kinds of criteria:
- Criteria **checked automatically** when you submit. The app looks at the files in your workspace and at what you and the agent did, such as whether a file exists, whether it contains some text, or whether the agent proposed a plan. It never runs your code.
- Criteria **marked by your instructor** against a rubric. Your instructor can read your submitted files and your sessions with the agent, so write your prompts the way you want them read.

Your result shows each automatic check with a ✓ or ✗, then the rubric marks and feedback once your instructor grades it. Until then you see a score so far.

## Rules for the agent
Your instructor can limit what the agent does in an exercise. The rules show above the agent while you work, and again before you start. They can include:
- Plan mode only, or a plan you must approve before the agent changes files. See [Plan mode and Act mode](#plan-act).
- No terminal, no Git or downloads, or some agent features switched off.
- Files nobody can change, often the tests.
- A limit on messages, spending, or time.

Rules only take things away from your role. They never give you more. When something is off, **Act** may turn gray, or a request fails with a short reason.

When you submit, or when the time limit ends, the workspace becomes read-only. You can still read everything. After a time limit you can still submit.

> [!WARNING]
> Your instructor can read the files and agent conversations from a submitted exercise. Keep personal details and secrets out of the workspace.

## If you can't use the agent
Your role needs access to the agent for the work. If it doesn't have that, the exercise says "Your role does not include the agent". You can still submit, but you will score little. Ask an administrator for access first.` },

  { id: 'courses-build', group: 'Courses', title: 'Build a course', requires: 'course.author', body: `
You design courses on the **Courses** page, under **Courses I teach**. [Assessments and grading](#courses-assess) and [Design an exercise](#courses-exercise-design) have their own guides.

## Create a course
1. Enter a **New course title** and select **Create course**.
2. The editor opens with three tabs: **Pages**, **Enrollment**, and **Settings**.
3. On **Settings**, add a description. A new course starts as a draft that only you and administrators see. Select **Publish** when it's ready, or **Unpublish** to pull it back. **Delete course** removes the course with its pages, assessments, and results.

## Add pages
On the **Pages** tab, select **Add page**. Give the page a **Page title**, choose a **Layout**, write the content, and select **Save page**. Use the arrows beside a page to reorder it, and **Delete page** to remove it. Select **Add assessment** to add a quiz as another page: see [Assessments and grading](#courses-assess).

## Group pages into modules
A course can have pages at the top level and modules that hold pages. Select **Add module** to make a module, then **Add page to module** inside it. To move an existing page into a module (or back out), open the page and change its **Module**. The arrows move a page within its module, or a whole module among the top-level items. Select **Rename** or **Delete** beside a module's name. Deleting a module keeps its pages and moves them to the top level. A module holds pages only, not other modules. Learners go through the course in outline order, so a module's pages follow each other where the module sits.

The editor works like a word processor: bold, italic, headings, lists, quotes, code blocks, and links.

Choose a **Layout** for each page:
- **Content only** shows just your text.
- **Content with chat panel** adds a chat that answers questions about the page.
- **Content with tutor agent panel** adds the chat plus extra tabs.
- **Content with agent and file** adds a code and text editor under the page, with an assistant beneath it that can read and change that one file. Set the **File name** and the **Starting text or code**; each learner gets their own copy, and **Reset to starting version** gives it back.

On a chat or tutor page, fill in the instructions box (hidden from learners). Tell the tutor how to teach: ask questions first, stay on the topic, hold back answers to graded work. The tutor also reads your page text. It has no tools, can't browse, and can't change files.

The **Thinking** switch controls whether learners watch the model think. When it is off (the default), the answer starts streaming right away. When it is on, the model's thinking streams in first in a block that collapses once the answer starts. It is available only for models your administrator has set up to think, and replies take longer to begin.

> [!INFO]
> Chat and tutor panels use your administrator's default chat model, and their use shows in the usage and cost reports. Learners can't pick a model.

### Tutor panels
On a tutor page, tick the panels under **Tutor panels shown beside the chat**. Your administrator decides which panels exist.
- **Hints**: type one hint per line. Learners reveal them one at a time, so put the gentlest hint first. Learners can read the whole list in their browser's network traffic, so use hints as nudges, not secrets.
- **Resources**: type one link per line as \`Title | https://address\`. Only http and https links work.
- **My notes** and **My progress** need nothing from you.

## Preview and enroll
Select **Preview as learner** to see the pages as learners do. Preview records no progress.

On the **Enrollment** tab, choose **Assign to**, then pick **Role (name)** or **Person**. For a person, type two letters of their name and choose from the list. Select **Add**, and **Remove** to undo it. Learners see the course once you publish it and they match an entry. Assigning a SAML group is an administrator's job; see [Set up courses](#admin-courses).

Learners also need the permission to take courses. The built-in **developer** and **chat-general** roles have it.` },

  { id: 'chat-course-design', group: 'Courses', title: 'Design courses with Chat', requires: { all: ['chat.course.use', 'course.author'] }, body: `
The **Course Design** tab on the **Chat** page is an assistant that helps you write and change the courses you teach. It is separate from the other chat tabs, with its own chats and system prompt. You can change its prompt under **Profile → System prompts**; see [Your system prompts](#prompts). See also [Build a course](#courses-build).

Pick one of the courses you teach in the **Course** menu, then ask for what you need: an outline, a new lesson, practice questions, or a rewrite of a page. The assistant can read the course, add or rename modules, and add, change, or move its pages. A chat stays with the course it started in, so start a new chat to work on another course. Each change shows as a chip under the reply, and you can review it in the course editor on the **Courses** page.

The assistant only changes courses that are **drafts**. Published and archived courses are read-only here, and it can create, change, and delete assessments, and add, change, and remove their multiple-choice, true/false, and free-text questions (until learners have attempted them). It can't publish, delete, enroll learners, or see learners' answers. Page text is Markdown (headings, lists, bold, italic, code, links, quotes, tables). Images aren't supported. The built-in **instructor** role has the permissions this tab needs.` },

  { id: 'courses-assess', group: 'Courses', title: 'Assessments and grading', requires: 'course.author', body: `
An assessment is a page like any other. It sits in the page list with your other pages, so you can put a quiz at the end of a module, or in the middle of one.

## Create an assessment
On the **Pages** tab, select **Add assessment**. Inside a module, use **Add assessment** under that module. Give the page a **Page title** and, if you like, an introduction that learners read first. Then set:
- **Attempts**: see below. When a learner finishes the assessment (or reaches its pass score, if it has one), the page counts as complete.
- **Attempts**: how many tries a learner gets.
  - **Unlimited attempts**: learners can try as often as they like.
  - **Limited attempts (best score)**: learners get up to **Number of attempts** tries, and their best score counts.
  - **Unscored (practice)**: learners see which answers were right, but you and they see no score.
- **Pass score % (optional)**: the lowest score that counts as a pass. You can set it for unlimited and unscored assessments, and only when the app can score every question itself: multiple choice, true/false, or an exercise with no rubric items. Written answers don't work with a pass score or with unscored mode, so the options turn off while the assessment has them. With no pass score, finishing the assessment is enough.

Select **Save settings**. To remove an assessment, select **Delete page**. That also removes its questions and every attempt at it.

## Add questions
Select **Add question**, choose a **Question type**, and fill it in. Every question has points.
- **Multiple choice**: type each option and tick every correct one. One tick means learners pick a single answer. Several ticks mean they must pick all of them. Select **Add option** for more, up to ten.
- **True / false**: choose the correct answer.
- **Written answer (you grade it)**: add grading notes that only you see.
- **Agentic-coding exercise**: see [Design an exercise](#courses-exercise-design).

Select **Add question** (or **Save question**) to finish.

> [!WARNING]
> Once any learner starts an attempt, you can't add, change, or delete questions. That keeps earlier scores meaningful. You can still change the title, attempts, and pass score. To change the questions, make a new assessment.

## Grade
Under **Submitted attempts** you see each learner's attempt. **Needs grading** marks the ones that wait for you. Select **Grade** (or **View** for finished ones) to open an attempt.

For a written answer, read it, enter a score out of its points, add feedback if you like, and select **Save grade**. When every answer has a grade, the attempt becomes final. You can change a grade later and the score updates. Learners see their score and your feedback.

## How scores work
A score is a percentage of the total points. Multiple choice and true/false questions score the moment a learner submits. Until you grade a written answer, it counts as zero, so the learner sees a score so far. Learners can't see which options were right, only how many points each question earned.` },

  { id: 'courses-exercise-design', group: 'Courses', title: 'Design an exercise', requires: 'course.author', body: `
An exercise sends learners into their own workspace to work with the agent. You decide the task, how it's checked, and what the agent may do. Add one on an assessment page: select **Add question**, then choose the **Agentic-coding exercise** type.

## Write the task
- **Question**: a short title.
- **Brief for the learner (what to do with the agent)**: what you want them to achieve. Say which skills matter, such as planning first or writing clear prompts.
- **Add starter file**: files learners begin with. Each has a path like \`src/app.js\` and its text. Use them for a broken program, a half-finished project, or notes. You can add up to 50.

## Add automatic checks
Pick a **Kind of check**, then select **Add check**. Name each check so learners understand it, and give it points. Checks read the learner's workspace and the record of their agent sessions when they submit. **They never run code or commands**, so a check can't harm the server or depend on the learner's setup.

| Kind of check | Passes when |
|---|---|
| File exists | the file is in the workspace |
| File does not exist | the file is not in the workspace |
| File contains text | the file holds the text (tick **Ignore case** to relax it) |
| File does not contain text | the file doesn't hold the text |
| File differs from the starter | the learner changed the starter file, or made the file |
| Agent used a tool | the agent used the tool at least the number of times you set, such as proposing a plan, editing a file, or using a subagent |
| A prompt mentions text | one of the learner's messages includes the text |

Tool checks count the calls the agent made, whether or not they worked. The app can't check a file over 1 MB.

Learners see each check's name and points, but not its path or text. Name checks for what you want ("Notes file created") without giving away how.

> [!INFO]
> Checks suit structure: a file exists, a plan came first, tests got a mention. Use the rubric for quality.

## Add rubric items
Select **Add rubric item** for anything you judge yourself, such as clear prompts. Each item has points. With rubric items, a submitted attempt waits for your marks. Without them, the exercise gets its score the moment the learner submits.

## Set the agent rules
Under **Agent rules**, pick a preset or change the settings. Rules can only take things away from the learner's own role. They never grant more, and they apply to the exercise workspace only. New exercises start on **Guided**.

| Preset | What it does |
|---|---|
| **Plan only** | The agent can read and plan but never change files. It teaches prompting and planning. |
| **Guided** | The agent must propose a plan, and the learner approves it, before it changes files. No shell, Git, subagents, web search, MCP tools, or memory. |
| **Full agent** | The learner's role as it stands, including the shell. Git and downloads stay off. |

Change any setting and the preset shows **Custom**:
- **What the agent may do**: plan only, or plan then change files.
- **Require an approved plan before it changes files**: the agent must propose a plan in the session first. A plan the learner types doesn't count.
- **Allow shell commands and the terminal**: works only if your administrator switched on shell access.
- **Turn off for the agent**: subagents, skills, web search, MCP tools, and memory.
- **Allow Git and downloads** and **Allow checkpoints**.
- **Protected files and folders (one per line)**: nobody can change, move, or delete these, the agent included. A folder protects everything inside. Protect the tests so the agent can't rewrite them to pass. Learners can still read these files. This needs the shell turned off, because a shell could edit any file.
- Limits: **Agent steps per message**, **Messages to the agent**, **Spending limit**, **Time limit (minutes)**, and a pinned **Model**. Leave a limit empty for no limit. When time runs out the workspace turns read-only, and the learner can still submit.

Under the settings, choose a **Role** to preview what a learner with that role could do under your rules. A ✗ says whether the role never had the ability or your rules turned it off.

> [!WARNING]
> You can't edit an exercise's questions or rules after a learner starts an attempt, and each attempt keeps the rules it started with.

## Grade an exercise
On the assessment's page, find **Submitted attempts**, then select **Grade** on a submitted attempt. You see each automatic check with ✓ or ✗. Select **View submitted files** to read the workspace as the learner left it, and **View agent sessions** to read what they asked and what the agent did. Enter a score for each rubric item and select **Save grade**.

The app saves a snapshot of the workspace (up to 500 files and 5 MB, without links or folders like node_modules) and the sessions when the learner submits, so you review the same thing even if they delete the project. Deleting the assessment or course deletes its snapshots.` },

  // ───────────────────────────── Your account
  { id: 'profile', group: 'Your account', title: 'Your profile', requires: null, body: `
**Profile** is where you manage your own account and how the assistant behaves for you. Use the list on the left to switch sections. You only see the sections your role allows.

**Account** shows your roles and the kind of account you have (local, or single sign-on). Your roles come from your organization's groups, so ask an administrator if one is missing.
- **Your details.** Local accounts can change their first and last name. With single sign-on, your name and email come from your identity provider. Nobody can change the email address here.
- **Appearance and accessibility.** See [Appearance and accessibility](#appearance).
- **Tutorial.** **Replay tutorial** starts the short tour of the app again.

## System prompts

Standing instructions for Plan mode, Act mode, the Coding chat, and the General chat, if your role allows editing them. See [Your system prompts](#prompts).

**Agent skills** and **Chat skills.** Saved instructions you run with a slash command. The Agent and Chat each have their own list. See [Skills and slash commands](#skills).

**MCP servers**, **Memory**, and **Web search.** Shown when your role allows them. These control which extra tools the agent can use, what it remembers about you, and whether the model may search the web.

## Security
- **Password.** Local accounts change their password here. Your other sessions end when you do.
- **Authenticator.** Local accounts can set up a new authenticator app and get fresh recovery codes.
- **Active sessions.** See where you're signed in and sign out everywhere else.

**Signed out unexpectedly?** Your session ends after a period of inactivity. The app takes you to the sign-in page with a note. Sign in again and you can carry on.` },

  { id: 'appearance', group: 'Your account', title: 'Appearance and accessibility', requires: null, body: `
Open **Profile → Account → Appearance and accessibility**. These settings belong to your account, so they follow you to other browsers and devices.

- **Color mode.** Choose **Device default**, **Light**, or **Dark**. The sun and moon button in the top bar changes it too.
- **Text size.** Make all text larger: **Default**, **Large**, **Larger**, or **Largest**.
- **High contrast.** Stronger text and border contrast.
- **Reduce motion.** Turns off animations and transitions.
- **Always underline links.** Makes links easier to spot without relying on color.

Changes apply right away. There is no Save button.` },

  // ───────────────────────────── Administer
  // Order follows the work: get oriented, set up the platform, set up sign-in and access, extend it, then monitor it.
  // Say exactly where each setting lives ("Admin, then SAML, then the Group mapping tab") and
  // put every button, toggle, field, and tab you name in **bold**.
  { id: 'admin-overview', group: 'Administer', title: 'Administration at a glance', requires: ANY_ADMIN, body: `
Select **Admin** in the top bar. A list of pages appears on the left. You see only the pages your role allows. Select a page to open it. Some pages have tabs across the top.

## Where to find each setting

| Page in the **Admin** list | What you do there |
|---|---|
| **General** | Name the app, add helpdesk details, set agent limits, choose the execution mode |
| **Server (AI services)** | Connect AI providers, choose models, enter prices |
| **MCP servers** | Add tools from remote MCP servers |
| **Web search** | Choose a search service and switch web search on |
| **HTTPS** | Encrypt the connection to the server |
| **Branding** | Set colors, fonts, the logo, and the agent's name |
| **Users & roles** | Manage users (the **Users** tab) and roles (the **Roles** tab) |
| **SAML** | Connect your identity provider for single sign-on, and map IdP groups to roles (the **Group mapping** tab) |
| **Security (MFA)** | Require MFA, and set session, password, and lockout rules |
| **Courses** | Designate instructors, assign courses to SAML groups, and choose tutor panels |
| **Reports** (top bar, not under Admin) | See usage and what each model costs |
| **Audit log** | Review who did what |

## Jobs people ask about
- Create or edit a role: go to **Admin**, then **Users & roles**, then the **Roles** tab. See [Users, roles, and groups](#admin-users).
- Connect single sign-on: go to **Admin**, then **SAML**. See [Single sign-on (SAML)](#admin-saml).
- Map IdP groups to roles, or set a default role: go to **Admin**, then **SAML**, then the **Group mapping** tab. See [Users, roles, and groups](#admin-users).
- Add a model: go to **Admin**, then **Server (AI services)**. See [Connect AI models](#admin-ai) and the [provider guides](#ai-providers).
- Require MFA: go to **Admin**, then **Security (MFA)**. See [Security settings](#admin-security).
- Turn on a shell: go to **Admin**, then **General**. See [Turn on shell access safely](#admin-shell).

> [!INFO]
> Most changes ask you to confirm it's you before they save. Enter your code or password when the prompt appears, then the change goes through.` },

  { id: 'admin-how-it-works', group: 'Administer', title: 'How the platform fits together', requires: ANY_ADMIN, body: `
## The four parts

- **Web app.** The interface in the user's browser.
- **Server.** Stores projects on its disk, enforces roles and permissions, and writes the audit log.
- **AI providers.** Run the models. The server sends them each prompt, plus any file text or attachment the agent reads. Nothing else leaves. The server encrypts API keys.
- **Optional services.** Your identity provider for SSO, and any [MCP servers](#mcp-explained).

## A request, step by step
1. A user sends a message.
2. The server adds project context and sends it to the model.
3. The model replies, or asks to use a tool.
4. The server checks permissions, runs the tool, and returns the result.
5. Steps 3 and 4 repeat until the model finishes.

## When something goes wrong
| Problem | Where to look |
|---|---|
| Sign-in fails | **Admin**, then **SAML**, then the **Group mapping** tab and the **Test** tab |
| No model available | **Admin**, then **Server (AI services)**, and the role limits on the connection |
| Slow or costly | **Reports** in the top bar. See [Reports](#admin-reports) |
| Unexpected activity | **Admin**, then **Audit log**. See the [Audit log](#admin-audit) |

> [!WARNING]
> Run the server behind HTTPS on a patched host, and back up its data folder. The data folder holds the database and the encryption key. Without the key, stored API keys and secrets can't be read again.` },

  { id: 'admin-start', group: 'Administer', title: 'Setup checklist', requires: ANY_ADMIN, body: `
Complete these steps in order. Each one names the page to open.

1. **Connect a model.** Go to **Admin**, then **Server (AI services)**. Without a model, nobody can use the agent. See [Connect AI models](#admin-ai), then follow the [guide for your provider](#ai-providers).
2. **Set up sign-in.** Go to **Admin**, then **SAML**, and configure [SSO](#admin-saml). Keep one local administrator for emergencies.
3. **Map groups to roles.** Go to **Admin**, then **SAML**, then the **Group mapping** tab. Users without a mapped group can't sign in unless you set a **Default role** there. See [Users, roles, and groups](#admin-users).
4. **Enforce MFA** and set the idle timeout. Go to **Admin**, then **Security (MFA)**. See [Security settings](#admin-security).
5. **Review the general settings.** Go to **Admin**, then **General**. Keep **Agent execution mode** on **File tools only** until you need a shell. List protected files, such as \`.env\`, in **Files the agent may never read or write**. See [General settings](#admin-general).
6. **Enter model prices** so [reports](#admin-reports) show real costs. Open **Admin**, then **Server (AI services)**, and choose **Edit** on each model.
7. **Add MCP servers**, if you want them. Go to **Admin**, then **MCP servers**.
8. **Brand the app**, if you want to. Go to **Admin**, then **Branding**.
9. **Test as a normal user.** Sign in without administrator rights, open a project, and ask the agent a question.

> [!INFO]
> Share [Use AI safely](#ai-safety) with your users before launch.` },

  { id: 'admin-general', group: 'Administer', title: 'General settings', requires: 'settings.read', body: `
Go to **Admin**, then **General**. Change the fields you need, then select **Save**. Saving asks you to confirm it's you.

## Identity and helpdesk
- **Application name** appears in the header and on the sign-in page. **Tagline** appears on the sign-in page.
- **Contact name** and **Contact email** record who owns this app.
- **Helpdesk email**, **Helpdesk phone**, **Helpdesk URL**, **Helpdesk hours**, and **Support message** appear on the sign-in page under "Need help?".
- **Sign-in banner** shows a notice above the sign-in form.
- **Terms / acceptable-use notice** shows your policy in small print at the bottom of the sign-in page.

## Agent
- **AI disclaimer** sets the reminder users see under the message box.
- **Max agent steps per turn** limits how many steps the agent takes for one request.
- **Shell timeout (seconds)** and **Shell output cap (bytes)** limit each command. They matter only when shell access is on.
- **Max upload size (MB)** and **Max chat attachment size (MB)** limit file uploads.
- **Files the agent may never read or write** takes one pattern per line, such as \`.env\` or \`*.pem\`.

## Switches
- Toggle **Allow agent memory** to turn memory on or off for everyone. When it's off, users can't turn it on. See [Memory](#memory).
- Toggle **Show users what each session costs** to show the cost next to the token estimate in the Sessions pane.
- Toggle **Show users each model's price per million tokens in the model picker** to show the prices you enter under **Server (AI services)**.

## Agent execution mode
Choose one from the **Agent execution mode** list. The change takes effect right away and needs no **Save**.
- **File tools only (no shell)** is the safe default. The agent can read and edit files but can't run commands.
- **Server-side workspace with approval-gated shell** lets the agent run commands, one approval at a time. You need the permission to change settings.

> [!WARNING]
> Shell commands run as the server's operating-system user. Read [Turn on shell access safely](#admin-shell) before you choose the shell option.

Switching back to **File tools only** ends every live shell right away.` },

  { id: 'admin-ai', group: 'Administer', title: 'Connect AI models', requires: 'provider.read', body: `
A *provider* runs the AI models. Cloud providers, such as Anthropic and OpenAI, bill per token. A local option, such as LM Studio or Ollama, runs on your hardware and keeps prompts in-house.

Go to **Admin**, then **Server (AI services)**. You need the permission to manage providers to change anything here.

> [!INFO]
> Need help with a specific provider? The [integration guides](#ai-providers) cover OpenAI, Anthropic, Gemini, Mistral, Bedrock, Vertex AI, Azure OpenAI, LM Studio, Ollama, and self-hosted servers, step by step.

## Add a connection
1. Select **Add connection**.
2. Enter a **Name**, then pick the **Type**: OpenAI (ChatGPT), Anthropic, LM Studio, Ollama, OpenAPI-compatible (self-hosted), Google Gemini, Mistral AI, AWS Bedrock, Google Vertex AI, or Azure OpenAI.
3. Fill in the details that type needs, such as the **Base URL** and the API key.
4. Select **Connect & load models**. The app asks the provider what it offers and fills the list.
5. In **Models to make available**, pick the models you want users to see.
6. Optional: use **Restrict to roles (empty = all)** to limit the connection to certain roles, and **Help text for users (optional)** to add a note on the connection.
7. Leave **Enabled** on, then select **Save**.

> [!INFO]
> The app encrypts API keys and never shows them again. To replace a key, edit the connection and type a new one.

## Check a connection
Select **Test** on the connection's card. A green message lists how many models the provider offers. Select **Edit** to change the connection, or **Delete** to remove it.

## Tune each model
Find the model under its connection and select **Edit**. The window has these settings:

### Availability
- Toggle **Enabled (users can pick this model)** to show or hide the model.
- Toggle **Subagents (the agent may delegate work to this model)**. Turn it off for models that struggle with tool calls.
- Toggle **Files & images (users can attach them for this model)** only for models that can read them.

### Limits and cost
- **Context window (tokens)** sets the model's limit, so the "session is getting long" hint appears at the right time.
- Turn on **Automatic context sizing** when the provider picks the window itself. The app grays out the context window field and ignores it, and users see "Automatic context size" on the model's card. The "session is getting long" hint then measures against a default of 128,000 tokens.
- **Max reply (tokens)** caps the length of each answer.
- **Input price ($ per 1M tokens)** and **Output price ($ per 1M tokens)** feed the [reports](#admin-reports).

### Thinking
Pick **Adaptive** for current Claude models, **Budget** for older ones (then set **Thinking budget (tokens)**), or **Off**. Models that stream their reasoning on their own need no setting.

### Default model for
Tick **Plan**, **Act**, or **Chat** to make this the default model for that job. Use a capable model for Act and a cheaper one for Chat.

> [!INFO]
> To add a model the list missed, type its ID in **Add model ID** under the connection and select **Add**. Use the arrow buttons next to a connection or model to change the order users see.` },

  { id: 'admin-https', group: 'Administer', title: 'Set up HTTPS', requires: 'settings.read', body: `
HTTPS encrypts the connection between people's browsers and this server. Without it, passwords and code travel in the clear.

Go to **Admin**, then **HTTPS**.

## Choose a mode
If nobody has set it up yet, the page asks you to choose under **Connection security**:
- **Self-signed certificate.** The server creates its own certificate for the site's address. Browsers warn about it until each person trusts it. Good for testing or a private network.
- **No HTTPS (unencrypted).** Use this only on a trusted network, or when something else already encrypts the connection.

Select **Save**. It asks you to confirm it's you. Then **restart the server**. The choice takes effect after the restart. After you choose a self-signed certificate, open the site with \`https://\`.

> [!DANGER]
> With **No HTTPS (unencrypted)**, passwords and code travel in the clear. Anyone on the network can read them. Don't use this option on the public internet.

## Replace the certificate
Select **Create a new certificate** to replace the self-signed one, for example after the site's address changes. The page shows the **Current certificate** and the **Certificate after restart**.

## When the page offers no choice
If you start the server with its own certificate (\`TLS_CERT\` and \`TLS_KEY\`), with an \`https://localhost\` address, or behind a reverse proxy (\`TRUST_PROXY\`), you manage HTTPS there. The page then shows only the status.` },

  { id: 'admin-branding', group: 'Administer', title: 'Branding', requires: 'branding.read', body: `
Go to **Admin**, then **Branding**. A live preview at the bottom updates as you type. Select **Save** when you like the result.

## Look and feel
- Pick the **Primary**, **Secondary**, **Background**, and **Surface** colors.
- **Default app theme (users can override)** sets light, dark, or device default for people who haven't chosen.
- **Font family (CSS font stack)** and **Web font stylesheet URL** set the font. The stylesheet must use https.
- **Corner radius (px)** and **Density** (**Comfortable** or **Compact**) change spacing and shape.
- **Code editor theme** sets the editor's colors.

## Words and images
- **Agent persona name** gives the agent a friendly name, such as "Ada". It joins the default system prompts. The code assistance chat adds "-Code" ("Ada-Code") and the course design chat adds "-Course" ("Ada-Course"). General chat and the agent view use the plain name. A user who writes their own prompt replaces it.
- **Sign-in page text** adds a short message to the sign-in page.
- Select **Upload logo** or **Upload favicon** (PNG, JPEG, WebP, or SVG). The app cleans SVG files to remove anything unsafe.

> [!INFO]
> People see your changes after they reload the page.` },

  { id: 'admin-saml', group: 'Administer', title: 'Single sign-on (SAML)', requires: 'idp.read', body: `
*Single sign-on* lets people use their organization login. With SAML, your *identity provider* (IdP), such as Okta or Entra ID, proves who someone is, and this app (the *service provider*) trusts that proof.

Go to **Admin**, then **SAML**. The page has five tabs: **Identity provider**, **Service provider**, **Attributes & NameID**, **Group mapping**, and **Test**. Above the tabs, toggle **Enable SAML sign-in** and set the **Login button text** that appears on the sign-in page.

## Connect your identity provider
1. Go to **Admin**, then **SAML**, then the **Service provider** tab. Select **Download SP metadata** and give the file to your IdP. If your IdP accepts pasted metadata, select **View SP metadata** instead, select **Copy** under the XML, and paste it into your IdP. If you want signed requests, select **Generate SP certificate** first and toggle **Sign authentication requests**.
2. Go to the **Identity provider** tab. Choose **Metadata URL** and paste the address, or choose **Upload file** and select **Choose XML file**. Then select **Auto-populate IdP metadata**. Review what appears, then select **Use these**.
3. Go to the **Attributes & NameID** tab. Confirm the **Email attribute**, **First name attribute**, **Last name attribute**, and **Group membership attribute** names that your IdP sends.
4. Select **Save SAML settings**. It asks you to confirm it's you.
5. Map groups to roles. Go to the **Group mapping** tab. See [Map groups to roles](#admin-users). See [Users, roles, and groups](#admin-users).
6. Go to the **Test** tab and select **Run test sign-in**. A new tab shows exactly what your IdP sends, without signing anyone in or creating a user.

> [!INFO]
> Save your settings before you run the test. The test uses the saved settings.

## Choose a NameID format
On the **Attributes & NameID** tab, pick **NameID format requested from the IdP**. Choose **persistent**. Persistent IDs are stable and private, and the app never treats them as email addresses. Other formats work too, with a warning. A transient NameID changes at every sign-in, so you must also fill in **Unique-ID attribute**.

## Tighten the connection
On the **Identity provider** tab, keep **Require signed assertions** and **Require signed response** on.

> [!WARNING]
> Leave **Allow private-network metadata hosts (not recommended)** off unless your IdP really lives on a private network. Turning it on lets the server fetch metadata from internal addresses.

## Need MFA for SSO users?
Go to **Admin**, then **Security (MFA)**. The app checks what your IdP asserts. See [Security settings](#admin-security).` },

  { id: 'admin-users', group: 'Administer', title: 'Users, roles, and groups', requires: { any: ['user.read', 'role.read'] }, body: `
Go to **Admin**, then **Users & roles**. The page has a **Users** tab and, if your role may read roles, a **Roles** tab. Mapping IdP groups to roles is on the **SAML** page, on its **Group mapping** tab.

> [!INFO]
> Most people sign in with SSO and appear on the **Users** tab automatically. Local accounts exist for emergencies and always require MFA.

## Manage users
Go to **Admin**, then **Users & roles**, then the **Users** tab.
- Select **Add local user** to create an account. Enter a **Username** and an **Initial password**. The person must change the password at first sign-in.
- Select **Edit** on a row to change the name, email, or roles. Toggle **Disabled** to block an account without deleting it.
- Toggle **Break-glass account (allowed to use local sign-in)** for emergency accounts.
- Select **Reset MFA** when someone loses their authenticator. You need the MFA reset permission.
- Select **Delete** to remove a user.

## Create and edit roles
Go to **Admin**, then **Users & roles**, then the **Roles** tab.
1. Select **New role**, or select **Edit** on an existing role.
2. Enter a **Name** and a **Description**.
3. Tick the permissions the role needs. Read and write permissions are separate. Hover over a name to see what it allows.
4. Select **Save**.

The built-in **administrator** role has every permission and you can't edit it. **developer** covers everyday building. **mcp-admin** manages tenant MCP servers. **instructor** designs and runs courses. **chat-general** allows the General chat tab only, and **chat-general-coding** adds the Coding chat tab; neither gives access to the agent or projects. Select **Delete** on a custom role to remove it.

## Map groups to roles
Go to **Admin**, then **SAML**, then the **Group mapping** tab. Changing mappings needs the permission to manage roles.
1. Under **IdP group → role mapping**, select **Add mapping**.
2. Enter the **Group value** your IdP sends. For Active Directory, use the full DN or just the CN.
3. Pick the **Role** that group receives.
4. Select **Save mappings**.

SSO users get their roles from these mappings at every sign-in.

## Give everyone else a default role
Some people belong to no mapped group, or your IdP sends no group information. On the same **Group mapping** tab, pick a **Default role (users with no mapped group)**, then select **Save SAML settings**. The app applies the default role only when none of a person's groups match a mapping. It never adds the default role on top of mapped roles. Choose a role with few permissions.

> [!WARNING]
> With **Default role** set to **None — refuse sign-in**, the app refuses people with no mapped group at sign-in. Map at least one group, or choose a default role, before you turn SSO on for everyone.

> [!DANGER]
> The app refuses to delete or demote the last administrator. Keep at least one local administrator account for emergencies, and store its password safely.` },

  { id: 'admin-security', group: 'Administer', title: 'Security settings', requires: 'security.read', body: `
*MFA* (multi-factor authentication) adds a second proof of identity, such as an authenticator code, to the password.

Go to **Admin**, then **Security (MFA)**. Change the fields you need, then select **Save**. Saving asks you to confirm it's you.

## MFA enforcement
- Toggle **Require MFA for everyone**, or list roles (one per line) in **…or require MFA for these roles**.
- Local accounts always need MFA. For SSO users, your IdP performs MFA and the app checks what it asserts. Fill in **Accepted AuthnContextClassRef values**, **Accepted 'amr' attribute values**, and **'amr' attribute name** to say what counts as MFA.
- **Maximum authentication age (seconds, 0 = unlimited)** and **Force re-authentication at the IdP on every sign-in** make people prove themselves again.
- **Enrollment grace period for local accounts (days)** gives new local users time to set up MFA.
- **Step-up window for sensitive actions (seconds)** sets how long a confirmation lasts.

## Sessions
- **Idle timeout (seconds)** ends a session after that much inactivity. Users then land on the sign-in page with a note.
- **Absolute lifetime (seconds)** ends every session after that long, however active.

## Local authentication
- Toggle **Allow local sign-in**, and toggle **Restrict local sign-in to break-glass accounts** to keep it for emergencies.
- **Minimum password length** sets the shortest password. Passwords can be as long as you like, up to 100,000 characters, and every character counts.
- **Lock out after N failed attempts** and **Base lockout (minutes, doubles on repeats)** control lockouts. Lockouts double when they repeat.

> [!WARNING]
> Don't turn off **Allow local sign-in** until SSO works for at least one administrator. Otherwise you can lock yourself out.` },

  { id: 'admin-extensions', group: 'Administer', title: 'MCP servers, attachments, and memory', requires: { any: ['mcp.read', 'mcp.write', 'settings.read', 'provider.read'] }, body: `
Three settings shape what the agent can reach.

## MCP servers
Go to **Admin**, then **MCP servers**.
1. Select **Add server**.
2. Enter a **Name** (lowercase letters, digits, and dashes) and the **URL** of a remote server that uses the Streamable HTTP transport.
3. Add **Authentication headers**, one \`Name: value\` per line. The app stores them encrypted and never shows them again.
4. Leave **Enabled** on, then select **Save**.
5. Select **Test** on the server's row to list its tools. Outlined tools are read-only. The others can change things, so the agent needs approval for each call, and they are unavailable in Plan mode.

Everyone gets an organization server unless they switch it off for themselves. At the top of the page, toggle **Allow users to connect their own MCP servers (Profile → MCP servers)** to let people add personal ones. Changes need a recent re-verification.

> [!WARNING]
> The app blocks private addresses for MCP servers. Toggle **Allow a private/internal address (http allowed)** on a server only when you trust that network.

## Files and images
1. Go to **Admin**, then **Server (AI services)**, and select **Edit** on a connection (to set the default for all its models) or on a single model. Toggle **Files** and **Images** under **Uploads** to set the default for all of a connection's models. In a model's **Edit** dialog, you can override either one for that model. Leave images off for models without vision support.
2. Go to **Admin**, then **General**, and set **Max upload size (MB)** and **Max chat attachment size (MB)**. Select **Save**.

## Memory
Go to **Admin**, then **General**, and toggle **Allow agent memory**. When it's off, memory is off for the whole organization. When it's on, users choose whether to use it.` },

  { id: 'admin-courses', group: 'Administer', title: 'Set up courses', requires: 'course.admin', body: `
Go to **Admin**, then **Courses**. The page has three tabs: **Instructors**, **Courses & groups**, and **Tutor panels**. Instructors build the courses themselves; see [Build a course](#courses-build).

## Designate instructors
Go to **Admin**, then **Courses**, then the **Instructors** tab. Search under **Designate an instructor**, pick the person, and select **Designate**. Select **Remove** to take the role back. Both ask you to confirm it's you.

You can also select **Make instructor** beside a person on the **Users** tab of **Users & roles**, or map an IdP group to the built-in **instructor** role. People who get the role through a group show **Via SSO group**. Change the group mapping to remove them.

Instructors create and edit their own courses. People with the course administration permission can open every course.

## Assign courses to SAML groups
Go to **Admin**, then **Courses**, then the **Courses & groups** tab. Every course shows its owner, its status, and its groups. Under **Add SAML group**, pick a group the app has seen, or type a name and press <kbd>Enter</kbd>. Remove a group with the **x** on its chip.

Everyone in the group can take the course once it's published. Group membership updates when people sign in, so a new member sees the course after their next sign-in. Instructors can enroll people and roles themselves, but only you can assign groups.

## Choose tutor panels
Go to **Admin**, then **Courses**, then the **Tutor panels** tab. Each panel has a switch, a name, and a kind: **Learner notes**, **Hints**, **Resource links**, or **Course progress**. Turn a switch off to hide that panel from learners and from new pages. Select **Add panel** to make another panel of a kind, and **Save panels** to keep your changes. Instructors choose from the panels you leave on.

## Permissions and roles
| Permission | What it allows |
|---|---|
| \`course.learn\` | Take courses you're enrolled in. The built-in **developer** and **chat-general** roles have it. |
| \`course.author\` | Create courses, enroll learners, and grade. The built-in **instructor** role has it. |
| \`course.admin\` | Manage all courses, assign SAML groups, designate instructors, and choose tutor panels. |

Learners don't need permission to use AI models to talk to a tutor. Chat and tutor panels use the default **Chat** model; set it under **Admin**, then **Server (AI services)**, by editing a model and ticking **Chat**. Their cost shows in [Reports](#admin-reports) with all other model use.

## Exercises, workspaces, and privacy
- Each exercise attempt creates an ordinary project owned by the learner. The learner's own role decides what the agent can do there, and the exercise's rules only take more away. The **Full agent** preset allows the shell only when you've turned on [shell access](#admin-shell).
- When a learner submits, the app saves a snapshot of their workspace and agent sessions for the instructor to read. Tell learners in advance. Deleting the assessment or the course deletes its snapshots.
- Deleting a course doesn't delete learners' workspaces. They stay as ordinary projects the learner can delete.

> [!INFO]
> Exercise rules apply to the workspace of one attempt and to nothing else. A learner's other projects behave as usual.` },

  { id: 'admin-web-search', group: 'Administer', title: 'Set up web search', requires: 'settings.read', body: `
Web search lets users' models look things up on the web. You choose a search service and switch the feature on. Users then decide for themselves, and per chat, whether to use it.

## Set it up
Go to **Admin**, then **Web search**.
1. Under **Search service**, pick a **Service**.
   - **Brave Search API.** Create a key in your Brave Search API account, then paste it in **API key**. The app stores it encrypted and never shows it again. To replace it, type a new key. To keep it, leave the box empty.
   - **SearXNG.** Enter the address in **SearXNG address**, such as \`https://searx.example.com\`. The instance must allow JSON output (include \`json\` in its \`search.formats\` setting).
2. Select **Save**. Saving asks you to confirm it's you.
3. Select **Test saved settings**. A green message means the service answered.
4. Toggle **Allow web search for this organization**.

> [!INFO]
> To turn the feature off for everyone, toggle **Allow web search for this organization** off again.

## Who can use it
Three switches must all be on: yours (the organization), the user's own (**Profile**, then **Web search**), and the chat's. The role also needs the web search permission, which the Developer role has by default. On the chat page, each tab has its own web search permission too.

## Private addresses
The app blocks local and private SearXNG addresses. If your instance lives inside your network, toggle **Allow a private or local address (for an instance inside your network)**.

## Privacy and safety
> [!WARNING]
> Search words leave your network and go to the service you chose. Tell your users, and check the service's terms.

- The audit log records that a search happened, with the length of the query but not its text.
- Each user can run up to 20 searches a minute.
- The model receives only titles, links, and short snippets. It never opens the pages, and it treats results as untrusted.` },

  { id: 'admin-shell', group: 'Administer', title: 'Turn on shell access safely', requires: 'settings.write', body: `
Shell access lets the agent (and users you choose) run commands on the server.

## Turn it on
1. Go to **Admin**, then **General**. In **Agent execution mode**, choose **Server-side workspace with approval-gated shell**. Confirm it's you when asked.
2. Go to **Admin**, then **Users & roles**, then the **Roles** tab. Select **Edit** on a role and tick \`agent.shell.run\` for roles whose agents may run commands, and \`terminal.use\` for people who may open a terminal. Select **Save**.
3. Tell users that every agent command needs their **Allow**.

## Turn it off
Go to **Admin**, then **General**, and choose **File tools only (no shell)**. Every live shell ends right away.

> [!DANGER]
> Shells run as the server's operating-system account and aren't a sandbox. A command can read anything that account can read. Run the app in a container or as a low-privilege user, and grant these permissions only to people you trust.

Shells start with a clean environment, so the server's secrets stay out. Set **Shell timeout (seconds)** and **Shell output cap (bytes)** on the same **General** page.` },

  { id: 'admin-reports', group: 'Administer', title: 'Reports', requires: 'report.read', body: `
Choose **Reports** in the top bar. It appears only for roles with the **View usage and cost reports** permission (the built-in **reporter** role has it). Choose the range with **From** and **To**, or **Last 7 days**, **Last 30 days**, **Last 90 days**.

The page shows:
- Totals for the range: spend, requests, tokens, active users, and the average cost per active user and per request. Each total shows its change from the previous period of the same length.
- **This month**: spend so far and a projection to the end of the month at the current pace.
- **Spend by day**, **Spend by model**, **Spend by user**, and **Spend by activity** (Agent, Chat, Courses, Context compaction).
- **Costliest sessions and chats**.

Choose **Download CSV** to get one row per model request, for use in a spreadsheet.

## How cost works
Cost is tokens × the model's price. Enter each model's input and output price (US dollars per million tokens) under **Admin**, then **Server (AI services)**, in the model's **Edit** window. The report counts models without a price but charges them $0, and warns you.

> [!INFO]
> When a provider doesn't report token counts, the app estimates them and marks the row "est.".

## Show costs to users
Toggle **Show users what each session costs**. It appears on this page and under **Admin**, then **General**. The cost then shows next to the token estimate in the Sessions pane.` },

  { id: 'admin-audit', group: 'Administer', title: 'Audit log', requires: 'audit.read', body: `
Go to **Admin**, then **Audit log**. The log records sign-ins, setting changes, role edits, shell activity, agent tool use, and more. Each row shows the time, the actor, the action, the target, and detail. Select **Load older entries** to go further back.

## Check the log's integrity
Each entry links to the one before it, so the app can tell when someone tampers with the log. A green banner at the top means the chain checks out.

> [!DANGER]
> A red banner that says the integrity check failed means someone changed or removed an entry. Treat it as a security incident. Note the entry number it names, and investigate before you change anything else.` },

  // ───────────────────────────── Integration guides (one per AI provider)
  ...INTEGRATION_TOPICS,

  // ───────────────────────────── Reference
  { id: 'shortcuts', group: 'Reference', title: 'Keyboard shortcuts', requires: 'files.read', body: `
| Action | Shortcut |
|---|---|
| Save | <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>S</kbd> |
| Find | <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>F</kbd> |
| Replace | <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>H</kbd> |
| Go to line | <kbd>Ctrl</kbd> + <kbd>G</kbd> |
| Command palette | <kbd>F1</kbd> |
| Comment line | <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>/</kbd> |
| Rename in the file tree | <kbd>F2</kbd> |
| Delete in the file tree | <kbd>Delete</kbd> |
| Send a message | <kbd>Enter</kbd> |
| New line in a message | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Resize a divider | <kbd>←</kbd> <kbd>→</kbd> (hold <kbd>Shift</kbd> for bigger steps) |

> [!INFO]
> On a Mac, use <kbd>⌘</kbd> where a shortcut shows <kbd>Ctrl</kbd> / <kbd>⌘</kbd>. On Windows and Linux, use <kbd>Ctrl</kbd>.

Open the command palette with <kbd>F1</kbd> to search every editor command.` },

  { id: 'glossary', group: 'Reference', title: 'Glossary', requires: null, body: `
| Term | Meaning |
|---|---|
| Agent | AI that takes actions, such as editing files |
| Model (LLM) | Large Language Model. The AI program that reads and writes text |
| Provider | The service that runs models |
| Prompt | The text you send to the model |
| System prompt | Standing instructions that shape the model's behavior |
| Token | A chunk of text; providers bill per token |
| Context window | How much the model holds in mind at once |
| Tool | An action the agent can take |
| MCP | Model Context Protocol. A standard for plugging in extra tools |
| Skill | Saved instructions you run with a slash command |
| Subagent | A helper for one focused task |
| Checkpoint | A project snapshot you can restore |
| Plan / Act mode | Read-only exploring versus making changes |
| Hallucination | A confident answer that is wrong |
| Prompt injection | Hidden text that tries to steer the AI |
| SSO | Single Sign On |
| SAML | Security Assertion Markup Language. The standard that SSO uses to prove who you are |
| IdP | The identity provider: the system that holds organization accounts |
| MFA | Multi-Factor Authentication. A second proof of identity |
| Shell | A text window for typing commands |
| Course | A set of pages, with optional chat, tutor, and assessments, that an instructor builds |
| Instructor | Someone an administrator allows to build and run courses |
| Exercise | An assessment where you complete a task by working with the agent in your own workspace |
| Rubric | The list of things an instructor marks by hand |
| Tutor panel | A tab beside a course chat, such as notes or hints |

Still stuck? Contact the helpdesk listed on the sign-in page.
` },

  { id: 'troubleshooting', group: 'Reference', title: 'Troubleshooting', requires: null, body: `
## I can't sign in

Check with your administrator that a group maps to a role for you. Administrators can also use a local account with a username and password.

## The agent says no model is available

Ask an administrator to connect an AI model and allow your role to use it.

## I can't switch to Act

Your role can plan but not change files. Ask an administrator for Act access.

## An exercise workspace won't let me do something

Your instructor's rules for the exercise may switch it off, and the rules show above the agent. After you submit, or when the time limit ends, the workspace is read-only. See [Agentic-coding exercises](#courses-exercises).

## An upload failed

The file may exceed the upload limit, or the agent may be working. Wait for it to finish and try again.

## The terminal says shell access is off

An administrator has to turn it on and give your role the permission.

## The agent feels slow or forgetful

Your session may be full. Type \`/compact\`, or start a new session.

## The agent made a mistake

Open **Checkpoints**, roll back, and ask again with more detail.

## The agent invented a function or package

Ask where it found it, then check the official docs. See [Use AI safely](#ai-safety).

## I don't know a term

Check the [Glossary](#glossary).

## My layout looks wrong

Press **Layout** in the header, then **Reset layout**.` },

  { id: 'permissions', group: 'Reference', title: 'Permission reference', requires: 'role.read', dynamic: 'permissions', body: '' },
];
