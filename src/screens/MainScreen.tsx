import { Fragment, useEffect, useState, useMemo, useRef } from 'react';
import { Package, FlaskConical, Lock as LockIcon, Star, X, Coins, CheckCircle2, Circle, ArrowUpDown, Wand2, ChevronLeft, ChevronRight, Hammer, Sparkles, Info, Settings2 } from 'lucide-react';
import { Arena } from '@/components/Arena';
import { HeroPortrait } from '@/components/HeroPortrait';
import { ItemActionPanel } from '@/components/ItemActionPanel';
import { buildLocation, canMineTokens, equippedSetBonus, getEquippedItems, heroStats, locationUnlockLevel, locationLevelRange, LOCATION_RANGES, SET_BONUS_PERCENT, teamPower as calculateHeroPower } from '@/game/engine';
import { formatNum, accountXpForLevel, accountXpProgress, heroXpForLevel } from '@/game/state';
import { ITEM_MAP, SLOT_LABEL, POTIONS, sellValue, meetsItemLevelRequirement, canClassEquipItem, standardChestWeights } from '@/game/items';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, CLASS_LABEL, RARITY_INDEX } from '@/game/heroes';
import type { TokenomicsApi } from '@/game/useTokenomics';
import type { TokenomicsStatus } from '@/game/useTokenomics';
import type { GameApi } from '@/game/useGame';
import type { HeroClass, ItemSlot, OwnedItem, PotionTier } from '@/game/types';
import { ItemArtwork } from '@/components/ItemArtwork';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { ChestCollectIcon } from '@/components/ChestCollectIcon';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { recommendedTeamPower } from '@/game/balance';
import { playerSync, supabase } from '@/game/backend';

const SAVE_KEY = 'afk-heroes-save-v7';

const SLOTS: ItemSlot[] = ['class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'];
const GRID_SIZE = 64;

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

export function MainScreen({ game, tokenomics }: { game: GameApi; tokenomics: TokenomicsApi }) {
  const { state, units, floaters, battleResult, potionFx, respawnCountdowns } = game;
  const tok = tokenomics;
  const accountXpCurrent = accountXpProgress(state.accountXp, state.accountLevel);
  const [banner, setBanner] = useState<string | null>(null);
  const [showPotSettings, setShowPotSettings] = useState(false);
  const [showBattleSettings, setShowBattleSettings] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showBulkSellConfirm, setShowBulkSellConfirm] = useState(false);
  const [showDropRates, setShowDropRates] = useState(false);
  const [showZoomTip, setShowZoomTip] = useState(true);
  const [selectedHeroUid, setSelectedHeroUid] = useState<string | null>(state.team[0] ?? null);
  const [selectedItem, setSelectedItem] = useState<OwnedItem | null>(null);
  const [selectedItemSource, setSelectedItemSource] = useState<'bag' | 'hero' | null>(null);
  const [selectedItemSlot, setSelectedItemSlot] = useState<ItemSlot | null>(null);
  const locationRailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (battleResult) { setBanner(battleResult.win ? 'VICTORY' : 'DEFEAT'); const t = setTimeout(() => setBanner(null), 2600); return () => clearTimeout(t); }
    return undefined;
  }, [battleResult]);

  useEffect(() => {
    if (selectedHeroUid && !state.team.includes(selectedHeroUid)) setSelectedHeroUid(state.team[0] ?? null);
  }, [state.team, selectedHeroUid]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };

  const drop = battleResult?.drop;
  const dropBase = drop ? ITEM_MAP[drop.itemId] : null;
  const power = game.teamPower();
  const ownPower = useMemo(() => calculateHeroPower(state.ownedHeroes, state.inventory), [state.ownedHeroes, state.inventory]);
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
  const potionsEmpty = POTIONS.every((potion) => state.potions[potion.tier] <= 0);
  const showAutoPotGuide = potionsEmpty && !state.autoPot.autoBuy;
  const cells: (OwnedItem | null)[] = Array.from({ length: Math.max(0, GRID_SIZE - visiblePotions.length) }).map((_, i) => bagItems[i] ?? null);
  const unlockedSellTotal = bagItems
    .filter(i => !i.locked && !['divine', 'celestial'].includes(ITEM_MAP[i.itemId]?.rarity ?? ''))
    .reduce((acc, i) => acc + sellValue(i), 0);
  const selectedEquippedCount = selectedHero ? Object.values(selectedHero.equipped).filter(Boolean).length : 0;
  const canUnequipAll = selectedEquippedCount > 0 && bagItems.length + selectedEquippedCount <= GRID_SIZE;
  const selectedBagIndex = selectedItemSource === 'bag' && liveSelectedItem
    ? visiblePotions.length + bagItems.findIndex((item) => item.uid === liveSelectedItem.uid)
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

  useEffect(() => {
    const current = locationRailRef.current?.querySelector<HTMLElement>(`[data-location="${state.currentLocation}"]`);
    current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [state.currentLocation]);

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
    if (!result || !game.summonBoss(result.remaining_keys)) showToast('A Boss Key is required');
  };

  return (
    <div className="game-main flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* ── LEFT COLUMN ── */}
      <div className="material-panel game-scrollbar order-2 flex w-full shrink-0 flex-col overflow-y-auto lg:order-none lg:w-60 xl:w-64">
        <div className="border-b border-[#4f412e] p-3">
          <div className="section-kicker mb-2">Account</div>
          <div className="mb-2 flex items-center gap-2.5">
            <button type="button" onClick={() => setShowAvatarPicker(true)} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-[#e0b45f] bg-black/30 shadow-[inset_0_1px_rgba(255,249,214,.28),0_0_14px_rgba(208,163,74,.24)]" title="Change account avatar">
              {avatarBase && <HeroPortrait heroId={avatarBase.id} heroClass={avatarBase.heroClass} rarity={avatarBase.rarity} color={avatarBase.color} size={46} />}
              <span className="absolute bottom-0 right-0 rounded-tl bg-black/80 px-1 text-[8px] font-black text-[#ffe6a2]">{state.accountLevel}</span>
            </button>
            <div className="flex-1">
              <div className="text-base font-extrabold text-[#f0dfba]">Level {state.accountLevel}</div>
              <div className="health-track mt-1 h-2.5 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#9b6824,#efc760)] shadow-[0_0_8px_rgba(225,177,77,.35)]" style={{ width: `${Math.min(100, (accountXpCurrent / accountXpForLevel(state.accountLevel)) * 100)}%` }} /></div>
              <div className="mt-1 text-[10px] font-semibold tabular-nums text-[#928b7d]">{formatNum(accountXpCurrent)} / {formatNum(accountXpForLevel(state.accountLevel))} XP</div>
            </div>
          </div>
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <div className="stat-tile px-2 py-1.5">
              <div className="text-[8px] font-bold uppercase tracking-[.1em] text-[#8e887b]">Team Power</div>
              <div className="mt-0.5 text-sm font-black tabular-nums text-[#f0c563]">⚡ {formatNum(power)}</div>
            </div>
            <div className="stat-tile px-2 py-1.5">
              <div className="text-[8px] font-bold uppercase tracking-[.1em] text-[#8e887b]">Hero Power</div>
              <div className="mt-0.5 text-sm font-black tabular-nums text-[#f0c563]">⚡ {formatNum(selectedHeroPower)}</div>
            </div>
          </div>
          {selectedHero && (
            <div className="stat-tile mb-2 px-2 py-1.5">
              <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-[.1em] text-[#8e887b]"><span>Hero XP</span><span>Level {selectedHero.level}</span></div>
              <div className="health-track mt-1 h-2.5 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#705028,#ddb557)]" style={{ width: `${Math.min(100, (selectedHero.xp / heroXpForLevel(selectedHero.level)) * 100)}%` }} /></div>
              <div className="mt-1 text-[10px] font-semibold tabular-nums text-[#928b7d]">{formatNum(selectedHero.xp)} / {formatNum(heroXpForLevel(selectedHero.level))} XP</div>
            </div>
          )}
          {selectedHeroStats && (
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
                <div key={label} className="stat-tile flex min-h-[42px] flex-col justify-center px-2 py-1.5">
                  <span className="text-[9px] font-semibold text-[#837f75]">{label}</span>
                  <span className="mt-0.5 text-[13px] font-bold tabular-nums text-[#e8e1d3]">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 p-3">
          <div className="section-kicker mb-2">Daily Quests</div>
          <div className="space-y-1.5">
            {state.dailyQuests.map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className={`quest-card p-2 ${done && !q.claimed ? 'border-[#b48a43]' : ''}`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    {q.claimed ? <CheckCircle2 size={14} className="text-emerald-400" /> : done ? <Circle size={14} className="text-amber-400 fill-amber-400/30" /> : <Circle size={14} className="text-slate-600" />}
                    <span className="text-sm text-px-text font-vt flex-1">{q.label}</span>
                  </div>
                  <div className="health-track mb-1 h-2 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#765022,#d4a449)]" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-px-dim font-vt">{q.progress}/{q.target}</span>
                    <span className="text-px-text font-vt flex items-center gap-1"><Coins size={11} />{q.reward.gold} <HeroTokenIcon size={11} />{q.reward.hero}</span>
                  </div>
                  {done && !q.claimed && <button onClick={() => game.claimQuest(q.id)} className="game-control game-primary mt-2 w-full px-3 py-1 text-xs font-bold">Claim reward</button>}
                </div>
              );
            })}
          </div>
          <div className="section-kicker mb-2 mt-4">Milestone Quests</div>
          <div className="space-y-1.5">
            {state.milestoneQuests.map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className={`quest-card p-2 ${done ? 'border-[#b48a43]' : ''}`}>
                  <div className="mb-1 flex items-center gap-1.5">
                    {done ? <Circle size={14} className="fill-amber-400/30 text-amber-400" /> : <Circle size={14} className="text-slate-600" />}
                    <span className="flex-1 font-vt text-sm text-px-text">{q.label}</span>
                    <span className="text-[8px] font-bold uppercase text-[#8e887b]">Tier {(q.tier ?? 0) + 1}</span>
                  </div>
                  <div className="health-track mb-1 h-2 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#5a3d70,#bd78d5)]" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                  <div className="flex items-center justify-between text-xs"><span className="font-vt text-px-dim">{formatNum(q.progress)}/{formatNum(q.target)}</span><span className="flex items-center gap-1 font-vt text-px-text"><Coins size={11} />{formatNum(q.reward.gold)} <HeroTokenIcon size={11} />{q.reward.hero}</span></div>
                  {done && <button onClick={() => game.claimQuest(q.id)} className="game-control game-primary mt-2 w-full px-3 py-1 text-xs font-bold">Claim & unlock next</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── CENTER COLUMN — responsive, max-width removed ── */}
      <div className="game-scrollbar order-1 flex min-h-[464px] w-full shrink-0 flex-col overflow-hidden lg:order-none lg:min-h-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:overflow-y-auto">
        {/* Arena */}
        <div className="battle-stage relative min-h-[320px] flex-1 overflow-hidden bg-arena">
          {showZoomTip && <div className="absolute left-1/2 top-12 z-40 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-[#80683f] bg-[#11130f]/95 px-3 py-1.5 font-vt text-[10px] font-bold text-[#d8c9ad] shadow-xl backdrop-blur-sm"><span>Adjust browser zoom with <kbd className="text-[#ffd36e]">Ctrl +</kbd> / <kbd className="text-[#ffd36e]">Ctrl -</kbd> to fit all interface elements.</span><button type="button" onClick={() => setShowZoomTip(false)} className="text-[#8f887b] hover:text-white" aria-label="Dismiss browser zoom tip"><X size={12} /></button></div>}
          <div className="absolute left-3 top-3 z-30 flex items-start gap-1.5">
            <div className="relative">
              <button onClick={() => setShowPotSettings(s => !s)} className={`game-control relative flex items-center gap-2 px-3 py-2 font-bold ${state.autoPot.enabled ? 'border-emerald-500/60 bg-emerald-950/30 text-emerald-300' : ''} ${showAutoPotGuide ? 'auto-pot-guide' : ''}`}>
                <FlaskConical size={16} /> Pot-auto {state.autoPot.enabled ? 'ON' : 'OFF'}
              </button>
              {showAutoPotGuide && !showPotSettings && <div className="auto-pot-guide-tip">Potions empty · open Auto-pot</div>}
              {showPotSettings && <PotionSettings game={game} guideAutoBuy={showAutoPotGuide} onClose={() => setShowPotSettings(false)} />}
            </div>
            <div className="relative">
              <button type="button" onClick={() => setShowBattleSettings((value) => !value)} className="game-control flex h-9 items-center gap-1.5 px-2 text-[9px] font-black uppercase" aria-label="Battle animation settings" aria-expanded={showBattleSettings}><Settings2 size={15} /><span className="hidden sm:inline">{state.battleAnimationMode}</span></button>
              {showBattleSettings && <div className="absolute left-0 top-full mt-1 w-56 rounded-lg border border-[#80683f] bg-[#11130f]/97 p-2 shadow-2xl backdrop-blur-sm">
                <div className="mb-1.5 text-[9px] font-black uppercase tracking-[.14em] text-[#efd18a]">Battle animation</div>
                {([
                  ['light', 'Light', 'Current restrained movement'],
                  ['spectacular', 'Spectacular', 'Richer local combat effects'],
                  ['off', 'Off', 'Static units; essential feedback only'],
                ] as const).map(([mode, label, description]) => <button key={mode} type="button" onClick={() => { game.setBattleAnimationMode(mode); setShowBattleSettings(false); }} className={`mt-1 w-full rounded-md border px-2 py-1.5 text-left ${state.battleAnimationMode === mode ? 'border-amber-400/60 bg-amber-400/12' : 'border-white/10 bg-black/25 hover:border-white/20'}`}><span className="block text-[10px] font-black text-[#e8decd]">{label}</span><span className="block text-[8px] text-[#8f887b]">{description}</span></button>)}
              </div>}
            </div>
          </div>
          {banner && (
            <div className="absolute inset-x-0 top-1/4 flex flex-col items-center z-30 pointer-events-none">
              <div className={`anim-banner font-pixel text-xl sm:text-2xl tracking-wider ${banner === 'VICTORY' ? 'text-px-bright' : 'text-px-red'}`} style={{ textShadow: banner === 'VICTORY' ? '0 0 20px #f5c518' : '0 0 20px #c02010' }}>{banner}</div>
              {battleResult && (
                <div className="anim-banner stat-tile mt-2 flex flex-wrap items-center justify-center gap-2 px-3 py-2 font-vt text-sm">
                  {battleResult.gold > 0 && <span className="text-amber-300">+{formatNum(battleResult.gold)}g</span>}
                  {battleResult.win && <span className="text-emerald-300">+{formatNum(battleResult.xp)} XP</span>}
                  {dropBase && <span style={{ color: RARITY_COLORS[dropBase.rarity] }} className="flex items-center gap-1"><Package size={11} /> {dropBase.name}</span>}
                  {battleResult.chest && <span className="text-amber-200 flex items-center gap-1">+1 chest</span>}
                </div>
              )}
            </div>
          )}
          {potionFx && <div key={potionFx.born} className="absolute inset-0 pointer-events-none anim-fade" style={{ background: 'radial-gradient(circle at 50% 70%, rgba(74,222,128,0.15), transparent 60%)' }} />}
          <Arena units={units} floaters={floaters} ownedHeroes={state.ownedHeroes} inventory={state.inventory} potionFx={potionFx} respawnCountdowns={respawnCountdowns} animationMode={state.battleAnimationMode} />
          <button
            onClick={handleSummonBoss}
            disabled={state.bossKeys < 1 || state.bossBattleActive}
            className="game-control absolute right-3 top-3 z-30 flex h-7 items-center gap-1 px-2 py-0.5 text-[9px] font-bold"
          >
            <BossKeyIcon size={22} /> {state.bossBattleActive ? 'BOSS ACTIVE' : `BOSS · ${state.bossKeys}`}
          </button>
          <TestControls game={game} />
          <div className="absolute bottom-3 right-3 z-30 flex items-end gap-1.5">
            {showDropRates && <div className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-[#80683f] bg-[#11130f]/95 p-2.5 shadow-2xl backdrop-blur-sm">
              <div className="flex items-center justify-between gap-2"><strong className="text-[10px] uppercase tracking-wider text-[#efd18a]">Chest drop rate</strong><button type="button" onClick={() => setShowDropRates(false)} aria-label="Close drop rates"><X size={13} /></button></div>
              <p className="mt-1 text-[9px] text-[#978f81]">Current Account Level {state.accountLevel}. Rates update with account level and global rarity availability.</p>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">{chestRateRows.map(([rarity, weight]) => <Fragment key={rarity}><span className="text-[9px] font-bold" style={{ color: RARITY_COLORS[rarity as keyof typeof RARITY_COLORS] }}>{RARITY_LABEL[rarity as keyof typeof RARITY_LABEL]}</span><span className="text-right text-[9px] tabular-nums text-[#ddd4c4]">{(weight / chestWeightTotal * 100).toFixed(2).replace(/\.?0+$/, '')}%</span></Fragment>)}</div>
              {state.chests.some((chest) => chest.boss) && <p className="mt-2 border-t border-white/10 pt-2 text-[9px] text-rose-200">Boss Chests use the same level table with a Rare/Epic minimum.</p>}
            </div>}
            <button type="button" onClick={() => setShowDropRates((value) => !value)} className="game-control grid h-8 w-8 place-items-center" aria-label="Show chest drop rates" aria-expanded={showDropRates}><Info size={15} /></button>
            <button
              onClick={() => game.openChests(tok.status?.rarity_capacity ?? {}, tok.reserveLimitedItem)}
              disabled={state.chests.length === 0}
              className={`reward-cta game-control flex h-8 items-center gap-1 px-2 py-0.5 text-[9px] font-black disabled:opacity-55 ${state.tutorial.chestGranted && !state.tutorial.chestCompleted ? 'chest-tutorial-guide' : ''}`}
              title={state.tutorial.chestGranted && !state.tutorial.chestCompleted ? 'Tutorial: open your first chest' : 'Open chests'}
            >
              <ChestCollectIcon size={34} />
              <span>OPEN · {state.chests.length}</span>
              {state.tutorial.chestGranted && !state.tutorial.chestCompleted && <span className="chest-tutorial-badge">+1</span>}
            </button>
          </div>
          <TokenEarningsPanel status={tok.status} today={game.state.tokensEarnedToday} clientPower={ownPower} eligible={canMineTokens(state.currentLocation, state.accountLevel, state.highestLocation)} heroes={state.ownedHeroes.length} defeated={state.totalKills} bosses={state.totalBossKills} />
        </div>

        {/* Location cards — redesigned like screenshot 4 */}
        <div className="material-panel mt-1.5 shrink-0 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="section-kicker">Locations</span>
            <span className="text-[10px] font-semibold uppercase tracking-[.12em] text-[#77746d]">Progression path</span>
          </div>
          <div className="grid grid-cols-[38px_minmax(0,1fr)_38px] items-stretch gap-1.5">
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
                  className={`location-card shrink-0 px-2.5 py-1.5 text-left transition ${current ? 'location-card-current' : ''} ${(locked || notYetDiscovered) ? 'location-card-locked' : ''} ${l.boss ? 'ring-1 ring-rose-800/60' : ''}`}
                  style={{ minWidth: '150px' }}
                >
                  {/* Top row: number + boss + lock */}
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-vt text-base font-bold" style={{ color: notYetDiscovered ? '#62543a' : current ? '#f0c461' : '#c5aa76' }}>
                      {String(lid).padStart(2, '0')}
                      {l.boss && <span className="text-px-red ml-1">BOSS</span>}
                    </span>
                    <span className="text-[9px] font-bold uppercase tracking-wider text-[#858073]">{current ? 'Current' : completed ? 'Completed' : locked || notYetDiscovered ? 'Locked' : 'Available'}</span>
                  </div>
                  {/* Name */}
                  <div className="mt-0.5 truncate text-xs font-bold text-[#e5ddcc]">{l.name}</div>
                  {/* Level, required power and gold */}
                  <div className="mt-0.5 text-[9px] font-semibold text-[#8f8a7e]">
                    Lv {rLo}–{rHi} · Recommended {formatNum(recommendedTeamPower(lid, state.team.length, state.balanceTelemetry))}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] font-vt">
                    <span className="flex items-center gap-1 text-[#c79b4e]"><Coins size={11} />{formatNum(l.goldReward)} Gold</span>
                    {!locked && !notYetDiscovered && <span className={`ml-auto text-[9px] font-bold ${tokenEligible ? 'text-emerald-400' : 'text-[#776f63]'}`}>{tokenEligible ? '$HERO ACTIVE' : 'NO $HERO'}</span>}
                    {(locked || notYetDiscovered) && <LockIcon size={11} className="ml-auto text-[#777064]" />}
                  </div>
                </button>
              );
            })}
            </div>
            <button onClick={() => scrollLocations(1)} className="game-control grid place-items-center" aria-label="Next locations"><ChevronRight size={20} /></button>
          </div>
        </div>

      </div>

      {/* ── RIGHT COLUMN ── */}
      <div className="material-panel order-3 flex min-w-0 w-full shrink-0 flex-col overflow-hidden lg:order-none lg:w-[390px] xl:w-[420px]">
        <div className="shrink-0 border-b border-[#4f412e] bg-[radial-gradient(circle_at_20%_0%,rgba(162,118,50,.11),transparent_50%)] px-3 py-2.5">
          <div className="section-kicker mb-2">Active Formation</div>
          <div className="flex min-h-[54px] items-end gap-1.5">
            {state.team.map(uid => {
              const h = state.ownedHeroes.find(h => h.uid === uid); const b = h ? HERO_MAP[h.heroId] : null;
              if (!h || !b) return null;
              return <HeroPortrait key={uid} heroId={b.id} heroClass={b.heroClass} rarity={b.rarity} color={b.color} size={selectedHeroUid === uid ? 56 : 46} active={selectedHeroUid === uid} badge={h.level} respawn={respawnCountdowns[uid] ?? 0} onClick={() => setSelectedHeroUid(uid)} />;
            })}
            {Array.from({ length: 3 - state.team.length }).map((_, i) => <div key={i} className="intentional-empty grid h-[46px] w-[46px] place-items-center"><Star size={13} className="text-[#625c50]" /></div>)}
          </div>
        </div>

        {selectedHero && selectedHeroBase ? (
          <div className="shrink-0 border-b border-[#4f412e] px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="section-kicker">Equipped Gear</span>
                <span className="group/set relative">
                  <button type="button" className={`set-bonus-badge rarity-${selectedSetBonus?.rarity ?? 'common'} ${selectedSetBonus ? 'set-bonus-active' : ''}`} aria-label="Set bonus details">
                    Set bonus {selectedSetBonus ? `+${selectedSetBonus.percent}%` : '—'}
                  </button>
                  <span className="set-bonus-tooltip pointer-events-none absolute bottom-full left-0 z-[70] mb-1 hidden w-64 rounded-lg border border-[#6f5833] bg-[#10120f]/[.98] p-2 text-[9px] leading-4 text-[#bbb2a2] shadow-2xl group-hover/set:block group-focus-within/set:block">
                    Equip all 8 item slots with one rarity to increase every stat granted by those items.
                    <span className="mt-1 grid grid-cols-3 gap-1">
                      {(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'] as const).map((rarity) => <span key={rarity} className={`set-bonus-rarity rarity-${rarity}`} style={{ color: RARITY_COLORS[rarity] }}>{RARITY_LABEL[rarity]} +{SET_BONUS_PERCENT[rarity]}%</span>)}
                    </span>
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2"><span className="text-[9px] font-vt font-black" style={{ color: RARITY_COLORS[selectedHeroBase.rarity], textShadow: `0 0 8px ${RARITY_COLORS[selectedHeroBase.rarity]}55` }}>{RARITY_LABEL[selectedHeroBase.rarity]} {CLASS_LABEL[selectedHeroBase.heroClass]}</span><button type="button" onClick={() => { if (canUnequipAll) { game.unequipAll(selectedHero.uid); setSelectedItem(null); showToast('All gear unequipped'); } }} disabled={!canUnequipAll} className="game-control px-2 text-[9px] font-black" title={selectedEquippedCount === 0 ? 'No equipped items' : canUnequipAll ? 'Move all equipped items to Inventory' : 'Not enough Inventory space'}>Unequip All</button></div>
            </div>
            <div className="grid w-full grid-cols-8 gap-1">
              {SLOTS.map(slot => {
                const eqUid = selectedHero.equipped[slot];
                const item = eqUid ? state.inventory.find(i => i.uid === eqUid) : null;
                const ib = item ? ITEM_MAP[item.itemId] : null;
                const ic = ib ? RARITY_COLORS[ib.rarity] : undefined;
                return <div key={slot} className="min-w-0 text-center">
                  <button
                    onClick={() => { if (item) { setSelectedItem(item); setSelectedItemSource('hero'); setSelectedItemSlot(slot); } else setSelectedItem(null); }}
                    className={`item-slot group aspect-square w-full min-w-0 flex items-center justify-center overflow-hidden text-lg border transition hover:-translate-y-0.5 relative ${ib ? `rarity-${ib.rarity}` : ''}`}
                    style={{ borderColor: ic ? `${ic}99` : 'rgba(255,255,255,0.08)', background: 'linear-gradient(145deg,#151c27,#090c11)' }}
                    title={ib ? `${ib.name} +${item!.enchantLevel}` : `Empty ${SLOT_LABEL[slot]}`}
                  >
                    {ib ? (
                      <ItemArtwork itemId={ib.id} name={ib.name} fallback={ib.icon} />
                    ) : (
                      <span className="pointer-events-none absolute inset-1 opacity-55 saturate-[.4] brightness-75">
                        <ItemArtwork itemId={emptySlotArtworkId(slot, selectedHeroBase.heroClass)} name={`Empty ${SLOT_LABEL[slot]}`} fallback="" />
                      </span>
                    )}
                    {ib && item!.enchantLevel > 0 && <div className="absolute top-0 left-0 text-[11px] font-bold text-amber-400 font-vt leading-none px-0.5">+{item!.enchantLevel}</div>}
                    {ib?.heroClass && <div className="item-class-badge absolute right-0 top-0" title={`${CLASS_LABEL[ib.heroClass]} only`}>{CLASS_SHORT_LABEL[ib.heroClass]}</div>}
                    {ib && <div className="absolute bottom-0 right-0 text-[12px] font-bold font-vt px-1 leading-tight" style={{ background: ic, color: '#000' }}>{item!.level}</div>}
                  </button>
                  <div className="mt-1 whitespace-nowrap text-center text-[7px] font-bold uppercase tracking-[-.02em] text-[#77756e]">{slot === 'class_weapon' ? 'Weapon' : SLOT_LABEL[slot]}</div>
                </div>;
              })}
            </div>
          </div>
        ) : <div className="px-3 py-3 text-center text-px-dim text-sm font-vt border-b-2 border-px-border shrink-0">Select a hero</div>}

        <div className="game-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
          <div className="mb-2 min-w-0">
            <div className="flex items-center gap-2">
              <span className="section-kicker">Inventory</span>
              <span className="rounded-md border border-[#493e2d] bg-black/25 px-2 py-1 text-[10px] font-bold text-[#8d887d]">{bagItems.length}/{GRID_SIZE}</span>
            </div>
            <div className="mt-2 grid min-w-0 grid-cols-4 gap-1">
              <button onClick={() => { game.sortInventory(); showToast('Sorted by rarity'); }} className="game-control flex min-w-0 items-center justify-center gap-1 px-1 py-1 text-xs font-bold" title="Sort by rarity"><ArrowUpDown size={12} /> Sort</button>
              <button onClick={() => { if (state.team.length > 0) { game.autoEquipBest(); showToast('Best gear equipped on active team'); } }} disabled={state.team.length === 0} className="game-control flex min-w-0 items-center justify-center gap-1 px-1 py-1 text-xs font-bold" title="Equip the strongest valid gear on each active hero in formation order"><Wand2 size={12} /> Auto</button>
              <button disabled className="game-control flex min-w-0 items-center justify-center gap-1 px-1 py-1 text-xs font-bold" title="Crafting is coming later"><Hammer size={12} /> Craft</button>
              <div className="relative">
                <button onClick={() => setShowBulkSellConfirm((value) => !value)} disabled={unlockedSellTotal === 0} className="game-control game-danger flex min-w-0 w-full items-center justify-center gap-1 px-1 py-1 text-xs font-bold" title={`Sell all unlocked items for ${formatNum(unlockedSellTotal)} gold`}><Coins size={12} /> Sell</button>
                {showBulkSellConfirm && <div className="item-sell-confirm absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-[#80502d] p-2 text-left shadow-xl"><p className="text-[9px] font-bold text-[#ead9bf]">Sell all unlocked items for {formatNum(unlockedSellTotal)} Gold?</p><div className="mt-1.5 grid grid-cols-2 gap-1"><button type="button" onClick={() => setShowBulkSellConfirm(false)} className="game-control py-1 text-[9px] font-bold">Cancel</button><button type="button" onClick={() => { game.sellAllUnlocked(); setShowBulkSellConfirm(false); }} className="rounded border border-rose-500/45 bg-rose-500/15 py-1 text-[9px] font-black text-rose-200">Sell all</button></div></div>}
              </div>
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-8 gap-1 overflow-hidden">
            {visiblePotions.map((potion) => (
              <button key={potion.tier} className="item-slot aspect-square min-w-0 w-full flex items-center justify-center overflow-hidden border border-emerald-500/50 relative" title={`${potion.name}: +${potion.hpRestore} HP`}>
                <ItemArtwork itemId={`potion-${potion.tier}`} name={potion.name} fallback="🧪" />
                <span className="absolute bottom-0 right-0 min-w-4 bg-emerald-500 px-0.5 text-[11px] font-bold leading-4 text-black">{state.potions[potion.tier]}</span>
              </button>
            ))}
            {cells.map((item, i) => {
              const itemBase = item ? ITEM_MAP[item.itemId] : null;
              const rarity = itemBase?.rarity ?? (item ? 'common' : null);
              const rc = rarity ? RARITY_COLORS[rarity] : null;
              const gridIndex = visiblePotions.length + i;
              return (
                <Fragment key={item ? item.uid : `e${i}`}>
                <button
                  onClick={item ? () => { setSelectedItem(item); setSelectedItemSource('bag'); setSelectedItemSlot(null); } : undefined}
                  className={`item-slot aspect-square min-w-0 w-full flex items-center justify-center overflow-hidden text-xl border transition hover:-translate-y-0.5 relative ${item && rarity ? `rarity-${rarity}` : ''} ${selectedItem?.uid === item?.uid ? 'ring-1 ring-[#d9ad5b]' : ''}`}
                  style={item ? { borderColor: rc ? `${rc}99` : 'rgba(255,255,255,0.08)' } : { borderColor: 'rgba(128,119,100,0.11)', background: 'linear-gradient(145deg,#151612,#0c0e0d)' }}
                >
                  {item && <ItemArtwork itemId={item.itemId} name={ITEM_MAP[item.itemId]?.name ?? 'Item'} fallback={ITEM_MAP[item.itemId]?.icon ?? '◆'} className="leading-none" />}
                  {item?.locked && <LockIcon size={11} className="absolute bottom-0.5 left-0.5 z-10 text-amber-300" />}
                  {item && item.enchantLevel > 0 && <div className="absolute top-0 left-0 text-[11px] font-bold text-amber-400 font-vt leading-none px-0.5">+{item.enchantLevel}</div>}
                  {itemBase?.heroClass && <div className="item-class-badge absolute right-0 top-0" title={`${CLASS_LABEL[itemBase.heroClass]} only`}>{CLASS_SHORT_LABEL[itemBase.heroClass]}</div>}
                  {item && <div className="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 text-[11px] font-bold leading-tight text-slate-200">{item.level}</div>}
                </button>
                {gridIndex === selectedBagRowEnd && liveSelectedItem && selectedItemSource === 'bag' && <div className="col-span-8 rounded-lg border border-[#6e5837] bg-[#10120f] p-2 shadow-inner"><ItemActionPanel item={liveSelectedItem} game={game} equippedSlot={null} comparisonItem={comparisonItem} equipDisabledReason={selectedEquipReason} onEquip={(slot) => { if (selectedHero) { game.equipItem(selectedHero.uid, liveSelectedItem.uid, slot); setSelectedItem(null); } }} onBeforeSell={async (selected) => { const selectedRarity = ITEM_MAP[selected.itemId]?.rarity; return selectedRarity === 'divine' || selectedRarity === 'celestial' ? tok.removeLimitedItem(selected.uid) : true; }} onClose={() => setSelectedItem(null)} /></div>}
                </Fragment>
              );
            })}
          </div>
        </div>

        {liveSelectedItem && selectedItemSource === 'hero' && (
          <div className="border-t-2 border-px-border p-2 shrink-0 max-h-[45%] overflow-y-auto no-scrollbar">
            <ItemActionPanel
              item={liveSelectedItem}
              game={game}
              equippedSlot={selectedItemSource === 'hero' ? selectedItemSlot : null}
              comparisonItem={comparisonItem}
              equipDisabledReason={selectedEquipReason}
              onUnequip={selectedItemSource === 'hero' && selectedItemSlot ? () => { if (selectedHero) { game.unequipItem(selectedHero.uid, selectedItemSlot); setSelectedItem(null); } } : undefined}
              onBeforeSell={async (item) => {
                const rarity = ITEM_MAP[item.itemId]?.rarity;
                return rarity === 'divine' || rarity === 'celestial' ? tok.removeLimitedItem(item.uid) : true;
              }}
              onClose={() => setSelectedItem(null)}
            />
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-px-panel border-2 border-px-bright font-vt text-base font-bold text-px-bright anim-slide-up" style={{ boxShadow: '3px 3px 0 #3d2008' }}>{toast}</div>
      )}
      {showAvatarPicker && <AvatarPicker game={game} onClose={() => setShowAvatarPicker(false)} />}
    </div>
  );
}

function TestControls({ game }: { game: GameApi }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [done, setDone] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const armed = confirm.toUpperCase() === 'DELETE';

  const creditTokens = async () => {
    if (crediting) return;
    setCrediting(true);
    const result = await playerSync<{ claimed: number; token_balance: number }>('tester_credit_tokens');
    if (result) game.applyServerTokenClaim(result.claimed, result.token_balance);
    setCrediting(false);
  };

  const wipe = async () => {
    if (!armed || busy) return;
    setBusy(true);
    setDeleteError('');
    const deleted = await playerSync<{ deleted: boolean }>('account_delete');
    if (!deleted?.deleted) {
      setDeleteError('Account was not deleted. Nothing was removed locally; retry in a moment.');
      setBusy(false);
      return;
    }
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    setDone(true);
    window.setTimeout(() => { window.location.href = '/'; }, 1300);
  };

  return (
    <>
      <div className="absolute right-3 top-14 z-40 flex flex-col items-stretch gap-1">
        <span className="test-marker">TESTER</span>
        <button type="button" className="test-btn test-btn-gold" onClick={() => game.creditTestGold(10000)}>+10k Gold</button>
        <button type="button" className="test-btn test-btn-gold" onClick={() => game.creditTestAccountXp(2000)}>+2k Account XP</button>
        <button type="button" className="test-btn test-btn-gold" onClick={() => game.creditTestFormationXp(2000)}>+2k Formation XP</button>
        <button type="button" className="test-btn test-btn-green" disabled={crediting} onClick={() => void creditTokens()}>{crediting ? 'Crediting…' : '+10k $HERO'}</button>
        <button type="button" className="test-btn test-btn-reset" onClick={() => setOpen(true)}>Delete account</button>
      </div>

      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[5px] anim-fade" style={{ pointerEvents: 'auto' }} onClick={() => !busy && setOpen(false)}>
          <div className="material-panel relative flex max-h-[78vh] w-full max-w-md flex-col overflow-hidden rounded-xl p-5" onClick={(e) => e.stopPropagation()}>
            {done ? (
              <>
                <h2 className="font-pixel text-base text-[#e85a57]">ACCOUNT DELETED</h2>
                <p className="mt-3 text-sm leading-6 text-px-dim">Everything was wiped from the database. Restarting to a clean slate…</p>
              </>
            ) : (
              <>
                <h2 className="font-pixel text-base text-[#e85a57]">DELETE ACCOUNT &amp; START OVER?</h2>
                <p className="mt-2 text-sm leading-6 text-px-dim">
                  This <b className="text-[#e85a57]">permanently erases your account from the database</b> — heroes, gold,
                  chests, equipment, <b className="text-gold-glow">$HERO</b>, leaderboard placement and all progress.
                  This cannot be undone. Your browser will be signed out so you can register and play the tutorials again.
                </p>
                <label className="mt-4 block text-[10px] font-bold uppercase tracking-widest text-px-dim">
                  Type <b className="text-[#e85a57]">DELETE</b> to confirm
                </label>
                <input
                  autoFocus
                  value={confirm}
                  disabled={busy}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void wipe(); }}
                  className="mt-2 w-full rounded-md border border-[#6b3c3a] bg-black/40 px-3 py-2 font-vt text-base text-white outline-none transition focus:border-[#a95650]"
                />
                {deleteError && <div role="alert" className="mt-3 rounded border border-red-500/45 bg-red-950/45 px-3 py-2 text-xs text-red-200">{deleteError}</div>}
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

function TokenEarningsPanel({ status, today, clientPower, eligible, heroes, defeated, bosses }: { status: TokenomicsStatus | null; today: number; clientPower: number; eligible: boolean; heroes: number; defeated: number; bosses: number }) {
  const TOKEN_PRICE_USD = 0.001;
  const DAILY_POOL = 20_000;
  // Display shares are mirrored client-side using the same efficiency share so
  // the panel never shows 0.000 for an eligible online miner, even when the
  // server status has not yet recorded the player as online/eligible.
  const serverDaily = status?.my_daily_share ?? 0;
  const totalScore = status?.total_power ?? 0;
  const myScore = clientPower > 0 ? clientPower : (status?.my_power ?? 0);
  const daily = eligible && myScore > 0
    ? (myScore / Math.max(totalScore, myScore)) * DAILY_POOL
    : serverDaily;
  const rate = daily / 24;
  const pool = status?.pool_amount ?? DAILY_POOL;
  const poolSharePct = pool > 0 ? (daily / pool) * 100 : 0;
  const fmt = (value: number) => value < 1 ? value.toFixed(3) : formatNum(value);
  const usd = (tokens: number) => {
    const v = tokens * TOKEN_PRICE_USD;
    return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
  };
  const Row = ({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) => (
    <>
      <span className="text-[13px] font-bold uppercase tracking-[.08em] text-[#a79a82]">{label}</span>
      <span className={`text-[15px] font-black tabular-nums ${valueClass ?? 'text-[#e8dfc8]'}`}>{value}</span>
    </>
  );
  return (
    <div className="absolute bottom-3 left-3 z-30 flex w-max origin-bottom-left scale-[.63] flex-col items-stretch gap-2 font-vt">
      <div className="grid w-full grid-cols-[repeat(3,1fr)] gap-2 rounded-2xl border-2 border-[#80683f] bg-[#0d100d]/[.98] px-4 py-3 shadow-[0_0_24px_rgba(128,104,63,.28)]">
        {[['Heroes', heroes], ['Defeated', defeated], ['Bosses', bosses]].map(([label, value]) => <div key={label} className="text-center"><span className="block text-[11px] font-bold uppercase tracking-[.08em] text-[#a79a82]">{label}</span><strong className="mt-1 block text-[16px] tabular-nums text-[#e8dfc8]">{formatNum(Number(value))}</strong></div>)}
      </div>
      <div className="token-earnings-panel flex w-full flex-col gap-2 rounded-2xl border-2 border-[#b98a3c] bg-[#0d100d]/[.98] px-4 py-3 shadow-[0_0_34px_rgba(229,177,70,.4)]">
      <div className="flex items-center gap-2">
        <HeroTokenIcon size={22} />
        <span className="text-[15px] font-black uppercase tracking-[.14em] text-[#ffd36e]">$HERO Income</span>
      </div>
      {status ? (
        <div className="grid grid-cols-[max-content_max-content] items-baseline gap-x-2 gap-y-2 whitespace-nowrap">
          <Row label="Per hour" value={`${fmt(rate)} (${usd(rate)})`} valueClass="text-[#7ee787]" />
          <Row label="Per day" value={`${fmt(daily)} (${usd(daily)})`} valueClass="text-[#e5bd68]" />
          <Row label="Pool share" value={`${poolSharePct.toFixed(poolSharePct < 0.01 ? 4 : 2)}%`} valueClass="text-[#9ed7ff]" />
          <Row label="Today" value={`${formatNum(today)} (${usd(today)})`} valueClass="text-[#ffd36e]" />
          <Row label="Daily pool" value={`${formatNum(pool)} $HERO`} valueClass="text-[#c8b3f0]" />
        </div>
      ) : (
        <span className="text-[12px] font-semibold text-[#9a937f]">Syncing token pool…</span>
      )}
      </div>
    </div>
  );
}

function AvatarPicker({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const uniqueHeroIds = [...new Set(game.state.ownedHeroes.map((hero) => hero.heroId))];
  return <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[3px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="px-panel-raised game-scrollbar max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl p-4"><div className="flex items-center justify-between"><div><div className="section-kicker">Account identity</div><h3 className="mt-1 text-lg font-black text-[#eee2cb]">Choose Avatar</h3></div><button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center"><X size={15} /></button></div><section className="mt-3"><div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#9b907c]">Owned heroes · one of each type</div><div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{uniqueHeroIds.map((heroId) => { const base = HERO_MAP[heroId]; if (!base) return null; const active = heroId === game.state.avatarHeroId; return <button type="button" key={heroId} onClick={() => game.setAvatarHero(heroId)} className={`rounded-lg border p-1 transition ${active ? 'border-[#efc660] bg-[#6a481b]/35 shadow-[0_0_14px_rgba(226,183,84,.35)]' : 'border-[#544630] bg-black/20'}`} title={base.name}><HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={62} active={active} /><span className="mt-1 block truncate text-[8px] font-bold" style={{ color: RARITY_COLORS[base.rarity] }}>{base.name}</span></button>; })}</div></section><div className="mt-4 grid grid-cols-2 gap-2"><section className="stat-tile cursor-not-allowed p-3 opacity-45"><LockIcon size={16} className="text-[#9a8b72]" /><b className="mt-2 block text-xs text-[#cfc4b1]">Avatar Frames</b><span className="text-[9px] text-[#81796c]">Coming later</span></section><section className="stat-tile cursor-not-allowed p-3 opacity-45"><Sparkles size={16} className="text-[#9a8b72]" /><b className="mt-2 block text-xs text-[#cfc4b1]">Glow & Effects</b><span className="text-[9px] text-[#81796c]">Coming later</span></section></div><p className="mt-3 text-[9px] leading-relaxed text-[#837a6d]">The final owned copy of the selected avatar cannot be sold. Choose another avatar first.</p></div></div>;
}

function PotionSettings({ game, guideAutoBuy, onClose }: { game: GameApi; guideAutoBuy: boolean; onClose: () => void }) {
  const { state } = game;
  return (
    <div className="absolute left-0 top-12 w-72 rounded-xl px-panel p-4 anim-slide-up z-40">
      <div className="flex items-center justify-between mb-2"><span className="text-sm font-bold text-px-text font-vt flex items-center gap-1.5"><FlaskConical size={14} className="text-emerald-400" /> Auto-Potions</span><button onClick={onClose} className="text-px-dim"><X size={14} /></button></div>
      <label className="flex items-center justify-between py-1 text-sm font-vt"><span className="text-px-text">Enable auto-use</span><Toggle on={state.autoPot.enabled} onClick={() => game.setAutoPot({ enabled: !state.autoPot.enabled })} /></label>
      <div className="py-1"><div className="flex items-center justify-between text-sm font-vt mb-1"><span className="text-px-text">Use at HP below</span><span className="text-emerald-300 font-bold">{Math.round(state.autoPot.threshold * 100)}%</span></div><input type="range" min={10} max={90} step={5} value={Math.round(state.autoPot.threshold * 100)} onChange={(e) => game.setAutoPot({ threshold: Number(e.target.value) / 100 })} className="w-full accent-emerald-400" /></div>
      {guideAutoBuy && <div className="mb-1 rounded-md border border-amber-400/60 bg-amber-950/60 px-2 py-1.5 text-[10px] font-bold text-amber-100">Step 2 · Turn on automatic potion purchases</div>}
      <label className={`flex items-center justify-between rounded-md px-1 py-1 text-sm font-vt ${guideAutoBuy ? 'auto-pot-guide' : ''}`}><span className="text-px-text">Auto-buy when empty</span><Toggle on={state.autoPot.autoBuy} onClick={() => game.setAutoPot({ autoBuy: !state.autoPot.autoBuy })} /></label>
      {state.autoPot.autoBuy && (
        <>
          <button onClick={() => game.setAutoPot({ autoSelectTier: !state.autoPot.autoSelectTier })} className={`my-2 w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${state.autoPot.autoSelectTier ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200' : 'border-white/10 text-slate-400'}`}>
            Smart buy ≥50% max HP {state.autoPot.autoSelectTier ? 'ON' : 'OFF'}
          </button>
          {!state.autoPot.autoSelectTier && <div className="py-1"><div className="text-sm font-vt text-px-text mb-1">Fixed buy tier</div><div className="grid grid-cols-3 gap-1">{POTIONS.map(p => <button key={p.tier} onClick={() => game.setAutoPot({ autoBuyTier: p.tier as PotionTier })} className={`px-1 py-1 text-xs font-vt font-bold border transition-none ${state.autoPot.autoBuyTier === p.tier ? 'border-px-green text-px-green bg-px-green/10' : 'border-px-border text-px-dim'}`}>{p.name.split(' ')[0]}</button>)}</div></div>}
        </>
      )}
      <div className="mt-1.5 pt-1.5 border-t-2 border-px-border grid grid-cols-3 gap-1 text-xs font-vt">{POTIONS.map(p => <div key={p.tier} className="text-center"><div className="text-px-dim">{p.name.split(' ')[0]}</div><div className="text-emerald-300 font-bold">{state.potions[p.tier]}</div></div>)}</div>
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`w-9 h-5 border-2 transition relative ${on ? 'border-px-green bg-px-green/40' : 'border-px-border bg-px-bg'}`}><div className={`absolute top-0.5 w-3 h-3 transition-all ${on ? 'left-4 bg-px-green' : 'left-0.5 bg-px-dim'}`} /></button>;
}
