import { useEffect, useState } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { get } from '../api.js';

// Type-ahead for finding a person by name, username or email (two characters to start). `onPick` gets { id, label, username } or null.
export default function UserPicker({ onPick, label = 'Find a person', value = null, sx }) {
  const [q, setQ] = useState(''); const [options, setOptions] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setOptions([]); return undefined; }
    let live = true;
    const t = setTimeout(() => get(`/api/courses-users?q=${encodeURIComponent(q.trim())}`).then((r) => live && setOptions(r)).catch(() => {}), 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <Autocomplete size="small" sx={sx} options={options} value={value} filterOptions={(o) => o} inputValue={q}
      onInputChange={(_, v) => setQ(v)} onChange={(_, v) => onPick(v)}
      getOptionLabel={(o) => (o.username && o.username !== o.label ? `${o.label} (${o.username})` : o.label)}
      isOptionEqualToValue={(a, b) => a.id === b.id} noOptionsText={q.trim().length < 2 ? 'Type at least two characters' : 'No one found'}
      renderInput={(p) => <TextField {...p} label={label} />} />
  );
}
