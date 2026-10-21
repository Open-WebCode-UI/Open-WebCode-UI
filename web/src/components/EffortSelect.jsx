import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

export const EFFORTS = [
  { value: 'quick', label: 'Quick', hint: 'Smallest change that works; little exploring or checking' },
  { value: 'balanced', label: 'Balanced', hint: 'The normal level of care' },
  { value: 'thorough', label: 'Thorough', hint: 'Reads more code, considers edge cases, and verifies its work' },
];

// How much work the agent puts in. Works with every model: the server adds a short instruction to the system prompt.
export default function EffortSelect({ value, onChange, disabled }) {
  return (
    <Box>
      <ToggleButtonGroup size="small" exclusive fullWidth value={value} disabled={disabled} aria-label="Effort" onChange={(_, v) => v && onChange(v)}>
        {EFFORTS.map((e) => <ToggleButton key={e.value} value={e.value} sx={{ textTransform: 'none' }}>{e.label}</ToggleButton>)}
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>{EFFORTS.find((e) => e.value === value)?.hint}</Typography>
    </Box>
  );
}
