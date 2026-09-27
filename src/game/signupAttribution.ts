// Sign-up attribution (Founder decision 2026-09-27): the first landing visit
// that carries utm_source/utm_medium/utm_campaign, ref or promo is remembered
// in this browser for 30 days and sent once with account_register. Values are
// plain labels, never identities; the server re-validates them, writes them
// once per account and the Control Center only shows totals of five or more.
const storageKey = 'heroloop.signup-attribution.v1';
const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
const valuePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const fields = {
  utm_source: 'source',
  utm_medium: 'medium',
  utm_campaign: 'campaign',
  ref: 'ref',
  promo: 'promo',
} as const;

export type SignupAttribution = Partial<Record<(typeof fields)[keyof typeof fields], string>>;

function clean(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return valuePattern.test(normalized) ? normalized : null;
}

// First touch wins: a later link does not overwrite a remembered visit.
export function captureSignupAttribution(search: string = window.location.search): void {
  try {
    if (readSignupAttribution()) return;
    const params = new URLSearchParams(search);
    const captured: SignupAttribution = {};
    for (const [param, key] of Object.entries(fields)) {
      const value = clean(params.get(param));
      if (value) captured[key] = value;
    }
    if (Object.keys(captured).length === 0) return;
    window.localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), values: captured }));
  } catch {
    // Storage blocked: attribution is optional and registration must not depend on it.
  }
}

export function readSignupAttribution(): SignupAttribution | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; values?: unknown };
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > maxAgeMs || !parsed.values || typeof parsed.values !== 'object') {
      window.localStorage.removeItem(storageKey);
      return null;
    }
    const values: SignupAttribution = {};
    for (const key of Object.values(fields)) {
      const value = clean(typeof (parsed.values as Record<string, unknown>)[key] === 'string' ? (parsed.values as Record<string, string>)[key] : null);
      if (value) values[key] = value;
    }
    return Object.keys(values).length > 0 ? values : null;
  } catch {
    return null;
  }
}

export function clearSignupAttribution(): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Nothing to clear.
  }
}
