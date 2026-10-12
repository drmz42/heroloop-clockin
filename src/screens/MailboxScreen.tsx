import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, Gift, Mail, MailOpen, Sparkles, Trash2 } from 'lucide-react';
import { versionedAsset } from '@/game/assetVersion';
import { ChestCollectIcon } from '@/components/ChestCollectIcon';
import { GoldIcon } from '@/components/GoldIcon';
import { ItemArtwork } from '@/components/ItemArtwork';
import { HERO_MAP, RARITY_COLORS } from '@/game/heroes';
import { heroThumbSrc } from '@/game/portraits';
import { ITEM_MAP, displayItemPower } from '@/game/items';
import { formatNum } from '@/game/state';
import { groupMailEntries } from '@/game/mailGrouping';
import type { OwnedItem } from '@/game/types';
import type { MailAttachment, MailClaimResult, MailEntry, MailItemEntry } from '@/game/useGame';
import './mailbox.css';

// Founder 2026-10-08: the Mailbox is a full page of letters (as in Idle Heroes). Every letter shares one template:
// sender, title, text and attached rewards. Opening a letter marks it read (grey in the list); Claim takes what
// fits; at the top, Claim all and the bin (delete read letters, after a confirmation).

const ITEM_SOURCE: Record<MailItemEntry['source'], string> = {
  market_purchase: 'Market purchase',
  market_return: 'Returned from Market',
  store_overflow: 'Store purchase',
  chest_reward: 'Chest reward',
};
const ERRORS: Record<string, string> = {
  item_capacity_exceeded: 'Your bag is full. Free a slot to claim items.',
  chests_full: 'Your chest storage is full (500). Open some chests to claim more.',
  mail_not_found: 'This letter was already claimed.',
  rate_limited: 'Please wait a little before trying again.',
  feature_paused: 'The Mailbox is temporarily unavailable.',
};

const dateLabel = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
};
const hasUnclaimed = (entry: MailEntry) => entry.kind === 'item' || entry.attachments.some((attachment) => !attachment.claimed);
const isRead = (entry: MailEntry) => entry.kind === 'letter' && entry.read && !hasUnclaimed(entry);

function AttachmentTile({ attachment }: { attachment: MailAttachment }) {
  if (attachment.kind === 'item') return <ItemTile item={attachment.item} claimed={attachment.claimed} />;
  if (attachment.kind === 'hero') return <GrantTile attachment={attachment} />;
  const title = attachment.kind === 'chest' ? `${attachment.chest.boss ? 'Boss Chest' : 'Chest'}, Location ${attachment.chest.stage}`
    : attachment.kind === 'resource' ? `${formatNum(attachment.amount)} × ${attachment.title}` : `${formatNum(attachment.amount)} Gold`;
  return <div className={`mailbox-reward ${attachment.claimed ? 'is-claimed' : ''}`} title={title} aria-label={title}>
    <span className="mailbox-reward-art">{attachment.kind === 'chest' ? <ChestCollectIcon size={44} /> : attachment.kind === 'resource' ? <ResourceArt resourceId={attachment.resourceId} /> : <GoldIcon size={34} stack />}</span>
    <b>{attachment.kind === 'chest' ? `${attachment.chest.boss ? 'Boss · ' : ''}L${attachment.chest.stage}` : formatNum(attachment.amount)}</b>
    {attachment.kind === 'resource' && <small className="mailbox-reward-name">{attachment.title}</small>}
    {attachment.claimed && <i aria-label="Claimed">✓</i>}
  </div>;
}

// A custom hero (Founder 2026-10-09): a fresh copy with its own id is made on Claim; "Bound" copies stay on the account.
function GrantTile({ attachment }: { attachment: Extract<MailAttachment, { kind: 'hero' }> }) {
  const hero = HERO_MAP[attachment.heroId];
  const name = attachment.title || hero?.name || 'Hero';
  const level = `Lv ${attachment.level}${attachment.stars ? ` · ★${attachment.stars}` : ''}`;
  const label = `${name}, ${level}${attachment.bound ? ', account-bound' : ''}`;
  return <div className={`mailbox-reward ${hero ? `rarity-${hero.rarity}` : ''} ${attachment.claimed ? 'is-claimed' : ''}`} title={label} aria-label={label}>
    <span className="mailbox-reward-art">{hero ? <img src={heroThumbSrc(hero.id, hero.heroClass, hero.rarity, hero.color)} alt="" className="h-full w-full object-cover" /> : <Sparkles size={26} />}</span>
    <b style={hero ? { color: RARITY_COLORS[hero.rarity] } : undefined}>{level}</b>
    <small className="mailbox-reward-name">{name}</small>
    {attachment.bound && <small className="mailbox-reward-bound">Bound</small>}
    {attachment.claimed && <i aria-label="Claimed">✓</i>}
  </div>;
}

// Ledger resources in a letter use the game's own art where it exists.
const RESOURCE_ART: Record<string, string> = {
  summon_scroll: '/assets/ui/summon-scroll-v1.webp', boss_key: '/assets/ui/boss-key-v2.webp', potion_xs: '/assets/ui/potion-v1.webp',
  premium_potion_weak: '/assets/ui/potion-v1.webp', premium_potion_strong: '/assets/ui/potion-v1.webp',
};
function ResourceArt({ resourceId }: { resourceId: string }) {
  const src = RESOURCE_ART[resourceId];
  return src ? <img src={versionedAsset(src)} alt="" className="h-full w-full object-contain" /> : <Sparkles size={26} />;
}

function ItemTile({ item, claimed = false }: { item: OwnedItem; claimed?: boolean }) {
  const base = ITEM_MAP[item.itemId];
  if (!base) return null;
  return <div className={`mailbox-reward rarity-${base.rarity} ${claimed ? 'is-claimed' : ''}`} title={base.name} aria-label={base.name}>
    <span className="mailbox-reward-art"><ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} /></span>
    <b style={{ color: RARITY_COLORS[base.rarity] }}>Lv {item.level}</b>
    {item.bound && <small className="mailbox-reward-bound">Bound</small>}
    {claimed && <i aria-label="Claimed">✓</i>}
  </div>;
}

export function MailboxScreen({ loadMail, claimMail, readMail, deleteReadMail, freeSlots, chestCount }: {
  loadMail: () => Promise<MailEntry[] | null>;
  claimMail: (mailId: string | null) => Promise<MailClaimResult>;
  readMail: (letterId: string) => Promise<void>;
  deleteReadMail: () => Promise<number | null>;
  freeSlots: number;
  chestCount: number;
}) {
  const [entries, setEntries] = useState<MailEntry[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await loadMail();
    setEntries(result ?? []);
    if (!result) setMessage('The Mailbox could not be loaded. Please try again later.');
  }, [loadMail]);
  useEffect(() => { void refresh(); }, [refresh]);

  const open = (entry: MailEntry) => {
    setMessage('');
    setOpenId(entry.id);
    if (entry.kind === 'letter' && !entry.read) {
      setEntries((list) => list?.map((item) => (item.id === entry.id && item.kind === 'letter' ? { ...item, read: true } : item)) ?? list);
      void readMail(entry.id);
    }
  };

  const claim = async (mailId: string | null) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const result = await claimMail(mailId);
    if (!result.ok) setMessage(ERRORS[result.error ?? ''] ?? 'The reward could not be claimed. Please try again.');
    else if (result.chestsFull && result.itemsFull) setMessage('Your bag and chest storage are full. The rest stays in the Mailbox.');
    else if (result.chestsFull) setMessage(result.claimed ? 'Your chest storage is full. The rest stays in the Mailbox.' : ERRORS.chests_full);
    else if (result.itemsFull) setMessage('Your bag is full. The rest stays in the Mailbox.');
    else if (result.resourcesFull) setMessage('A resource is at its limit. That reward stays in the Mailbox.');
    else if (result.heroesFull) setMessage('Your hero roster is full. That hero stays in the Mailbox.');
    else if (result.heroesLimited) setMessage('That hero tier is sold out right now. The hero stays in the Mailbox until a slot frees up.');
    await refresh();
    setBusy(false);
  };

  const removeRead = async () => {
    setConfirmDelete(false);
    if (busy) return;
    setBusy(true);
    const deleted = await deleteReadMail();
    setMessage(deleted === null ? 'Letters could not be deleted. Please try again.' : deleted === 0 ? 'There are no read letters to delete.' : '');
    setOpenId(null);
    await refresh();
    setBusy(false);
  };

  const opened = entries?.find((entry) => entry.id === openId) ?? null;
  const claimable = (entries ?? []).filter(hasUnclaimed).length;
  const readCount = (entries ?? []).filter(isRead).length;
  const groups = groupMailEntries(entries ?? []);

  const deliveryRow = (entry: MailEntry) => {
    const read = isRead(entry) || (entry.kind === 'letter' && entry.read);
    const gift = hasUnclaimed(entry);
    const title = entry.kind === 'letter' ? entry.title : ITEM_MAP[entry.item.itemId]?.name ?? 'Item delivery';
    const sub = entry.kind === 'letter' ? entry.sender : ITEM_SOURCE[entry.source] ?? 'Delivery';
    return <button type="button" key={entry.id} onClick={() => open(entry)} className={`mailbox-row ${read ? 'is-read' : ''}`}>
      <span className={`mailbox-row-icon ${gift ? 'has-gift' : ''}`}>{gift ? <Gift size={22} /> : read ? <MailOpen size={22} /> : <Mail size={22} />}</span>
      <span className="mailbox-row-text"><b>{title}</b><small>{sub} · {dateLabel(entry.created_at)}</small></span>
      {!read && <i className="mailbox-row-dot" aria-label="Unread" />}
    </button>;
  };

  return (
    <div className="mailbox-screen" aria-labelledby="mailbox-title">
      <header className="mailbox-head">
        {opened
          ? <button type="button" className="game-control mailbox-back" onClick={() => { setOpenId(null); setMessage(''); }} aria-label="Back to the Mailbox"><ChevronLeft size={18} /> Mailbox</button>
          : <h2 id="mailbox-title" className="mailbox-title"><Mail size={18} /> Mailbox</h2>}
        <span className="mailbox-room">Bag {Math.max(0, freeSlots)} free · Chests {chestCount}/500</span>
      </header>
      {message && <p role="status" className="mailbox-message">{message}</p>}

      {!opened && <>
        <div className="mailbox-actions">
          <button type="button" disabled={busy || claimable === 0} onClick={() => void claim(null)} className="game-control game-primary mailbox-claim-all">{busy ? 'Claiming…' : `Claim all${claimable ? ` (${claimable})` : ''}`}</button>
          <button type="button" disabled={busy || readCount === 0} onClick={() => setConfirmDelete(true)} className="game-control mailbox-bin" aria-label="Delete read letters"><Trash2 size={18} /></button>
        </div>
        <div className="mailbox-list">
          {entries === null ? <p className="mailbox-empty">Loading…</p> : entries.length === 0 ? <p className="mailbox-empty">The Mailbox is empty.</p> : groups.map((group) => {
            const entry = group.entries[0];
            if (group.entries.length === 1 || entry.kind !== 'letter') return deliveryRow(entry);
            const expanded = expandedGroup === group.id;
            const read = group.entries.every((letter) => letter.kind === 'letter' && letter.read);
            const gift = group.entries.some(hasUnclaimed);
            const pending = group.entries.reduce((total, letter) => total + (letter.kind === 'letter' ? letter.attachments.filter((reward) => !reward.claimed).length : 1), 0);
            return <div className="mailbox-group" key={group.id}>
              <button type="button" className={`mailbox-row ${read ? 'is-read' : ''}`} aria-expanded={expanded} aria-controls={`mail-group-${group.id}`} onClick={() => setExpandedGroup(expanded ? null : group.id)}>
                <span className={`mailbox-row-icon ${gift ? 'has-gift' : ''}`}>{gift ? <Gift size={22} /> : <MailOpen size={22} />}</span>
                <span className="mailbox-row-text"><b>{entry.title}</b><small>{entry.sender} · {group.entries.length} letters · {pending} rewards waiting{!read ? ' · Unread' : ''}</small></span>
                <span className="mailbox-group-count">×{group.entries.length}<ChevronDown size={16} className={expanded ? 'is-expanded' : ''} /></span>
              </button>
              {expanded && <div className="mailbox-group-entries" id={`mail-group-${group.id}`}>{group.entries.map(deliveryRow)}</div>}
            </div>;
          })}
        </div>
      </>}

      {opened && <article className="mailbox-letter">
        <h3>{opened.kind === 'letter' ? opened.title : ITEM_MAP[opened.item.itemId]?.name ?? 'Item delivery'}</h3>
        <p className="mailbox-letter-body">{opened.kind === 'letter' ? opened.body : `${ITEM_SOURCE[opened.source] ?? 'Delivery'}: this item waits here until your bag has a free slot. ${formatNum(displayItemPower(opened.item))} PWR.`}</p>
        <p className="mailbox-letter-from">— {opened.kind === 'letter' ? opened.sender : 'Market'} · {dateLabel(opened.created_at)}</p>
        {(opened.kind === 'item' || opened.attachments.length > 0) && <>
          <h4>Rewards</h4>
          <div className="mailbox-rewards">
            {opened.kind === 'item' ? <ItemTile item={opened.item} /> : opened.attachments.map((attachment) => <AttachmentTile key={attachment.id} attachment={attachment} />)}
          </div>
          <button type="button" disabled={busy || !hasUnclaimed(opened)} onClick={() => void claim(opened.id)} className="game-control game-primary mailbox-claim">{busy ? 'Claiming…' : hasUnclaimed(opened) ? 'Claim' : 'Claimed'}</button>
        </>}
      </article>}

      {confirmDelete && <div className="mailbox-confirm" role="alertdialog" aria-modal="true" aria-labelledby="mailbox-confirm-text">
        <div className="mailbox-confirm-card">
          <p id="mailbox-confirm-text">Delete all read letters? Letters with unclaimed rewards stay.</p>
          <div><button type="button" className="game-control" onClick={() => setConfirmDelete(false)}>Cancel</button><button type="button" className="game-control game-primary" onClick={() => void removeRead()}>OK</button></div>
        </div>
      </div>}
    </div>
  );
}

