// Listing prices remain integer USD cents on the server. Round the SKR input
// up to that price step; the server quote confirms the final payable amount.
export function skrListingPriceCents(value: string, rate: string | null): number {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(value) || !rate || !/^\d+$/.test(rate) || BigInt(rate) <= 0n) return 0;
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const cents = (minor * BigInt(rate) + 9_999_999_999n) / 10_000_000_000n;
  return cents > 0n && cents <= 1_000_000_000n ? Number(cents) : 0;
}
