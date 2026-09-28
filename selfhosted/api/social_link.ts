// Verified social links for Partner Quests. X uses OAuth 2.0 with PKCE and a
// confidential client; Telegram uses a one-time /start code sent to our bot
// through its webhook. Both bind the provider's stable account id to the
// player that created the single-use challenge. Provider tokens are never
// stored: the X access token is used once to read the account id.

export type SocialProvider = "x" | "telegram";

export interface SocialLinkConfig {
  siteOrigin: string;
  x: { clientId: string; clientSecret: string } | null;
  telegram: { botUsername: string; webhookSecret: string } | null;
}

export interface SocialLinkStore {
  createChallenge(playerId: string, provider: SocialProvider, stateHash: string, codeVerifier: string | null): Promise<void>;
  // Returns null when the challenge is unknown, expired or already used.
  consumeChallenge(provider: SocialProvider, stateHash: string): Promise<{ playerId: string; codeVerifier: string | null } | null>;
  // Returns an error code (social_account_taken, social_link_cooldown, ...) or null on success.
  linkAccount(playerId: string, provider: SocialProvider, providerUserId: string, handle: string | null): Promise<string | null>;
}

type Fetch = typeof fetch;

const statePattern = /^[A-Za-z0-9_-]{43}$/;
const xScopes = "users.read tweet.read";
const maxWebhookBytes = 64 * 1024;

export function socialLinkConfig(env: (name: string) => string | undefined): SocialLinkConfig {
  let siteOrigin = "";
  try {
    siteOrigin = new URL(env("SIWS_URI") ?? "").origin;
  } catch {
    siteOrigin = "";
  }
  const clientId = env("X_CLIENT_ID") ?? "";
  const clientSecret = env("X_CLIENT_SECRET") ?? "";
  const botUsername = env("TELEGRAM_BOT_USERNAME") ?? "";
  const webhookSecret = env("TELEGRAM_WEBHOOK_SECRET") ?? "";
  return {
    siteOrigin,
    x: siteOrigin && clientId && clientSecret ? { clientId, clientSecret } : null,
    telegram: /^[A-Za-z0-9_]{5,32}$/.test(botUsername) && /^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)
      ? { botUsername, webhookSecret }
      : null,
  };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function xRedirectUri(config: SocialLinkConfig): string {
  return `${config.siteOrigin}/api/v1/social/x/callback`;
}

// Player command: returns the URL that starts linking, or an error code.
export async function startSocialLink(
  playerId: string,
  provider: SocialProvider,
  config: SocialLinkConfig,
  store: SocialLinkStore,
): Promise<{ url: string } | { code: string }> {
  const state = randomToken();
  if (provider === "x") {
    if (!config.x) return { code: "social_provider_unavailable" };
    const verifier = randomToken();
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    await store.createChallenge(playerId, provider, await sha256Hex(state), verifier);
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.x.clientId,
      redirect_uri: xRedirectUri(config),
      scope: xScopes,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString() };
  }
  if (!config.telegram) return { code: "social_provider_unavailable" };
  await store.createChallenge(playerId, provider, await sha256Hex(state), null);
  return { url: `https://t.me/${config.telegram.botUsername}?start=${state}` };
}

function backToGame(config: SocialLinkConfig, provider: SocialProvider, result: string): Response {
  const target = new URL(config.siteOrigin || "https://heroloop.xyz");
  target.pathname = "/";
  target.search = new URLSearchParams({ social_link: provider, result }).toString();
  return new Response(null, { status: 303, headers: { location: target.toString(), "cache-control": "no-store" } });
}

// GET /api/v1/social/x/callback: X returns the player here after consent.
export async function handleXCallback(url: URL, config: SocialLinkConfig, store: SocialLinkStore, fetcher: Fetch = fetch): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!config.x) return backToGame(config, "x", "social_provider_unavailable");
  if (!statePattern.test(state)) return backToGame(config, "x", "social_link_expired");
  const challenge = await store.consumeChallenge("x", await sha256Hex(state));
  if (!challenge || !challenge.codeVerifier) return backToGame(config, "x", "social_link_expired");
  if (url.searchParams.has("error") || !code || code.length > 512) return backToGame(config, "x", "social_link_cancelled");
  let account: { id: string; username: string };
  try {
    const tokenResponse = await fetcher("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${config.x.clientId}:${config.x.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: xRedirectUri(config),
        code_verifier: challenge.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(8_000),
    });
    const token = await tokenResponse.json().catch(() => null) as { access_token?: unknown } | null;
    if (!tokenResponse.ok || typeof token?.access_token !== "string") throw new Error("x_token_exchange_failed");
    const meResponse = await fetcher("https://api.x.com/2/users/me", {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const me = await meResponse.json().catch(() => null) as { data?: { id?: unknown; username?: unknown } } | null;
    const id = me?.data?.id;
    const username = me?.data?.username;
    if (!meResponse.ok || typeof id !== "string" || !/^[0-9]{1,25}$/.test(id)
      || typeof username !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(username)) {
      throw new Error("x_profile_failed");
    }
    account = { id, username };
  } catch {
    console.error("social link X exchange failed");
    return backToGame(config, "x", "social_provider_failed");
  }
  const error = await store.linkAccount(challenge.playerId, "x", account.id, account.username);
  return backToGame(config, "x", error ?? "linked");
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

const telegramReplies: Record<string, string> = {
  linked: "✅ Telegram linked to your HeroLoop account. Return to the game.",
  social_account_taken: "This Telegram account is already linked to another HeroLoop player.",
  social_link_cooldown: "You can switch your linked Telegram account once per 24 hours.",
  social_link_expired: "This link has expired. Press \"Link Telegram\" in the game again.",
  help: "To link Telegram, open HeroLoop → BOOST MAX → Linked accounts → Link Telegram.",
};

// POST /api/v1/social/telegram/webhook. Telegram retries any non-2xx, so every
// authentic update gets 200; the reply rides in the webhook response.
export async function handleTelegramWebhook(request: Request, config: SocialLinkConfig, store: SocialLinkStore): Promise<Response> {
  if (!config.telegram) return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (!timingSafeEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", config.telegram.webhookSecret)) {
    return new Response(null, { status: 401 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > maxWebhookBytes) return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > maxWebhookBytes) return new Response(null, { status: 413 });
  let update: { message?: { chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown; is_bot?: unknown; username?: unknown }; text?: unknown } };
  try {
    update = JSON.parse(text);
  } catch {
    return new Response(null, { status: 200 });
  }
  const message = update?.message;
  if (!message || message.chat?.type !== "private" || typeof message.chat.id !== "number" || typeof message.text !== "string") {
    return new Response(null, { status: 200 });
  }
  const reply = (key: string) => new Response(JSON.stringify({ method: "sendMessage", chat_id: message.chat!.id, text: telegramReplies[key] ?? telegramReplies.help }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const start = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/.exec(message.text);
  if (!start) return new Response(null, { status: 200 });
  const state = start[1] ?? "";
  const from = message.from;
  if (!statePattern.test(state) || !from || from.is_bot === true || typeof from.id !== "number" || !Number.isSafeInteger(from.id) || from.id <= 0) {
    return reply("help");
  }
  const challenge = await store.consumeChallenge("telegram", await sha256Hex(state));
  if (!challenge) return reply("social_link_expired");
  const username = typeof from.username === "string" && /^[A-Za-z0-9_]{4,32}$/.test(from.username) ? from.username : null;
  const error = await store.linkAccount(challenge.playerId, "telegram", String(from.id), username);
  return reply(error ?? "linked");
}
