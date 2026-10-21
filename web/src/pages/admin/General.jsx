import { Typography, Alert } from '@mui/material';
import { SettingsPage, Text, Num, Pick, Lines, Bool } from './common.jsx';
import { useAuth } from '../../AuthContext.jsx';
import { put } from '../../api.js';
import { useStepUp } from '../../components/StepUp.jsx';
import { useState } from 'react';

export default function General() {
  const { can, refresh } = useAuth();
  const { run, dialog } = useStepUp();
  const [note, setNote] = useState('');
  return (
    <>
      <SettingsPage title="General settings" url="/api/admin/general" readOnly={!can('settings.write')} onSaved={refresh} intro="Application identity, contact, and helpdesk information (shown on the sign-in page), and agent execution limits.">
        {(f, set) => (<>
          <Text label="Application name" value={f.appName} onChange={set('appName')} />
          <Text label="Tagline" value={f.tagline} onChange={set('tagline')} />
          <Typography variant="subtitle2">Contact</Typography>
          <Text label="Contact name" value={f.contactName} onChange={set('contactName')} />
          <Text label="Contact email" value={f.contactEmail} onChange={set('contactEmail')} />
          <Typography variant="subtitle2">Helpdesk</Typography>
          <Text label="Helpdesk email" value={f.helpdeskEmail} onChange={set('helpdeskEmail')} />
          <Text label="Helpdesk phone" value={f.helpdeskPhone} onChange={set('helpdeskPhone')} />
          <Text label="Helpdesk URL" value={f.helpdeskUrl} onChange={set('helpdeskUrl')} />
          <Text label="Helpdesk hours" value={f.helpdeskHours} onChange={set('helpdeskHours')} />
          <Text label="Support message" multiline minRows={2} value={f.supportMessage} onChange={set('supportMessage')} />
          <Text label="Sign-in banner" multiline minRows={2} value={f.loginBanner} onChange={set('loginBanner')} />
          <Text label="Terms / acceptable use" multiline minRows={4} value={f.termsNotice} onChange={set('termsNotice')} helperText="Shown on its own page, linked from the sign-in page, the footer and the Contact pane. Leave blank for no terms page." />
          <Typography variant="subtitle2">Agent</Typography>
          <Alert severity="info">Execution mode is changed separately below (requires re-verification).</Alert>
          <Text label="AI disclaimer" value={f.aiDisclaimer} onChange={set('aiDisclaimer')} helperText="Shown under the message box in agent and chat. Leave blank for the default: “{name} is AI and can make mistakes. Always double check results.” ({name} is the persona name, or “The assistant” if none is set.)" />
          <Num label="Max agent steps per turn" value={f.maxAgentIterations} onChange={set('maxAgentIterations')} />
          <Num label="Shell timeout (seconds)" value={f.shellTimeoutSec} onChange={set('shellTimeoutSec')} />
          <Num label="Shell output cap (bytes)" value={f.shellOutputCapBytes} onChange={set('shellOutputCapBytes')} />
          <Num label="Max upload size (MB)" value={f.maxUploadMb} onChange={set('maxUploadMb')} helperText="Applies to file uploads and project .zip imports (1–500). Unpacked zip contents may be up to 4× this (minimum 200 MB)." />
          <Num label="Max chat attachment size (MB)" value={f.maxAttachmentMb} onChange={set('maxAttachmentMb')} helperText="Images, PDFs, and data files users attach to a message (1–50). A model only accepts them once file and/or image uploads are switched on for its connection or for the model itself under Server (AI services)." />
          <Bool label="Allow agent memory (users and projects still choose to turn it on; off here disables it for everyone)" value={f.memoryAllowed} onChange={set('memoryAllowed')} />
          <Bool label="Enable Courses (off hides the Courses page, the Course Design chat tab, and course administration for everyone; existing courses are kept)" value={f.coursesEnabled} onChange={set('coursesEnabled')} />
          <Bool label="Show every user what each session costs (individual roles can be given the “View own session spend” permission instead; with its token estimate, in the Sessions pane and the chat list)" value={f.showSessionCost} onChange={set('showSessionCost')} />
          <Bool label="Show users each model's price per million tokens in the model picker (the prices are the ones you enter under Server (AI services))" value={f.showModelPricing} onChange={set('showModelPricing')} />
          <Bool label="Fun mode (mix a few fun facts in with the helpful tips shown while the agent works)" value={f.funMode} onChange={set('funMode')} />
          <Lines label="Files the agent may never read or write (glob patterns, one per line)" value={f.secretGlobs} onChange={set('secretGlobs')} />
          <ExecMode value={f.execMode} disabled={!can('settings.write')} run={run} note={note} setNote={setNote} onChanged={(v) => set('execMode')(v)} />
        </>)}
      </SettingsPage>
      {dialog}
    </>
  );
}

function ExecMode({ value, disabled, run, note, setNote, onChanged }) {
  const change = async (v) => { try { await run(() => put('/api/admin/general/exec-mode', { execMode: v })); onChanged(v); setNote('Execution mode updated'); } catch (e) { if (e.message !== 'canceled') setNote('Failed to update'); } };
  return (<>
    <Pick label="Agent execution mode" value={value} onChange={change} options={[['files_only', 'File tools only (no shell) — safest, simplest deployment'], ['workspace_shell', 'Server-side workspace with approval-gated shell']]} />
    {disabled && <Alert severity="info">You do not have permission to change this.</Alert>}
    {value === 'workspace_shell' && <Alert severity="warning">Shell commands run as the server's OS user inside the project directory, one approval at a time. Only grant "agent.shell.run" to trusted roles; run the server in a container or low-privilege account.</Alert>}
    {note && <Alert severity="success" onClose={() => setNote('')}>{note}</Alert>}
  </>);
}
