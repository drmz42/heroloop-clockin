import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  SolanaSignIn,
  SolanaSignMessage,
  type SolanaSignInFeature,
  type SolanaSignInInput,
  type SolanaSignInOutput,
  type SolanaSignMessageFeature,
  type SolanaSignMessageOutput,
} from '@solana/wallet-standard-features';
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features';

const MAX_CHALLENGE_BYTES = 8_192;
const MAX_CLOCK_SKEW_MS = 30_000;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const SIWS_STATEMENT = 'Signing is free, proves wallet ownership, moves no funds and costs no gas.';
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ConnectApi = StandardConnectFeature[typeof StandardConnect];
type SignInApi = SolanaSignInFeature[typeof SolanaSignIn];
type SignMessageApi = SolanaSignMessageFeature[typeof SolanaSignMessage];

type SiwsSignInInput = Required<Omit<SolanaSignInInput, 'notBefore' | 'resources' | 'useOffchainMessage'>>;

type Challenge = {
  message: string;
  signInInput: SiwsSignInInput;
};

export type SolanaWalletProof = {
  address: string;
  method: typeof SolanaSignIn | typeof SolanaSignMessage;
  public_key: string;
  request_id: string;
  signature: string;
  signature_type: 'ed25519';
  signed_message: string;
};

export type SolanaWalletAuthOptions = {
  accountAddress?: string;
  challengeEndpoint: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

export class SolanaWalletAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'SolanaWalletAuthError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new SolanaWalletAuthError(code);
}

function feature<T>(wallet: Wallet, name: `${string}:${string}`): T | null {
  const value = wallet.features[name];
  return value && typeof value === 'object' ? value as T : null;
}

function isUsableAccount(account: WalletAccount): boolean {
  return BASE58_ADDRESS.test(account.address) && account.publicKey.length === 32 &&
    account.chains.some((chain) => chain.startsWith('solana:'));
}

function chooseAccount(accounts: readonly WalletAccount[], requested?: string): WalletAccount {
  const usable = accounts.filter(isUsableAccount);
  if (requested) {
    const exact = usable.find((account) => account.address === requested);
    return exact ?? fail('wallet_account_unavailable');
  }
  if (usable.length === 0) fail('wallet_account_unavailable');
  if (usable.length !== 1) fail('wallet_account_selection_required');
  return usable[0];
}

async function authorizeAccount(wallet: Wallet, requested?: string): Promise<WalletAccount> {
  const connect = feature<ConnectApi>(wallet, StandardConnect)?.connect;
  if (typeof connect !== 'function') fail('wallet_connect_unsupported');
  const current = wallet.accounts.filter(isUsableAccount);
  if (current.length > 0) return chooseAccount(current, requested);
  let accounts: readonly WalletAccount[];
  try {
    ({ accounts } = await connect());
  } catch {
    return fail('wallet_connect_rejected');
  }
  return chooseAccount(accounts, requested);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function canonicalMessage(input: SiwsSignInInput): string {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: ${input.version}\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}\nRequest ID: ${input.requestId}`;
}

function parseChallenge(value: unknown, address: string, now: number): Challenge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_challenge');
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== true || envelope.contract_version !== 1 || !envelope.result ||
    typeof envelope.result !== 'object' || Array.isArray(envelope.result)) fail('invalid_challenge');
  const result = envelope.result as Record<string, unknown>;
  if (!hasExactKeys(result, ['message', 'signInInput']) || typeof result.message !== 'string' ||
    !result.signInInput || typeof result.signInInput !== 'object' || Array.isArray(result.signInInput)) {
    fail('invalid_challenge');
  }
  const rawInput = result.signInInput as Record<string, unknown>;
  const keys = ['address', 'chainId', 'domain', 'expirationTime', 'issuedAt', 'nonce', 'requestId', 'statement', 'uri', 'version'];
  if (!hasExactKeys(rawInput, keys) || keys.some((key) => typeof rawInput[key] !== 'string')) fail('invalid_challenge');
  const input = rawInput as SiwsSignInInput;
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expirationTime);
  let uri: URL;
  try {
    uri = new URL(input.uri);
  } catch {
    return fail('invalid_challenge');
  }
  if (input.address !== address || input.version !== '1' || !UUID_V4.test(input.requestId) ||
    !/^[0-9a-f]{32}$/.test(input.nonce) || input.statement !== SIWS_STATEMENT || !input.chainId.startsWith('solana:') ||
    uri.protocol !== 'https:' || uri.host !== input.domain || !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) || issuedAt > now + MAX_CLOCK_SKEW_MS || expiresAt <= now ||
    expiresAt - issuedAt !== CHALLENGE_LIFETIME_MS || result.message !== canonicalMessage(input)) {
    fail('invalid_challenge');
  }
  return { message: result.message, signInInput: input };
}

async function requestChallenge(endpoint: string, address: string, fetchImpl: typeof globalThis.fetch, now: number): Promise<Challenge> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
      credentials: 'same-origin',
    });
  } catch {
    return fail('challenge_unavailable');
  }
  if (response.status !== 201 || !(response.headers.get('content-type') ?? '').startsWith('application/json')) {
    fail(response.status === 429 ? 'challenge_rate_limited' : 'challenge_unavailable');
  }
  try {
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_CHALLENGE_BYTES) {
      fail('invalid_challenge');
    }
    const reader = response.body?.getReader();
    if (!reader) fail('invalid_challenge');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CHALLENGE_BYTES) {
        await reader.cancel();
        fail('invalid_challenge');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseChallenge(JSON.parse(text), address, now);
  } catch (error) {
    if (error instanceof SolanaWalletAuthError) throw error;
    return fail('invalid_challenge');
  }
}

function exactBytes(value: Uint8Array, expected: Uint8Array): boolean {
  return value.length === expected.length && value.every((byte, index) => byte === expected[index]);
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validateProof(account: WalletAccount, signedMessage: Uint8Array, signature: Uint8Array, expected: Uint8Array): void {
  if (!exactBytes(signedMessage, expected) || signature.length !== 64 || account.publicKey.length !== 32) {
    fail('wallet_proof_invalid');
  }
}

function proofPayload(
  account: WalletAccount,
  challenge: Challenge,
  method: SolanaWalletProof['method'],
  output: Pick<SolanaSignInOutput | SolanaSignMessageOutput, 'signature' | 'signedMessage'>,
): SolanaWalletProof {
  const signedMessage = new Uint8Array(output.signedMessage);
  const signature = new Uint8Array(output.signature);
  const expected = new TextEncoder().encode(challenge.message);
  validateProof(account, signedMessage, signature, expected);
  return {
    address: account.address,
    method,
    public_key: bytesToBase64(new Uint8Array(account.publicKey)),
    request_id: challenge.signInInput.requestId,
    signature: bytesToBase64(signature),
    signature_type: 'ed25519',
    signed_message: bytesToBase64(signedMessage),
  };
}

export async function createSolanaWalletProof(wallet: Wallet, options: SolanaWalletAuthOptions): Promise<SolanaWalletProof> {
  let endpoint: URL;
  try {
    endpoint = new URL(options.challengeEndpoint);
  } catch {
    return fail('challenge_unavailable');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail('challenge_unavailable');
  }

  const account = await authorizeAccount(wallet, options.accountAddress);
  const signIn = feature<SignInApi>(wallet, SolanaSignIn)?.signIn;
  const signMessage = feature<SignMessageApi>(wallet, SolanaSignMessage)?.signMessage;
  if (typeof signIn !== 'function' && typeof signMessage !== 'function') fail('wallet_signing_unsupported');

  const challenge = await requestChallenge(
    endpoint.toString(),
    account.address,
    options.fetch ?? globalThis.fetch,
    (options.now ?? Date.now)(),
  );
  if (!account.chains.some((chain) => chain === challenge.signInInput.chainId)) fail('wallet_chain_mismatch');

  if (typeof signIn === 'function' && account.features.includes(SolanaSignIn)) {
    let outputs: readonly SolanaSignInOutput[];
    try {
      outputs = await signIn(challenge.signInInput);
    } catch {
      return fail('wallet_signature_rejected');
    }
    if (outputs.length !== 1 || outputs[0].account.address !== account.address ||
      !exactBytes(new Uint8Array(outputs[0].account.publicKey), new Uint8Array(account.publicKey)) ||
      outputs[0].signatureType && outputs[0].signatureType !== 'ed25519') fail('wallet_proof_invalid');
    return proofPayload(account, challenge, SolanaSignIn, outputs[0]);
  }

  if (typeof signMessage !== 'function' || !account.features.includes(SolanaSignMessage)) {
    fail('wallet_signing_unsupported');
  }
  let outputs: readonly SolanaSignMessageOutput[];
  try {
    outputs = await signMessage({ account, message: new TextEncoder().encode(challenge.message) });
  } catch {
    return fail('wallet_signature_rejected');
  }
  if (outputs.length !== 1 || outputs[0].signatureType && outputs[0].signatureType !== 'ed25519') {
    fail('wallet_proof_invalid');
  }
  return proofPayload(account, challenge, SolanaSignMessage, outputs[0]);
}
