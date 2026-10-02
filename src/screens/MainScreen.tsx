import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { editionStorageKey, isolatedHackathon } from '../game/editionStorage';
import { goldHealingEnabled } from '../../managed/functions/player-sync/automatic-healing.mjs';
import { tutorialProgress } from '@/game/tutorialProgress';
import { Fragment, useCallback, useEffect, useState, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { isAndroidLayout } from '@/platform/platform';
import { COMMANDER_OPEN_EVENT, BATTLE_ACTIONS_SLOT } from '@/components/GameProgressBar';
import { Package, PackageMinus, FlaskConical, Lock as LockIcon, Star, X, Coins, CheckCircle2, Circle, ArrowUpDown, Wand2, ChevronDown, ChevronLeft, ChevronRight, Sparkles, Info, Settings2, Rocket, DoorOpen, HeartPulse, Gem, Skull, BookOpen } from 'lucide-react';
import { Arena, locationArtStyle } from '@/components/Arena';
import { CombatErrorBoundary } from '@/components/CombatErrorBoundary';
import { HeroPortrait } from '@/components/HeroPortrait';
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
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { PartnerQuests } from '@/components/PartnerQuests';
import { FantasyBagIcon } from '@/components/FantasyBagIcon';
import { recommendedTeamPower } from '@/game/balance';
import { playerSync, authClient } from '@/game/backend';

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
  ['defeat-50-enemies', 'Defeat 50 enemies', 50, '1,000 Gold'],
  ['defeat-tutorial-boss', 'Use the granted key and defeat one summoned Boss', 1, '1 Summon Scroll'],
] as const;
const DUNGEON_BOSS_ART: Record<string, string> = { 'iron-warden': 'boss-titan', 'ash-warlock': 'boss-lich', 'thorn-shaman': 'boss-ogre', 'rift-behemoth': 'boss-dragon', 'grave-necromancer': 'boss-lich' };

type DungeonCheckpoint = {
  type: 'dungeon' | 'boss_hunt'; encounter_id: string; boss_encounter_id?: string; depth: number; room: number; revision: number;
  roster_snapshot?: Array<{ uid: string; hero_id: string; stats?: Record<string, number> }>;
  run_state?: { heroes?: DungeonUnitState[]; rooms_cleared?: number; tutorial_boss?: boolean };
  room_state: null | { status: string; kind?: string; choice?: string; modifier?: string; heroes?: DungeonUnitState[]; enemies?: DungeonUnitState[]; boss?: { boss_id: string; name: string; status: string; current_hp?: number; max_hp?: number }; reward_preview?: { summon_scrolls?: number; dungeon_chests?: number; settled?: boolean; reward_table_version?: string }; playback_tick?: number; elapsed_ms?: number; heavy_target_uid?: string; heavy_casts?: number; identity_ability?: string; identity_casts?: number };
};
type DungeonUnitState = {
  uid?: string; unit_id?: string; position?: number; lane?: number; current_hp: number; max_hp: number; alive: boolean;
  atk?: number; def?: number; speed?: number; attack_speed_bonus?: number;
};
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
const CLASS_SHORT_LABEL: Record<HeroClass, string> = {
  shepherd: 'MAGE', assassin: 'ASN', knight: 'WAR', druid: 'DRU', archer: 'XBOW',
};

function emptySlotArtworkId(slot: ItemSlot, heroClass: HeroClass): string {
  const classKey = PRODUCT_CLASS_KEY[heroClass];
  if (slot === 'class_weapon') return `weapon-${classKey}-common`;
  if (slot === 'offhand') return `offhand-${classKey}-common`;
  if (slot === 'chest') return 'armor-common';
  return `${slot}-common`;
}

export function MainScreen({ game, tokenomics, onBoostClick, onGuidesClick, onRewardBoostClick }: { game: GameApi; tokenomics: TokenomicsApi; onBoostClick: () => void; onGuidesClick: () => void; onRewardBoostClick: () => void; onQuestsClick?: () => void }) {
  const { state, battleResult, respawnCountdowns, paused, setPaused } = game;
  const tok = tokenomics;
  const accountXpCurrent = accountXpProgress(state.accountXp, state.accountLevel);
  const battleAnimationLabel = state.battleAnimationMode === 'spectacular' ? 'Maximum' : state.battleAnimationMode === 'light' ? 'Medium' : 'Minimum';
  const [banner, setBanner] = useState<typeof battleResult>(null);
  const [showPotSettings, setShowPotSettings] = useState(false);
  const [showBattleSettings, setShowBattleSettings] = useState(false);
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
  const [bagPurchaseConfirm, setBagPurchaseConfirm] = useState(false);
  const [bagPurchaseBusy, setBagPurchaseBusy] = useState(false);
  const bagSlotsKey = state.bagSlots.join(',');
  const bagQuoteReady = Number.isSafeInteger(game.serverRevisionHint);
  const [selectedResource, setSelectedResource] = useState<'summon-scroll' | 'boss-key' | null>(null);
  const [showDropRates, setShowDropRates] = useState(false);
  const dropRatesButtonRef = useRef<HTMLButtonElement>(null);
  const [dropRatesPos, setDropRatesPos] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);
  const [showZoomTip, setShowZoomTip] = useState(true);
  const [showHeroDetails, setShowHeroDetails] = useState(false);
  const [showDungeonInfo, setShowDungeonInfo] = useState(false);
  const [activeDungeon, setActiveDungeon] = useState<DungeonCheckpoint | null>(null);
  const [dungeonFloaters, setDungeonFloaters] = useState<FloatingNumber[]>([]);
  const [dungeonCompletion, setDungeonCompletion] = useState<{ won: boolean; depth: number; kind: 'dungeon' | 'boss_hunt'; gold: number; scrolls: number } | null>(null);
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
    setActiveDungeon(encounter);
    if (encounter) setShowDungeonInfo(false);
  };

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };
  // A Boss Hunt that ends changes Boss Keys on the server (a win spends the key for good;
  // a loss during the Tutorial returns it), so re-read the save instead of guessing.
  const handleDungeonChange = async (next: DungeonCheckpoint | null) => {
    const endedBossHunt = next === null && activeDungeon?.type === 'boss_hunt';
    const keysBefore = state.bossKeys;
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
  const visiblePotions = POTIONS.filter((p) => state.potions[p.tier] > 0);
  const resourceSlotCount = 2 + visiblePotions.length;
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

  const handleSummonBoss = async () => {
    const result = await tok.summonBoss(state.currentLocation);
    if (!result) { showToast('A Boss Key is required'); return; }
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
      uid: isSharedBoss
        ? `${DUNGEON_BOSS_ART[activeDungeon.room_state?.boss?.boss_id ?? ''] ?? 'boss-lich'}-dungeon-shared`
        : isSummon ? `e${position}-skeleton` : `e${position}-${activeDungeon.room === 2 ? 'boss-ogre' : activeDungeon.room === 3 ? 'skeleton' : activeDungeon.room === 4 ? 'goblin' : 'orc'}`,
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

  const [battleActionsHost, setBattleActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (isolatedHackathon) setBattleActionsHost(document.getElementById(BATTLE_ACTIONS_SLOT));
  }, []);
  const [commanderOpen, setCommanderOpen] = useState(false);
  useEffect(() => {
    const open = () => setCommanderOpen(true);
    window.addEventListener(COMMANDER_OPEN_EVENT, open);
    return () => window.removeEventListener(COMMANDER_OPEN_EVENT, open);
  }, []);

  // Commander panel: in the Quests column on desktop; on a phone it opens from the avatar in the
  // top bar (Founder 2026-10-02).
  const encounterActions = (
    !activeDungeon && <div className="battle-entry-actions flex shrink-0 items-center justify-center gap-2 px-2 py-1.5">
            <button type="button" onClick={() => setShowDungeonInfo(true)} className="pm-socket game-control flex min-h-11 items-center gap-1 px-2 py-0.5 ui-text-small font-bold text-[#d7c6ea]" aria-label="Open Dungeons information">
              <DoorOpen size={14} aria-hidden="true" /> DUNGEONS <Info size={11} aria-hidden="true" />
            </button>
            <button
              onClick={handleSummonBoss}
              disabled={state.bossKeys < 1 || state.bossBattleActive}
              className="pm-socket game-control flex min-h-11 items-center gap-1 px-2 py-0.5 ui-text-small font-bold"
            >
              <BossKeyIcon size={22} /> {state.bossBattleActive ? 'BOSS ACTIVE' : `BOSS · ${state.bossKeys}`}
            </button>
          </div>
  );

  const commanderPanel = (
  <div className="hl-commander border-b border-[#4f412e] p-3">
    <div className="section-kicker mb-2">Commander</div>
    <div className="mb-2 flex items-center gap-2.5">
      <button type="button" onClick={() => setShowAvatarPicker(true)} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-[#e0b45f] bg-black/30 shadow-[inset_0_1px_rgba(255,249,214,.28),0_0_14px_rgba(208,163,74,.24)]" title="Change account avatar">
        {avatarBase && <HeroPortrait heroId={avatarBase.id} heroClass={avatarBase.heroClass} rarity={avatarBase.rarity} color={avatarBase.color} size={46} />}
        <span className="absolute bottom-0 right-0 rounded-tl bg-black/80 px-1 ui-text-small font-black text-[#ffe6a2]">{state.accountLevel}</span>
      </button>
      <div className="flex-1">
        <div className="ui-text-large font-extrabold text-[#f0dfba]">Level {state.accountLevel}</div>
        <div className="health-track mt-1 h-2.5 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#9b6824,#efc760)] shadow-[0_0_8px_rgba(225,177,77,.35)]" style={{ width: `${Math.min(100, (accountXpCurrent / accountXpForLevel(state.accountLevel)) * 100)}%` }} /></div>
        <div className="mt-1 ui-text-small font-semibold tabular-nums text-[#928b7d]">{formatNum(accountXpCurrent)} / {formatNum(accountXpForLevel(state.accountLevel))} XP</div>
      </div>
    </div>
    <div className="mb-2 grid grid-cols-2 gap-1.5">
      <div className="stat-tile px-2 py-1.5">
        <div className="ui-text-small font-bold uppercase tracking-[.1em] text-[#8e887b]">Team Power</div>
        <div className="mt-0.5 ui-text-medium font-black tabular-nums text-[#f0c563]">⚡ {formatNum(power)}</div>
      </div>
      <div className="stat-tile px-2 py-1.5">
        <div className="ui-text-small font-bold uppercase tracking-[.1em] text-[#8e887b]">Hero Power</div>
        <div className="mt-0.5 ui-text-medium font-black tabular-nums text-[#f0c563]">⚡ {formatNum(selectedHeroPower)}</div>
      </div>
    </div>
    <RewardBoostTile bonus={game.accountBonus} onOpenShop={onRewardBoostClick} />
    {selectedHero && (
      <div className="stat-tile mb-2 px-2 py-1.5">
        <div className="flex items-center justify-between ui-text-small font-bold uppercase tracking-[.1em] text-[#8e887b]"><span>Hero XP</span><span>Level {selectedHero.level}</span></div>
        <div className="health-track mt-1 h-2.5 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#705028,#ddb557)]" style={{ width: `${Math.min(100, (selectedHero.xp / heroXpForLevel(selectedHero.level)) * 100)}%` }} /></div>
        <div className="mt-1 ui-text-small font-semibold tabular-nums text-[#928b7d]">{formatNum(selectedHero.xp)} / {formatNum(heroXpForLevel(selectedHero.level))} XP</div>
      </div>
    )}
    <div className="commander-kill-stats stat-tile mb-2 grid grid-cols-3 gap-1 px-2 py-2" aria-label="Combat totals">
      {[['Heroes', state.ownedHeroes.length], ['Defeated', state.totalKills], ['Bosses', state.totalBossKills]].map(([label, value]) => <div key={label} className="text-center"><span className="block ui-text-small font-bold uppercase tracking-wide text-[#a79a82]">{label}</span><strong className="mt-1 block ui-text-medium tabular-nums text-[#e8dfc8]">{formatNum(Number(value))}</strong></div>)}
    </div>
    {selectedHeroStats && (
      <div className="stat-tile overflow-hidden">
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-between gap-2 px-2 py-1 text-left"
          aria-expanded={showHeroDetails}
          aria-controls="commander-hero-details"
          onClick={() => setShowHeroDetails((visible) => !visible)}
        >
          <span className="ui-text-small font-bold uppercase tracking-[.1em] text-[#a59b88]">Hero characteristics</span>
          <span className="flex items-center gap-1 ui-text-small font-semibold text-[#d5bd85]">
            {showHeroDetails ? 'Hide' : 'Show'}
            <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${showHeroDetails ? 'rotate-180' : ''}`} />
          </span>
        </button>
        <div id="commander-hero-details" hidden={!showHeroDetails} className="border-t border-[#4f412e] px-1.5 py-1.5">
            <div className="grid grid-cols-2 gap-1">
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
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-1 rounded border border-[#4a4032]/70 bg-black/10 px-1.5 py-0.5">
                  <span className="truncate ui-text-small font-semibold text-[#8f897d]">{label}</span>
                  <span className="shrink-0 ui-text-medium font-bold tabular-nums text-[#e8e1d3]">{value}</span>
                </div>
              ))}
            </div>
            <div className="mt-1.5 border-t border-[#4f412e]/80 px-1 pt-1.5">
              <div className="mb-1 ui-text-small font-bold uppercase tracking-[.08em] text-[#a59b88]">Passives</div>
              <AccountBonusPassives bonus={game.accountBonus} />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-[#4f412e]/80 px-1 pt-1.5">
              <span className="ui-text-small font-bold uppercase tracking-[.08em] text-[#777269]">Skills · Auras</span>
              <span className="shrink-0 ui-text-small font-semibold text-[#9b8862]">Coming soon</span>
            </div>
        </div>
      </div>
    )}
  </div>
  );

  return (
    <div className="game-main flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* ── LEFT COLUMN ── */}
      <div className="hl-col-left material-panel game-scrollbar order-2 flex w-full shrink-0 flex-col overflow-y-auto lg:order-none lg:w-60 xl:w-64">
        {tutorialFinished && createPortal(<div className="dungeon-complete is-victory" style={{ position: 'fixed', zIndex: 9999 }} role="dialog" aria-modal="true" aria-label="Tutorial complete"><div className="dungeon-complete-crest"><Sparkles size={38} /><small>TUTORIAL · 10/10</small><strong>TUTORIAL COMPLETE</strong><p>Your team is built, geared and has beaten its first Boss.</p><div className="dungeon-reward-preview"><span><SummonScrollArtwork size={18} /> 1 SUMMON SCROLL</span><span><CheckCircle2 size={14} /> DAILY QUESTS NEXT</span><small>Final reward granted exactly once by the server</small></div><button type="button" autoFocus className="game-control game-primary" onClick={() => setTutorialFinished(false)}>CONTINUE</button></div></div>, document.body)}
        {!isAndroidLayout && commanderPanel}

        <div id="game-quest-list" className="hl-quest-list flex-1 p-2">
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
                <div className="mt-1 flex items-center gap-1.5"><div className="health-track h-1 flex-1 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#765022,#d4a449)]" style={{ width: `${Math.min(100, progress / quest[2] * 100)}%` }} /></div><span className="ui-text-small shrink-0 text-px-dim">{progress}/{quest[2]}</span><span className="ui-text-small shrink-0 text-[#e7c579]">{quest[3]}</span></div>
                {done && <button type="button" disabled={tutorialClaimBusy} aria-busy={tutorialClaimBusy} onClick={async () => {
                  setTutorialClaimBusy(true); setTutorialClaimError('');
                  try {
                    const error = await game.claimTutorialQuest(quest[0]);
                    if (error) setTutorialClaimError(error === 'state_conflict' ? 'Your game changed. Please try claiming again.' : error === 'tutorial_quest_incomplete' ? 'The server has not confirmed this task yet. Please try again.' : error === 'tutorial_quest_locked' || error === 'tutorial_completed' ? 'This tutorial step is no longer available. Reload the game.' : 'Could not claim the reward. Please try again.');
                    else if (quest[0] === 'defeat-tutorial-boss') setTutorialFinished(true);
                    else showToast('Tutorial reward claimed');
                  } finally { setTutorialClaimBusy(false); }
                }} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full px-2 py-0.5 font-bold disabled:opacity-50">{tutorialClaimBusy ? 'Claiming…' : 'Claim & unlock next'}</button>}
                {tutorialClaimError && <p role="alert" className="mt-1 ui-text-small text-red-300">{tutorialClaimError}</p>}
              </div>
              {state.tutorial.chestBalance > 0 && <div className="quest-card mt-1 px-2 py-1"><div className="ui-text-medium flex justify-between"><span>Tutorial Chests</span><b>{state.tutorial.chestBalance}</b></div><div className="mt-1 grid grid-cols-2 gap-1"><button disabled={state.tutorial.chestBalance < 1 || game.chestOpening} onClick={() => void game.openTutorialChests(1)} className="game-control min-h-7 ui-text-small font-bold">Open 1</button><button disabled={state.tutorial.chestBalance < 10 || game.chestOpening} onClick={() => void game.openTutorialChests(10)} className="game-control min-h-7 ui-text-small font-bold">Open 10</button></div></div>}
            </section>;
          })()}
          <div className="section-kicker mb-1">Daily Quests</div>
          <div className="space-y-1">
            {state.dailyQuests.map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className={`quest-card px-2 py-1 ${done && !q.claimed ? 'border-[#b48a43]' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    {q.claimed ? <CheckCircle2 size={11} className="shrink-0 text-emerald-400" /> : done ? <Circle size={11} className="shrink-0 fill-amber-400/30 text-amber-400" /> : <Circle size={11} className="shrink-0 text-slate-600" />}
                    <span className="ui-text-medium min-w-0 flex-1 truncate leading-tight text-px-text" title={q.label}>{q.label}</span>
                    <span className="ui-text-small flex shrink-0 items-center gap-1 text-px-text"><Coins size={10} />{q.reward.gold} <HeroTokenIcon size={10} />{q.reward.hero}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="health-track h-1 flex-1 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#765022,#d4a449)]" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                    <span className="ui-text-small shrink-0 text-px-dim">{q.progress}/{q.target}</span>
                  </div>
                  {done && !q.claimed && <button onClick={() => game.claimQuest(q.id)} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full px-2 py-0.5 font-bold">Claim reward</button>}
                </div>
              );
            })}
          </div>
          <div className="section-kicker mb-1 mt-2">Milestone Quests</div>
          <div className="space-y-1">
            {state.milestoneQuests.map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className={`quest-card px-2 py-1 ${done ? 'border-[#b48a43]' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    {done ? <Circle size={11} className="shrink-0 fill-amber-400/30 text-amber-400" /> : <Circle size={11} className="shrink-0 text-slate-600" />}
                    <span className="ui-text-medium min-w-0 flex-1 truncate leading-tight text-px-text" title={q.label}>{q.label}</span>
                    <span className="ui-text-small flex shrink-0 items-center gap-1 text-px-text">{q.reward.summonScrolls ? <><SummonScrollArtwork size={14} />{q.reward.summonScrolls}</> : <><Coins size={10} />{formatNum(q.reward.gold)} <HeroTokenIcon size={10} />{q.reward.hero}</>}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="health-track h-1 flex-1 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#5a3d70,#bd78d5)]" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                    <span className="ui-text-small shrink-0 text-px-dim">{formatNum(q.progress)}/{formatNum(q.target)}</span>
                    <span className="ui-text-small shrink-0 font-bold uppercase text-[#8e887b]">T{(q.tier ?? 0) + 1}</span>
                  </div>
                  {done && <button onClick={() => game.claimQuest(q.id)} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full px-2 py-0.5 font-bold">Claim & unlock next</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── CENTER COLUMN — responsive, max-width removed ── */}
      <div className="hl-col-center game-scrollbar order-1 flex min-h-[464px] w-full shrink-0 flex-col overflow-hidden lg:order-none lg:min-h-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:overflow-y-auto">
        {battleActionsHost ? createPortal(encounterActions, battleActionsHost) : encounterActions}
        {/* Arena */}
        <div className={`battle-stage ${!activeDungeon ? 'battle-stage-normal' : ''} relative min-h-[320px] flex-1 overflow-hidden bg-arena`} style={activeDungeon ? undefined : locationArtStyle(game.state.currentLocation)}>
          {!activeDungeon && showZoomTip && <div className="hl-zoom-tip absolute left-1/2 top-12 z-40 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-[#80683f] bg-[#11130f]/95 px-3 py-1.5 font-vt ui-text-small font-bold text-[#d8c9ad] shadow-xl backdrop-blur-sm"><span>Adjust browser zoom with <kbd className="text-[#ffd36e]">Ctrl +</kbd> / <kbd className="text-[#ffd36e]">Ctrl -</kbd> to fit all interface elements.</span><button type="button" onClick={() => setShowZoomTip(false)} className="text-[#8f887b] hover:text-white" aria-label="Dismiss browser zoom tip"><X size={12} /></button></div>}
          <div className={`hl-battle-hud-left absolute left-3 top-3 flex items-start gap-1.5 ${showPotSettings || showBattleSettings ? 'z-[110]' : 'z-30'}`}>
            {!activeDungeon && !isolatedHackathon ? <div className="relative">
              <button onClick={() => setShowPotSettings(s => !s)} className={`game-control relative flex h-7 items-center gap-1.5 px-2 py-0.5 ui-text-small font-bold ${state.autoPot.enabled ? 'border-emerald-500/60 bg-emerald-950/30 text-emerald-300' : ''}`}>
                <FlaskConical size={14} /> Pot-auto {state.autoPot.enabled ? 'ON' : 'OFF'}
              </button>
              {showPotSettings && <PotionSettings game={game} onClose={() => setShowPotSettings(false)} />}
            </div> : activeDungeon ? <div className="game-control flex h-9 items-center gap-2 border-violet-500/60 bg-violet-950/40 px-3 ui-text-small font-black uppercase text-violet-200"><DoorOpen size={15} /> {activeDungeon.type === 'boss_hunt' ? 'Boss Hunt' : `Depth ${activeDungeon.depth} · Room ${activeDungeon.room}/4`}</div> : null}
            <div className="relative">
              <button type="button" onClick={() => setShowBattleSettings((value) => !value)} className="game-control flex h-7 items-center gap-1.5 px-2 ui-text-small font-black uppercase" aria-label={isolatedHackathon ? 'Battle settings' : 'Battle graphics quality settings'} aria-expanded={showBattleSettings}><Settings2 size={14} /><span className="hidden sm:inline">{battleAnimationLabel}</span></button>
              {showBattleSettings && <div className="absolute left-0 top-full z-[111] mt-1 w-56 rounded-lg border border-[#80683f] bg-[#11130f]/97 p-2 shadow-2xl backdrop-blur-sm">
                {isolatedHackathon && <section className="mb-2 border-b border-[#80683f]/50 pb-2" aria-label="Healing settings">
                  <h3 className="ui-text-medium font-bold text-emerald-300">Automatic healing</h3>
                  <p className="my-1 ui-text-small leading-relaxed text-[#c4bba7]">Stored potions are used first below 35% HP. Gold buys instant healing only when stock runs out.</p>
                  <label className="flex items-center gap-2 py-1 ui-text-medium text-[#e8decd]"><input type="checkbox" checked={goldHealingEnabled(state.autoPot)} onChange={event => game.setAutoPot({ enabled: true, goldHealingOptOut: !event.target.checked, healingInfoSeen: true })} className="h-4 w-4 accent-emerald-400" /> Spend Gold on healing</label>
                  <p className="ui-text-small leading-relaxed text-[#9e9687]">XS / S / M / L / XL / XXL: 1 / 1 / 1 / 2 / 4 / 10 Gold. Not enough Gold means no purchase. Normal battles only; changes apply next wave.</p>
                </section>}
                <div className="mb-1.5 ui-text-small font-black uppercase tracking-[.14em] text-[#efd18a]">Battle graphics</div>
                {([
                  ['spectacular', 'Maximum', 'Full battle movement and effects'],
                  ['light', 'Medium', 'Standard battle movement and effects'],
                  ['off', 'Minimum', 'Static portraits; essential feedback only'],
                ] as const).map(([mode, label, description]) => <button key={mode} type="button" onClick={() => { game.setBattleAnimationMode(mode); setShowBattleSettings(false); }} className={`mt-1 w-full rounded-md border px-2 py-1.5 text-left ${state.battleAnimationMode === mode ? 'border-amber-400/60 bg-amber-400/12' : 'border-white/10 bg-black/25 hover:border-white/20'}`}><span className="block ui-text-small font-black text-[#e8decd]">{label}</span><span className="block ui-text-small text-[#8f887b]">{description}</span></button>)}
              </div>}
            </div>
          </div>
          {isolatedHackathon && !activeDungeon && <AutomaticHealingStatus game={game} />}
          {!activeDungeon && banner && (
            <div className="absolute inset-x-0 top-1/4 flex flex-col items-center z-30 pointer-events-none">
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
          {activeDungeon && <DungeonBattleControls checkpoint={activeDungeon} attempts={dungeonAttempts} onChange={(next) => void handleDungeonChange(next)} onAttempts={setDungeonAttempts} onCombatPulse={setDungeonFloaters} onHydrate={game.hydrateServerState} onComplete={(won, gold = 0, scrolls = 0) => setDungeonCompletion({ won, depth: activeDungeon.depth, kind: activeDungeon.type, gold, scrolls })} />}
          {dungeonCompletion && <div className={`dungeon-complete ${dungeonCompletion.won ? 'is-victory' : 'is-defeat'}`} role="dialog" aria-modal="true" aria-label={dungeonCompletion.won ? 'Encounter Complete' : 'Encounter Failed'}><div className="dungeon-complete-crest"><Skull size={38} /><small>{dungeonCompletion.kind === 'boss_hunt' ? 'BOSS HUNT' : `CURSED CITADEL · DEPTH ${dungeonCompletion.depth}`}</small><strong>{dungeonCompletion.won ? (dungeonCompletion.kind === 'boss_hunt' ? 'BOSS DEFEATED' : 'DUNGEON COMPLETE') : 'THE ENEMY ENDURES'}</strong><p>{dungeonCompletion.won ? (dungeonCompletion.kind === 'boss_hunt' ? 'The server verified and settled every Boss reward.' : 'The Abyss throne is silent. Server reward result:') : 'The formation has fallen.'}</p>{dungeonCompletion.won && <div className="dungeon-reward-preview">{dungeonCompletion.kind === 'boss_hunt' ? <><span><Coins size={14} /> {formatNum(dungeonCompletion.gold)} GOLD</span><span><Package size={14} /> 1 BOSS CHEST</span><small>Granted together exactly once by the server</small></> : <><span><SummonScrollArtwork size={18} /> {dungeonCompletion.scrolls} SUMMON SCROLLS</span><span><Package size={14} /> 1 DUNGEON CHEST PREVIEW</span><small>{dungeonCompletion.scrolls === 2 ? 'Scrolls granted exactly once by the server; Dungeon Chest is not yet granted' : 'No Scrolls granted for this run; Dungeon Chest is not yet granted'}</small></>}</div>}<button type="button" className="game-control game-primary" onClick={() => setDungeonCompletion(null)}>RETURN TO BATTLE</button></div></div>}
          {!activeDungeon && import.meta.env.MODE === 'staging' && <TestControls game={game} />}
          {!activeDungeon && <div className="hl-battle-footer normal-battle-footer relative z-30 flex shrink-0 flex-wrap items-end justify-between gap-3 px-3 pb-3">
            <TokenEarningsPanel status={tok.status} stale={tok.incomeStale} today={game.state.tokensEarnedToday} />
            <div className="hl-battle-dock ml-auto flex items-end gap-1.5">
            {showDropRates && dropRatesPos && createPortal(<div role="dialog" aria-label="Chest drop rate" className="fixed z-[100] w-56 overflow-y-auto rounded-lg border border-[#80683f] bg-[#11130f]/98 p-2.5 shadow-2xl backdrop-blur-sm" style={{ right: dropRatesPos.right, bottom: dropRatesPos.bottom, maxHeight: dropRatesPos.maxHeight }}>
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
          {isolatedHackathon ? <button
            type="button"
            className="location-disclosure game-control flex min-h-11 w-full items-center justify-between gap-2 px-2 text-left"
            aria-expanded={locationsExpanded}
            aria-controls="location-progression-path"
            onClick={() => setLocationsExpanded(expanded => !expanded)}
          >
            <span className={`section-kicker ${nextLocationAvailable ? 'location-disclosure-ready' : ''}`}>
              Locations <span className="ui-text-small">· {String(state.currentLocation).padStart(2, '0')}</span>
              {nextLocationAvailable && <span className="block ui-text-small">Next location available</span>}
            </span>
            <ChevronDown size={20} className={locationsExpanded ? 'rotate-180 shrink-0' : 'shrink-0'} aria-hidden="true" />
          </button> : <div className="mb-1.5 flex items-center justify-between">
            <span className="section-kicker">Locations</span>
            <span className="ui-text-small font-semibold uppercase tracking-[.12em] text-[#77746d]">Progression path</span>
          </div>}
          <div id="location-progression-path" hidden={!locationsExpanded}>
          <div className={`grid grid-cols-[38px_minmax(0,1fr)_38px] items-stretch gap-1.5 ${isolatedHackathon ? 'mt-1.5' : ''}`}>
            <button onClick={() => scrollLocations(-1)} className="game-control grid place-items-center" aria-label="Previous locations"><ChevronLeft size={20} /></button>
            <div ref={locationRailRef} className="game-scrollbar flex gap-1.5 overflow-x-auto pb-1.5">
            {Array.from({ length: totalLocations }).map((_, i) => {
              const lid = i + 1;
              const l = buildLocation(lid, state.team.length);
              const current = lid === state.currentLocation;
              const completed = lid < state.currentLocation;
              const unlockLv = locationUnlockLevel(lid);
              const locked = state.accountLevel < unlockLv;
              const notYetDiscovered = lid > state.highestLocation;
              const [rLo, rHi] = locationLevelRange(lid);
              const tokenEligible = canMineTokens(lid, state.accountLevel, state.highestLocation);
              return (
                <button
                  key={lid}
                  data-location={lid}
                  onClick={() => !locked && !notYetDiscovered && game.setLocation(lid)}
                  disabled={locked || notYetDiscovered}
                  className={`location-card location-card-art shrink-0 px-2.5 py-1.5 text-left transition ${current ? 'location-card-current' : ''} ${(locked || notYetDiscovered) ? 'location-card-locked' : ''} ${l.boss ? 'ring-1 ring-rose-800/60' : ''}`}
                  style={{ minWidth: '150px', '--location-card-art': `url('/assets/locations/${lid > 10 ? 'endgame' : 'standard'}/location-${lid}.webp')` } as React.CSSProperties}
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
                    Lv {rLo}–{rHi} · Recommended {formatNum(recommendedTeamPower(lid, state.team.length, state.balanceTelemetry))}
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
        </div> : activeDungeon.type === 'boss_hunt' ? <div className="material-panel mt-1.5 shrink-0 p-3"><div className="flex items-center justify-between gap-3"><span className="section-kicker">Boss Hunt</span><span className="ui-text-small font-black uppercase tracking-widest text-violet-300">Server combat · reload-safe · potions disabled</span></div><div className="mt-2 grid grid-cols-2 gap-1.5"><div className={`rounded-lg border px-2 py-2 text-center ui-text-small font-black uppercase ${activeDungeon.room_state?.kind === 'retinue' ? 'border-violet-400 bg-violet-950/40 text-violet-100' : 'border-emerald-700/60 bg-emerald-950/25 text-emerald-300'}`}>1. Retinue</div><div className={`rounded-lg border px-2 py-2 text-center ui-text-small font-black uppercase ${activeDungeon.room_state?.kind === 'shared_boss' ? 'border-violet-400 bg-violet-950/40 text-violet-100' : 'border-white/10 bg-black/20 text-[#77706f]'}`}>2. Shared Boss</div></div></div> : <div className="material-panel mt-1.5 shrink-0 p-3"><div className="flex items-center justify-between gap-3"><span className="section-kicker">Cursed Citadel</span><span className="ui-text-small font-black uppercase tracking-widest text-violet-300">HP persists · potions disabled</span></div><div className="mt-2 grid grid-cols-4 gap-1.5">{['Guards', 'Elite', 'Crossroads', 'Boss'].map((label, index) => <div key={label} className={`rounded-lg border px-2 py-2 text-center ui-text-small font-black uppercase ${activeDungeon.room === index + 1 ? 'border-violet-400 bg-violet-950/40 text-violet-100' : activeDungeon.room > index + 1 ? 'border-emerald-700/60 bg-emerald-950/25 text-emerald-300' : 'border-white/10 bg-black/20 text-[#77706f]'}`}>{index + 1}. {label}</div>)}</div></div>}

      </div>

      {/* ── RIGHT COLUMN ── */}
      <div className="hl-col-right material-panel order-3 flex min-w-0 w-full shrink-0 flex-col overflow-hidden lg:order-none lg:w-[390px] xl:w-[420px]">
        <div className="shrink-0 border-b border-[#4f412e] bg-[radial-gradient(circle_at_20%_0%,rgba(162,118,50,.11),transparent_50%)] px-3 py-2.5">
          <div className="section-kicker mb-2">Active Formation</div>
          <div className="flex min-h-[54px] items-end gap-1.5">
            {state.team.map(uid => {
              const h = state.ownedHeroes.find(h => h.uid === uid); const b = h ? HERO_MAP[h.heroId] : null;
              if (!h || !b) return null;
              return <HeroPortrait key={uid} heroId={b.id} heroClass={b.heroClass} rarity={b.rarity} color={b.color} size={selectedHeroUid === uid ? 56 : 46} active={selectedHeroUid === uid} badge={h.level} respawn={respawnCountdowns[uid] ?? 0} onClick={() => setSelectedHeroUid(uid)} />;
            })}
            {Array.from({ length: 3 - state.team.length }).map((_, i) => <div key={i} className="intentional-empty pm-portrait-slot grid h-[46px] w-[46px] place-items-center"><Star size={13} className="text-[#625c50]" /></div>)}
          </div>
        </div>

        {selectedHero && selectedHeroBase ? (
          <div className="shrink-0 border-b border-[#4f412e] px-3 py-2.5" style={{ zIndex: 10 }}>
            <div className="hl-gear-head mb-2 flex min-w-0 items-center gap-1 whitespace-nowrap">
                <span className="section-kicker shrink-0">Equipped Gear</span>
                <span className="min-w-0 truncate ui-text-small font-vt font-black" style={{ color: RARITY_COLORS[selectedHeroBase.rarity], textShadow: `0 0 8px ${RARITY_COLORS[selectedHeroBase.rarity]}55` }}>{RARITY_LABEL[selectedHeroBase.rarity]} {CLASS_LABEL[selectedHeroBase.heroClass]}</span>
                <span className="group/set relative ml-auto shrink-0">
                  <button type="button" className={`set-bonus-badge h-6 w-[62px] px-1 ui-text-small rarity-${selectedSetBonus?.rarity ?? 'common'} ${selectedSetBonus ? 'set-bonus-active' : ''}`} aria-label="Set bonus details">
                    Set bonus {selectedSetBonus ? `+${selectedSetBonus.percent}%` : '—'}
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
                <button type="button" aria-label="Unequip All" onClick={async () => { if (!canUnequipAll) return; if (await game.unequipAll(selectedHero.uid)) { setSelectedItem(null); showToast('All gear unequipped'); } else showToast(equipmentFailure('Unequip')); }} disabled={!canUnequipAll} className="game-control flex h-6 w-[44px] shrink-0 items-center justify-center gap-0.5 px-0.5 ui-text-small font-bold leading-none" title={selectedEquippedCount === 0 ? 'No equipped items' : canUnequipAll ? 'Move all equipped items to Inventory' : 'Not enough Inventory space'}><PackageMinus size={10} aria-hidden="true" />All</button>
            </div>
            <div className="grid w-full grid-cols-8 gap-1">
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
                    {ib ? (
                      <ItemArtwork itemId={ib.id} name={ib.name} fallback={ib.icon} />
                    ) : (
                      <span aria-hidden="true" className="pointer-events-none absolute inset-1 opacity-55 saturate-[.4] brightness-75">
                        <ItemArtwork itemId={emptySlotArtworkId(slot, selectedHeroBase.heroClass)} name="" fallback="" />
                      </span>
                    )}
                    {ib && item!.enchantLevel > 0 && <div className="absolute top-0 left-0 ui-text-medium font-bold text-amber-400 font-vt leading-none px-0.5">+{item!.enchantLevel}</div>}
                    {ib?.heroClass && <div className="item-class-badge absolute right-0 top-0" title={`${CLASS_LABEL[ib.heroClass]} only`}>{CLASS_SHORT_LABEL[ib.heroClass]}</div>}
                    {ib && <div className="item-level-label absolute bottom-0 right-0 ui-text-medium font-bold font-vt px-1 leading-tight" style={{ background: ic, color: '#000' }}>{item!.level}</div>}
                  </button>
                  <div className="mt-1 min-w-0 truncate text-center ui-text-small font-semibold tracking-[-.03em] text-[#8a867c]" title={SLOT_LABEL[slot]}>{slotLabel}</div>
                </div>;
              })}
            </div>
          </div>
        ) : <div className="px-3 py-3 text-center text-px-dim ui-text-medium font-vt border-b-2 border-px-border shrink-0">Select a hero</div>}

        <div className="game-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
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
              <button onClick={async () => { if (state.team.length === 0) return; const message = await game.autoEquipBest() ? 'Best gear equipped on active team' : equipmentFailure('Auto Equip'); if (!isolatedHackathon) { showToast(message); return; } if (autoGearNoticeTimer.current) clearTimeout(autoGearNoticeTimer.current); setAutoGearNotice(message); autoGearNoticeTimer.current = setTimeout(() => setAutoGearNotice(null), 2400); }} disabled={state.team.length === 0} className="game-control flex w-full min-w-0 items-center justify-center gap-1 px-1 py-1 ui-text-medium font-bold" title="Equip the strongest valid gear on each active hero in formation order"><Wand2 size={12} /> Auto</button>
              {autoGearNotice && <div role="status" className="auto-gear-notice pointer-events-none absolute left-1/2 top-full z-40 mt-1 w-52 -translate-x-1/2 rounded border border-[#9e7b3d] bg-[#15130f] px-2 py-1 text-center ui-text-small font-bold text-[#f2d393] shadow-lg">{autoGearNotice}</div>}
              </div>
              <button type="button" aria-label={inventoryLockMode ? 'Exit Inventory Lock mode' : 'Enter Inventory Lock mode'} aria-pressed={inventoryLockMode} onClick={() => { setInventoryLockMode((active) => !active); setSelectedItem(null); setSelectedItemSource(null); setSelectedItemSlot(null); setShowBulkSellConfirm(false); }} className={`game-control grid min-w-0 place-items-center px-0 py-1 ${inventoryLockMode ? 'border-red-500/70 bg-red-950/55 text-red-300' : 'text-[#a69c8c]'}`} title={inventoryLockMode ? 'Lock mode active — click to exit' : 'Lock mode — click items to lock or unlock'}><LockIcon size={13} /></button>
              <div className="relative">
                <button onClick={() => setShowBulkSellConfirm((value) => !value)} disabled={unlockedSellTotal === 0} className="game-control game-danger flex min-w-0 w-full items-center justify-center gap-1 px-1 py-1 ui-text-medium font-bold" title={`Sell all unlocked items for ${formatNum(unlockedSellTotal)} gold`}><Coins size={12} /> Sell</button>
                {showBulkSellConfirm && <div className="item-sell-confirm absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-[#80502d] p-2 text-left shadow-xl"><p className="ui-text-small font-bold text-[#ead9bf]">Sell all unlocked items for {formatNum(unlockedSellTotal)} Gold?</p><div className="mt-1.5 grid grid-cols-2 gap-1"><button type="button" onClick={() => setShowBulkSellConfirm(false)} className="game-control py-1 ui-text-small font-bold">Cancel</button><button type="button" onClick={async () => { setShowBulkSellConfirm(false); const limited = bagItems.filter((item) => !item.locked && !item.serverOwned && ['divine', 'celestial'].includes(ITEM_MAP[item.itemId]?.rarity ?? '')); await Promise.allSettled(limited.map((item) => tok.removeLimitedItem(item.uid))); const unsold = await game.sellAllUnlocked(); if (unsold > 0) showToast(`${unsold} item${unsold === 1 ? '' : 's'} could not be sold`); }} className="rounded border border-rose-500/45 bg-rose-500/15 py-1 ui-text-small font-black text-rose-200">Sell all</button></div></div>}
              </div>
            </div>}
            {inventoryTab !== 'resources' && inventoryLockMode && <div className="mt-1.5 rounded-md border border-red-500/45 bg-red-950/35 px-2 py-1 text-center ui-text-small font-bold text-red-200" role="status">LOCK MODE · click an item to lock or unlock it</div>}
          </div>
          {inventoryTab === 'resources' ? <div className="min-w-0">
            <div className="grid min-w-0 grid-cols-8 gap-1 overflow-hidden">
            <button type="button" aria-label={`Summon Scrolls: ${formatNum(state.summonScrolls)}`} aria-pressed={selectedResource === 'summon-scroll'} onClick={() => setSelectedResource((current) => current === 'summon-scroll' ? null : 'summon-scroll')} className={`item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-violet-400/55 ${selectedResource === 'summon-scroll' ? 'ring-2 ring-violet-300 ring-offset-1 ring-offset-black' : ''}`} title={`Summon Scrolls: ${formatNum(state.summonScrolls)}`}><SummonScrollArtwork size={48} /><span className="ui-text-small absolute bottom-0 right-0 min-w-4 rounded-tl bg-violet-400 px-0.5 text-center font-bold leading-4 text-black">{formatNum(state.summonScrolls)}</span></button>
            <button type="button" aria-label={`Boss Keys: ${formatNum(state.bossKeys)}`} aria-pressed={selectedResource === 'boss-key'} onClick={() => setSelectedResource((current) => current === 'boss-key' ? null : 'boss-key')} className={`item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-amber-400/55 ${selectedResource === 'boss-key' ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-black' : ''}`} title={`Boss Keys: ${formatNum(state.bossKeys)}`}><BossKeyIcon size={48} /><span className="ui-text-small absolute bottom-0 right-0 min-w-4 rounded-tl bg-amber-400 px-0.5 text-center font-bold leading-4 text-black">{formatNum(state.bossKeys)}</span></button>
            {visiblePotions.map((potion) => <button type="button" key={potion.tier} className="item-slot relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border border-emerald-500/50" title={`${potion.name}: ${state.potions[potion.tier]}`}><ItemArtwork itemId={`potion-${potion.tier}`} name={potion.name} fallback="Potion" /><span className="absolute bottom-0 right-0 min-w-4 rounded-tl bg-emerald-500 px-0.5 ui-text-medium font-bold leading-4 text-black">{state.potions[potion.tier]}</span></button>)}
            {Array.from({ length: GRID_SIZE - resourceSlotCount }, (_, index) => <div key={`resource-empty-${index}`} className="item-slot aspect-square min-w-0 w-full border" style={{ borderColor: 'rgba(128,119,100,0.11)', background: 'linear-gradient(145deg,#151612,#0c0e0d)' }} />)}
            </div>
            {selectedResource && <div className={`mt-2 rounded-lg border p-2 ${selectedResource === 'summon-scroll' ? 'border-violet-400/45 bg-violet-950/20' : 'border-amber-400/45 bg-amber-950/20'}`}><div className="flex items-center gap-2">{selectedResource === 'summon-scroll' ? <SummonScrollArtwork size={40} /> : <BossKeyIcon size={40} />}<div className="min-w-0"><strong className="ui-text-large block text-[#efe4ce]">{selectedResource === 'summon-scroll' ? 'Summon Scroll' : 'Boss Key'}</strong><span className="ui-text-small text-[#9b9283]">Owned: {formatNum(selectedResource === 'summon-scroll' ? state.summonScrolls : state.bossKeys)}</span></div></div><p className="ui-text-medium mt-1.5 leading-snug text-[#c9c0b1]">{selectedResource === 'summon-scroll' ? 'Persistent consumable for one future Free Summon. Scroll spending is not available until server-authoritative Free Summon launches.' : 'Non-deletable resource used only to summon a Boss. One summon consumes one key; a Boss Chest is awarded only after victory.'}</p></div>}
          </div> : <div className={`grid min-w-0 grid-cols-8 gap-1 overflow-hidden ${inventoryLockMode ? 'inventory-lock-cursor' : ''}`}>
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
                  {item?.locked && <LockIcon size={11} className="absolute bottom-0.5 left-0.5 z-10 text-amber-300" />}
                  {item && item.enchantLevel > 0 && <div className="absolute top-0 left-0 ui-text-medium font-bold text-amber-400 font-vt leading-none px-0.5">+{item.enchantLevel}</div>}
                  {itemBase?.heroClass && <div className="item-class-badge absolute right-0 top-0" title={`${CLASS_LABEL[itemBase.heroClass]} only`}>{CLASS_SHORT_LABEL[itemBase.heroClass]}</div>}
                  {item && <span className="item-level-label ui-text-small absolute bottom-0 right-0 min-w-4 rounded-tl bg-[#d9d0c0] px-0.5 text-center font-bold leading-4 text-black" title={`Item level ${item.level}`}>{item.level}</span>}
                </button>
                {gridIndex === selectedBagRowEnd && liveSelectedItem && selectedItemSource === 'bag' && <div className="col-span-8 rounded-lg border border-[#6e5837] bg-[#10120f] p-2 shadow-inner"><ItemActionPanel item={liveSelectedItem} game={game} equippedSlot={null} comparisonItem={comparisonItem} equipDisabledReason={selectedEquipReason} onEquip={async (slot) => { if (!selectedHero) return; if (await game.equipItem(selectedHero.uid, liveSelectedItem.uid, slot)) { setSelectedItem(null); showToast('Item equipped'); } else showToast(equipmentFailure('Equip')); }} onBeforeSell={async (selected) => { if (selected.serverOwned) return true; const selectedRarity = ITEM_MAP[selected.itemId]?.rarity; return selectedRarity === 'divine' || selectedRarity === 'celestial' ? tok.removeLimitedItem(selected.uid) : true; }} onClose={() => setSelectedItem(null)} /></div>}
                </Fragment>
              );
            })}
            {bagOpenSlots < GRID_SIZE && <div data-inventory-locked-region className="col-span-8 grid min-w-0">
              <div data-inventory-locked-cells className="col-start-1 row-start-1 grid min-w-0 grid-cols-8 gap-1">
                {Array.from({ length: GRID_SIZE - bagOpenSlots }, (_, index) => <button key={`locked-${index}`} type="button" disabled aria-label={`Bag ${activeBag} slot ${bagOpenSlots + index + 1} locked`} className="item-slot aspect-square flex min-w-0 w-full items-center justify-center overflow-hidden border opacity-70" style={{ borderColor: 'rgba(130,103,63,0.35)', background: 'linear-gradient(145deg,#181612,#080909)' }}><LockIcon size={13} className="text-[#8f7652]" aria-hidden="true" /></button>)}
              </div>
            {bagQuote && !bagQuote.complete && bagQuote.bag === inventoryTab && <div className="col-start-1 row-start-1 z-10 m-1 min-w-0 max-w-full self-center justify-self-center text-center ui-text-small text-[#e5d4b4]">
              {isolatedHackathon && <SkrPurchaseButton product="inventory_bag_buy" params={{bag:bagQuote.bag,kind:bagQuote.kind}}
                label={`${bagQuote.kind==='buy'?'Unlock':'Upgrade'} Bag ${bagQuote.bag} · $${(bagQuote.catalogue_usd_cents/100).toFixed(2)}`}
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
        <div className="hl-commander-sheet" role="dialog" aria-modal="true" aria-label="Commander" onClick={() => setCommanderOpen(false)}>
          <div className="hl-commander-sheet-panel material-panel" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="game-control hl-commander-sheet-close" onClick={() => setCommanderOpen(false)} aria-label="Close Commander"><X size={18} /></button>
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

function DungeonBattleControls({ checkpoint, attempts, onChange, onAttempts, onCombatPulse, onHydrate, onComplete }: {
  checkpoint: DungeonCheckpoint;
  attempts: { remaining: number; max: number } | null;
  onChange: (checkpoint: DungeonCheckpoint | null) => void;
  onAttempts: (attempts: { remaining: number; max: number } | null) => void;
  onCombatPulse: (floaters: FloatingNumber[]) => void;
  onHydrate: (state: unknown) => void;
  onComplete: (won: boolean, gold?: number, scrolls?: number) => void;
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
  const survivingHeroes = (roomState?.heroes ?? checkpoint.run_state?.heroes ?? []).filter((hero) => hero.alive).length;
  const formationSize = checkpoint.roster_snapshot?.length ?? (roomState?.heroes ?? checkpoint.run_state?.heroes ?? []).length;
  const bossDurationSeconds = Math.max(0, Math.round(Number(roomState?.elapsed_ms ?? 0) / 1000));

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
        if (action !== 'dungeon_abandon') onComplete(result.status === 'completed', Number(result.gold) || 0, Number(result.scrolls_awarded) || 0);
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
    const interpolate = (startUnits: DungeonUnitState[] = [], finalUnits: DungeonUnitState[] = [], progress: number) => finalUnits.map((unit, index) => {
      const identity = unit.uid ?? unit.unit_id;
      const start = startUnits.find((candidate) => (candidate.uid ?? candidate.unit_id) === identity) ?? startUnits[index] ?? unit;
      const hp = Math.round(Number(start.current_hp) + (Number(unit.current_hp) - Number(start.current_hp)) * progress);
      return { ...unit, current_hp: hp, alive: progress >= 1 ? unit.alive : hp > 0 };
    });
    const bossFight = startState.kind === 'shared_boss';
    const frames = 18;
    const presentationFrames = bossFight ? 36 : 24;
    const totalFrames = bossFight ? presentationFrames : frames;
    const authoritativeDuration = Math.max(totalFrames * 220, Number(finalState.elapsed_ms ?? totalFrames * 450));
    const frameDuration = authoritativeDuration / totalFrames;
    let previousHeroes = startState.heroes ?? [];
    let previousEnemies = startState.enemies ?? [];
    for (let frame = 1; frame <= totalFrames; frame += 1) {
      const beat = bossFight ? Math.ceil(frame / 3) : frame;
      const totalBeats = bossFight ? 12 : totalFrames;
      const progress = beat / totalBeats;
      const nextHeroes = interpolate(startState.heroes, finalState.heroes, progress);
      const nextEnemies = interpolate(startState.enemies, finalState.enemies, progress);
      const born = performance.now();
      const pulses: FloatingNumber[] = [];
      [...nextHeroes, ...nextEnemies].forEach((unit, index) => {
        const identity = unit.uid ?? unit.unit_id ?? `unit-${index}`;
        const prior = [...previousHeroes, ...previousEnemies].find((candidate) => (candidate.uid ?? candidate.unit_id) === identity);
        const delta = prior ? Math.round(Number(prior.current_hp) - Number(unit.current_hp)) : 0;
        const enemy = nextEnemies.includes(unit);
        const targetUid = bossFight && enemy ? `${DUNGEON_BOSS_ART[startState.boss?.boss_id ?? ''] ?? 'boss-lich'}-dungeon-shared` : identity;
        if (delta !== 0) pulses.push({ id: Date.now() + index, targetUid, value: Math.abs(delta), crit: delta > 0 && (beat + index) % 5 === 0, heal: delta < 0, born });
      });
      onCombatPulse(pulses);
      onChange({
        ...resolved,
        room_state: {
          ...finalState,
          status: progress < 1 ? 'resolving' : finalState.status,
          heroes: nextHeroes,
          enemies: nextEnemies,
          playback_tick: frame,
        },
      });
      previousHeroes = nextHeroes; previousEnemies = nextEnemies;
      if (frame < totalFrames) await new Promise<void>((resolve) => setTimeout(resolve, frameDuration));
    }
    onCombatPulse([]);
    if (result.status && result.status !== 'active') {
      onComplete(result.status === 'completed');
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      onChange(null);
      return;
    }
    if (startState.kind === 'retinue' && finalState.status === 'cleared') {
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      const revealed = await requestAction('dungeon_room_complete', {
        encounter_id: resolved.encounter_id,
        expected_revision: resolved.revision,
      });
      if (revealed) onChange(checkpointFromResult(resolved, revealed));
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

  return <aside className="dungeon-battle-panel" aria-label={checkpoint.type === 'boss_hunt' ? 'Boss Hunt controls' : 'Dungeon battle controls'}>
    <div className="flex items-center justify-between ui-text-small font-black uppercase tracking-wide text-[#b7a9c0]"><span>{roomState?.modifier?.split('_').join(' ') ?? (roomState?.kind?.split('_').join(' ') || 'Ready')}</span><span className="flex items-center gap-1">{checkpoint.type === 'boss_hunt' ? <><BossKeyIcon size={16} /> 1 Boss Key spent</> : attempts ? `${attempts.remaining}/${attempts.max} attempts` : '— attempts'}</span></div>
    <div className="grid w-full gap-2">
      {roomState?.status === 'cleared' && <div className="text-center ui-text-medium font-black uppercase tracking-wider text-emerald-300">Room cleared</div>}
      {roomState?.status === 'failed' && <div className="text-center ui-text-medium font-black uppercase tracking-wider text-rose-300">Formation defeated</div>}
      {busy && <div className="text-center ui-text-medium font-black uppercase tracking-wide text-violet-200">Battle in progress…</div>}
      {checkpoint.room === 3 && !roomState && <div className="grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => runAction('dungeon_room_choose', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision, choice: 'recovery' })} className="game-control min-h-11 px-2 ui-text-small font-black text-emerald-300"><HeartPulse size={15} className="mx-auto mb-1" />Recovery · +25% HP</button><button type="button" disabled={busy} onClick={() => runAction('dungeon_room_choose', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision, choice: 'treasure' })} className="game-control min-h-11 px-2 ui-text-small font-black text-amber-300"><Gem size={15} className="mx-auto mb-1" />Treasure fight</button></div>}
      {checkpoint.room === 4 && roomState?.boss && <div className="rounded-lg border border-amber-800/45 bg-amber-950/20 px-3 py-2 text-center ui-text-small font-bold text-amber-200">{roomState.boss.name} · {roomState.status === 'reward_locked' ? 'Defeated · Rewards locked' : roomState.kind === 'shared_boss' ? 'Vulnerable · Shared target' : roomState.status === 'boss_locked' ? 'Retinue defeated · Boss vulnerable' : 'Protected by Retinue'}</div>}
      {roomState?.status === 'reward_locked' && <div className="grid gap-2" role="status" aria-label={checkpoint.type === 'boss_hunt' ? 'Verified Boss Hunt summary' : 'Verified Dungeon run summary'}>
        <div className="rounded-lg border border-emerald-700/45 bg-emerald-950/25 px-2 py-2">
          <div className="text-center ui-text-small font-black uppercase tracking-widest text-emerald-300">{checkpoint.type === 'boss_hunt' ? 'Victory verified' : 'Run verified'}</div>
          <dl className="mt-2 grid grid-cols-2 gap-1 ui-text-small sm:grid-cols-4">
            <div><dt className="text-[#8f8795]">Depth</dt><dd className="font-black text-[#eee5d5]">{checkpoint.depth}</dd></div>
            <div><dt className="text-[#8f8795]">Rooms</dt><dd className="font-black text-[#eee5d5]">{checkpoint.run_state?.rooms_cleared ?? 4} / 4</dd></div>
            <div><dt className="text-[#8f8795]">Survivors</dt><dd className="font-black text-[#eee5d5]">{survivingHeroes} / {formationSize}</dd></div>
            <div><dt className="text-[#8f8795]">Boss time</dt><dd className="font-black text-[#eee5d5]">{bossDurationSeconds}s</dd></div>
          </dl>
        </div>
        {checkpoint.type === 'boss_hunt' ? <div className="dungeon-reward-preview"><span><Coins size={14} /> SERVER GOLD</span><span><Package size={14} /> 1 BOSS CHEST</span><small>Claim is atomic, idempotent and server-owned</small></div> : <div className="dungeon-reward-preview"><span><SummonScrollArtwork size={18} /> {rewardCount(rewardPreview?.summon_scrolls)} SUMMON SCROLLS</span><span><Package size={14} /> {rewardCount(rewardPreview?.dungeon_chests)} DUNGEON CHEST</span><small>Server table {rewardPreview?.reward_table_version ?? 'unavailable'} · {rewardPreview?.reward_table_version === 'dungeon-reward-v3' && rewardCount(rewardPreview?.summon_scrolls) === 2 ? 'claim credits Scrolls once; Dungeon Chest is preview-only' : 'Scroll claim unavailable for this run'}</small></div>}
      </div>}
      {roomState?.status === 'cleared' && checkpoint.room < 4 && <div className="rounded border border-amber-700/35 bg-amber-950/20 px-2 py-1.5 text-center ui-text-small font-bold text-amber-200">Room reward preview · Gold + XP · settlement disabled in testing</div>}
      {primary && <button type="button" disabled={busy} onClick={primary.action} className="game-control game-primary min-h-11 px-3 ui-text-medium font-black"><Skull size={17} className="mr-2 inline" />{primary.label}</button>}
      {error && <div role="alert" className="text-center ui-text-small font-bold text-rose-300">{error.split('_').join(' ')}</div>}
      <button type="button" disabled={busy} onClick={() => confirmAbandon ? void runAction('dungeon_abandon', { encounter_id: checkpoint.encounter_id, expected_revision: checkpoint.revision }) : setConfirmAbandon(true)} className="game-control min-h-10 px-3 ui-text-medium font-bold text-rose-300">{confirmAbandon ? 'Confirm exit · no refund' : checkpoint.type === 'boss_hunt' ? 'Abandon Boss Hunt' : 'Exit Dungeon'}</button>
    </div>
  </aside>;
}

function DungeonPreviewModal({ accountLevel, onStatus, onClose, onGuidesClick }: { accountLevel: number; onStatus: (status: DungeonStatus) => void; onClose: () => void; onGuidesClick: () => void }) {
  const [status, setStatus] = useState<DungeonStatus | null>(null);
  const [depth, setDepth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onCloseRef = useRef(onClose);
  const onStatusRef = useRef(onStatus);
  const active = status?.active_encounter?.type === 'dungeon' ? status.active_encounter : null;
  const effectiveLevel = status?.account_level ?? accountLevel;
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
      label: effectiveLevel < 30 ? 'Unlocks at Account Level 30' : `Enter Depth ${depth} · Uses 1 Attempt`,
      disabled: effectiveLevel < 30 || status.attempts_remaining < 1,
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

        {!active && <div className="dungeon-depth-picker" aria-label="Dungeon depth">{[1, 2, 3].map((value) => <button key={value} type="button" disabled={effectiveLevel < 30 || busy} onClick={() => setDepth(value)} className={depth === value ? 'is-selected' : ''}><span>Depth {value}</span><small>{value === 1 ? 'Ruined Fortress' : value === 2 ? 'Inner Keep' : 'Abyss Foundation'}</small></button>)}</div>}

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
  const daily = isolatedHackathon ? 0 : status?.my_daily_share ?? 0;
  const rate = isolatedHackathon ? 0 : status?.my_hourly_share ?? 0;
  const pool = isolatedHackathon ? 0 : status?.pool_amount ?? DAILY_POOL;
  const poolSharePct = status?.pool_share_percent ?? 0;
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
      <div id="battle-income-details" hidden={isolatedHackathon && !open} className={`hl-battle-income battle-income flex w-max flex-col items-stretch gap-2 font-vt ${isolatedHackathon ? 'battle-income-popover fixed overflow-y-auto' : ''}`} style={isolatedHackathon ? popoverPosition : undefined}>
      <div className={`${isolatedHackathon ? 'hl-skr-income' : 'hl-hero-only'} token-earnings-panel flex w-full flex-col gap-2 rounded-2xl border-2 border-[#b98a3c] bg-[#0d100d]/[.98] px-4 py-3 shadow-[0_0_34px_rgba(229,177,70,.4)]`}>
      <div className="flex items-center gap-2">
        <HeroTokenIcon size={22} />
        <span className="ui-text-small font-black uppercase tracking-[.14em] text-[#ffd36e]">$HERO Income</span>
        {stale && <span className="ml-auto ui-text-small font-bold uppercase tracking-wide text-amber-300" title="Keeping the last confirmed server values while income refresh retries">Updating…</span>}
      </div>
      {status ? (
        <div className="grid grid-cols-[max-content_max-content] items-baseline gap-x-2 gap-y-2 whitespace-nowrap">
          <Row label="Per hour" value={isolatedHackathon ? `${fmt(rate)} $SKR` : `${fmt(rate)} (${usd(rate)})`} valueClass="text-[#7ee787]" />
          <Row label="Per day" value={isolatedHackathon ? `${fmt(daily)} $SKR` : `${fmt(daily)} (${usd(daily)})`} valueClass="text-[#e5bd68]" />
          <Row label="Pool share" value={`${poolSharePct.toFixed(poolSharePct < 0.01 ? 4 : 2)}%`} valueClass="text-[#9ed7ff]" />
          <Row label="Today" value={isolatedHackathon ? '0 $SKR' : `${formatNum(today)} (${usd(today)})`} valueClass="text-[#ffd36e]" />
          <Row label="Daily pool" value={isolatedHackathon ? `${formatNum(pool)} $SKR` : `${formatNum(pool)} $HERO`} valueClass="text-[#c8b3f0]" />
        </div>
      ) : (
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

function AvatarPicker({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const uniqueHeroIds = [...new Set(game.state.ownedHeroes.map((hero) => hero.heroId))];
  return <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[3px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="px-panel-raised game-scrollbar max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl p-4"><div className="flex items-center justify-between"><div><div className="section-kicker">Account identity</div><h3 className="mt-1 ui-text-large font-black text-[#eee2cb]">Choose Avatar</h3></div><button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center"><X size={15} /></button></div><section className="mt-3"><div className="mb-2 ui-text-small font-bold uppercase tracking-wider text-[#9b907c]">Owned heroes · one of each type</div><div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{uniqueHeroIds.map((heroId) => { const base = HERO_MAP[heroId]; if (!base) return null; const active = heroId === game.state.avatarHeroId; return <button type="button" key={heroId} onClick={() => game.setAvatarHero(heroId)} className={`rounded-lg border p-1 transition ${active ? 'border-[#efc660] bg-[#6a481b]/35 shadow-[0_0_14px_rgba(226,183,84,.35)]' : 'border-[#544630] bg-black/20'}`} title={base.name}><HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={62} active={active} /><span className="mt-1 block truncate ui-text-small font-bold" style={{ color: RARITY_COLORS[base.rarity] }}>{base.name}</span></button>; })}</div></section><div className="mt-4 grid grid-cols-2 gap-2"><section className="stat-tile cursor-not-allowed p-3 opacity-45"><LockIcon size={16} className="text-[#9a8b72]" /><b className="mt-2 block ui-text-medium text-[#cfc4b1]">Avatar Frames</b><span className="ui-text-small text-[#81796c]">Coming later</span></section><section className="stat-tile cursor-not-allowed p-3 opacity-45"><Sparkles size={16} className="text-[#9a8b72]" /><b className="mt-2 block ui-text-medium text-[#cfc4b1]">Glow & Effects</b><span className="ui-text-small text-[#81796c]">Coming later</span></section></div><p className="mt-3 ui-text-small leading-relaxed text-[#837a6d]">The final owned copy of the selected avatar cannot be sold. Choose another avatar first.</p></div></div>;
}

function AutomaticHealingStatus({ game }: { game: GameApi }) {
  const { units } = useSyncExternalStore(game.subscribeCombatPresentation, game.getCombatPresentationSnapshot, game.getCombatPresentationSnapshot);
  const heroes = units.filter(unit => unit.side === 'hero' && unit.hp > 0);
  const hero = heroes.find(unit => unit.hp < unit.maxHp * .35) ?? heroes[0];
  const potion = POTIONS.find(item => item.hpRestore >= (hero?.maxHp ?? 0) * .5) ?? POTIONS[POTIONS.length - 1];
  const stock = Object.values(game.state.potions).some(count => count > 0);
  const label = !game.state.autoPot.healingInfoSeen || !goldHealingEnabled(game.state.autoPot)
    ? 'Healing · stored potions only'
    : stock ? 'Healing · stock first' : game.state.gold < potion.cost
      ? `Healing · not enough Gold (needs ${potion.cost})` : 'Healing · automatic Gold';
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
  return createPortal(<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4">
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
      <p className="mt-3 ui-text-medium leading-relaxed text-[#e8decd]">Below 35% HP, heroes instantly use stored potions first. When stock runs out, Gold buys the smallest potion that restores at least half their maximum HP, up to XXL.</p>
      <div className="my-4 grid grid-cols-3 gap-2">{POTIONS.map(potion => <div key={potion.tier} className="rounded-md border border-white/10 bg-black/25 p-2 text-center ui-text-medium text-[#efd18a]">{potion.name}<span className="block text-[#c4bba7]">{potion.cost} Gold</span></div>)}</div>
      <p className="ui-text-medium leading-relaxed text-[#c4bba7]">Not enough Gold? No purchase is made. Heroes keep their remaining HP between waves. Potions do not revive heroes and are unavailable in Dungeons and Boss Hunts.</p>
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
