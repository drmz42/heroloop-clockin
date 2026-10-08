// Sign-In With Solana is bound to one site (SIWS_DOMAIN / SIWS_URI). A second site that shares the same
// backend (Staging's design lab, staging2.heroloop.xyz) is listed in SIWS_ADDITIONAL_URIS. A request whose
// browser Origin equals one of those URIs gets a challenge and verification bound to that site instead;
// Selection alone is not an Origin check. Seeker POST routes enforce siwsOriginAllowed first.
export type SiwsSiteBinding = { domain: string; uri: string };

export function siwsOriginAllowed(primary: SiwsSiteBinding, additionalUris: readonly string[], request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return [primary.uri, ...additionalUris].some((uri) => new URL(uri).origin === origin);
  } catch {
    return false;
  }
}

export function parseAdditionalSiwsUris(raw: string | undefined): string[] {
  const uris = (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const value of uris) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("invalid SIWS_ADDITIONAL_URIS");
    }
    if (
      parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash ||
      parsed.username || parsed.password || parsed.port || parsed.toString() !== value
    ) throw new Error("invalid SIWS_ADDITIONAL_URIS");
  }
  return uris;
}

export function siwsSiteForRequest<T extends SiwsSiteBinding>(primary: T, additionalUris: readonly string[], request: Request): T {
  const origin = request.headers.get("origin");
  if (!origin) return primary;
  for (const uri of additionalUris) {
    const parsed = new URL(uri);
    if (parsed.origin === origin) return { ...primary, domain: parsed.host, uri };
  }
  return primary;
}
