import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Clock3, List, Lock, PackageSearch, Search, ShieldCheck, ShoppingCart, Swords, Shield, Gem, PawPrint, Users } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { SkrTokenIcon } from '@/components/SkrTokenIcon';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice, skrListingPriceCents, useSkrRate } from '@/game/skrPurchase';
import { formatMinor, useWalletSnapshot } from '@/game/seekerWallet';
import { ItemArtwork } from '@/components/ItemArtwork';
import { ItemCompareStats } from '@/components/ItemActionPanel';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { ITEM_MAP, STAT_LABEL, displayItemPower, formatStatValue, isMarketEligibleEquipment } from '@/game/items';
import { formatNum } from '@/game/state';
import type { OwnedHero, OwnedItem, Rarity } from '@/game/types';
import type { GameApi, ServerMarketListing, ServerMarketSnapshot } from '@/game/useGame';
import type { TokenomicsApi } from '@/game/useTokenomics';

type MarketTab = 'browse' | 'activity' | 'history' | 'supply' | 'listings' | 'sell';
type Category = 'all' | 'weapons' | 'armor' | 'accessories' | 'heroes' | 'pets';
type LevelFilter = 'all' | 'my' | 'usable' | 'upgrades' | 'endgame';
type Listing = { id: string; kind: 'item' | 'hero'; sourceId: string; name: string; rarity: Rarity; level: number; enchantLevel: number; power: number; price: number; seller: string; createdAt: number; stats: string[]; owned?: OwnedItem | OwnedHero };

const TABS: { id: MarketTab; label: string }[] = [
  { id: 'browse', label: 'Browse' }, { id: 'activity', label: 'Activity' }, { id: 'history', label: 'History' },
  { id: 'sell', label: 'Sell' }, { id: 'listings', label: 'My Listings' }, { id: 'supply', label: 'Supply' },
];

function ownedRows(game: GameApi): Listing[] {
  const equipped = new Set(game.state.ownedHeroes.flatMap((hero) => Object.values(hero.equipped)).filter(Boolean));
  return game.state.inventory.flatMap((item) => {
    const base = ITEM_MAP[item.itemId];
    // Sell lists only free equipment: nothing equipped or locked (Founder 2026-10-03).
    if (!base || !item.serverOwned || !isMarketEligibleEquipment(base) || item.locked || equipped.has(item.uid)) return [];
    return [{ id: item.uid, kind: 'item' as const, sourceId: item.itemId, name: base.name, rarity: base.rarity, level: item.level, enchantLevel: item.enchantLevel, power: displayItemPower(item), price: 0, seller: item.locked ? 'Locked' : equipped.has(item.uid) ? 'Equipped' : 'Ready', createdAt: 0, stats: item.stats.map((stat) => `${STAT_LABEL[stat.key]} ${formatStatValue(stat)}`), owned: item }];
  });
}

function listingFromServer(entry: ServerMarketListing): Listing | null {
  const base = ITEM_MAP[entry.item.itemId];
  if (!base) return null;
  return { id: entry.id, kind: 'item', sourceId: entry.item.itemId, name: base.name, rarity: base.rarity, level: entry.item.level, enchantLevel: entry.item.enchantLevel, power: displayItemPower(entry.item), price: entry.price, seller: entry.is_own ? 'You' : entry.seller, createdAt: Date.parse(entry.created_at), stats: entry.item.stats.map((stat) => `${STAT_LABEL[stat.key]} ${formatStatValue(stat)}`), owned: entry.item };
}

export function SeekerMarketScreen({ game, tokenomics }: { game: GameApi; tokenomics: TokenomicsApi }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const rate = useSkrRate();
  const wallet = useWalletSnapshot();
  const [tab, setTab] = useState<MarketTab>('browse'); const [query, setQuery] = useState(''); const [selectedId, setSelectedId] = useState<string | null>(null); const [price, setPrice] = useState(''); const [notice, setNotice] = useState('');
  const [market, setMarket] = useState<ServerMarketSnapshot | null>(null); const [marketBusy, setMarketBusy] = useState(false);
  const [category, setCategory] = useState<Category>('all'); const [rarity, setRarity] = useState<Rarity | 'all'>('all'); const [enchant, setEnchant] = useState(0); const [levelFilter, setLevelFilter] = useState<LevelFilter>('all'); const [comparisonHeroUid, setComparisonHeroUid] = useState(game.state.team[0] ?? game.state.ownedHeroes[0]?.uid ?? '');
  const fetchSupply = tokenomics.fetchStatus;
  useEffect(() => { if (tab !== 'supply') return; void fetchSupply(); const timer = window.setInterval(() => void fetchSupply(), 60_000); return () => window.clearInterval(timer); }, [tab, fetchSupply]);
  const loadMarket = game.loadMarket;
  useEffect(() => { let active = true; const load = async () => { const next = await loadMarket(); if (!active) return; if (next) { setMarket(next); setNotice(previous => previous === 'Market is unavailable. Try again shortly.' ? '' : previous); } else setNotice('Market is unavailable. Try again shortly.'); }; void load(); const timer = window.setInterval(() => void load(), 15_000); return () => { active = false; window.clearInterval(timer); }; }, [loadMarket]);
  const serverListings = market?.listings ?? [];
  const browse = serverListings.map(listingFromServer).filter((row): row is Listing => Boolean(row));
  const mine = serverListings.filter((entry) => entry.is_own).map(listingFromServer).filter((row): row is Listing => Boolean(row));
  const sellable = ownedRows(game);
  const comparisonHero = game.state.ownedHeroes.find((hero) => hero.uid === comparisonHeroUid) ?? game.state.ownedHeroes[0];
  const comparisonLevel = comparisonHero?.level ?? 1;
  const heroRarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
  const allRarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'];
  const matchesCategory = (row: Listing) => { if (category === 'all') return true; if (category === 'heroes') return row.kind === 'hero'; if (category === 'pets') return false; if (row.kind !== 'item') return false; const item = ITEM_MAP[row.sourceId]; const slot = item?.slot; const isShield = slot === 'offhand' && item?.heroClass === 'knight'; if (category === 'weapons') return !isShield && ['class_weapon', 'offhand', 'weapon', 'ring2'].includes(slot ?? ''); if (category === 'armor') return isShield || ['helmet', 'chest', 'gloves', 'boots', 'armor'].includes(slot ?? ''); return ['ring', 'amulet', 'ring1'].includes(slot ?? ''); };
  const rows = (tab === 'browse' ? browse : tab === 'listings' ? mine : tab === 'sell' ? sellable : []).filter((row) => {
    if (query && !row.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (!matchesCategory(row) || (rarity !== 'all' && row.rarity !== rarity)) return false;
    if (row.kind === 'item' && row.enchantLevel < enchant) return false;
    if (row.kind === 'item' && levelFilter === 'my' && Math.abs(row.level - comparisonLevel) > 3) return false;
    if (row.kind === 'item' && levelFilter === 'usable' && row.level > comparisonLevel) return false;
    if (row.kind === 'item' && levelFilter === 'upgrades' && row.level <= comparisonLevel) return false;
    if (row.kind === 'item' && levelFilter === 'endgame' && row.level < 80) return false;
    return true;
  });
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId || !window.matchMedia('(max-width: 1023px)').matches) return;
    screenRef.current?.scrollTo({ top: 0 });
    detailRef.current?.focus({ preventScroll: true });
  }, [selectedId]);
  const flash = (value: string) => { setNotice(value); window.setTimeout(() => setNotice(''), 2400); };
  const refreshMarket = async () => { const next = await loadMarket(); if (next) setMarket(next); };
  const cents = skrListingPriceCents(price, rate);
  const validPrice = cents >= 1;
  const delivered = (result: Record<string, unknown>) => { game.applySeekerPurchase(result); void refreshMarket(); };
  const cancel = async (row: Listing) => {
    if (marketBusy) return;
    setMarketBusy(true);
    try {
      const result = await game.cancelMarketListing(row.id);
      flash(result.ok ? `${row.name} returned to ${result.mailed ? 'your Mailbox' : 'inventory'}` : marketError(result.error));
      await refreshMarket();
    } catch { flash('Cancellation failed. Refresh and try again.'); }
    finally { setMarketBusy(false); }
  };
  return <div ref={screenRef} data-detail={Boolean(selected)} className="seeker-market premium-screen themed-screen themed-screen-market game-scrollbar h-full overflow-y-auto p-2"><div className="market-shell mx-auto flex min-h-full max-w-6xl flex-col overflow-hidden"><header className="market-header flex items-center justify-between gap-2 py-2 pl-3 pr-14"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg border border-[#a8762d] bg-black/25 text-[#efbd52]"><ShoppingCart size={20} /></span><div><div className="text-lg font-black text-[#f1e5d0]">MARKET</div><div className="text-[9px] text-[#92897b]">20 listings per seller</div></div></div><Balance icon={<SkrTokenIcon size={16} />} value={wallet ? `${formatMinor(wallet.balances.SKR, 'SKR', 6)} SKR` : '— SKR'} label="In-game balance" /></header>
  <p className="market-fee-copy px-3 py-1 text-[10px] leading-tight text-stone-300">Listing fee: {skrPrice(2, rate)}<SkrUsd cents={2} />. Non-refundable after listing, including cancellation. Sale fee: 10%; the seller receives 90% in SKR. Purchases arrive in Mailbox. The final SKR amount is shown before confirmation.</p>
  <nav aria-label="Market sections" className="market-tabs flex gap-1 overflow-x-auto px-4 pt-2">{TABS.map((item) => <button key={item.id} type="button" style={{ minHeight: 44 }} aria-pressed={tab === item.id} onClick={() => { setTab(item.id); setSelectedId(null); setPrice(''); }} className={`market-tab min-h-11 whitespace-nowrap ${tab === item.id ? 'market-tab-active' : ''}`}>{item.label}</button>)}</nav>
  {notice && <div className="mx-4 mt-2 rounded border border-emerald-700/50 bg-emerald-950/45 px-3 py-2 text-center text-xs text-emerald-200">{notice}</div>}
  {(tab === 'browse' || tab === 'sell' || tab === 'listings') && <><section className="market-filter-panel border-y border-[#44331d] bg-black/15 px-4 py-2"><div className="market-categories flex gap-1 overflow-x-auto">{([{ id: 'all', label: 'All', icon: <List size={11} /> }, { id: 'weapons', label: 'Weapons', icon: <Swords size={11} /> }, { id: 'armor', label: 'Armor', icon: <Shield size={11} /> }, { id: 'accessories', label: 'Accessories', icon: <Gem size={11} /> }, { id: 'heroes', label: 'Heroes', icon: <Users size={11} /> }] as { id: Category; label: string; icon: ReactNode }[]).map((item) => <button type="button" style={{ minHeight: 44 }} key={item.id} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setRarity('all'); }} className={`market-chip min-h-11 flex items-center gap-1 ${category === item.id ? 'market-chip-active' : ''}`}>{item.icon}{item.label}</button>)}<button type="button" style={{ minHeight: 44 }} disabled className="market-chip min-h-11 flex items-center gap-1 opacity-40"><PawPrint size={11} />Pets · Soon</button></div><div className="market-filters mt-2 grid gap-1.5 md:grid-cols-[minmax(150px,1fr)_130px_110px_130px_150px]"><label className="relative"><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#756b5c]" /><input style={{ minHeight: 44 }} aria-label="Search items" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." className="market-input min-h-11 w-full pl-8 pr-3" /></label><select style={{ minHeight: 44 }} aria-label="Rarity" value={rarity} onChange={(event) => setRarity(event.target.value as Rarity | 'all')} className="market-input min-h-11 px-2"><option value="all">All Rarities</option>{(category === 'heroes' ? heroRarities : allRarities).map((value) => <option key={value} value={value}>{RARITY_LABEL[value]}</option>)}</select><select style={{ minHeight: 44 }} aria-label="Minimum enchant" value={enchant} onChange={(event) => setEnchant(Number(event.target.value))} disabled={category === 'heroes'} className="market-input min-h-11 px-2 disabled:opacity-40"><option value={0}>Any +Level</option><option value={3}>+3 or more</option><option value={5}>+5 or more</option><option value={7}>+7 or more</option><option value={10}>+10 only</option></select><select style={{ minHeight: 44 }} aria-label="Item level" value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as LevelFilter)} disabled={category === 'heroes'} className="market-input min-h-11 px-2 disabled:opacity-40"><option value="all">All Levels</option><option value="my">My Level ±3</option><option value="usable">Usable Now</option><option value="upgrades">Upgrades</option><option value="endgame">Endgame 80+</option></select>{category !== 'heroes' ? <select style={{ minHeight: 44 }} aria-label="Comparison hero" value={comparisonHeroUid} onChange={(event) => setComparisonHeroUid(event.target.value)} className="market-input min-h-11 px-2"><option value="" disabled>Compare hero</option>{game.state.ownedHeroes.map((hero) => <option key={hero.uid} value={hero.uid}>{HERO_MAP[hero.heroId]?.name ?? 'Hero'} · Lv {hero.level}</option>)}</select> : <div className="market-input grid min-h-11 place-items-center text-[9px] text-[#777064]">Hero filters need no comparison</div>}</div></section><main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]"><section className="market-rows space-y-1.5 border-r border-[#44331d] p-3">{rows.map((row) => <Row key={row.id} row={row} rate={rate} selling={tab === 'sell'} active={selected?.id === row.id} onClick={() => { setSelectedId(row.id); setPrice(''); }} />)}{rows.length === 0 && <Empty text={tab === 'listings' ? 'You have no active listings' : tab === 'sell' ? 'No eligible equipment matches these filters' : 'Nothing available'} />}</section><aside ref={detailRef} tabIndex={-1} aria-label="Selected market item" className="market-selected-detail bg-black/15 p-3">{selected && <button type="button" onClick={() => setSelectedId(null)} className="game-control mb-3 min-h-11 w-full lg:hidden">Back to items</button>}{selected ? <Detail row={selected}>{tab === 'browse' ? selected.seller === 'You' ? <p className="mt-3 text-center text-xs text-stone-400">Your listing</p> : <><SkrPurchaseButton key={selected.id} product="market_buy_listing" params={{ listing_id: selected.id }} label={<>Buy · {skrPrice(selected.price, rate)}<SkrUsd cents={selected.price} /></>} onDelivered={delivered} />{selected.kind === 'item' && selected.owned && comparisonHero && ITEM_MAP[selected.sourceId] && <div className="market-compare mt-3"><p className="mb-1 text-[10px] font-bold uppercase text-[#8d816f]">Compared with {HERO_MAP[comparisonHero.heroId]?.name ?? 'hero'}</p><ItemCompareStats item={selected.owned as OwnedItem} comparisonItem={game.state.inventory.find((item) => item.uid === comparisonHero.equipped[ITEM_MAP[selected.sourceId].slot]) ?? null} /></div>}</> : tab === 'sell' ? <div className="mt-3"><p role="status" className="mb-2 text-xs text-amber-200">{selected.seller === 'Locked' ? 'Unlock this item in Inventory before selling.' : selected.seller === 'Equipped' ? 'Unequip this item before selling.' : 'Set a sale price, then check and confirm the listing fee.'}</p><label className="block text-xs text-stone-300">Sale price in SKR<input style={{ minHeight: 44 }} aria-label="Sale price in SKR" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="market-input mt-2 min-h-11 w-full px-2" /></label><p className="mt-2 text-xs text-amber-200">{validPrice ? <>{skrPrice(cents, rate)}<SkrUsd cents={cents} /></> : 'Enter a SKR price'}</p><p className="mt-2 text-[10px] text-stone-400">Price uses the current rate and is rounded to the server price step. Seller receives 90% in SKR.</p><SkrPurchaseButton key={selected.id} product="market_list_item" params={{ item_id: selected.id, price: cents }} label={selected.seller === 'Ready' ? <>List · {skrPrice(2, rate)}<SkrUsd cents={2} /> fee</> : selected.seller} disabled={!validPrice || selected.seller !== 'Ready'} onDelivered={delivered} /></div> : <button type="button" style={{ minHeight: 44 }} onClick={() => cancel(selected)} disabled={marketBusy} className="game-control mt-3 w-full text-xs font-bold disabled:opacity-35">Cancel</button>}</Detail> : <Empty text="Select an asset" />}</aside></main></>}
  {tab === 'activity' && <Records title="Latest 100 market sales" rate={rate} rows={(market?.activity ?? []).map(marketHistoryRow)} />}
  {tab === 'history' && <Records title="Your purchases and sales" rate={rate} rows={(market?.history ?? []).map(marketHistoryRow)} />}
  {tab === 'supply' && <section className="market-supply p-2"><div className="mb-2 flex items-center justify-between"><div><div className="section-kicker">Equipment supply by rarity</div><div className="text-[9px] text-[#81796c]">Global limits · refreshed every minute</div></div><Clock3 size={15} className="text-[#c3974e]" /></div><div className="market-supply-grid grid grid-cols-2 gap-2 lg:grid-cols-4">{allRarities.map((key) => {
    const limits: Partial<Record<Rarity, number>> = { divine: 10_000, celestial: 5_000, cursed: 2_500, immortal: 1_000, god: 500 };
    const limited = key in limits;
    const supply = limited ? tokenomics.status?.rarity_supply?.[key as 'divine' | 'celestial' | 'cursed' | 'immortal' | 'god'] : undefined;
    return <div key={key} className={`market-supply-tile stat-tile rarity-${key} p-2`} style={{ borderColor: RARITY_COLORS[key] }}><div className={`rarity-title rarity-${key} text-xs font-black`} style={{ color: RARITY_COLORS[key] }}>{RARITY_LABEL[key]}</div><div className="mt-1 text-sm font-black" style={{ color: RARITY_COLORS[key] }}>{limited ? `${supply ? formatNum(supply.existing) : '—'} / ${formatNum(supply?.max ?? limits[key] ?? 0)}` : 'No global limit'}</div><p className="col-span-full text-[10px] text-stone-400">{limited ? 'Existing / maximum' : 'Uncapped rarity'} · {['cursed', 'immortal', 'god'].includes(key) ? 'Crafting only' : 'Level-gated drops'}</p></div>;
  })}</div></section>}
  <footer className="mt-auto flex items-center gap-2 border-t border-[#44331d] px-4 py-2 text-[9px] text-[#81786b]"><ShieldCheck size={12} /> Server escrow · buyer pays in SKR · seller receives 90% · purchases arrive in Mailbox.</footer></div></div>;
}

function Row({ row, active, onClick, rate, selling }: { row: Listing; active: boolean; onClick: () => void; rate: string | null; selling: boolean }) { return <button type="button" onClick={onClick} className={`market-row rarity-${row.rarity} flex w-full text-left ${active ? 'market-row-selected' : ''}`}><Artwork row={row} compact /><span className="min-w-0 flex-1"><b className={`rarity-title rarity-${row.rarity} block truncate text-xs`} style={{ color: RARITY_COLORS[row.rarity] }}>{row.name}{row.kind === 'item' && row.enchantLevel > 0 ? ` +${row.enchantLevel}` : ''}</b><span className="text-[9px] text-[#8d8374]">{RARITY_LABEL[row.rarity]} · Lv {row.level} · {formatNum(row.power)} PWR · {row.seller}</span></span>{row.seller === 'Locked' || row.seller === 'Equipped' || row.seller === 'Active team' ? <Lock size={13} className="text-amber-300" /> : <span className="min-w-0 break-words text-[10px] font-black text-[#efff9f]">{selling ? 'Set sale price' : <>{skrPrice(row.price, rate)}<SkrUsd cents={row.price} /></>}</span>}</button>; }
function Detail({ row, children }: { row: Listing; children: ReactNode }) { const item = row.kind === 'item' ? ITEM_MAP[row.sourceId] : null; const hero = row.kind === 'hero' ? HERO_MAP[row.sourceId] : null; return <div><h3 className={`rarity-title rarity-${row.rarity} text-center text-lg font-black`} style={{ color: RARITY_COLORS[row.rarity] }}>{row.name}</h3>{children}<div className={`market-detail-art rarity-${row.rarity} mx-auto mt-3`} style={{ borderColor: RARITY_COLORS[row.rarity] }}><Artwork row={row} /></div><div className="stat-tile mt-3 space-y-1 p-3 text-[10px]"><div className="flex justify-between"><span className="text-[#81796c]">Owner</span><b>{row.seller}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Type</span><b>{item?.slot.replace('_', ' ') ?? hero?.heroClass ?? row.kind}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Rarity</span><b style={{ color: RARITY_COLORS[row.rarity] }}>{RARITY_LABEL[row.rarity]}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Level / Upgrade</span><b>{row.level} / +{row.enchantLevel}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Power</span><b>{formatNum(row.power)}</b></div><div className="mt-2 border-t border-[#473a28] pt-2 text-[9px] font-bold uppercase text-[#8d816f]">All properties</div>{row.stats.map((stat, index) => <div key={`${stat}-${index}`} className="text-[#c4b8a6]">• {stat}</div>)}</div></div>; }
function Artwork({ row, compact = false }: { row: Listing; compact?: boolean }) { const cls = compact ? 'h-11 w-11' : 'h-36 w-36'; if (row.kind === 'hero') { const hero = HERO_MAP[row.sourceId]; return hero ? <span className={`${cls} grid shrink-0 place-items-center overflow-hidden rounded-lg`}><HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={compact ? 42 : 136} /></span> : null; } const item = ITEM_MAP[row.sourceId]; return item ? <span className={`${cls} block shrink-0 overflow-hidden rounded-lg bg-black/25`}><ItemArtwork itemId={item.id} name={item.name} fallback={item.icon} /></span> : null; }
function Records({ title, rows, rate }: { title: string; rate: string | null; rows: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold'; rarity?: Rarity }[] }) { return <section className="p-4"><h3 className="mb-3 text-sm font-black text-[#e8dcc8]">{title}</h3><div className="space-y-1.5">{rows.map((row) => <div key={row.id} className="market-record flex flex-wrap items-center gap-2 rounded border border-[#44331d] p-3"><Clock3 size={13} className="text-[#8c806e]" /><span className={`rarity-title rarity-${row.rarity ?? 'common'} ml-2 flex-1 text-xs`} style={{ color: row.rarity ? RARITY_COLORS[row.rarity] : undefined }}>{row.name}</span><span className="text-[9px] uppercase text-[#8d8374]">{row.action}</span><time className="text-[10px] text-stone-400" dateTime={new Date(row.createdAt).toISOString()}>{new Date(row.createdAt).toLocaleString()}</time><span className="min-w-0 break-words text-xs font-black text-[#efff9f]">{skrPrice(row.price, rate)}<SkrUsd cents={row.price} /><small className="block font-normal text-stone-400">At current rate</small></span></div>)}{rows.length === 0 && <Empty text="No records yet" />}</div></section>; }
function Empty({ text }: { text: string }) { return <div className="market-empty"><PackageSearch size={23} /><b>{text}</b></div>; }
function Balance({ icon, value, label }: { icon: ReactNode; value: string; label: string }) { return <span className="stat-tile flex min-w-0 max-w-full items-center gap-2 px-3 py-1.5 text-[#e7b858]">{icon}<span className="min-w-0"><small className="block text-[7px] uppercase text-[#7f7669]">{label}</small><b className="block break-words text-xs text-[#eee3d2]">{value}</b></span></span>; }

function marketError(code?: string): string {
  const messages: Record<string, string> = {
    insufficient_tokens: 'Not enough in-game SKR',
    account_restricted: 'Market is paused during an account check',
    market_listing_unavailable: 'Listing is no longer available',
    market_seller_limit_reached: 'You reached the 20 active listings limit',
    market_test_item_required: 'Only eligible server-owned equipment can be listed',
    market_self_purchase: 'You cannot buy your own listing',
    item_locked: 'Unlock this item first',
    item_equipped: 'Unequip this item first',
    item_capacity_exceeded: 'Inventory is full',
  };
  return messages[code ?? ''] ?? 'Market action failed';
}

function marketHistoryRow(row: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold' }) {
  return { ...row, rarity: ITEM_MAP[row.name]?.rarity, name: ITEM_MAP[row.name] ? `${ITEM_MAP[row.name].name} · ${RARITY_LABEL[ITEM_MAP[row.name].rarity]}` : row.name };
}
