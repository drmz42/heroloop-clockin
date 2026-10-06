// Founder decision 2026-10-02: player-visible numbers group thousands with a space
// (3 172, 1 000). A no-break space keeps a number on one line.
const GROUP = ' ';
const SUFFIXES = ['', 'k', 'm', 'b', 't', 'qa', 'qi', 'sx', 'sp', 'oc', 'no', 'dc'];

export function groupNumber(value: number): string {
  return Math.trunc(value).toLocaleString('en-US').replace(/,/g, GROUP);
}

// Display-only: rewrites comma-grouped numbers inside existing text such as saved quest labels.
export function groupDigits(text: string): string {
  return text.replace(/(\d),(?=\d{3}\b)/g, `$1${GROUP}`);
}

/** Founder 2026-10-06: whole numbers stay grouped in full up to `maxDigits` digits; longer ones keep
 * `significant` digits with a k/m/b/t suffix (5.56k, 9.991m, 99.99b). Digits are cut, never rounded
 * up, so a balance never reads higher than it is and 999 999 shows as 999.9k rather than 1000k. */
export function compactNumber(value: number, maxDigits = 3, significant = 4): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const whole = Math.trunc(Math.abs(value));
  if (whole < 10 ** maxDigits) return sign + groupNumber(whole);
  const digits = whole < 1e21 ? String(whole).length : Math.floor(Math.log10(whole)) + 1;
  const tier = Math.min(Math.floor((digits - 1) / 3), SUFFIXES.length - 1);
  const scaled = whole / 1000 ** tier;
  const decimals = Math.max(0, significant - (scaled >= 100 ? 3 : scaled >= 10 ? 2 : 1));
  const text = (Math.floor(scaled * 10 ** decimals + 1e-9) / 10 ** decimals).toFixed(decimals);
  return `${sign}${decimals ? text.replace(/\.?0+$/, '') : text}${SUFFIXES[tier]}`;
}
