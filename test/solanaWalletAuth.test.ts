import assert from 'node:assert/strict';
import test from 'node:test';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { SolanaSignIn, SolanaSignMessage } from '@solana/wallet-standard-features';
import { StandardConnect } from '@wallet-standard/features';
import { createSolanaWalletProof, SolanaWalletAuthError } from '../src/game/solanaWalletAuth.ts';

const NOW = Date.parse('2026-09-13T00:00:00.000Z');
const ADDRESS = '11111111111111111111111111111111';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const MESSAGE = `test.invalid wants you to sign in with your Solana account:\n${ADDRESS}\n\nSigning is free, proves wallet ownership, moves no funds and costs no gas.\n\nURI: https://test.invalid/\nVersion: 1\nChain ID: solana:devnet\nNonce: abcdef0123456789abcdef0123456789\nIssued At: 2026-09-13T00:00:00.000Z\nExpiration Time: 2026-09-13T00:05:00.000Z\nRequest ID: ${REQUEST_ID}`;

function account(features: readonly string[] = [SolanaSignIn, SolanaSignMessage]): WalletAccount {
  return {
    address: ADDRESS,
    chains: ['solana:devnet'],
    features,
    publicKey: new Uint8Array(32),
  };
}

function challengeResponse(overrides: Record<string, unknown> = {}): Response {
  const body = {
    contract_version: 1,
    ok: true,
    request_id: '223e4567-e89b-42d3-a456-426614174000',
    result: {
      message: MESSAGE,
      signInInput: {
        address: ADDRESS,
        chainId: 'solana:devnet',
        domain: 'test.invalid',
        expirationTime: '2026-09-13T00:05:00.000Z',
        issuedAt: '2026-09-13T00:00:00.000Z',
        nonce: 'abcdef0123456789abcdef0123456789',
        requestId: REQUEST_ID,
        statement: 'Signing is free, proves wallet ownership, moves no funds and costs no gas.',
        uri: 'https://test.invalid/',
        version: '1',
      },
    },
    ...overrides,
  };
  return new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } });
}

function wallet(overrides: Record<string, unknown> = {}): Wallet {
  const selected = account();
  return {
    accounts: [],
    chains: ['solana:devnet'],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignIn]: {
        version: '1.0.0',
        signIn: async () => [{
          account: selected,
          signature: new Uint8Array(64).fill(7),
          signedMessage: new TextEncoder().encode(MESSAGE),
        }],
      },
      [SolanaSignMessage]: {
        version: '1.0.0',
        signMessage: async ({ message }: { message: Uint8Array }) => [{
          signature: new Uint8Array(64).fill(8),
          signedMessage: message,
        }],
      },
    },
    icon: 'data:image/png;base64,AA==',
    name: 'Test wallet',
    version: '1.0.0',
    ...overrides,
  } as Wallet;
}

const options = {
  challengeEndpoint: 'https://test.invalid/api/v1/auth/solana/challenge',
  fetch: async () => challengeResponse(),
  now: () => NOW,
};

async function rejectsCode(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof SolanaWalletAuthError && error.code === code);
}

test('prefers solana:signIn and returns a bounded server-verification payload', async () => {
  let input: unknown;
  const selected = account();
  const proof = await createSolanaWalletProof(wallet({
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignIn]: {
        version: '1.0.0',
        signIn: async (value: unknown) => {
          input = value;
          return [{ account: selected, signature: new Uint8Array(64), signedMessage: new TextEncoder().encode(MESSAGE) }];
        },
      },
    },
  }), options);
  assert.equal((input as { requestId: string }).requestId, REQUEST_ID);
  assert.equal(proof.method, SolanaSignIn);
  assert.equal(proof.address, ADDRESS);
  assert.equal(proof.request_id, REQUEST_ID);
  assert.equal(proof.signature_type, 'ed25519');
  assert.equal(Object.keys(proof).sort().join(','), 'address,method,public_key,request_id,signature,signature_type,signed_message');
});

test('falls back to the identical canonical message through solana:signMessage', async () => {
  let signed = '';
  const selected = account([SolanaSignMessage]);
  const proof = await createSolanaWalletProof(wallet({
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignMessage]: {
        version: '1.0.0',
        signMessage: async ({ message }: { message: Uint8Array }) => {
          signed = new TextDecoder().decode(message);
          return [{ signature: new Uint8Array(64), signedMessage: message }];
        },
      },
    },
  }), options);
  assert.equal(signed, MESSAGE);
  assert.equal(proof.method, SolanaSignMessage);
});

test('falls back to signMessage when Phantom signIn fails technically after approval', async () => {
  let fallbackCalls = 0;
  const selected = account([SolanaSignIn, SolanaSignMessage]);
  const signInFeature = {
    version: '1.0.0',
    async signIn(this: unknown) {
      assert.equal(this, signInFeature);
      throw new Error('provider response unavailable');
    },
  };
  const signMessageFeature = {
    version: '1.0.0',
    async signMessage(this: unknown, { message }: { message: Uint8Array }) {
      assert.equal(this, signMessageFeature);
      fallbackCalls += 1;
      return [{ signature: new Uint8Array(64), signedMessage: message }];
    },
  };
  const proof = await createSolanaWalletProof(wallet({
    accounts: [selected],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignIn]: signInFeature,
      [SolanaSignMessage]: signMessageFeature,
    },
  }), options);
  assert.equal(fallbackCalls, 1);
  assert.equal(proof.method, SolanaSignMessage);
});

test('uses the address-matched Phantom provider when its Wallet Standard signMessage bridge fails', async () => {
  let providerCalls = 0;
  const selected = account([SolanaSignMessage]);
  const proof = await createSolanaWalletProof(wallet({
    name: 'Phantom',
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignMessage]: {
        version: '1.0.0',
        signMessage: async () => { throw new Error('Wallet Standard bridge unavailable'); },
      },
    },
  }), {
    ...options,
    phantomProvider: {
      isPhantom: true,
      publicKey: { toBase58: () => ADDRESS },
      signMessage: async (message, display) => {
        providerCalls += 1;
        assert.equal(display, 'utf8');
        return {
          publicKey: { toBase58: () => ADDRESS },
          signature: new Uint8Array(64),
        };
      },
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(proof.method, SolanaSignMessage);
  assert.equal(Buffer.from(proof.signed_message, 'base64').toString(), MESSAGE);
});

test('never uses an injected Phantom provider for a different connected address', async () => {
  let providerCalls = 0;
  const selected = account([SolanaSignMessage]);
  await rejectsCode(() => createSolanaWalletProof(wallet({
    name: 'Phantom',
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignMessage]: {
        version: '1.0.0',
        signMessage: async () => { throw new Error('Wallet Standard bridge unavailable'); },
      },
    },
  }), {
    ...options,
    phantomProvider: {
      isPhantom: true,
      publicKey: { toBase58: () => 'SysvarRent111111111111111111111111111111111' },
      signMessage: async () => { providerCalls += 1; return { signature: new Uint8Array(64) }; },
    },
  }), 'wallet_sign_message_unavailable');
  assert.equal(providerCalls, 0);
});

test('uses wallet-level Phantom signIn with the refreshed account', async () => {
  let connectCalls = 0;
  let signInCalls = 0;
  let signMessageCalls = 0;
  const stale = account([SolanaSignIn]);
  const refreshed = account([SolanaSignMessage]);
  const proof = await createSolanaWalletProof(wallet({
    accounts: [stale],
    features: {
      [StandardConnect]: {
        version: '1.0.0',
        connect: async () => {
          connectCalls += 1;
          return { accounts: [refreshed] };
        },
      },
      [SolanaSignIn]: {
        version: '1.0.0',
        signIn: async () => {
          signInCalls += 1;
          return [{
            account: refreshed,
            signature: new Uint8Array(64),
            signedMessage: new TextEncoder().encode(MESSAGE),
          }];
        },
      },
      [SolanaSignMessage]: {
        version: '1.0.0',
        signMessage: async ({ message }: { message: Uint8Array }) => {
          signMessageCalls += 1;
          return [{ signature: new Uint8Array(64), signedMessage: message }];
        },
      },
    },
  }), options);
  assert.equal(connectCalls, 1);
  assert.equal(signInCalls, 1);
  assert.equal(signMessageCalls, 0);
  assert.equal(proof.method, SolanaSignIn);
});

test('never invokes transaction-only features for login', async () => {
  let fetched = false;
  await rejectsCode(() => createSolanaWalletProof(wallet({
    accounts: [account(['solana:signTransaction'])],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [account(['solana:signTransaction'])] }) },
      'solana:signTransaction': { version: '1.0.0', signTransaction: () => assert.fail('transaction requested') },
    },
  }), { ...options, fetch: async () => { fetched = true; return challengeResponse(); } }), 'wallet_signing_unsupported');
  assert.equal(fetched, false);
});

test('rejects a signIn account mismatch', async () => {
  const selected = account([SolanaSignIn]);
  const other = { ...selected, address: 'SysvarRent111111111111111111111111111111111' };
  await rejectsCode(() => createSolanaWalletProof(wallet({
    accounts: [selected],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignIn]: { version: '1.0.0', signIn: async () => [{ account: other, signature: new Uint8Array(64), signedMessage: new TextEncoder().encode(MESSAGE) }] },
    },
  }), options), 'wallet_proof_invalid');
});

test('rejects modified signed bytes and malformed server challenges', async () => {
  const selected = account([SolanaSignMessage]);
  await rejectsCode(() => createSolanaWalletProof(wallet({
    accounts: [selected],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignMessage]: { version: '1.0.0', signMessage: async () => [{ signature: new Uint8Array(64), signedMessage: new Uint8Array([1]) }] },
    },
  }), options), 'wallet_proof_invalid');
  await rejectsCode(() => createSolanaWalletProof(wallet(), {
    ...options,
    fetch: async () => challengeResponse({ result: { message: 'changed', signInInput: {} } }),
  }), 'invalid_challenge');
});

test('requires explicit selection when a wallet exposes multiple Solana accounts', async () => {
  const second = { ...account(), address: 'SysvarRent111111111111111111111111111111111' };
  const first = account();
  await rejectsCode(() => createSolanaWalletProof(wallet({
    accounts: [first, second],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [first, second] }) },
      [SolanaSignIn]: { version: '1.0.0', signIn: async () => [] },
    },
  }), options), 'wallet_account_selection_required');
});

test('maps rate limiting and rejected signing to bounded errors', async () => {
  await rejectsCode(() => createSolanaWalletProof(wallet(), {
    ...options,
    fetch: async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
  }), 'challenge_rate_limited');
  const selected = account([SolanaSignIn, SolanaSignMessage]);
  let fallbackCalls = 0;
  await rejectsCode(() => createSolanaWalletProof(wallet({
    accounts: [selected],
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async () => ({ accounts: [selected] }) },
      [SolanaSignIn]: { version: '1.0.0', signIn: async () => { throw Object.assign(new Error('User rejected request'), { code: 4001 }); } },
      [SolanaSignMessage]: {
        version: '1.0.0',
        signMessage: async () => { fallbackCalls += 1; return []; },
      },
    },
  }), options), 'wallet_signature_rejected');
  assert.equal(fallbackCalls, 0);
});
