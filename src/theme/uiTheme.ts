// Visual theme switch. "premium" is the Figma HL-LANDING-2 dark-fantasy skin; "classic" is the
// previous look. 2026-09-29 Founder swap: premium is the default in the normal Staging build (or with
// VITE_UI_THEME=premium); staging2 now keeps classic as the backup copy and Production stays classic
// until a separately approved release. Instant per-browser rollback: add ?ui=classic
// to any URL (or ?ui=premium to return); the choice is remembered in localStorage.
export type UiTheme = 'premium' | 'classic';

const STORAGE_KEY = 'heroloop-ui-theme';
const isTheme = (value: unknown): value is UiTheme => value === 'premium' || value === 'classic';

export const defaultUiTheme: UiTheme =
  import.meta.env.VITE_UI_THEME === 'premium' || import.meta.env.MODE === 'staging' ? 'premium' : 'classic';

export function resolveUiTheme(): UiTheme {
  try {
    const requested = new URLSearchParams(window.location.search).get('ui');
    if (isTheme(requested)) {
      window.localStorage.setItem(STORAGE_KEY, requested);
      return requested;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch {
    // Storage can be blocked; fall back to the build default.
  }
  return defaultUiTheme;
}

export function applyUiTheme(theme: UiTheme) {
  document.documentElement.dataset.hlTheme = theme;
}

export function setUiTheme(theme: UiTheme) {
  try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* reload still applies the URL choice */ }
  const url = new URL(window.location.href);
  url.searchParams.set('ui', theme);
  window.location.replace(url.toString());
}
