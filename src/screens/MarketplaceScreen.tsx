import { isolatedHackathon } from '@/game/editionStorage';
import { SeekerMarketScreen } from './SeekerCommerceScreens';
import { useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Clock3, Coins, List, Lock, PackageSearch, Search, ShieldCheck, ShoppingCart, Swords, Shield, Gem, PawPrint, Users } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { ItemArtwork } from '@/components/ItemArtwork';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { ITEM_MAP, displayItemPower, formatStatValue, isMarketEligibleEquipment, sellValue } from '@/game/items';
import { formatNum } from '@/game/state';
import type { OwnedHero, OwnedItem, Rarity } from '@/game/types';
import type { GameApi, ServerMarketListing, ServerMarketSnapshot } from '@/game/useGame';
import type { TokenomicsApi } from '@/game/useTokenomics';

type MarketTab = 'browse' | 'activity' | 'history' | 'stats' | 'supply' | 'listings' | 'sell';
type Category = 'all' | 'weapons' | 'armor' | 'accessories' | 'heroes' | 'pets';
type LevelFilter = 'all' | 'my' | 'usable' | 'upgrades' | 'endgame';
type Listing = { id: string; kind: 'item' | 'hero'; sourceId: string; name: string; rarity: Rarity; level: number; enchantLevel: number; power: number; price: number; seller: string; createdAt: number; stats: string[]; owned?: OwnedItem | OwnedHero };

const TABS: { id: MarketTab; label: string }[] = [
  { id: 'browse', label: 'Browse' }, { id: 'activity', label: 'Activity' }, { id: 'history', label: 'History' },
  { id: 'stats', label: 'Stats' }, { id: 'supply', label: 'Supply' }, { id: 'listings', label: 'My Listings' }, { id: 'sell', label: 'Sell' },
];

function ownedRows(game: GameApi): Listing[] {
  const equipped = new Set(game.state.ownedHeroes.flatMap((hero) => Object.values(hero.equipped)).filter(Boolean));
  return game.state.inventory.flatMap((item) => {
    const base = ITEM_MAP[item.itemId];
    if (!base || !item.serverOwned || !isMarketEligibleEquipment(base)) return [];
    return [{ id: item.uid, kind: 'item' as const, sourceId: item.itemId, name: base.name, rarity: base.rarity, level: item.level, enchantLevel: item.enchantLevel, power: displayItemPower(item), price: Math.max(1, sellValue(item) * 2), seller: item.locked ? 'Locked' : equipped.has(item.uid) ? 'Equipped' : 'Ready', createdAt: 0, stats: item.stats.map(formatStatValue), owned: item }];
  });
}

function listingFromServer(entry: ServerMarketListing): Listing | null {
  const base = ITEM_MAP[entry.item.itemId];
  if (!base) return null;
  return { id: entry.id, kind: 'item', sourceId: entry.item.itemId, name: base.name, rarity: base.rarity, level: entry.item.level, enchantLevel: entry.item.enchantLevel, power: displayItemPower(entry.item), price: entry.price, seller: entry.is_own ? 'You' : entry.seller, createdAt: Date.parse(entry.created_at), stats: entry.item.stats.map(formatStatValue), owned: entry.item };
}

export function MarketplaceScreen(props: { game: GameApi; tokenomics: TokenomicsApi }) {
  return isolatedHackathon ? <SeekerMarketScreen game={props.game}/> : <StandardMarketplaceScreen {...props}/>;
}
function StandardMarketplaceScreen({ game, tokenomics }: { game: GameApi; tokenomics: TokenomicsApi }) {
  const [tab, setTab] = useState<MarketTab>('browse'); const [query, setQuery] = useState(''); const [selectedId, setSelectedId] = useState<string | null>(null); const [price, setPrice] = useState(10); const [notice, setNotice] = useState('');
  const [market, setMarket] = useState<ServerMarketSnapshot | null>(null); const [marketBusy, setMarketBusy] = useState(false);
  const [category, setCategory] = useState<Category>('all'); const [rarity, setRarity] = useState<Rarity | 'all'>('all'); const [enchant, setEnchant] = useState(0); const [levelFilter, setLevelFilter] = useState<LevelFilter>('all'); const [comparisonHeroUid, setComparisonHeroUid] = useState(game.state.team[0] ?? game.state.ownedHeroes[0]?.uid ?? '');
  const fetchSupply = tokenomics.fetchStatus;
  useEffect(() => { if (tab !== 'supply') return; void fetchSupply(); const timer = window.setInterval(() => void fetchSupply(), 60_000); return () => window.clearInterval(timer); }, [tab, fetchSupply]);
  const loadMarket = game.loadMarket;
  useEffect(() => { let active = true; const load = async () => { const next = await loadMarket(); if (active && next) setMarket(next); }; void load(); const timer = window.setInterval(() => void load(), 15_000); return () => { active = false; window.clearInterval(timer); }; }, [loadMarket]);
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
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const flash = (value: string) => { setNotice(value); window.setTimeout(() => setNotice(''), 2400); };
  const refreshMarket = async () => { const next = await loadMarket(); if (next) setMarket(next); };
  const buy = async (row: Listing) => { if (marketBusy) return; setMarketBusy(true); const result = await game.buyMarketAsset(row.id); flash(result.ok ? `Purchased ${row.name}. It is waiting in your Mailbox` : marketError(result.error)); await refreshMarket(); setMarketBusy(false); };
  const list = async (row: Listing) => { if (marketBusy) return; setMarketBusy(true); const result = await game.createMarketListing(row.id, price); flash(result.ok ? `${row.name} listed for ${price} $HERO` : marketError(result.error)); await refreshMarket(); setMarketBusy(false); };
  const cancel = async (row: Listing) => { if (marketBusy) return; setMarketBusy(true); const result = await game.cancelMarketListing(row.id); flash(result.ok ? `${row.name} returned to ${result.mailed ? 'your Mailbox' : 'inventory'}` : marketError(result.error)); await refreshMarket(); setMarketBusy(false); };
  const ownListingCount = serverListings.filter((entry) => entry.is_own).length;
  return <div className="premium-screen themed-screen themed-screen-market game-scrollbar h-full overflow-y-auto p-2"><div className="market-shell mx-auto flex min-h-full max-w-6xl flex-col overflow-hidden"><header className="market-header flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg border border-[#a8762d] bg-black/25 text-[#efbd52]"><ShoppingCart size={20} /></span><div><div className="text-lg font-black text-[#f1e5d0]">Marketplace</div><div className="text-[9px] text-[#92897b]">Server settlement · 20 listings per seller · 5% seller fee</div></div></div><div className="flex gap-2"><Balance icon={<Coins size={13} />} value={formatNum(market?.pool_fee_total ?? 0)} label="Test daily pool" /><Balance icon={<HeroTokenIcon size={13} />} value={formatNum(game.state.hero)} label="$HERO" /></div></header>
  <nav className="market-tabs flex gap-1 overflow-x-auto px-4 pt-2">{TABS.map((item) => <button key={item.id} type="button" onClick={() => { setTab(item.id); setSelectedId(null); }} className={`market-tab whitespace-nowrap ${tab === item.id ? 'market-tab-active' : ''}`}>{item.label}</button>)}</nav>
  {notice && <div className="mx-4 mt-2 rounded border border-emerald-700/50 bg-emerald-950/45 px-3 py-2 text-center text-xs text-emerald-200">{notice}</div>}
  {(tab === 'browse' || tab === 'sell' || tab === 'listings') && <><section className="border-y border-[#44331d] bg-black/15 px-4 py-2"><div className="flex flex-wrap gap-1.5">{([{ id: 'all', label: 'All', icon: <List size={11} /> }, { id: 'weapons', label: 'Weapons', icon: <Swords size={11} /> }, { id: 'armor', label: 'Armor', icon: <Shield size={11} /> }, { id: 'accessories', label: 'Accessories', icon: <Gem size={11} /> }, { id: 'heroes', label: 'Heroes', icon: <Users size={11} /> }] as { id: Category; label: string; icon: ReactNode }[]).map((item) => <button type="button" key={item.id} onClick={() => { setCategory(item.id); setRarity('all'); }} className={`market-chip flex items-center gap-1 ${category === item.id ? 'market-chip-active' : ''}`}>{item.icon}{item.label}</button>)}<button type="button" disabled className="market-chip flex items-center gap-1 opacity-40"><PawPrint size={11} />Pets · Soon</button></div><div className="market-filters mt-2 grid gap-1.5 md:grid-cols-[minmax(150px,1fr)_130px_110px_130px_150px]"><label className="relative"><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#756b5c]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." className="market-input h-9 w-full pl-8 pr-3" /></label><select value={rarity} onChange={(event) => setRarity(event.target.value as Rarity | 'all')} className="market-input h-9 px-2"><option value="all">All Rarities</option>{(category === 'heroes' ? heroRarities : allRarities).map((value) => <option key={value} value={value}>{RARITY_LABEL[value]}</option>)}</select><select value={enchant} onChange={(event) => setEnchant(Number(event.target.value))} disabled={category === 'heroes'} className="market-input h-9 px-2 disabled:opacity-40"><option value={0}>Any +Level</option><option value={3}>+3 or more</option><option value={5}>+5 or more</option><option value={7}>+7 or more</option><option value={10}>+10 only</option></select><select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as LevelFilter)} disabled={category === 'heroes'} className="market-input h-9 px-2 disabled:opacity-40"><option value="all">All Levels</option><option value="my">My Level ±3</option><option value="usable">Usable Now</option><option value="upgrades">Upgrades</option><option value="endgame">Endgame 80+</option></select>{category !== 'heroes' ? <select value={comparisonHeroUid} onChange={(event) => setComparisonHeroUid(event.target.value)} className="market-input h-9 px-2"><option value="" disabled>Compare hero</option>{game.state.ownedHeroes.map((hero) => <option key={hero.uid} value={hero.uid}>{HERO_MAP[hero.heroId]?.name ?? 'Hero'} · Lv {hero.level}</option>)}</select> : <div className="market-input grid h-9 place-items-center text-[9px] text-[#777064]">Hero filters need no comparison</div>}</div></section><main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]"><section className="market-rows space-y-1.5 border-r border-[#44331d] p-3">{rows.map((row) => <Row key={row.id} row={row} active={selected?.id === row.id} onClick={() => setSelectedId(row.id)} />)}{rows.length === 0 && <Empty text={tab === 'listings' ? 'You have no active listings' : tab === 'sell' ? 'No eligible Legendary+ equipment' : 'Nothing available'} />}</section><aside className="bg-black/15 p-3">{selected ? <Detail row={selected}>{tab === 'browse' ? <button onClick={() => buy(selected)} disabled={marketBusy || selected.seller === 'You'} className="game-control game-primary mt-3 w-full px-3 text-xs font-black disabled:opacity-35">{selected.seller === 'You' ? 'Your listing' : `Buy for ${selected.price} $HERO`}</button> : tab === 'sell' ? <div className="mt-3"><div className="mb-2 text-center text-[9px] text-[#9c907d]">Seller receives {Math.floor(price * 0.95)} · fee {price - Math.floor(price * 0.95)}</div><div className="flex gap-2"><input type="number" min={1} max={1_000_000_000} value={price} onChange={(event) => setPrice(Math.max(1, Math.min(1_000_000_000, Number(event.target.value))))} className="market-input min-w-0 flex-1 px-2" /><button onClick={() => list(selected)} disabled={marketBusy || selected.seller !== 'Ready'} className="game-control game-primary px-3 text-xs font-black disabled:opacity-35">List</button></div></div> : <button onClick={() => cancel(selected)} disabled={marketBusy} className="game-control mt-3 w-full text-xs font-bold disabled:opacity-35">Cancel</button>}</Detail> : <Empty text="Select an asset" />}</aside></main></>}
  {tab === 'activity' && <Records title="Recent market activity" rows={(market?.history ?? []).map(marketHistoryRow)} />}
  {tab === 'history' && <Records title="Your sales history" rows={(market?.history ?? []).filter((row) => row.action === 'sold').map(marketHistoryRow)} />}
  {tab === 'stats' && <section className="grid gap-3 p-4 sm:grid-cols-4"><Metric icon={<BarChart3 />} label="Test pool today" value={`${market?.pool_fee_total ?? 0} $HERO`} /><Metric icon={<ShoppingCart />} label="Trades today" value={String(market?.pool_trade_count ?? 0)} /><Metric icon={<Coins />} label="Average active price" value={`${browse.length ? Math.round(browse.reduce((sum, row) => sum + row.price, 0) / browse.length) : 0} $HERO`} /><Metric icon={<List />} label="My active listings" value={`${ownListingCount} / ${market?.active_limit ?? 20}`} /></section>}
  {tab === 'supply' && <section className="p-4"><div className="mb-3 flex items-center justify-between"><div><div className="section-kicker">Live server supply</div><div className="text-[9px] text-[#81796c]">Automatically refreshed every minute</div></div><Clock3 size={15} className="text-[#c3974e]" /></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{([['divine', 'Divine', 10_000], ['celestial', 'Celestial', 5_000], ['cursed', 'Cursed', 2_500], ['immortal', 'Immortal', 1_000], ['god', 'God', 500]] as const).map(([key, name, fallbackMax]) => { const supply = tokenomics.status?.rarity_supply?.[key]; return <div key={key} className="stat-tile p-3"><div className="text-xs font-black text-[#ead9ba]">{name}</div><div className="mt-1 text-lg font-black text-[#e9bd61]">{supply ? formatNum(supply.existing) : '—'} / {formatNum(supply?.max ?? fallbackMax)}</div><div className="text-[9px] text-[#81796c]">Existing / maximum</div></div>; })}</div></section>}
  <footer className="mt-auto flex items-center gap-2 border-t border-[#44331d] px-4 py-2 text-[9px] text-[#81786b]"><ShieldCheck size={12} /> Server escrow · buyer pays full price · seller receives 95% · 5% enters the test daily pool.</footer></div></div>;
}

function Row({ row, active, onClick }: { row: Listing; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={`market-row rarity-${row.rarity} flex w-full text-left ${active ? 'market-row-selected' : ''}`}><Artwork row={row} compact /><span className="min-w-0 flex-1"><b className="block truncate text-xs" style={{ color: RARITY_COLORS[row.rarity] }}>{row.name}{row.kind === 'item' && row.enchantLevel > 0 ? ` +${row.enchantLevel}` : ''}</b><span className="text-[9px] text-[#8d8374]">Lv {row.level} · {formatNum(row.power)} PWR · {row.seller}</span></span>{row.seller === 'Locked' || row.seller === 'Equipped' || row.seller === 'Active team' ? <Lock size={13} className="text-amber-300" /> : <span className="flex items-center gap-1 font-black text-[#efff9f]"><HeroTokenIcon size={12} />{row.price}</span>}</button>; }
function Detail({ row, children }: { row: Listing; children: ReactNode }) { const item = row.kind === 'item' ? ITEM_MAP[row.sourceId] : null; const hero = row.kind === 'hero' ? HERO_MAP[row.sourceId] : null; return <div><h3 className={`rarity-title rarity-${row.rarity} text-center text-lg font-black`} style={{ color: RARITY_COLORS[row.rarity] }}>{row.name}</h3><div className={`market-detail-art rarity-${row.rarity} mx-auto mt-3`}><Artwork row={row} /></div><div className="stat-tile mt-3 space-y-1 p-3 text-[10px]"><div className="flex justify-between"><span className="text-[#81796c]">Owner</span><b>{row.seller}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Type</span><b>{item?.slot.replace('_', ' ') ?? hero?.heroClass ?? row.kind}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Rarity</span><b style={{ color: RARITY_COLORS[row.rarity] }}>{RARITY_LABEL[row.rarity]}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Level / Upgrade</span><b>{row.level} / +{row.enchantLevel}</b></div><div className="flex justify-between"><span className="text-[#81796c]">Power</span><b>{formatNum(row.power)}</b></div><div className="mt-2 border-t border-[#473a28] pt-2 text-[9px] font-bold uppercase text-[#8d816f]">All properties</div>{row.stats.map((stat, index) => <div key={`${stat}-${index}`} className="text-[#c4b8a6]">• {stat}</div>)}</div>{children}</div>; }
function Artwork({ row, compact = false }: { row: Listing; compact?: boolean }) { const cls = compact ? 'h-11 w-11' : 'h-36 w-36'; if (row.kind === 'hero') { const hero = HERO_MAP[row.sourceId]; return hero ? <span className={`${cls} grid shrink-0 place-items-center overflow-hidden rounded-lg`}><HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={compact ? 42 : 136} /></span> : null; } const item = ITEM_MAP[row.sourceId]; return item ? <span className={`${cls} block shrink-0 overflow-hidden rounded-lg bg-black/25`}><ItemArtwork itemId={item.id} name={item.name} fallback={item.icon} /></span> : null; }
function Records({ title, rows }: { title: string; rows: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold' }[] }) { return <section className="p-4"><h3 className="mb-3 text-sm font-black text-[#e8dcc8]">{title}</h3><div className="space-y-1.5">{rows.map((row) => <div key={row.id} className="market-row flex items-center"><Clock3 size={13} className="text-[#8c806e]" /><span className="ml-2 flex-1 text-xs text-[#d8cdbb]">{row.name}</span><span className="text-[9px] uppercase text-[#8d8374]">{row.action}</span><span className="ml-3 flex items-center gap-1 text-xs font-black text-[#efff9f]"><HeroTokenIcon size={11} />{row.price}</span></div>)}{rows.length === 0 && <Empty text="No records yet" />}</div></section>; }
function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="stat-tile p-4 text-center"><span className="mx-auto block w-fit text-[#bd9147]">{icon}</span><div className="mt-2 text-lg font-black text-[#eadabf]">{value}</div><div className="text-[9px] uppercase text-[#81796c]">{label}</div></div>; }
function Empty({ text }: { text: string }) { return <div className="market-empty"><PackageSearch size={23} /><b>{text}</b></div>; }
function Balance({ icon, value, label }: { icon: ReactNode; value: string; label: string }) { return <span className="stat-tile flex min-w-[98px] items-center gap-2 px-3 py-1.5 text-[#e7b858]">{icon}<span><small className="block text-[7px] uppercase text-[#7f7669]">{label}</small><b className="block text-xs text-[#eee3d2]">{value}</b></span></span>; }

function marketError(code?: string): string {
  const messages: Record<string, string> = {
    insufficient_tokens: 'Not enough $HERO',
    account_restricted: 'Market is paused during an account check',
    market_listing_unavailable: 'Listing is no longer available',
    market_seller_limit_reached: 'You reached the 20 active listings limit',
    market_test_item_required: 'Only Legendary+ equipment can be listed',
    market_self_purchase: 'You cannot buy your own listing',
    item_locked: 'Unlock this item first',
    item_equipped: 'Unequip this item first',
    item_capacity_exceeded: 'Inventory is full',
  };
  return messages[code ?? ''] ?? 'Market action failed';
}

function marketHistoryRow(row: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold' }) {
  return { ...row, name: ITEM_MAP[row.name]?.name ?? row.name };
}
