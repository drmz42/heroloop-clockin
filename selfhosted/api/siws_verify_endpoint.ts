import { siwsHmacHex } from "./siws_hash.ts";
import {
  evaluateSiwsProof,
  type SiwsVerificationConfig,
} from "./siws_verify.ts";

const MAX_BODY_BYTES = 12_288;
type JsonRecord = Record<string, unknown>;

export type SiwsVerifyEndpointConfig = SiwsVerificationConfig & {
  hashPepper: string;
};

export type SiwsConsumeAttempt = {
  messageHash: string;
  nonceHash: string;
  proofValid: boolean;
  requestId: string;
  walletHash: string;
};

export type ConsumeSiwsChallenge = (
  attempt: SiwsConsumeAttempt,
) => Promise<{ consumed: boolean }>;

function response(status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readBody(request: Request): Promise<unknown | null> {
  if (
    !(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
      "application/json",
    )
  ) return null;
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
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function handleSiwsVerification(
  request: Request,
  requestId: string,
  config: SiwsVerifyEndpointConfig,
  consume: ConsumeSiwsChallenge,
  now = new Date(),
): Promise<Response> {
  if (request.method !== "POST") {
    const result = response(405, {
      code: "method_not_allowed",
      ok: false,
      request_id: requestId,
    });
    result.headers.set("allow", "POST");
    return result;
  }
  if (config.hashPepper.length < 43) {
    return response(503, {
      code: "verification_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
  const body = await readBody(request);
  if (body === null) {
    return response(401, {
      code: "invalid_wallet_proof",
      ok: false,
      request_id: requestId,
    });
  }

  let evaluated: Awaited<ReturnType<typeof evaluateSiwsProof>>;
  try {
    evaluated = await evaluateSiwsProof(body, config, now);
  } catch {
    return response(401, {
      code: "invalid_wallet_proof",
      ok: false,
      request_id: requestId,
    });
  }

  try {
    const consumed = await consume({
      messageHash: await siwsHmacHex(
        config.hashPepper,
        evaluated.proof.message,
      ),
      nonceHash: await siwsHmacHex(config.hashPepper, evaluated.proof.nonce),
      proofValid: evaluated.signatureValid,
      requestId: evaluated.proof.requestId,
      walletHash: await siwsHmacHex(config.hashPepper, evaluated.proof.address),
    });
    if (!evaluated.signatureValid || !consumed.consumed) {
      return response(401, {
        code: "invalid_wallet_proof",
        ok: false,
        request_id: requestId,
      });
    }
    return response(200, {
      ok: true,
      request_id: requestId,
      result: {
        address: evaluated.proof.address,
        method: evaluated.proof.method,
        verified: true,
      },
    });
  } catch {
    return response(503, {
      code: "verification_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
}
