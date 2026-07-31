import { useEffect, useState, useMemo, useRef } from 'react';
import { Package, FlaskConical, Zap, Lock as LockIcon, Star, X, Coins, CheckCircle2, Circle, ArrowUpDown, Wand2, ChevronLeft, ChevronRight, TrendingUp } from 'lucide-react';
import { Arena } from '@/components/Arena';
import { HeroPortrait } from '@/components/HeroPortrait';
import { ItemActionPanel } from '@/components/ItemActionPanel';
import { buildLocation, isOverpowered, locationUnlockLevel, locationLevelRange, LOCATION_RANGES } from '@/game/engine';
import { formatNum, accountXpForLevel } from '@/game/state';
import { ITEM_MAP, SLOT_LABEL, SLOT_ICON, POTIONS, sellValue } from '@/game/items';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, CLASS_LABEL } from '@/game/heroes';
import { useTokenomics } from '@/game/useTokenomics';
import type { GameApi } from '@/game/useGame';
import type { ItemSlot, OwnedItem, PotionTier } from '@/game/types';
import { itemArtSrc, itemArtStyle } from '@/game/art';

const SLOTS: ItemSlot[] = ['weapon', 'helmet', 'armor', 'gloves', 'boots', 'ring1', 'ring2', 'amulet'];
const GRID_SIZE = 64;

export function MainScreen({ game }: { game: GameApi }) {
  const { state, units, floaters, battleResult, potionFx, respawnCountdowns } = game;
  const [banner, setBanner] = useState<string | null>(null);
  const [showPotSettings, setShowPotSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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

  const selectedHero = selectedHeroUid ? state.ownedHeroes.find(h => h.uid === selectedHeroUid) : null;
  const selectedHeroBase = selectedHero ? HERO_MAP[selectedHero.heroId] : null;

  const equippedUids = new Set<string>();
  state.ownedHeroes.forEach(h => { for (const u of Object.values(h.equipped)) { if (u) equippedUids.add(u); } });
  const bagItems = state.inventory.filter(i => !equippedUids.has(i.uid));
  const visiblePotions = POTIONS.filter((p) => state.potions[p.tier] > 0);
  const cells: (OwnedItem | null)[] = Array.from({ length: Math.max(0, GRID_SIZE - visiblePotions.length) }).map((_, i) => bagItems[i] ?? null);
  const unlockedSellTotal = bagItems.filter(i => !i.locked).reduce((acc, i) => acc + sellValue(i), 0);

  const totalLocations = LOCATION_RANGES.length;

  useEffect(() => {
    const current = locationRailRef.current?.querySelector<HTMLElement>(`[data-location="${state.currentLocation}"]`);
    current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [state.currentLocation]);

  const scrollLocations = (direction: -1 | 1) => {
    locationRailRef.current?.scrollBy({ left: direction * 360, behavior: 'smooth' });
  };

  // Tokenomics hook — heartbeat power to server, fetch pool share
  const tok = useTokenomics(power, state.accountLevel, state.username, state.walletAddress || null);
  const earnPerHour = tok.status?.my_hourly_share ?? 0;
  const pendingWhole = useMemo(() => tok.status ? Math.floor(tok.status.pending_tokens) : 0, [tok.status]);

  const handleClaim = async () => {
    const claimed = await tok.claimTokens();
    if (claimed > 0) showToast(`+${formatNum(claimed)} $HERO claimed from pool!`);
    else showToast('Nothing to claim yet');
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── LEFT COLUMN ── */}
      <div className="hidden lg:flex w-64 xl:w-72 shrink-0 flex-col border-r border-px-border bg-px-panel/40 overflow-y-auto game-scrollbar">
        <div className="p-3 border-b-2 border-px-border">
          <div className="font-pixel text-[9px] text-px-bright mb-2">ACCOUNT</div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-11 h-11 bg-px-gold border-2 border-px-bright flex items-center justify-center font-pixel text-sm text-px-bg" style={{ boxShadow: '2px 2px 0 #3d2008' }}>{state.accountLevel}</div>
            <div className="flex-1">
              <div className="font-vt text-base font-bold text-px-bright">Level {state.accountLevel}</div>
              <div className="h-2 bg-px-bg border border-px-border overflow-hidden mt-0.5"><div className="h-full bg-px-gold" style={{ width: `${Math.min(100, (state.accountXp / accountXpForLevel(state.accountLevel)) * 100)}%` }} /></div>
              <div className="text-xs text-px-dim font-vt">{formatNum(state.accountXp)}/{formatNum(accountXpForLevel(state.accountLevel))}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-y-1 font-vt text-base">
            <span className="text-px-dim">Team Power</span><span className="text-px-bright font-bold text-right">⚡{formatNum(power)}</span>
            <span className="text-px-dim">Heroes</span><span className="text-px-text text-right">{state.ownedHeroes.length}</span>
            <span className="text-px-dim">Monsters Killed</span><span className="text-px-text text-right">{formatNum(state.totalKills)}</span>
            <span className="text-px-dim">Chests</span><span className="text-px-bright text-right">{state.chests.length}</span>
            <span className="text-px-dim">$HERO Total</span><span className="text-purple-300 text-right">{formatNum(state.totalTokensEarned)}</span>
          </div>
        </div>

        <div className="p-3 border-b-2 border-px-border">
          <div className="font-pixel text-[9px] text-px-bright mb-1.5">EARNINGS/HR</div>
          {earnPerHour > 0 ? (
            <>
              <div className="flex items-baseline gap-2 mb-1">
                <Zap size={18} className="text-purple-300" />
                <span className="text-purple-300 font-vt text-2xl font-bold">{formatNum(earnPerHour)}</span>
                <span className="text-px-dim text-sm font-vt">$HERO/hr</span>
              </div>
              <div className="text-xs text-px-dim font-vt">~${(earnPerHour * 0.01).toFixed(2)}/hr</div>
              <div className="mt-2 h-12 flex items-end gap-0.5">
                {Array.from({ length: 24 }).map((_, i) => {
                  const h = 20 + Math.sin(i * 0.5) * 15 + Math.random() * 10;
                  return <div key={i} className="flex-1 bg-purple-500/40" style={{ height: `${h}%` }} />;
                })}
              </div>
            </>
          ) : (
            <div className="text-sm text-px-dim font-vt leading-tight">Syncing your online pool share...</div>
          )}
        </div>

        {/* Tokenomics — pool share */}
        <div className="p-3 border-b-2 border-px-border">
          <div className="font-pixel text-[9px] text-px-bright mb-1.5 flex items-center gap-1"><TrendingUp size={12} /> TOKEN POOL</div>
          {tok.status ? (
            <>
              <div className="grid grid-cols-2 gap-y-1 font-vt text-sm mb-2">
                <span className="text-px-dim">Pool</span><span className="text-purple-300 font-bold text-right">{formatNum(Math.floor(tok.status.pool_amount))}</span>
                <span className="text-px-dim">Distributed</span><span className="text-px-dim text-right">{formatNum(Math.floor(tok.status.total_distributed))}</span>
                <span className="text-px-dim">All Power</span><span className="text-px-dim text-right">{formatNum(tok.status.total_power)}</span>
                <span className="text-px-dim">Your Share</span><span className="text-emerald-300 font-bold text-right">{formatNum(Math.floor(tok.status.my_hourly_share))}/hr</span>
              </div>
              <div className="px-panel p-2 border-2 border-purple-500/40">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-purple-300 font-vt text-sm font-bold">Pending</span>
                  <span className="text-purple-200 font-vt text-xl font-bold tabular-nums">{formatNum(pendingWhole)}</span>
                </div>
                <button onClick={handleClaim} disabled={pendingWhole === 0 || tok.loading} className="w-full py-1.5 px-btn text-sm font-bold disabled:opacity-40">
                  {tok.loading ? '...' : `Claim ${pendingWhole} $HERO`}
                </button>
              </div>
            </>
          ) : (
            <div className="text-xs text-px-dim font-vt">Connecting to pool...</div>
          )}
        </div>

        <div className="p-3 flex-1">
          <div className="font-pixel text-[9px] text-px-bright mb-2">DAILY QUESTS</div>
          <div className="space-y-2">
            {state.dailyQuests.map(q => {
              const done = q.progress >= q.target;
              return (
                <div key={q.id} className="px-panel p-2 border-2 border-px-border" style={{ boxShadow: '2px 2px 0 #2a1504' }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    {q.claimed ? <CheckCircle2 size={14} className="text-emerald-400" /> : done ? <Circle size={14} className="text-amber-400 fill-amber-400/30" /> : <Circle size={14} className="text-slate-600" />}
                    <span className="text-sm text-px-text font-vt flex-1">{q.label}</span>
                  </div>
                  <div className="h-2 bg-px-bg border border-px-border overflow-hidden mb-1"><div className="h-full bg-px-gold" style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-px-dim font-vt">{q.progress}/{q.target}</span>
                    <span className="text-px-text font-vt flex items-center gap-1"><Coins size={11} />{q.reward.gold} <Zap size={11} className="text-purple-300" />{q.reward.hero}</span>
                  </div>
                  {done && !q.claimed && <button onClick={() => game.claimQuest(q.id)} className="w-full mt-1 py-1 px-btn text-xs font-bold">Claim</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── CENTER COLUMN — responsive, max-width removed ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Chest button — visible at top of center column */}
        {state.chests.length > 0 && (
          <button onClick={game.openChests} className="mx-auto mt-2 flex items-center gap-2 px-4 py-2 px-btn anim-glow text-base font-bold z-30 self-center">
            <Package size={18} className="text-amber-300" /><span className="text-amber-200">OPEN {state.chests.length} CHEST{state.chests.length > 1 ? 'S' : ''}</span>
          </button>
        )}

        {/* Arena */}
        <div className="flex-1 relative overflow-hidden bg-arena min-h-0">
          <div className="absolute left-3 top-3 z-30">
            <button onClick={() => setShowPotSettings(s => !s)} className={`flex items-center gap-2 px-3 py-2 px-btn font-bold ${state.autoPot.enabled ? 'border-emerald-400/60 text-emerald-300' : ''}`}>
              <FlaskConical size={16} /> Pot-auto {state.autoPot.enabled ? 'ON' : 'OFF'}
            </button>
            {showPotSettings && <PotionSettings game={game} onClose={() => setShowPotSettings(false)} />}
          </div>
          {banner && (
            <div className="absolute inset-x-0 top-1/4 flex flex-col items-center z-30 pointer-events-none">
              <div className={`anim-banner font-pixel text-xl sm:text-2xl tracking-wider ${banner === 'VICTORY' ? 'text-px-bright' : 'text-px-red'}`} style={{ textShadow: banner === 'VICTORY' ? '0 0 20px #f5c518' : '0 0 20px #c02010' }}>{banner}</div>
              {battleResult && (
                <div className="anim-banner mt-2 flex flex-wrap items-center justify-center gap-2 font-vt text-sm bg-px-bg/80 px-3 py-1 border-2 border-px-border" style={{ boxShadow: '2px 2px 0 #2a1504' }}>
                  <span className="text-amber-300">+{formatNum(battleResult.gold)}g</span>
                  {battleResult.win && <span className="text-emerald-300">+{formatNum(battleResult.xp)} XP</span>}
                  {dropBase && <span style={{ color: RARITY_COLORS[dropBase.rarity] }} className="flex items-center gap-1"><Package size={11} /> {dropBase.name}</span>}
                  {battleResult.chest && <span className="text-amber-200 flex items-center gap-1">+1 chest</span>}
                </div>
              )}
            </div>
          )}
          {potionFx && <div key={potionFx.born} className="absolute inset-0 pointer-events-none anim-fade" style={{ background: 'radial-gradient(circle at 50% 70%, rgba(74,222,128,0.15), transparent 60%)' }} />}
          <Arena units={units} floaters={floaters} ownedHeroes={state.ownedHeroes} inventory={state.inventory} potionFx={potionFx} onHeal={game.healTeam} />
        </div>

        {/* Location cards — redesigned like screenshot 4 */}
        <div className="px-2 py-2 border-t-2 border-px-border bg-px-panel shrink-0">
          <div className="text-sm text-px-dim uppercase tracking-wider mb-1.5 flex items-center justify-between font-vt">
            <span className="text-px-text font-bold">LOCATIONS</span>
          </div>
          <div className="grid grid-cols-[42px_minmax(0,1fr)_42px] items-stretch gap-2">
            <button onClick={() => scrollLocations(-1)} className="px-btn grid place-items-center" aria-label="Previous locations"><ChevronLeft size={20} /></button>
            <div ref={locationRailRef} className="flex gap-2 overflow-x-auto game-scrollbar pb-2">
            {Array.from({ length: totalLocations }).map((_, i) => {
              const lid = i + 1;
              const l = buildLocation(lid, state.team.length);
              const current = lid === state.currentLocation;
              const op = isOverpowered(l, power);
              const unlockLv = locationUnlockLevel(lid);
              const locked = state.accountLevel < unlockLv;
              const notYetDiscovered = lid > state.highestLocation;
              const [rLo, rHi] = locationLevelRange(lid);
              return (
                <button
                  key={lid}
                  data-location={lid}
                  onClick={() => !locked && !notYetDiscovered && game.setLocation(lid)}
                  disabled={locked || notYetDiscovered}
                  className={`shrink-0 rounded-lg px-3 py-1.5 border text-left transition ${current ? 'bg-amber-300/10 border-px-bright shadow-[0_0_24px_rgba(217,173,91,.12)]' : notYetDiscovered ? 'bg-px-bg border-px-border opacity-40' : locked ? 'bg-px-bg border-px-border opacity-60' : op ? 'bg-px-bg/50 border-px-red/40' : 'bg-px-panel border-px-border hover:border-px-gold'} ${l.boss ? 'ring-1 ring-px-red/50' : ''}`}
                  style={{ minWidth: '144px' }}
                >
                  {/* Top row: number + boss + lock */}
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-base font-bold font-vt" style={{ color: notYetDiscovered ? '#5c3f08' : current ? '#f5c518' : '#f0d060' }}>
                      {lid}
                      {l.boss && <span className="text-px-red ml-1">BOSS</span>}
                    </span>
                    {(locked || notYetDiscovered) && <LockIcon size={12} className="text-px-dim" />}
                  </div>
                  {/* Name */}
                  <div className="text-xs truncate font-vt" style={{ color: notYetDiscovered ? '#5c3f08' : locked ? '#8a6428' : '#a07028' }}>{l.name}</div>
                  {/* Level, required power and gold */}
                  <div className="text-xs font-vt mt-0.5 font-bold" style={{ color: notYetDiscovered ? '#5c3f08' : locked ? '#8a6428' : '#c8840e' }}>
                    Lv {rLo}-{rHi} · Pwr {formatNum(l.requiredPower)}
                  </div>
                  <div className="text-xs flex items-center gap-1 mt-0.5 font-vt">
                    <span className="flex items-center gap-0.5" style={{ color: notYetDiscovered ? '#5c3f08' : '#c8840e' }}><Coins size={10} />{formatNum(l.goldReward)}</span>
                  </div>
                </button>
              );
            })}
            </div>
            <button onClick={() => scrollLocations(1)} className="px-btn grid place-items-center" aria-label="Next locations"><ChevronRight size={20} /></button>
          </div>
        </div>

      </div>

      {/* ── RIGHT COLUMN ── */}
      <div className="hidden lg:flex w-[420px] xl:w-[470px] shrink-0 flex-col border-l border-px-border bg-[#100d08] overflow-y-auto game-scrollbar">
        <div className="border-b border-px-border bg-gradient-to-r from-violet-500/[.07] to-transparent px-4 py-3 shrink-0">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[.16em] text-slate-500">Active formation</div>
          <div className="flex items-center gap-2">
            {state.team.map(uid => {
              const h = state.ownedHeroes.find(h => h.uid === uid); const b = h ? HERO_MAP[h.heroId] : null;
              if (!h || !b) return null;
              return <HeroPortrait key={uid} heroId={b.id} heroClass={b.heroClass} rarity={b.rarity} color={b.color} size={50} active={selectedHeroUid === uid} badge={h.level} respawn={respawnCountdowns[uid] ?? 0} onClick={() => setSelectedHeroUid(uid)} />;
            })}
            {Array.from({ length: 3 - state.team.length }).map((_, i) => <div key={i} className="w-11 h-11 rounded-xl border-2 border-dashed border-white/10 flex items-center justify-center"><Star size={13} className="text-slate-700" /></div>)}
          </div>
        </div>

        {selectedHero && selectedHeroBase ? (
          <div className="border-b border-px-border px-4 py-4 shrink-0">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-bold font-vt truncate" style={{ color: RARITY_COLORS[selectedHeroBase.rarity] }}>{selectedHeroBase.name}</span>
              <span className="text-xs text-px-dim font-vt">{RARITY_LABEL[selectedHeroBase.rarity]} {CLASS_LABEL[selectedHeroBase.heroClass]}</span>
            </div>
            <div className="grid grid-cols-8 gap-1">
              {SLOTS.map(slot => {
                const eqUid = selectedHero.equipped[slot];
                const item = eqUid ? state.inventory.find(i => i.uid === eqUid) : null;
                const ib = item ? ITEM_MAP[item.itemId] : null;
                const ic = ib ? RARITY_COLORS[ib.rarity] : undefined;
                return <div key={slot} className="min-w-0 text-center">
                  <button
                    onClick={() => { if (item) { setSelectedItem(item); setSelectedItemSource('hero'); setSelectedItemSlot(slot); } else setSelectedItem(null); }}
                    className={`group aspect-square w-full min-w-0 flex items-center justify-center overflow-hidden rounded-md text-lg border transition hover:-translate-y-0.5 relative ${ib ? `rarity-${ib.rarity}` : ''}`}
                    style={{ borderColor: ic ?? 'rgba(255,255,255,0.08)', background: ic ? `${ic}1a` : 'rgba(255,255,255,0.02)' }}
                    title={ib ? `${ib.name} +${item!.enchantLevel}` : `Empty ${SLOT_LABEL[slot]}`}
                  >
                    {ib ? (itemArtStyle(ib.id) ? <img src={itemArtSrc(ib.id)!} alt={ib.name} className="absolute max-w-none" style={itemArtStyle(ib.id)!} /> : <span className="text-2xl leading-none">{ib.icon}</span>) : <span className="text-xl opacity-30">{SLOT_ICON[slot]}</span>}
                    {ib && item!.enchantLevel > 0 && <div className="absolute top-0 left-0 text-[11px] font-bold text-amber-400 font-vt leading-none px-0.5">+{item!.enchantLevel}</div>}
                    {ib && <div className="absolute bottom-0 right-0 text-[12px] font-bold font-vt px-1 leading-tight" style={{ background: ic, color: '#000' }}>{item!.level}</div>}
                  </button>
                  <div className="mt-1 truncate text-[8px] uppercase text-px-dim font-vt">{SLOT_LABEL[slot]}</div>
                </div>;
              })}
            </div>
          </div>
        ) : <div className="px-3 py-3 text-center text-px-dim text-sm font-vt border-b-2 border-px-border shrink-0">Select a hero</div>}

        <div className="flex-1 overflow-y-auto game-scrollbar p-4 min-h-0">
          <div className="flex items-center justify-between mb-3 gap-2">
            <div><span className="font-pixel text-sm text-white">INVENTORY</span><span className="ml-2 text-xs text-slate-500">{bagItems.length}/{GRID_SIZE}</span></div>
            <div className="flex items-center gap-1">
              <button onClick={() => { game.sortInventory(); showToast('Sorted by rarity'); }} className="flex items-center gap-1 px-2 py-1 px-btn text-xs font-bold" title="Sort by rarity"><ArrowUpDown size={12} /> Sort</button>
              <button onClick={() => { game.autoEquipBest(); showToast('Best gear equipped'); }} className="flex items-center gap-1 px-2 py-1 px-btn text-xs font-bold" title="Auto-equip strongest gear"><Wand2 size={12} /> Auto</button>
            </div>
          </div>
          <button onClick={game.sellAllUnlocked} disabled={unlockedSellTotal === 0} className="w-full mb-3 py-2 px-btn text-sm font-bold flex items-center justify-center gap-1 disabled:opacity-40">
            <Coins size={14} /> Sell All Unlocked ({formatNum(unlockedSellTotal)}g)
          </button>
          <div className="grid grid-cols-8 gap-1.5">
            {visiblePotions.map((potion) => (
              <button key={potion.tier} className="aspect-square flex items-center justify-center overflow-hidden rounded-md border border-emerald-500/50 bg-emerald-950/20 relative" title={`${potion.name}: +${potion.hpRestore} HP`}>
                <img src={itemArtSrc(`potion-${potion.tier}`)!} alt={potion.name} className="absolute max-w-none" style={itemArtStyle(`potion-${potion.tier}`)!} />
                <span className="absolute bottom-0 right-0 min-w-4 bg-emerald-500 px-0.5 text-[11px] font-bold leading-4 text-black">{state.potions[potion.tier]}</span>
              </button>
            ))}
            {cells.map((item, i) => {
              const rarity = item ? ITEM_MAP[item.itemId]?.rarity ?? 'common' : null;
              const rc = rarity ? RARITY_COLORS[rarity] : null;
              return (
                <button
                  key={item ? item.uid : `e${i}`}
                  onClick={item ? () => { setSelectedItem(item); setSelectedItemSource('bag'); setSelectedItemSlot(null); } : undefined}
                  className={`aspect-square flex items-center justify-center overflow-hidden rounded-xl text-xl border transition hover:-translate-y-0.5 relative ${item && rarity ? `rarity-${rarity}` : ''} ${selectedItem?.uid === item?.uid ? 'ring-2 ring-amber-400' : ''}`}
                  style={item ? { borderColor: rc ?? 'rgba(255,255,255,0.06)', background: rc ? `${rc}1a` : 'rgba(255,255,255,0.02)' } : { borderColor: 'rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}
                >
                  {item && (itemArtStyle(item.itemId) ? <img src={itemArtSrc(item.itemId)!} alt={ITEM_MAP[item.itemId]?.name ?? ''} className="absolute max-w-none" style={itemArtStyle(item.itemId)!} /> : <span className="leading-none">{ITEM_MAP[item.itemId]?.icon}</span>)}
                  {item?.locked && <LockIcon size={11} className="absolute top-0.5 left-0.5 text-amber-300" />}
                  {item && item.enchantLevel > 0 && <div className="absolute top-0 left-0 text-[11px] font-bold text-amber-400 font-vt leading-none px-0.5">+{item.enchantLevel}</div>}
                  {item && <div className="absolute bottom-0 right-0 text-[13px] font-bold font-vt px-1 leading-tight" style={{ background: rc ?? '#666', color: '#000' }}>{item.level}</div>}
                </button>
              );
            })}
          </div>
        </div>

        {selectedItem && (
          <div className="border-t-2 border-px-border p-2 shrink-0 max-h-[45%] overflow-y-auto no-scrollbar">
            <ItemActionPanel
              item={selectedItem}
              game={game}
              equippedSlot={selectedItemSource === 'hero' ? selectedItemSlot : null}
              onEquip={selectedItemSource === 'bag' ? (slot) => { if (selectedHero) { game.equipItem(selectedHero.uid, selectedItem.uid, slot); setSelectedItem(null); } } : undefined}
              onUnequip={selectedItemSource === 'hero' && selectedItemSlot ? () => { if (selectedHero) { game.unequipItem(selectedHero.uid, selectedItemSlot); setSelectedItem(null); } } : undefined}
              onClose={() => setSelectedItem(null)}
            />
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-px-panel border-2 border-px-bright font-vt text-base font-bold text-px-bright anim-slide-up" style={{ boxShadow: '3px 3px 0 #3d2008' }}>{toast}</div>
      )}
    </div>
  );
}

function PotionSettings({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const { state } = game;
  return (
    <div className="absolute left-0 top-12 w-72 rounded-xl px-panel p-4 anim-slide-up z-40">
      <div className="flex items-center justify-between mb-2"><span className="text-sm font-bold text-px-text font-vt flex items-center gap-1.5"><FlaskConical size={14} className="text-emerald-400" /> Auto-Potions</span><button onClick={onClose} className="text-px-dim"><X size={14} /></button></div>
      <label className="flex items-center justify-between py-1 text-sm font-vt"><span className="text-px-text">Enable auto-use</span><Toggle on={state.autoPot.enabled} onClick={() => game.setAutoPot({ enabled: !state.autoPot.enabled })} /></label>
      <div className="py-1"><div className="flex items-center justify-between text-sm font-vt mb-1"><span className="text-px-text">Use at HP below</span><span className="text-emerald-300 font-bold">{Math.round(state.autoPot.threshold * 100)}%</span></div><input type="range" min={10} max={90} step={5} value={Math.round(state.autoPot.threshold * 100)} onChange={(e) => game.setAutoPot({ threshold: Number(e.target.value) / 100 })} className="w-full accent-emerald-400" /></div>
      <label className="flex items-center justify-between py-1 text-sm font-vt"><span className="text-px-text">Auto-buy when empty</span><Toggle on={state.autoPot.autoBuy} onClick={() => game.setAutoPot({ autoBuy: !state.autoPot.autoBuy })} /></label>
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
