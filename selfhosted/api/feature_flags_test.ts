import { createFeatureFlagGate } from "./feature_flags.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("a paused flag refuses only the actions it names", async () => {
  let reads = 0;
  const gate = createFeatureFlagGate(async () => {
    reads += 1;
    return { paused: ["market_listing"] };
  });
  assert(await gate("market_list_item") === "market_listing", "a paused flag must refuse its action");
  assert(await gate("market_cancel_listing") === null, "cancelling a listing is never paused");
  assert(await gate("store_buy_item") === null, "a flag that is on refuses nothing");
  assert(await gate("game_state_save") === null, "an action no flag names is never paused");
  assert(reads === 1, `the paused set is cached, read ${reads} times`);
});

Deno.test("the cache expires and a failed read lets the command through", async () => {
  let clock = 0;
  let paused: string[] = ["hero_summon"];
  let fail = false;
  const gate = createFeatureFlagGate(async () => {
    if (fail) throw new Error("database down");
    return { paused };
  }, () => clock);
  assert(await gate("hero_summon") === "hero_summon", "paused before the change");
  paused = [];
  clock = 4_000;
  assert(await gate("hero_summon") === "hero_summon", "within five seconds the cached state holds");
  clock = 6_000;
  assert(await gate("hero_summon") === null, "after five seconds the new state is read");
  fail = true;
  clock = 12_000;
  assert(await gate("hero_summon") === null, "a failed flag read must not refuse the command");
  fail = false;
  paused = ["hero_summon"];
  assert(await gate("hero_summon") === "hero_summon", "a later successful read applies again");
});

Deno.test("a malformed reply pauses nothing", async () => {
  const gate = createFeatureFlagGate(async () => ({ paused: "market_listing" }));
  assert(await gate("market_list_item") === null, "only a list of keys can pause");
});
