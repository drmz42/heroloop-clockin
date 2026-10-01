import assert from 'node:assert/strict';
import test from 'node:test';
import type { Wallet } from '@wallet-standard/base';
import { allowMobileWalletAdapter, compatibleSolanaWallets } from '../src/game/solanaWalletRegistry';

const wallet = (name: string) => ({
  version: '1.0.0', name, icon: 'data:image/svg+xml;base64,', chains: ['solana:mainnet'], accounts: [],
  features: { 'standard:connect': {}, 'solana:signIn': {} },
}) as unknown as Wallet;

test('Mobile Wallet Adapter is accepted only after the Android layout allows it', () => {
  const list = [wallet('Phantom'), wallet('Mobile Wallet Adapter'), wallet('Other')];
  assert.deepEqual(compatibleSolanaWallets(list).map((entry) => entry.name), ['Phantom']);
  allowMobileWalletAdapter();
  assert.deepEqual(compatibleSolanaWallets(list).map((entry) => entry.name), ['Phantom', 'Mobile Wallet Adapter']);
});
