// A temporary Auth failure (network, rate limit, server error) must never replace or erase the
// stored player identity; only an explicit server rejection may.
export function isTemporaryAuthStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

// A missing status (e.g. auth-js's AuthUnknownError, thrown for an unexpected internal fault) is
// deliberately NOT transient: treating an unidentified error as always-retryable could strand a
// player on Retry forever. Only a status auth-js itself attached counts.
export function isTransientAuthError(error: { status?: number } | null | undefined): boolean {
  return error != null && typeof error.status === 'number' && isTemporaryAuthStatus(error.status);
}

const AUTH_TRANSIENT = Symbol('auth-transient');
export type AuthTransient = typeof AUTH_TRANSIENT;

// Runs one Auth SDK call and normalizes both ways it can signal a temporary failure - a rejected
// promise (e.g. a storage write throwing under an internal token refresh) and a resolved
// {data, error} with a transient status - into the same AUTH_TRANSIENT signal, so every caller
// branches on it once instead of re-deriving "did this actually fail permanently" each time.
export async function runAuthCall<T extends { error: { status?: number } | null }>(
  run: () => Promise<T>,
): Promise<T | AuthTransient> {
  let result: T;
  try {
    result = await run();
  } catch {
    return AUTH_TRANSIENT;
  }
  return isTransientAuthError(result.error) ? AUTH_TRANSIENT : result;
}

export function isAuthTransient(value: unknown): value is AuthTransient {
  return value === AUTH_TRANSIENT;
}

// auth-js keeps the stored session after a failed refresh only for network errors and 502/503/504;
// any other failure deletes it. Present every temporary status as 503 so the session survives.
export const authFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  const { status } = response;
  if (status !== 429 && (status < 500 || status === 502 || status === 503 || status === 504)) return response;
  await response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: 503, statusText: 'Service Unavailable' });
};
