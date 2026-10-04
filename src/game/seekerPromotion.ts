// Seeker Promote All (Founder 2026-10-03): a Star Up costs exact zero-star duplicates plus a small
// Gold fee. This preview mirrors heroloop_api.seeker_hero_promote_all
// (selfhosted/postgres/migrations/20261003230000_seeker_gold_promote_all.sql): the server repeats the
// same walk over the same targets and refuses the call if its Gold total differs from the one shown.
import { HERO_MAP, RARITY_INDEX } from '@/game/heroes';
import { teamPower } from '@/game/engine';
import { MAX_HERO_STARS, starUpCost } from '@/game/state';
import type { GameState, Rarity } from '@/game/types';

// Provisional Gold per star = base x next star; rebalanced later by rarity and star band.
export const SEEKER_STAR_GOLD_BASE: Partial<Record<Rarity, number>> = {
  common: 5, uncommon: 10, rare: 25, epic: 50, legendary: 100, mythic: 200, cosmic: 400, divine: 800, celestial: 1500,
};
const MAX_TARGETS = 45;

export function seekerStarGoldCost(rarity: Rarity, nextStar: number): number | null {
  const base = SEEKER_STAR_GOLD_BASE[rarity];
  return base === undefined ? null : base * nextStar;
}

export interface SeekerPromotionStep { uid: string; heroId: string; from: number; to: number; gold: number }
export interface SeekerPromotionPlan { targets: string[]; steps: SeekerPromotionStep[]; gold: number; stars: number; copies: number }

type PlanState = Pick<GameState, 'ownedHeroes' | 'inventory' | 'team' | 'trainingCamp' | 'gold'>;

/** onlyUid limits the plan to one hero (its own Star Up), promoted as far as copies and Gold allow. */
export function planSeekerPromotion(state: PlanState, onlyUid?: string): SeekerPromotionPlan {
  const heroes = state.ownedHeroes;
  const team = new Set(state.team);
  const training = new Set(state.trainingCamp.heroUids.filter((uid): uid is string => Boolean(uid)));
  // One target per hero kind: the strongest affordable, eligible copy, best rarity first.
  const kinds = [...new Set(heroes.map((hero) => hero.heroId))].filter((heroId) => HERO_MAP[heroId]);
  const only = onlyUid ? heroes.find((hero) => hero.uid === onlyUid && HERO_MAP[hero.heroId] && hero.stars < MAX_HERO_STARS) : undefined;
  const targetGroups = onlyUid ? (only ? [[only]] : []) : kinds.map((heroId) => {
    return heroes.map((hero, index) => ({ hero, index }))
      .filter(({ hero }) => hero.heroId === heroId && hero.stars < MAX_HERO_STARS)
      .map((entry) => ({ ...entry, power: teamPower([entry.hero], state.inventory) }))
      .sort((a, b) => b.power - a.power || b.hero.level - a.hero.level || b.hero.stars - a.hero.stars || a.index - b.index)
      .map(({ hero }) => hero);
  }).filter((group) => group.length > 0)
    .sort((a, b) => RARITY_INDEX[HERO_MAP[b[0].heroId].rarity] - RARITY_INDEX[HERO_MAP[a[0].heroId].rarity]);

  let budget = Math.max(0, Math.floor(state.gold));
  const steps: SeekerPromotionStep[] = [];
  let consumed = 0;
  for (const group of targetGroups) {
    if (steps.length >= MAX_TARGETS) break;
    const spareCopies = heroes.filter((hero) => hero.heroId === group[0].heroId && hero.stars === 0
      && !hero.locked && !team.has(hero.uid) && !training.has(hero.uid));
    const target = group.find((hero) => {
      const rarity = HERO_MAP[hero.heroId].rarity;
      const cost = seekerStarGoldCost(rarity, hero.stars + 1);
      const copies = spareCopies.filter((copy) => copy.uid !== hero.uid).length;
      return cost !== null && budget >= cost && copies >= starUpCost(hero.stars, rarity).dupes;
    });
    if (!target) continue;
    const rarity = HERO_MAP[target.heroId].rarity;
    let copies = spareCopies.filter((hero) => hero.uid !== target.uid).length;
    let stars = Math.max(0, Math.min(MAX_HERO_STARS, Math.floor(target.stars)));
    const from = stars;
    let gold = 0;
    while (stars < MAX_HERO_STARS) {
      const required = starUpCost(stars, rarity).dupes;
      const cost = seekerStarGoldCost(rarity, stars + 1);
      if (cost === null || budget < cost || copies < required) break;
      copies -= required; consumed += required; budget -= cost; gold += cost; stars += 1;
    }
    if (stars > from) steps.push({ uid: target.uid, heroId: target.heroId, from, to: stars, gold });
  }
  return {
    targets: steps.map((step) => step.uid),
    steps,
    gold: steps.reduce((sum, step) => sum + step.gold, 0),
    stars: steps.reduce((sum, step) => sum + step.to - step.from, 0),
    copies: consumed,
  };
}
