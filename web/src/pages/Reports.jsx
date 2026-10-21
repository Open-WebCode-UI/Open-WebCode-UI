import { useEffect, useState, useCallback } from 'react';
import { Box, Typography, Tooltip, Alert, Paper, TextField, Table, TableHead, TableRow, TableCell, TableBody, Button, Chip, FormControlLabel, Switch } from '@mui/material';
import { get, put } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { CONTENT_MAX_WIDTH } from '../components/SectionShell.jsx';
import { errText } from './admin/common.jsx';

const money = (n) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2 })}`;
const num = (n) => (n || 0).toLocaleString();
const dayStr = (d) => d.toISOString().slice(0, 10);
const startOf = (s) => Math.floor(new Date(`${s}T00:00:00`).getTime() / 1000);
const KINDS = { agent: 'Agent', chat: 'Chat', course: 'Courses', compact: 'Context compaction' };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const bar = (v, max) => <Box role="presentation" sx={{ height: 8, borderRadius: 1, bgcolor: 'primary.main', width: `${max ? (v / max) * 100 : 0}%`, minWidth: v ? 2 : 0 }} />;
const PRESETS = [['7 days', 7], ['30 days', 30], ['90 days', 90]];

// Change against the previous period of the same length, as a short note under a figure (nothing when there is no earlier data).
function Delta({ now, before }) {
  if (before == null || !before) return null;
  const d = Math.round(((now - before) / before) * 100);
  return <Typography variant="caption" color="text.secondary" display="block">{d === 0 ? 'No change' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`} vs previous period</Typography>;
}

function Stat({ label, children, note }) {
  return <Box sx={{ minWidth: 140 }}><Typography variant="caption" color="text.secondary">{label}</Typography>{children}{note}</Box>;
}

const SERIES_COLORS = ['#1976d2', '#ed6c02', '#2e7d32', '#9c27b0', '#d32f2f', '#0097a7', '#795548', '#c2185b'];
const dayAdd = (s, n) => dayStr(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86400000));
// A round number at or above v, so the y axis ends on a tidy tick.
const niceMax = (v) => { if (!v) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

// Spend per day, stacked by model, with labelled axes, a legend, and a least-squares trend line through the daily totals.
// Days without usage are shown as zero so the x axis and the trend are true to the calendar.
function DailyChart({ days, byDayModel = [] }) {
  const W = 800; const H = 300; const m = { l: 64, r: 16, t: 12, b: 48 };
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const keyOf = (r) => `${r.provider || ''}\u0000${r.model}`;
  const series = []; const totals = new Map();
  for (const r of byDayModel) { totals.set(keyOf(r), (totals.get(keyOf(r)) || 0) + r.cost); }
  [...totals.entries()].sort((a, b) => b[1] - a[1]).forEach(([k]) => { const [provider, model] = k.split('\u0000'); series.push({ key: k, model, provider, color: SERIES_COLORS[series.length % SERIES_COLORS.length] }); });
  const cell = new Map(byDayModel.map((r) => [`${r.day}|${keyOf(r)}`, r.cost || 0]));
  const first = days[0].day; const n = Math.round((new Date(`${days[days.length - 1].day}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / 86400000) + 1;
  const all = Array.from({ length: n }, (_, i) => { const day = dayAdd(first, i); const d = days.find((x) => x.day === day); return { day, cost: d?.cost || 0, requests: d?.requests || 0, activeUsers: d?.activeUsers || 0 }; });
  const top = niceMax(Math.max(...all.map((d) => d.cost), 0));
  const x = (i) => m.l + (pw * (i + 0.5)) / n; const y = (v) => m.t + ph - (v / top) * ph;
  const bw = Math.min((pw / n) * 0.8, 28);
  // Least-squares line through (day index, total); needs two or more days.
  let trend = null;
  if (n > 1) {
    const mx = (n - 1) / 2; const my = all.reduce((a, d) => a + d.cost, 0) / n;
    const sxx = all.reduce((a, _, i) => a + (i - mx) ** 2, 0); const sxy = all.reduce((a, d, i) => a + (i - mx) * (d.cost - my), 0);
    const slope = sxy / sxx; const at = (i) => Math.max(0, Math.min(top, my + slope * (i - mx)));
    trend = { slope, x1: x(0), y1: y(at(0)), x2: x(n - 1), y2: y(at(n - 1)) };
  }
  const yTicks = [0, 1, 2, 3, 4].map((i) => (top * i) / 4);
  const step = Math.max(1, Math.ceil(n / 8)); const xTicks = all.map((d, i) => [d.day, i]).filter(([, i]) => i % step === 0);
  const label = `Daily spend by model, ${first} to ${all[n - 1].day}, highest day ${money(Math.max(...all.map((d) => d.cost)))}${trend ? `, trend ${trend.slope >= 0 ? 'rising' : 'falling'} by about ${money(Math.abs(trend.slope))} per day` : ''}`;
  return (
    <Box>
      <Box component="svg" role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} sx={{ width: '100%', height: 'auto', display: 'block', color: 'text.primary' }}>
        {yTicks.map((v) => <g key={v}><line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v ? 0.12 : 0.4} /><text x={m.l - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="currentColor" fillOpacity="0.7">{money(v)}</text></g>)}
        {all.map((d, i) => {
          let acc = 0;
          return (
            <Tooltip key={d.day} title={<>{d.day}: {money(d.cost)}, {num(d.requests)} requests, {num(d.activeUsers)} active user(s){series.filter((s) => cell.get(`${d.day}|${s.key}`)).map((s) => <div key={s.key}>{s.model}: {money(cell.get(`${d.day}|${s.key}`))}</div>)}</>}>
              <g>
                <rect x={x(i) - (pw / n) / 2} y={m.t} width={pw / n} height={ph} fill="transparent" />
                {series.map((s) => { const v = cell.get(`${d.day}|${s.key}`) || 0; if (!v) return null; const y0 = y(acc); acc += v; return <rect key={s.key} x={x(i) - bw / 2} y={y(acc)} width={bw} height={Math.max(y0 - y(acc), 1)} fill={s.color} />; })}
              </g>
            </Tooltip>);
        })}
        {trend && <line data-testid="trend-line" x1={trend.x1} y1={trend.y1} x2={trend.x2} y2={trend.y2} stroke="currentColor" strokeWidth="2" strokeDasharray="6 4" />}
        {xTicks.map(([d, i]) => <g key={d}><line x1={x(i)} x2={x(i)} y1={m.t + ph} y2={m.t + ph + 4} stroke="currentColor" strokeOpacity="0.4" /><text x={x(i)} y={m.t + ph + 17} textAnchor="middle" fontSize="11" fill="currentColor" fillOpacity="0.7">{d.slice(5)}</text></g>)}
        <text x={m.l + pw / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="currentColor" fillOpacity="0.8">Date (UTC)</text>
        <text transform={`translate(14 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="currentColor" fillOpacity="0.8">Spend per day (USD)</text>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 1 }}>
        {series.map((s) => <Box key={s.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: s.color }} /><Typography variant="caption">{s.model}{s.provider ? ` (${s.provider})` : ''}</Typography></Box>)}
        {trend && <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><Box component="svg" width="18" height="6" sx={{ color: 'text.primary' }}><line x1="0" x2="18" y1="3" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" /></Box><Typography variant="caption">Trend ({trend.slope >= 0 ? '+' : '−'}{money(Math.abs(trend.slope))}/day)</Typography></Box>}
      </Box>
    </Box>
  );
}

// Usage and spend for a date range. Cost = tokens × the model's $/1M-token prices at the time of each request (set under Server settings).
export default function Reports() {
  const { can } = useAuth();
  const [showCost, setShowCost] = useState(null); // whether users see each session's cost in their Sessions pane
  const canRead = can('settings.read');
  useEffect(() => { if (canRead) get('/api/admin/general').then((g) => setShowCost(!!g.showSessionCost)).catch(() => {}); }, [canRead]); // eslint-disable-line
  const toggleShowCost = async (v) => { setShowCost(v); try { await put('/api/admin/general', { showSessionCost: v }); } catch (e) { setShowCost(!v); setErr(errText(e)); } };
  const today = new Date();
  const [from, setFrom] = useState(dayStr(new Date(today.getTime() - 29 * 86400000))); const [to, setTo] = useState(dayStr(today));
  const [data, setData] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); get(`/api/reports/usage?from=${startOf(from)}&to=${startOf(to) + 86400}`).then(setData).catch((e) => setErr(errText(e))); }, [from, to]);
  useEffect(() => { load(); }, [load]);
  const preset = (n) => { const t = new Date(); setTo(dayStr(t)); setFrom(dayStr(new Date(t.getTime() - (n - 1) * 86400000))); };
  const max = Math.max(...(data?.byModel || []).map((r) => r.cost), 0);

  return (
    <Box sx={{ p: 3, maxWidth: CONTENT_MAX_WIDTH, width: '100%' }}>
      <Typography variant="h5" component="h1" gutterBottom>Reports</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>What is being spent on each model. Token counts come from the provider where it reports them, otherwise they are estimated (marked “est.”). Prices are set per model under Server settings.</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 2 }}>
        <TextField size="small" type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField size="small" type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        {PRESETS.map(([l, n]) => <Button key={n} size="small" onClick={() => preset(n)}>Last {l}</Button>)}
        <Button size="small" component="a" href={`/api/reports/usage.csv?from=${startOf(from)}&to=${startOf(to) + 86400}`} download>Download CSV</Button>
      </Box>
      {showCost !== null && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <FormControlLabel control={<Switch checked={showCost} disabled={!can('settings.write')} onChange={(e) => toggleShowCost(e.target.checked)} />} label="Show users what each session costs" />
          <Typography variant="caption" color="text.secondary" display="block">When on, each session's and chat's spend appears next to its token estimate in the Sessions pane and chat list. When off, users never see costs.</Typography>
        </Paper>)}
      {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
      {data?.unpriced?.length > 0 && <Alert severity="warning" sx={{ mb: 2 }}>No price set for: {data.unpriced.join(', ')}. Their usage is counted but costs $0 until you add prices under Server settings.</Alert>}
      {data && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, mb: 2 }}>
            <Stat label="Total spend" note={<Delta now={data.totals.cost} before={data.previous?.cost} />}><Typography variant="h5" data-testid="report-total">{money(data.totals.cost)}</Typography></Stat>
            <Stat label="Requests" note={<Delta now={data.totals.requests} before={data.previous?.requests} />}><Typography variant="h5">{num(data.totals.requests)}</Typography></Stat>
            <Stat label="Tokens (in / out)"><Typography variant="h5">{num(data.totals.inputTokens)} / {num(data.totals.outputTokens)}</Typography></Stat>
            <Stat label="Active users" note={<Delta now={data.totals.activeUsers} before={data.previous?.activeUsers} />}><Typography variant="h5">{num(data.totals.activeUsers)}</Typography></Stat>
            <Stat label="Avg cost per active user"><Typography variant="h5">{money(data.totals.activeUsers ? data.totals.cost / data.totals.activeUsers : 0)}</Typography></Stat>
            <Stat label="Avg cost per request"><Typography variant="h5">{money(data.totals.requests ? data.totals.cost / data.totals.requests : 0)}</Typography></Stat>
            {data.month && <Stat label="This month" note={<Typography variant="caption" color="text.secondary" display="block">projected {money(data.month.projected)} at the current pace</Typography>}><Typography variant="h5">{money(data.month.spent)}</Typography></Stat>}
          </Box>
          {data.totals.estimatedRequests > 0 && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>{pct(data.totals.estimatedRequests, data.totals.requests)}% of requests in this period have estimated token counts (the provider did not report them).</Typography>}
          {data.byDay?.length > 0 && <Box sx={{ mb: 3 }}><Typography variant="h6" gutterBottom>Spend by day</Typography><DailyChart days={data.byDay} byDayModel={data.byDayModel} /></Box>}
          <Typography variant="h6" gutterBottom>Spend by model</Typography>
          <Table size="small" aria-label="Spend by model">
            <TableHead><TableRow><TableCell>Model</TableCell><TableCell>Provider</TableCell><TableCell align="right">Requests</TableCell><TableCell align="right">Input tokens</TableCell><TableCell align="right">Output tokens</TableCell><TableCell align="right">Cost</TableCell><TableCell sx={{ width: '20%' }}>Share</TableCell></TableRow></TableHead>
            <TableBody>
              {data.byModel.map((r) => (
                <TableRow key={`${r.provider}-${r.model}`}>
                  <TableCell>{r.model}{r.estimatedRequests > 0 && <Chip size="small" variant="outlined" label={`${r.estimatedRequests} est.`} sx={{ ml: 1, height: 18, fontSize: 10 }} />}</TableCell>
                  <TableCell>{r.provider}</TableCell><TableCell align="right">{num(r.requests)}</TableCell><TableCell align="right">{num(r.inputTokens)}</TableCell><TableCell align="right">{num(r.outputTokens)}</TableCell>
                  <TableCell align="right">{money(r.cost)}</TableCell>
                  <TableCell><Box role="img" aria-label={`${data.totals.cost ? Math.round((r.cost / data.totals.cost) * 100) : 0}% of spend`} sx={{ height: 8, borderRadius: 1, bgcolor: 'primary.main', width: `${max ? (r.cost / max) * 100 : 0}%`, minWidth: r.cost ? 2 : 0 }} /></TableCell>
                </TableRow>))}
              {!data.byModel.length && <TableRow><TableCell colSpan={7}><Typography color="text.secondary" variant="body2">No usage in this period.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </Paper>)}
      {data && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6" gutterBottom>Spend by user</Typography>
          <Table size="small" aria-label="Spend by user">
            <TableHead><TableRow><TableCell>User</TableCell><TableCell>Models used</TableCell><TableCell align="right">Requests</TableCell><TableCell align="right">Input tokens</TableCell><TableCell align="right">Output tokens</TableCell><TableCell align="right">Cost</TableCell></TableRow></TableHead>
            <TableBody>
              {data.byUser.map((u) => (
                <TableRow key={u.userId ?? 'deleted'}>
                  <TableCell>{u.userId == null ? <em>Deleted user</em> : <>{u.name}{u.username && u.username !== u.name ? <Typography component="span" variant="caption" color="text.secondary"> ({u.username})</Typography> : null}</>}</TableCell>
                  <TableCell>{u.models?.split(',').join(', ')}</TableCell>
                  <TableCell align="right">{num(u.requests)}</TableCell><TableCell align="right">{num(u.inputTokens)}</TableCell><TableCell align="right">{num(u.outputTokens)}</TableCell><TableCell align="right">{money(u.cost)}</TableCell>
                </TableRow>))}
              {!data.byUser.length && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" variant="body2">No usage in this period.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </Paper>)}
      {data && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6" gutterBottom>Spend by activity</Typography>
          <Table size="small" aria-label="Spend by activity">
            <TableHead><TableRow><TableCell>Activity</TableCell><TableCell align="right">Requests</TableCell><TableCell align="right">Tokens</TableCell><TableCell align="right">Cost</TableCell><TableCell sx={{ width: '20%' }}>Share</TableCell></TableRow></TableHead>
            <TableBody>
              {(data.byKind || []).map((k) => <TableRow key={k.kind}><TableCell>{KINDS[k.kind] || k.kind}</TableCell><TableCell align="right">{num(k.requests)}</TableCell><TableCell align="right">{num(k.inputTokens + k.outputTokens)}</TableCell><TableCell align="right">{money(k.cost)}</TableCell><TableCell>{bar(k.cost, data.byKind[0].cost)}</TableCell></TableRow>)}
              {!data.byKind?.length && <TableRow><TableCell colSpan={5}><Typography color="text.secondary" variant="body2">No usage in this period.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </Paper>)}
      {data && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6" gutterBottom>Costliest sessions and chats</Typography>
          <Table size="small" aria-label="Costliest sessions">
            <TableHead><TableRow><TableCell>Title</TableCell><TableCell>Type</TableCell><TableCell>User</TableCell><TableCell align="right">Requests</TableCell><TableCell align="right">Tokens</TableCell><TableCell align="right">Cost</TableCell></TableRow></TableHead>
            <TableBody>
              {(data.topSessions || []).map((c) => <TableRow key={c.id}><TableCell>{c.title}</TableCell><TableCell>{c.kind}</TableCell><TableCell>{c.user}</TableCell><TableCell align="right">{num(c.requests)}</TableCell><TableCell align="right">{num(c.tokens)}</TableCell><TableCell align="right">{money(c.cost)}</TableCell></TableRow>)}
              {!data.topSessions?.length && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" variant="body2">No usage in this period.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </Paper>)}
    </Box>
  );
}
