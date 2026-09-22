// A temporary Auth failure (network, rate limit, server error) must never replace or erase the
// stored player identity; only an explicit server rejection may.
export function isTemporaryAuthStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export function isTransientAuthError(error: { status?: number } | null | undefined): boolean {
  return error != null && isTemporaryAuthStatus(error.status ?? 0);
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
