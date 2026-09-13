import {
  handleSiwsIdentityLink,
  handleSiwsSessionRevoke,
} from "./siws_identity_endpoint.ts";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174099";
const ACCOUNT_ID = "123e4567-e89b-42d3-a456-426614174088";
const KEY = "123e4567-e89b-42d3-a456-426614174077";
const TOKEN = `hlw_${"a".repeat(43)}`;
const CONFIG = {
  chainId: "solana:devnet",
  domain: "staging.heroloop.xyz",
  hashPepper: "p".repeat(48),
  uri: "https://staging.heroloop.xyz/",
};

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
