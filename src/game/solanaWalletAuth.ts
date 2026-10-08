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
import { withWalletReturnGrace } from '@/platform/walletReturn';

const MAX_CHALLENGE_BYTES = 8_192;
const MAX_CLOCK_SKEW_MS = 30_000;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const SIWS_STATEMENT = 'Sign in to HeroLoop. This will not trigger a transaction or cost gas.';
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ConnectApi = StandardConnectFeature[typeof StandardConnect];
type SignInApi = SolanaSignInFeature[typeof SolanaSignIn];
type SignMessageApi = SolanaSignMessageFeature[typeof SolanaSignMessage];

type PhantomPublicKey = { toBase58: () => string };
type PhantomProvider = {
  connect?: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: PhantomPublicKey }>;
  isPhantom?: boolean;
  publicKey?: PhantomPublicKey | null;
  signMessage?: (message: Uint8Array, display?: 'utf8') => Promise<{
    publicKey?: PhantomPublicKey;
    signature: Uint8Array;
  }>;
};

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
  phantomProvider?: PhantomProvider | null;
  // Mobile Wallet Adapter opens the wallet app through an Android intent, and Chrome only
  // allows that from a fresh tap. Connect and sign are two wallet round trips, so the UI
  // resolves this after a second tap before the signing request is sent.
  confirmBeforeSign?: () => Promise<void>;
};

export type WalletSignInStage = 'session' | 'connect' | 'challenge' | 'sign' | 'verify' | 'link' | 'login' | 'account';

export type MwaSessionProofOptions = Pick<SolanaWalletAuthOptions, 'challengeEndpoint' | 'fetch' | 'now'> & {
  appIdentity: { name: string; uri: string; icon: string };
  onStage?: (stage: WalletSignInStage) => void;
};

const MWA_CHALLENGE_TIMEOUT_MS = 15_000;

export class SolanaWalletAuthError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail = '') {
    super(code);
    this.name = 'SolanaWalletAuthError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: string, detail = ''): never {
  throw new SolanaWalletAuthError(code, detail);
}

// Short, secret-free wallet failure description for support diagnostics.
function describeWalletError(stage: string, error: unknown): string {
  const candidate = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  const part = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  return [stage, part(candidate.name), part(candidate.code), part(candidate.message)]
    .filter(Boolean).join(' ').replace(/[^A-Za-z0-9 _:.,()/-]/g, '').slice(0, 120);
}

function isUserRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (candidate.code === 4001 || candidate.code === '4001') return true;
  if (typeof candidate.message === 'string' && /cancel|declin|reject/i.test(candidate.message)) return true;
  return candidate.cause !== error && isUserRejected(candidate.cause);
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
  const connectFeature = feature<ConnectApi>(wallet, StandardConnect);
  const connect = connectFeature?.connect;
  if (typeof connect !== 'function') fail('wallet_connect_unsupported');
  let accounts: readonly WalletAccount[];
  try {
    // Refresh authorization on every explicit Connect Phantom click. Reusing
    // wallet.accounts skipped Phantom's working connect path after the first
    // login and could leave us calling signing features with a stale account.
    ({ accounts } = await connect.call(connectFeature));
  } catch (error) {
    return fail('wallet_connect_rejected', describeWalletError('standard-connect', error));
  }
  return chooseAccount(accounts, requested);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function canonicalMessage(input: SiwsSignInInput): string {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: ${input.version}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}`;
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

function injectedPhantomProvider(): PhantomProvider | null {
  const root = globalThis as typeof globalThis & {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  const provider = root.phantom?.solana ?? root.solana;
  return provider?.isPhantom === true ? provider : null;
}

async function signWithInjectedPhantom(
  wallet: Wallet,
  account: WalletAccount,
  message: Uint8Array,
  provider: PhantomProvider | null,
): Promise<SolanaSignMessageOutput | null> {
  if (wallet.name.trim().toLowerCase() !== 'phantom' || provider?.isPhantom !== true ||
    typeof provider.connect !== 'function' || typeof provider.signMessage !== 'function') return null;
  let providerAddress: string;
  try {
    const connected = await provider.connect();
    providerAddress = (connected.publicKey ?? provider.publicKey)?.toBase58() ?? '';
  } catch (error) {
    return fail(isUserRejected(error) ? 'wallet_connect_rejected' : 'wallet_sign_message_unavailable', describeWalletError('injected-connect', error));
  }
  if (providerAddress !== account.address) fail('wallet_account_unavailable');
  try {
    const output = await provider.signMessage(message, 'utf8');
    if (output.publicKey && output.publicKey.toBase58() !== account.address) fail('wallet_proof_invalid');
    return { signature: new Uint8Array(output.signature), signedMessage: message };
  } catch (error) {
    if (error instanceof SolanaWalletAuthError) throw error;
    return fail(isUserRejected(error) ? 'wallet_signature_rejected' : 'wallet_sign_message_unavailable', describeWalletError('injected-sign', error));
  }
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
  const signInFeature = feature<SignInApi>(wallet, SolanaSignIn);
  const signMessageFeature = feature<SignMessageApi>(wallet, SolanaSignMessage);
  const signIn = signInFeature?.signIn;
  const signMessage = signMessageFeature?.signMessage;
  // Phantom exposes SIWS as a wallet-level feature. Unlike signMessage, its
  // input has no account field; the returned account is checked against the
  // freshly connected account before the proof is accepted.
  const canSignIn = typeof signIn === 'function';
  const canSignMessage = typeof signMessage === 'function' && account.features.includes(SolanaSignMessage);
  if (!canSignIn && !canSignMessage) fail('wallet_signing_unsupported');

  const challenge = await requestChallenge(
    endpoint.toString(),
    account.address,
    options.fetch ?? globalThis.fetch,
    (options.now ?? Date.now)(),
  );
  if (!account.chains.some((chain) => chain === challenge.signInInput.chainId)) fail('wallet_chain_mismatch');
  if (options.confirmBeforeSign) await options.confirmBeforeSign();

  const message = new TextEncoder().encode(challenge.message);
  const injectedOutput = await signWithInjectedPhantom(
    wallet,
    account,
    message,
    options.phantomProvider === undefined ? injectedPhantomProvider() : options.phantomProvider,
  );
  if (injectedOutput) return proofPayload(account, challenge, SolanaSignMessage, injectedOutput);

  if (canSignIn) {
    let outputs: readonly SolanaSignInOutput[];
    try {
      const { address, domain, issuedAt, nonce, statement, uri, version } = challenge.signInInput;
      // Send only the signed fields so the wallet builds exactly the compact message.
      outputs = await signIn.call(signInFeature, { address, domain, issuedAt, nonce, statement, uri, version });
    } catch (error) {
      if (isUserRejected(error)) return fail('wallet_signature_rejected');
      if (!canSignMessage) {
        return fail('wallet_sign_in_unavailable', describeWalletError('standard-signin', error));
      }
      outputs = [];
    }
    if (outputs.length > 0) {
      if (outputs.length !== 1 || outputs[0].account.address !== account.address ||
        !exactBytes(new Uint8Array(outputs[0].account.publicKey), new Uint8Array(account.publicKey)) ||
        outputs[0].signatureType && outputs[0].signatureType !== 'ed25519') fail('wallet_proof_invalid');
      return proofPayload(account, challenge, SolanaSignIn, outputs[0]);
    }
  }

  if (!canSignMessage) {
    fail('wallet_signing_unsupported');
  }
  let outputs: readonly SolanaSignMessageOutput[];
  try {
    outputs = await signMessage.call(signMessageFeature, {
      account,
      message,
    });
  } catch (error) {
    return fail(isUserRejected(error) ? 'wallet_signature_rejected' : 'wallet_sign_message_unavailable', describeWalletError('standard-sign', error));
  }
  if (outputs.length !== 1 || outputs[0].signatureType && outputs[0].signatureType !== 'ed25519') {
    fail('wallet_proof_invalid');
  }
  return proofPayload(account, challenge, SolanaSignMessage, outputs[0]);
}

// Mobile Wallet Adapter in one wallet session (native app): authorize, fetch the address-bound
// challenge and sign it while the wallet stays open. The Wallet Standard path opens the wallet
// twice (connect, then sign), and a second, tap-less launch from the app could not reach it.
// The proof is the same signMessage proof the server already verifies.
export async function createMwaSessionProof(options: MwaSessionProofOptions): Promise<SolanaWalletProof> {
  let endpoint: URL;
  try {
    endpoint = new URL(options.challengeEndpoint);
  } catch {
    return fail('challenge_unavailable');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail('challenge_unavailable');
  }
  const [{ transact }, { base58FromUint8Array, base64FromUint8Array, base64ToUint8Array }] = await Promise.all([
    import('@solana-mobile/mobile-wallet-adapter-protocol'),
    import('@solana-mobile/mobile-wallet-adapter-protocol/encoding'),
  ]);
  const progress: { stage: 'connect' | 'challenge' | 'sign' } = { stage: 'connect' };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // The wallet holds the session open while the challenge loads: never wait on it forever.
  const challengeFetch: typeof globalThis.fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(MWA_CHALLENGE_TIMEOUT_MS) });
  options.onStage?.('connect');
  try {
    return await withWalletReturnGrace(transact(async (wallet) => {
      const authorization = await wallet.authorize({ chain: 'solana:mainnet', identity: options.appIdentity });
      const authorized = authorization.accounts[0];
      if (!authorized) fail('wallet_account_unavailable');
      const publicKey = base64ToUint8Array(authorized.address);
      if (publicKey.length !== 32) fail('wallet_account_unavailable');
      const account = { address: base58FromUint8Array(publicKey), publicKey } as unknown as WalletAccount;

      progress.stage = 'challenge';
      options.onStage?.('challenge');
      const challenge = await requestChallenge(
        endpoint.toString(),
        account.address,
        challengeFetch,
        (options.now ?? Date.now)(),
      );
      if (challenge.signInInput.chainId !== 'solana:mainnet') fail('wallet_chain_mismatch');

      progress.stage = 'sign';
      options.onStage?.('sign');
      const message = new TextEncoder().encode(challenge.message);
      const { signed_payloads: signedPayloads } = await wallet.signMessages({
        addresses: [authorized.address],
        payloads: [base64FromUint8Array(message)],
      });
      if (signedPayloads.length !== 1) fail('wallet_proof_invalid');
      // MWA returns the message with the 64-byte signature appended; some wallets return only the signature.
      const signed = base64ToUint8Array(signedPayloads[0]);
      const signature = signed.slice(-64);
      const signedMessage = signed.length === 64 ? message : signed.slice(0, -64);
      return proofPayload(account, challenge, SolanaSignMessage, { signature, signedMessage });
    }));
  } catch (error) {
    if (error instanceof SolanaWalletAuthError) throw error;
    const { stage } = progress;
    const detail = describeWalletError(`mwa-${stage}`, error);
    // MWA protocol: -1 authorization declined, -3 signature declined.
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (isUserRejected(error) || code === -1 || code === -3) return fail(stage === 'sign' ? 'wallet_signature_rejected' : 'wallet_connect_rejected', detail);
    return fail(stage === 'sign' ? 'wallet_sign_message_unavailable' : 'wallet_connect_rejected', detail);
  }
}
