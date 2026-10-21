import { useState } from 'react';
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material';
import { approvals, useApprovals } from '../approvalStore.js';

// "The agent wants to run <command>": nothing runs until the user presses Allow. The optional sidecar message goes to the agent with either answer.
export default function ApprovalPrompt({ dense }) {
  const queue = useApprovals();
  const [message, setMessage] = useState('');
  const a = queue[0];
  if (!a) return null;
  const answer = (value) => { approvals.answer(a.id, value, message); setMessage(''); };
  return (
    <Alert severity="warning" role="alertdialog" aria-label="Command approval" data-testid="approval" sx={{ alignItems: 'center', '& .MuiAlert-message': { flexGrow: 1, minWidth: 0 }, ...(dense ? { py: 0, borderRadius: 0 } : {}) }}>
      <Typography variant="body2">{a.agent ? `Subagent “${a.agent}”` : 'The agent'} wants to {String(a.command).startsWith('MCP tool ') ? 'use this MCP tool' : 'run this command'}{queue.length > 1 ? ` (+${queue.length - 1} more waiting)` : ''}:</Typography>
      <Box component="pre" sx={{ m: 0, mt: 0.5, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>{a.command}</Box>
      <TextField size="small" fullWidth margin="dense" placeholder="Add a message for the agent (optional)" slotProps={{ htmlInput: { maxLength: 1000, 'aria-label': 'Message to the agent' } }} value={message} onChange={(e) => setMessage(e.target.value)} />
      <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}><Button size="small" color="inherit" variant="outlined" onClick={() => answer(true)}>Allow</Button><Button size="small" color="inherit" onClick={() => answer(false)}>Deny</Button></Stack>
    </Alert>
  );
}
