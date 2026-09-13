import { siwsHmacHex } from "./siws_hash.ts";
import {
  evaluateSiwsProof,
  type SiwsVerificationConfig,
} from "./siws_verify.ts";

const MAX_BODY_BYTES = 12_288;
const SESSION_LIFETIME_MS = 15 * 60 * 1_000;
const SESSION_TOKEN_PATTERN = /^hlw_[A-Za-z0-9_-]{43}$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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

export type SiwsSessionIssue = Omit<SiwsConsumeAttempt, "proofValid"> & {
  address: string;
  expiresAt: string;
  issuedAt: string;
  tokenHash: string;
};

export type IssueSiwsWalletSession = (
  session: SiwsSessionIssue,
) => Promise<{ expires_at?: string; issued: boolean }>;

export type ValidateSiwsWalletSession = (
  tokenHash: string,
) => Promise<{
  account_id?: string | null;
  address?: string;
  expires_at?: string;
  valid: boolean;
}>;

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

function createSessionToken(randomBytes: () => Uint8Array): string {
  const bytes = randomBytes();
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error("invalid_session_entropy");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = `hlw_${
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  }`;
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new Error("invalid_session_token");
  }
  return token;
}

export async function handleSiwsVerification(
  request: Request,
  requestId: string,
  config: SiwsVerifyEndpointConfig,
  consumeFailedAttempt: ConsumeSiwsChallenge,
  issueSession: IssueSiwsWalletSession,
  now = new Date(),
  randomBytes = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32)),
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
    const hashes = {
      messageHash: await siwsHmacHex(
        config.hashPepper,
        evaluated.proof.message,
      ),
      nonceHash: await siwsHmacHex(config.hashPepper, evaluated.proof.nonce),
      requestId: evaluated.proof.requestId,
      walletHash: await siwsHmacHex(config.hashPepper, evaluated.proof.address),
    };
    if (!evaluated.signatureValid) {
      await consumeFailedAttempt({ ...hashes, proofValid: false });
      return response(401, {
        code: "invalid_wallet_proof",
        ok: false,
        request_id: requestId,
      });
    }

    const sessionToken = createSessionToken(randomBytes);
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS)
      .toISOString();
    const issued = await issueSession({
      ...hashes,
      address: evaluated.proof.address,
      expiresAt,
      issuedAt: now.toISOString(),
      tokenHash: await siwsHmacHex(config.hashPepper, sessionToken),
    });
    if (
      !issued.issued || typeof issued.expires_at !== "string" ||
      Date.parse(issued.expires_at) !== Date.parse(expiresAt)
    ) {
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
        session: {
          wallet_session_token: sessionToken,
          expires_at: expiresAt,
          token_type: "bearer",
        },
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

export async function handleSiwsSession(
  request: Request,
  requestId: string,
  config: SiwsVerifyEndpointConfig,
  validate: ValidateSiwsWalletSession,
  now = new Date(),
): Promise<Response> {
  if (request.method !== "GET") {
    const result = response(405, {
      code: "method_not_allowed",
      ok: false,
      request_id: requestId,
    });
    result.headers.set("allow", "GET");
    return result;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (config.hashPepper.length < 43 || !SESSION_TOKEN_PATTERN.test(token)) {
    return response(401, {
      code: "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
  }
  try {
    const session = await validate(await siwsHmacHex(config.hashPepper, token));
    if (
      !session.valid || typeof session.address !== "string" ||
      !ADDRESS_PATTERN.test(session.address) ||
      typeof session.expires_at !== "string" ||
      !Number.isFinite(Date.parse(session.expires_at)) ||
      Date.parse(session.expires_at) <= now.getTime()
    ) {
      return response(401, {
        code: "invalid_wallet_session",
        ok: false,
        request_id: requestId,
      });
    }
    return response(200, {
      ok: true,
      request_id: requestId,
      result: {
        account_id: typeof session.account_id === "string"
          ? session.account_id
          : null,
        address: session.address,
        expires_at: session.expires_at,
        valid: true,
      },
    });
  } catch {
    return response(503, {
      code: "session_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
}
