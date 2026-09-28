import {
  handleTelegramWebhook,
  handleXCallback,
  socialLinkConfig,
  startSocialLink,
  type SocialLinkStore,
  type SocialProvider,
} from "./social_link.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const env: Record<string, string> = {
  SIWS_URI: "https://staging.heroloop.xyz/",
  X_CLIENT_ID: "client-id",
  X_CLIENT_SECRET: "client-secret",
  TELEGRAM_BOT_USERNAME: "heroloop_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "w".repeat(40),
};
const config = socialLinkConfig((name) => env[name]);

function memoryStore() {
  const challenges = new Map<string, { playerId: string; provider: SocialProvider; verifier: string | null; used: boolean }>();
  const links: Array<{ playerId: string; provider: SocialProvider; id: string; handle: string | null }> = [];
  const store: SocialLinkStore = {
    createChallenge(playerId, provider, stateHash, verifier) {
      challenges.set(stateHash, { playerId, provider, verifier, used: false });
      return Promise.resolve();
    },
    consumeChallenge(provider, stateHash) {
      const row = challenges.get(stateHash);
      if (!row || row.used || row.provider !== provider) return Promise.resolve(null);
      row.used = true;
      return Promise.resolve({ playerId: row.playerId, codeVerifier: row.verifier });
    },
    linkAccount(playerId, provider, id, handle) {
      if (links.some((link) => link.provider === provider && link.id === id && link.playerId !== playerId)) {
        return Promise.resolve("social_account_taken");
      }
      links.push({ playerId, provider, id, handle });
      return Promise.resolve(null);
    },
  };
  return { store, links };
}

Deno.test("unconfigured providers refuse to start", async () => {
  const bare = socialLinkConfig(() => undefined);
  const { store } = memoryStore();
  const result = await startSocialLink("p1", "x", bare, store);
  assert("code" in result && result.code === "social_provider_unavailable", "X started without a client");
  const telegram = await startSocialLink("p1", "telegram", bare, store);
  assert("code" in telegram && telegram.code === "social_provider_unavailable", "Telegram started without a bot");
});

Deno.test("X link: PKCE start, one-time callback, verified account id", async () => {
  const { store, links } = memoryStore();
  const started = await startSocialLink("p1", "x", config, store);
  assert("url" in started, "X start failed");
  const authorize = new URL(started.url);
  assert(authorize.origin === "https://x.com" && authorize.searchParams.get("code_challenge_method") === "S256", "PKCE missing");
  assert(authorize.searchParams.get("redirect_uri") === "https://staging.heroloop.xyz/api/v1/social/x/callback", "wrong redirect");
  const state = authorize.searchParams.get("state")!;
  const calls: string[] = [];
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    calls.push(target);
    if (target.endsWith("/2/oauth2/token")) {
      const body = new URLSearchParams(String(init?.body));
      assert(body.get("code") === "auth-code" && (body.get("code_verifier") ?? "").length === 43, "token exchange lacks verifier");
      return Promise.resolve(Response.json({ access_token: "access" }));
    }
    return Promise.resolve(Response.json({ data: { id: "12345", username: "Alpha_Hero" } }));
  }) as typeof fetch;
  const callback = new URL(`https://staging.heroloop.xyz/api/v1/social/x/callback?state=${state}&code=auth-code`);
  const response = await handleXCallback(callback, config, store, fakeFetch);
  assert(response.status === 303, "callback must redirect");
  const location = new URL(response.headers.get("location")!);
  assert(location.origin === "https://staging.heroloop.xyz" && location.searchParams.get("result") === "linked", "link not reported");
  assert(links.length === 1 && links[0].playerId === "p1" && links[0].id === "12345" && links[0].handle === "Alpha_Hero", "wrong link");
  assert(calls.length === 2, "unexpected provider calls");

  const replay = await handleXCallback(callback, config, store, fakeFetch);
  assert(new URL(replay.headers.get("location")!).searchParams.get("result") === "social_link_expired", "callback replay accepted");
  assert(links.length === 1 && calls.length === 2, "replay reached the provider");
});

Deno.test("X link: forged state and denied consent never link", async () => {
  const { store, links } = memoryStore();
  const forged = await handleXCallback(new URL(`https://s/cb?state=${"a".repeat(43)}&code=c`), config, store, () => {
    throw new Error("provider must not be called");
  });
  assert(new URL(forged.headers.get("location")!).searchParams.get("result") === "social_link_expired", "forged state accepted");
  const started = await startSocialLink("p1", "x", config, store);
  assert("url" in started, "X start failed");
  const state = new URL(started.url).searchParams.get("state");
  const denied = await handleXCallback(new URL(`https://s/cb?state=${state}&error=access_denied`), config, store, () => {
    throw new Error("provider must not be called");
  });
  assert(new URL(denied.headers.get("location")!).searchParams.get("result") === "social_link_cancelled", "denial not reported");
  assert(links.length === 0, "denied consent linked an account");
});

function telegramUpdate(text: string, fromId = 777, secret = env.TELEGRAM_WEBHOOK_SECRET): Request {
  return new Request("https://staging.heroloop.xyz/api/v1/social/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ message: { chat: { id: fromId, type: "private" }, from: { id: fromId, is_bot: false, username: "alpha_tg" }, text } }),
  });
}

Deno.test("Telegram link: secret header, one-time /start code, reply in response", async () => {
  const { store, links } = memoryStore();
  const started = await startSocialLink("p2", "telegram", config, store);
  assert("url" in started && started.url.startsWith("https://t.me/heroloop_test_bot?start="), "bad deep link");
  const state = new URL(started.url).searchParams.get("start")!;

  const unauthorized = await handleTelegramWebhook(telegramUpdate(`/start ${state}`, 777, "wrong"), config, store);
  assert(unauthorized.status === 401 && links.length === 0, "webhook without secret accepted");

  const linked = await handleTelegramWebhook(telegramUpdate(`/start ${state}`), config, store);
  const reply = await linked.json();
  assert(linked.status === 200 && reply.method === "sendMessage" && reply.chat_id === 777 && String(reply.text).includes("linked"), "no link reply");
  assert(Number(links.length) === 1 && links[0].playerId === "p2" && links[0].id === "777" && links[0].handle === "alpha_tg", "wrong Telegram link");

  const replay = await handleTelegramWebhook(telegramUpdate(`/start ${state}`, 888), config, store);
  assert(String((await replay.json()).text).includes("expired") && Number(links.length) === 1, "Telegram code reused");

  const plain = await handleTelegramWebhook(telegramUpdate("hello"), config, store);
  assert(plain.status === 200 && (await plain.text()) === "", "ordinary chat answered");
});
