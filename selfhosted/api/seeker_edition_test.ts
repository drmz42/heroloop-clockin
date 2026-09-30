import assert from "node:assert/strict";
import { parseEdition, seekerRefusal } from "./seeker_edition.ts";

Deno.test("standard edition refuses nothing", () => {
  assert.equal(parseEdition(undefined), "standard");
  assert.equal(parseEdition("SEEKER"), "standard");
  for (const action of ["claim", "spend_tokens", "hero_summon", "market_buy_listing"]) {
    assert.equal(seekerRefusal("standard", action, {}), null);
  }
});

Deno.test("seeker edition refuses $HERO commands before state", () => {
  const seeker = parseEdition("seeker");
  for (const action of ["claim", "spend_tokens", "tester_credit_tokens", "tester_credit_gold", "store_buy_item", "market_list_item", "market_buy_listing"]) {
    assert.equal(seekerRefusal(seeker, action, {}), "unavailable_in_seeker_edition");
  }
  assert.equal(seekerRefusal(seeker, "hero_summon", { payment_method: "paid" }), "unavailable_in_seeker_edition");
  assert.equal(seekerRefusal(seeker, "hero_summon", { payment_method: "scroll" }), null);
  for (const action of ["game_state_load", "normal_combat_complete", "quest_claim", "chest_open", "market_cancel_listing"]) {
    assert.equal(seekerRefusal(seeker, action, {}), null);
  }
});
