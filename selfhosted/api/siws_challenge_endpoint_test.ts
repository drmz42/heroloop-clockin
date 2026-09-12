import {
  handleSiwsChallenge,
  type SiwsEndpointConfig,
  type StoredSiwsChallenge,
} from "./siws_challenge_endpoint.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const config: SiwsEndpointConfig = {
  chainId: "solana:devnet",
  domain: "staging.heroloop.xyz",
  hashPepper: "p".repeat(48),
  uri: "https://staging.heroloop.xyz/",
};
const address = "11111111111111111111111111111111";

function request(body: unknown, method = "POST"): Request {
  return new Request(
    "https://staging.heroloop.xyz/api/v1/auth/solana/challenge",
    {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    },
  );
}

Deno.test("stores hashes only and returns a bounded SIWS challenge", async () => {
  let stored: StoredSiwsChallenge | undefined;
  const result = await handleSiwsChallenge(
    request({ address }),
    requestId,
    "192.0.2.10",
    config,
    (record) => {
      stored = record;
      return Promise.resolve({ allowed: true });
    },
  );
  const body = await result.json();
  assert(
    result.status === 201 && body.ok === true,
    "challenge response failed",
  );
  assert(body.request_id === requestId, "HTTP request ID differs");
  assert(body.result?.signInInput?.address === address, "wallet input differs");
  assert(
    body.result?.message?.includes("Nonce: "),
    "canonical message missing",
  );
  assert(stored !== undefined, "challenge was not stored");
  const encoded = JSON.stringify(stored);
  assert(!encoded.includes(address), "storage leaked wallet address");
  assert(
    !encoded.includes(body.result.signInInput.nonce),
    "storage leaked nonce",
  );
  assert(!encoded.includes(body.result.message), "storage leaked message");
  for (
    const key of [
      "nonceHash",
      "messageHash",
      "walletHash",
      "rateSubjectHash",
    ] as const
  ) {
    assert(/^[0-9a-f]{64}$/.test(stored[key]), `${key} is not a SHA-256 HMAC`);
  }
});

Deno.test("rejects methods, malformed bodies and unsafe addresses", async () => {
  const store = () => Promise.resolve({ allowed: true });
  for (
    const [candidate, expected] of [
      [request({}, "GET"), 405],
      [request({}), 400],
      [request({ address, extra: true }), 400],
      [request({ address: "not-a-wallet" }), 400],
    ] as const
  ) {
    const result = await handleSiwsChallenge(
      candidate,
      requestId,
      "192.0.2.10",
      config,
      store,
    );
    assert(result.status === expected, `unexpected status ${result.status}`);
  }
});

Deno.test("fails closed without server pepper or a bounded client address", async () => {
  const store = () => Promise.resolve({ allowed: true });
  const noPepper = await handleSiwsChallenge(
    request({ address }),
    requestId,
    "192.0.2.10",
    { ...config, hashPepper: "short" },
    store,
  );
  assert(noPepper.status === 503, "short pepper was accepted");
  const badAddress = await handleSiwsChallenge(
    request({ address }),
    requestId,
    "not an ip",
    config,
    store,
  );
  assert(badAddress.status === 503, "invalid client address was accepted");
});

Deno.test("returns generic rate-limit and storage failures", async () => {
  const limited = await handleSiwsChallenge(
    request({ address }),
    requestId,
    "192.0.2.10",
    config,
    () => Promise.resolve({ allowed: false, retry_after: 45 }),
  );
  assert(
    limited.status === 429 && limited.headers.get("retry-after") === "45",
    "rate limit differs",
  );
  const unavailable = await handleSiwsChallenge(
    request({ address }),
    requestId,
    "192.0.2.10",
    config,
    () => Promise.reject(new Error("fixture")),
  );
  const body = await unavailable.json();
  assert(
    unavailable.status === 503 && body.code === "challenge_unavailable",
    "storage failure leaked",
  );
});
