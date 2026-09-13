import { createSiwsChallenge, type SiwsChallenge } from "./siws_challenge.ts";
import {
  evaluateSiwsProof,
  type SiwsProofRequest,
  SiwsVerificationError,
  solanaAddressFromPublicKey,
  verifySiwsProof,
} from "./siws_verify.ts";

const NOW = new Date("2026-09-13T01:00:00.000Z");
const CONFIG = {
  chainId: "solana:devnet",
  domain: "staging.heroloop.xyz",
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

async function fixture(
  method: SiwsProofRequest["method"] = "solana:signIn",
): Promise<{ challenge: SiwsChallenge; proof: SiwsProofRequest }> {
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
    { address, ...CONFIG },
    {
      now: () => NOW,
      randomBytes: () => new Uint8Array(16).fill(0xab),
      requestId: () => "123e4567-e89b-42d3-a456-426614174000",
    },
  );
  const message = new TextEncoder().encode(challenge.message);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      Uint8Array.from(message).buffer,
    ),
  );
  return {
    challenge,
    proof: {
      address,
      method,
      public_key: base64(publicKey),
      request_id: challenge.signInInput.requestId,
      signature: base64(signature),
      signature_type: "ed25519",
      signed_message: base64(message),
    },
  };
}

async function rejects(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(
      error instanceof SiwsVerificationError &&
        error.message === "invalid_wallet_proof",
      "unexpected verification error",
    );
    return;
  }
  throw new Error("verification unexpectedly succeeded");
}

Deno.test("verifies a canonical solana:signIn Ed25519 proof", async () => {
  const { challenge, proof } = await fixture();
  const verified = await verifySiwsProof(proof, CONFIG, NOW);
  assert(verified.address === proof.address, "address differs");
  assert(verified.message === challenge.message, "message differs");
  assert(verified.nonce === "ab".repeat(16), "nonce differs");
  assert(verified.requestId === proof.request_id, "request ID differs");
});

Deno.test("accepts the identical solana:signMessage fallback proof", async () => {
  const { proof } = await fixture("solana:signMessage");
  const verified = await verifySiwsProof(proof, CONFIG, NOW);
  assert(verified.method === "solana:signMessage", "fallback method differs");
});

Deno.test("rejects invalid Ed25519 signatures", async () => {
  const { proof } = await fixture();
  const signature = Uint8Array.from(
    atob(proof.signature),
    (value) => value.charCodeAt(0),
  );
  signature[0] ^= 0xff;
  const invalidProof = { ...proof, signature: base64(signature) };
  const evaluated = await evaluateSiwsProof(invalidProof, CONFIG, NOW);
  assert(!evaluated.signatureValid, "invalid signature was marked valid");
  assert(
    evaluated.proof.requestId === proof.request_id,
    "attempt reference differs",
  );
  await rejects(() => verifySiwsProof(invalidProof, CONFIG, NOW));
});

Deno.test("rejects public-key, address and request-ID mismatches", async () => {
  const first = await fixture();
  const second = await fixture();
  await rejects(() =>
    verifySiwsProof(
      { ...first.proof, public_key: second.proof.public_key },
      CONFIG,
      NOW,
    )
  );
  await rejects(() =>
    verifySiwsProof(
      { ...first.proof, address: second.proof.address },
      CONFIG,
      NOW,
    )
  );
  await rejects(() =>
    verifySiwsProof(
      { ...first.proof, request_id: "223e4567-e89b-42d3-a456-426614174000" },
      CONFIG,
      NOW,
    )
  );
});

Deno.test("rejects domain, URI and chain substitution", async () => {
  const { proof } = await fixture();
  await rejects(() =>
    verifySiwsProof(proof, {
      ...CONFIG,
      domain: "evil.invalid",
      uri: "https://evil.invalid/",
    }, NOW)
  );
  await rejects(() =>
    verifySiwsProof(proof, {
      ...CONFIG,
      uri: "https://staging.heroloop.xyz/auth",
    }, NOW)
  );
  await rejects(() =>
    verifySiwsProof(proof, { ...CONFIG, chainId: "solana:mainnet" }, NOW)
  );
});

Deno.test("rejects expired and future-issued proofs", async () => {
  const { proof } = await fixture();
  await rejects(() =>
    verifySiwsProof(proof, CONFIG, new Date("2026-09-13T01:05:00.000Z"))
  );
  await rejects(() =>
    verifySiwsProof(proof, CONFIG, new Date("2026-09-13T00:59:29.000Z"))
  );
});

Deno.test("rejects altered ABNF, transaction methods and extra fields", async () => {
  const { challenge, proof } = await fixture();
  const altered = new TextEncoder().encode(
    `${challenge.message}\nResources:\n- https://evil.invalid/`,
  );
  await rejects(() =>
    verifySiwsProof({ ...proof, signed_message: base64(altered) }, CONFIG, NOW)
  );
  await rejects(() =>
    verifySiwsProof({ ...proof, method: "solana:signTransaction" }, CONFIG, NOW)
  );
  await rejects(() =>
    verifySiwsProof({ ...proof, transaction: "forbidden" }, CONFIG, NOW)
  );
});
