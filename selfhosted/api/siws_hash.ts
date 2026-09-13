export const SIWS_HASH_PATTERN = /^[0-9a-f]{64}$/;

export async function siwsHmacHex(
  pepper: string,
  value: string,
): Promise<string> {
  if (
    typeof pepper !== "string" || pepper.length < 43 ||
    typeof value !== "string"
  ) {
    throw new Error("invalid_siws_hash_input");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!SIWS_HASH_PATTERN.test(hash)) throw new Error("invalid_siws_hash");
  return hash;
}
