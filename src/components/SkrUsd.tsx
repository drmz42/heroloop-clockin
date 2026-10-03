// Thin USD hint shown next to every SKR price (Founder 2026-10-03). The SKR
// amount floats with the rate; the USD catalogue price is what the server charges.
function formatUsdHint(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(cents % 1 ? 3 : 2)}`;
}
export function SkrUsd({ cents }: { cents: number }) {
  return <small className="skr-usd ml-1 whitespace-nowrap text-[0.8em] font-normal tabular-nums opacity-60">≈{formatUsdHint(cents)}</small>;
}
