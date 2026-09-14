import {
  handleSiwsAccountLogin,
  handleSiwsIdentityLink,
  handleSiwsSessionRevoke,
} from "./siws_identity_endpoint.ts";
import { createSiwsChallenge } from "./siws_challenge.ts";
import { solanaAddressFromPublicKey } from "./siws_verify.ts";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174099";
const ACCOUNT_ID = "123e4567-e89b-42d3-a456-426614174088";
const LEGACY_ACCOUNT_ID = "123e4567-e89b-42d3-a456-426614174066";
const KEY = "123e4567-e89b-42d3-a456-426614174077";
const TOKEN = `hlw_${"a".repeat(43)}`;
const CONFIG = {
  chainId: "solana:devnet",
  domain: "staging.heroloop.xyz",
  hashPepper: "p".repeat(48),
  uri: "https://staging.heroloop.xyz/",
};
const NOW = new Date("2026-09-13T13:00:00.000Z");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, extra: Record<string, string> = {}): Request {
  return new Request(`https://staging.heroloop.xyz${path}`, {
    method: "POST",
    headers: {
      "x-heroloop-wallet-session": TOKEN,
      "x-idempotency-key": KEY,
      ...extra,
    },
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loginRequest(): Promise<{ address: string; request: Request }> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
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
    request: new Request(
      "https://staging.heroloop.xyz/api/v1/auth/solana/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-heroloop-wallet-session": TOKEN,
          "x-idempotency-key": KEY,
        },
        body: JSON.stringify({
          address,
          method: "solana:signIn",
          public_key: base64(publicKey),
          request_id: challenge.signInInput.requestId,
          signature: base64(signature),
          signature_type: "ed25519",
          signed_message: base64(message),
        }),
      },
    ),
  };
}

Deno.test("links only the authenticated account using a hashed wallet bearer", async () => {
  let storedToken = "";
  const result = await handleSiwsIdentityLink(
    request("/api/v1/auth/solana/link"),
    REQUEST_ID,
    CONFIG,
    ACCOUNT_ID,
    (accountId, tokenHash, key) => {
      assert(
        accountId === ACCOUNT_ID && key === KEY,
        "trusted identifiers differ",
      );
      storedToken = tokenHash;
      return Promise.resolve({
        account_id: accountId,
        address: "11111111111111111111111111111111",
        linked: true,
      });
    },
  );
  const body = await result.json();
  assert(
    result.status === 200 && body.result?.linked,
    "identity was not linked",
  );
  assert(
    /^[0-9a-f]{64}$/.test(storedToken) && storedToken !== TOKEN,
    "plaintext bearer reached storage",
  );
  assert(!JSON.stringify(body).includes(storedToken), "bearer hash leaked");
});

Deno.test("identity collision and malformed credentials fail generically", async () => {
  const collision = await handleSiwsIdentityLink(
    request("/api/v1/auth/solana/link"),
    REQUEST_ID,
    CONFIG,
    ACCOUNT_ID,
    () => Promise.resolve({ code: "identity_collision", linked: false }),
  );
  const collisionBody = await collision.json();
  assert(
    collision.status === 409 && collisionBody.code === "wallet_link_rejected",
    "collision leaked",
  );

  const malformed = await handleSiwsIdentityLink(
    new Request("https://staging.heroloop.xyz/api/v1/auth/solana/link", {
      method: "POST",
    }),
    REQUEST_ID,
    CONFIG,
    ACCOUNT_ID,
    () => Promise.reject(new Error("must not run")),
  );
  assert(malformed.status === 401, "missing bearer accepted");
});

Deno.test("revokes the exact hashed wallet session with a bounded reason", async () => {
  let seenReason = "";
  const result = await handleSiwsSessionRevoke(
    request("/api/v1/auth/solana/session/revoke", {
      "x-wallet-session-reason": "wallet_disconnect",
    }),
    REQUEST_ID,
    CONFIG,
    (tokenHash, key, reason) => {
      assert(
        /^[0-9a-f]{64}$/.test(tokenHash) && key === KEY,
        "revoke inputs differ",
      );
      seenReason = reason;
      return Promise.resolve({ revoked: true });
    },
  );
  assert(
    result.status === 204 && seenReason === "wallet_disconnect",
    "session was not revoked",
  );
});

Deno.test("wallet login burns the verified bearer and returns one linked rotating Auth session", async () => {
  const fixture = await loginRequest();
  let claimedHash = "";
  let forwardedMessage = "";
  const result = await handleSiwsAccountLogin(
    fixture.request,
    REQUEST_ID,
    CONFIG,
    (tokenHash, key) => {
      claimedHash = tokenHash;
      assert(key === KEY, "login claim idempotency key differs");
      return Promise.resolve({
        claimed: true,
        address: fixture.address,
        account_id: LEGACY_ACCOUNT_ID,
      });
    },
    (message, signature) => {
      forwardedMessage = message;
      assert(signature.length === 88, "signature forwarding differs");
      return Promise.resolve({
        access_token: `eyJ${"a".repeat(64)}`,
        expires_at: 1_900_000_000,
        expires_in: 3600,
        refresh_token: "r".repeat(32),
        token_type: "bearer",
        user: { id: ACCOUNT_ID },
      });
    },
    (authSubject, tokenHash, key) =>
      Promise.resolve({
        account_id: LEGACY_ACCOUNT_ID,
        address: fixture.address,
        auth_subject: authSubject,
        linked: tokenHash === claimedHash && key === KEY,
      }),
    () => Promise.reject(new Error("successful login must not revoke")),
    NOW,
  );
  const body = await result.json();
  assert(
    result.status === 200 && body.result?.account_id === LEGACY_ACCOUNT_ID &&
      body.result?.auth_subject_id === ACCOUNT_ID,
    "account login failed",
  );
  assert(
    /^[0-9a-f]{64}$/.test(claimedHash) && claimedHash !== TOKEN,
    "plaintext bearer reached claim",
  );
  assert(
    forwardedMessage.includes(`\n${fixture.address}\n`),
    "verified message was not forwarded",
  );
  assert(
    body.result.auth.refresh_token === "r".repeat(32),
    "rotating session was not returned",
  );
});

Deno.test("wallet login rejects account collisions and revokes the unreturned Auth session", async () => {
  const fixture = await loginRequest();
  let revoked = "";
  const accessToken = `eyJ${"b".repeat(64)}`;
  const result = await handleSiwsAccountLogin(
    fixture.request,
    REQUEST_ID,
    CONFIG,
    () =>
      Promise.resolve({
        claimed: true,
        address: fixture.address,
        account_id: LEGACY_ACCOUNT_ID,
      }),
    () =>
      Promise.resolve({
        access_token: accessToken,
        expires_in: 3600,
        refresh_token: "r".repeat(32),
        token_type: "bearer",
        user: { id: ACCOUNT_ID },
      }),
    (authSubject) =>
      Promise.resolve({
        account_id: ACCOUNT_ID,
        address: fixture.address,
        auth_subject: authSubject,
        linked: true,
      }),
    (token) => {
      revoked = token;
      return Promise.resolve();
    },
    NOW,
  );
  assert(
    result.status === 409 && revoked === accessToken,
    "collision did not fail closed and revoke",
  );
});
