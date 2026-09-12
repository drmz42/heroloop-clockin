const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALLOWED_CHAINS = new Set([
  "mainnet",
  "testnet",
  "devnet",
  "localnet",
  "solana:mainnet",
  "solana:testnet",
  "solana:devnet",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;

export const SIWS_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
export const SIWS_STATEMENT =
  "Signing is free, proves wallet ownership, moves no funds and costs no gas.";

export type SiwsChallengeRequest = {
  address: string;
  chainId: string;
  domain: string;
  uri: string;
};

export type SiwsSignInInput = SiwsChallengeRequest & {
  expirationTime: string;
  issuedAt: string;
  nonce: string;
  requestId: string;
  statement: string;
  version: "1";
};

export type SiwsChallenge = {
  message: string;
  signInInput: SiwsSignInInput;
};

export type SiwsChallengeDependencies = {
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
  requestId?: () => string;
};

function fail(code: string): never {
  throw new TypeError(code);
}

function isSolanaAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false;
  const bytes: number[] = [];
  for (const character of address) {
    let carry = BASE58_ALPHABET.indexOf(character);
    if (carry < 0) return false;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroBytes = 0;
  while (
    leadingZeroBytes < address.length && address[leadingZeroBytes] === "1"
  ) {
    leadingZeroBytes += 1;
  }
  return leadingZeroBytes + bytes.length === 32;
}

function validateRequest(request: SiwsChallengeRequest): void {
  const allowedKeys = new Set(["address", "chainId", "domain", "uri"]);
  if (
    !request || typeof request !== "object" || Array.isArray(request) ||
    Object.keys(request).some((key) => !allowedKeys.has(key)) ||
    Object.keys(request).length !== allowedKeys.size
  ) fail("invalid_challenge_request");
  if (
    typeof request.address !== "string" || !isSolanaAddress(request.address)
  ) {
    fail("invalid_solana_address");
  }
  if (
    typeof request.chainId !== "string" || !ALLOWED_CHAINS.has(request.chainId)
  ) {
    fail("invalid_solana_chain");
  }
  if (
    typeof request.domain !== "string" || !DOMAIN_PATTERN.test(request.domain)
  ) {
    fail("invalid_siws_domain");
  }
  if (typeof request.uri !== "string") fail("invalid_siws_uri");

  let parsed: URL;
  try {
    parsed = new URL(request.uri);
  } catch {
    fail("invalid_siws_uri");
  }
  if (
    request.uri.length > 2048 || parsed.protocol !== "https:" ||
    parsed.username !== "" || parsed.password !== "" || parsed.search !== "" ||
    parsed.hash !== "" || parsed.host !== request.domain ||
    parsed.toString() !== request.uri
  ) fail("invalid_siws_uri");
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function createSiwsMessage(input: SiwsSignInInput): string {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: ${input.version}\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}\nRequest ID: ${input.requestId}`;
}

export function createSiwsChallenge(
  request: SiwsChallengeRequest,
  dependencies: SiwsChallengeDependencies = {},
): SiwsChallenge {
  validateRequest(request);
  const now = (dependencies.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("invalid_server_time");
  }

  const randomBytes = (dependencies.randomBytes ?? secureRandomBytes)(16);
  if (!(randomBytes instanceof Uint8Array) || randomBytes.length !== 16) {
    fail("invalid_nonce_source");
  }
  const requestId = (dependencies.requestId ?? (() => crypto.randomUUID()))();
  if (!UUID_PATTERN.test(requestId)) fail("invalid_request_id_source");

  const signInInput: SiwsSignInInput = {
    address: request.address,
    chainId: request.chainId,
    domain: request.domain,
    expirationTime: new Date(now.getTime() + SIWS_CHALLENGE_LIFETIME_MS)
      .toISOString(),
    issuedAt: now.toISOString(),
    nonce: toHex(randomBytes),
    requestId,
    statement: SIWS_STATEMENT,
    uri: request.uri,
    version: "1",
  };
  return { message: createSiwsMessage(signInInput), signInInput };
}
