import {
  createSiwsChallenge,
  SIWS_CHALLENGE_LIFETIME_MS,
  SIWS_STATEMENT,
  type SiwsChallengeDependencies,
  type SiwsChallengeRequest,
} from "./siws_challenge.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectFailure(code: string, callback: () => unknown): void {
  try {
    callback();
  } catch (error) {
    assert(
      error instanceof TypeError && error.message === code,
      `expected ${code}`,
    );
    return;
  }
  throw new Error(`expected ${code}`);
}

const request: SiwsChallengeRequest = {
  address: "11111111111111111111111111111111",
  chainId: "solana:devnet",
  domain: "staging.heroloop.xyz",
  uri: "https://staging.heroloop.xyz/",
};
const dependencies: SiwsChallengeDependencies = {
  now: () => new Date("2026-09-12T12:00:00.000Z"),
  randomBytes: (length) => new Uint8Array(length).fill(0xab),
  requestId: () => "123e4567-e89b-42d3-a456-426614174000",
};

Deno.test("creates one deterministic five-minute SIWS challenge", () => {
  const challenge = createSiwsChallenge(request, dependencies);
  assert(
    challenge.signInInput.nonce === "ab".repeat(16),
    "nonce must contain 128 random bits",
  );
  assert(
    challenge.signInInput.statement === SIWS_STATEMENT,
    "statement differs",
  );
  assert(
    Date.parse(challenge.signInInput.expirationTime) -
        Date.parse(challenge.signInInput.issuedAt) ===
      SIWS_CHALLENGE_LIFETIME_MS,
    "challenge lifetime differs",
  );
  assert(
    challenge.message ===
      "staging.heroloop.xyz wants you to sign in with your Solana account:\n" +
        "11111111111111111111111111111111\n\n" +
        `${SIWS_STATEMENT}\n\n` +
        "URI: https://staging.heroloop.xyz/\n" +
        "Version: 1\n" +
        "Chain ID: solana:devnet\n" +
        `Nonce: ${"ab".repeat(16)}\n` +
        "Issued At: 2026-09-12T12:00:00.000Z\n" +
        "Expiration Time: 2026-09-12T12:05:00.000Z\n" +
        "Request ID: 123e4567-e89b-42d3-a456-426614174000",
    "canonical SIWS text differs",
  );
});

Deno.test("uses fresh server entropy by default", () => {
  const first = createSiwsChallenge(request);
  const second = createSiwsChallenge(request);
  assert(
    /^[0-9a-f]{32}$/.test(first.signInInput.nonce),
    "nonce encoding differs",
  );
  assert(
    first.signInInput.nonce !== second.signInInput.nonce,
    "nonce was reused",
  );
  assert(
    first.signInInput.requestId !== second.signInInput.requestId,
    "request ID was reused",
  );
});

Deno.test("rejects malformed or non-32-byte Solana addresses", () => {
  for (const address of ["", "0".repeat(32), "1".repeat(31), "1".repeat(33)]) {
    expectFailure(
      "invalid_solana_address",
      () => createSiwsChallenge({ ...request, address }, dependencies),
    );
  }
});

Deno.test("rejects unknown chains and cross-origin or unsafe URIs", () => {
  expectFailure(
    "invalid_solana_chain",
    () =>
      createSiwsChallenge(
        { ...request, chainId: "solana:mainnet-beta" },
        dependencies,
      ),
  );
  for (
    const uri of [
      "http://staging.heroloop.xyz/",
      "https://heroloop.xyz/",
      "https://staging.heroloop.xyz/?return=wallet",
      "https://staging.heroloop.xyz/#wallet",
      "https://user@staging.heroloop.xyz/",
    ]
  ) {
    expectFailure(
      "invalid_siws_uri",
      () => createSiwsChallenge({ ...request, uri }, dependencies),
    );
  }
});

Deno.test("rejects malformed domains and extra request fields", () => {
  for (
    const domain of [
      "https://staging.heroloop.xyz",
      "Staging.heroloop.xyz",
      "-invalid.example",
    ]
  ) {
    expectFailure(
      "invalid_siws_domain",
      () => createSiwsChallenge({ ...request, domain }, dependencies),
    );
  }
  expectFailure(
    "invalid_challenge_request",
    () =>
      createSiwsChallenge(
        { ...request, extra: true } as SiwsChallengeRequest,
        dependencies,
      ),
  );
});

Deno.test("fails closed for invalid time, nonce and request-ID sources", () => {
  expectFailure(
    "invalid_server_time",
    () =>
      createSiwsChallenge(request, {
        ...dependencies,
        now: () => new Date("invalid"),
      }),
  );
  expectFailure(
    "invalid_nonce_source",
    () =>
      createSiwsChallenge(request, {
        ...dependencies,
        randomBytes: () => new Uint8Array(15),
      }),
  );
  expectFailure(
    "invalid_request_id_source",
    () =>
      createSiwsChallenge(request, {
        ...dependencies,
        requestId: () => "predictable",
      }),
  );
});
