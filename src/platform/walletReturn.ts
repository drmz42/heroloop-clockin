// Some wallets close without answering Mobile Wallet Adapter when the player cancels the
// fingerprint/PIN unlock (Founder test 2026-10-08): the request then never settles and the
// sign-in or payment overlay blocks the game. Once the game is back in front after the wallet,
// an unanswered request is treated as cancelled after a short grace period. Browsers report the
// return through visibilitychange; the Android app keeps the page "visible" during a wallet round
// trip (so the session stays alive) and dispatches WALLET_RETURN_EVENT instead (APK 24+).

export const WALLET_RETURN_EVENT = 'hl-wallet-return';

export const WALLET_RETURN_GRACE_MS = 10_000;

export function withWalletReturnGrace<T>(request: Promise<T>, graceMs = WALLET_RETURN_GRACE_MS): Promise<T> {
  if (typeof document === 'undefined') return request;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let onVisibility: (() => void) | undefined;
  let onReturn: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    let left = document.visibilityState === 'hidden';
    const arm = () => {
      clearTimeout(grace);
      grace = setTimeout(() => reject(Object.assign(new Error('Wallet closed without an answer (cancelled)'), { code: 4001 })), graceMs);
    };
    onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(grace);
        left = true;
      } else if (left) {
        arm();
      }
    };
    onReturn = arm;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(WALLET_RETURN_EVENT, onReturn);
  });
  return Promise.race([request, cancelled]).finally(() => {
    clearTimeout(grace);
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    if (onReturn) window.removeEventListener(WALLET_RETURN_EVENT, onReturn);
  });
}
