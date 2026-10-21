import { useEffect, useState } from 'react';
import { Box, Typography, Table, TableHead, TableRow, TableCell, TableBody, Alert, Button } from '@mui/material';
import { get } from '../../api.js';

export default function Audit() {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { get('/api/admin/audit?limit=50').then(setD); }, []);
  const loadMore = async () => {
    setLoading(true);
    try {
      const next = await get(`/api/admin/audit?limit=50&before=${d.nextBefore}`);
      setD((cur) => ({ ...cur, rows: [...cur.rows, ...next.rows], hasMore: next.hasMore, nextBefore: next.nextBefore }));
    } finally { setLoading(false); }
  };
  if (!d) return null;
  return (
    <Box>
      <Typography variant="h5" gutterBottom>Audit log</Typography>
      <Alert severity={d.integrity.ok ? 'success' : 'error'} sx={{ mb: 2 }}>{d.integrity.ok ? `Hash chain verified (${d.integrity.count} entries).` : `Integrity check FAILED at entry ${d.integrity.brokenAt}.`}</Alert>
      <Table size="small"><TableHead><TableRow><TableCell>Time</TableCell><TableCell>Actor</TableCell><TableCell>Action</TableCell><TableCell>Target</TableCell><TableCell>Detail</TableCell></TableRow></TableHead>
        <TableBody>{d.rows.map((r) => <TableRow key={r.id}><TableCell>{new Date(r.ts * 1000).toLocaleString()}</TableCell><TableCell>{r.actor ?? '—'}</TableCell><TableCell>{r.action}</TableCell><TableCell title={r.target ?? undefined} sx={{ maxWidth: 160, wordBreak: 'break-all' }}>{r.target ?? ''}</TableCell><TableCell sx={{ maxWidth: 360, wordBreak: 'break-all' }}>{r.detail}</TableCell></TableRow>)}</TableBody></Table>
      {d.hasMore && <Box sx={{ mt: 2, textAlign: 'center' }}><Button onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load older entries'}</Button></Box>}
    </Box>
  );
}
