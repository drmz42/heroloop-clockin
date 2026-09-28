import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Clock3, Coins, Download, ExternalLink, FlaskConical, Hourglass, Package, Sparkles, X } from 'lucide-react';
import { playerSync } from '@/game/backend';
import { formatNum } from '@/game/state';
import type { GameState } from '@/game/types';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { renderPartnerQuestShareCard } from '@/components/PartnerQuestShareCard';

export type PartnerQuestKind = 'x_follow' | 'x_repost' | 'x_comment' | 'x_post' | 'tg_join' | 'custom';
export type SocialProvider = 'x' | 'telegram';
export interface SocialLinks { x: { handle: string } | null; telegram: { handle: string } | null }

interface PartnerQuest {
  id: number;
  kind: PartnerQuestKind;
  title: string;
  body: string;
  partner: string;
  target_url: string;
  ends_at: string;
  reward: Record<string, number>;
  requires: SocialProvider | null;
  min_account_level: number;
  full: boolean;
  status: 'started' | 'pending' | 'approved' | 'rejected' | 'claimed' | null;
  proof: string | null;
  review_note: string | null;
  can_resubmit: boolean;
}

export interface PartnerQuestList { links: SocialLinks; quests: PartnerQuest[] }

export const SOCIAL_LINKS_CHANGED = 'heroloop:social-links-changed';
export const PROVIDER_LABEL: Record<SocialProvider, string> = { x: 'X (Twitter)', telegram: 'Telegram' };

const NEEDS_PROOF: Record<PartnerQuestKind, boolean> = {
  x_follow: false, tg_join: false, x_repost: true, x_comment: true, x_post: true, custom: true,
};

const PROOF_HINT: Record<PartnerQuestKind, string> = {
  x_follow: '', tg_join: '',
  x_repost: 'Link to your repost (x.com/you/status/…)',
  x_comment: 'Link to your reply (x.com/you/status/…)',
  x_post: 'Link to your post (x.com/you/status/…)',
  custom: 'Link that proves the task (https://…)',
};

const ERROR_TEXT: Record<string, string> = {
  social_link_required: 'Link your account in BOOST MAX first.',
  partner_quest_unavailable: 'This quest has ended.',
  partner_quest_level_required: 'Your account level is too low for this quest.',
  partner_quest_too_fast: 'Complete the task first, then submit.',
  partner_proof_invalid: 'This link does not look right for this quest.',
  partner_proof_not_yours: 'The link must be from your linked account.',
  partner_proof_reused: 'This link was already used by another player.',
  partner_quest_final: 'No more attempts for this quest.',
  partner_quest_already_submitted: 'Already submitted.',
  chest_capacity_exceeded: 'Your chest storage is full. Open some chests first.',
  rate_limited: 'Too many attempts. Please wait a moment.',
};

const REWARD_ICON: Record<string, JSX.Element> = {
  gold: <Coins size={10} />, hero: <HeroTokenIcon size={10} />, summon_scroll: <SummonScrollArtwork size={16} />,
  boss_key: <BossKeyIcon size={16} />, chests: <Package size={10} />,
};
const REWARD_LABEL: Record<string, string> = {
  gold: 'Gold', hero: '$HERO', summon_scroll: 'Scrolls', boss_key: 'Boss Keys', chests: 'Chests',
  potion_xs: 'XS Potions', potion_sm: 'S Potions', potion_md: 'M Potions', potion_lg: 'L Potions', potion_xl: 'XL Potions', potion_xxl: 'XXL Potions',
};

function timeLeft(endsAt: string, now: number): string {
  const ms = Date.parse(endsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Ended';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)}d left`;
  if (hours >= 1) return `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

export function PartnerQuests({ claim, onOpenBoostMax, shareState, teamPower }: {
  claim: (questId: number) => Promise<string | null>;
  onOpenBoostMax: () => void;
  shareState: GameState;
  teamPower: number;
}) {
  const [data, setData] = useState<PartnerQuestList | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [proofs, setProofs] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [shareCard, setShareCard] = useState<{ imageUrl: string; image: Blob; targetUrl: string; questId: number } | null>(null);

  const load = useCallback(async () => {
    const result = await playerSync<PartnerQuestList>('partner_quest_list', {});
    if (result && Array.isArray(result.quests)) setData(result);
  }, []);

  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState !== 'visible') return; void load(); setNow(Date.now()); };
    const refresh = window.setInterval(tick, 60_000);
    const onLinksChanged = () => { void load(); };
    window.addEventListener(SOCIAL_LINKS_CHANGED, onLinksChanged);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(refresh); window.removeEventListener(SOCIAL_LINKS_CHANGED, onLinksChanged); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  // Back from the X sign-in page: BOOST MAX hosts Linked accounts, which shows the result.
  const openedForLinkResult = useRef(false);
  useEffect(() => {
    if (openedForLinkResult.current || !new URLSearchParams(window.location.search).has('social_link')) return;
    openedForLinkResult.current = true;
    onOpenBoostMax();
  }, [onOpenBoostMax]);

  useEffect(() => () => { if (shareCard) URL.revokeObjectURL(shareCard.imageUrl); }, [shareCard]);
  useEffect(() => {
    if (!shareCard) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setShareCard(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shareCard]);

  if (!data || data.quests.length === 0) return null;

  const fail = (id: number, code: string) => setErrors((current) => ({ ...current, [id]: ERROR_TEXT[code] ?? 'Temporarily unavailable. Try again later.' }));
  const run = async (id: number, action: () => Promise<string | null>) => {
    setBusy(id);
    setErrors((current) => ({ ...current, [id]: '' }));
    const code = await action();
    if (code) fail(id, code);
    await load();
    setBusy(null);
  };

  const go = (quest: PartnerQuest) => {
    if (quest.requires && !data.links[quest.requires]) { fail(quest.id, 'social_link_required'); return; }
    // Other tasks open synchronously so the browser does not block the tab.
    // An X post first gets a local image preview; its button opens X later.
    if (quest.kind !== 'x_post') window.open(quest.target_url, '_blank', 'noopener,noreferrer');
    void run(quest.id, async () => {
      let code = '';
      const started = await playerSync('partner_quest_start', { quest_id: quest.id }, (error) => { code = error; });
      if (!started) return code || 'unavailable';
      if (quest.kind === 'x_post') {
        try {
          const image = await renderPartnerQuestShareCard(shareState, teamPower);
          setShareCard({ imageUrl: URL.createObjectURL(image), image, targetUrl: quest.target_url, questId: quest.id });
        } catch {
          return 'share_image_unavailable';
        }
      }
      return null;
    });
  };

  const downloadShareCard = () => {
    if (!shareCard) return;
    const link = document.createElement('a');
    link.href = shareCard.imageUrl;
    link.download = `heroloop-squad-${shareCard.questId}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.open(shareCard.targetUrl, '_blank', 'noopener,noreferrer');
  };

  const shareImage = async () => {
    if (!shareCard || !navigator.share) return;
    const file = new File([shareCard.image], `heroloop-squad-${shareCard.questId}.png`, { type: 'image/png' });
    try { await navigator.share({ files: [file], title: 'My HeroLoop squad' }); } catch { /* The player may cancel the share sheet. */ }
  };

  const submit = (quest: PartnerQuest) => void run(quest.id, async () => {
    let code = '';
    const proof = NEEDS_PROOF[quest.kind] ? (proofs[quest.id] ?? '').trim() : null;
    if (NEEDS_PROOF[quest.kind] && !proof) return 'partner_proof_invalid';
    const submitted = await playerSync('partner_quest_submit', { quest_id: quest.id, proof }, (error) => { code = error; });
    return submitted ? null : code || 'unavailable';
  });

  return (
    <section className="partner-quests mb-2" aria-label="Special Quests">
      <div className="section-kicker mb-1 flex items-center gap-1 text-[#e9c97a]"><Sparkles size={11} /> Special Quests</div>
      <div className="space-y-1">
        {data.quests.map((quest) => {
          const missingLink = quest.requires && !data.links[quest.requires];
          const rewards = Object.entries(quest.reward).filter(([, value]) => value > 0);
          const canSubmit = quest.status === 'started' || (quest.status === 'rejected' && quest.can_resubmit);
          return (
            <div key={quest.id} className="partner-quest-card px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="ui-text-medium min-w-0 flex-1 truncate font-bold leading-tight text-[#f5e3b5]" title={quest.title}>{quest.title}</span>
                <span className="ui-text-small flex shrink-0 items-center gap-0.5 text-[#c9a8f0]"><Clock3 size={10} />{timeLeft(quest.ends_at, now)}</span>
              </div>
              {quest.body && <p className="ui-text-small mt-0.5 leading-snug text-[#bdb3a3]">{quest.body}</p>}
              <div className="ui-text-small mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#f1d188]">
                {rewards.map(([key, value]) => (
                  <span key={key} className="flex items-center gap-0.5" title={REWARD_LABEL[key] ?? key}>
                    {REWARD_ICON[key] ?? <FlaskConical size={10} />}{formatNum(value)}{REWARD_ICON[key] ? '' : ` ${REWARD_LABEL[key] ?? key}`}
                  </span>
                ))}
              </div>

              {missingLink && quest.status === null && (
                <div className="ui-text-small mt-1 rounded border border-[#7a5bb0]/60 bg-[#231a33]/70 px-1.5 py-1 text-[#d9c8f5]">
                  Link your {PROVIDER_LABEL[quest.requires as SocialProvider]} account in BOOST MAX first.
                  <button type="button" onClick={onOpenBoostMax} className="ml-1 font-bold text-[#f1d188] underline">Open BOOST MAX</button>
                </div>
              )}
              {!missingLink && (quest.status === null || quest.status === 'started') && !quest.full && (
                <button type="button" disabled={busy === quest.id} onClick={() => go(quest)} className="game-control partner-quest-go ui-text-medium mt-1 flex min-h-7 w-full items-center justify-center gap-1 px-2 py-0.5 font-bold">
                  <ExternalLink size={12} /> {quest.status === 'started' ? 'Open task again' : 'Go'}
                </button>
              )}
              {quest.full && quest.status === null && <div className="ui-text-small mt-1 text-[#8f887b]">All rewards have been claimed.</div>}
              {canSubmit && (
                <form className="mt-1 flex gap-1" onSubmit={(event) => { event.preventDefault(); submit(quest); }}>
                  {NEEDS_PROOF[quest.kind] && (
                    <input value={proofs[quest.id] ?? ''} onChange={(event) => setProofs((current) => ({ ...current, [quest.id]: event.target.value }))}
                      maxLength={300} inputMode="url" placeholder={PROOF_HINT[quest.kind]} aria-label={PROOF_HINT[quest.kind]}
                      className="game-control ui-text-small min-h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[#f4e6c7] outline-none placeholder:text-[#6f675b]" />
                  )}
                  <button type="submit" disabled={busy === quest.id} className="game-control game-primary ui-text-small min-h-7 shrink-0 px-2 font-bold">
                    {NEEDS_PROOF[quest.kind] ? 'Submit' : 'I did it'}
                  </button>
                </form>
              )}
              {quest.status === 'rejected' && quest.review_note && (
                <div className="ui-text-small mt-1 text-red-300">Rejected: {quest.review_note}{quest.can_resubmit ? ' — you can submit once more.' : ''}</div>
              )}
              {quest.status === 'pending' && <div className="ui-text-small mt-1 flex items-center gap-1 text-[#c9a8f0]"><Hourglass size={10} /> Under review</div>}
              {quest.status === 'approved' && (
                <button type="button" disabled={busy === quest.id} onClick={() => void run(quest.id, () => claim(quest.id))} className="game-control game-primary ui-text-medium mt-1 min-h-7 w-full px-2 py-0.5 font-bold">Claim reward</button>
              )}
              {quest.status === 'claimed' && <div className="ui-text-small mt-1 flex items-center gap-1 text-emerald-300"><CheckCircle2 size={10} /> Reward claimed</div>}
              {errors[quest.id] && <div role="alert" className="ui-text-small mt-1 text-red-300">{errors[quest.id]}</div>}
            </div>
          );
        })}
      </div>
      {shareCard && createPortal((
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Share your HeroLoop squad">
          <div className="game-control w-full max-w-xl space-y-3 p-4">
            <div className="flex items-center justify-between gap-3"><h3 className="ui-text-medium font-bold text-[#f1d188]">Share your HeroLoop squad</h3>
              <button type="button" autoFocus onClick={() => setShareCard(null)} aria-label="Close share image" className="game-control grid h-9 w-9 place-items-center"><X size={16} /></button>
            </div>
            <img src={shareCard.imageUrl} alt="Your HeroLoop squad share image" className="w-full rounded border border-[#a98446]" />
            <p className="ui-text-medium text-[#bdb3a3]">Download the image, attach it to your X post, then paste that post's link here for review.</p>
            <button type="button" onClick={downloadShareCard} className="game-control game-primary flex min-h-11 w-full items-center justify-center gap-2 ui-text-medium font-bold"><Download size={16} /> Download image &amp; open X</button>
            {typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([shareCard.image], 'heroloop-squad.png', { type: 'image/png' })] }) && (
              <button type="button" onClick={() => void shareImage()} className="game-control flex min-h-11 w-full items-center justify-center ui-text-medium font-bold">Share image</button>
            )}
          </div>
        </div>
      ), document.body)}
    </section>
  );
}
