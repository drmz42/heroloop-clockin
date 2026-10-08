import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { RarityFx } from '@/components/RarityFx';
import { Package, Sparkles } from 'lucide-react';
import { ITEM_MAP, SLOT_LABEL, displayItemPower } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL, RARITY_INDEX } from '@/game/heroes';
import type { OwnedItem, OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { ItemArtwork } from '@/components/ItemArtwork';
import { versionedAsset } from '@/game/assetVersion';
import { itemArtSrc } from '@/game/art';
import { duckMusic, playReveal, playSfx } from '@/audio/gameAudio';
import '@/theme/motion/chest-ceremony.css';

// Chest opening ceremony (presentation only; the server already settled every item): the sealed chest
// charges in the colour of the best item, the seal shatters, cards fly out face down and flip one by one,
// commons quickly and Rare+ with a pause, Legendary+ with a full-screen stamp. Tap skips ahead.
// Founder 2026-10-08: faster pacing, item art is decoded while the chest charges, and each card is a memoized
// component so a flip re-renders one card instead of the whole grid (game ticks no longer touch the grid).
type Phase = 'charge' | 'burst' | 'reveal' | 'done';
const CHARGE_MS = 1000;
const BURST_MS = 420;

const motionActive = () => typeof document !== 'undefined'
  && document.documentElement.dataset.hlMotion === 'on'
  && !document.querySelector('.game-motion-off')
  && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const rarityOf = (item: OwnedItem): Rarity => ITEM_MAP[item.itemId]?.rarity ?? 'common';
const tierOf = (item: OwnedItem) => RARITY_INDEX[rarityOf(item)] ?? 0;

export function ChestOpenModal({
  items, onClose,
}: {
  items: OwnedItem[]; game: GameApi; heroes: OwnedHero[]; onClose: () => void;
}) {
  // Reveal order saves the best for last; the summary lists best first.
  const ordered = useMemo(() => items.filter((item) => ITEM_MAP[item.itemId])
    .sort((a, b) => tierOf(a) - tierOf(b) || displayItemPower(a) - displayItemPower(b)), [items]);
  const best = ordered[ordered.length - 1];
  const bestTier = best ? tierOf(best) : 0;
  const bestColor = best ? RARITY_COLORS[rarityOf(best)] : '#e2a54b';
  const animated = useRef(motionActive()).current;
  const [phase, setPhase] = useState<Phase>(animated ? 'charge' : 'done');
  const [flipped, setFlipped] = useState(animated ? 0 : ordered.length);
  const [stamp, setStamp] = useState<{ key: number; rarity: Rarity } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<number[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const clearTimers = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };
  useEffect(() => () => clearTimers(), []);

  const revealSchedule = useMemo(() => {
    // Commons speed up for big batches so 48 items never take more than a few seconds.
    const fast = ordered.length > 12 ? 32 : 90;
    let at = 0;
    return ordered.map((item, index) => {
      const tier = tierOf(item);
      const pause = tier >= 4 ? 640 : tier === 3 ? 360 : tier === 2 ? 160 : fast;
      at += index === 0 ? 260 : pause;
      return at;
    });
  }, [ordered]);

  const startReveal = useCallback(() => {
    clearTimers();
    setPhase('reveal');
    playSfx('cardFly');
    revealSchedule.forEach((at, index) => later(() => {
      setFlipped(index + 1);
      const item = ordered[index];
      const tier = tierOf(item);
      playReveal(tier);
      if (tier >= 4) setStamp({ key: Date.now(), rarity: rarityOf(item) });
    }, at));
    later(() => setPhase('done'), (revealSchedule[revealSchedule.length - 1] ?? 0) + 450);
  }, [ordered, revealSchedule]);

  useLayoutEffect(() => {
    if (phase !== 'reveal' || flipped === 0) return;
    const grid = gridRef.current;
    const card = grid?.querySelector<HTMLElement>(`[data-cc-index="${flipped - 1}"]`);
    if (!grid || !card) return;
    // Follow every rarity after the flip commits. Scroll only the item grid, and move
    // immediately so fast Common batches never outrun a smooth-scroll animation.
    // Layout offsets ignore the temporary card-deal transform.
    const cardTop = card.offsetTop - grid.offsetTop;
    const cardBottom = cardTop + card.offsetHeight;
    const top = grid.scrollTop + 6;
    const bottom = grid.scrollTop + grid.clientHeight - 10;
    if (cardBottom > bottom) grid.scrollTop = cardBottom - grid.clientHeight + 10;
    else if (cardTop < top) grid.scrollTop = cardTop - 6;
  }, [phase, flipped]);

  // Decode every item picture during the charge so flips never wait on image loading.
  useEffect(() => {
    const seen = new Set<string>();
    ordered.forEach((item) => {
      const src = itemArtSrc(item.itemId);
      if (!src || seen.has(src)) return;
      seen.add(src);
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      img.decode?.().catch(() => undefined);
    });
  }, [ordered]);

  useEffect(() => {
    if (!animated) { if (ordered.length) playReveal(bestTier); return; }
    duckMusic(CHARGE_MS + BURST_MS + (revealSchedule[revealSchedule.length - 1] ?? 0) + 1200);
    playSfx('chestCharge');
    for (let t = 120; t < CHARGE_MS - 100; t += 260) later(() => playSfx('chestRattle'), t);
    later(() => { setPhase('burst'); playSfx('chestBurst', bestTier); }, CHARGE_MS);
    later(startReveal, CHARGE_MS + BURST_MS);
    // Mount-only: the ceremony runs once per result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!stamp) return undefined;
    const t = window.setTimeout(() => setStamp(null), 1300);
    return () => window.clearTimeout(t);
  }, [stamp]);

  const skip = () => {
    if (phase === 'charge') { clearTimers(); setPhase('burst'); playSfx('chestBurst', bestTier); later(startReveal, 300); return; }
    if (phase === 'reveal') { clearTimers(); setFlipped(ordered.length); setStamp(null); playReveal(bestTier); setPhase('done'); }
  };

  const collect = () => {
    if (leaving) return;
    playSfx('claim');
    const bag = [...document.querySelectorAll<HTMLElement>('.hl-tabbar-item')].find((el) => /bag/i.test(el.textContent ?? ''));
    const cards = [...(gridRef.current?.querySelectorAll<HTMLElement>('.hl-cc-card') ?? [])].slice(0, 24);
    if (!animated || !bag || !cards.length) { onClose(); return; }
    setLeaving(true);
    const target = bag.getBoundingClientRect();
    cards.forEach((card, index) => {
      const r = card.getBoundingClientRect();
      const dx = target.left + target.width / 2 - (r.left + r.width / 2);
      const dy = target.top + target.height / 2 - (r.top + r.height / 2);
      card.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 30}px) scale(.9)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${dx}px, ${dy}px) scale(.15)`, opacity: 0.2 },
      ], { duration: 560, delay: index * 22, easing: 'cubic-bezier(.5, 0, .7, .4)', fill: 'forwards' });
    });
    window.setTimeout(onClose, 560 + cards.length * 22);
  };

  const tally = useMemo(() => {
    const counts = new Map<Rarity, number>();
    ordered.forEach((item) => counts.set(rarityOf(item), (counts.get(rarityOf(item)) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => RARITY_INDEX[b[0]] - RARITY_INDEX[a[0]]);
  }, [ordered]);

  const single = ordered.length === 1;
  const style = { '--cc-best': bestColor } as CSSProperties;

  return createPortal(
    <div className={`hl-portal hl-chest-ceremony is-${phase} ${bestTier >= 4 ? 'is-jackpot' : bestTier >= 3 ? 'is-rare' : ''} ${animated ? 'is-animated' : ''}`} style={style} data-sfx="off" role="dialog" aria-modal="true" aria-label={`${ordered.length} items found`} onClick={phase === 'charge' || phase === 'reveal' ? skip : undefined}>
      <div className="hl-cc-backdrop" aria-hidden="true" />
      <div className="hl-cc-rays" aria-hidden="true" />
      <div className="hl-cc-motes" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <i key={index} style={{ ['--x' as string]: `${(index * 53 + 7) % 100}%`, ['--t' as string]: `${(index % 5) * 0.6}s` }} />)}</div>

      {(phase === 'charge' || phase === 'burst') && (
        <div className="hl-cc-stage">
          <div className="hl-cc-chest">
            <i className="hl-cc-leak" aria-hidden="true" />
            <img src={versionedAsset('/assets/ui/chest-ceremony-v1.webp')} alt="" draggable={false} />
            <svg className="hl-cc-seal" viewBox="0 0 200 200" aria-hidden="true">
              <circle cx="100" cy="100" r="88" />
              <circle cx="100" cy="100" r="70" strokeDasharray="4 7" />
              <path d="M100 18 L118 100 L100 182 L82 100 Z M18 100 L100 82 L182 100 L100 118 Z" />
              {Array.from({ length: 12 }, (_, index) => <text key={index} x="100" y="22" transform={`rotate(${index * 30} 100 100)`}>{'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃ'[index]}</text>)}
            </svg>
          </div>
          <div className="hl-cc-count"><Package size={14} aria-hidden="true" /> {ordered.length} {single ? 'ITEM' : 'ITEMS'} SEALED</div>
          <p className="hl-cc-hint">Tap to break the seal</p>
          {phase === 'burst' && <>
            <i className="hl-cc-flash" aria-hidden="true" />
            <i className="hl-cc-shock" aria-hidden="true" />
            <span className="hl-cc-burst" aria-hidden="true">{Array.from({ length: 26 }, (_, index) => <i key={index} style={{ ['--a' as string]: `${index * (360 / 26)}deg`, ['--d' as string]: `${110 + (index % 4) * 38}px` }} />)}</span>
          </>}
        </div>
      )}

      {(phase === 'reveal' || phase === 'done') && (
        <div className="hl-cc-result" onClick={(event) => { if (phase === 'done') event.stopPropagation(); }}>
          <header className="hl-cc-head">
            <span className="hl-cc-kicker"><Sparkles size={13} aria-hidden="true" /> Chest opened</span>
            <h2>{ordered.length} {single ? 'ITEM' : 'ITEMS'} FOUND</h2>
          </header>
          <div ref={gridRef} className={`hl-cc-grid ${single ? 'is-single' : ''} ${ordered.length > 12 ? 'is-many' : ''}`}>
            {ordered.map((item, index) => (
              <ChestCard key={item.uid} item={item} index={index} open={index < flipped} teasing={index === flipped && phase === 'reveal'} single={single} />
            ))}
          </div>
          {phase === 'done' ? (
            <footer className="hl-cc-foot">
              <div className="hl-cc-tally">{tally.map(([rarity, count]) => <span key={rarity} style={{ color: RARITY_COLORS[rarity], borderColor: `${RARITY_COLORS[rarity]}88` }}>{count} {RARITY_LABEL[rarity]}</span>)}</div>
              <button type="button" className="hl-cc-collect" onClick={collect} disabled={leaving}><Package size={16} aria-hidden="true" /> Send to Bag</button>
            </footer>
          ) : (
            <footer className="hl-cc-foot"><button type="button" className="hl-cc-skip" onClick={(event) => { event.stopPropagation(); skip(); }}>Reveal all</button></footer>
          )}
        </div>
      )}

      {stamp && <div key={stamp.key} className="hl-cc-stamp" style={{ '--rc': RARITY_COLORS[stamp.rarity] } as CSSProperties} aria-hidden="true"><i className="hl-cc-stamp-flash" /><strong>{RARITY_LABEL[stamp.rarity].toUpperCase()}!</strong></div>}
    </div>,
    document.body,
  );
}

const ChestCard = memo(function ChestCard({ item, index, open, teasing, single }: { item: OwnedItem; index: number; open: boolean; teasing: boolean; single: boolean }) {
  const base = ITEM_MAP[item.itemId]!;
  const rc = RARITY_COLORS[base.rarity];
  const tier = tierOf(item);
  return (
    <div data-cc-index={index} className={`hl-cc-card rarity-${base.rarity} tier-${Math.min(tier, 6)} ${open ? 'is-open' : ''} ${teasing && tier >= 3 ? 'is-teasing' : ''}`} style={{ '--rc': rc, '--i': index } as CSSProperties}>
      <div className="hl-cc-card-inner">
        <div className="hl-cc-back" aria-hidden="true"><i /></div>
        <div className="hl-cc-front" aria-hidden={!open}>
          <i className="hl-cc-front-glow" aria-hidden="true" />
          <div className="hl-cc-art item-slot">
            <ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} className={single ? 'text-6xl' : 'text-3xl'} />
            <RarityFx rarity={base.rarity} shape="slot" />
          </div>
          <strong className="hl-cc-name" style={{ color: rc }}>{base.name}</strong>
          <span className="hl-cc-meta">{RARITY_LABEL[base.rarity]} · {SLOT_LABEL[base.slot]}</span>
          <span className="hl-cc-stats">iLvl {item.level} · ⚡ {displayItemPower(item)}</span>
        </div>
      </div>
    </div>
  );
});
