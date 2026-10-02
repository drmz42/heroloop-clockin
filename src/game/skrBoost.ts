import { skrPrice } from './skrPurchase';
import { SKR_BOOST_POLICY } from '../../selfhosted/api/skr_boost';
export { SKR_BOOST_POLICY } from '../../selfhosted/api/skr_boost';

export type SkrBoostStatus = {
  policy: typeof SKR_BOOST_POLICY;
  status: 'verified' | 'unavailable';
  activation_enabled: false;
  spend: { usd_cents: string; complete: boolean } | null;
  hold: { available_minor: string; required_minor: string | null; complete: boolean; rate_available: boolean } | null;
};

// Missing or stale data is unknown, never a completed task or a zero balance.
export function skrBoostTasks(status: SkrBoostStatus | null, rate: string | null = null) {
  const verified = status?.status === 'verified';
  return [
    { key: 'spend', label: `Spend ${skrPrice(1000, rate)}`, detail: 'Store buys, gear upgrades, rerolls, gacha and potions paid in SKR count. Marketplace trades do not.',
      done: verified && status.spend?.complete === true,
      progress: verified && status.spend ? `${skrPrice(Number(status.spend.usd_cents), rate)} / ${skrPrice(1000, rate)} at current rate` : 'Awaiting verified purchases',
      percent: verified && status.spend ? Math.min(100, Number(status.spend.usd_cents) / 10) : 0 },
    { key: 'hold', label: `Hold ${skrPrice(3000, rate)}`, detail: 'Keep SKR in your in-game account. Funds reserved for withdrawal do not count. The server checks the current SKR rate.',
      done: verified && status.hold?.complete === true,
      progress: verified && status.hold?.rate_available && status.hold.required_minor
        ? `${skrMinor(status.hold.available_minor)} / ${skrMinor(status.hold.required_minor)} SKR` : 'Awaiting verified balance and rate',
      percent: verified && status.hold?.rate_available && status.hold.required_minor
        ? Math.min(100, Number(status.hold.available_minor) / Number(status.hold.required_minor) * 100) : 0 },
  ];
}
function skrMinor(value: string) {
  const minor = BigInt(value);
  const fraction = (minor % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${minor / 1000000n}${fraction ? `.${fraction}` : ''}`;
}
