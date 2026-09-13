import { siwsHmacHex } from "./siws_hash.ts";
import type { SiwsVerifyEndpointConfig } from "./siws_verify_endpoint.ts";

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
