import { useState } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import CopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';

// Copies `text` (plain markdown, exactly as written, or as the model produced it) to the clipboard.
export default function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(text ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } };
  if (!text?.trim()) return null;
  return <Tooltip title={copied ? 'Copied' : label}><IconButton size="small" aria-label={label} onClick={copy} sx={{ p: 0.25 }}>{copied ? <CheckIcon fontSize="inherit" /> : <CopyIcon fontSize="inherit" />}</IconButton></Tooltip>;
}
