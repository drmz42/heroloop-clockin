import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

// Phantom's mobile in-app browser exposes window.phantom.solana but does not always
// register a Wallet Standard wallet, so the sign-in screen saw "no wallet". When the
// legacy provider is present and no standard Phantom registered itself, this adds a
// minimal standard wallet around it (connect + signMessage). Signing still goes through
// the same SIWS challenge and server verification as every other wallet.
type LegacyKey = { toBase58: () => string; toBytes?: () => Uint8Array };
type LegacyProvider = {
  isPhantom?: boolean;
  publicKey?: LegacyKey | null;
  connect: () => Promise<{ publicKey?: LegacyKey }>;
  signMessage: (message: Uint8Array, display?: 'utf8') => Promise<{ signature: Uint8Array; publicKey?: LegacyKey }>;
};

const CHAIN = 'solana:mainnet' as const;
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=' as const;

function legacyProvider(): LegacyProvider | null {
  const scope = window as unknown as { phantom?: { solana?: LegacyProvider } };
  const provider = scope.phantom?.solana;
  return provider?.isPhantom === true && typeof provider.connect === 'function' && typeof provider.signMessage === 'function' ? provider : null;
}

function accountFor(key: LegacyKey): WalletAccount {
  const publicKey = typeof key.toBytes === 'function' ? key.toBytes() : new Uint8Array();
  return Object.freeze({ address: key.toBase58(), publicKey, chains: [CHAIN], features: ['solana:signMessage' as const] });
}

export function registerInjectedPhantomFallback(delayMs = 1200) {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    const provider = legacyProvider();
    if (!provider) return;
    const registry = getWallets();
    if (registry.get().some((wallet) => wallet.name.trim().toLowerCase() === 'phantom')) return;
    let accounts: WalletAccount[] = provider.publicKey ? [accountFor(provider.publicKey)] : [];
    const wallet: Wallet = {
      version: '1.0.0',
      name: 'Phantom',
      icon: ICON,
      chains: [CHAIN],
      get accounts() { return accounts; },
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => {
            const result = await provider.connect();
            const key = result.publicKey ?? provider.publicKey;
            accounts = key ? [accountFor(key)] : [];
            return { accounts };
          },
        },
        'standard:events': { version: '1.0.0', on: () => () => undefined },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async ({ message }) => {
            const output = await provider.signMessage(message, 'utf8');
            return { signedMessage: message, signature: new Uint8Array(output.signature), signatureType: 'ed25519' as const };
          })),
        },
      },
    } as unknown as Wallet;
    registry.register(wallet);
  }, delayMs);
}
