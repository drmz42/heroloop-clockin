import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Clock3, List, Lock, PackageSearch, Search, ShieldCheck, Swords, Shield, Gem, PawPrint, Users } from 'lucide-react';
import { GameSelect } from '@/components/GameSelect';
import { HeroPortrait } from '@/components/HeroPortrait';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice, skrListingPriceCents, useSkrRate } from '@/game/skrPurchase';
import { ItemArtwork } from '@/components/ItemArtwork';
import { ItemCompareStats } from '@/components/ItemActionPanel';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { ITEM_MAP, STAT_LABEL, displayItemPower, formatStatValue, isMarketEligibleEquipment } from '@/game/items';
import { formatNum } from '@/game/state';
import type { OwnedHero, OwnedItem, Rarity } from '@/game/types';
import type { GameApi, ServerMarketListing, ServerMarketSnapshot } from '@/game/useGame';
import type { TokenomicsApi } from '@/game/useTokenomics';
import '@/theme/scene/scene.css';
import { RarityFx } from '@/components/RarityFx';

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
  const still = game.state.battleAnimationMode === 'off';
  const categories = [{ id: 'all', label: 'All', icon: <List size={11} /> }, { id: 'weapons', label: 'Weapons', icon: <Swords size={11} /> }, { id: 'armor', label: 'Armor', icon: <Shield size={11} /> }, { id: 'accessories', label: 'Accessories', icon: <Gem size={11} /> }, { id: 'heroes', label: 'Heroes', icon: <Users size={11} /> }] as { id: Category; label: string; icon: ReactNode }[];
  return <div ref={screenRef} data-detail={Boolean(selected)} className={`sc-root mv-root seeker-market${still ? ' sc-still' : ''}`}>
    <section className="sc-stage mv-vault" aria-label="Market vault">
      <div className="sc-stage-art" aria-hidden="true" />
      <div className="sc-glow" aria-hidden="true" />
      {!still && <div className="sc-embers" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
      <header className="sc-head mv-head"><span className="sc-kicker">Merchant's Vault</span><h2 className="sc-title">Market</h2><p className="sc-lede">Trade equipment with other Seekers · 20 listings per seller</p></header>
      <nav aria-label="Market sections" className="mv-tabs">{TABS.map((item) => <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => { setTab(item.id); setSelectedId(null); setPrice(''); }} className="sc-chip mv-tab">{item.label}</button>)}</nav>
    </section>
    <div className="sc-body mv-body">
      <p className="mv-fee">Listing fee: {skrPrice(2, rate)}<SkrUsd cents={2} />. Non-refundable after listing, including cancellation. Sale fee: 10%; the seller receives 90% in SKR. Purchases arrive in Mailbox. The final SKR amount is shown before confirmation.</p>
      {notice && <div role="status" className="mv-notice">{notice}</div>}
      {(tab === 'browse' || tab === 'sell' || tab === 'listings') && <>
        <section className="sc-panel market-filter-panel mv-filters-panel">
          <div className="mv-categories">{categories.map((item) => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setRarity('all'); }} className="sc-chip mv-cat">{item.icon}{item.label}</button>)}<button type="button" disabled className="sc-chip mv-cat"><PawPrint size={11} />Pets · Soon</button></div>
          <div className="mv-filters"><label className="mv-search"><Search size={13} /><input aria-label="Search items" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." className="mv-input" /></label><GameSelect<Rarity | 'all'> ariaLabel="Rarity" value={rarity} onChange={setRarity} options={[{ value: 'all' as const, label: 'All Rarities' }, ...(category === 'heroes' ? heroRarities : allRarities).map((value) => ({ value, label: RARITY_LABEL[value] }))]} className="mv-input" /><GameSelect ariaLabel="Minimum enchant" value={enchant} onChange={setEnchant} disabled={category === 'heroes'} options={[{ value: 0, label: 'Any +Level' }, { value: 3, label: '+3 or more' }, { value: 5, label: '+5 or more' }, { value: 7, label: '+7 or more' }, { value: 10, label: '+10 only' }]} className="mv-input" /><GameSelect<LevelFilter> ariaLabel="Item level" value={levelFilter} onChange={setLevelFilter} disabled={category === 'heroes'} options={[{ value: 'all' as const, label: 'All Levels' }, { value: 'my' as const, label: 'My Level ±3' }, { value: 'usable' as const, label: 'Usable Now' }, { value: 'upgrades' as const, label: 'Upgrades' }, { value: 'endgame' as const, label: 'Endgame 80+' }]} className="mv-input" />{category !== 'heroes' ? <GameSelect ariaLabel="Comparison hero" value={comparisonHeroUid} onChange={setComparisonHeroUid} placeholder="Compare hero" options={[{ value: '', label: 'Compare hero', disabled: true }, ...game.state.ownedHeroes.map((hero) => ({ value: hero.uid, label: `${HERO_MAP[hero.heroId]?.name ?? 'Hero'} · Lv ${hero.level}` }))]} className="mv-input" /> : <div className="mv-input mv-input-note">Hero filters need no comparison</div>}</div>
        </section>
        <main className="mv-main">
          <section className="market-rows mv-grid" aria-label={tab === 'sell' ? 'Your equipment' : 'Listings'}>{rows.map((row) => <Row key={row.id} row={row} rate={rate} selling={tab === 'sell'} active={selected?.id === row.id} onClick={() => { setSelectedId(row.id); setPrice(''); }} />)}{rows.length === 0 && <Empty text={tab === 'listings' ? 'You have no active listings' : tab === 'sell' ? 'No eligible equipment matches these filters' : 'Nothing available'} />}</section>
          <aside ref={detailRef} tabIndex={-1} aria-label="Selected market item" className="sc-panel market-selected-detail mv-detail">{selected && <button type="button" onClick={() => setSelectedId(null)} className="sc-plate mv-back">Back to items</button>}{selected ? <Detail row={selected}>{tab === 'browse' ? selected.seller === 'You' ? <p className="mv-own">Your listing</p> : <><SkrPurchaseButton key={selected.id} product="market_buy_listing" params={{ listing_id: selected.id }} label={<>Buy · {skrPrice(selected.price, rate)}<SkrUsd cents={selected.price} /></>} onDelivered={delivered} />{selected.kind === 'item' && selected.owned && comparisonHero && ITEM_MAP[selected.sourceId] && <div className="mv-compare"><p className="mv-label">Compared with {HERO_MAP[comparisonHero.heroId]?.name ?? 'hero'}</p><ItemCompareStats item={selected.owned as OwnedItem} comparisonItem={game.state.inventory.find((item) => item.uid === comparisonHero.equipped[ITEM_MAP[selected.sourceId].slot]) ?? null} /></div>}</> : tab === 'sell' ? <div className="mv-sell"><p role="status" className="mv-hint">{selected.seller === 'Locked' ? 'Unlock this item in Inventory before selling.' : selected.seller === 'Equipped' ? 'Unequip this item before selling.' : 'Set a sale price, then check and confirm the listing fee.'}</p><label className="mv-price">Sale price in SKR<input aria-label="Sale price in SKR" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="mv-input" /></label><p className="mv-hint">{validPrice ? <>{skrPrice(cents, rate)}<SkrUsd cents={cents} /></> : 'Enter a SKR price'}</p><p className="sc-muted">Price uses the current rate and is rounded to the server price step. Seller receives 90% in SKR.</p><SkrPurchaseButton key={selected.id} product="market_list_item" params={{ item_id: selected.id, price: cents }} label={selected.seller === 'Ready' ? <>List · {skrPrice(2, rate)}<SkrUsd cents={2} /> fee</> : selected.seller} disabled={!validPrice || selected.seller !== 'Ready'} onDelivered={delivered} /></div> : <button type="button" onClick={() => cancel(selected)} disabled={marketBusy} className="sc-seal mv-cancel">Cancel</button>}</Detail> : <Empty text="Select an asset" />}</aside>
        </main>
      </>}
      {tab === 'activity' && <Records title="Latest 100 market sales" rate={rate} rows={(market?.activity ?? []).map(marketHistoryRow)} />}
      {tab === 'history' && <Records title="Your purchases and sales" rate={rate} rows={(market?.history ?? []).map(marketHistoryRow)} />}
      {tab === 'supply' && <section className="sc-panel mv-supply"><div className="sc-section-head"><span>Equipment supply by rarity</span><Clock3 size={15} /></div><p className="sc-muted mv-supply-note">Global limits · refreshed every minute</p><div className="mv-supply-grid">{allRarities.map((key) => {
        const limits: Partial<Record<Rarity, number>> = { divine: 10_000, celestial: 5_000, cursed: 2_500, immortal: 1_000, god: 500 };
        const limited = key in limits;
        const supply = limited ? tokenomics.status?.rarity_supply?.[key as 'divine' | 'celestial' | 'cursed' | 'immortal' | 'god'] : undefined;
        return <div key={key} className={`mv-supply-tile rarity-${key}`} style={{ '--mv-color': RARITY_COLORS[key] } as CSSProperties}><b className={`rarity-title rarity-${key}`}>{RARITY_LABEL[key]}</b><strong>{limited ? `${supply ? formatNum(supply.existing) : '—'} / ${formatNum(supply?.max ?? limits[key] ?? 0)}` : 'No global limit'}</strong><span>{limited ? 'Existing / maximum' : 'Uncapped rarity'} · {['cursed', 'immortal', 'god'].includes(key) ? 'Crafting only' : 'Level-gated drops'}</span></div>;
      })}</div></section>}
      <footer className="mv-foot"><ShieldCheck size={12} /> Server escrow · buyer pays in SKR · seller receives 90% · purchases arrive in Mailbox.</footer>
    </div>
  </div>;
}

function Row({ row, active, onClick, rate, selling }: { row: Listing; active: boolean; onClick: () => void; rate: string | null; selling: boolean }) { const blocked = row.seller === 'Locked' || row.seller === 'Equipped' || row.seller === 'Active team'; return <button type="button" onClick={onClick} aria-pressed={active} className={`mv-card rarity-${row.rarity}`} style={{ '--mv-color': RARITY_COLORS[row.rarity] } as CSSProperties}><span className="mv-card-art"><span className="mv-card-img"><Artwork row={row} compact /></span><RarityFx rarity={row.rarity} shape="slot" />{row.kind === 'item' && row.enchantLevel > 0 && <span className="mv-card-plus">+{row.enchantLevel}</span>}<span className="mv-card-lv">Lv {row.level}</span></span><span className="mv-card-info"><b className={`rarity-title rarity-${row.rarity}`}>{row.name}</b><small>{formatNum(row.power)} PWR · {row.seller}</small><span className="mv-card-price">{blocked ? <Lock size={13} /> : selling ? 'Set sale price' : <>{skrPrice(row.price, rate)}<SkrUsd cents={row.price} /></>}</span></span></button>; }
function Detail({ row, children }: { row: Listing; children: ReactNode }) { const item = row.kind === 'item' ? ITEM_MAP[row.sourceId] : null; const hero = row.kind === 'hero' ? HERO_MAP[row.sourceId] : null; return <div className="mv-detail-body" style={{ '--mv-color': RARITY_COLORS[row.rarity] } as CSSProperties}><span className="mv-detail-rarity">{RARITY_LABEL[row.rarity]}</span><h3 className={`rarity-title rarity-${row.rarity} mv-detail-name`}>{row.name}</h3><div className={`market-detail-art mv-detail-art rarity-${row.rarity}`} style={{ position: 'relative' }}><Artwork row={row} /><RarityFx rarity={row.rarity} shape="slot" /></div>{children}<dl className="mv-props"><div><dt>Owner</dt><dd>{row.seller}</dd></div><div><dt>Type</dt><dd>{item?.slot.replace('_', ' ') ?? hero?.heroClass ?? row.kind}</dd></div><div><dt>Rarity</dt><dd style={{ color: RARITY_COLORS[row.rarity] }}>{RARITY_LABEL[row.rarity]}</dd></div><div><dt>Level / Upgrade</dt><dd>{row.level} / +{row.enchantLevel}</dd></div><div><dt>Power</dt><dd>{formatNum(row.power)}</dd></div></dl><p className="mv-label">All properties</p><ul className="mv-stats">{row.stats.map((stat, index) => <li key={`${stat}-${index}`}>{stat}</li>)}</ul></div>; }
function Artwork({ row, compact = false }: { row: Listing; compact?: boolean }) { if (row.kind === 'hero') { const hero = HERO_MAP[row.sourceId]; return hero ? <HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={compact ? 64 : 136} /> : null; } const item = ITEM_MAP[row.sourceId]; return item ? <ItemArtwork itemId={item.id} name={item.name} fallback={item.icon} /> : null; }
function Records({ title, rows, rate }: { title: string; rate: string | null; rows: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold'; rarity?: Rarity }[] }) { return <section className="sc-panel mv-records"><div className="sc-section-head"><span>{title}</span></div><ul>{rows.map((row) => <li key={row.id} className="mv-record"><span className={`mv-record-action is-${row.action}`}>{row.action}</span><span className={`rarity-title rarity-${row.rarity ?? 'common'} mv-record-name`} style={{ color: row.rarity ? RARITY_COLORS[row.rarity] : undefined }}>{row.name}</span><time dateTime={new Date(row.createdAt).toISOString()}>{new Date(row.createdAt).toLocaleString()}</time><span className="mv-record-price">{skrPrice(row.price, rate)}<SkrUsd cents={row.price} /><small>At current rate</small></span></li>)}</ul>{rows.length === 0 && <Empty text="No records yet" />}</section>; }
function Empty({ text }: { text: string }) { return <div className="market-empty mv-empty"><PackageSearch size={23} /><b>{text}</b></div>; }

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
