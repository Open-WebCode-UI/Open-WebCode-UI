import StarIcon from '@mui/icons-material/Star';
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';

// Fixed badge colors, independent of the branding theme (so "Blue" is always blue). Each has a light- and dark-mode set of text, fill and
// border chosen for readable contrast; the label is always shown, so color is never the only cue.
export const BADGE_COLORS = {
  gray: { name: 'Gray', light: ['#374151', '#f3f4f6', '#9ca3af'], dark: ['#d1d5db', 'rgba(156,163,175,0.16)', '#6b7280'] },
  blue: { name: 'Blue', light: ['#1d4ed8', '#eff6ff', '#60a5fa'], dark: ['#93c5fd', 'rgba(59,130,246,0.18)', '#3b82f6'] },
  purple: { name: 'Purple', light: ['#6d28d9', '#f5f3ff', '#a78bfa'], dark: ['#c4b5fd', 'rgba(139,92,246,0.18)', '#8b5cf6'] },
  teal: { name: 'Teal', light: ['#0f766e', '#f0fdfa', '#2dd4bf'], dark: ['#5eead4', 'rgba(20,184,166,0.18)', '#14b8a6'] },
  green: { name: 'Green', light: ['#15803d', '#f0fdf4', '#4ade80'], dark: ['#86efac', 'rgba(34,197,94,0.18)', '#22c55e'] },
  yellow: { name: 'Yellow', light: ['#854d0e', '#fefce8', '#facc15'], dark: ['#fde047', 'rgba(234,179,8,0.18)', '#eab308'] },
  orange: { name: 'Orange', light: ['#c2410c', '#fff7ed', '#fb923c'], dark: ['#fdba74', 'rgba(249,115,22,0.18)', '#f97316'] },
  red: { name: 'Red', light: ['#b91c1c', '#fef2f2', '#f87171'], dark: ['#fca5a5', 'rgba(239,68,68,0.18)', '#ef4444'] },
};

// Administrator-defined badges on a model (data classification tier, what the model is good at, ...). The tooltip carries the category
// and the description; the category is also part of the accessible name so it is not lost without hover.
export function BadgeChip({ badge, category = badge.category, featured }) {
  const name = `${category ? `${category}: ${badge.label}` : badge.label}${featured ? ' (featured)' : ''}`;
  const tip = [category, badge.description].filter(Boolean).join(' — ');
  const chip = (
    <Chip size="small" variant="outlined" label={badge.label} aria-label={name} icon={featured ? <StarIcon /> : undefined} data-color={BADGE_COLORS[badge.color] ? badge.color : 'gray'}
      sx={(t) => { const [color, bgcolor, borderColor] = (BADGE_COLORS[badge.color] || BADGE_COLORS.gray)[t.palette.mode === 'dark' ? 'dark' : 'light']; return { color, bgcolor, borderColor }; }} />);
  return tip ? <Tooltip title={tip} describeChild>{chip}</Tooltip> : chip;
}

// featuredId marks one badge with a star (admin lists only; the picker shows the featured badge on its own).
export default function ModelBadges({ badges, featuredId, sx }) {
  if (!badges?.length) return null;
  return <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap', ...sx }} aria-label="Badges" role="list">{badges.map((b) => <span key={b.id} role="listitem"><BadgeChip badge={b} featured={b.id === featuredId} /></span>)}</Stack>;
}

// All of a model's badges under their category's name (badges without a category last, under "Other").
export function GroupedBadges({ badges }) {
  if (!badges?.length) return null;
  const groups = new Map();
  for (const b of badges) { const k = b.category || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const ordered = [...groups].sort(([a], [b]) => (a === '') - (b === '')); // stable: categories keep the administrator's order
  return (
    <Stack spacing={0.75} sx={{ mt: 0.75 }}>
      {ordered.map(([cat, items]) => (
        <Box key={cat} component="section" aria-label={`${cat || 'Other'} badges`}>
          <Typography variant="caption" color="text.secondary" component="div">{cat || 'Other'}</Typography>
          <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap' }}>{items.map((b) => <BadgeChip key={b.id} badge={b} category={null} />)}</Stack>
        </Box>))}
    </Stack>
  );
}
