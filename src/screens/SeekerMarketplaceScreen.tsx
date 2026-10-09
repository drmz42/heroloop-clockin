import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Clock3, HelpCircle, List, Lock, Package, PackageSearch, Search, ShieldCheck, Swords, Shield, Gem, PawPrint, Users } from 'lucide-react';
import { GameSelect } from '@/components/GameSelect';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice, skrListingPriceCents, useSkrRate } from '@/game/skrPurchase';
import { ItemArtwork } from '@/components/ItemArtwork';
import { heroPortraitSrc, heroPortraitStyle, heroThumbSrc } from '@/game/portraits';
import { ItemCompareStats } from '@/components/ItemActionPanel';
import { CLASS_LABEL, HERO_MAP, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { ITEM_MAP, STAT_LABEL, canClassEquipItem, displayItemPower, formatStatValue, isMarketEligibleEquipment } from '@/game/items';
import { formatNum, MAX_HERO_STARS, MAX_LEVEL } from '@/game/state';
import { MAX_ENCHANT_LEVEL } from '@/game/enchant';
import type { HeroClass, OwnedHero, OwnedItem, Rarity } from '@/game/types';
import type { GameApi, ServerMarketChestListing, ServerMarketHeroListing, ServerMarketListing, ServerMarketSnapshot } from '@/game/useGame';
import { teamPower } from '@/game/engine';
import type { TokenomicsApi } from '@/game/useTokenomics';
import '@/theme/scene/scene.css';
import { RarityFx } from '@/components/RarityFx';
import { formatUtcDateTime } from '@/game/numberFormat';
import { useAndroidOverlayHistory } from '@/platform/useAndroidOverlayHistory';

type MarketTab = 'consumables' | 'gear' | 'heroes' | 'sell' | 'listings' | 'activity' | 'supply';
type Category = 'weapons' | 'armor' | 'accessories';
type SellKind = 'gear' | 'heroes' | 'consumables';
type LevelFilter = 'all' | 'my' | 'usable' | `band-${number}`;
type Listing = { id: string; kind: 'item' | 'hero' | 'chest'; quantity?: number; sourceId: string; name: string; rarity: Rarity; level: number; enchantLevel: number; stars?: number; power: number; price: number; seller: string; createdAt: number; stats: string[]; owned?: OwnedItem | OwnedHero };

const MARKET_PAGE = 40;
const HERO_CLASSES = Object.keys(CLASS_LABEL) as HeroClass[];
// Level and star filters use bands of 10 levels and 5 stars up to the live caps.
const LEVEL_BANDS = Array.from({ length: Math.ceil(MAX_LEVEL / 10) }, (_, index) => index * 10 + 1);
const STAR_BANDS = Array.from({ length: Math.ceil(MAX_HERO_STARS / 5) }, (_, index) => index * 5 + 1);
const ENCHANT_STEPS = [1, 5, 10, 15].filter((step) => step < MAX_ENCHANT_LEVEL);
// Each category offers its own filters (Founder 2026-10-09); Type narrows slots inside a category.
const TYPE_OPTIONS: Record<Category, { value: string; label: string }[]> = {
  weapons: [{ value: 'main', label: 'Main Weapon' }, { value: 'offhand', label: 'Off-hand' }],
  armor: [{ value: 'helmet', label: 'Helmet' }, { value: 'chest', label: 'Chest' }, { value: 'gloves', label: 'Gloves' }, { value: 'boots', label: 'Boots' }, { value: 'shield', label: 'Shield' }],
  accessories: [{ value: 'amulet', label: 'Amulet' }, { value: 'ring', label: 'Ring' }],
};
function itemType(itemId: string): string {
  const item = ITEM_MAP[itemId];
  if (!item) return '';
  if (item.slot === 'offhand') return item.heroClass === 'knight' ? 'shield' : 'offhand';
  if (item.slot === 'class_weapon' || item.slot === 'weapon') return 'main';
  if (item.slot === 'armor') return 'chest';
  return item.slot.startsWith('ring') ? 'ring' : item.slot;
}
const ALL_TYPE_OPTIONS = Object.values(TYPE_OPTIONS).flat();
const categoryOf = (itemId: string): Category => { const type = itemType(itemId); return type === 'main' || type === 'offhand' ? 'weapons' : type === 'amulet' || type === 'ring' ? 'accessories' : 'armor'; };
const bandLabel = (start: number, max: number, suffix = '') => `${start}–${Math.min(start + (suffix ? 4 : 9), max)}${suffix}`;

// Founder 2026-10-09 order: Materials, Consumables, Gear, Heroes, Sell, My Listings, Activity, Supply, Auction.
const TABS: { id: MarketTab | 'materials' | 'auction'; label: string; soon?: boolean }[] = [
  { id: 'materials', label: 'Materials', soon: true }, { id: 'consumables', label: 'Consumables' },
  { id: 'gear', label: 'Gear' }, { id: 'heroes', label: 'Heroes' }, { id: 'sell', label: 'Sell' }, { id: 'listings', label: 'My Listings' },
  { id: 'activity', label: 'Activity' }, { id: 'supply', label: 'Supply' }, { id: 'auction', label: 'Auction', soon: true },
];

function ownedRows(game: GameApi): Listing[] {
  const equipped = new Set(game.state.ownedHeroes.flatMap((hero) => Object.values(hero.equipped)).filter(Boolean));
  return game.state.inventory.flatMap((item) => {
    const base = ITEM_MAP[item.itemId];
    // Inventory locks protect Gold sales; deliberate Market listings remain available.
    // Account-bound items (Founder 2026-10-09) never reach the Market; the server refuses them too.
    if (!base || !item.serverOwned || item.bound || !isMarketEligibleEquipment(base) || equipped.has(item.uid)) return [];
    return [{ id: item.uid, kind: 'item' as const, sourceId: item.itemId, name: base.name, rarity: base.rarity, level: item.level, enchantLevel: item.enchantLevel, power: displayItemPower(item), price: 0, seller: 'Ready', createdAt: 0, stats: item.stats.map((stat) => `${STAT_LABEL[stat.key]} ${formatStatValue(stat)}`), owned: item }];
  });
}

// Heroes follow the server's Hero Release guards; the reason shows instead of a price.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ownedHeroRows(game: GameApi): Listing[] {
  const { ownedHeroes, team } = game.state;
  const training = new Set(game.state.trainingCamp?.heroUids ?? []);
  return ownedHeroes.flatMap((hero) => {
    const base = HERO_MAP[hero.heroId];
    if (!base || !UUID.test(hero.uid)) return [];
    const reason = hero.bound ? 'Account-bound' : ownedHeroes.length <= 1 ? 'Last hero' : hero.locked ? 'Locked' : team.includes(hero.uid) ? 'Active team'
      : training.has(hero.uid) ? 'Training' : Object.values(hero.equipped ?? {}).some(Boolean) ? 'Equipped' : 'Ready';
    return [{ id: hero.uid, kind: 'hero' as const, sourceId: base.id, name: base.name, rarity: base.rarity, level: hero.level, enchantLevel: 0, stars: hero.stars, power: teamPower([hero], game.state.inventory), price: 0, seller: reason, createdAt: 0, stats: [`${hero.stars} ★`, `Level ${hero.level}`], owned: hero }];
  });
}

function listingFromServer(entry: ServerMarketListing): Listing | null {
  const base = ITEM_MAP[entry.item.itemId];
  if (!base) return null;
  return { id: entry.id, kind: 'item', sourceId: entry.item.itemId, name: base.name, rarity: base.rarity, level: entry.item.level, enchantLevel: entry.item.enchantLevel, power: displayItemPower(entry.item), price: entry.price, seller: entry.is_own ? 'You' : entry.seller, createdAt: Date.parse(entry.created_at), stats: entry.item.stats.map((stat) => `${STAT_LABEL[stat.key]} ${formatStatValue(stat)}`), owned: entry.item };
}

// House merchants list heroes too; a bought hero joins the roster directly (no Mailbox).
// Boss Chests (Consumables): loot follows the opener's Account Level, so one lot is N identical chests.
const CHEST_ART = '/assets/ui/chest-ceremony-v1.webp';
const CHEST_STATS = ['Opens with your Account Level loot table', 'Rare minimum before Level 10', 'Epic or better from Level 10'];
function chestListingFromServer(entry: ServerMarketChestListing): Listing | null {
  const quantity = Math.floor(Number(entry.chest?.quantity));
  if (entry.chest?.kind !== 'boss' || !(quantity >= 1)) return null;
  return { id: entry.id, kind: 'chest', quantity, sourceId: 'boss_chest', name: 'Boss Chest', rarity: 'epic', level: 0, enchantLevel: 0, power: 0, price: entry.price, seller: entry.is_own ? 'You' : entry.seller, createdAt: Date.parse(entry.created_at), stats: CHEST_STATS };
}
// Timed, tutorial and account-bound chests never list; the server applies the same rule.
function ownedChestRows(game: GameApi): Listing[] {
  const quantity = game.state.chests.filter((chest) => chest.boss && !chest.tutorial && !(chest as { bound?: boolean }).bound).length;
  return quantity ? [{ id: 'boss_chest', kind: 'chest', quantity, sourceId: 'boss_chest', name: 'Boss Chest', rarity: 'epic', level: 0, enchantLevel: 0, power: 0, price: 0, seller: 'Ready', createdAt: 0, stats: CHEST_STATS }] : [];
}

function heroListingFromServer(entry: ServerMarketHeroListing): Listing | null {
  const base = HERO_MAP[entry.hero?.heroId];
  if (!base) return null;
  const hero: OwnedHero = { uid: entry.id, heroId: base.id, level: entry.hero.level, stars: entry.hero.stars, equipped: {}, xp: 0 };
  return { id: entry.id, kind: 'hero', sourceId: base.id, name: base.name, rarity: base.rarity, level: entry.hero.level, enchantLevel: 0, stars: entry.hero.stars, power: teamPower([hero], []), price: entry.price, seller: entry.is_own ? 'You' : entry.seller, createdAt: Date.parse(entry.created_at), stats: [`${entry.hero.stars} ★`, `Level ${entry.hero.level}`] };
}

export function SeekerMarketScreen({ game, tokenomics }: { game: GameApi; tokenomics: TokenomicsApi }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const rate = useSkrRate();
  const [tab, setTab] = useState<MarketTab>('gear'); const [query, setQuery] = useState(''); const [selectedId, setSelectedId] = useState<string | null>(null); const [price, setPrice] = useState(''); const [notice, setNotice] = useState('');
  const [market, setMarket] = useState<ServerMarketSnapshot | null>(null); const [marketBusy, setMarketBusy] = useState(false);
  const [category, setCategory] = useState<Category>('weapons'); const [sellKind, setSellKind] = useState<SellKind>('gear'); const [chestQuantity, setChestQuantity] = useState('1'); const [rarity, setRarity] = useState<Rarity | 'all'>('all'); const [enchant, setEnchant] = useState(0); const [levelFilter, setLevelFilter] = useState<LevelFilter>('all'); const [heroClass, setHeroClass] = useState<HeroClass | 'all'>('all'); const [starBand, setStarBand] = useState(0); const [itemKind, setItemKind] = useState('all'); const [feeOpen, setFeeOpen] = useState(false); const [comparisonHeroUid, setComparisonHeroUid] = useState(game.state.team[0] ?? game.state.ownedHeroes[0]?.uid ?? '');
  const fetchSupply = tokenomics.fetchStatus;
  useEffect(() => { if (tab !== 'supply') return; void fetchSupply(); const timer = window.setInterval(() => void fetchSupply(), 60_000); return () => window.clearInterval(timer); }, [tab, fetchSupply]);
  const loadMarket = game.loadMarket;
  useEffect(() => { let active = true; const load = async () => { const next = await loadMarket(); if (!active) return; if (next) { setMarket(next); setNotice(previous => previous === 'Market is unavailable. Try again shortly.' ? '' : previous); } else setNotice('Market is unavailable. Try again shortly.'); }; void load(); const timer = window.setInterval(() => void load(), 15_000); return () => { active = false; window.clearInterval(timer); }; }, [loadMarket]);
  const serverListings = market?.listings ?? [];
  const browse = [...serverListings.map(listingFromServer), ...(market?.hero_listings ?? []).map(heroListingFromServer), ...(market?.chest_listings ?? []).map(chestListingFromServer)]
    .filter((row): row is Listing => Boolean(row)).sort((a, b) => b.createdAt - a.createdAt);
  const mine = browse.filter((row) => row.seller === 'You');
  const sellable = sellKind === 'heroes' ? ownedHeroRows(game) : sellKind === 'consumables' ? ownedChestRows(game) : ownedRows(game);
  // Item details compare against one of the active team heroes (Founder 2026-10-09).
  const teamHeroes = game.state.team.map((uid) => game.state.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero): hero is OwnedHero => Boolean(hero && HERO_MAP[hero.heroId])).slice(0, 3);
  const comparisonHero = teamHeroes.find((hero) => hero.uid === comparisonHeroUid) ?? teamHeroes[0];
  // Equipment level requirements follow the account level.
  const comparisonLevel = game.state.accountLevel ?? 1;
  const heroRarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
  const allRarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'];
  const heroMode = tab === 'heroes' || (tab === 'sell' && sellKind === 'heroes');
  const consumablesMode = tab === 'consumables' || (tab === 'sell' && sellKind === 'consumables');
  // Hundreds of listings render in pages so phones stay smooth; any filter change starts over.
  const [shown, setShown] = useState(MARKET_PAGE);
  // Android Back closes the item/hero detail and stays in the Market (Founder 2026-10-08).
  useAndroidOverlayHistory(selectedId !== null, () => setSelectedId(null));
  const filterKey = [tab, sellKind, query, category, rarity, enchant, levelFilter, heroClass, starBand, itemKind].join('|');
  useEffect(() => setShown(MARKET_PAGE), [filterKey]);
  const source = tab === 'gear' ? browse.filter((row) => row.kind === 'item' && categoryOf(row.sourceId) === category)
    : tab === 'heroes' ? browse.filter((row) => row.kind === 'hero') : tab === 'consumables' ? browse.filter((row) => row.kind === 'chest') : tab === 'sell' ? sellable : tab === 'listings' ? mine : [];
  const rows = (tab === 'listings' ? source : source.filter((row) => {
    if (query && !row.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (rarity !== 'all' && row.rarity !== rarity) return false;
    // Class keeps heroes of that class and every item that class can equip (class gear plus shared gear).
    if (heroClass !== 'all' && (row.kind === 'hero' ? HERO_MAP[row.sourceId]?.heroClass !== heroClass : !ITEM_MAP[row.sourceId] || !canClassEquipItem(heroClass, ITEM_MAP[row.sourceId]))) return false;
    if (itemKind !== 'all' && (row.kind !== 'item' || itemType(row.sourceId) !== itemKind)) return false;
    if (enchant && (row.kind !== 'item' || row.enchantLevel < enchant)) return false;
    if (row.kind === 'hero' && starBand && ((row.stars ?? 0) < starBand || (row.stars ?? 0) > starBand + 4)) return false;
    if (levelFilter.startsWith('band-')) { const start = Number(levelFilter.slice(5)); if (row.level < start || row.level > start + 9) return false; }
    if (row.kind === 'item' && levelFilter === 'my' && Math.abs(row.level - comparisonLevel) > 3) return false;
    if (row.kind === 'item' && levelFilter === 'usable' && row.level > comparisonLevel) return false;
    return true;
  }));
  const resetFilters = () => { setChestQuantity('1'); setQuery(''); setRarity('all'); setEnchant(0); setLevelFilter('all'); setHeroClass('all'); setStarBand(0); setItemKind('all'); setSelectedId(null); setPrice(''); };
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId || !window.matchMedia('(max-width: 1023px)').matches) return;
    detailRef.current?.scrollIntoView({ block: 'start' });
    detailRef.current?.focus({ preventScroll: true });
  }, [selectedId]);
  const flash = (value: string) => { setNotice(value); window.setTimeout(() => setNotice(''), 2400); };
  const refreshMarket = async () => { const next = await loadMarket(); if (next) setMarket(next); };
  const cents = skrListingPriceCents(price, rate);
  const validPrice = cents >= 1;
  // A chest lot holds 1-100 chests and never more than the seller owns.
  const lotQuantity = (() => { const value = Number(chestQuantity); return Number.isInteger(value) && value >= 1 && value <= Math.min(100, selected?.quantity ?? 0) ? value : 0; })();
  const delivered = (result: Record<string, unknown>) => { game.applySeekerPurchase(result); void refreshMarket(); };
  const cancel = async (row: Listing) => {
    if (marketBusy) return;
    setMarketBusy(true);
    try {
      const result = await game.cancelMarketListing(row.id);
      flash(result.ok ? `${row.name} returned to ${row.kind === 'hero' ? 'your heroes' : result.mailed ? 'your Mailbox' : 'inventory'}` : marketError(result.error));
      await refreshMarket();
    } catch { flash('Cancellation failed. Refresh and try again.'); }
    finally { setMarketBusy(false); }
  };
  const still = game.state.battleAnimationMode === 'off';
  // Class matters for heroes and class weapons; armor and accessories fit every class.
  const showClass = heroMode || (tab === 'gear' && category === 'weapons') || tab === 'sell';
  const typeOptions = tab === 'gear' ? TYPE_OPTIONS[category] : tab === 'sell' && !heroMode ? ALL_TYPE_OPTIONS : null;
  const categories = [{ id: 'weapons', label: 'Weapons', icon: <Swords size={11} /> }, { id: 'armor', label: 'Armor', icon: <Shield size={11} /> }, { id: 'accessories', label: 'Accessories', icon: <Gem size={11} /> }] as { id: Category; label: string; icon: ReactNode }[];
  const sellKinds = [{ id: 'gear', label: 'Gear', icon: <Swords size={11} /> }, { id: 'heroes', label: 'Heroes', icon: <Users size={11} /> }, { id: 'consumables', label: 'Consumables', icon: <Package size={11} /> }] as { id: SellKind; label: string; icon: ReactNode }[];
  const soonChip = (label: string, icon: ReactNode) => <button type="button" key={label} disabled className="sc-chip mv-cat">{icon}{label} · Soon</button>;
  return <div ref={screenRef} data-detail={Boolean(selected)} className={`sc-root mv-root seeker-market${still ? ' sc-still' : ''}`}>
    <section className="sc-stage mv-vault" aria-label="Market vault">
      <div className="sc-stage-art" aria-hidden="true" />
      <div className="sc-glow" aria-hidden="true" />
      {!still && <div className="sc-embers" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
      <header className="sc-head mv-head"><span className="sc-kicker">Merchant's Vault</span><h2 className="sc-title">Market</h2></header>
      <button type="button" className="mv-help" aria-label="Market fees and rules" aria-expanded={feeOpen} aria-controls="mv-fee" onClick={() => setFeeOpen((open) => !open)}><HelpCircle size={16} /></button>
      <nav aria-label="Market sections" className="mv-tabs">{TABS.map((item) => item.soon ? <button key={item.id} type="button" disabled className="sc-chip mv-tab mv-tab-soon">{item.label}<small>Soon</small></button> : <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => { setTab(item.id as MarketTab); resetFilters(); setFeeOpen(false); }} className="sc-chip mv-tab">{item.label}</button>)}</nav>
    </section>
    <div className="sc-body mv-body">
      {feeOpen && <div id="mv-fee" role="note" className="mv-fee"><p>Listing fee: {skrPrice(2, rate)}<SkrUsd cents={2} />. Non-refundable after listing, including cancellation.</p><p>Sale fee: 10%; the seller receives 90% in SKR. Up to 20 listings per seller.</p><p><ShieldCheck size={11} /> Server escrow. Items arrive in Mailbox, heroes join your roster. The final SKR amount is shown before confirmation.</p></div>}
      {notice && <div role="status" className="mv-notice">{notice}</div>}
      {(tab === 'consumables' || tab === 'gear' || tab === 'heroes' || tab === 'sell' || tab === 'listings') && <>
        {tab !== 'listings' && <section className="sc-panel market-filter-panel mv-filters-panel">
          {tab === 'gear' && <div className="mv-categories">{categories.map((item) => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); resetFilters(); }} className="sc-chip mv-cat">{item.icon}{item.label}</button>)}{soonChip('Pets', <PawPrint size={11} />)}{soonChip('Cosmetics', <Gem size={11} />)}</div>}
          {tab === 'sell' && <div className="mv-categories">{sellKinds.map((item) => <button type="button" key={item.id} aria-pressed={sellKind === item.id} onClick={() => { setSellKind(item.id); resetFilters(); }} className="sc-chip mv-cat">{item.icon}{item.label}</button>)}{soonChip('Materials', <List size={11} />)}{soonChip('Pets', <PawPrint size={11} />)}</div>}
          {tab === 'consumables' && <div className="mv-categories"><button type="button" aria-pressed="true" className="sc-chip mv-cat"><Package size={11} />Boss Chests</button>{soonChip('Keys', <List size={11} />)}{soonChip('Boosts', <List size={11} />)}</div>}
          {!consumablesMode && <div className={`mv-filters${showClass && typeOptions ? ' is-six' : ''}`}><label className="mv-search"><Search size={13} /><input aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." className="mv-input" /></label><GameSelect<Rarity | 'all'> ariaLabel="Rarity" value={rarity} onChange={setRarity} options={[{ value: 'all' as const, label: 'All Rarities' }, ...(heroMode ? heroRarities : allRarities).map((value) => ({ value, label: RARITY_LABEL[value], disabled: ['cursed', 'immortal', 'god'].includes(value), badge: ['cursed', 'immortal', 'god'].includes(value) ? 'Soon' : undefined }))]} className="mv-input" />{showClass && <GameSelect<HeroClass | 'all'> ariaLabel="Hero class" value={heroClass} onChange={setHeroClass} options={[{ value: 'all' as const, label: 'All Classes' }, ...HERO_CLASSES.map((value) => ({ value, label: CLASS_LABEL[value] }))]} className="mv-input" />}{typeOptions && <GameSelect ariaLabel="Item type" value={itemKind} onChange={setItemKind} options={[{ value: 'all', label: 'All Types' }, ...typeOptions]} className="mv-input" />}<GameSelect<LevelFilter> ariaLabel="Level" value={levelFilter} onChange={setLevelFilter} options={[{ value: 'all' as const, label: 'All Levels' }, ...(heroMode ? [] : [{ value: 'my' as const, label: 'My Level ±3' }, { value: 'usable' as const, label: 'Usable Now' }]), ...LEVEL_BANDS.map((start) => ({ value: `band-${start}` as const, label: `Lv ${bandLabel(start, MAX_LEVEL)}` }))]} className="mv-input" />{heroMode ? <GameSelect ariaLabel="Stars" value={starBand} onChange={setStarBand} options={[{ value: 0, label: 'All Stars' }, ...STAR_BANDS.map((start) => ({ value: start, label: bandLabel(start, MAX_HERO_STARS, '★') }))]} className="mv-input" /> : <><GameSelect ariaLabel="Minimum enhancement" value={enchant} onChange={setEnchant} options={[{ value: 0, label: 'Any Enhance' }, ...ENCHANT_STEPS.map((step) => ({ value: step, label: `+${step} or more` })), { value: MAX_ENCHANT_LEVEL, label: `+${MAX_ENCHANT_LEVEL} only` }]} className="mv-input" /></>}</div>}
        </section>}
        <main className="mv-main">
          <section className="market-rows mv-grid" aria-label={tab === 'sell' ? 'Your assets' : tab === 'listings' ? 'Your listings' : 'Listings'}>{rows.slice(0, shown).map((row) => <Row key={row.id} row={row} rate={rate} selling={tab === 'sell'} active={selected?.id === row.id} onClick={() => { setSelectedId(row.id); setPrice(''); }} />)}{rows.length > shown && <button type="button" className="sc-chip mv-more" onClick={() => setShown((count) => count + MARKET_PAGE)}>Show more · {shown} of {rows.length}</button>}{rows.length === 0 && <Empty text={tab === 'listings' ? 'You have no active listings' : tab === 'sell' ? 'Nothing eligible matches these filters' : 'Nothing available'} />}</section>
          <aside ref={detailRef} tabIndex={-1} aria-label="Selected market item" className="sc-panel market-selected-detail mv-detail">{selected ? <Detail row={selected}>{tab === 'gear' || tab === 'heroes' ? selected.seller === 'You' ? <><p className="mv-own">Your listing</p><button type="button" onClick={() => cancel(selected)} disabled={marketBusy} className="sc-seal mv-cancel">Cancel listing</button></> : <><SkrPurchaseButton key={selected.id} product="market_buy_listing" params={{ listing_id: selected.id }} label={<>Buy · {skrPrice(selected.price, rate)}<SkrUsd cents={selected.price} /></>} onDelivered={delivered} />{selected.kind === 'item' && selected.owned && comparisonHero && ITEM_MAP[selected.sourceId] && <div className="mv-compare"><p className="mv-label">Compare with</p><div className="mv-compare-heroes" role="group" aria-label="Compare with team hero">{teamHeroes.map((hero) => { const base = HERO_MAP[hero.heroId]; return <button key={hero.uid} type="button" aria-pressed={hero.uid === comparisonHero.uid} onClick={() => setComparisonHeroUid(hero.uid)} className="mv-compare-hero" style={{ '--mv-color': RARITY_COLORS[base.rarity] } as CSSProperties}><img src={heroThumbSrc(base.id, base.heroClass, base.rarity, base.color)} alt="" loading="lazy" decoding="async" /><span>{base.name}<small>Lv {hero.level}</small></span></button>; })}</div>{canClassEquipItem(HERO_MAP[comparisonHero.heroId].heroClass, ITEM_MAP[selected.sourceId]) ? <ItemCompareStats item={selected.owned as OwnedItem} comparisonItem={game.state.inventory.find((item) => item.uid === comparisonHero.equipped[ITEM_MAP[selected.sourceId].slot]) ?? null} /> : <p className="mv-hint">{HERO_MAP[comparisonHero.heroId].name} cannot equip this item.</p>}</div>}</> : tab === 'sell' ? <div className="mv-sell"><p role="status" className="mv-hint">{selected.seller === 'Equipped' ? 'Unequip this item before selling.' : 'Set a sale price, then check and confirm the listing fee.'}</p>{selected.kind === 'chest' && <label className="mv-price">Quantity (you have {selected.quantity}, up to {Math.min(100, selected.quantity ?? 0)} per lot)<input aria-label="Chest quantity" inputMode="numeric" value={chestQuantity} onChange={(event) => setChestQuantity(event.target.value.replace(/\D/g, '').slice(0, 3))} className="mv-input" /></label>}<label className="mv-price">{selected.kind === 'chest' ? 'Lot price in SKR (whole lot)' : 'Sale price in SKR'}<input aria-label="Sale price in SKR" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="mv-input" /></label><p className="mv-hint">{validPrice ? <>{skrPrice(cents, rate)}<SkrUsd cents={cents} /></> : 'Enter a SKR price'}</p><p className="sc-muted">Price uses the current rate and is rounded to the server price step. Seller receives 90% in SKR.</p><SkrPurchaseButton key={selected.id} product="market_list_item" params={{ item_id: selected.kind === 'chest' ? `chest:boss:${lotQuantity}` : selected.id, price: cents }} label={selected.seller === 'Ready' ? <>List · {skrPrice(2, rate)}<SkrUsd cents={2} /> fee</> : selected.seller} disabled={!validPrice || selected.seller !== 'Ready' || (selected.kind === 'chest' && !lotQuantity)} onDelivered={delivered} /></div> : <button type="button" onClick={() => cancel(selected)} disabled={marketBusy} className="sc-seal mv-cancel">Cancel</button>}</Detail> : <Empty text="Select an asset" />}</aside>
        </main>
        {tab === 'listings' && <Records title="Your purchases and sales" rate={rate} rows={(market?.history ?? []).map(marketHistoryRow)} />}
      </>}
      {tab === 'activity' && <Records title="Latest 100 market sales" rate={rate} rows={(market?.activity ?? []).map(marketHistoryRow)} />}
      {tab === 'supply' && <section className="sc-panel mv-supply"><div className="sc-section-head"><span>Equipment supply by rarity</span><Clock3 size={15} /></div><p className="sc-muted mv-supply-note">Global limits · refreshed every minute</p><div className="mv-supply-grid">{allRarities.map((key) => {
        const limits: Partial<Record<Rarity, number>> = { divine: 10_000, celestial: 5_000, cursed: 2_500, immortal: 1_000, god: 500 };
        const limited = key in limits;
        const supply = limited ? tokenomics.status?.rarity_supply?.[key as 'divine' | 'celestial' | 'cursed' | 'immortal' | 'god'] : undefined;
        return <div key={key} className={`mv-supply-tile rarity-${key}`} style={{ '--mv-color': RARITY_COLORS[key] } as CSSProperties}><b className={`rarity-title rarity-${key}`}>{RARITY_LABEL[key]}</b><strong>{limited ? `${supply ? formatNum(supply.existing) : '—'} / ${formatNum(supply?.max ?? limits[key] ?? 0)}` : 'No global limit'}</strong><span>{limited ? 'Existing / maximum' : 'Uncapped rarity'} · {['cursed', 'immortal', 'god'].includes(key) ? 'Crafting only' : 'Level-gated drops'}</span></div>;
      })}</div></section>}
    </div>
  </div>;
}

function Row({ row, active, onClick, rate, selling }: { row: Listing; active: boolean; onClick: () => void; rate: string | null; selling: boolean }) { const blocked = ['Locked', 'Equipped', 'Active team', 'Training', 'Last hero'].includes(row.seller); return <button type="button" onClick={onClick} aria-pressed={active} className={`mv-card rarity-${row.rarity}`} style={{ '--mv-color': RARITY_COLORS[row.rarity] } as CSSProperties}><span className="mv-card-art"><span className={`mv-card-img${row.kind === 'hero' ? ' is-hero' : ''}`}><Artwork row={row} compact /></span><RarityFx rarity={row.rarity} shape="slot" />{row.kind === 'item' && row.enchantLevel > 0 && <span className="mv-card-plus">+{row.enchantLevel}</span>}{row.kind === 'hero' && Boolean(row.stars) && <span className="mv-card-plus">{row.stars}★</span>}{row.kind === 'chest' ? <span className="mv-card-lv">×{row.quantity}</span> : <span className="mv-card-lv">Lv {row.level}</span>}</span><span className="mv-card-info"><b className={`rarity-title rarity-${row.rarity}`}>{row.name}</b><small>{row.kind === 'chest' ? 'Consumable' : `${formatNum(row.power)} PWR`} · {row.seller}</small><span className="mv-card-price">{blocked ? <Lock size={13} /> : selling ? 'Set sale price' : <>{skrPrice(row.price, rate)}<SkrUsd cents={row.price} /></>}</span></span></button>; }
function Detail({ row, children }: { row: Listing; children: ReactNode }) { const item = row.kind === 'item' ? ITEM_MAP[row.sourceId] : null; const hero = row.kind === 'hero' ? HERO_MAP[row.sourceId] : null; return <div className="mv-detail-body" style={{ '--mv-color': RARITY_COLORS[row.rarity] } as CSSProperties}><div className={`market-detail-art mv-detail-art rarity-${row.rarity}`} style={{ position: 'relative' }}><Artwork row={row} /><RarityFx rarity={row.rarity} shape="slot" /></div>{children}{row.kind === 'chest' ? <dl className="mv-props"><div><dt>Name</dt><dd>{row.name}</dd></div><div><dt>Owner</dt><dd>{row.seller}</dd></div><div><dt>Type</dt><dd>Consumable · Chest</dd></div><div><dt>Quantity</dt><dd>{row.quantity}</dd></div></dl> : <dl className="mv-props"><div><dt>Name</dt><dd>{row.name}</dd></div><div><dt>Owner</dt><dd>{row.seller}</dd></div><div><dt>Type</dt><dd>{item?.slot.replace('_', ' ') ?? hero?.heroClass ?? row.kind}</dd></div><div><dt>Rarity</dt><dd style={{ color: RARITY_COLORS[row.rarity] }}>{RARITY_LABEL[row.rarity]}</dd></div><div><dt>Level / Upgrade</dt><dd>{row.level} / +{row.enchantLevel}</dd></div><div><dt>Power</dt><dd>{formatNum(row.power)}</dd></div></dl>}<p className="mv-label">All properties</p><ul className="mv-stats">{row.stats.map((stat, index) => <li key={`${stat}-${index}`}>{stat}</li>)}</ul></div>; }
function Artwork({ row, compact = false }: { row: Listing; compact?: boolean }) { if (row.kind === 'chest') return <img src={CHEST_ART} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />; if (row.kind === 'hero') { const hero = HERO_MAP[row.sourceId]; return hero ? <span className="relative block h-full w-full overflow-hidden"><img src={(compact ? heroThumbSrc : heroPortraitSrc)(hero.id, hero.heroClass, hero.rarity, hero.color)} alt="" loading="lazy" decoding="async" style={{ ...heroPortraitStyle(hero.id, hero.heroClass), transform: 'none' }} /></span> : null; } const item = ITEM_MAP[row.sourceId]; return item ? <ItemArtwork itemId={item.id} name={item.name} fallback={item.icon} /> : null; }
function Records({ title, rows, rate }: { title: string; rate: string | null; rows: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold'; rarity?: Rarity }[] }) { return <section className="sc-panel mv-records"><div className="sc-section-head"><span>{title}</span></div><ul>{rows.map((row) => <li key={row.id} className="mv-record"><span className={`mv-record-action is-${row.action}`}>{row.action}</span><span className={`rarity-title rarity-${row.rarity ?? 'common'} mv-record-name`} style={{ color: row.rarity ? RARITY_COLORS[row.rarity] : undefined }}>{row.name}</span><time dateTime={new Date(row.createdAt).toISOString()}>{formatUtcDateTime(row.createdAt)}</time><span className="mv-record-price">{skrPrice(row.price, rate)}<SkrUsd cents={row.price} /><small>At current rate</small></span></li>)}</ul>{rows.length === 0 && <Empty text="No records yet" />}</section>; }
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
    chest_not_found: 'Not enough tradable Boss Chests',
    chest_capacity_exceeded: 'Your chest queue is full',
    market_chest_limit_reached: 'You reached the 20 active chest listings limit',
  };
  return messages[code ?? ''] ?? 'Market action failed';
}

// Sales name an equipment base id, a hero catalogue id or a Boss Chest lot ('Boss Chest ×N').
function marketHistoryRow(row: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold' }) {
  const item = ITEM_MAP[row.name]; const hero = HERO_MAP[row.name];
  if (item) return { ...row, rarity: item.rarity, name: `${item.name} · ${RARITY_LABEL[item.rarity]}` };
  if (hero) return { ...row, rarity: hero.rarity, name: `${hero.name} · Hero` };
  return row.name.startsWith('Boss Chest') ? { ...row, rarity: 'epic' as Rarity } : row;
}
