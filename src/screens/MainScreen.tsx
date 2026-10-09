import { type PremiumPotionEvent } from '@/components/PremiumPotions';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { BattleSettings } from '@/components/BattleSettings';
import { EventMenuCards } from '@/components/SeekerEvents';
import { readyEventCount, type EventTab, type SeekerEventsApi } from '@/game/useSeekerEvents';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice, useSkrRate } from '@/game/skrPurchase';
import { editionStorageKey, isolatedHackathon } from '../game/editionStorage';
import { goldHealingEnabled } from '../../managed/functions/player-sync/automatic-healing.mjs';
import { currentTutorialObjective, readyQuestCount, tutorialProgress } from '@/game/tutorialProgress';
import { TUTORIAL_GO_EVENT, tutorialDestination, tutorialGuide } from '@/game/tutorialGuide';
import { Fragment, useCallback, useEffect, useState, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { isAndroidLayout } from '@/platform/platform';
import { SEEKER_SAMPLE_INCOME } from '@/game/seekerSampleIncome';
import { MINE_OPEN_EVENT, SEEKER_TOUR_EVENT, seekerTourSeen } from '@/game/seekerTour';
import { COMMANDER_OPEN_EVENT, BATTLE_ACTIONS_SLOT, OVERLAYS_CLOSE_EVENT } from '@/components/GameProgressBar';
import { Package, PackageMinus, FlaskConical, Lock as LockIcon, Star, X, Coins, CheckCircle2, Circle, ArrowUpDown, Wand2, ChevronDown, ChevronLeft, ChevronRight, Sparkles, Info, Settings2, Rocket, DoorOpen, Menu, HeartPulse, Gem, Skull, BookOpen, ArrowRight } from 'lucide-react';
import { Arena, locationArtStyle } from '@/components/Arena';
import { CombatErrorBoundary } from '@/components/CombatErrorBoundary';
import { HeroPortrait } from '@/components/HeroPortrait';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { RarityFx } from '@/components/RarityFx';
import { ItemActionPanel } from '@/components/ItemActionPanel';
import { buildLocation, canMineTokens, equippedEnchantResonance, equippedSetBonus, getEquippedItems, heroStats, locationUnlockLevel, locationLevelRange, LOCATION_RANGES, SET_BONUS_PERCENT, teamPower as calculateHeroPower } from '@/game/engine';
import { ENCHANT_RESONANCE_PERCENT } from '@/game/enchant';
import { formatNum, accountXpForLevel, accountXpProgress, heroXpForLevel, inventoryCapacity } from '@/game/state';
import { ITEM_MAP, SLOT_LABEL, POTIONS, sellValue, meetsItemLevelRequirement, canClassEquipItem, standardChestWeights } from '@/game/items';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, CLASS_LABEL, RARITY_INDEX } from '@/game/heroes';
import type { TokenomicsApi } from '@/game/useTokenomics';
import type { TokenomicsStatus } from '@/game/useTokenomics';
import { bagItemCount, type GameApi } from '@/game/useGame';
import { InventoryFullModal } from '@/components/InventoryFullModal';
import type { CombatUnit, FloatingNumber, HeroClass, ItemSlot, OwnedItem, PotionTier } from '@/game/types';
import { ItemArtwork } from '@/components/ItemArtwork';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { AccountBonusPassives, RewardBoostTile } from '@/components/RewardBoost';
import { ChestCollectIcon } from '@/components/ChestCollectIcon';
import { GoldIcon } from '@/components/GoldIcon';
import { SeekerQuestChallenge, SeekerQuests } from '@/components/SeekerQuests';
import { useSeekerQuests } from '@/game/useSeekerQuests';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { ClassGlyph } from '@/components/ClassGlyph';
import { PartnerQuests } from '@/components/PartnerQuests';
import { FantasyBagIcon } from '@/components/FantasyBagIcon';
import { recommendedTeamPower } from '@/game/balance';
import { playerSync, authClient, lastRetryAfterSeconds } from '@/game/backend';
import { groupNumber, groupDigits } from '@/game/numberFormat';
import { versionedAsset } from '@/game/assetVersion';
import { BattleAmbience } from '@/components/BattleAmbience';
import { ActionFx } from '@/theme/motion/ActionFx';
import { flyCoins } from '@/theme/motion/flyCoins';
import { installGameAudio, playSfx } from '@/audio/gameAudio';
import { BossIntro } from '@/theme/motion/BossIntro';
import { useAndroidOverlayHistory } from '@/platform/useAndroidOverlayHistory';

const SAVE_KEY = editionStorageKey('afk-heroes-save-v7');
// Temporarily hide the first-use dialog for hackathon start-of-game recordings.
// Restore this flag after recording; keep consent and the settings entry intact.
const SHOW_HACKATHON_HEALING_INTRODUCTION = false;

const SLOTS: ItemSlot[] = ['class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'];
// Short slot names so all eight fit under the gear row at the small text tier.
const EQUIPPED_SLOT_LABEL: Partial<Record<ItemSlot, string>> = { class_weapon: 'Weapon', offhand: 'Offhand', helmet: 'Helm', chest: 'Chest', gloves: 'Gloves', boots: 'Boots', ring: 'Ring', amulet: 'Amulet' };
const GRID_SIZE = 64;

function CombatPresentationLayer({ game, activeDungeon, dungeonUnits, dungeonFloaters, dungeonBossScene, dungeonRoom }: {
  game: GameApi;
  activeDungeon: DungeonCheckpoint | null;
  dungeonUnits: CombatUnit[];
  dungeonFloaters: FloatingNumber[];
  dungeonBossScene: Parameters<typeof Arena>[0]['dungeonBossScene'];
  dungeonRoom: Parameters<typeof Arena>[0]['dungeonRoom'];
}) {
  const { units, floaters, potionFx } = useSyncExternalStore(
    game.subscribeCombatPresentation,
    game.getCombatPresentationSnapshot,
    game.getCombatPresentationSnapshot,
  );
  return (
    <>
      {!activeDungeon && potionFx && <div key={potionFx.born} className="absolute inset-0 pointer-events-none anim-fade" style={{ background: 'radial-gradient(circle at 50% 70%, rgba(74,222,128,0.15), transparent 60%)' }} />}
      <Arena units={activeDungeon ? dungeonUnits : units} floaters={activeDungeon ? dungeonFloaters : floaters} ownedHeroes={game.state.ownedHeroes} inventory={game.state.inventory} potionFx={activeDungeon ? null : potionFx} respawnCountdowns={activeDungeon ? {} : game.respawnCountdowns} animationMode={game.state.battleAnimationMode} dungeonPanelOpen={Boolean(activeDungeon)} locationId={activeDungeon ? undefined : game.state.currentLocation} dungeonBossScene={dungeonBossScene} dungeonRoom={dungeonRoom} />
    </>
  );
}
const TUTORIAL_QUESTS = [
  ['defeat-10-enemies', 'Defeat 10 enemies', 10, '10 Tutorial Chests'],
  ['open-10-tutorial-chests', 'Open 10 Tutorial Chests', 10, '500 Gold'],
  ['equip-active-hero', 'Equip one item on an active hero', 1, '2 Summon Scrolls'],
  ['summon-two-heroes', 'Summon two heroes', 2, '1 Summon Scroll'],
  ['fill-active-formation', 'Fill the three-hero Active Formation', 3, '3 XS Potions'],
  ['summon-reserve-hero', 'Summon one reserve hero', 3, '500 Gold'],
  ['defeat-25-enemies', 'Defeat 25 enemies', 25, '3 XS Potions'],
  ['enable-auto-pot', 'Enable Auto-pot', 1, '1 Boss Key'],
  ['defeat-50-enemies', 'Defeat 50 enemies', 50, `${groupNumber(1000)} Gold`],
  ['defeat-tutorial-boss', 'Use the granted key and defeat one summoned Boss', 1, '1 Summon Scroll'],
] as const;
const DUNGEON_BOSS_ART: Record<string, string> = { 'iron-warden': 'boss-titan', 'ash-warlock': 'boss-lich', 'thorn-shaman': 'boss-ogre', 'rift-behemoth': 'boss-dragon', 'grave-necromancer': 'boss-lich' };

type DungeonCheckpoint = {
  type: 'dungeon' | 'boss_hunt'; encounter_id: string; boss_encounter_id?: string; depth: number; room: number; revision: number;
  roster_snapshot?: Array<{ uid: string; hero_id: string; stats?: Record<string, number> }>;
  run_state?: { heroes?: DungeonUnitState[]; rooms_cleared?: number; tutorial_boss?: boolean };
  room_state: null | { status: string; kind?: string; choice?: string; modifier?: string; heroes?: DungeonUnitState[]; enemies?: DungeonUnitState[]; boss?: { boss_id: string; name: string; status: string; current_hp?: number; max_hp?: number }; reward_preview?: { summon_scrolls?: number; dungeon_chests?: number; settled?: boolean; reward_table_version?: string }; playback_tick?: number; elapsed_ms?: number; premium_potion_events?: PremiumPotionEvent[]; heavy_target_uid?: string; heavy_casts?: number; identity_ability?: string; identity_casts?: number };
};
type DungeonUnitState = {
  uid?: string; unit_id?: string; position?: number; lane?: number; current_hp: number; max_hp: number; alive: boolean;
  atk?: number; def?: number; speed?: number; attack_speed_bonus?: number; heavy_damage_taken?: number;
};

// The Arena unit uid for a server enemy; combat playback pulses must target and attribute the same uids.
function dungeonEnemyUid(room: number, roomState: DungeonCheckpoint['room_state'], unit: DungeonUnitState, position: number): string {
  const sharedBossPhase = roomState?.kind === 'shared_boss';
  if (sharedBossPhase && String(unit.unit_id ?? '').startsWith('shared-boss-')) return `${DUNGEON_BOSS_ART[roomState?.boss?.boss_id ?? ''] ?? 'boss-lich'}-dungeon-shared`;
  if (sharedBossPhase && String(unit.unit_id ?? '').startsWith('necromancer-summon-')) return `e${position}-skeleton`;
  return `e${position}-${room === 2 ? 'boss-ogre' : room === 3 ? 'skeleton' : room === 4 ? 'goblin' : 'orc'}`;
}

type DungeonRoomState = NonNullable<DungeonCheckpoint['room_state']>;
type DungeonPlaybackFrame = { heroes: DungeonUnitState[]; enemies: DungeonUnitState[]; pulses: Array<Omit<FloatingNumber, 'id' | 'born'>> };
type PlaybackFighter = {
  side: 'hero' | 'enemy'; index: number; uid: string; lane: number; boss: boolean; strikes: Set<number>;
  unit: DungeonUnitState; startHp: number; spawn: number; death: number;
};

// The server resolves a Dungeon room in one call and returns only the end state, so playback stages it: each
// fighter strikes on its own beat (every third frame, staggered), deaths are spread through the fight, and each
// target's authoritative HP loss is split over the hits it actually receives. Every hit names its attacker so
// the Arena plays the lunge. The last frame always equals the server result.
function planDungeonPlayback(room: number, start: DungeonRoomState, final: DungeonRoomState, frames: number): DungeonPlaybackFrame[] {
  const period = 3;
  // Personal cooldowns: a fighter swings about every third frame, faster or slower with its speed and a stable
  // per-fighter variation, from its own starting phase, so the party never strikes in lockstep.
  const seed = (key: string, salt: number) => {
    let hash = 2166136261 ^ salt;
    for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return ((hash >>> 0) % 1000) / 1000;
  };
  const strikeFrames = (key: string, speed: number | undefined, from: number) => {
    const cooldown = Math.max(2, period * (100 / Math.max(50, Math.min(200, Number(speed) || 100))) * (0.8 + seed(key, 1) * 0.45));
    const result = new Set<number>();
    for (let time = from + 0.5 + seed(key, 2) * cooldown; time <= frames; time += cooldown) result.add(Math.max(from + 1, Math.ceil(time)));
    return result;
  };
  const bossFight = start.kind === 'shared_boss';
  const heroes: PlaybackFighter[] = (final.heroes ?? []).map((unit, index) => {
    const before = (start.heroes ?? []).find((candidate) => candidate.uid === unit.uid) ?? start.heroes?.[index];
    return {
      side: 'hero', index, uid: unit.uid ?? `dungeon-hero-${index}`, lane: Number(unit.position ?? index), boss: false,
      strikes: strikeFrames(unit.uid ?? `hero-${index}`, unit.speed, 0),
      unit, startHp: Number(before?.current_hp ?? unit.current_hp), spawn: before && !before.alive ? frames + 1 : 0, death: frames + 1,
    };
  });
  const enemies: PlaybackFighter[] = (final.enemies ?? []).map((unit, index) => {
    const before = (start.enemies ?? []).find((candidate) => candidate.unit_id === unit.unit_id);
    const summonWave = !before && bossFight ? (String(unit.unit_id ?? '').startsWith('necromancer-summon-2') ? 0.6 : 0.3) : 0;
    return {
      side: 'enemy', index, uid: dungeonEnemyUid(room, final, unit, index), lane: Number(unit.lane ?? index),
      boss: String(unit.unit_id ?? '').startsWith('shared-boss-'), strikes: new Set<number>(),
      unit, startHp: Number(before?.current_hp ?? unit.max_hp), spawn: Math.round(frames * summonWave), death: before && !before.alive ? 0 : frames + 1,
    };
  });
  // Fighters who fall in this fight go down one after another instead of all on the last frame.
  for (const fighter of enemies) {
    // The Boss keeps the fixed beat its cast bars are drawn on; guards and summons get personal cooldowns.
    fighter.strikes = fighter.boss
      ? new Set(Array.from({ length: frames }, (_, frame) => frame + 1).filter((frame) => (frame + 1) % period === 0))
      : strikeFrames(String(fighter.unit.unit_id ?? fighter.uid), fighter.unit.speed, fighter.spawn);
  }
  // When the other side is wiped out, this side's losses land before that final kill.
  for (const [side, foes] of [[heroes, enemies], [enemies, heroes]] as const) {
    const falling = side.filter((fighter) => !fighter.unit.alive && fighter.death > frames && fighter.spawn <= frames);
    const last = foes.some((foe) => foe.unit.alive) ? frames : frames - period;
    falling.forEach((fighter, order) => {
      const earliest = Math.max(fighter.spawn + period, Math.round(frames * 0.4));
      fighter.death = Math.min(frames, Math.max(earliest, Math.round(earliest + (last - earliest) * (order + 1) / falling.length)));
    });
  }
  const canAct = (fighter: PlaybackFighter, frame: number) => frame > fighter.spawn && frame < fighter.death;
  const canBeHit = (fighter: PlaybackFighter, frame: number) => frame > fighter.spawn && frame <= fighter.death;
  const chooseTarget = (attacker: PlaybackFighter, frame: number) => {
    const foes = (attacker.side === 'hero' ? enemies : heroes).filter((foe) => canBeHit(foe, frame));
    const guards = foes.filter((foe) => !foe.boss);
    return guards.find((foe) => foe.lane === attacker.lane) ?? guards[0] ?? foes.find((foe) => foe.lane === attacker.lane) ?? foes[0];
  };

  type Hit = { frame: number; source?: PlaybackFighter; heavy?: boolean };
  const hits = new Map<PlaybackFighter, Hit[]>();
  for (let frame = 1; frame <= frames; frame += 1) {
    for (const attacker of [...heroes, ...enemies]) {
      if (!canAct(attacker, frame) || !attacker.strikes.has(frame)) continue;
      const target = chooseTarget(attacker, frame);
      if (target) hits.set(target, [...(hits.get(target) ?? []), { frame, source: attacker }]);
    }
  }

  const changes = new Map<PlaybackFighter, Array<{ frame: number; value: number; heal: boolean; crit: boolean; source?: PlaybackFighter }>>();
  const boss = enemies.find((fighter) => fighter.boss);
  for (const fighter of [...heroes, ...enemies]) {
    if (fighter.spawn > frames) continue;
    const net = Math.round(fighter.startHp - Number(fighter.unit.current_hp));
    const list: Array<{ frame: number; value: number; heal: boolean; crit: boolean; source?: PlaybackFighter }> = [];
    if (net < 0) {
      // Healing (Druid growth, Recovery) arrives in a few soft pulses.
      const beats = [0.25, 0.5, 0.75, 1].map((share) => Math.max(fighter.spawn + 1, Math.round(frames * share)));
      beats.forEach((frame, order) => list.push({ frame, value: Math.floor(-net / 4) + (order < -net % 4 ? 1 : 0), heal: true, crit: false }));
    } else if (net > 0) {
      let damage = net;
      const lastFrame = Math.min(frames, fighter.death);
      let received = (hits.get(fighter) ?? []).filter((hit) => hit.frame <= lastFrame);
      const heavy = bossFight && boss && fighter.side === 'hero' && fighter.unit.uid === final.heavy_target_uid
        ? Math.min(damage, Math.max(0, Math.round(Number(fighter.unit.heavy_damage_taken ?? 0)))) : 0;
      if (heavy > 0) {
        damage -= heavy;
        list.push({ frame: Math.min(15, lastFrame), value: heavy, heal: false, crit: true, source: boss });
      }
      if (received.length === 0 || (fighter.death <= frames && !received.some((hit) => hit.frame === fighter.death))) {
        // A target the staged duel never reached still shows its loss, and a falling fighter takes the last blow.
        const foe = (fighter.side === 'hero' ? enemies : heroes).find((candidate) => canAct(candidate, lastFrame)) ?? (fighter.side === 'hero' ? boss : undefined);
        // Move a recent strike to the killing blow instead of adding a second fast swing.
        received = [...received.filter((hit) => hit.source !== foe || hit.frame < lastFrame - 1), { frame: lastFrame, source: foe }];
      }
      received.forEach((hit, order) => {
        const value = Math.floor(damage / received.length) + (order < damage % received.length ? 1 : 0);
        if (value > 0) list.push({ frame: hit.frame, value, heal: false, crit: hit.source?.side === 'hero' && order % 5 === 4, source: hit.source });
      });
    }
    changes.set(fighter, list);
  }

  const timeline: DungeonPlaybackFrame[] = [];
  const spent = new Map<PlaybackFighter, number>();
  for (let frame = 1; frame <= frames; frame += 1) {
    const pulses: DungeonPlaybackFrame['pulses'] = [];
    const snapshot = (fighter: PlaybackFighter): DungeonUnitState => {
      for (const change of changes.get(fighter) ?? []) {
        if (change.frame !== frame) continue;
        spent.set(fighter, (spent.get(fighter) ?? 0) + (change.heal ? -change.value : change.value));
        pulses.push({ sourceUid: change.source?.uid, targetUid: fighter.uid, value: change.value, crit: change.crit, heal: change.heal });
      }
      if (frame === frames) return fighter.unit;
      const hp = Math.max(0, Math.min(Number(fighter.unit.max_hp), Math.round(fighter.startHp - (spent.get(fighter) ?? 0))));
      return { ...fighter.unit, current_hp: hp, alive: frame < fighter.death && hp > 0 };
    };
    timeline.push({
      heroes: heroes.map(snapshot),
      enemies: enemies.filter((fighter) => frame > fighter.spawn || frame === frames).map(snapshot),
      pulses,
    });
  }
  return timeline;
}
type DungeonStatus = {
  attempts_remaining: number; attempts_max: number; next_reset_at: string; account_level: number;
  unlocks: { depth_1: boolean; depth_2: boolean; depth_3: boolean };
  active_encounter: DungeonCheckpoint | { type: 'boss_hunt'; boss_encounter_id?: string; legacy_unresumable: true } | null;
};

const DUNGEON_PREVIEW_STATS: Record<number, Record<number, { hp: number; atk: number; def: number; speed: number }>> = {
  1: { 1: { hp: 618, atk: 58, def: 19, speed: 99.63 }, 2: { hp: 2372, atk: 214, def: 78, speed: 102.888 }, 3: { hp: 6759, atk: 585, def: 272, speed: 102.888 } },
  2: { 1: { hp: 649, atk: 61, def: 20, speed: 99.63 }, 2: { hp: 2491, atk: 225, def: 82, speed: 102.888 }, 3: { hp: 7097, atk: 614, def: 286, speed: 102.888 } },
  4: { 1: { hp: 371, atk: 15, def: 14, speed: 99.63 }, 2: { hp: 1423, atk: 54, def: 59, speed: 102.888 }, 3: { hp: 4055, atk: 146, def: 204, speed: 102.888 } },
};

function dungeonPreviewEnemies(checkpoint: DungeonCheckpoint, heroes: DungeonUnitState[]): DungeonUnitState[] {
  const base = DUNGEON_PREVIEW_STATS[checkpoint.room]?.[checkpoint.depth];
  if (!base) return [];
  // The first Tutorial Boss Hunt is weakened on the server (20% HP, 40% ATK, 50% DEF);
  // show the same numbers before the room starts.
  const tutorial = checkpoint.run_state?.tutorial_boss === true;
  const stats = tutorial ? { ...base, hp: Math.max(1, Math.round(base.hp * 0.2)), atk: Math.max(1, Math.round(base.atk * 0.4)), def: Math.round(base.def * 0.5) } : base;
  return heroes.filter((hero) => hero.alive).map((hero, index) => ({
    unit_id: `preview-${checkpoint.room}-${hero.position ?? index}`,
    lane: hero.position ?? index,
    current_hp: stats.hp,
    max_hp: stats.hp,
    atk: stats.atk,
    def: stats.def,
    speed: stats.speed,
    alive: true,
  }));
}

const EQUIPMENT_ERROR_LABELS: Record<string, string> = {
  duplicate_equipment_assignment: 'Saved gear conflict',
  hero_not_active: 'Hero is not in the active team',
  hero_not_found: 'Hero data mismatch',
  item_not_found: 'Item was not found on the server',
  item_state_mismatch: 'Item data mismatch',
  item_level_required: 'Requires a higher Account Level',
  item_slot_mismatch: 'Wrong equipment slot',
  item_class_mismatch: 'Wrong hero class',
  item_capacity_exceeded: 'Inventory is full',
  invalid_server_response: 'Invalid server response',
};

const PRODUCT_CLASS_KEY: Record<HeroClass, string> = {
  shepherd: 'mage', assassin: 'assassin', knight: 'warrior', druid: 'druid', archer: 'crossbowman',
};

function emptySlotArtworkId(slot: ItemSlot, heroClass: HeroClass): string {
  const classKey = PRODUCT_CLASS_KEY[heroClass];
  if (slot === 'class_weapon') return `weapon-${classKey}-common`;
  if (slot === 'offhand') return `offhand-${classKey}-common`;
  if (slot === 'chest') return 'armor-common';
  return `${slot}-common`;
}

export function MainScreen({ game, tokenomics, onBoostClick, onGuidesClick, onRewardBoostClick, onQuestsClick, events, onEventsOpen, eventsMenuOpen, onEventsMenuOpen }: { game: GameApi; tokenomics: TokenomicsApi; onBoostClick: () => void; onGuidesClick: () => void; onRewardBoostClick: () => void; onQuestsClick?: () => void; events?: SeekerEventsApi; onEventsOpen?: (tab: EventTab) => void; eventsMenuOpen?: boolean; onEventsMenuOpen?: (open: boolean) => void }) {
  const { state, battleResult, respawnCountdowns, paused, setPaused } = game;
  const tok = tokenomics;
  const accountXpCurrent = accountXpProgress(state.accountXp, state.accountLevel);
  const battleAnimationLabel = state.battleAnimationMode === 'spectacular' ? 'Maximum' : state.battleAnimationMode === 'light' ? 'Medium' : 'Minimum';
  const [banner, setBanner] = useState<typeof battleResult>(null);
  const [showPotSettings, setShowPotSettings] = useState(false);
  const [showBattleSettings, setShowBattleSettings] = useState(false);
  // Seeker (Founder 2026-10-09): the top bar's Events plate owns this menu; elsewhere the battle burger does.
  const [localBattleMenuOpen, setLocalBattleMenuOpen] = useState(false);
  const battleMenuOpen = onEventsMenuOpen ? Boolean(eventsMenuOpen) : localBattleMenuOpen;
  const setBattleMenuOpen = onEventsMenuOpen ?? setLocalBattleMenuOpen;
  const eventsReady = readyEventCount(events?.status ?? null);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [autoGearNotice, setAutoGearNotice] = useState<string | null>(null);
  const autoGearNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (autoGearNoticeTimer.current) clearTimeout(autoGearNoticeTimer.current); }, []);
  const [toast, setToast] = useState<string | null>(null);
  const [showInventoryFull, setShowInventoryFull] = useState(false);
  const closeInventoryFull = useCallback(() => setShowInventoryFull(false), []);
  const [tutorialClaimBusy, setTutorialClaimBusy] = useState(false);
  const [tutorialFinished, setTutorialFinished] = useState(false);
  const [tutorialClaimError, setTutorialClaimError] = useState('');
  const [showBulkSellConfirm, setShowBulkSellConfirm] = useState(false);
  const [inventoryLockMode, setInventoryLockMode] = useState(false);
  const [inventoryTab, setInventoryTab] = useState<1 | 2 | 3 | 4 | 'resources'>(1);
  const [bagQuote, setBagQuote] = useState<Awaited<ReturnType<GameApi['quoteInventoryBag']>>>(null);
  const bagSkrRate = useSkrRate(isolatedHackathon && Boolean(bagQuote));
  // Summons and claimed lifetime milestones move the Seeker quest counters and the challenge bar.
  const seekerQuestBoard = useSeekerQuests(isolatedHackathon, game.claimQuest, `${state.summons}:${state.milestoneQuests.map((quest) => quest.id).join()}`);
  const [bagPurchaseConfirm, setBagPurchaseConfirm] = useState(false);
  const [bagPurchaseBusy, setBagPurchaseBusy] = useState(false);
  const bagSlotsKey = state.bagSlots.join(',');
  const bagQuoteReady = Number.isSafeInteger(game.serverRevisionHint);
  const [selectedResource, setSelectedResource] = useState<'summon-scroll' | 'boss-key' | 'chests' | null>(null);
  const [showDropRates, setShowDropRates] = useState(false);
  const dropRatesButtonRef = useRef<HTMLButtonElement>(null);
  const [dropRatesPos, setDropRatesPos] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);
  const [showZoomTip, setShowZoomTip] = useState(true);
  const [showHeroDetails, setShowHeroDetails] = useState(false);
  const [showDungeonInfo, setShowDungeonInfo] = useState(false);
  // Runs entered in this session play through on their own; a run restored on load waits for one press.
  const dungeonAutoRun = useRef(false);
  const [activeDungeon, setActiveDungeon] = useState<DungeonCheckpoint | null>(null);
  const [dungeonFloaters, setDungeonFloaters] = useState<FloatingNumber[]>([]);
  const [dungeonCompletion, setDungeonCompletion] = useState<{ won: boolean; depth: number; kind: 'dungeon' | 'boss_hunt'; gold: number; scrolls: number; premium: number } | null>(null);
  const [dungeonAttempts, setDungeonAttempts] = useState<{ remaining: number; max: number } | null>(null);
  const dungeonPreviousPause = useRef<boolean | null>(null);
  const [selectedHeroUid, setSelectedHeroUid] = useState<string | null>(state.team[0] ?? null);
  const [selectedItem, setSelectedItem] = useState<OwnedItem | null>(null);
  const [selectedItemSource, setSelectedItemSource] = useState<'bag' | 'hero' | null>(null);
  const [selectedItemSlot, setSelectedItemSlot] = useState<ItemSlot | null>(null);
  const locationRailRef = useRef<HTMLDivElement>(null);
  const [locationsExpanded, setLocationsExpanded] = useState(!isolatedHackathon);

  useEffect(() => {
    if (!bagQuoteReady) return undefined;
    let active = true;
    void game.quoteInventoryBag().then((quote) => { if (active) setBagQuote(quote); });
    return () => { active = false; };
  }, [game.quoteInventoryBag, bagQuoteReady, bagSlotsKey]);

  useEffect(() => {
    // The banner keeps its own snapshot: the next wave clears battleResult
    // within ~250ms, which must not cut the reward tile short.
    if (battleResult) setBanner(battleResult);
  }, [battleResult]);

  useEffect(() => installGameAudio(), []);

  // Tutorial Chests open only when every item fits; otherwise explain the full bag instead of doing nothing.
  const openTutorialChestsChecked = (count: 1 | 10) => {
    if (inventoryCapacity(state) - bagItemCount(state) < count) { playSfx('error'); setShowInventoryFull(true); return; }
    void game.openTutorialChests(count);
  };

  // Victory/defeat sting only while the battle is on screen (other tabs overlay the live arena).
  useEffect(() => {
    if (!banner || document.querySelector('.game-window-overlay') || !document.querySelector('.arena-stage-inner')?.getClientRects().length) return;
    playSfx(banner.win ? 'victory' : 'defeat');
    if (banner.win && (banner.gold > 0 || banner.chest)) window.setTimeout(() => playSfx('coin'), 380);
  }, [banner]);

  const lastAccountLevel = useRef(state.accountLevel);
  useEffect(() => {
    if (state.accountLevel > lastAccountLevel.current) playSfx('levelUp');
    lastAccountLevel.current = state.accountLevel;
  }, [state.accountLevel]);

  useEffect(() => {
    if (!banner) return undefined;
    const t = setTimeout(() => setBanner(null), 2600);
    return () => clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    if (!showDropRates) { setDropRatesPos(null); return undefined; }
    // The popup is portalled to <body>, so anchor it to the button's viewport rectangle.
    const place = () => {
      const rect = dropRatesButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDropRatesPos({
        // Keep the 224px-wide popup inside the screen even when the button sits left of centre.
        right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 232)),
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: Math.max(120, rect.top - 16),
      });
    };
    place();
    // A tap anywhere else (another tab, the battle) closes the popup; it is portalled, so it would otherwise stay open.
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (dropRatesButtonRef.current?.contains(target) || (target instanceof Element && target.closest('[aria-label="Chest drop rate"]')))) return;
      setShowDropRates(false);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [showDropRates]);

  useEffect(() => {
    if (selectedHeroUid && !state.team.includes(selectedHeroUid)) setSelectedHeroUid(state.team[0] ?? null);
  }, [state.team, selectedHeroUid]);

  useEffect(() => {
    void playerSync<DungeonStatus>('dungeon_status').then((status) => {
      if (!status) return;
      setDungeonAttempts({ remaining: status.attempts_remaining, max: status.attempts_max });
      setActiveDungeon(status.active_encounter && 'room' in status.active_encounter ? status.active_encounter : null);
    });
  }, []);

  useEffect(() => {
    if (activeDungeon && dungeonPreviousPause.current === null) {
      dungeonPreviousPause.current = paused;
      setPaused(true);
    } else if (!activeDungeon && dungeonPreviousPause.current !== null) {
      setPaused(dungeonPreviousPause.current);
      dungeonPreviousPause.current = null;
    }
  }, [activeDungeon, paused, setPaused]);

  const enterDungeonArena = (status: DungeonStatus) => {
    const encounter = status.active_encounter && 'room' in status.active_encounter ? status.active_encounter : null;
    setDungeonAttempts({ remaining: status.attempts_remaining, max: status.attempts_max });
    dungeonAutoRun.current = Boolean(encounter);
    setActiveDungeon(encounter);
    if (encounter) setShowDungeonInfo(false);
  };

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };
  // A Boss Hunt that ends changes Boss Keys on the server (a win spends the key for good;
  // a loss during the Tutorial returns it), so re-read the save instead of guessing.
  const handleDungeonChange = async (next: DungeonCheckpoint | null) => {
    const endedBossHunt = next === null && activeDungeon?.type === 'boss_hunt';
    const keysBefore = state.bossKeys;
    if (next && !activeDungeon) dungeonAutoRun.current = true;
    setActiveDungeon(next);
    if (!endedBossHunt) return;
    const refreshed = await playerSync<{ revision: number; state?: { bossKeys?: number } }>('game_state_load');
    if (!refreshed) return;
    game.applyServerRevision(refreshed.revision);
    const keys = refreshed.state?.bossKeys;
    if (typeof keys !== 'number') return;
    game.syncBossKeys(keys);
    if (keys > keysBefore && !state.tutorial.questCompleted) showToast('Boss Key returned · grow stronger and try again');
  };
  const equipmentFailure = (action: string) => {
    const code = game.equipmentError();
    return `${action} failed · ${(EQUIPMENT_ERROR_LABELS[code] ?? code) || 'unknown error'}`;
  };

  const drop = banner?.drop;
  const dropBase = drop ? ITEM_MAP[drop.itemId] : null;
  const hasBattleRewards = Boolean(banner && (banner.gold > 0 || banner.xp > 0 || dropBase || banner.chest));
  const power = game.teamPower();
  const selectedHero = selectedHeroUid ? state.ownedHeroes.find(h => h.uid === selectedHeroUid) : null;
  const selectedHeroBase = selectedHero ? HERO_MAP[selectedHero.heroId] : null;
  const selectedHeroStats = useMemo(
    () => selectedHero ? heroStats(selectedHero, getEquippedItems(selectedHero, state.inventory)) : null,
    [selectedHero, state.inventory],
  );
  const selectedHeroPower = useMemo(
    () => selectedHero ? calculateHeroPower([selectedHero], state.inventory) : 0,
    [selectedHero, state.inventory],
  );
  const selectedSetBonus = useMemo(
    () => selectedHero ? equippedSetBonus(getEquippedItems(selectedHero, state.inventory)) : null,
    [selectedHero, state.inventory],
  );
  // Largest group of equipped items sharing one rarity: progress toward the 8-slot set bonus.
  const selectedSetProgress = useMemo(() => {
    if (!selectedHero) return 0;
    const counts = new Map<string, number>();
    for (const item of getEquippedItems(selectedHero, state.inventory)) {
      const rarity = ITEM_MAP[item.itemId]?.rarity;
      if (rarity) counts.set(rarity, (counts.get(rarity) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
  }, [selectedHero, state.inventory]);
  const selectedEnchantResonance = useMemo(
    () => selectedHero ? equippedEnchantResonance(getEquippedItems(selectedHero, state.inventory)) : null,
    [selectedHero, state.inventory],
  );
  const activeTeamBonuses = useMemo(() => state.team.reduce((totals, uid) => {
    const hero = state.ownedHeroes.find((candidate) => candidate.uid === uid);
    const stats = hero ? heroStats(hero, getEquippedItems(hero, state.inventory)) : null;
    return stats ? { xp: totals.xp + stats.xpBonus, gold: totals.gold + stats.goldBonus } : totals;
  }, { xp: 0, gold: 0 }), [state.team, state.ownedHeroes, state.inventory]);
  const avatarBase = HERO_MAP[state.avatarHeroId] ?? selectedHeroBase ?? HERO_MAP[state.ownedHeroes[0]?.heroId];

  const equippedUids = new Set<string>();
  state.ownedHeroes.forEach(h => { for (const u of Object.values(h.equipped)) { if (u) equippedUids.add(u); } });
  const bagItems = state.inventory.filter(i => !equippedUids.has(i.uid));
  const liveSelectedItem = selectedItem
    ? state.inventory.find((item) => item.uid === selectedItem.uid) ?? null
    : null;
  const liveSelectedBase = liveSelectedItem ? ITEM_MAP[liveSelectedItem.itemId] : null;
  const comparisonItem = selectedItemSource === 'bag' && selectedHero && liveSelectedBase
    ? state.inventory.find((item) => item.uid === selectedHero.equipped[liveSelectedBase.slot]) ?? null
    : null;
  const ordinaryStock = Object.values(state.potions).reduce((sum, count) => sum + count, 0);
  const visiblePotions = isolatedHackathon
    ? ordinaryStock > 0 ? [{ ...POTIONS[0], name: 'Ordinary Potion' }] : []
    : POTIONS.filter((p) => state.potions[p.tier] > 0);
  const resourceSlotCount = 3 + visiblePotions.length;
  const bossChestCount = state.chests.filter((chest) => chest.boss).length;
  const activeBag = inventoryTab === 'resources' ? 1 : inventoryTab;
  const bagStart = state.bagSlots.slice(0, activeBag - 1).reduce((sum, slots) => sum + slots, 0);
  const bagOpenSlots = state.bagSlots[activeBag - 1] ?? 0;
  const cells: (OwnedItem | null)[] = Array.from({ length: GRID_SIZE }).map((_, i) => i < bagOpenSlots ? bagItems[bagStart + i] ?? null : null);
  const bagUsedSlots = Math.min(bagOpenSlots, Math.max(0, bagItems.length - bagStart));
  const unlockedSellTotal = bagItems
    .filter(i => !i.locked)
    .reduce((acc, i) => acc + sellValue(i), 0);
  const selectedEquippedCount = selectedHero ? Object.values(selectedHero.equipped).filter(Boolean).length : 0;
  const canUnequipAll = selectedEquippedCount > 0 && bagItems.length + selectedEquippedCount <= inventoryCapacity(state);
  const selectedBagIndex = selectedItemSource === 'bag' && liveSelectedItem
    ? cells.findIndex((item) => item?.uid === liveSelectedItem.uid)
    : -1;
  const selectedBagRowEnd = selectedBagIndex >= 0 ? Math.floor(selectedBagIndex / 8) * 8 + 7 : -1;
  const chestWeights = standardChestWeights(state.accountLevel, tok.status?.rarity_capacity ?? {});
  const chestWeightTotal = Object.values(chestWeights).reduce((sum, weight) => sum + weight, 0);
  const chestRateRows = Object.entries(chestWeights)
    .filter(([, weight]) => weight > 0)
    .sort(([left], [right]) => RARITY_INDEX[left as keyof typeof RARITY_INDEX] - RARITY_INDEX[right as keyof typeof RARITY_INDEX]);

  const selectedEquipReason: string | undefined = (() => {
    if (selectedItemSource !== 'bag' || !selectedHero || !liveSelectedItem) return undefined;
    const base = ITEM_MAP[liveSelectedItem.itemId];
    if (!base) return undefined;
    if (!state.team.includes(selectedHero.uid)) return 'Hero not in active lineup';
    if (selectedHeroBase && !canClassEquipItem(selectedHeroBase.heroClass, base)) return base.heroClass ? `${CLASS_LABEL[base.heroClass]} only` : 'Wrong class';
    if (!meetsItemLevelRequirement(liveSelectedItem, state.accountLevel)) return `Requires Account Lv ${liveSelectedItem.level}`;
    return undefined;
  })();

  const totalLocations = LOCATION_RANGES.length;
  const nextLocation = state.currentLocation + 1;
  const nextLocationAvailable = nextLocation <= totalLocations
    && nextLocation <= state.highestLocation
    && state.accountLevel >= locationUnlockLevel(nextLocation);

  // Android: Dungeons, Boss and the battle settings live in the burger menu at the stage's top right
  // (Founder 2026-10-03); the web keeps the settings button in the battle HUD.
  const battleSettingsContent = <BattleSettings game={game} onPicked={() => { setShowBattleSettings(false); setBattleMenuOpen(false); }} />;
  const battleSettingsControl = (
    <div className="hl-battle-settings relative">
      <button type="button" onClick={() => setShowBattleSettings((value) => !value)} className="game-control flex h-7 items-center gap-1.5 px-2 ui-text-small font-black uppercase" aria-label={isolatedHackathon ? 'Battle settings' : 'Battle graphics quality settings'} aria-expanded={showBattleSettings}><Settings2 size={14} /><span className="hidden sm:inline">{battleAnimationLabel}</span></button>
      {showBattleSettings && <div className="absolute left-0 top-full z-[111] mt-1 w-56 rounded-lg border border-[#80683f] bg-[#11130f] p-2 shadow-2xl backdrop-blur-sm">{battleSettingsContent}</div>}
    </div>
  );
  const battleMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!battleMenuOpen) return;
    // The top bar's Events plate toggles the menu itself on click.
    const close = (event: PointerEvent) => { if (!battleMenuRef.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.tb-events')) setBattleMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setBattleMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [battleMenuOpen, setBattleMenuOpen]);

  // Opening the collapsed hackathon path scrolls the battle column so the whole path is on screen at once.
  useEffect(() => {
    if (isolatedHackathon && locationsExpanded) document.getElementById('location-progression-path')?.scrollIntoView({ block: 'nearest' });
  }, [locationsExpanded]);

  useEffect(() => {
    if (!locationsExpanded) return;
    const current = locationRailRef.current?.querySelector<HTMLElement>(`[data-location="${state.currentLocation}"]`);
    if (!isolatedHackathon) {
      current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } else if (current && locationRailRef.current) {
      locationRailRef.current.scrollLeft = current.offsetLeft - locationRailRef.current.offsetLeft
        - (locationRailRef.current.clientWidth - current.clientWidth) / 2;
    }
  }, [state.currentLocation, locationsExpanded]);

  const scrollLocations = (direction: -1 | 1) => {
    locationRailRef.current?.scrollBy({ left: direction * 360, behavior: 'smooth' });
  };

  const serverBossKeys = tok.status?.boss_keys;
  const syncBossKeys = game.syncBossKeys;

  useEffect(() => {
    if (serverBossKeys !== undefined) syncBossKeys(serverBossKeys);
  }, [serverBossKeys, syncBossKeys]);

  // Every server refusal used to read "A Boss Key is required" even with keys in the bag; name the real cause.
  const handleSummonBoss = async () => {
    setBattleMenuOpen(false);
    // One request at a time: the server allows 2 Boss summons per 5 minutes, and a second tap spent the allowance.
    if (summonBusyRef.current) return;
    summonBusyRef.current = true;
    try { await summonBossOnce(); } finally { summonBusyRef.current = false; setSummonBusy(false); }
  };
  const summonBusyRef = useRef(false);
  const [summonBusy, setSummonBusy] = useState(false);
  const summonBossOnce = async () => {
    setSummonBusy(true);
    let errorCode = '';
    const result = await tok.summonBoss(state.currentLocation, (code) => { errorCode = code; });
    if (!result) {
      if (errorCode === 'active_encounter_exists') {
        const status = await playerSync<DungeonStatus>('dungeon_status');
        if (status?.active_encounter && 'room' in status.active_encounter) { enterDungeonArena(status); showToast('Resuming your active encounter'); return; }
        showToast('Another Boss or Dungeon fight is still open on the server'); return;
      }
      if (errorCode === 'resource_insufficient_balance') {
        const refreshed = await playerSync<{ revision: number; state?: { bossKeys?: number } }>('game_state_load');
        if (typeof refreshed?.state?.bossKeys === 'number') game.syncBossKeys(refreshed.state.bossKeys);
        showToast('A Boss Key is required'); return;
      }
      if (errorCode === 'rate_limited') {
        const wait = lastRetryAfterSeconds();
        showToast(`Boss summons are limited to 2 per 5 minutes · next in ${wait >= 60 ? `${Math.ceil(wait / 60)} min` : `${wait} s`}`);
        return;
      }
      showToast(`Boss summon failed · ${errorCode || 'try again'}`);
      return;
    }
    game.syncBossKeys(result.remaining_keys);
    const status = await playerSync<DungeonStatus>('dungeon_status');
    if (!status || !status.active_encounter || !('room' in status.active_encounter)) {
      showToast('Boss Hunt resume failed'); return;
    }
    enterDungeonArena(status);
  };

  const dungeonUnits = useMemo<CombatUnit[]>(() => {
    if (!activeDungeon) return [];
    const roomHeroes = activeDungeon.room_state?.heroes ?? activeDungeon.run_state?.heroes ?? [];
    const heroStates: DungeonUnitState[] = roomHeroes.length > 0 ? roomHeroes : (activeDungeon.roster_snapshot ?? []).map((hero, position) => ({
      uid: hero.uid, position, current_hp: Number(hero.stats?.hp ?? 1), max_hp: Number(hero.stats?.hp ?? 1), alive: true,
    }));
    const playbackTick = activeDungeon.room_state?.playback_tick ?? 0;
    const attackBeat = activeDungeon.room_state?.kind === 'shared_boss' ? Math.floor(playbackTick / 3) : Math.floor(playbackTick / 2);
    const heroes = heroStates.map((unit, position): CombatUnit => {
      const owned = state.ownedHeroes.find((hero) => hero.uid === unit.uid);
      const base = owned ? HERO_MAP[owned.heroId] : undefined;
      const snapshot = activeDungeon.roster_snapshot?.find((hero) => hero.uid === unit.uid);
      return {
        uid: unit.uid ?? `dungeon-hero-${position}`, name: base?.name ?? 'Dungeon Hero', side: 'hero',
        hp: Number(unit.current_hp), maxHp: Number(unit.max_hp), atk: Number(snapshot?.stats?.atk ?? unit.atk ?? 0),
        def: Number(snapshot?.stats?.def ?? unit.def ?? 0), speed: Number(snapshot?.stats?.speed ?? unit.speed ?? 100),
        combatSpeed: 1, critChance: 0, critDamage: 1.5, color: base ? RARITY_COLORS[base.rarity] : '#b98ce0',
        icon: '⚔️', attackTimer: attackBeat % 2 === 0 ? 0 : 60, attackInterval: 1, heroClass: base?.heroClass, alive: Boolean(unit.alive),
      };
    });
    const enemyStates = activeDungeon.room_state?.enemies ?? dungeonPreviewEnemies(activeDungeon, heroStates);
    const sharedBossPhase = activeDungeon.room_state?.kind === 'shared_boss';
    const enemies = enemyStates.map((unit, position): CombatUnit => {
      const isSharedBoss = sharedBossPhase && String(unit.unit_id ?? '').startsWith('shared-boss-');
      const isSummon = sharedBossPhase && String(unit.unit_id ?? '').startsWith('necromancer-summon-');
      return ({
      uid: dungeonEnemyUid(activeDungeon.room, activeDungeon.room_state, unit, position),
      name: isSharedBoss ? (activeDungeon.room_state?.boss?.name ?? 'Dungeon Boss') : isSummon ? 'Raised Guard' : activeDungeon.room === 2 ? 'Elite Guard' : activeDungeon.room === 3 ? 'Treasure Guard' : activeDungeon.room === 4 ? 'Retinue Guard' : 'Citadel Guard',
      side: 'enemy', hp: Number(unit.current_hp), maxHp: Number(unit.max_hp), atk: Number(unit.atk ?? 0),
      def: Number(unit.def ?? 0), speed: Number(unit.speed ?? 100), combatSpeed: 1, critChance: 0.06,
      critDamage: 1.5, color: isSharedBoss ? '#efb85b' : isSummon ? '#7eb5cf' : activeDungeon.room === 2 ? '#c084fc' : activeDungeon.room === 4 ? '#a78bfa' : '#ef7f68', icon: isSharedBoss ? '👑' : isSummon ? '💀' : activeDungeon.room === 2 ? '👹' : '🛡️',
      attackTimer: attackBeat % 2 === 0 ? 60 : 0, attackInterval: 1, alive: Boolean(unit.alive),
    }); });
    return [...heroes, ...enemies];
  }, [activeDungeon, state.ownedHeroes]);

  const dungeonBossScene = useMemo(() => {
    const room = activeDungeon?.room_state;
    if (!room?.boss || activeDungeon?.room !== 4 || !['retinue', 'shared_boss'].includes(room.kind ?? '')) return null;
    const tick = room.playback_tick ?? 0;
    const heroRatio = (room.heroes ?? []).reduce((sum, hero) => sum + Number(hero.current_hp), 0)
      / Math.max(1, (room.heroes ?? []).reduce((sum, hero) => sum + Number(hero.max_hp), 0));
    const bossUnit = room.enemies?.[0];
    const bossRatio = bossUnit ? Number(bossUnit.current_hp) / Math.max(1, Number(bossUnit.max_hp)) : 1;
    const identityCasting = room.kind === 'shared_boss' && room.status === 'resolving' && Boolean(room.identity_casts) && tick >= 3 && tick <= 6;
    const heavyCasting = room.kind === 'shared_boss' && room.status === 'resolving' && tick >= 9 && tick <= 15;
    const remaining = identityCasting ? Math.max(0, (6 - tick) * 0.5) : Math.max(0, (15 - tick) * 0.5);
    const bossId = room.boss.boss_id;
    const mechanics: Record<string, { name: string; state: string; threshold?: number }> = {
      'iron-warden': { name: 'BULWARK · 20% SHIELD', state: tick >= 3 && tick <= 6 ? 'BARRIER FORMING' : 'SHIELD COOLDOWN' },
      'ash-warlock': { name: 'ASHEN RUIN · PARTY MARK', state: identityCasting ? 'ALL HEROES MARKED' : 'CINDERS ORBITING' },
      'thorn-shaman': { name: 'THORN RENEWAL · HEAL', state: identityCasting ? 'CHANNELING HEAL' : 'SOURCE 20/80%' },
      'rift-behemoth': { name: 'RIFT FURY · 35%', state: bossRatio <= .35 ? 'FURY ACTIVE' : 'SHELL INTACT', threshold: 35 },
      'grave-necromancer': { name: 'RAISE DEAD · 70% / 35%', state: bossRatio <= .7 ? 'THE DEAD PROTECT' : 'SOUL CHAINS READY', threshold: bossRatio > .7 ? 70 : 35 },
    };
    const mechanic = mechanics[bossId] ?? { name: 'HEAVY STRIKE', state: 'READY' };
    return {
      phase: room.kind === 'retinue' ? 'retinue' as const : 'shared' as const,
      bossId,
      bossName: room.boss.name,
      targetUid: heavyCasting ? room.heavy_target_uid : undefined,
      cast: identityCasting
        ? { name: room.identity_ability ?? 'Boss Ability', remaining, impact: tick === 6 }
        : heavyCasting ? { name: 'Heavy Strike', remaining, impact: tick === 15 } : null,
      momentum: heroRatio > bossRatio + 0.12 ? 'party' as const : bossRatio > heroRatio + 0.12 ? 'boss' as const : 'even' as const,
      elapsedSeconds: tick * 0.52,
      room: 4, depth: activeDungeon.depth, status: room.status,
      mechanic: mechanic.name, mechanicState: mechanic.state, threshold: mechanic.threshold,
      summons: bossId === 'grave-necromancer' ? (room.enemies ?? []).filter((enemy) => String(enemy.unit_id ?? '').startsWith('necromancer-summon-') && enemy.alive).length : 0,
      enrage: bossId === 'rift-behemoth' && bossRatio <= .35,
      transition: room.kind === 'retinue' && room.status === 'cleared' ? 'RETINUE DEFEATED · BOSS VULNERABLE' : tick === 1 ? `${room.boss.name.toUpperCase()} ADVANCES` : null,
    };
  }, [activeDungeon]);

  const dungeonRoom = useMemo(() => activeDungeon ? ({
    room: activeDungeon.room, depth: activeDungeon.depth, status: activeDungeon.room_state?.status,
    label: activeDungeon.room === 1 ? 'OUTER BASTION' : activeDungeon.room === 2 ? 'HALL OF THE CURSED GUARD' : activeDungeon.room === 3 ? 'CROSSROADS OF FATE' : 'THRONE OF THE ABYSS',
  }) : null, [activeDungeon]);

  // Android encounter mode (Founder 2026-10-03): a Dungeon or Boss Hunt hides both bars and secondary panels so
  // the fight fills the screen (android.css, html[data-hl-encounter]).
  useEffect(() => {
    if (!isAndroidLayout || !activeDungeon) return;
    document.documentElement.dataset.hlEncounter = activeDungeon.type === 'boss_hunt' ? 'boss' : 'dungeon';
    return () => { delete document.documentElement.dataset.hlEncounter; };
  }, [activeDungeon?.type, Boolean(activeDungeon)]);
  const [battleActionsHost, setBattleActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (isolatedHackathon && !isAndroidLayout) setBattleActionsHost(document.getElementById(BATTLE_ACTIONS_SLOT));
  }, []);
  const [commanderOpen, setCommanderOpen] = useState(false);
  useAndroidOverlayHistory(commanderOpen, () => setCommanderOpen(false));
  useEffect(() => {
    const open = () => setCommanderOpen((visible) => !visible);
    window.addEventListener(COMMANDER_OPEN_EVENT, open);
    return () => window.removeEventListener(COMMANDER_OPEN_EVENT, open);
  }, []);
  // A top-bar or tab-bar button closes this screen's sheets and panels (App.tsx closeOverlaysFromBar).
  useEffect(() => {
    const close = (event: Event) => {
      // Keep the current state until the Commander button toggles it in the bubble phase.
      if (!(event as CustomEvent<{ commanderToggle?: boolean }>).detail?.commanderToggle) setCommanderOpen(false);
      setBattleMenuOpen(false); setShowBattleSettings(false); setShowDungeonInfo(false);
      setShowAvatarPicker(false); setShowDropRates(false); setShowInventoryFull(false);
    };
    window.addEventListener(OVERLAYS_CLOSE_EVENT, close);
    return () => window.removeEventListener(OVERLAYS_CLOSE_EVENT, close);
  }, [setBattleMenuOpen]);

  // Commander panel: in the Quests column on desktop; on a phone it opens from the avatar in the
  // top bar (Founder 2026-10-02).
  const encounterActions = (
    !activeDungeon && <div className="battle-entry-actions flex shrink-0 items-center justify-center gap-2 px-2 py-1.5">
            <button type="button" onClick={() => setShowDungeonInfo(true)} className="pm-socket game-control flex min-h-11 items-center gap-1 px-2 py-0.5 ui-text-small font-bold text-[#d7c6ea]" aria-label="Open Dungeons information">
              <DoorOpen size={14} aria-hidden="true" /> DUNGEONS <Info size={11} aria-hidden="true" />
            </button>
            <button
              onClick={handleSummonBoss}
              data-guide="boss"
              disabled={summonBusy || state.bossKeys < 1 || state.bossBattleActive}
              className="pm-socket game-control flex min-h-11 items-center gap-1 px-2 py-0.5 ui-text-small font-bold"
            >
              <BossKeyIcon size={22} /> {state.bossBattleActive ? 'BOSS ACTIVE' : `BOSS · ${state.bossKeys}`}
            </button>
          </div>
  );

  const commanderPanel = (
  <div className="hl-commander commander-card">
    <div className="section-kicker mb-2">Commander</div>
    <div className="commander-identity">
      <button type="button" onClick={() => setShowAvatarPicker(true)} className="commander-avatar relative shrink-0 overflow-hidden rounded-lg bg-black/30" aria-label="Change account avatar">
        {avatarBase && <img src={heroPortraitSrc(avatarBase.id, avatarBase.heroClass, avatarBase.rarity, avatarBase.color)} alt="" className="h-full w-full object-cover" style={{ ...heroPortraitStyle(avatarBase.id, avatarBase.heroClass), transform: 'none' }} />}
        {avatarBase && <RarityFx rarity={avatarBase.rarity} shape="slot" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="commander-label">Commander XP</div>
        <div className="commander-level">Level {state.accountLevel}</div>
        <div className="commander-bar health-track"><span style={{ width: `${Math.min(100, (accountXpCurrent / accountXpForLevel(state.accountLevel)) * 100)}%` }} /></div>
        <div className="commander-xp">{formatNum(accountXpCurrent)} / {formatNum(accountXpForLevel(state.accountLevel))} XP</div>
      </div>
    </div>
    <div className="commander-stats stat-tile">
      <div><span className="commander-label">Team Power</span><strong>⚡ {formatNum(power)}</strong></div>
      <span className="commander-stats-gem" aria-hidden="true" />
      <div><span className="commander-label">Hero Power</span><strong>⚡ {formatNum(selectedHeroPower)}</strong></div>
    </div>
    <section aria-label="Active Formation">
      <div className="commander-divider"><span>Active Formation</span></div>
      <div className="commander-squad">
        {[0, 1, 2].map((slot) => {
          const hero = state.ownedHeroes.find((owned) => owned.uid === state.team[slot]);
          const base = hero ? HERO_MAP[hero.heroId] : null;
          return hero && base ? <button key={slot} type="button" className={`commander-squad-slot ${selectedHeroUid === hero.uid ? 'is-selected' : ''}`} aria-pressed={selectedHeroUid === hero.uid} aria-label={`Select ${base.name}, level ${hero.level}`} onClick={() => { setSelectedHeroUid(hero.uid); setShowHeroDetails(false); }}>
            <HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={112} active={selectedHeroUid === hero.uid} />
            <span className="commander-squad-name" style={{ color: selectedHeroUid === hero.uid ? RARITY_COLORS[base.rarity] : undefined }}>{base.name}</span>
            <span className="commander-xp">Level {hero.level}</span>
          </button> : <div key={slot} className="commander-squad-slot"><div className="commander-squad-empty">Empty slot</div></div>;
        })}
      </div>
    </section>
    {selectedHero && (
      <div className="commander-row">
        <div className="commander-divider" aria-hidden="true" />
        <div className="flex items-baseline justify-between gap-2"><span className="commander-label">Hero XP · Level {selectedHero.level}</span><span className="commander-xp">{formatNum(selectedHero.xp)} / {formatNum(heroXpForLevel(selectedHero.level))} XP</span></div>
        <div className="commander-bar health-track is-hero"><span style={{ width: `${Math.min(100, (selectedHero.xp / heroXpForLevel(selectedHero.level)) * 100)}%` }} /></div>
      </div>
    )}
    <RewardBoostTile bonus={game.accountBonus} onOpenShop={() => { setCommanderOpen(false); onRewardBoostClick(); }} />
    {selectedHeroStats && (
      <div className="commander-details">
        <button
          type="button"
          className="commander-toggle"
          aria-expanded={showHeroDetails}
          aria-controls="commander-hero-details"
          onClick={() => setShowHeroDetails((visible) => !visible)}
        >
          <span className="commander-label">Hero characteristics</span>
          <span className="flex items-center gap-1 ui-text-small font-semibold text-[#d5bd85]">
            {showHeroDetails ? 'Hide' : 'Show'}
            <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${showHeroDetails ? 'rotate-180' : ''}`} />
          </span>
        </button>
        <div id="commander-hero-details" hidden={!showHeroDetails} className="pb-1">
            <dl className="commander-stat-list">
              {[
                ['Attack', formatNum(selectedHeroStats.atk)],
                ['Health', formatNum(selectedHeroStats.hp)],
                ['Armor', formatNum(selectedHeroStats.def)],
                ['Dodge', `${(selectedHeroStats.dodge * 100).toFixed(1)}%`],
                ['Attack Speed', formatNum(selectedHeroStats.speed + selectedHeroStats.atkSpeed)],
                ['Crit', `${(selectedHeroStats.critChance * 100).toFixed(1)}%`],
                ['Crit Damage', `+${(selectedHeroStats.critDamage * 100).toFixed(0)}%`],
                ['XP Bonus', `+${(activeTeamBonuses.xp * 100).toFixed(1)}%`],
                ['Gold Bonus', `+${(activeTeamBonuses.gold * 100).toFixed(1)}%`],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="commander-subrow">
              <div className="commander-label mb-1">Passives</div>
              <AccountBonusPassives bonus={game.accountBonus} />
            </div>
            <div className="commander-subrow flex items-center justify-between gap-2">
              <span className="commander-label">Skills · Auras</span>
              <span className="shrink-0 ui-text-small font-semibold text-[#9b8862]">Coming soon</span>
            </div>
        </div>
      </div>
    )}
    <div className="commander-kill-stats" aria-label="Combat totals">
      {[['Heroes', state.ownedHeroes.length], ['Defeated', state.totalKills], ['Bosses', state.totalBossKills]].map(([label, value]) => <div key={label}><span className="commander-label">{label}</span><strong>{formatNum(Number(value))}</strong></div>)}
    </div>
  </div>
  );

  return (
    <div className="game-main flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* ── LEFT COLUMN ── */}
      <div className="hl-col-left material-panel game-scrollbar order-2 flex w-full shrink-0 flex-col overflow-y-auto lg:order-none lg:w-60 xl:w-64">
        {tutorialFinished && createPortal(<div className="hl-portal dungeon-complete is-victory" style={{ position: 'fixed', zIndex: 9999 }} role="dialog" aria-modal="true" aria-label="Tutorial complete"><div className="dungeon-complete-crest"><Sparkles size={38} /><small>TUTORIAL · 10/10</small><strong>TUTORIAL COMPLETE</strong><p>Your team is built, geared and has beaten its first Boss.</p><div className="dungeon-reward-preview"><span><SummonScrollArtwork size={18} /> 1 SUMMON SCROLL</span><span><CheckCircle2 size={14} /> DAILY QUESTS NEXT</span><small>Final reward granted exactly once by the server</small></div><button type="button" autoFocus className="game-control game-primary" onClick={() => setTutorialFinished(false)}>CONTINUE</button></div></div>, document.body)}
        {!isAndroidLayout && commanderPanel}

        <div id="game-quest-list" className="hl-quest-list flex-1 p-2">
          {isolatedHackathon && <SeekerQuestChallenge board={seekerQuestBoard} />}
          <PartnerQuests claim={game.claimPartnerQuest} onOpenBoostMax={onBoostClick} shareState={state} teamPower={power} />
          {!state.tutorial.questCompleted && (() => {
            const ordinal = Math.max(1, Math.min(10, state.tutorial.questOrdinal));
            const quest = TUTORIAL_QUESTS[ordinal - 1];
            const progress = tutorialProgress(state, ordinal);
            const done = progress >= quest[2];
            return <section className="mb-2" aria-label="Tutorial Quests">
              <div className="section-kicker mb-1">Tutorial Quests · {ordinal}/10</div>
              <div className={`quest-card px-2 py-1 ${done ? 'border-[#b48a43]' : ''}`}>
                <div className="flex items-center gap-1.5"><Circle size={11} className={done ? 'fill-amber-400/30 text-amber-400' : 'text-slate-600'} /><span className="ui-text-medium min-w-0 flex-1 leading-tight text-px-text">{isolatedHackathon && quest[0] === 'enable-auto-pot' ? 'Automatic healing' : quest[1]}</span></div>
                <div className="mt-1 flex items-center gap-1.5"><div className="health-track h-1 flex-1 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#765022,#d4a449)]" style={{ width: `${Math.min(100, progress / quest[2] * 100)}%` }} /></div><span className="ui-text-small shrink-0 text-px-dim">{progress}/{quest[2]}</span><span className="ui-text-small shrink-0 text-[#e7c579]">{isolatedHackathon ? quest[3].replace('XS Potions', 'Ordinary Potions') : quest[3]}</span></div>
                {done && <button type="button" disabled={tutorialClaimBusy} aria-busy={tutorialClaimBusy} onClick={async () => {
                  setTutorialClaimBusy(true); setTutorialClaimError('');
                  try {
                    const error = await game.claimTutorialQuest(quest[0]);
                    if (error) setTutorialClaimError(error === 'state_conflict' ? 'Your game changed. Please try claiming again.' : error === 'tutorial_quest_incomplete' ? 'The server has not confirmed this task yet. Please try again.' : error === 'tutorial_quest_locked' || error === 'tutorial_completed' ? 'This tutorial step is no longer available. Reload the game.' : 'Could not claim the reward. Please try again.');
                    else playSfx('claim');
                    if (!error && quest[0] === 'defeat-tutorial-boss') setTutorialFinished(true);
                    else if (!error) showToast('Tutorial reward claimed');
                  } finally { setTutorialClaimBusy(false); }
                }} data-guide="claim" className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full px-2 py-0.5 font-bold disabled:opacity-50">{tutorialClaimBusy ? 'Claiming…' : 'Claim & unlock next'}</button>}
                {tutorialClaimError && <p role="alert" className="mt-1 ui-text-small text-red-300">{tutorialClaimError}</p>}
              </div>
              {state.tutorial.chestBalance > 0 && <div className="quest-card mt-1 px-2 py-1"><div className="ui-text-medium flex justify-between"><span>Tutorial Chests</span><b>{state.tutorial.chestBalance}</b></div><div className="mt-1 grid grid-cols-2 gap-1"><button disabled={state.tutorial.chestBalance < 1 || game.chestOpening} onClick={() => openTutorialChestsChecked(1)} className="game-control min-h-7 ui-text-small font-bold">Open 1</button><button disabled={state.tutorial.chestBalance < 10 || game.chestOpening} onClick={() => openTutorialChestsChecked(10)} data-guide="open-chests" className="game-control min-h-7 ui-text-small font-bold">Open 10</button></div></div>}
            </section>;
          })()}
          {isolatedHackathon && <SeekerQuests board={seekerQuestBoard} onOpenShop={onRewardBoostClick} claimQuest={game.claimQuest} motionOff={state.battleAnimationMode === 'off'} />}
          <div className="section-kicker mb-1">Daily Quests</div>
          <div className="space-y-1">
            {state.dailyQuests.map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className={`quest-card px-2 py-1 ${done && !q.claimed ? 'border-[#b48a43]' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    {q.claimed ? <CheckCircle2 size={11} className="shrink-0 text-emerald-400" /> : done ? <Circle size={11} className="shrink-0 fill-amber-400/30 text-amber-400" /> : <Circle size={11} className="shrink-0 text-slate-600" />}
                    <span className="ui-text-medium min-w-0 flex-1 truncate leading-tight text-px-text" title={groupDigits(q.label)}>{groupDigits(q.label)}</span>
                    <span className="ui-text-small flex shrink-0 items-center gap-1 text-px-text"><GoldIcon size={12} />{groupNumber(q.reward.gold)} Gold {!isolatedHackathon && <><HeroTokenIcon size={10} />{q.reward.hero}</>}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="health-track h-1 flex-1 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#765022,#d4a449)]" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                    <span className="ui-text-small shrink-0 text-px-dim">{groupNumber(q.progress)}/{groupNumber(q.target)}</span>
                  </div>
                  {done && !q.claimed && <button onClick={() => void game.claimQuest(q.id).then((ok) => { if (ok) playSfx('claim'); })} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full px-2 py-0.5 font-bold">Claim reward</button>}
                </div>
              );
            })}
          </div>
          <div className="section-kicker mb-1 mt-2">Milestone Quests</div>
          <div className="space-y-1">
            {state.milestoneQuests.filter(q => !isolatedHackathon || !q.chain?.startsWith('token-')).map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className={`quest-card px-2 py-1 ${done ? 'border-[#b48a43]' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    {done ? <Circle size={11} className="shrink-0 fill-amber-400/30 text-amber-400" /> : <Circle size={11} className="shrink-0 text-slate-600" />}
                    <span className="ui-text-medium min-w-0 flex-1 truncate leading-tight text-px-text" title={groupDigits(q.label)}>{groupDigits(q.label)}</span>
                    <span className="ui-text-small flex shrink-0 items-center gap-1 text-px-text">{q.reward.summonScrolls ? <><SummonScrollArtwork size={14} />{q.reward.summonScrolls}</> : <><GoldIcon size={12} />{formatNum(q.reward.gold)} Gold {!isolatedHackathon && <><HeroTokenIcon size={10} />{q.reward.hero}</>}</>}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="health-track h-1 flex-1 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#5a3d70,#bd78d5)]" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                    <span className="ui-text-small shrink-0 text-px-dim">{formatNum(q.progress)}/{formatNum(q.target)}</span>
                    <span className="ui-text-small shrink-0 font-bold uppercase text-[#8e887b]">T{(q.tier ?? 0) + 1}</span>
                  </div>
                  {done && <button onClick={() => void game.claimQuest(q.id).then((ok) => { if (ok) playSfx('claim'); })} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full px-2 py-0.5 font-bold">Claim & unlock next</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── CENTER COLUMN — responsive, max-width removed ── */}
      <div className="hl-col-center game-scrollbar order-1 flex min-h-[464px] w-full shrink-0 flex-col overflow-hidden lg:order-none lg:min-h-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:overflow-y-auto">
        {!isAndroidLayout && (battleActionsHost ? createPortal(encounterActions, battleActionsHost) : encounterActions)}
        {/* Arena */}
        <div className={`battle-stage ${!activeDungeon ? 'battle-stage-normal' : ''} relative min-h-[320px] flex-1 overflow-hidden bg-arena`} style={activeDungeon ? undefined : locationArtStyle(game.state.currentLocation)}>
          {!activeDungeon && state.battleAnimationMode === 'spectacular' && <div className="arena-spectacular-atmosphere pointer-events-none absolute inset-0" aria-hidden="true" />}
          {!activeDungeon && <BattleAmbience />}
          {!activeDungeon && showZoomTip && <div className="hl-zoom-tip absolute left-1/2 top-12 z-40 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-[#80683f] bg-[#11130f]/95 px-3 py-1.5 font-vt ui-text-small font-bold text-[#d8c9ad] shadow-xl backdrop-blur-sm"><span>Adjust browser zoom with <kbd className="text-[#ffd36e]">Ctrl +</kbd> / <kbd className="text-[#ffd36e]">Ctrl -</kbd> to fit all interface elements.</span><button type="button" onClick={() => setShowZoomTip(false)} className="text-[#8f887b] hover:text-white" aria-label="Dismiss browser zoom tip"><X size={12} /></button></div>}
          <div className={`hl-battle-hud-left absolute left-3 top-3 flex items-start gap-1.5 ${showPotSettings || showBattleSettings ? 'z-[110]' : 'z-30'}`}>
            {!activeDungeon && !isolatedHackathon ? <div className="relative">
              <button onClick={() => setShowPotSettings(s => !s)} className={`game-control relative flex h-7 items-center gap-1.5 px-2 py-0.5 ui-text-small font-bold ${state.autoPot.enabled ? 'border-emerald-500/60 bg-emerald-950/30 text-emerald-300' : ''}`}>
                <FlaskConical size={14} /> Pot-auto {state.autoPot.enabled ? 'ON' : 'OFF'}
              </button>
              {showPotSettings && <PotionSettings game={game} onClose={() => setShowPotSettings(false)} />}
            </div> : activeDungeon ? <div className="game-control flex h-9 items-center gap-2 border-violet-500/60 bg-violet-950/40 px-3 ui-text-small font-black uppercase text-violet-200"><DoorOpen size={15} /> {activeDungeon.type === 'boss_hunt' ? 'Boss Hunt' : `Depth ${activeDungeon.depth} · Room ${activeDungeon.room}/4`}</div> : null}
            {!isAndroidLayout && battleSettingsControl}
          </div>
          {isolatedHackathon && !activeDungeon && <AutomaticHealingStatus game={game} />}
          {isolatedHackathon && !activeDungeon && <NextStepCard game={game} nextLocation={nextLocationAvailable ? nextLocation : null} onQuestsClick={onQuestsClick} onStoreClick={onRewardBoostClick} />}
          {isAndroidLayout && <div ref={battleMenuRef} className="hl-battle-menu pointer-events-none absolute bottom-2 right-2 top-2 z-[112] flex flex-col items-end gap-1">
            {!onEventsMenuOpen && <button type="button" onClick={() => setBattleMenuOpen(!battleMenuOpen)} data-guide="boss" className="hl-battle-menu-toggle game-control pointer-events-auto relative grid h-11 w-11 shrink-0 place-items-center p-0" aria-label={eventsReady ? 'Battle menu, event rewards ready' : 'Battle menu'} aria-haspopup="dialog" aria-expanded={battleMenuOpen}>{battleMenuOpen ? <X size={20} /> : <Menu size={20} />}{eventsReady > 0 && !battleMenuOpen && <b className="hl-battle-menu-dot" aria-hidden="true" />}</button>}
            {battleMenuOpen && (events && onEventsOpen ? <div role="dialog" aria-label="Events" className="ev-menu-panel pointer-events-auto">
              <EventMenuCards events={events} onOpen={(tab) => { setBattleMenuOpen(false); onEventsOpen(tab); }}>
                {!activeDungeon && <div className="ev-menu-battle">
                  <button type="button" onClick={() => { setBattleMenuOpen(false); setShowDungeonInfo(true); }} className="ev-menu-btn ev-menu-btn-dungeon"><DoorOpen size={16} aria-hidden="true" /><span>Dungeons</span></button>
                  <button type="button" onClick={() => void handleSummonBoss()} data-guide="boss" disabled={summonBusy || state.bossKeys < 1 || state.bossBattleActive} className="ev-menu-btn ev-menu-btn-boss"><BossKeyIcon size={22} /><span>{state.bossBattleActive ? 'Boss active' : `Boss · ${state.bossKeys}`}</span></button>
                </div>}
              </EventMenuCards>
            </div> : <div role="dialog" aria-label="Battle menu" className="hl-battle-menu-panel pointer-events-auto min-h-0 w-64 max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-lg border border-[#80683f] bg-[#11130f] p-2 shadow-2xl">
              {!activeDungeon && <div className="mb-2 grid grid-cols-2 gap-1.5 border-b border-[#80683f]/50 pb-2">
                <button type="button" onClick={() => { setBattleMenuOpen(false); setShowDungeonInfo(true); }} className="pm-socket game-control flex min-h-11 items-center justify-center gap-1.5 px-2 ui-text-small font-bold text-[#d7c6ea]"><DoorOpen size={15} aria-hidden="true" /> DUNGEONS</button>
                <button type="button" onClick={() => void handleSummonBoss()} data-guide="boss" disabled={summonBusy || state.bossKeys < 1 || state.bossBattleActive} className="pm-socket game-control flex min-h-11 items-center justify-center gap-1 px-2 ui-text-small font-bold disabled:opacity-50"><BossKeyIcon size={22} /> {state.bossBattleActive ? 'BOSS ACTIVE' : `BOSS · ${state.bossKeys}`}</button>
              </div>}
              {battleSettingsContent}
            </div>)}
          </div>}
          {!activeDungeon && banner && (
            <div className="hl-battle-banner absolute inset-x-0 top-1/4 flex flex-col items-center z-30 pointer-events-none">
              <div className={`anim-banner battle-result-title font-pixel text-2xl sm:text-3xl tracking-wider ${banner.win ? 'is-victory' : 'is-defeat'}`}>{banner.win ? 'VICTORY' : 'DEFEAT'}</div>
              {hasBattleRewards && (
                <div className="anim-banner stat-tile mt-2 flex flex-wrap items-center justify-center gap-2 px-3 py-2 font-vt ui-text-medium">
                  {banner.gold > 0 && <span className="text-amber-300">+{formatNum(banner.gold)}g</span>}
                  {banner.xp > 0 && <span className="text-emerald-300">+{formatNum(banner.xp)} Account XP</span>}
                  {dropBase && <span style={{ color: RARITY_COLORS[dropBase.rarity] }} className="flex items-center gap-1"><Package size={11} /> {dropBase.name}</span>}
                  {banner.chest && <span className="text-amber-200 flex items-center gap-1">+1 chest</span>}
                </div>
              )}
            </div>
          )}
          <CombatErrorBoundary
            resetKey={`${activeDungeon?.encounter_id ?? 'normal'}:${game.state.currentLocation}:${game.state.team.join('|')}`}
            onRetry={activeDungeon ? undefined : game.retry}
          >
            <div className="h-full">
              <CombatPresentationLayer game={game} activeDungeon={activeDungeon} dungeonUnits={dungeonUnits} dungeonFloaters={dungeonFloaters} dungeonBossScene={dungeonBossScene} dungeonRoom={dungeonRoom} />
              <BossIntro encounterKey={activeDungeon && (activeDungeon.type === 'boss_hunt' || dungeonBossScene) ? String(activeDungeon.encounter_id) : null} bossName={dungeonBossScene?.bossName ?? 'Boss'} phase={dungeonBossScene?.phase ?? null} motion={state.battleAnimationMode !== 'off'} />
            </div>
          </CombatErrorBoundary>
          {!activeDungeon && game.combatRecovery.status !== 'healthy' && (
            <div className="absolute inset-x-0 bottom-3 z-30 flex justify-center px-3" data-combat-recovery={game.combatRecovery.status}>
              <div className="game-control flex items-center gap-2 bg-[#17130d]/95 px-3 py-2 font-vt ui-text-medium text-amber-100">
                <span>{game.combatRecovery.status === 'retrying' ? `Battle link recovering · attempt ${game.combatRecovery.attempt}/5` : 'Battle link paused after repeated failures'}</span>
                {game.combatRecovery.status === 'failed' && <button type="button" className="font-bold text-amber-300 underline" onClick={game.retry}>Retry</button>}
              </div>
            </div>
          )}
          {activeDungeon && <DungeonBattleControls checkpoint={activeDungeon} attempts={dungeonAttempts} autoRun={dungeonAutoRun.current} onChange={(next) => void handleDungeonChange(next)} onAttempts={setDungeonAttempts} onCombatPulse={setDungeonFloaters} onHydrate={game.hydrateServerState} onComplete={(won, gold = 0, scrolls = 0, premium = 0) => setDungeonCompletion({ won, depth: activeDungeon.depth, kind: activeDungeon.type, gold, scrolls, premium })} />}
          {dungeonCompletion && <div className={`dungeon-complete ${dungeonCompletion.won ? 'is-victory' : 'is-defeat'}`} role="dialog" aria-modal="true" aria-label={dungeonCompletion.won ? 'Encounter Complete' : 'Encounter Failed'}><div className="dungeon-complete-crest"><Skull size={38} /><small>{dungeonCompletion.kind === 'boss_hunt' ? 'BOSS HUNT' : `CURSED CITADEL · DEPTH ${dungeonCompletion.depth}`}</small><strong>{dungeonCompletion.won ? (dungeonCompletion.kind === 'boss_hunt' ? 'BOSS DEFEATED' : 'DUNGEON COMPLETE') : 'THE ENEMY ENDURES'}</strong><p>{dungeonCompletion.won ? (dungeonCompletion.kind === 'boss_hunt' ? 'The server verified and settled every Boss reward.' : 'The Abyss throne is silent. Server reward result:') : 'The formation has fallen.'}</p>{dungeonCompletion.won && <div className="dungeon-reward-preview">{dungeonCompletion.kind === 'boss_hunt' ? <><span><Coins size={14} /> {formatNum(dungeonCompletion.gold)} GOLD</span><span><Package size={14} /> 1 BOSS CHEST</span>{dungeonCompletion.premium > 0 && <span><FlaskConical size={14} /> {dungeonCompletion.premium} WEAK PREMIUM POTION</span>}<small>Granted once · Find your chest in Inventory → Resources → Chests</small></> : <><span><SummonScrollArtwork size={18} /> {dungeonCompletion.scrolls} SUMMON SCROLLS</span><span><Package size={14} /> 1 DUNGEON CHEST PREVIEW</span><small>{dungeonCompletion.scrolls === 2 ? 'Scrolls granted exactly once by the server; Dungeon Chest is not yet granted' : 'No Scrolls granted for this run; Dungeon Chest is not yet granted'}</small></>}</div>}<button type="button" className="game-control game-primary" onClick={() => setDungeonCompletion(null)}>RETURN TO BATTLE</button></div></div>}
          {!activeDungeon && import.meta.env.MODE === 'staging' && <TestControls game={game} />}
          {!activeDungeon && <div className="hl-battle-footer normal-battle-footer relative z-30 flex shrink-0 flex-wrap items-end justify-between gap-3 px-3 pb-3">
            <TokenEarningsPanel status={tok.status} stale={tok.incomeStale} today={game.state.tokensEarnedToday} />
            <div className="hl-battle-dock ml-auto flex items-end gap-1.5">
            {showDropRates && dropRatesPos && createPortal(<div role="dialog" aria-label="Chest drop rate" className="hl-portal fixed z-[100] w-56 overflow-y-auto rounded-lg border border-[#80683f] bg-[#11130f]/98 p-2.5 shadow-2xl backdrop-blur-sm" style={{ right: dropRatesPos.right, bottom: dropRatesPos.bottom, maxHeight: dropRatesPos.maxHeight }}>
              <div className="flex items-center justify-between gap-2"><strong className="ui-text-small uppercase tracking-wider text-[#efd18a]">Chest drop rate</strong><button type="button" onClick={() => setShowDropRates(false)} aria-label="Close drop rates"><X size={13} /></button></div>
              <p className="mt-1 ui-text-small text-[#978f81]">Current Account Level {state.accountLevel}. Rates update with account level and global rarity availability.</p>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">{chestRateRows.map(([rarity, weight]) => <Fragment key={rarity}><span className="ui-text-small font-bold" style={{ color: RARITY_COLORS[rarity as keyof typeof RARITY_COLORS] }}>{RARITY_LABEL[rarity as keyof typeof RARITY_LABEL]}</span><span className="text-right ui-text-small tabular-nums text-[#ddd4c4]">{(weight / chestWeightTotal * 100).toFixed(2).replace(/\.?0+$/, '')}%</span></Fragment>)}</div>
              {state.chests.some((chest) => chest.boss) && <p className="mt-2 border-t border-white/10 pt-2 ui-text-small text-rose-200">Boss Chests use the same level table with a Rare/Epic minimum.</p>}
            </div>, document.body)}
            <button ref={dropRatesButtonRef} type="button" onClick={() => setShowDropRates((value) => !value)} className="game-control grid h-7 w-7 place-items-center sm:h-8 sm:w-8" aria-label="Show chest drop rates" aria-expanded={showDropRates}><Info size={15} /></button>
            <div className="flex flex-row gap-1 sm:flex-col sm:gap-1.5">
              <button type="button" onClick={onBoostClick} className={`pm-boost game-control flex h-7 w-auto shrink-0 items-center sm:h-8 sm:w-36 justify-center gap-1 px-1.5 py-0.5 sm:px-2 ui-text-small font-black ${state.boost.active ? 'boost-max-active' : 'boost-max-ready'}`} title="Boost your offline earnings to 24/7"><Rocket size={15} /><span>{state.boost.active ? 'BOOST ON' : 'BOOST MAX'}</span></button>
              <button
                onClick={() => {
                  if (isolatedHackathon && bagItemCount(state) >= inventoryCapacity(state)) {
                    playSfx('error');
                    setShowInventoryFull(true);
                    return;
                  }
                  void game.openChests(tok.status?.rarity_capacity ?? {}, tok.reserveLimitedItem);
                }}
                disabled={state.chests.length === 0 || game.chestOpening}
                className="pm-chest reward-cta game-control flex h-7 w-auto shrink-0 items-center sm:h-8 sm:w-36 justify-center gap-1 px-1.5 py-0.5 sm:px-2 ui-text-small font-black disabled:opacity-55"
                title="Open chests"
              >
                <ChestCollectIcon size={34} />
                <span>{game.chestOpening ? 'OPENING…' : `OPEN · ${state.chests.length}`}</span>
              </button>
            </div>
            </div>
          </div>}
        </div>

        {/* Hackathon locations collapse to reserve phone space for combat. */}
        {!activeDungeon ? <div className="hl-locations material-panel mt-1.5 shrink-0 p-2.5">
          {isolatedHackathon ? <div className="flex items-stretch gap-1.5"><button
            type="button"
            className="location-disclosure game-control flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 px-2 text-left"
            aria-expanded={locationsExpanded}
            aria-controls="location-progression-path"
            onClick={() => setLocationsExpanded(expanded => !expanded)}
          >
            <span className={`section-kicker ${nextLocationAvailable ? 'location-disclosure-ready' : ''}`}>
              Locations <span className="ui-text-small">· {String(state.currentLocation).padStart(2, '0')} · {buildLocation(state.currentLocation, state.team.length).name}</span>
            </span>
            <ChevronDown size={20} className={locationsExpanded ? 'rotate-180 shrink-0' : 'shrink-0'} aria-hidden="true" />
          </button>
          {nextLocationAvailable && <button type="button" onClick={() => game.setLocation(nextLocation)} className="location-next game-control game-primary flex min-h-11 shrink-0 items-center gap-1.5 px-3 ui-text-small font-black uppercase" aria-label={`Go to location ${nextLocation}`}>Go to {String(nextLocation).padStart(2, '0')}<ArrowRight size={16} aria-hidden="true" /></button>}
          </div> : <div className="mb-1.5 flex items-center justify-between">
            <span className="section-kicker">Locations</span>
            <span className="ui-text-small font-semibold uppercase tracking-[.12em] text-[#77746d]">Progression path</span>
          </div>}
          <div id="location-progression-path" hidden={!locationsExpanded}>
          <div className={`grid grid-cols-[38px_minmax(0,1fr)_38px] items-stretch gap-1.5 ${isolatedHackathon ? 'mt-1.5' : ''}`}>
            <button onClick={() => scrollLocations(-1)} className="game-control grid place-items-center" aria-label="Previous locations"><ChevronLeft size={20} /></button>
            <div ref={locationRailRef} className="game-scrollbar flex gap-1.5 overflow-x-auto pb-1.5">
            {Array.from({ length: totalLocations }).map((_, i) => {
              const lid = i + 1;
              const l = buildLocation(lid, state.team.length, false, state.accountLevel);
              const current = lid === state.currentLocation;
              const completed = lid < state.currentLocation;
              const unlockLv = locationUnlockLevel(lid);
              const locked = state.accountLevel < unlockLv && lid > (state.seekerProgression?.legacyLocationAccess ?? 1);
              const notYetDiscovered = lid > state.highestLocation;
              const [rLo, rHi] = locationLevelRange(lid);
              const tokenEligible = canMineTokens(lid, state.accountLevel, state.highestLocation, state.seekerProgression?.legacyLocationAccess);
              return (
                <button
                  key={lid}
                  data-location={lid}
                  onClick={() => !locked && !notYetDiscovered && game.setLocation(lid)}
                  disabled={locked || notYetDiscovered}
                  className={`location-card location-card-art shrink-0 px-2.5 py-1.5 text-left transition ${current ? 'location-card-current' : ''} ${(locked || notYetDiscovered) ? 'location-card-locked' : ''} ${l.boss ? 'ring-1 ring-rose-800/60' : ''}`}
                  style={{ minWidth: '150px', '--location-card-art': `url('${versionedAsset(`/assets/locations/${lid > 10 ? 'endgame' : 'standard'}/location-${lid}.webp`)}')` } as React.CSSProperties}
                >
                  {/* Top row: number + boss + lock */}
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-vt ui-text-large font-bold" style={{ color: notYetDiscovered ? '#62543a' : current ? '#f0c461' : '#c5aa76' }}>
                      {String(lid).padStart(2, '0')}
                      {l.boss && <span className="text-px-red ml-1">BOSS</span>}
                    </span>
                    <span className="ui-text-small font-bold uppercase tracking-wider text-[#858073]">{current ? 'Current' : completed ? 'Completed' : locked || notYetDiscovered ? 'Locked' : 'Available'}</span>
                  </div>
                  {/* Name */}
                  <div className="mt-0.5 truncate ui-text-medium font-bold text-[#e5ddcc]">{l.name}</div>
                  {/* Level, required power and gold */}
                  <div className="mt-0.5 ui-text-small font-semibold text-[#8f8a7e]">
                    Lv {rLo}–{rHi} · Recommended {formatNum(recommendedTeamPower(lid, state.team.length, state.balanceTelemetry, state.accountLevel))}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 ui-text-small font-vt">
                    <span className="flex items-center gap-1 text-[#c79b4e]"><Coins size={11} />{formatNum(l.goldReward * (isolatedHackathon ? 2 : 1))} Gold</span>
                    {!isolatedHackathon && !locked && !notYetDiscovered && <span className={`hl-hero-only ml-auto ui-text-small font-bold ${tokenEligible ? 'text-emerald-400' : 'text-[#776f63]'}`}>{tokenEligible ? '$HERO ACTIVE' : 'NO $HERO'}</span>}
                    {(locked || notYetDiscovered) && <LockIcon size={11} className="ml-auto text-[#777064]" />}
                  </div>
                </button>
              );
            })}
            </div>
            <button onClick={() => scrollLocations(1)} className="game-control grid place-items-center" aria-label="Next locations"><ChevronRight size={20} /></button>
          </div>
          </div>
        </div> : activeDungeon.type === 'boss_hunt' ? <div className="hl-encounter-strip material-panel mt-1.5 shrink-0 p-3"><div className="flex items-center justify-between gap-3"><span className="section-kicker">Boss Hunt</span><span className="ui-text-small font-black uppercase tracking-widest text-violet-300">Server combat · reload-safe · potions disabled</span></div><div className="mt-2 grid grid-cols-2 gap-1.5"><div className={`rounded-lg border px-2 py-2 text-center ui-text-small font-black uppercase ${activeDungeon.room_state?.kind === 'retinue' ? 'border-violet-400 bg-violet-950/40 text-violet-100' : 'border-emerald-700/60 bg-emerald-950/25 text-emerald-300'}`}>1. Retinue</div><div className={`rounded-lg border px-2 py-2 text-center ui-text-small font-black uppercase ${activeDungeon.room_state?.kind === 'shared_boss' ? 'border-violet-400 bg-violet-950/40 text-violet-100' : 'border-white/10 bg-black/20 text-[#77706f]'}`}>2. Shared Boss</div></div></div> : <div className="hl-encounter-strip material-panel mt-1.5 shrink-0 p-3"><div className="flex items-center justify-between gap-3"><span className="section-kicker">Cursed Citadel</span><span className="ui-text-small font-black uppercase tracking-widest text-violet-300">HP persists · potions disabled</span></div><div className="mt-2 grid grid-cols-4 gap-1.5">{['Guards', 'Elite', 'Crossroads', 'Boss'].map((label, index) => <div key={label} className={`rounded-lg border px-2 py-2 text-center ui-text-small font-black uppercase ${activeDungeon.room === index + 1 ? 'border-violet-400 bg-violet-950/40 text-violet-100' : activeDungeon.room > index + 1 ? 'border-emerald-700/60 bg-emerald-950/25 text-emerald-300' : 'border-white/10 bg-black/20 text-[#77706f]'}`}>{index + 1}. {label}</div>)}</div></div>}

      </div>

      {/* ── RIGHT COLUMN ── */}
      <div className="hl-col-right material-panel order-3 flex min-w-0 w-full shrink-0 flex-col overflow-hidden lg:order-none lg:w-[390px] xl:w-[420px]">
        <div className="hl-active-formation shrink-0 border-b border-[#4f412e] bg-[radial-gradient(circle_at_20%_0%,rgba(162,118,50,.11),transparent_50%)] px-1 py-2.5">
          <div className="section-kicker mb-2">Active Formation</div>
          <div className="relative flex min-h-[54px] items-end gap-1.5">
            <ActionFx watch={state.team.length} variant="join" downVariant="leave" />
            {state.team.map(uid => {
              const h = state.ownedHeroes.find(h => h.uid === uid); const b = h ? HERO_MAP[h.heroId] : null;
              if (!h || !b) return null;
              return <HeroPortrait key={uid} heroId={b.id} heroClass={b.heroClass} rarity={b.rarity} color={b.color} size={selectedHeroUid === uid ? 56 : 46} active={selectedHeroUid === uid} badge={h.level} respawn={respawnCountdowns[uid] ?? 0} onClick={() => setSelectedHeroUid(uid)} />;
            })}
            {Array.from({ length: 3 - state.team.length }).map((_, i) => <div key={i} className="intentional-empty pm-portrait-slot grid h-[46px] w-[46px] place-items-center"><Star size={13} className="text-[#625c50]" /></div>)}
          </div>
        </div>

        {selectedHero && selectedHeroBase ? (
          <div className="hl-gear-section shrink-0 border-b border-[#4f412e] px-1 py-2.5" style={{ zIndex: 10 }}>
            <div className="hl-gear-head mb-2 flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                <div className="hl-gear-identity flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                  <span className="section-kicker leading-none">Equipped Gear</span>
                  <span className="min-w-0 truncate ui-text-small font-vt font-black" title={`${RARITY_LABEL[selectedHeroBase.rarity]} ${CLASS_LABEL[selectedHeroBase.heroClass]}`} style={{ color: RARITY_COLORS[selectedHeroBase.rarity], textShadow: `0 0 8px ${RARITY_COLORS[selectedHeroBase.rarity]}55` }}>{RARITY_LABEL[selectedHeroBase.rarity]} {CLASS_LABEL[selectedHeroBase.heroClass]}</span>
                </div>
                <span className="group/set relative shrink-0">
                  <button type="button" className={`game-control set-bonus-badge rarity-${selectedSetBonus?.rarity ?? 'common'} ${selectedSetBonus ? 'set-bonus-active' : ''}`} aria-label={selectedSetBonus ? `Set bonus +${selectedSetBonus.percent}%, details` : `Set bonus ${selectedSetProgress} of 8 matching, details`}>
                    <span>SET</span><strong>{selectedSetBonus ? `+${selectedSetBonus.percent}%` : `${selectedSetProgress}/8`}</strong>
                  </button>
                  <span className="set-bonus-tooltip pointer-events-none absolute right-0 top-full z-[70] mt-1 hidden w-80 max-w-[calc(100vw-2rem)] whitespace-normal break-words rounded-lg border border-[#6f5833] bg-[#10120f]/[.98] p-3 text-left ui-text-medium leading-5 text-[#bbb2a2] shadow-2xl group-hover/set:block group-focus-within/set:block">
                    Equip all 8 item slots with one rarity to increase every stat granted by those items.
                    <span className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                      {(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'] as const).map((rarity) => <span key={rarity} className={`set-bonus-rarity flex items-baseline justify-between gap-2 rarity-${rarity}`} style={{ color: RARITY_COLORS[rarity] }}><span>{RARITY_LABEL[rarity]}</span><span className="tabular-nums">+{SET_BONUS_PERCENT[rarity]}%</span></span>)}
                    </span>
                    <span className="mt-2 block border-t border-[#4f412e] pt-1 font-black text-amber-200">Enchant Resonance {selectedEnchantResonance ? `+${selectedEnchantResonance.percent}%` : '—'}</span>
                    <span className="block">Fill all 8 slots. The lowest Enchant level sets the bonus; rarity matching is not required.</span>
                    <span className="mt-2 grid grid-cols-4 gap-x-2 gap-y-1">
                      {ENCHANT_RESONANCE_PERCENT.slice(1).map((percent, index) => <span key={index} className="set-bonus-rarity flex items-baseline justify-between gap-1 text-amber-200"><span>+{index + 1}</span><span className="tabular-nums">{percent}%</span></span>)}
                    </span>
                  </span>
                </span>
                <button type="button" aria-label="Unequip all gear" onClick={async () => { if (!canUnequipAll) return; if (await game.unequipAll(selectedHero.uid)) { setSelectedItem(null); showToast('All gear unequipped'); } else showToast(equipmentFailure('Unequip')); }} disabled={!canUnequipAll} className="game-control hl-gear-unequip flex shrink-0 items-center justify-center gap-1 px-2 ui-text-small font-bold leading-none" title={selectedEquippedCount === 0 ? 'No equipped items' : canUnequipAll ? 'Move all equipped items to Inventory' : 'Not enough Inventory space'}><PackageMinus size={10} aria-hidden="true" />Unequip</button>
            </div>
            <div className="hl-gear-grid grid w-full grid-cols-8 gap-px">
              {SLOTS.map(slot => {
                const eqUid = selectedHero.equipped[slot];
                const item = eqUid ? state.inventory.find(i => i.uid === eqUid) : null;
                const ib = item ? ITEM_MAP[item.itemId] : null;
                const ic = ib ? RARITY_COLORS[ib.rarity] : undefined;
                const slotLabel = EQUIPPED_SLOT_LABEL[slot] ?? SLOT_LABEL[slot];
                return <div key={slot} className="min-w-0 text-center">
                  <button
                    data-equipped-item-uid={item?.uid}
                    onClick={() => { if (item) { setSelectedItem(item); setSelectedItemSource('hero'); setSelectedItemSlot(slot); } else setSelectedItem(null); }}
                    className={`item-slot group aspect-square w-full min-w-0 flex items-center justify-center overflow-hidden ui-text-large border transition hover:-translate-y-0.5 relative ${ib ? `rarity-${ib.rarity}` : ''}`}
                    style={{ borderColor: ic ? `${ic}99` : 'rgba(255,255,255,0.08)', background: 'linear-gradient(145deg,#151c27,#090c11)' }}
                    title={ib ? `${ib.name} +${item!.enchantLevel}` : `Empty ${SLOT_LABEL[slot]}`}
                    aria-label={ib ? `${ib.name}, ${slotLabel}, enchant level ${item!.enchantLevel}` : `Empty ${SLOT_LABEL[slot]}`}
                  >
                    {ib && <RarityFx rarity={ib.rarity} shape="slot" />}
                    {ib ? (
                      <ItemArtwork itemId={ib.id} name={ib.name} fallback={ib.icon} />
                    ) : (
                      <span aria-hidden="true" className="pointer-events-none absolute inset-1 opacity-55 saturate-[.4] brightness-75">
                        <ItemArtwork itemId={emptySlotArtworkId(slot, selectedHeroBase.heroClass)} name="" fallback="" />
                      </span>
                    )}
                    {ib && item!.enchantLevel > 0 && <div className="item-enchant-label absolute left-0 top-0 z-10 ui-text-small font-bold text-amber-400 font-vt leading-none px-0.5">+{item!.enchantLevel}</div>}
                    <ActionFx watch={eqUid ?? ''} scope={selectedHero.uid} variant={item ? 'equip' : 'unequip'} />
                    {item && <ActionFx watch={item.enchantLevel} scope={`${selectedHero.uid}:${item.uid}`} variant="enchant" downVariant="unequip" />}
                    {ib?.heroClass && <ClassGlyph heroClass={ib.heroClass} className="absolute right-0 top-0" />}
                    {ib && <div className="item-level-label absolute bottom-0 right-0 ui-text-small font-bold font-vt px-0.5 leading-none" style={{ background: ic, color: '#000' }}>{item!.level}</div>}
                  </button>
                  <div className="mt-1 min-w-0 truncate text-center ui-text-small font-semibold tracking-[-.03em] text-[#8a867c]" title={SLOT_LABEL[slot]}>{slotLabel}</div>
                </div>;
              })}
            </div>
          </div>
        ) : <div className="px-3 py-3 text-center text-px-dim ui-text-medium font-vt border-b-2 border-px-border shrink-0">Select a hero</div>}

        <div className="hl-inventory-body game-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-3">
          <div className="mb-2 min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              <span className="section-kicker shrink-0">Inventory</span>
              <span className="shrink-0 rounded border border-[#493e2d] bg-black/25 px-1.5 py-0.5 ui-text-small font-bold text-[#8d887d]">{inventoryTab === 'resources' ? resourceSlotCount : bagUsedSlots}/{inventoryTab === 'resources' ? GRID_SIZE : bagOpenSlots}</span>
              <div className="ml-auto flex min-w-0 items-center gap-0.5" role="tablist" aria-label="Inventory sections">
                {([1, 2, 3, 4] as const).map((bag) => <button key={bag} type="button" role="tab" aria-label={`Bag ${bag}${state.bagSlots[bag - 1] === 0 ? ', locked' : ''}`} aria-selected={inventoryTab === bag} onClick={() => { setInventoryTab(bag); setSelectedResource(null); setSelectedItem(null); setBagPurchaseConfirm(false); }} className={`pm-socket game-control ui-text-small relative flex h-6 w-[30px] shrink-0 items-center justify-center gap-px px-0 font-medium ${inventoryTab === bag ? 'game-primary' : ''} ${state.bagSlots[bag - 1] === 0 ? 'opacity-55' : ''}`}><FantasyBagIcon size={14} /><span>{bag}</span>{state.bagSlots[bag - 1] === 0 && <LockIcon size={7} className="absolute right-px top-px" aria-hidden="true" />}</button>)}
                <button type="button" role="tab" aria-label="Resources" title="Resources" aria-selected={inventoryTab === 'resources'} onClick={() => { setInventoryTab('resources'); setSelectedItem(null); }} className={`pm-socket game-control ui-text-small flex h-6 w-[34px] shrink-0 items-center justify-center gap-px px-0 font-medium ${inventoryTab === 'resources' ? 'game-primary' : ''}`}><Package size={13} strokeWidth={1.7} aria-hidden="true" /><span>R</span></button>
              </div>
            </div>
            {inventoryTab !== 'resources' && <div className="mt-2 grid min-w-0 grid-cols-[1fr_1fr_32px_1fr] gap-1">
              <button onClick={() => { game.sortInventory(); showToast('Sorted by rarity'); }} className="game-control flex min-w-0 items-center justify-center gap-1 px-1 py-1 ui-text-medium font-bold" title="Sort by rarity"><ArrowUpDown size={12} /> Sort</button>
              <div className="relative min-w-0">
              <button onClick={async () => { if (state.team.length === 0) return; const message = await game.autoEquipBest() ? 'Best gear equipped on active team' : equipmentFailure('Auto Equip'); if (!isolatedHackathon) { showToast(message); return; } if (autoGearNoticeTimer.current) clearTimeout(autoGearNoticeTimer.current); setAutoGearNotice(message); autoGearNoticeTimer.current = setTimeout(() => setAutoGearNotice(null), 2400); }} disabled={state.team.length === 0} data-guide="equip" className="game-control flex w-full min-w-0 items-center justify-center gap-1 px-1 py-1 ui-text-medium font-bold" title="Equip the strongest valid gear on each active hero in formation order"><Wand2 size={12} /> Auto</button>
              {autoGearNotice && <div role="status" className="auto-gear-notice pointer-events-none absolute left-1/2 top-full z-40 mt-1 w-52 -translate-x-1/2 rounded border border-[#9e7b3d] bg-[#15130f] px-2 py-1 text-center ui-text-small font-bold text-[#f2d393] shadow-lg">{autoGearNotice}</div>}
              </div>
              <button type="button" aria-label={inventoryLockMode ? 'Exit Inventory Lock mode' : 'Enter Inventory Lock mode'} aria-pressed={inventoryLockMode} onClick={() => { setInventoryLockMode((active) => !active); setSelectedItem(null); setSelectedItemSource(null); setSelectedItemSlot(null); setShowBulkSellConfirm(false); }} className={`game-control grid min-w-0 place-items-center px-0 py-1 ${inventoryLockMode ? 'border-red-500/70 bg-red-950/55 text-red-300' : 'text-[#a69c8c]'}`} title={inventoryLockMode ? 'Lock mode active — click to exit' : 'Lock mode — click items to lock or unlock'}><LockIcon size={13} /></button>
              <div className="relative">
                <button onClick={() => setShowBulkSellConfirm((value) => !value)} disabled={unlockedSellTotal === 0} className="game-control game-danger flex min-w-0 w-full items-center justify-center gap-1 px-1 py-1 ui-text-medium font-bold" title={`Sell all unlocked items for ${formatNum(unlockedSellTotal)} gold`}><Coins size={12} /> Sell</button>
                {showBulkSellConfirm && <div className="item-sell-confirm absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-[#80502d] p-2 text-left shadow-xl"><p className="ui-text-small font-bold text-[#ead9bf]">Sell all unlocked items for {formatNum(unlockedSellTotal)} Gold?</p><div className="mt-1.5 grid grid-cols-2 gap-1"><button type="button" onClick={() => setShowBulkSellConfirm(false)} className="game-control py-1 ui-text-small font-bold">Cancel</button><button type="button" onClick={async (event) => { const coinAnchor = event.currentTarget.closest('.item-sell-confirm')?.parentElement; setShowBulkSellConfirm(false); const limited = bagItems.filter((item) => !item.locked && !item.serverOwned && ['divine', 'celestial'].includes(ITEM_MAP[item.itemId]?.rarity ?? '')); await Promise.allSettled(limited.map((item) => tok.removeLimitedItem(item.uid))); const unsold = await game.sellAllUnlocked(); flyCoins(coinAnchor); if (unsold > 0) showToast(`${unsold} item${unsold === 1 ? '' : 's'} could not be sold`); }} className="rounded border border-rose-500/45 bg-rose-500/15 py-1 ui-text-small font-black text-rose-200">Sell all</button></div></div>}
              </div>
            </div>}
            {inventoryTab !== 'resources' && inventoryLockMode && <div className="mt-1.5 rounded-md border border-red-500/45 bg-red-950/35 px-2 py-1 text-center ui-text-small font-bold text-red-200" role="status">LOCK MODE · click an item to lock or unlock it</div>}
          </div>
          {inventoryTab === 'resources' ? <div className="min-w-0">
            <div className="grid min-w-0 grid-cols-8 gap-1 overflow-hidden">
            <button type="button" aria-label={`Summon Scrolls: ${formatNum(state.summonScrolls)}`} aria-pressed={selectedResource === 'summon-scroll'} onClick={() => setSelectedResource((current) => current === 'summon-scroll' ? null : 'summon-scroll')} className={`item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-violet-400/55 ${selectedResource === 'summon-scroll' ? 'ring-2 ring-violet-300 ring-offset-1 ring-offset-black' : ''}`} title={`Summon Scrolls: ${formatNum(state.summonScrolls)}`}><span className="resource-slot-art" aria-hidden="true"><SummonScrollArtwork size={48} /></span><span className="ui-text-small absolute bottom-0 right-0 z-10 min-w-3 rounded-tl bg-violet-400 px-px text-center font-bold leading-3 text-black">{formatNum(state.summonScrolls)}</span></button>
            <button type="button" aria-label={`Boss Keys: ${formatNum(state.bossKeys)}`} aria-pressed={selectedResource === 'boss-key'} onClick={() => setSelectedResource((current) => current === 'boss-key' ? null : 'boss-key')} className={`item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-amber-400/55 ${selectedResource === 'boss-key' ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-black' : ''}`} title={`Boss Keys: ${formatNum(state.bossKeys)}`}><span className="resource-slot-art" aria-hidden="true"><BossKeyIcon size={48} /></span><span className="ui-text-small absolute bottom-0 right-0 z-10 min-w-3 rounded-tl bg-amber-400 px-px text-center font-bold leading-3 text-black">{formatNum(state.bossKeys)}</span></button>
            <button type="button" aria-label={`Chests: ${state.chests.length}, Boss Chests: ${bossChestCount}`} aria-pressed={selectedResource === 'chests'} onClick={() => setSelectedResource((current) => current === 'chests' ? null : 'chests')} className={`item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-amber-400/55 ${selectedResource === 'chests' ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-black' : ''}`} title={`Chests: ${state.chests.length} · Boss: ${bossChestCount}`}><span className="resource-slot-art" aria-hidden="true"><ChestCollectIcon size={48} /></span><span className="ui-text-small absolute bottom-0 right-0 z-10 min-w-3 rounded-tl bg-amber-400 px-px text-center font-bold leading-3 text-black">{formatNum(state.chests.length)}</span></button>
            {visiblePotions.map((potion) => <button type="button" key={potion.tier} className="item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-emerald-500/50" title={`${potion.name}: ${isolatedHackathon ? ordinaryStock : state.potions[potion.tier]}`}><ItemArtwork itemId={`potion-${potion.tier}`} name={potion.name} fallback="Potion" /><span className="ui-text-small absolute bottom-0 right-0 z-10 min-w-3 rounded-tl bg-emerald-500 px-px text-center font-bold leading-3 text-black">{isolatedHackathon ? ordinaryStock : state.potions[potion.tier]}</span></button>)}
            {Array.from({ length: GRID_SIZE - resourceSlotCount }, (_, index) => <div key={`resource-empty-${index}`} className="item-slot aspect-square min-w-0 w-full border" style={{ borderColor: 'rgba(128,119,100,0.11)', background: 'linear-gradient(145deg,#151612,#0c0e0d)' }} />)}
            </div>
            {selectedResource && selectedResource !== 'chests' && <div className={`mt-2 rounded-lg border p-2 ${selectedResource === 'summon-scroll' ? 'border-violet-400/45 bg-violet-950/20' : 'border-amber-400/45 bg-amber-950/20'}`}><div className="flex items-center gap-2">{selectedResource === 'summon-scroll' ? <SummonScrollArtwork size={40} /> : <BossKeyIcon size={40} />}<div className="min-w-0"><strong className="ui-text-large block text-[#efe4ce]">{selectedResource === 'summon-scroll' ? 'Summon Scroll' : 'Boss Key'}</strong><span className="ui-text-small text-[#9b9283]">Owned: {formatNum(selectedResource === 'summon-scroll' ? state.summonScrolls : state.bossKeys)}</span></div></div><p className="ui-text-medium mt-1.5 leading-snug text-[#c9c0b1]">{selectedResource === 'summon-scroll' ? 'Persistent consumable for one future Free Summon. Scroll spending is not available until server-authoritative Free Summon launches.' : 'Non-deletable resource used only to summon a Boss. One summon consumes one key; a Boss Chest is awarded only after victory.'}</p></div>}
            {selectedResource === 'chests' && <div className="mt-2 rounded-lg border border-amber-400/45 bg-amber-950/20 p-2"><strong className="ui-text-large block text-[#efe4ce]">Chests</strong><p className="ui-text-medium mt-1.5 text-[#c9c0b1]">Owned: {state.chests.length} · Boss Chests: {bossChestCount}. Boss Hunt rewards enter this chest queue after Claim Boss Rewards.</p><button type="button" disabled={state.chests.length === 0 || game.chestOpening} onClick={() => { if (bagItemCount(state) >= inventoryCapacity(state)) { setShowInventoryFull(true); return; } void game.openChests(tok.status?.rarity_capacity ?? {}, tok.reserveLimitedItem); }} className="game-control game-primary mt-2 !min-h-[44px] px-3 py-2 ui-text-medium font-bold disabled:opacity-55">{game.chestOpening ? 'OPENING…' : 'OPEN CHESTS'}</button></div>}
          </div> : <div className={`hl-equipment-grid grid min-w-0 grid-cols-8 gap-px overflow-hidden ${inventoryLockMode ? 'inventory-lock-cursor' : ''}`}>
            {cells.slice(0, bagOpenSlots).map((item, i) => {
              const itemBase = item ? ITEM_MAP[item.itemId] : null;
              const rarity = itemBase?.rarity ?? (item ? 'common' : null);
              const rc = rarity ? RARITY_COLORS[rarity] : null;
              const gridIndex = i;
              return (
                <Fragment key={item ? item.uid : `e${i}`}>
                <button
                  data-inventory-item-uid={item?.uid}
                  aria-label={i >= bagOpenSlots ? `Bag ${activeBag} slot ${i + 1} locked` : item ? undefined : `Bag ${activeBag} slot ${i + 1} empty`}
                  disabled={i >= bagOpenSlots}
                  onClick={item ? () => { if (inventoryLockMode) { game.toggleItemLock(item.uid); showToast(item.locked ? 'Item unlocked' : 'Item locked'); return; } setSelectedItem(item); setSelectedItemSource('bag'); setSelectedItemSlot(null); } : undefined}
                  className={`item-slot aspect-square min-w-0 w-full flex items-center justify-center overflow-hidden text-xl border transition hover:-translate-y-0.5 relative ${item && rarity ? `rarity-${rarity}` : ''} ${selectedItem?.uid === item?.uid ? 'ring-1 ring-[#d9ad5b]' : ''} ${i >= bagOpenSlots ? 'opacity-70' : ''}`}
                  style={item ? { borderColor: rc ? `${rc}99` : 'rgba(255,255,255,0.08)' } : { borderColor: i >= bagOpenSlots ? 'rgba(130,103,63,0.35)' : 'rgba(128,119,100,0.11)', background: i >= bagOpenSlots ? 'linear-gradient(145deg,#181612,#080909)' : 'linear-gradient(145deg,#151612,#0c0e0d)' }}
                >
                  {i >= bagOpenSlots && <LockIcon size={13} className="text-[#8f7652]" aria-hidden="true" />}
                  {item && <ItemArtwork itemId={item.itemId} name={ITEM_MAP[item.itemId]?.name ?? 'Item'} fallback={ITEM_MAP[item.itemId]?.icon ?? '◆'} className="leading-none" />}
                  {item && rarity && <RarityFx rarity={rarity} shape="slot" />}
                  {item?.locked && <LockIcon size={11} className="absolute bottom-0.5 left-0.5 z-10 text-amber-300" />}
                  {item && item.enchantLevel > 0 && <div className="item-enchant-label absolute left-0 top-0 z-10 ui-text-small font-bold text-amber-400 font-vt leading-3 px-px">+{item.enchantLevel}</div>}
                  {item && <ActionFx watch={Boolean(item.locked)} scope={item.uid} variant={item.locked ? 'lock' : 'unlock'} />}
                  {item && <ActionFx watch={item.enchantLevel} scope={item.uid} variant="enchant" downVariant="unequip" />}
                  {itemBase?.heroClass && <ClassGlyph heroClass={itemBase.heroClass} className="absolute right-0 top-0" />}
                  {item && <span className="item-level-label ui-text-small absolute bottom-0 right-0 min-w-3 rounded-tl px-px text-center font-bold leading-3 text-black" style={{ background: rc ?? RARITY_COLORS.common }} title={`Item level ${item.level}`}>{item.level}</span>}
                </button>
                {gridIndex === selectedBagRowEnd && liveSelectedItem && selectedItemSource === 'bag' && <div className="col-span-8 rounded-lg border border-[#6e5837] bg-[#10120f] p-2 shadow-inner"><ItemActionPanel item={liveSelectedItem} game={game} equippedSlot={null} comparisonItem={comparisonItem} equipDisabledReason={selectedEquipReason} onEquip={async (slot) => { if (!selectedHero) return; if (await game.equipItem(selectedHero.uid, liveSelectedItem.uid, slot)) { setSelectedItem(null); showToast('Item equipped'); } else showToast(equipmentFailure('Equip')); }} onBeforeSell={async (selected) => { if (selected.serverOwned) return true; const selectedRarity = ITEM_MAP[selected.itemId]?.rarity; return selectedRarity === 'divine' || selectedRarity === 'celestial' ? tok.removeLimitedItem(selected.uid) : true; }} onClose={() => setSelectedItem(null)} /></div>}
                </Fragment>
              );
            })}
            {bagOpenSlots < GRID_SIZE && <div data-inventory-locked-region className="col-span-8 grid min-w-0">
              <div data-inventory-locked-cells className="col-start-1 row-start-1 grid min-w-0 grid-cols-8 gap-px">
                {Array.from({ length: GRID_SIZE - bagOpenSlots }, (_, index) => <button key={`locked-${index}`} type="button" disabled aria-label={`Bag ${activeBag} slot ${bagOpenSlots + index + 1} locked`} className="item-slot aspect-square flex min-w-0 w-full items-center justify-center overflow-hidden border opacity-70" style={{ borderColor: 'rgba(130,103,63,0.35)', background: 'linear-gradient(145deg,#181612,#080909)' }}><LockIcon size={13} className="text-[#8f7652]" aria-hidden="true" /></button>)}
              </div>
            {bagQuote && !bagQuote.complete && bagQuote.bag === inventoryTab && <div className="col-start-1 row-start-1 z-10 m-1 min-w-0 max-w-full self-center justify-self-center text-center ui-text-small text-[#e5d4b4]">
              {isolatedHackathon && <SkrPurchaseButton product="inventory_bag_buy" params={{bag:bagQuote.bag,kind:bagQuote.kind}}
                label={<>{bagQuote.kind==='buy'?'Unlock':'Upgrade'} Bag {bagQuote.bag} · {bagSkrRate ? skrPrice(bagQuote.catalogue_usd_cents, bagSkrRate) : '… SKR'}<SkrUsd cents={bagQuote.catalogue_usd_cents}/></>}
                onDelivered={result=>{game.applySeekerPurchase(result);setBagQuote(null);showToast('Bag capacity unlocked with SKR');}} />}
              {!isolatedHackathon && !bagPurchaseConfirm && <button type="button" data-inventory-bag-action className="game-control game-primary min-h-11 max-w-full px-3 py-1.5 font-bold disabled:opacity-50" disabled={!bagQuote.available || bagPurchaseBusy || !Number.isFinite(bagQuote.token_cost)} onClick={() => setBagPurchaseConfirm(true)}><span className="block whitespace-normal leading-tight">{bagQuote.kind === 'buy' ? `Unlock Bag ${bagQuote.bag} · 48 cells` : `Upgrade Bag ${bagQuote.bag} · +16 cells`} · ${(bagQuote.catalogue_usd_cents / 100).toFixed(0)} in $HERO</span><span className="block leading-tight">{bagQuote.available ? `${formatNum(bagQuote.token_cost)} $HERO` : 'Quote unavailable'}</span></button>}
              {!isolatedHackathon && bagPurchaseConfirm && <div className="flex max-w-full flex-wrap items-center justify-center gap-1" role="group" aria-label="Confirm bag purchase"><span>Spend up to {formatNum(bagQuote.token_cost)} $HERO?</span><button type="button" className="game-control min-h-11 px-2" onClick={() => setBagPurchaseConfirm(false)}>Cancel</button><button type="button" className="game-control game-primary min-h-11 px-2 font-bold" disabled={bagPurchaseBusy} onClick={async () => { setBagPurchaseBusy(true); const result = await game.buyInventoryBag(bagQuote.bag, bagQuote.kind, bagQuote.token_cost); setBagPurchaseBusy(false); setBagPurchaseConfirm(false); if (result.ok) setBagQuote(null); showToast(result.ok ? 'Bag capacity unlocked' : `Bag purchase failed: ${result.error}`); }}>{bagPurchaseBusy ? 'Processing…' : 'Confirm'}</button></div>}
            </div>}
            {bagOpenSlots === 0 && bagQuote && !bagQuote.complete && bagQuote.bag !== inventoryTab && <p className="col-start-1 row-start-1 z-10 m-2 self-center justify-self-center text-center ui-text-small text-[#a9a092]">Unlock and upgrade earlier bags first.</p>}
            {bagQuoteReady && !bagQuote && <button type="button" className="game-control col-start-1 row-start-1 z-10 m-1 min-h-11 max-w-full self-center justify-self-center px-2 ui-text-small" onClick={() => void game.quoteInventoryBag().then(setBagQuote)}>Refresh bag price</button>}
            </div>}
          </div>}
        </div>

        {liveSelectedItem && selectedItemSource === 'hero' && (
          <div className="border-t-2 border-px-border p-2 shrink-0 max-h-[45%] overflow-y-auto no-scrollbar">
            <ItemActionPanel
              item={liveSelectedItem}
              game={game}
              equippedSlot={selectedItemSource === 'hero' ? selectedItemSlot : null}
              comparisonItem={comparisonItem}
              equipDisabledReason={selectedEquipReason}
              onUnequip={selectedItemSource === 'hero' && selectedItemSlot ? async () => { if (!selectedHero) return; if (await game.unequipItem(selectedHero.uid, selectedItemSlot)) setSelectedItem(null); else showToast(equipmentFailure('Unequip')); } : undefined}
              onBeforeSell={async (item) => {
                if (item.serverOwned) return true;
                const rarity = ITEM_MAP[item.itemId]?.rarity;
                return rarity === 'divine' || rarity === 'celestial' ? tok.removeLimitedItem(item.uid) : true;
              }}
              onClose={() => setSelectedItem(null)}
            />
          </div>
        )}
      </div>

      {showInventoryFull && <InventoryFullModal onClose={closeInventoryFull} />}
      {toast && createPortal(
        <div role="status" className="hl-toast fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-px-panel border-2 border-px-bright font-vt ui-text-large font-bold text-px-bright anim-slide-up" style={{ boxShadow: '3px 3px 0 #3d2008' }}>{toast}</div>,
        document.body,
      )}
      {isAndroidLayout && commanderOpen && createPortal(
        <div className="hl-portal hl-commander-sheet" role="dialog" aria-modal="true" aria-label="Commander" onClick={() => setCommanderOpen(false)}>
          <div className="hl-commander-sheet-panel material-panel" onClick={(event) => event.stopPropagation()}>
            {commanderPanel}
          </div>
        </div>,
        document.body,
      )}
      {showAvatarPicker && <AvatarPicker game={game} onClose={() => setShowAvatarPicker(false)} />}
      {isolatedHackathon && SHOW_HACKATHON_HEALING_INTRODUCTION && !state.autoPot.healingInfoSeen && <HealingIntroduction game={game} />}
      {showDungeonInfo && <DungeonPreviewModal accountLevel={state.accountLevel} onStatus={enterDungeonArena} onClose={() => setShowDungeonInfo(false)} onGuidesClick={() => { setShowDungeonInfo(false); onGuidesClick(); }} />}
    </div>
  );
}

function DungeonBattleControls({ checkpoint, attempts, autoRun, onChange, onAttempts, onCombatPulse, onHydrate, onComplete }: {
  checkpoint: DungeonCheckpoint;
  autoRun: boolean;
  attempts: { remaining: number; max: number } | null;
  onChange: (checkpoint: DungeonCheckpoint | null) => void;
  onAttempts: (attempts: { remaining: number; max: number } | null) => void;
  onCombatPulse: (floaters: FloatingNumber[]) => void;
  onHydrate: (state: unknown) => void;
  onComplete: (won: boolean, gold?: number, scrolls?: number, premium?: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const roomState = checkpoint.room_state;
  const rewardCount = (value: unknown) => {
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  };
  const rewardPreview = roomState?.reward_preview;

  const checkpointFromResult = (base: DungeonCheckpoint, result: Record<string, unknown>): DungeonCheckpoint => ({
    ...base,
    room: Number(result.room ?? base.room),
    revision: Number(result.revision ?? base.revision),
    run_state: (result.run_state ?? base.run_state) as DungeonCheckpoint['run_state'],
    room_state: (result.room_state ?? null) as DungeonCheckpoint['room_state'],
  });

  const requestAction = (action: string, payload: Record<string, unknown>) => playerSync<Record<string, unknown>>(
    action,
    { ...payload, idempotency_key: crypto.randomUUID() },
    (message) => setError(message === 'rate_limited' ? 'Please wait a few seconds before repeating this Dungeon action.' : message),
  );

  const runAction = async (action: string, payload: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true); setError(''); setConfirmAbandon(false);
    const result = await requestAction(action, payload);
    if (result) {
      if (result.state) onHydrate(result.state);
      if (action === 'dungeon_abandon' || (result.status && result.status !== 'active')) {
        if (attempts) onAttempts({ remaining: Number(result.attempts_remaining ?? attempts.remaining), max: attempts.max });
        if (action !== 'dungeon_abandon') onComplete(result.status === 'completed', Number(result.gold) || 0, Number(result.scrolls_awarded) || 0, Number(result.premium_potions_awarded) || 0);
        onChange(null);
      } else {
        onChange(checkpointFromResult(checkpoint, result));
      }
    }
    setBusy(false);
  };

  const playServerCombat = async (ready: DungeonCheckpoint, result: Record<string, unknown>) => {
    const resolved = checkpointFromResult(ready, result);
    const startState = ready.room_state;
    const finalState = resolved.room_state;
    if (!startState || !finalState) { onChange(resolved); return; }
    const bossFight = startState.kind === 'shared_boss';
    // Boss frames stay at 36: the cast bars read playback ticks 3-6 and 9-15 (Heavy Strike lands on 15).
    const totalFrames = bossFight ? 36 : 24;
    const authoritativeDuration = Math.max(totalFrames * 450, Number(finalState.elapsed_ms ?? totalFrames * 450));
    const frameDuration = authoritativeDuration / totalFrames;
    const playback = planDungeonPlayback(resolved.room, startState, finalState, totalFrames);
    let pulseId = Date.now() * 32;
    let nextPremiumEvent = 0;
    const premiumEvents = finalState.premium_potion_events ?? [];
    // Keep each number for the same 1.5 seconds as ordinary combat, across playback frames.
    let shown: FloatingNumber[] = [];
    const publishPulses = () => {
      const now = performance.now();
      shown = shown.filter((pulse) => now - pulse.born < 1500);
      onCombatPulse([...shown]);
    };
    const waitForFeedback = async (duration: number) => {
      const deadline = performance.now() + duration;
      while (performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - performance.now())));
        publishPulses();
      }
    };
    for (let frame = 1; frame <= totalFrames; frame += 1) {
      const { heroes: nextHeroes, enemies: nextEnemies, pulses } = playback[frame - 1];
      const frameStarted = performance.now();
      while (nextPremiumEvent < premiumEvents.length && premiumEvents[nextPremiumEvent].elapsed_ms <= frame * Number(finalState.elapsed_ms ?? authoritativeDuration) / totalFrames) {
        const event = premiumEvents[nextPremiumEvent++];
        pulses.push({ targetUid: event.hero_uid, value: Math.round(event.amount), crit: false, heal: true, label: `PREMIUM +${Math.round(event.amount)}` });
      }
      onChange({
        ...resolved,
        room_state: {
          ...finalState,
          status: frame < totalFrames ? 'resolving' : finalState.status,
          heroes: nextHeroes,
          enemies: nextEnemies,
          playback_tick: frame,
        },
      });
      // Hits that share a frame land one after another inside it rather than as one simultaneous volley.
      for (let order = 0; order < pulses.length; order += 1) {
        if (order > 0) await waitForFeedback((frameDuration * 0.7) / pulses.length);
        shown.push({ ...pulses[order], id: pulseId++, born: performance.now() });
        publishPulses();
      }
      const rest = frameDuration - (performance.now() - frameStarted);
      if (frame < totalFrames && rest > 0) await waitForFeedback(rest);
    }
    await waitForFeedback(1500);
    onCombatPulse([]);
    if (result.status && result.status !== 'active') {
      onComplete(result.status === 'completed');
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      onChange(null);
      return;
    }
    // A cleared Retinue reveals the Boss, and a killed Boss is verified at once (Founder 2026-10-05: no separate
    // Verify Victory step), so the panel goes straight to the Claim.
    if ((startState.kind === 'retinue' || bossFight) && finalState.status === 'cleared') {
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      const revealed = await requestAction('dungeon_room_complete', {
        encounter_id: resolved.encounter_id,
        expected_revision: resolved.revision,
      });
      if (revealed?.status && revealed.status !== 'active') {
        if (revealed.state) onHydrate(revealed.state);
        onComplete(revealed.status === 'completed', Number(revealed.gold) || 0, Number(revealed.scrolls_awarded) || 0, Number(revealed.premium_potions_awarded) || 0);
        onChange(null);
      } else if (revealed) onChange(checkpointFromResult(resolved, revealed));
    }
  };

  const startBattle = async () => {
    if (busy) return;
    setBusy(true); setError(''); setConfirmAbandon(false);
    let ready = checkpoint;
    if (!ready.room_state) {
      const started = await requestAction('dungeon_room_start', {
        encounter_id: ready.encounter_id,
        expected_revision: ready.revision,
      });
      if (!started) { setBusy(false); return; }
      ready = checkpointFromResult(ready, started);
      onChange(ready);
    }
    if (ready.room_state?.status !== 'ready') { setBusy(false); return; }
    const resolved = await requestAction('dungeon_room_action', {
      encounter_id: ready.encounter_id,
      expected_revision: ready.revision,
      command: 'resolve',
    });
    if (resolved?.state) onHydrate(resolved.state);
    if (resolved) await playServerCombat(ready, resolved);
    setBusy(false);
  };

  const primary = (() => {
    if (checkpoint.room === 3 && !roomState) return null;
    if (roomState?.status === 'boss_locked') return {
      label: 'Reveal Boss',
      action: () => runAction('dungeon_room_complete', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision }),
    };
    if (roomState?.status === 'reward_locked') return {
      label: checkpoint.type === 'boss_hunt' ? 'Claim Boss Rewards' : rewardPreview?.reward_table_version === 'dungeon-reward-v3' && rewardCount(rewardPreview?.summon_scrolls) === 2 ? 'Claim 2 Scrolls' : 'Finish test run',
      action: () => runAction(checkpoint.type === 'boss_hunt' ? 'boss_claim' : 'dungeon_room_complete', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision }),
    };
    if (roomState?.status === 'resolving') return null;
    if (!roomState) return checkpoint.room === 3 ? null : {
      label: `Start Room ${checkpoint.room}`,
      action: startBattle,
    };
    if (roomState.status === 'ready') return {
      label: roomState.kind === 'shared_boss' ? 'Fight Boss' : `Start Room ${checkpoint.room}`,
      action: startBattle,
    };
    return {
      label: roomState.status === 'cleared' ? (checkpoint.room === 4 && roomState.kind === 'shared_boss' ? (checkpoint.type === 'boss_hunt' ? 'Verify Victory' : 'Complete Dungeon') : checkpoint.room === 4 ? 'Reveal Boss' : `Continue to Room ${checkpoint.room + 1}`) : 'Leave defeated run',
      action: () => runAction('dungeon_room_complete', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision }),
    };
  })();

  // Founder 2026-10-05: fewer presses. Once the player is in the run, rooms start, clear and advance on their
  // own; only the Room 3 path choice, a defeat and the reward Claim wait for a press. A run restored on app
  // load waits for one press first.
  const [engaged, setEngaged] = useState(autoRun);
  const autoStep = roomState?.status === 'reward_locked' || roomState?.status === 'failed' || roomState?.status === 'resolving' ? null
    : !roomState ? (checkpoint.room === 3 ? null : 'start')
      : roomState.status === 'ready' ? 'start'
        : roomState.status === 'cleared' || roomState.status === 'boss_locked' ? 'advance' : null;
  const autoKey = autoStep ? `${checkpoint.encounter_id}:${checkpoint.revision}:${autoStep}` : '';
  const lastAutoKey = useRef('');
  useEffect(() => {
    if (!engaged || !autoKey || busy || error || lastAutoKey.current === autoKey) return undefined;
    const timer = window.setTimeout(() => {
      lastAutoKey.current = autoKey;
      if (autoStep === 'start') void startBattle();
      else void runAction('dungeon_room_complete', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision });
    }, autoStep === 'start' ? 500 : 1100);
    return () => window.clearTimeout(timer);
    // The key carries the encounter revision and step; the handlers read that same checkpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, autoKey, busy, error]);

  return <aside className="dungeon-battle-panel" aria-label={checkpoint.type === 'boss_hunt' ? 'Boss Hunt controls' : 'Dungeon battle controls'}>
    <div className="dungeon-panel-head flex items-center justify-between ui-text-small font-black uppercase tracking-wide text-[#b7a9c0]"><span>{roomState?.modifier?.split('_').join(' ') ?? (roomState?.kind?.split('_').join(' ') || 'Ready')}</span><span className="flex items-center gap-1">{checkpoint.type === 'boss_hunt' ? <><BossKeyIcon size={16} /> 1 Boss Key spent</> : attempts ? `${attempts.remaining}/${attempts.max} attempts` : '— attempts'}</span></div>
    <div className="dungeon-panel-body grid w-full gap-2">
      {roomState?.status === 'cleared' && <div className="dungeon-panel-status text-center ui-text-medium font-black uppercase tracking-wider text-emerald-300">Room cleared</div>}
      {roomState?.status === 'failed' && <div className="dungeon-panel-status text-center ui-text-medium font-black uppercase tracking-wider text-rose-300">Formation defeated</div>}
      {busy && <div className="dungeon-panel-status text-center ui-text-medium font-black uppercase tracking-wide text-violet-200">Battle in progress…</div>}
      {checkpoint.room === 3 && !roomState && <div className="grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => runAction('dungeon_room_choose', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision, choice: 'recovery' })} className="game-control min-h-11 px-2 ui-text-small font-black text-emerald-300"><HeartPulse size={15} className="mx-auto mb-1" />Recovery · +25% HP</button><button type="button" disabled={busy} onClick={() => runAction('dungeon_room_choose', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision, choice: 'treasure' })} className="game-control min-h-11 px-2 ui-text-small font-black text-amber-300"><Gem size={15} className="mx-auto mb-1" />Treasure fight</button></div>}
      {checkpoint.room === 4 && roomState?.boss && <div className="dungeon-panel-boss-line rounded-lg border border-amber-800/45 bg-amber-950/20 px-3 py-2 text-center ui-text-small font-bold text-amber-200">{roomState.boss.name} · {roomState.status === 'reward_locked' ? 'Defeated · Rewards locked' : roomState.kind === 'shared_boss' ? 'Vulnerable · Shared target' : roomState.status === 'boss_locked' ? 'Retinue defeated · Boss vulnerable' : 'Protected by Retinue'}</div>}
      {/* Founder 2026-10-05: a won run goes straight to Claim; the run summary covered the party. */}
      {roomState?.status === 'cleared' && checkpoint.room < 4 && <div className="rounded border border-amber-700/35 bg-amber-950/20 px-2 py-1.5 text-center ui-text-small font-bold text-amber-200">Room reward preview · Gold + XP · settlement disabled in testing</div>}
      {primary && <button type="button" disabled={busy} onClick={() => { setEngaged(true); void primary.action(); }} className="dungeon-panel-primary game-control game-primary min-h-11 px-3 ui-text-medium font-black"><Skull size={17} className="mr-2 inline" />{primary.label}</button>}
      {error && <div role="alert" className="text-center ui-text-small font-bold text-rose-300">{error.split('_').join(' ')}</div>}
      {/* Founder 2026-10-08: a won fight waiting for its Claim has nothing to abandon. */}
      {roomState?.status !== 'reward_locked' && <button type="button" disabled={busy} onClick={() => confirmAbandon ? void runAction('dungeon_abandon', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision }) : setConfirmAbandon(true)} className="dungeon-panel-abandon game-control min-h-10 px-3 ui-text-medium font-bold text-rose-300">{confirmAbandon ? 'Confirm exit · no refund' : checkpoint.type === 'boss_hunt' ? 'Abandon Boss Hunt' : 'Exit Dungeon'}</button>}
    </div>
  </aside>;
}

function DungeonPreviewModal({ onStatus, onClose, onGuidesClick }: { accountLevel: number; onStatus: (status: DungeonStatus) => void; onClose: () => void; onGuidesClick: () => void }) {
  const [status, setStatus] = useState<DungeonStatus | null>(null);
  const [depth, setDepth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onCloseRef = useRef(onClose);
  const onStatusRef = useRef(onStatus);
  const active = status?.active_encounter?.type === 'dungeon' ? status.active_encounter : null;
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', closeOnEscape);
    void playerSync<DungeonStatus>('dungeon_status', {}, (message) => setError(message === 'rate_limited' ? 'Dungeon status is cooling down. Reopen in a few seconds.' : message))
      .then((result) => { if (result) { setStatus(result); setError(''); onStatusRef.current(result); } });
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  const runAction = async (action: string, payload: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    const result = await playerSync<Record<string, unknown>>(action, { ...payload, idempotency_key: crypto.randomUUID() }, (message) => setError(message === 'rate_limited' ? 'Please wait a few seconds before repeating this Dungeon action.' : message));
    if (result && action === 'dungeon_start' && status) {
      const encounter = result.encounter as Omit<DungeonCheckpoint, 'room_state'> | undefined;
      if (encounter) {
        const next: DungeonStatus = {
          ...status,
          attempts_remaining: Number(result.attempts_remaining ?? status.attempts_remaining),
          active_encounter: { ...encounter, type: 'dungeon', room_state: null },
        };
        setStatus(next);
        onStatusRef.current(next);
      }
    } else if (result) setStatus((current) => {
      if (!current) return current;
      if (action === 'dungeon_abandon') return {
        ...current,
        attempts_remaining: Number(result.attempts_remaining ?? current.attempts_remaining),
        active_encounter: null,
      };
      if (current.active_encounter?.type !== 'dungeon' || result.encounter_id !== current.active_encounter.encounter_id) return current;
      if (result.status && result.status !== 'active') return { ...current, active_encounter: null };
      return {
        ...current,
        active_encounter: {
          ...current.active_encounter,
          room: Number(result.room ?? current.active_encounter.room),
          revision: Number(result.revision ?? current.active_encounter.revision),
          room_state: (result.room_state ?? null) as DungeonCheckpoint['room_state'],
        },
      };
    });
    setBusy(false);
  };
  const primary = (() => {
    if (!status) return { label: 'Loading Dungeon…', disabled: true, action: () => undefined };
    if (status.active_encounter?.type === 'boss_hunt') return { label: 'Boss Hunt is active', disabled: true, action: () => undefined };
    if (!active) return {
      // Temporary (Founder 2026-10-05): any Account Level may enter; the Level 30 copy stays.
      label: `Enter Depth ${depth} · Uses 1 Attempt`,
      disabled: status.attempts_remaining < 1,
      action: () => runAction('dungeon_start', { depth }),
    };
    if (active.room === 3 && !active.room_state) return { label: 'Choose Recovery or Treasure', disabled: true, action: () => undefined };
    if (!active.room_state) return {
      label: `Start Room ${active.room}`,
      disabled: active.room > 2,
      action: () => runAction('dungeon_room_start', { encounter_id: active.encounter_id, expected_revision: active.revision }),
    };
    if (active.room_state.status === 'ready') return {
      label: active.room === 3 ? 'Resolve Treasure Guards' : active.room === 2 ? 'Resolve Elite Room' : 'Resolve Room 1', disabled: false,
      action: () => runAction('dungeon_room_action', { encounter_id: active.encounter_id, expected_revision: active.revision, command: 'resolve' }),
    };
    return {
      label: active.room_state.status === 'cleared' ? `Continue to Room ${active.room + 1}` : 'Close defeated run', disabled: false,
      action: () => runAction('dungeon_room_complete', { encounter_id: active.encounter_id, expected_revision: active.revision }),
    };
  })();
  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/80 p-3 backdrop-blur-[5px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="dungeon-preview-title" className="dungeon-gate-modal game-scrollbar max-h-[96vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-[#76569b] p-3 shadow-[0_28px_100px_rgba(0,0,0,.85),0_0_38px_rgba(118,86,155,.18)]">
        <header className="dungeon-gate-header flex items-start gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[#8965ad] bg-[#281d33] text-[#d8b4fe] shadow-[inset_0_1px_rgba(255,255,255,.08),0_0_18px_rgba(168,85,247,.15)]"><DoorOpen size={23} /></div>
          <div className="min-w-0 flex-1"><div className="section-kicker">Live testing</div><div className="mt-1 flex flex-wrap items-center gap-2"><h2 id="dungeon-preview-title" className="font-vt ui-text-large font-black text-[#f0e5ce]">Dungeons</h2><span className="rounded-full border border-emerald-700/60 bg-emerald-950/35 px-2 py-0.5 ui-text-small font-black uppercase tracking-wider text-emerald-300">Server active</span></div><p className="mt-1 ui-text-medium leading-5 text-[#aca1b2]">Level 30+ testing · persistent HP · 100 Attempts each week · only the first 3 entries can earn Boss Scrolls.</p></div>
          <aside className="dungeon-gate-quick"><span>Weekly attempts</span><b>{status ? `${status.attempts_remaining} / ${status.attempts_max}` : 'Loading…'}</b>{active && <small>Depth {active.depth} · Room {active.room} of 4</small>}</aside>
          <button type="button" autoFocus onClick={onClose} className="game-control grid h-9 w-9 shrink-0 place-items-center" aria-label="Close Dungeons information"><X size={15} /></button>
        </header>

        {!active && <div className="dungeon-depth-picker" aria-label="Dungeon depth">{[1, 2, 3].map((value) => <button key={value} type="button" disabled={busy} onClick={() => setDepth(value)} className={depth === value ? 'is-selected' : ''}><span>Depth {value}</span><small>{value === 1 ? 'Ruined Fortress' : value === 2 ? 'Inner Keep' : 'Abyss Foundation'}</small></button>)}</div>}

        <div className="dungeon-route-preview relative mx-auto mt-2 max-w-3xl">
          <ol className="relative grid gap-1.5">
            <li className="flex gap-3"><span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[#8965ad] bg-[#241b2c] text-[#d8b4fe]"><DoorOpen size={16} /></span><div><span className="ui-text-small font-black uppercase tracking-widest text-[#8e729f]">Room 1</span><strong className="block ui-text-medium text-[#eee3d2]">Guards</strong><p className="ui-text-small leading-4 text-[#978d9b]">Three-lane formation</p></div></li>
            <li className="flex gap-3"><span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[#8965ad] bg-[#241b2c] text-[#d8b4fe]"><Sparkles size={16} /></span><div><span className="ui-text-small font-black uppercase tracking-widest text-[#8e729f]">Room 2</span><strong className="block ui-text-medium text-[#eee3d2]">Elite</strong><p className="ui-text-small leading-4 text-[#978d9b]">One cursed modifier</p></div></li>
            <li className="dungeon-fork flex gap-3"><span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[#8965ad] bg-[#241b2c] text-[#d8b4fe]"><Gem size={16} /></span><div className="min-w-0 flex-1"><span className="ui-text-small font-black uppercase tracking-[.16em] text-[#d5b8ec]">Room 3 · Choose your path</span><div className="mt-1 grid grid-cols-2 gap-2"><div className="dungeon-fork-door is-recovery"><strong className="flex items-center gap-1.5 ui-text-small text-emerald-300"><HeartPulse size={13} /> Recovery Shrine</strong><p className="ui-text-small leading-3 text-[#b9c7ba]">Survivors restore 25% HP</p></div><div className="dungeon-fork-door is-treasure"><strong className="flex items-center gap-1.5 ui-text-small text-amber-300"><Gem size={13} /> Treasure Vault</strong><p className="ui-text-small leading-3 text-[#c9b89d]">Harder fight, extra reward</p></div></div></div></li>
            <li className="flex gap-3"><span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[#ad8250] bg-[#2b2118] text-[#efbd79]"><Skull size={17} /></span><div><span className="ui-text-small font-black uppercase tracking-widest text-[#9f815d]">Room 4 · Final</span><strong className="block ui-text-medium text-[#f1dfc5]">Retinue → Boss</strong><p className="ui-text-small leading-4 text-[#a4998b]">Boss waits behind</p></div></li>
          </ol>
        </div>

        <div className="mt-2 border-t border-[#4d3c57]/70 pt-2 ui-text-small leading-4 text-[#a89eaa]"><p><b className="text-rose-300">Rules:</b> Level 30+ · all Depths open · persistent HP/deaths · formation locked · potions disabled · first 3 weekly entries can earn 2 final-Boss Scrolls; other Dungeon rewards are preview-only.</p><span className="sr-only">All four rooms, Retinue and shared Boss combat are server-authoritative. Only eligible final Boss claims mint two Summon Scrolls; other Dungeon rewards remain previews.</span>{error && <p role="alert" className="mt-1 font-bold text-rose-300">{error.split('_').join(' ')}</p>}</div>

        <footer className="dungeon-gate-actions mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" onClick={onGuidesClick} className="game-control flex min-h-9 items-center justify-center gap-2 px-3 py-1.5 ui-text-small font-black"><BookOpen size={14} /> Dungeon guide</button>
          <div className="grid gap-2">
            {active?.room === 3 && !active.room_state && <div className="grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => runAction('dungeon_room_choose', { encounter_id: active.encounter_id, expected_revision: active.revision, choice: 'recovery' })} className="game-control min-h-11 px-2 py-2 ui-text-small font-black text-emerald-300"><HeartPulse size={14} className="mx-auto mb-1" />Recovery · +25% HP</button><button type="button" disabled={busy} onClick={() => runAction('dungeon_room_choose', { encounter_id: active.encounter_id, expected_revision: active.revision, choice: 'treasure' })} className="game-control min-h-11 px-2 py-2 ui-text-small font-black text-amber-300"><Gem size={14} className="mx-auto mb-1" />Treasure · no healing</button></div>}
            <button type="button" disabled={primary.disabled || busy} onClick={primary.action} className="game-control game-primary flex min-h-11 items-center justify-center gap-2 px-5 py-2 ui-text-medium font-black"><DoorOpen size={16} /> {busy ? 'Server confirming…' : primary.label}</button>
            {active && <button type="button" disabled={busy} onClick={() => runAction('dungeon_abandon', { encounter_id: active.encounter_id, expected_revision: active.revision })} className="game-control flex min-h-9 items-center justify-center px-3 py-1 ui-text-small font-bold text-rose-300">Abandon run · no Attempt refund</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}

function TestControls({ game }: { game: GameApi }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [creditingGold, setCreditingGold] = useState(false);
  const [creditingAccountXp, setCreditingAccountXp] = useState(false);
  const [creditingFormationXp, setCreditingFormationXp] = useState(false);
  const [creditError, setCreditError] = useState('');
  const [done, setDone] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const armed = confirm.toUpperCase() === 'DELETE';
  const reportCreditError = (message: string) => setCreditError(message === 'rate_limited'
    ? 'Tester limit reached. Try again in up to 60 seconds.'
    : `Tester credit failed: ${message}`);

  const creditTokens = async () => {
    if (crediting) return;
    setCreditError('');
    setCrediting(true);
    const result = await playerSync<{ claimed: number; token_balance: number }>('tester_credit_tokens', {}, reportCreditError);
    if (result) game.applyServerTokenClaim(result.claimed, result.token_balance);
    else setCreditError((message) => message || 'Tester credit failed. Try again.');
    setCrediting(false);
  };

  const creditGold = async () => {
    if (creditingGold) return;
    setCreditError('');
    setCreditingGold(true);
    if (!await game.creditTestGold(reportCreditError)) setCreditError((message) => message || 'Tester credit failed. Try again.');
    setCreditingGold(false);
  };

  const creditAccountXp = async () => {
    if (creditingAccountXp) return;
    setCreditError('');
    setCreditingAccountXp(true);
    if (!await game.creditTestAccountXp(reportCreditError)) setCreditError((message) => message || 'Tester credit failed. Try again.');
    setCreditingAccountXp(false);
  };

  const creditFormationXp = async () => {
    if (creditingFormationXp) return;
    setCreditError('');
    setCreditingFormationXp(true);
    if (!await game.creditTestFormationXp(reportCreditError)) setCreditError((message) => message || 'Tester credit failed. Try again.');
    setCreditingFormationXp(false);
  };

  const wipe = async () => {
    if (!armed || busy) return;
    setBusy(true);
    setDeleteError('');
    let reason = '';
    const deleted = await playerSync<{ deleted: boolean }>('account_delete', {}, (message) => { reason = message; });
    if (!deleted?.deleted) {
      const detail = reason ? ` Server said: ${reason}.` : ' Sign in again and retry.';
      setDeleteError(`Account was not deleted. Nothing was removed locally; retry in a moment.${detail}`);
      setBusy(false);
      return;
    }
    try { await authClient.auth.signOut(); } catch { /* ignore */ }
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    setDone(true);
    window.setTimeout(() => { window.location.href = '/'; }, 1300);
  };

  return (
    <>
      <div className="absolute right-3 top-14 z-40 flex flex-col items-stretch gap-1">
        <span className="test-marker">TESTER</span>
        <button type="button" className="test-btn test-btn-gold" disabled={creditingGold} onClick={() => void creditGold()}>{creditingGold ? 'Crediting…' : '+50k Gold'}</button>
        <button type="button" className="test-btn test-btn-gold" disabled={creditingAccountXp} onClick={() => void creditAccountXp()}>{creditingAccountXp ? 'Crediting…' : '+40k Account XP'}</button>
        <button type="button" className="test-btn test-btn-gold" disabled={creditingFormationXp} onClick={() => void creditFormationXp()}>{creditingFormationXp ? 'Crediting…' : '+40k Formation XP'}</button>
        {!isolatedHackathon && <button type="button" className="test-btn test-btn-green" disabled={crediting} onClick={() => void creditTokens()}>{crediting ? 'Crediting…' : '+50k $HERO'}</button>}
        {creditError && <div role="alert" className="max-w-40 rounded border border-red-500/45 bg-red-950/80 px-2 py-1 ui-text-medium text-red-200">{creditError}</div>}
        <button type="button" className="test-btn test-btn-reset" onClick={() => setOpen(true)}>Delete account</button>
      </div>

      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[5px] anim-fade" style={{ pointerEvents: 'auto' }} onClick={() => !busy && setOpen(false)}>
          <div className="material-panel relative flex max-h-[78vh] w-full max-w-md flex-col overflow-hidden rounded-xl p-5" onClick={(e) => e.stopPropagation()}>
            {done ? (
              <>
                <h2 className="font-pixel ui-text-large text-[#e85a57]">ACCOUNT DELETED</h2>
                <p className="mt-3 ui-text-medium leading-6 text-px-dim">Everything was wiped from the database. Restarting to a clean slate…</p>
              </>
            ) : (
              <>
                <h2 className="font-pixel ui-text-large text-[#e85a57]">DELETE ACCOUNT &amp; START OVER?</h2>
                <p className="mt-2 ui-text-medium leading-6 text-px-dim">
                  This <b className="text-[#e85a57]">permanently erases your account from the database</b> — heroes, gold,
                  chests, equipment, <b className="text-gold-glow">$HERO</b>, leaderboard placement and all progress.
                  This cannot be undone. Your browser will be signed out so you can register and play the tutorials again.
                </p>
                <label className="mt-4 block ui-text-small font-bold uppercase tracking-widest text-px-dim">
                  Type <b className="text-[#e85a57]">DELETE</b> to confirm
                </label>
                <input
                  autoFocus
                  value={confirm}
                  disabled={busy}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void wipe(); }}
                  className="mt-2 w-full rounded-md border border-[#6b3c3a] bg-black/40 px-3 py-2 font-vt ui-text-large text-white outline-none transition focus:border-[#a95650]"
                />
                {deleteError && <div role="alert" className="mt-3 rounded border border-red-500/45 bg-red-950/45 px-3 py-2 ui-text-medium text-red-200">{deleteError}</div>}
                <div className="mt-5 flex justify-between gap-2">
                  <button type="button" className="game-control px-4 py-2" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
                  <button type="button" className="game-control game-danger px-4 py-2 font-bold" disabled={!armed || busy} onClick={() => void wipe()}>
                    {busy ? 'DELETING…' : 'DELETE FOREVER'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TokenEarningsPanel({ status, stale, today }: { status: TokenomicsStatus | null; stale: boolean; today: number }) {
  const [open, setOpen] = useState(false);
  const incomeButton = useRef<HTMLButtonElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ left: 8, bottom: 0, maxHeight: 200 });
  useEffect(() => {
    if (!isolatedHackathon || !open) return;
    const place = () => {
      const rect = incomeButton.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 224)),
        bottom: window.innerHeight - rect.top + 6,
        maxHeight: Math.max(60, Math.min(220, rect.top - 72)),
      });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.battle-income-wrap, .battle-income-popover')) setOpen(false);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  useEffect(() => {
    if (!isolatedHackathon || !open) return;
    const observer = new MutationObserver(() => {
      if (document.documentElement.dataset.hlSection !== 'battle') setOpen(false);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-hl-section'] });
    return () => observer.disconnect();
  }, [open]);
  // SKR rewards are disabled until funded activation. Keep the server score share
  // independent of the zero SKR budget; never display legacy HERO payouts as SKR.
  const TOKEN_PRICE_USD = 0.001;
  const DAILY_POOL = 20_000;
  const sample = isolatedHackathon ? SEEKER_SAMPLE_INCOME : null;
  const daily = sample ? sample.daily : isolatedHackathon ? 0 : status?.my_daily_share ?? 0;
  const rate = sample ? sample.daily / 24 : isolatedHackathon ? 0 : status?.my_hourly_share ?? 0;
  const pool = sample ? sample.pool : isolatedHackathon ? 0 : status?.pool_amount ?? DAILY_POOL;
  const poolSharePct = sample ? sample.daily / sample.pool * 100 : status?.pool_share_percent ?? 0;
  const sampleToday = sample ? daily * ((Date.now() % 86_400_000) / 86_400_000) : 0;
  const fmt = (value: number) => value === 0 ? '0' : value < 1 ? value.toFixed(3) : formatNum(value);
  const usd = (tokens: number) => {
    const v = tokens * TOKEN_PRICE_USD;
    return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
  };
  const Row = ({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) => (
    <>
      <span className="ui-text-small font-bold uppercase tracking-[.08em] text-[#a79a82]">{label}</span>
      <span className={`ui-text-small font-black tabular-nums ${valueClass ?? 'text-[#e8dfc8]'}`}>{value}</span>
    </>
  );
  const incomeDetails = (
      <div id="battle-income-details" hidden={isolatedHackathon && !open} className={`${isolatedHackathon ? 'hl-portal ' : ''}hl-battle-income battle-income flex w-max flex-col items-stretch gap-2 font-vt ${isolatedHackathon ? 'battle-income-popover fixed overflow-y-auto' : ''}`} style={isolatedHackathon ? popoverPosition : undefined}>
      <div className={`${isolatedHackathon ? 'hl-skr-income' : 'hl-hero-only'} token-earnings-panel flex w-full flex-col gap-2 rounded-2xl border-2 border-[#b98a3c] bg-[#0d100d]/[.98] px-4 py-3 shadow-[0_0_34px_rgba(229,177,70,.4)]`}>
      <div className="flex items-center gap-2">
        <HeroTokenIcon size={22} />
        <span className="ui-text-small font-black uppercase tracking-[.14em] text-[#ffd36e]">$HERO Income</span>
        {stale && <span className="ml-auto ui-text-small font-bold uppercase tracking-wide text-amber-300" title="Keeping the last confirmed server values while income refresh retries">Updating…</span>}
      </div>
      {status || sample ? (<>
        <div className="grid grid-cols-[max-content_max-content] items-baseline gap-x-2 gap-y-2 whitespace-nowrap">
          <Row label="Per hour" value={isolatedHackathon ? `${fmt(rate)} $SKR` : `${fmt(rate)} (${usd(rate)})`} valueClass="text-[#7ee787]" />
          <Row label="Per day" value={isolatedHackathon ? `${fmt(daily)} $SKR` : `${fmt(daily)} (${usd(daily)})`} valueClass="text-[#e5bd68]" />
          <Row label="Pool share" value={`${poolSharePct.toFixed(poolSharePct < 0.01 ? 4 : 2)}%`} valueClass="text-[#9ed7ff]" />
          <Row label="Today" value={isolatedHackathon ? `${fmt(sampleToday)} $SKR` : `${formatNum(today)} (${usd(today)})`} valueClass="text-[#ffd36e]" />
          <Row label="Daily pool" value={isolatedHackathon ? `${formatNum(pool)} $SKR` : `${formatNum(pool)} $HERO`} valueClass="text-[#c8b3f0]" />
        </div>
        {isolatedHackathon && isAndroidLayout && <button type="button" onClick={() => { setOpen(false); window.dispatchEvent(new Event(MINE_OPEN_EVENT)); }} className="game-control game-primary mt-1 flex min-h-11 w-full items-center justify-center gap-1.5 px-3 ui-text-small font-black uppercase">Open ORE Mine<ArrowRight size={15} aria-hidden="true" /></button>}
      </>) : (
        <span className="ui-text-small font-semibold text-[#9a937f]">Syncing token pool…</span>
      )}
      </div>
      </div>
  );
  return (
    <div className="battle-income-wrap relative min-w-0" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
      {isolatedHackathon && <button ref={incomeButton} type="button" className="battle-income-chip game-control flex items-center justify-between gap-2 px-2 font-vt font-black tabular-nums" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="battle-income-details" aria-label="$SKR income details">
        <HeroTokenIcon size={18} /><span>{fmt(daily)} $SKR / day</span><ChevronDown size={15} aria-hidden="true" className={open ? '' : 'rotate-180'} />
      </button>}
      {isolatedHackathon && open ? createPortal(incomeDetails, document.body) : incomeDetails}
    </div>
  );
}

// One plain-language prompt over the battle so a new player always knows what to do next.
// Presentation only: claiming still happens in the quest list, which the server validates.
function NextStepCard({ game, nextLocation, onQuestsClick, onStoreClick }: { game: GameApi; nextLocation: number | null; onQuestsClick?: () => void; onStoreClick: () => void }) {
  const { state } = game;
  const [, setTourVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setTourVersion(version => version + 1);
    window.addEventListener(SEEKER_TOUR_EVENT, refresh);
    return () => window.removeEventListener(SEEKER_TOUR_EVENT, refresh);
  }, []);
  const objective = currentTutorialObjective(state);
  const ready = readyQuestCount(state);
  const step = objective
    ? { kicker: `Next step · ${Math.max(1, Math.min(10, state.tutorial.questOrdinal))}/10`, label: objective.ready ? 'Done! Claim your reward' : objective.label, progress: objective.ready ? null : objective, cta: objective.ready ? 'Claim' : null, onClick: () => { const guide = tutorialGuide(state); if (!guide || guide === 'claim' || !isAndroidLayout) onQuestsClick?.(); else window.dispatchEvent(new CustomEvent(TUTORIAL_GO_EVENT, { detail: tutorialDestination(guide) })); } }
    : ready > 0
      ? { kicker: 'Next step', label: `${ready} reward${ready === 1 ? '' : 's'} ready`, progress: null, cta: 'Claim', onClick: onQuestsClick }
      : nextLocation
        ? { kicker: 'Next step', label: `New location open: ${buildLocation(nextLocation, state.team.length).name}`, progress: null, cta: 'Go', onClick: () => game.setLocation(nextLocation) }
        : isAndroidLayout && !seekerTourSeen('mine')
          ? { kicker: 'Next step', label: 'Try the ORE Mine', progress: null, cta: 'Open', onClick: () => window.dispatchEvent(new Event(MINE_OPEN_EVENT)) }
          : !seekerTourSeen('store')
            ? { kicker: 'Next step', label: 'Spend $SKR in the Store', progress: null, cta: 'Open', onClick: onStoreClick }
            : null;
  if (!step) return null;
  return <button type="button" onClick={step.onClick} className={`hl-next-step game-control absolute top-2 z-30 flex min-h-11 items-center gap-2 px-2.5 py-1.5 text-left ${step.cta ? 'is-ready' : ''}`} aria-label={`${step.kicker}: ${step.label}`}>
    <span className="min-w-0 flex-1">
      <span className="block ui-text-small font-black uppercase tracking-[.12em] text-[#c9a463]">{step.kicker}</span>
      <span className="block whitespace-normal break-words ui-text-medium font-bold leading-tight text-[#efe4cf]">{step.label}</span>
      {step.progress && <span className="mt-1 flex items-center gap-1.5"><span className="health-track h-1 flex-1 overflow-hidden"><span className="block h-full bg-[linear-gradient(90deg,#765022,#d4a449)]" style={{ width: `${Math.min(100, step.progress.progress / step.progress.target * 100)}%` }} /></span><span className="ui-text-small tabular-nums text-px-dim">{step.progress.progress}/{step.progress.target}</span></span>}
    </span>
    {step.cta ? <span className="hl-next-step-cta flex shrink-0 items-center gap-1 ui-text-small font-black uppercase">{step.cta}<ArrowRight size={14} aria-hidden="true" /></span> : <ChevronRight size={16} className="shrink-0 text-[#9b8c70]" aria-hidden="true" />}
  </button>;
}

function AvatarPicker({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const uniqueHeroIds = [...new Set(game.state.ownedHeroes.map((hero) => hero.heroId))];
  return <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[3px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="px-panel-raised game-scrollbar max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl p-4"><div className="flex items-center justify-between"><div><div className="section-kicker">Account identity</div><h3 className="mt-1 ui-text-large font-black text-[#eee2cb]">Choose Avatar</h3></div><button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center"><X size={15} /></button></div><section className="mt-3"><div className="mb-2 ui-text-small font-bold uppercase tracking-wider text-[#9b907c]">Owned heroes · one of each type</div><div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{uniqueHeroIds.map((heroId) => { const base = HERO_MAP[heroId]; if (!base) return null; const active = heroId === game.state.avatarHeroId; return <button type="button" key={heroId} onClick={() => game.setAvatarHero(heroId)} className={`rounded-lg border p-1 transition ${active ? 'border-[#efc660] bg-[#6a481b]/35 shadow-[0_0_14px_rgba(226,183,84,.35)]' : 'border-[#544630] bg-black/20'}`} title={base.name}><HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={62} active={active} /><span className="mt-1 block truncate ui-text-small font-bold" style={{ color: RARITY_COLORS[base.rarity] }}>{base.name}</span></button>; })}</div></section><div className="mt-4 grid grid-cols-2 gap-2"><section className="stat-tile cursor-not-allowed p-3 opacity-45"><LockIcon size={16} className="text-[#9a8b72]" /><b className="mt-2 block ui-text-medium text-[#cfc4b1]">Avatar Frames</b><span className="ui-text-small text-[#81796c]">Coming later</span></section><section className="stat-tile cursor-not-allowed p-3 opacity-45"><Sparkles size={16} className="text-[#9a8b72]" /><b className="mt-2 block ui-text-medium text-[#cfc4b1]">Glow & Effects</b><span className="ui-text-small text-[#81796c]">Coming later</span></section></div><p className="mt-3 ui-text-small leading-relaxed text-[#837a6d]">The final owned copy of the selected avatar cannot be sold. Choose another avatar first.</p></div></div>;
}

function AutomaticHealingStatus({ game }: { game: GameApi }) {
  const stock = Object.values(game.state.potions).some(count => count > 0);
  const label = !game.state.autoPot.healingInfoSeen || !goldHealingEnabled(game.state.autoPot)
    ? 'Healing · stored potions only'
    : stock ? 'Healing · stock first' : game.state.gold < 3
      ? 'Healing · not enough Gold (needs 3)' : 'Healing · automatic Gold';
  return <div role="status" className="hl-healing-status pointer-events-none absolute right-3 top-3 z-30 max-w-[65%] rounded-md border border-emerald-500/30 bg-[#11130f]/90 px-2 py-1 ui-text-small text-emerald-200">{label}</div>;
}

function HealingIntroduction({ game }: { game: GameApi }) {
  const firstButton = useRef<HTMLButtonElement>(null);
  const stockOnly = () => game.setAutoPot({ enabled: true, healingInfoSeen: true, goldHealingOptOut: true });
  useEffect(() => {
    const previous = document.activeElement;
    firstButton.current?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return createPortal(<div className="hl-portal fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="healing-intro-title" className="w-full max-w-md max-h-[88dvh] overflow-y-auto rounded-xl border border-[#80683f] bg-[#11130f] p-5 shadow-2xl" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); stockOnly(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
      <h2 id="healing-intro-title" className="font-vt text-2xl font-bold text-emerald-300">Your heroes heal automatically</h2>
      <p className="mt-3 ui-text-medium leading-relaxed text-[#e8decd]">At 50% HP or below, a living hero uses one Ordinary Potion. It restores 100% maximum HP in four ticks over 20 seconds. The first tick arrives after 5 seconds. Each hero has a 30-second cooldown from drinking.</p>
      <p className="my-4 ui-text-medium text-[#efd18a]">Stock is used first. When empty, one bottle costs 3 Gold if Gold healing is enabled.</p>
      <p className="ui-text-medium leading-relaxed text-[#c4bba7]">Not enough Gold? No purchase is made. Damage continues during healing. Remaining healing, cooldowns and HP carry between waves. Death cancels remaining healing. Potions do not revive heroes and are unavailable in Dungeons and Boss Hunts.</p>
      <p className="mt-3 ui-text-small leading-relaxed text-[#9e9687]">You can turn Gold spending off in Battle settings. Changes apply from the next wave.</p>
      <button ref={firstButton} type="button" style={{ minHeight: 44 }} className="game-control mt-4 min-h-11 w-full border-emerald-500/60 text-emerald-200" onClick={() => game.setAutoPot({ enabled: true, goldHealingOptOut: !goldHealingEnabled(game.state.autoPot), healingInfoSeen: true })}>Got it</button>
      <button type="button" style={{ minHeight: 44 }} className="game-control mt-2 min-h-11 w-full text-[#c4bba7]" onClick={stockOnly}>Use stored potions only</button>
    </section>
  </div>, document.body);
}

function PotionSettings({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const { state } = game;
  return (
    <div className="auto-pot-settings anim-slide-up">
      <div className="mb-1.5 flex items-center justify-between"><span className="flex items-center gap-1.5 ui-text-medium font-bold text-px-text"><FlaskConical size={14} className="text-emerald-400" /> Auto-potion</span><button onClick={onClose} className="grid h-7 w-7 place-items-center text-px-dim"><X size={14} /></button></div>
      <label className="flex items-center justify-between py-1 ui-text-medium"><span className="text-px-text">Auto-use</span><Toggle on={state.autoPot.enabled} onClick={() => game.setAutoPot({ enabled: !state.autoPot.enabled })} /></label>
      <div className="py-1"><div className="mb-0.5 flex items-center justify-between ui-text-medium"><span className="text-px-text">Use below HP</span><span className="font-bold text-emerald-300">{Math.round(state.autoPot.threshold * 100)}%</span></div><input type="range" min={10} max={90} step={5} value={Math.round(state.autoPot.threshold * 100)} onChange={(e) => game.setAutoPot({ threshold: Number(e.target.value) / 100 })} className="h-4 w-full accent-emerald-400" /></div>
      <label className="flex items-center justify-between rounded-md px-1 py-1 ui-text-medium"><span className="text-px-text">Buy when empty</span><Toggle on={state.autoPot.autoBuy} onClick={() => game.setAutoPot({ autoBuy: !state.autoPot.autoBuy })} /></label>
      {state.autoPot.autoBuy && (
        <>
          <button onClick={() => game.setAutoPot({ autoSelectTier: !state.autoPot.autoSelectTier })} className={`my-1 w-full rounded-md border px-2 py-1.5 text-left ui-text-small font-semibold ${state.autoPot.autoSelectTier ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200' : 'border-white/10 text-slate-400'}`}>
            Smart tier ≥50% HP · {state.autoPot.autoSelectTier ? 'ON' : 'OFF'}
          </button>
          {!state.autoPot.autoSelectTier && <div className="py-1"><div className="ui-text-medium font-vt text-px-text mb-1">Fixed buy tier</div><div className="grid grid-cols-3 gap-1">{POTIONS.map(p => <button key={p.tier} onClick={() => game.setAutoPot({ autoBuyTier: p.tier as PotionTier })} className={`px-1 py-1 ui-text-medium font-vt font-bold border transition-none ${state.autoPot.autoBuyTier === p.tier ? 'border-px-green text-px-green bg-px-green/10' : 'border-px-border text-px-dim'}`}>{p.name.split(' ')[0]}</button>)}</div></div>}
        </>
      )}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`w-9 h-5 border-2 transition relative ${on ? 'border-px-green bg-px-green/40' : 'border-px-border bg-px-bg'}`}><div className={`absolute top-0.5 w-3 h-3 transition-all ${on ? 'left-4 bg-px-green' : 'left-0.5 bg-px-dim'}`} /></button>;
}
