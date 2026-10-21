import { useRef, useState } from 'react';
import { Alert, Chip, IconButton, Tooltip } from '@mui/material';
import AttachIcon from '@mui/icons-material/AttachFile';
import ImageIcon from '@mui/icons-material/ImageOutlined';
import FileIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { del, uploadAttachment } from '../api.js';

export const MAX_FILES = 5;

// Files waiting to be sent with the next message. They are uploaded at once (so a bad file is refused straight away) and
// stay unattached on the server until a message uses them.
export function useAttachments() {
  const [items, setItems] = useState([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const add = async (files) => {
    setError(''); setBusy(true);
    try {
      for (const f of [...files]) {
        if (items.length + 1 > MAX_FILES) { setError(`You can attach up to ${MAX_FILES} files.`); break; }
        try { const a = await uploadAttachment(f); setItems((x) => [...x, a]); } catch (e) { setError(`${f.name}: ${e.body?.message || e.body?.error || 'upload failed'}`); }
      }
    } finally { setBusy(false); }
  };
  const remove = (id) => { setItems((x) => x.filter((a) => a.id !== id)); del(`/api/attachments/${id}`).catch(() => {}); };
  const clear = () => { setItems([]); setError(''); };
  return { items, busy, error, add, remove, clear, dismiss: () => setError('') };
}

// Paperclip: only offered for models the administrator has enabled for files and/or images, and it only accepts what the model can read.
export function AttachButton({ model, att, disabled }) {
  const input = useRef(null);
  const files = !!model?.supportsFiles, images = !!model?.supportsImages;
  if (!files && !images) return null;
  const accept = files && images ? undefined : images ? 'image/png,image/jpeg,image/gif,image/webp' : '.pdf,.txt,.md,.csv,.tsv,.json,.log,.xml,.yaml,.yml,text/*,application/pdf,application/json';
  return (
    <>
      <input ref={input} type="file" multiple hidden accept={accept} data-testid="attach-input" onChange={(e) => { att.add(e.target.files); e.target.value = ''; }} />
      <Tooltip title={files && images ? 'Attach images, PDFs, or data files' : images ? 'Attach images' : 'Attach PDFs or data files'}><span><IconButton aria-label={images && !files ? 'Attach images' : 'Attach files'} disabled={disabled || att.busy || att.items.length >= MAX_FILES} onClick={() => input.current?.click()}><AttachIcon /></IconButton></span></Tooltip>
    </>
  );
}

export function AttachmentChips({ att }) {
  if (!att.items.length && !att.error && !att.busy) return null;
  return (
    <>
      {att.error && <Alert severity="error" sx={{ py: 0 }} onClose={att.dismiss}>{att.error}</Alert>}
      {(att.items.length > 0 || att.busy) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 8px' }}>
          {att.items.map((a) => <Chip key={a.id} size="small" icon={a.kind === 'image' ? <ImageIcon /> : <FileIcon />} label={a.name} onDelete={() => att.remove(a.id)} />)}
          {att.busy && <Chip size="small" label="Uploading…" variant="outlined" />}
        </div>)}
    </>
  );
}

// Names of files already sent with a message.
export function SentAttachments({ items }) {
  if (!items?.length) return null;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>{items.map((a, i) => <Chip key={i} size="small" variant="outlined" icon={a.kind === 'image' ? <ImageIcon /> : <FileIcon />} label={a.name} />)}</div>;
}
