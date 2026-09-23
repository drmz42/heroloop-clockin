import { getWallets } from '@wallet-standard/app';
import type { Wallet } from '@wallet-standard/base';
import { SolanaSignIn, SolanaSignMessage } from '@solana/wallet-standard-features';
import { StandardConnect, StandardEvents, type StandardEventsFeature } from '@wallet-standard/features';

function hasFeature(wallet: Wallet, name: `${string}:${string}`): boolean {
  return typeof wallet.features[name] === 'object';
}

export function compatibleSolanaWallets(wallets: readonly Wallet[] = getWallets().get()): readonly Wallet[] {
  return wallets.filter((wallet) =>
    wallet.name.trim().toLowerCase() === 'phantom' &&
    hasFeature(wallet, StandardConnect) &&
    (hasFeature(wallet, SolanaSignIn) || hasFeature(wallet, SolanaSignMessage)) &&
    (wallet.chains.some((chain) => chain.startsWith('solana:')) ||
      wallet.accounts.some((account) => account.chains.some((chain) => chain.startsWith('solana:'))))
  ).sort((left, right) => left.name.localeCompare(right.name));
}

export function observeCompatibleSolanaWallets(listener: (wallets: readonly Wallet[]) => void): () => void {
  const registry = getWallets();
  const publish = () => listener(compatibleSolanaWallets(registry.get()));
  publish();
  const offRegister = registry.on('register', publish);
  const offUnregister = registry.on('unregister', publish);
  return () => { offRegister(); offUnregister(); };
}

const WALLET_REGISTRATION_GRACE_MS = 1500;

// On a plain reload the app's first synchronous read can run before the wallet
// extension's content script has finished its Wallet Standard register handshake,
// so a same-instant miss is not proof the wallet is gone - only observeCompatibleSolanaWallets'
// register event is. Waits only for the real registry; an explicit wallet list (tests,
// or a caller that already resolved one) is read synchronously and never waited on.
export function awaitCompatibleSolanaWallets(
  matches: (wallets: readonly Wallet[]) => boolean,
  explicitWallets?: readonly Wallet[],
): Promise<readonly Wallet[]> {
  const immediate = compatibleSolanaWallets(explicitWallets);
  if (explicitWallets || matches(immediate)) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let stop: () => void = () => undefined;
    const timer = setTimeout(() => { stop(); resolve(compatibleSolanaWallets()); }, WALLET_REGISTRATION_GRACE_MS);
    stop = observeCompatibleSolanaWallets((wallets) => {
      if (!matches(wallets)) return;
      clearTimeout(timer);
      stop();
      resolve(wallets);
    });
  });
}

export function watchSolanaWalletSession(
  session: { address: string },
  wallet: Wallet,
  onInvalid: (reason: 'wallet_disconnect' | 'account_change') => void,
): () => void {
  const events = wallet.features[StandardEvents] as StandardEventsFeature[typeof StandardEvents] | undefined;
  if (!events?.on) return () => undefined;
  return events.on('change', ({ accounts }) => {
    if (!accounts) return;
    const stillPresent = accounts.some((account) => account.address === session.address);
    if (!stillPresent) onInvalid(accounts.length > 0 ? 'account_change' : 'wallet_disconnect');
  });
}
