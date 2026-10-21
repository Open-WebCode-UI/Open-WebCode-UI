// The tutorial script. Targets are `data-tour="<target>"` attributes in the app; nothing here uses element ids.
//   route:     path the step lives on (omit = any page). If the user is elsewhere the engine offers a "go there" step.
//   navigate:  makes this a navigation step: the target is clicked (or "Next" used) to reach `navigate`; arriving there advances.
//   placement: preferred Floating UI side; the tooltip flips/shifts to stay in the viewport.
//   inside:    sit inside the target's edge instead of beside it (for panes that fill most of the screen).
//   requires:  permission needed to see the step; steps the user can't use are left out.
//   optional:  skip silently when the target is not on screen (e.g. the user hid that panel).
export const STEPS = [
  { id: 'go-agent', target: 'nav-agent', placement: 'bottom', navigate: '/', requires: 'agent.plan', title: 'Open the Agent workspace', body: 'Click Agent to see where you build with the AI agent. The next few stops are its panels.' },
  { id: 'pane-explorer', target: 'pane-explorer', route: '/', requires: 'agent.plan', placement: 'right', title: 'Explorer: your project files',
    body: 'Pick a project at the top, then browse its files. Click a file to open it in the editor. Right-click for rename, move, delete, and download, or drop files from your desktop to upload. The agent works on exactly these files.' },
  { id: 'pane-sessions', target: 'pane-sessions', route: '/', requires: 'agent.plan', placement: 'right', title: 'Sessions: your conversations',
    body: 'Each session is one conversation with the agent. Start a new one for a new task, or click an old one to carry on where you left off. Long sessions slow the agent down, so start fresh when you change topic.' },
  { id: 'pane-editor', target: 'pane-editor', route: '/', requires: 'agent.plan', placement: 'bottom', inside: true, title: 'Editor: read and change code',
    body: 'Open files appear as tabs. Review what the agent changed here, or edit by hand and press Ctrl/⌘ S to save. A dot on a tab means unsaved changes. While the agent is running, saving is paused.' },
  { id: 'pane-agent', target: 'pane-chat', route: '/', requires: 'agent.plan', placement: 'left', title: 'Agent: tell it what you want',
    body: 'Describe a task in the message box and press Enter. Each step the agent takes shows up as a card you can open for details, and every turn ends with a summary of what changed. Press Stop at any time. In a long chat, type /compact to summarize it and keep going, or /clear to start fresh; your files stay untouched.' },
  { id: 'agent-mode', target: 'agent-mode', route: '/', requires: 'agent.plan', placement: 'bottom', title: 'Plan first, then Act',
    body: 'Plan mode is read-only: the agent explores and proposes a plan. Act mode lets it edit files. A good habit is to plan, read the plan, then switch to Act to approve it.' },
  { id: 'agent-checkpoints', target: 'agent-checkpoints', route: '/', requires: 'checkpoint.read', optional: true, placement: 'bottom', title: 'Checkpoints: a safety net',
    body: 'The agent saves a snapshot before it changes things. Open this tab to see what changed since any snapshot, or roll the whole project back if you do not like the result.' },
  { id: 'pane-terminal', target: 'pane-terminal', route: '/', requires: 'agent.plan', optional: true, placement: 'top', title: 'Terminal: a shell, and the agent\'s shell',
    body: 'The Terminal tab is your own shell in the project folder. The Agent tab shows live what the agent runs. Before the agent runs a command, you get Allow and Deny buttons, and nothing runs until you allow it.' },
  { id: 'layout', target: 'layout-menu', route: '/', requires: 'agent.plan', optional: true, placement: 'bottom', title: 'Make the workspace yours',
    body: 'Drag any panel by its header to rearrange it, drag the dividers to resize, or use this menu for ready-made layouts and to show or hide panels.' },
  { id: 'help', target: 'nav-help', placement: 'bottom', title: 'Help is always here', body: 'Guides for every feature you can use. That is the tour. You can replay it any time from your Profile page. Enjoy!' },
];
