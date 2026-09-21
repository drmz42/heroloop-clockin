import assert from 'node:assert/strict';
import test from 'node:test';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  clearWalletBinding,
  readWalletBinding,
  walletBindingRestorable,
  writeWalletBinding,
  type WalletBinding,
} from '../src/game/solanaWalletBinding.ts';

const ADDRESS = '11111111111111111111111111111112';
const BINDING: WalletBinding = {
  accountId: '123e4567-e89b-42d3-a456-426614174000',
  address: ADDRESS,
  authSubjectId: '223e4567-e89b-42d3-a456-426614174001',
  walletName: 'Phantom',
};

function memoryStore(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

const wallet = (name: string, address: string): Wallet => ({
  version: '1.0.0',
  name,
  icon: 'data:image/png;base64,',
  chains: ['solana:mainnet'],
  features: {},
  accounts: [{ address, chains: ['solana:mainnet'], features: [], publicKey: new Uint8Array(32) } as WalletAccount],
});

test('stores only a non-secret wallet binding and can clear it', () => {
  const store = memoryStore();
  writeWalletBinding(BINDING, store);
  assert.deepEqual(readWalletBinding(store), BINDING);
  assert.deepEqual(Object.keys(JSON.parse(store.getItem('heroloop.siws.wallet-binding.v1')!)).sort(), ['accountId', 'address', 'authSubjectId', 'walletName']);
  clearWalletBinding(store);
  assert.equal(readWalletBinding(store), null);
});

test('rejects malformed or tampered bindings', () => {
  const store = memoryStore();
  store.setItem('heroloop.siws.wallet-binding.v1', JSON.stringify({ ...BINDING, address: 'not-an-address' }));
  assert.equal(readWalletBinding(store), null);
  store.setItem('heroloop.siws.wallet-binding.v1', '{"accountId":');
  assert.equal(readWalletBinding(store), null);
  assert.equal(readWalletBinding(null), null);
});

test('restores only for the same non-anonymous account and still-exposed wallet', () => {
  const session = { user: { id: BINDING.authSubjectId, is_anonymous: false } };
  assert.equal(walletBindingRestorable(BINDING, session, [wallet('Phantom', ADDRESS)]), true);
  assert.equal(walletBindingRestorable(BINDING, null, [wallet('Phantom', ADDRESS)]), false);
  assert.equal(walletBindingRestorable(BINDING, { user: { id: BINDING.authSubjectId, is_anonymous: true } }, [wallet('Phantom', ADDRESS)]), false);
  assert.equal(walletBindingRestorable(BINDING, { user: { id: '323e4567-e89b-42d3-a456-426614174002' } }, [wallet('Phantom', ADDRESS)]), false);
  assert.equal(walletBindingRestorable(BINDING, session, [wallet('Phantom', '11111111111111111111111111111113')]), false);
  assert.equal(walletBindingRestorable(BINDING, session, [wallet('Solflare', ADDRESS)]), false);
  assert.equal(walletBindingRestorable(BINDING, session, []), false);
});
