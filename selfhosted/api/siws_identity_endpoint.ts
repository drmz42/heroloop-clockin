import { siwsHmacHex } from "./siws_hash.ts";
import type { SiwsVerifyEndpointConfig } from "./siws_verify_endpoint.ts";
import { evaluateSiwsProof, type SiwsProofRequest } from "./siws_verify.ts";

const MAX_BODY_BYTES = 12_288;
const SESSION_TOKEN_PATTERN = /^hlw_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type JsonRecord = Record<string, unknown>;
type RevokeReason =
  | "logout"
  | "wallet_disconnect"
  | "account_change"
  | "expired_identity";

export type LinkSiwsIdentity = (
  accountId: string,
  tokenHash: string,
  idempotencyKey: string,
) => Promise<
  { account_id?: string; address?: string; code?: string; linked: boolean }
>;

export type RevokeSiwsSession = (
  tokenHash: string,
  idempotencyKey: string,
  reason: RevokeReason,
) => Promise<{ revoked: boolean }>;

export type ClaimSiwsAccountLogin = (
  tokenHash: string,
  idempotencyKey: string,
) => Promise<{
  account_id?: string | null;
  address?: string;
  claimed: boolean;
  code?: string;
}>;

type GoTrueSession = {
  access_token?: string;
  expires_at?: number;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
  user?: { id?: string };
};

export type SignInWithSolana = (
  message: string,
  signature: string,
) => Promise<GoTrueSession>;

export type RevokeGoTrueSession = (accessToken: string) => Promise<void>;

function response(status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function sessionToken(request: Request): string {
  return request.headers.get("x-heroloop-wallet-session") ?? "";
}

function idempotencyKey(request: Request): string {
  return request.headers.get("x-idempotency-key") ?? "";
}

async function readBody(request: Request): Promise<unknown | null> {
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function validSecret(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return typeof value === "string" && value.length >= minimum &&
    value.length <= maximum && !/\s/.test(value);
}

export async function handleSiwsAccountLogin(
  request: Request,
  requestId: string,
  config: SiwsVerifyEndpointConfig,
  claim: ClaimSiwsAccountLogin,
  signIn: SignInWithSolana,
  link: LinkSiwsIdentity,
  revokeAuth: RevokeGoTrueSession,
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
  const token = sessionToken(request);
  const key = idempotencyKey(request);
  const body = await readBody(request);
  if (
    config.hashPepper.length < 43 || !SESSION_TOKEN_PATTERN.test(token) ||
    !UUID_PATTERN.test(key) || !body || typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return response(401, {
      code: "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
  }

  let proof;
  try {
    proof = await evaluateSiwsProof(body as SiwsProofRequest, config, now);
  } catch {
    return response(401, {
      code: "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
  }
  if (!proof.signatureValid) {
    return response(401, {
      code: "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
  }

  let claimed;
  try {
    claimed = await claim(await siwsHmacHex(config.hashPepper, token), key);
  } catch {
    return response(503, {
      code: "account_login_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
  if (!claimed.claimed || claimed.address !== proof.proof.address) {
    const rateLimited = claimed.code === "rate_limited";
    const denied = response(rateLimited ? 429 : 401, {
      code: rateLimited ? "wallet_login_rate_limited" : "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
    if (rateLimited) denied.headers.set("retry-after", "60");
    return denied;
  }

  let auth: GoTrueSession;
  try {
    auth = await signIn(
      proof.proof.message,
      (body as SiwsProofRequest).signature,
    );
  } catch {
    return response(503, {
      code: "account_login_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
  const accountId = auth.user?.id;
  if (
    !UUID_PATTERN.test(accountId ?? "") ||
    !validSecret(auth.access_token, 20, 8192) ||
    !validSecret(auth.refresh_token, 8, 1024) || auth.token_type !== "bearer" ||
    typeof auth.expires_in !== "number" ||
    !Number.isSafeInteger(auth.expires_in) ||
    auth.expires_in < 60 || auth.expires_in > 86_400 ||
    (claimed.account_id != null && claimed.account_id !== accountId)
  ) {
    if (validSecret(auth.access_token, 20, 8192)) {
      await revokeAuth(auth.access_token).catch(() => undefined);
    }
    return response(409, {
      code: "wallet_login_rejected",
      ok: false,
      request_id: requestId,
    });
  }

  let linked;
  try {
    linked = await link(
      accountId!,
      await siwsHmacHex(config.hashPepper, token),
      key,
    );
  } catch {
    await revokeAuth(auth.access_token!).catch(() => undefined);
    return response(503, {
      code: "account_login_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
  if (
    !linked.linked || linked.account_id !== accountId ||
    linked.address !== proof.proof.address
  ) {
    await revokeAuth(auth.access_token!).catch(() => undefined);
    return response(409, {
      code: "wallet_login_rejected",
      ok: false,
      request_id: requestId,
    });
  }

  return response(200, {
    ok: true,
    request_id: requestId,
    result: {
      account_id: accountId,
      address: proof.proof.address,
      auth: {
        access_token: auth.access_token,
        expires_at: auth.expires_at,
        expires_in: auth.expires_in,
        refresh_token: auth.refresh_token,
        token_type: "bearer",
      },
    },
  });
}

export async function handleSiwsIdentityLink(
  request: Request,
  requestId: string,
  config: SiwsVerifyEndpointConfig,
  accountId: string,
  link: LinkSiwsIdentity,
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
  const token = sessionToken(request);
  const key = idempotencyKey(request);
  if (
    config.hashPepper.length < 43 || !SESSION_TOKEN_PATTERN.test(token) ||
    !UUID_PATTERN.test(key)
  ) {
    return response(401, {
      code: "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
  }
  try {
    const result = await link(
      accountId,
      await siwsHmacHex(config.hashPepper, token),
      key,
    );
    if (
      !result.linked || result.account_id !== accountId ||
      typeof result.address !== "string"
    ) {
      const status = result.code === "rate_limited" ? 429 : 409;
      const denied = response(status, {
        code: status === 429
          ? "wallet_link_rate_limited"
          : "wallet_link_rejected",
        ok: false,
        request_id: requestId,
      });
      if (status === 429) denied.headers.set("retry-after", "60");
      return denied;
    }
    return response(200, {
      ok: true,
      request_id: requestId,
      result: { account_id: accountId, address: result.address, linked: true },
    });
  } catch {
    return response(503, {
      code: "wallet_link_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
}

export async function handleSiwsSessionRevoke(
  request: Request,
  requestId: string,
  config: SiwsVerifyEndpointConfig,
  revoke: RevokeSiwsSession,
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
  const token = sessionToken(request);
  const key = idempotencyKey(request);
  const reason = request.headers.get("x-wallet-session-reason") as
    | RevokeReason
    | null;
  if (
    config.hashPepper.length < 43 || !SESSION_TOKEN_PATTERN.test(token) ||
    !UUID_PATTERN.test(key) ||
    !reason ||
    !["logout", "wallet_disconnect", "account_change", "expired_identity"]
      .includes(reason)
  ) {
    return response(401, {
      code: "invalid_wallet_session",
      ok: false,
      request_id: requestId,
    });
  }
  try {
    await revoke(await siwsHmacHex(config.hashPepper, token), key, reason);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return response(503, {
      code: "session_unavailable",
      ok: false,
      request_id: requestId,
    });
  }
}
