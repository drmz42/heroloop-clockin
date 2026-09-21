import {
  SIWS_CHALLENGE_LIFETIME_MS,
  SIWS_STATEMENT,
} from "./siws_challenge.ts";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_PATTERN =
  /^(?<domain>[^\r\n]{1,253}) wants you to sign in with your Solana account:\n(?<address>[1-9A-HJ-NP-Za-km-z]{32,44})\n\n(?<statement>[^\r\n]+)\n\nURI: (?<uri>[^\r\n]{1,2048})\nVersion: (?<version>[^\r\n]+)\nNonce: (?<nonce>[^\r\n]+)\nIssued At: (?<issuedAt>[^\r\n]+)$/;
const MAX_MESSAGE_BYTES = 4_096;
const MAX_CLOCK_SKEW_MS = 30_000;

export type SiwsProofRequest = {
  address: string;
  method: "solana:signIn" | "solana:signMessage";
  public_key: string;
  request_id: string;
  signature: string;
  signature_type: "ed25519";
  signed_message: string;
};

export type SiwsVerificationConfig = {
  chainId: string;
  domain: string;
  uri: string;
};

export type VerifiedSiwsProof = {
  address: string;
  expirationTime: string;
  issuedAt: string;
  message: string;
  method: SiwsProofRequest["method"];
  nonce: string;
  requestId: string;
};

export type EvaluatedSiwsProof = {
  proof: VerifiedSiwsProof;
  signatureValid: boolean;
};

export class SiwsVerificationError extends Error {
  readonly code = "invalid_wallet_proof";

  constructor() {
    super("invalid_wallet_proof");
    this.name = "SiwsVerificationError";
  }
}

function fail(): never {
  throw new SiwsVerificationError();
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function decodeBase64(value: unknown, expectedBytes?: number): Uint8Array {
  if (
    typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) fail();
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return fail();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (btoa(binary) !== value) fail();
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) fail();
  return bytes;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function solanaAddressFromPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) fail();
  let leadingZeros = 0;
  while (leadingZeros < publicKey.length && publicKey[leadingZeros] === 0) {
    leadingZeros += 1;
  }
  if (leadingZeros === publicKey.length) return "1".repeat(publicKey.length);
  const digits: number[] = [0];
  for (const byte of publicKey) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] * 256;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(leadingZeros) +
    digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

function publicKeyFromSolanaAddress(address: string): Uint8Array {
  if (!ADDRESS_PATTERN.test(address)) fail();
  const littleEndian: number[] = [];
  for (const character of address) {
    let carry = BASE58_ALPHABET.indexOf(character);
    if (carry < 0) fail();
    for (let index = 0; index < littleEndian.length; index += 1) {
      carry += littleEndian[index] * 58;
      littleEndian[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      littleEndian.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < address.length && address[leadingZeros] === "1") {
    leadingZeros += 1;
  }
  const publicKey = new Uint8Array(leadingZeros + littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 1) {
    publicKey[publicKey.length - 1 - index] = littleEndian[index];
  }
  if (publicKey.length !== 32) fail();
  return publicKey;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function parseMessage(message: string): Record<string, string> {
  const groups = MESSAGE_PATTERN.exec(message)?.groups;
  if (!groups) fail();
  return groups;
}

function exactUtc(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail();
  }
  return parsed;
}

function validateConfig(config: SiwsVerificationConfig): void {
  if (
    !DOMAIN_PATTERN.test(config.domain) || !config.chainId.startsWith("solana:")
  ) {
    fail();
  }
  let uri: URL;
  try {
    uri = new URL(config.uri);
  } catch {
    return fail();
  }
  if (
    uri.protocol !== "https:" || uri.host !== config.domain || uri.username ||
    uri.password || uri.search || uri.hash || uri.toString() !== config.uri
  ) fail();
}

export async function evaluateSiwsProof(
  value: unknown,
  config: SiwsVerificationConfig,
  now = new Date(),
): Promise<EvaluatedSiwsProof> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !(now instanceof Date) || !Number.isFinite(now.getTime())
  ) fail();
  validateConfig(config);
  const proof = value as Record<string, unknown>;
  const proofKeys = [
    "address",
    "method",
    "public_key",
    "request_id",
    "signature",
    "signature_type",
    "signed_message",
  ];
  if (!hasExactKeys(proof, proofKeys)) fail();
  if (
    typeof proof.address !== "string" || !ADDRESS_PATTERN.test(proof.address) ||
    (proof.method !== "solana:signIn" &&
      proof.method !== "solana:signMessage") ||
    proof.signature_type !== "ed25519" || typeof proof.request_id !== "string"
  ) fail();

  const publicKey = decodeBase64(proof.public_key, 32);
  const signature = decodeBase64(proof.signature, 64);
  const messageBytes = decodeBase64(proof.signed_message);
  if (messageBytes.length === 0 || messageBytes.length > MAX_MESSAGE_BYTES) {
    fail();
  }
  let message: string;
  try {
    message = new TextDecoder("utf-8", { fatal: true }).decode(messageBytes);
  } catch {
    return fail();
  }
  const fields = parseMessage(message);
  const issuedAt = exactUtc(fields.issuedAt);
  // Expiry and request binding are server-owned: the challenge row stores the
  // five-minute expiry and the message hash, so they are not signed text.
  const expirationTime = issuedAt + SIWS_CHALLENGE_LIFETIME_MS;
  let messageUri: URL;
  try {
    messageUri = new URL(fields.uri);
  } catch {
    return fail();
  }
  if (
    fields.domain !== config.domain || fields.uri !== config.uri ||
    fields.address !== proof.address ||
    !exactBytes(publicKeyFromSolanaAddress(proof.address), publicKey) ||
    fields.statement !== SIWS_STATEMENT || fields.version !== "1" ||
    !/^[0-9a-f]{32}$/.test(fields.nonce) ||
    !UUID_PATTERN.test(proof.request_id) ||
    messageUri.protocol !== "https:" || messageUri.host !== fields.domain ||
    issuedAt > now.getTime() + MAX_CLOCK_SKEW_MS ||
    expirationTime <= now.getTime()
  ) fail();

  let verificationKey: CryptoKey;
  try {
    verificationKey = await crypto.subtle.importKey(
      "raw",
      exactBuffer(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return fail();
  }
  let validSignature: boolean;
  try {
    validSignature = await crypto.subtle.verify(
      { name: "Ed25519" },
      verificationKey,
      exactBuffer(signature),
      exactBuffer(messageBytes),
    );
  } catch {
    return fail();
  }
  return {
    proof: {
      address: proof.address,
      expirationTime: new Date(expirationTime).toISOString(),
      issuedAt: fields.issuedAt,
      message,
      method: proof.method,
      nonce: fields.nonce,
      requestId: proof.request_id,
    },
    signatureValid: validSignature,
  };
}

export async function verifySiwsProof(
  value: unknown,
  config: SiwsVerificationConfig,
  now = new Date(),
): Promise<VerifiedSiwsProof> {
  const evaluated = await evaluateSiwsProof(value, config, now);
  if (!evaluated.signatureValid) fail();
  return evaluated.proof;
}
