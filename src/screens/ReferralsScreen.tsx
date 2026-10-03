import { isolatedHackathon } from '@/game/editionStorage';
import { useState, type CSSProperties } from 'react';
import { Users, Copy, Check, Gift } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import '@/theme/scene/scene.css';

export function ReferralsScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const ref = state.referral;
  const refLink = `http://heroloop.xyz/?ref=${ref.code}`;

  const copy = (kind: 'code' | 'link') => {
    navigator.clipboard?.writeText(kind === 'code' ? ref.code : refLink).catch(() => {});
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  };
  const invitees = ref.invitedUsers;

  const still = state.battleAnimationMode === 'off';

  return (
    <div className={`sc-root rf-root${still ? ' sc-still' : ''}`}>
      <section className="sc-stage rf-guild" aria-label="Guild Hall">
        <div className="sc-stage-art" aria-hidden="true" />
        <div className="sc-glow" aria-hidden="true" />
        {!still && <div className="sc-embers" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
        <header className="sc-head"><span className="sc-kicker">The Guild Hall</span><h2 className="sc-title">Referrals</h2><p className="sc-lede">{isolatedHackathon ? 'Invite friends. SKR referral rewards are not available yet.' : 'Invite heroes · earn 3 tiers deep on eligible $HERO earnings.'}</p></header>
        <div className="rf-tiers">
          <StatBox label="Tier 1 · 8%" value={String(invitees.length)} icon={<Users size={14} />} />
          <StatBox label="Tier 2 · 3%" value="0" icon={<Users size={14} />} />
          <StatBox label="Tier 3 · 1%" value="0" icon={<Users size={14} />} />
        </div>
      </section>

      <div className="sc-body">
        <section className="sc-panel rf-invite">
          <div className="sc-section-head"><span>Invite friends</span><span className="rf-total">Total team <b>{invitees.length}</b></span></div>
          <ReferralField label="Your code" value={ref.code} copied={copied === 'code'} onCopy={() => copy('code')} code />
          <ReferralField label="Your link" value={refLink} copied={copied === 'link'} onCopy={() => copy('link')} />
        </section>

        <section className="sc-panel rf-claim">
          <div><span className="rf-label">Claimable now</span><b className="rf-amount"><HeroTokenIcon size={18} />{(isolatedHackathon ? '—' : formatNum(ref.pendingReward))} <small>$HERO</small></b></div>
          <button type="button" onClick={game.claimReferralReward} disabled={isolatedHackathon || ref.pendingReward <= 0} className="sc-seal rf-claim-btn"><Gift size={15} /> Claim</button>
        </section>

        <section className="sc-panel">
          <div className="sc-section-head"><span>Earnings by tier</span></div>
          <dl className="rf-ledger"><div><dt>Tier 1 · 8%</dt><dd>{(isolatedHackathon ? '—' : formatNum(ref.totalEarned + ref.pendingReward))}</dd></div><div><dt>Tier 2 · 3%</dt><dd>0</dd></div><div><dt>Tier 3 · 1%</dt><dd>0</dd></div><div className="rf-ledger-total"><dt>Already claimed</dt><dd>{(isolatedHackathon ? '—' : formatNum(ref.alreadyClaimed))}</dd></div></dl>
        </section>

        <section className="sc-panel">
          <div className="sc-section-head"><span>Your direct invites ({invitees.length})</span></div>
          {invitees.length === 0 && <p className="rf-empty">No direct invites yet. Share your referral link.</p>}
          <ul className="rf-list">
            {invitees.map((u, i) => (
              <li key={i}><b>{u.username}</b><span>Lv {u.level}</span><em className={u.active ? 'is-active' : ''}>{u.active ? 'ACTIVE' : 'INACTIVE'}</em></li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ReferralField({ label, value, copied, onCopy, code = false }: { label: string; value: string; copied: boolean; onCopy: () => void; code?: boolean }) {
  return (
    <div className="rf-field">
      <span className="rf-label">{label}</span>
      <div className="rf-field-row">
        <span className={`rf-value${code ? ' is-code' : ''}`}><span>{value}</span></span>
        <button type="button" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} className="sc-plate rf-copy">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
    </div>
  );
}

function StatBox({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rf-tier">
      <span className="rf-tier-medal">{icon}<b>{value}</b></span>
      <span className="rf-tier-label">{label}</span>
    </div>
  );
}
