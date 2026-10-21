import { createTheme } from '@mui/material/styles';

export const DEFAULT_BRANDING = {
  primaryColor: '#3f51b5', secondaryColor: '#009688', colorMode: 'manual', primaryColorDark: '#8c9eff', secondaryColorLight: '#00796b',
  buttonTextLight: '#ffffff', buttonTextDark: '#000000', backgroundColor: '#f5f6fa', surfaceColor: '#ffffff',
  defaultMode: 'system', fontFamily: 'Roboto, "Helvetica Neue", Arial, sans-serif', borderRadius: 8, density: 'comfortable', monacoTheme: 'system',
};

// Builds the MUI theme from the administrator's branding settings (served via /api/public-config).
export const deviceMode = () => { try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; } };
// 'system' (the device setting) resolves to light or dark.
export const resolveMode = (mode) => (mode === 'light' || mode === 'dark' ? mode : deviceMode());
// The code editor follows the app's resolved mode unless the administrator pinned a specific editor theme.
export const resolveMonaco = (setting, mode) => (['vs', 'vs-dark', 'hc-black'].includes(setting) ? setting : mode === 'dark' ? 'vs-dark' : 'vs');

// WCAG relative luminance and contrast ratio of two #rrggbb colors.
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a, b) => { if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return 0; const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const MIN_CONTRAST = 4;

// Auto color mode: pre-fill the other brand colors from the primary color (the administrator can then edit them).
const DARK_BACKGROUNDS = ['#121317', '#1c1e24'];
const toHsl = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, s, l];
};
const fromHsl = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return `#${[0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0')).join('')}`;
};
// Moves the color's lightness (darker or lighter) in small steps until it reaches `min` contrast on every background.
function readableOn(color, backgrounds, dir, min = 4.5) {
  const [h, s, l0] = toHsl(color);
  for (let l = l0; l >= 0 && l <= 1; l += dir * 0.01) {
    const c = fromHsl(h, s, l);
    if (backgrounds.every((bg) => contrast(c, bg) >= min)) return c;
  }
  return dir > 0 ? '#ffffff' : '#000000';
}
const bestText = (bg) => (contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000');
export function deriveColors(primary, backgrounds = ['#ffffff']) {
  const [h, s, l] = toHsl(primary);
  const accent = fromHsl((h + 150) % 360, Math.max(s, 0.4), Math.min(Math.max(l, 0.35), 0.6)); // split-complement of the primary
  const primaryDark = readableOn(primary, DARK_BACKGROUNDS, 1);
  return {
    primaryColorDark: primaryDark, secondaryColorLight: readableOn(accent, backgrounds, -1), secondaryColor: readableOn(accent, DARK_BACKGROUNDS, 1),
    buttonTextLight: bestText(primary), buttonTextDark: bestText(primaryDark),
  };
}
// The fields auto mode derives from, and the ones it fills in.
export const AUTO_SOURCES = ['primaryColor', 'backgroundColor', 'surfaceColor'];
export const autoFill = (b) => (/^#[0-9a-f]{6}$/i.test(b.primaryColor) ? deriveColors(b.primaryColor, [b.backgroundColor, b.surfaceColor].filter((c) => /^#[0-9a-f]{6}$/i.test(c))) : {});

export const DEFAULT_A11Y = { fontScale: 100, reduceMotion: false, highContrast: false, underlineLinks: false };

// a11y = the user's accessibility preferences (see server/src/preferences.js).
export function buildTheme(b = DEFAULT_BRANDING, modeSetting = b.defaultMode, a11y = DEFAULT_A11Y) {
  const mode = resolveMode(modeSetting);
  const dark = mode === 'dark';
  const hc = !!a11y.highContrast;
  const scale = [100, 115, 130, 150].includes(a11y.fontScale) ? a11y.fontScale : 100;
  return createTheme({
    palette: {
      mode,
      // Dark mode has its own primary and light mode its own secondary so each stays readable on its background; contrastText is the button text color.
      primary: { main: (dark && b.primaryColorDark) || b.primaryColor, contrastText: (dark ? b.buttonTextDark : b.buttonTextLight) || undefined },
      secondary: { main: (!dark && b.secondaryColorLight) || b.secondaryColor, contrastText: (dark ? b.buttonTextDark : b.buttonTextLight) || undefined },
      background: dark ? { default: '#121317', paper: '#1c1e24' } : { default: b.backgroundColor, paper: b.surfaceColor },
      ...(hc ? {
        // Maximum-contrast text and borders; contrastThreshold makes MUI pick the readable text color on brand colors.
        contrastThreshold: 7,
        text: dark ? { primary: '#ffffff', secondary: '#f0f0f0', disabled: '#d0d0d0' } : { primary: '#000000', secondary: '#1a1a1a', disabled: '#4d4d4d' },
        divider: dark ? '#ffffff' : '#000000',
      } : {}),
    },
    shape: { borderRadius: b.borderRadius },
    typography: { fontFamily: b.fontFamily, fontSize: (14 * scale) / 100 },
    // Reduced motion removes MUI transitions and ripples; the global rule in A11yStyles covers everything else.
    ...(a11y.reduceMotion ? { transitions: { create: () => 'none' } } : {}),
    components: {
      ...(b.density === 'compact' ? {
        MuiButton: { defaultProps: { size: 'small' } }, MuiTextField: { defaultProps: { size: 'small', margin: 'dense' } },
        MuiTable: { defaultProps: { size: 'small' } },
      } : {}),
      ...(a11y.reduceMotion ? { MuiButtonBase: { defaultProps: { disableRipple: true } } } : {}),
      ...(a11y.underlineLinks ? { MuiLink: { defaultProps: { underline: 'always' } } } : {}),
      ...(hc ? { MuiOutlinedInput: { styleOverrides: { notchedOutline: { borderColor: dark ? '#ffffff' : '#000000' } } } } : {}),
    },
  });
}
