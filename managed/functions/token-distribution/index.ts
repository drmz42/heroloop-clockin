import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "https://heroloop.xyz,https://www.heroloop.xyz")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

const corsHeadersBase = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function corsHeadersFor(origin: string | null): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { ...corsHeadersBase, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { ...corsHeadersBase, Vary: "Origin" };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "unknown_error");
}

function internalError(headers: Record<string, string>, requestId: string, detail: unknown): Response {
  console.error(JSON.stringify({ request_id: requestId, error: "distribution_failed", detail: errorMessage(detail) }));
  return new Response(JSON.stringify({ error: "distribution_failed", request_id: requestId }), {
    status: 500,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

const DAILY_HERO_POOL = 20_000;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const headers = corsHeadersFor(origin);
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(null, { status: 403, headers });
    }
    return new Response(null, { status: 200, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...headers, Allow: "POST, OPTIONS", "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const providedSecret = req.headers.get("x-cron-secret") ?? "";
    const cronSecret = Deno.env.get("TOKEN_DISTRIBUTION_CRON_SECRET");
    const matchesEnvironment = Boolean(cronSecret && providedSecret === cronSecret);
    let matchesVault = false;
    if (!matchesEnvironment && /^[a-f0-9]{64}$/.test(providedSecret)) {
      const { data, error } = await supabase.rpc("verify_token_distribution_cron_secret", {
        candidate: providedSecret,
      });
      matchesVault = !error && data === true;
    }
    if (!matchesEnvironment && !matchesVault) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const { data: rateAllowed, error: rateError } = await supabase.rpc("consume_edge_rate_limit", {
      p_subject_key: "cron:token-distribution",
      p_action: "token-distribution",
      p_limit: 3,
      p_window_seconds: 60,
    });
    if (rateError) return internalError(headers, requestId, rateError);
    if (rateAllowed !== true) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { ...headers, "Content-Type": "application/json", "Retry-After": "60" },
      });
    }

    // 1. Read the current pool
    const { data: pool, error: poolErr } = await supabase
      .from("token_pool")
      .select("pool_amount, total_distributed, distribution_rate")
      .eq("id", 1)
      .maybeSingle();

    if (poolErr || !pool) {
      return internalError(headers, requestId, poolErr ?? "pool_not_found");
    }

    // A fresh heartbeat marks the browser online and renews a separate
    // eight-hour reward window. Closing the browser stops heartbeats, but the
    // account remains eligible until that server-owned deadline expires.
    const now = new Date().toISOString();
    const onlineCutoff = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase
      .from("players")
      .update({ online: false })
      .lt("last_heartbeat", onlineCutoff);

    const { data: players, error: playersErr } = await supabase
      .from("players")
      .select("player_id, power, highest_location, training_hero_count, reward_active_until, boost_max_active")
      .eq("token_eligible", true)
      .or(`reward_active_until.gt.${now},boost_max_active.eq.true`)
      .gt("power", 0);

    if (playersErr) {
      return internalError(headers, requestId, playersErr);
    }

    const intervalSeconds = 30;
    const { data: resourcePlayers, error: resourcePlayersError } = await supabase
      .from("players")
      .select("player_id")
      .or(`reward_active_until.gt.${now},boost_max_active.eq.true`)
      .gt("combat_power", 0);
    if (resourcePlayersError) throw new Error("resource_players_unavailable");
    const resourceResults = await Promise.all((resourcePlayers ?? []).map((player) =>
      supabase.rpc("settle_periodic_progression", {
        p_player_id: player.player_id,
        p_tick: now,
      })
    ));
    if (resourceResults.some((result) => result.error)) throw new Error("resource_credit_failed");

    if (!players || players.length === 0) {
      return new Response(
        JSON.stringify({ distributed: 0, reason: "no eligible players" }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Efficiency-weighted distribution score.
    // playerScore = power x (1 + 0.10 x (highest_location - 1)).
    // The Training Camp discount is already reflected in `power` (effectivePower),
    // so a penalized player's forfeited share automatically redistributes to the
    // rest of the pool; we still account and log it explicitly.
    // v2 includes canonical equipped player_items in server-derived Power.
    const SCORE_VERSION = 2;

    const { data: scoreRows, error: scoreError } = await supabase.rpc("canonical_hero_income_scores", {
      p_players: players,
    });
    if (scoreError || !Array.isArray(scoreRows) || scoreRows.length !== players.length) {
      throw new Error("income_score_unavailable");
    }
    const scored = scoreRows.map((row) => ({
      player_id: String(row.player_id),
      power: Number(row.power),
      score: Number(row.score),
      forfeited: Number(row.forfeited),
    }));

    const totalScore = scored.reduce((sum, p) => sum + p.score, 0);
    const totalPower = players.reduce((sum, p) => sum + Number(p.power), 0);
    if (totalScore <= 0) {
      return new Response(
        JSON.stringify({ distributed: 0, reason: "no power" }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // A 30-second tick gradually pays the configured daily pool.
    const tickAmount = (DAILY_HERO_POOL / 86400) * intervalSeconds;

    // Player reward = tick pool * player score / total reward-active score.
    let actuallyDistributed = 0;
    let totalForfeited = 0;
    const updates: PromiseLike<{ error: unknown }>[] = [];

    for (const player of scored) {
      const score = player.score;
      const share = score / totalScore;
      const reward = tickAmount * share;

      if (reward <= 0) continue;

      totalForfeited += player.forfeited;
      actuallyDistributed += reward;
      updates.push(supabase.rpc("credit_token_distribution", {
        p_player_id: player.player_id,
        p_amount: reward,
      }));
    }

    // Execute all updates
    const results = await Promise.all(updates);
    if (results.some((result) => result.error)) throw new Error("token_credit_failed");

    // Record lifetime distribution; the MVP daily emission is a fixed budget.
    const newTotalDistributed = Number(pool.total_distributed) + actuallyDistributed;

    await supabase
      .from("token_pool")
      .update({
        pool_amount: DAILY_HERO_POOL,
        total_distributed: newTotalDistributed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    // 7. Log this distribution tick
    await supabase
      .from("distribution_log")
      .insert({
        tick_at: new Date().toISOString(),
        total_power: totalPower,
        player_count: players.length,
        amount_distributed: actuallyDistributed,
        interval_seconds: intervalSeconds,
        forfeited: totalForfeited,
        total_score: totalScore,
        score_version: SCORE_VERSION,
      });

    return new Response(
      JSON.stringify({
        distributed: actuallyDistributed.toFixed(6),
        forfeited: totalForfeited.toFixed(6),
        players: players.length,
        total_power: totalPower,
        total_score: totalScore.toFixed(2),
        score_version: SCORE_VERSION,
        daily_pool: DAILY_HERO_POOL,
        tick_amount: tickAmount.toFixed(6),
      }),
      { headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return internalError(headers, requestId, err);
  }
});
