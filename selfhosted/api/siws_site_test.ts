import { parseAdditionalSiwsUris, siwsOriginAllowed, siwsSiteForRequest } from "./siws_site.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function throws(run: () => unknown, message: string) {
  try {
    run();
  } catch {
    return;
  }
  throw new Error(message);
}

const primary = { chainId: "solana:mainnet", domain: "staging.heroloop.xyz", hashPepper: "p", uri: "https://staging.heroloop.xyz/" };
const request = (origin?: string) => new Request("http://api/api/v1/auth/solana/challenge", { method: "POST", headers: origin ? { origin } : {} });

Deno.test("Seeker SIWS requires an exact primary or additional browser Origin", () => {
  const extra = parseAdditionalSiwsUris("https://staging2.heroloop.xyz/");
  for (const origin of ["https://staging.heroloop.xyz", "https://staging2.heroloop.xyz"]) {
    assert(siwsOriginAllowed(primary, extra, request(origin)), `allowed ${origin}`);
  }
  for (const origin of [undefined, "null", "https://evil.example", "https://staging.heroloop.xyz/",
    "https://staging.heroloop.xyz.evil.example", "http://staging.heroloop.xyz", "https://staging.heroloop.xyz:8443"]) {
    assert(!siwsOriginAllowed(primary, extra, request(origin)), `rejected ${origin}`);
  }
  assert(!siwsOriginAllowed(primary, [], request("https://staging2.heroloop.xyz")), "unlisted site rejected");
  assert(!siwsOriginAllowed({ domain: "", uri: "" }, [], request("https://evil.example")), "invalid config closed");
});

Deno.test("additional SIWS URIs accept only bare https site roots", () => {
  assert(parseAdditionalSiwsUris(undefined).length === 0, "empty by default");
  assert(parseAdditionalSiwsUris(" https://staging2.heroloop.xyz/ ").length === 1, "trimmed root accepted");
  for (const bad of ["http://staging2.heroloop.xyz/", "https://staging2.heroloop.xyz/x", "https://staging2.heroloop.xyz/?a", "https://staging2.heroloop.xyz:8443/", "https://u@staging2.heroloop.xyz/", "staging2"]) {
    throws(() => parseAdditionalSiwsUris(bad), `rejects ${bad}`);
  }
});

Deno.test("a listed browser origin binds the challenge to that site", () => {
  const extra = parseAdditionalSiwsUris("https://staging2.heroloop.xyz/");
  const site = siwsSiteForRequest(primary, extra, request("https://staging2.heroloop.xyz"));
  assert(site.domain === "staging2.heroloop.xyz" && site.uri === "https://staging2.heroloop.xyz/", "staging2 binding");
  assert(site.chainId === primary.chainId && site.hashPepper === primary.hashPepper, "other settings kept");
});

Deno.test("unlisted or missing origins keep the primary site", () => {
  const extra = parseAdditionalSiwsUris("https://staging2.heroloop.xyz/");
  assert(siwsSiteForRequest(primary, extra, request()) === primary, "no origin");
  assert(siwsSiteForRequest(primary, extra, request("https://evil.example")) === primary, "foreign origin");
  assert(siwsSiteForRequest(primary, extra, request("https://heroloop.xyz")) === primary, "production origin");
  assert(siwsSiteForRequest(primary, [], request("https://staging2.heroloop.xyz")) === primary, "not listed");
});
