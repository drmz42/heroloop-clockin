import { automaticHealingConfig } from './automatic-healing.mjs';

export const ORDINARY_POTION_POLICY = 'ordinary-potion-v1';
export const ORDINARY_POTION_BALANCE_VERSION = 'seeker-200-2026.10.09-v1-combat-effects-v2-ordinary-potion-v1';
export const ORDINARY_POTION_PRICE = 3;

// Context comes from a private server table, never from the player's save payload.
export function ordinaryPotionSession(context, config, startedAtMs, stock, gold) {
  const timers = structuredClone(context ?? {});
  const purchases = [], ticks = [];
  const autoBuy = automaticHealingConfig(config).autoBuy;
  function step(units, elapsedMs, allowDrink = true) {
    const clock = startedAtMs + elapsedMs;
    return units.map(unit => {
      if (unit.side !== 'hero') return unit;
      const timer = timers[unit.uid] ?? { cooldown_until_ms: 0, buff: null };
      timers[unit.uid] = timer;
      if (!unit.alive) { timer.buff = null; return unit; }
      let hp = unit.hp;
      const buff = timer.buff;
      if (buff) {
        while (buff.ticks < 4 && buff.next_ms <= clock) {
          const promised = Math.floor(buff.total * (buff.ticks + 1) / 4) - Math.floor(buff.total * buff.ticks / 4);
          const amount = Math.max(0, Math.min(unit.maxHp - hp, promised));
          hp += amount;
          if (amount > 0) ticks.push({ elapsedMs, kind: 'potion', targetUid: unit.uid, amount });
          buff.ticks++; buff.next_ms += 5000;
        }
        if (buff.ticks === 4) timer.buff = null;
      }
      if (allowDrink && hp <= unit.maxHp * .5 && !timer.buff && clock >= timer.cooldown_until_ms) {
        const fromStock = stock > 0;
        if (fromStock || (autoBuy && gold >= ORDINARY_POTION_PRICE)) {
          if (fromStock) stock--; else gold -= ORDINARY_POTION_PRICE;
          purchases.push({ elapsed_ms: elapsedMs, hero_uid: unit.uid, tier: 'xs', hp_restore: unit.maxHp,
            from_stock: fromStock, gold_cost: fromStock ? 0 : ORDINARY_POTION_PRICE });
          timer.cooldown_until_ms = clock + 30000;
          timer.buff = { total: unit.maxHp, ticks: 0, next_ms: clock + 5000 };
        }
      }
      return { ...unit, hp };
    });
  }
  return { step, timers, purchases, ticks };
}
