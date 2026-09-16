import assert from 'node:assert/strict';
import test from 'node:test';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { SolanaSignMessage } from '@solana/wallet-standard-features';
import { StandardConnect, StandardEvents } from '@wallet-standard/features';
import {
  compatibleSolanaWallets,
  watchSolanaWalletSession,
} from '../src/game/solanaWalletRegistry.ts';

const account = (address: string): WalletAccount => ({
  address,
  chains: ['solana:devnet'],
  features: [SolanaSignMessage],
  icon: 'data:image/png;base64,',
  label: 'Test',
  publicKey: new Uint8Array(32),
});

function wallet(name: string, accounts: readonly WalletAccount[], on?: (listener: (change: { accounts?: readonly WalletAccount[] }) => void) => void): Wallet {
  return {
    accounts,
    chains: ['solana:devnet'],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts }) },
      [SolanaSignMessage]: { version: '1.0.0', signMessage: async () => [] },
      ...(on ? { [StandardEvents]: { version: '1.0.0', on: (_event: 'change', listener: (change: { accounts?: readonly WalletAccount[] }) => void) => { on(listener); return () => undefined; } } } : {}),
    },
    icon: 'data:image/png;base64,',
    name,
    version: '1.0.0',
  } as Wallet;
}

test('discovers only Phantom through Wallet Standard', () => {
  const phantom = wallet('Phantom', [account('11111111111111111111111111111111')]);
  const solflare = wallet('Solflare', [account('11111111111111111111111111111112')]);
  const incompatible = { ...wallet('Other', []), chains: ['ethereum:1'], features: {} } as Wallet;
  assert.deepEqual(compatibleSolanaWallets([solflare, incompatible, phantom]).map((entry) => entry.name), ['Phantom']);
});

test('wallet account changes invalidate the bound session', () => {
  let listener: ((change: { accounts?: readonly WalletAccount[] }) => void) | undefined;
  let reason = '';
  const selected = wallet('Test', [account('11111111111111111111111111111111')], (value) => { listener = value; });
  const stop = watchSolanaWalletSession({
    accountId: '123e4567-e89b-42d3-a456-426614174088',
    authSubjectId: '123e4567-e89b-42d3-a456-426614174099',
    address: '11111111111111111111111111111111',
    expiresAt: '2099-01-01T00:00:00.000Z',
    token: `hlw_${'a'.repeat(43)}`,
    walletName: 'Test',
  }, selected, (value) => { reason = value; });
  listener?.({ accounts: [account('11111111111111111111111111111112')] });
  assert.equal(reason, 'account_change');
  reason = '';
  listener?.({ accounts: [account('11111111111111111111111111111111')] });
  assert.equal(reason, '');
  listener?.({ accounts: [] });
  assert.equal(reason, 'wallet_disconnect');
  stop();
});
