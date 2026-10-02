// Founder decision 2026-10-02: player-visible numbers group thousands with a space
// (3 172, 1 000). A no-break space keeps a number on one line.
const GROUP = ' ';

export function groupNumber(value: number): string {
  return Math.trunc(value).toLocaleString('en-US').replace(/,/g, GROUP);
}

// Display-only: rewrites comma-grouped numbers inside existing text such as saved quest labels.
export function groupDigits(text: string): string {
  return text.replace(/(\d),(?=\d{3}\b)/g, `$1${GROUP}`);
}
