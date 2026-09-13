import { createSiwsChallenge, type SiwsChallenge } from "./siws_challenge.ts";
import { SIWS_HASH_PATTERN, siwsHmacHex } from "./siws_hash.ts";

const MAX_BODY_BYTES = 256;
const IP_PATTERN = /^[0-9a-f:.]{2,64}$/i;

type JsonRecord = Record<string, unknown>;

export type SiwsEndpointConfig = {
  chainId: string;
  domain: string;
  hashPepper: string;
  uri: string;
};

export type StoredSiwsChallenge = {
  expiresAt: string;
  issuedAt: string;
  messageHash: string;
  nonceHash: string;
  rateSubjectHash: string;
  requestId: string;
  walletHash: string;
};

export type StoreSiwsChallenge = (
  challenge: StoredSiwsChallenge,
) => Promise<{ allowed: boolean; retry_after?: number }>;

function response(
  status: number,
  body: JsonRecord,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

async function readBody(request: Request): Promise<JsonRecord | null> {
  if (
    !(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
      "application/json",
    )
  ) {
    return null;
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  } catch {
    return null;
  }
}

async function storageRecord(
  challenge: SiwsChallenge,
  clientAddress: string,
  pepper: string,
): Promise<StoredSiwsChallenge> {
  const record = {
    expiresAt: challenge.signInInput.expirationTime,
    issuedAt: challenge.signInInput.issuedAt,
    messageHash: await siwsHmacHex(pepper, challenge.message),
    nonceHash: await siwsHmacHex(pepper, challenge.signInInput.nonce),
    rateSubjectHash: await siwsHmacHex(pepper, clientAddress),
    requestId: challenge.signInInput.requestId,
    walletHash: await siwsHmacHex(pepper, challenge.signInInput.address),
  };
  if (
    ![
      record.messageHash,
      record.nonceHash,
      record.rateSubjectHash,
      record.walletHash,
    ].every((hash) => SIWS_HASH_PATTERN.test(hash))
  ) {
    throw new Error("invalid_challenge_hash");
  }
  return record;
}

export async function handleSiwsChallenge(
  request: Request,
  requestId: string,
  clientAddress: string,
  config: SiwsEndpointConfig,
  store: StoreSiwsChallenge,
): Promise<Response> {
  if (request.method !== "POST") {
    return response(405, {
      code: "method_not_allowed",
      ok: false,
      request_id: requestId,
    }, { allow: "POST" });
  }
  if (config.hashPepper.length < 43 || !IP_PATTERN.test(clientAddress)) {
    return response(503, {
      code: "challenge_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
  const body = await readBody(request);
  if (
    !body || Object.keys(body).length !== 1 || typeof body.address !== "string"
  ) {
    return response(400, {
      code: "invalid_request",
      ok: false,
      request_id: requestId,
    });
  }
  let challenge: SiwsChallenge;
  try {
    challenge = createSiwsChallenge({
      address: body.address,
      chainId: config.chainId,
      domain: config.domain,
      uri: config.uri,
    });
  } catch {
    return response(400, {
      code: "invalid_request",
      ok: false,
      request_id: requestId,
    });
  }
  try {
    const stored = await store(
      await storageRecord(challenge, clientAddress, config.hashPepper),
    );
    if (!stored.allowed) {
      const retryAfter = Math.max(
        1,
        Math.min(300, Number(stored.retry_after) || 300),
      );
      return response(
        429,
        { code: "rate_limited", ok: false, request_id: requestId },
        { "retry-after": String(retryAfter) },
      );
    }
    return response(201, {
      contract_version: 1,
      ok: true,
      request_id: requestId,
      result: challenge,
    });
  } catch {
    return response(503, {
      code: "challenge_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
}
