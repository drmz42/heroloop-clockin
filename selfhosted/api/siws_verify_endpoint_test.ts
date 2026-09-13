import { createSiwsChallenge } from "./siws_challenge.ts";
import {
  handleSiwsVerification,
  type SiwsConsumeAttempt,
} from "./siws_verify_endpoint.ts";
import {
  type SiwsProofRequest,
  solanaAddressFromPublicKey,
} from "./siws_verify.ts";

const NOW = new Date("2026-09-13T13:00:00.000Z");
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174099";
const CONFIG = {
  chainId: "solana:devnet",
  domain: "staging.heroloop.xyz",
  hashPepper: "p".repeat(48),
  uri: "https://staging.heroloop.xyz/",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function proofFixture(): Promise<SiwsProofRequest> {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  );
  const address = solanaAddressFromPublicKey(publicKey);
  const challenge = createSiwsChallenge(
    {
      address,
      chainId: CONFIG.chainId,
      domain: CONFIG.domain,
      uri: CONFIG.uri,
    },
    {
      now: () => NOW,
      randomBytes: () => new Uint8Array(16).fill(0xcd),
      requestId: () => "123e4567-e89b-42d3-a456-426614174000",
    },
  );
  const message = new TextEncoder().encode(challenge.message);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", keys.privateKey, message),
  );
  return {
    address,
    method: "solana:signIn",
    public_key: base64(publicKey),
    request_id: challenge.signInInput.requestId,
    signature: base64(signature),
    signature_type: "ed25519",
    signed_message: base64(message),
  };
}

function request(body: unknown, method = "POST"): Request {
  return new Request("https://staging.heroloop.xyz/api/v1/auth/solana/verify", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

Deno.test("valid proof consumes matching hashes exactly once", async () => {
  const proof = await proofFixture();
  let attempt: SiwsConsumeAttempt | undefined;
  const result = await handleSiwsVerification(
    request(proof),
    REQUEST_ID,
    CONFIG,
    (value) => {
      attempt = value;
      return Promise.resolve({ consumed: true });
    },
    NOW,
  );
  const body = await result.json();
  assert(
    result.status === 200 && body.result?.verified,
    "proof was not verified",
  );
  assert(attempt?.proofValid === true, "valid proof was not consumed as valid");
  assert(
    attempt?.requestId === proof.request_id,
    "challenge request ID differs",
  );
  assert(
    [attempt?.messageHash, attempt?.nonceHash, attempt?.walletHash].every((
      hash,
    ) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)),
    "consume hashes are invalid",
  );
  assert(
    !JSON.stringify(attempt).includes(proof.signature),
    "signature leaked to storage",
  );
});

Deno.test("replay returns the generic proof error", async () => {
  const result = await handleSiwsVerification(
    request(await proofFixture()),
    REQUEST_ID,
    CONFIG,
    () => Promise.resolve({ consumed: false }),
    NOW,
  );
  const body = await result.json();
  assert(
    result.status === 401 && body.code === "invalid_wallet_proof",
    "replay leaked",
  );
});

Deno.test("matching invalid signature spends a failed attempt", async () => {
  const proof = await proofFixture();
  const signature = Uint8Array.from(
    atob(proof.signature),
    (value) => value.charCodeAt(0),
  );
  signature[0] ^= 0xff;
  let attempt: SiwsConsumeAttempt | undefined;
  const result = await handleSiwsVerification(
    request({ ...proof, signature: base64(signature) }),
    REQUEST_ID,
    CONFIG,
    (value) => {
      attempt = value;
      return Promise.resolve({ consumed: false });
    },
    NOW,
  );
  assert(result.status === 401, "invalid signature response differs");
  assert(
    attempt?.proofValid === false,
    "failed signature did not spend an attempt",
  );
});

Deno.test("malformed proof never reaches challenge storage", async () => {
  let called = false;
  const result = await handleSiwsVerification(
    request({ request_id: "untrusted" }),
    REQUEST_ID,
    CONFIG,
    () => {
      called = true;
      return Promise.resolve({ consumed: false });
    },
    NOW,
  );
  assert(result.status === 401 && !called, "malformed proof reached storage");
});

Deno.test("fails closed for methods, configuration and database errors", async () => {
  const proof = await proofFixture();
  const method = await handleSiwsVerification(
    request({}, "GET"),
    REQUEST_ID,
    CONFIG,
    () => Promise.resolve({ consumed: false }),
  );
  assert(
    method.status === 405 && method.headers.get("allow") === "POST",
    "method accepted",
  );
  const missingPepper = await handleSiwsVerification(
    request(proof),
    REQUEST_ID,
    { ...CONFIG, hashPepper: "short" },
    () => Promise.resolve({ consumed: true }),
    NOW,
  );
  assert(missingPepper.status === 503, "short pepper accepted");
  const unavailable = await handleSiwsVerification(
    request(proof),
    REQUEST_ID,
    CONFIG,
    () => Promise.reject(new Error("fixture")),
    NOW,
  );
  const body = await unavailable.json();
  assert(
    unavailable.status === 503 && body.code === "verification_unavailable",
    "database failure leaked",
  );
});
