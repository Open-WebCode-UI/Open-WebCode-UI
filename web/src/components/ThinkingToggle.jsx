import { FormControlLabel, Switch, Tooltip } from '@mui/material';

// Shown so it can be found. For models an administrator has not set up to think it is switched off and explains why.
// Hidden when the provider itself reports the model can't think.
export default function ThinkingToggle({ model, value, onChange, disabled }) {
  if (model?.thinkingCapable === false) return null;
  const supported = !!model?.supportsThinking;
  const control = (
    <FormControlLabel sx={{ mr: 0, flexShrink: 0 }} label="Thinking" slotProps={{ typography: { variant: 'body2' } }}
      control={<Switch size="small" checked={supported && value} disabled={disabled || !supported} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-label': 'Thinking' } }} />} />
  );
  return supported ? control : <Tooltip title={model ? 'Extended thinking is not enabled for this model. An administrator can turn it on in the model settings.' : 'Choose a model first'}><span>{control}</span></Tooltip>;
}
