import { useState } from 'react';
import { Box, Button, Typography, Paper, Stack, Alert } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { SettingsPage, Text, Num, Pick } from './common.jsx';
import { buildTheme, contrast, MIN_CONTRAST, autoFill, AUTO_SOURCES } from '../../theme.js';
import { post } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';

const readDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

// Colors checked against the backgrounds they appear on (the dark app backgrounds are fixed in theme.js).
const DARK_BG = ['#121317', '#1c1e24'];
function contrastIssues(f) {
  const checks = [
    ['Primary (light mode) on background/surface', f.primaryColor, [f.backgroundColor, f.surfaceColor], 'darker'],
    ['Primary (dark mode) on dark backgrounds', f.primaryColorDark, DARK_BG, 'lighter'],
    ['Secondary (light mode) on background/surface', f.secondaryColorLight, [f.backgroundColor, f.surfaceColor], 'darker'],
    ['Secondary (dark mode) on dark backgrounds', f.secondaryColor, DARK_BG, 'lighter'],
    ['Button text (light mode) on primary', f.buttonTextLight, [f.primaryColor], 'contrasting'],
    ['Button text (light mode) on secondary', f.buttonTextLight, [f.secondaryColorLight], 'contrasting'],
    ['Button text (dark mode) on primary', f.buttonTextDark, [f.primaryColorDark], 'contrasting'],
    ['Button text (dark mode) on secondary', f.buttonTextDark, [f.secondaryColor], 'contrasting'],
  ];
  return checks.map(([label, fg, bgs, hint]) => ({ label, hint, ratio: Math.min(...bgs.map((bg) => contrast(fg, bg))) })).filter((c) => c.ratio < MIN_CONTRAST);
}

export default function Branding() {
  const { can, refresh } = useAuth(); const write = can('branding.write');
  const [note, setNote] = useState(null);
  const upload = (kind) => async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await post('/api/admin/branding/upload', { kind, dataUrl: await readDataUrl(f) }); setNote({ s: 'success', t: `${kind} updated. Reload to see it.` }); refresh(); } catch (x) { setNote({ s: 'error', t: x.body?.error || 'Upload failed' }); }
  };
  return (
    <SettingsPage title="Branding" url="/api/admin/branding" readOnly={!write} intro="Theme colors, fonts, logo, and the agent's persona name. Changes are applied to everyone after they reload.">
      {(f, set) => { const auto = f.colorMode === 'auto';
        // In auto mode, changing the primary/background/surface color (or switching to auto) pre-fills the other colors; they stay editable.
        const fill = (next) => Object.entries(autoFill(next)).forEach(([k, v]) => set(k)(v));
        const setColor = (k) => (v) => { set(k)(v); if (auto && AUTO_SOURCES.includes(k)) fill({ ...f, [k]: v }); };
        const setMode = (v) => { set('colorMode')(v); if (v === 'auto') fill(f); };
        return (<>
        {note && <Alert severity={note.s}>{note.t}</Alert>}
        <Pick label="Color mode" value={f.colorMode || 'manual'} onChange={setMode} options={[['manual', 'Manual (choose every color)'], ['auto', 'Auto (derive the other colors from the primary color)']]}
          helperText="Auto pre-fills the secondary color, dark-mode colors and button text from the primary color whenever you change the primary, background or surface color. You can still edit any of them, and the contrast checks below apply." />
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {[['primaryColor', 'Primary (light mode)'], ['primaryColorDark', 'Primary (dark mode)'], ['secondaryColorLight', 'Secondary (light mode)'], ['secondaryColor', 'Secondary (dark mode)'],
            ['buttonTextLight', 'Button text (light mode)'], ['buttonTextDark', 'Button text (dark mode)'], ['backgroundColor', 'Background'], ['surfaceColor', 'Surface']]
            .map(([k, l]) => (
            <Box key={k}><Typography variant="caption">{l}</Typography><br /><input type="color" aria-label={`${l} color`} value={f[k]} onChange={(e) => setColor(k)(e.target.value)} /> <Text label="" value={f[k]} onChange={setColor(k)} sx={{ width: 110 }} /></Box>
          ))}
        </Stack>
        {contrastIssues(f).map((i) => <Alert key={i.label} severity="warning">{i.label}: contrast {i.ratio.toFixed(2)}:1 is below {MIN_CONTRAST}:1. Pick a {i.hint} color.</Alert>)}
        <Pick label="Default app theme (users can override)" value={f.defaultMode} onChange={set('defaultMode')} options={[['system', 'Device default'], ['light', 'Light'], ['dark', 'Dark']]} />
        <Text label="Font family (CSS font stack)" value={f.fontFamily} onChange={set('fontFamily')} />
        <Text label="Web font stylesheet URL (https, e.g. Google Fonts; optional)" value={f.fontUrl} onChange={set('fontUrl')} />
        <Num label="Corner radius (px)" value={f.borderRadius} onChange={set('borderRadius')} />
        <Pick label="Density" value={f.density} onChange={set('density')} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} />
        <Pick label="Code editor theme" value={f.monacoTheme} onChange={set('monacoTheme')} options={[['system', 'Device default (follows the app theme)'], ['vs', 'Light'], ['vs-dark', 'Dark'], ['hc-black', 'High contrast']]} />
          <Text label="Agent persona name" value={f.personaName} onChange={set('personaName')} helperText={f.personaName?.trim()
            ? `Added to the default system prompts; a user who writes their own prompt in Profile replaces it. The assistant will be named “${f.personaName.trim()}” in general chat and the agent view, “${f.personaName.trim()}-Code” in the code assistance chat, and “${f.personaName.trim()}-Course” in the course design chat.`
            : 'A friendly name the agent uses for itself (e.g. “Ada”). With “Ada”, it presents as “Ada” in general chat and the agent view, “Ada-Code” in the code assistance chat, and “Ada-Course” in the course design chat. Leave blank for none.'} />
        <Text label="Sign-in page text" multiline minRows={2} value={f.loginText} onChange={set('loginText')} />
        {write && <Stack direction="row" spacing={2}><Button component="label" variant="outlined">Upload logo<input hidden type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={upload('logo')} /></Button><Button component="label" variant="outlined">Upload favicon<input hidden type="file" accept="image/png,image/svg+xml,image/x-icon" onChange={upload('favicon')} /></Button></Stack>}
        <Typography variant="subtitle2">Preview</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {[['light', 'Light mode'], ['dark', 'Dark mode']].map(([mode, label]) => (
            <ThemeProvider key={mode} theme={buildTheme(f, mode)}>
              <Paper sx={{ p: 2, flex: 1, bgcolor: 'background.default' }} role="group" aria-label={`${label} preview`}>
                <Typography variant="caption" color="text.secondary">{label}</Typography>
                <Paper sx={{ p: 2, mt: 0.5 }}><Typography variant="h6">Sample card</Typography><Stack direction="row" spacing={1} sx={{ mt: 1 }}><Button variant="contained">Primary</Button><Button variant="contained" color="secondary">Secondary</Button><Button>Text</Button></Stack></Paper>
              </Paper>
            </ThemeProvider>
          ))}
        </Stack>
      </>); }}
    </SettingsPage>
  );
}
