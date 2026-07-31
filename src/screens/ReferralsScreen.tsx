import { useState } from 'react';
import { Users, Copy, Check, Gift, Zap, TrendingUp } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { GameApi } from '@/game/useGame';

export function ReferralsScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [copied, setCopied] = useState(false);
  const ref = state.referral;
  const refLink = `https://heroloop.app/r/${ref.code}`;

  const copy = () => {
    navigator.clipboard?.writeText(refLink).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Generate mock invitees if none
  const invitees = ref.invitedUsers.length > 0 ? ref.invitedUsers : [
    { username: 'CryptoWarrior', level: 12, active: true },
    { username: 'PixelHunter', level: 8, active: true },
    { username: 'SolRider', level: 3, active: false },
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto no-scrollbar scanlines">
      {/* Hero banner */}
      <div className="px-4 py-3 border-b-2 border-px-border bg-px-panel shrink-0">
        <h2 className="font-pixel text-sm text-gold-glow flex items-center gap-2"><Users size={16} className="text-px-bright" /> REFERRALS</h2>
        <p className="font-vt text-px-dim text-xs mt-1">Invite friends. Earn 10% of their $HERO earnings forever.</p>
      </div>

      <div className="p-4 space-y-4 max-w-2xl mx-auto w-full">
        {/* Referral link card */}
        <div className="px-panel-raised p-4">
          <div className="font-vt text-px-dim text-sm mb-2">YOUR REFERRAL LINK</div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={refLink}
              className="flex-1 px-3 py-2 bg-px-bg border-2 border-px-border text-px-text font-vt text-sm focus:outline-none"
            />
            <button onClick={copy} className="px-btn px-3 py-2 text-sm font-bold flex items-center gap-1.5">
              {copied ? <Check size={14} className="text-px-green" /> : <Copy size={14} />}
              {copied ? 'COPIED' : 'COPY'}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="font-vt text-px-dim text-xs">CODE:</span>
            <span className="px-tag font-pixel text-[10px]">{ref.code}</span>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatBox label="INVITED" value={String(invitees.length)} icon={<Users size={14} />} />
          <StatBox label="ACTIVE" value={String(invitees.filter(i => i.active).length)} icon={<TrendingUp size={14} />} />
          <StatBox label="EARNED" value={formatNum(ref.totalEarned + ref.pendingReward) + ' $HERO'} icon={<Zap size={14} />} />
          <StatBox label="PENDING" value={formatNum(ref.pendingReward) + ' $HERO'} icon={<Gift size={14} />} />
        </div>

        {/* Claim button */}
        {ref.pendingReward > 0 && (
          <button
            onClick={game.claimReferralReward}
            className="w-full py-3 px-btn text-base font-bold flex items-center justify-center gap-2 anim-glow"
          >
            <Gift size={18} /> CLAIM {formatNum(ref.pendingReward)} $HERO
          </button>
        )}

        {/* How it works */}
        <div className="px-panel p-3">
          <div className="font-pixel text-[10px] text-px-bright mb-2">HOW IT WORKS</div>
          <ul className="font-vt text-sm text-px-dim space-y-1">
            <li>1. Share your link with friends</li>
            <li>2. They connect wallet & start playing</li>
            <li>3. You earn 10% of their $HERO token earnings</li>
            <li>4. Claim accumulated rewards anytime</li>
            <li>5. Top referrers get bonus $HERO at month end</li>
          </ul>
        </div>

        {/* Invited users list */}
        <div>
          <div className="font-pixel text-[10px] text-px-bright mb-2">INVITED PLAYERS ({invitees.length})</div>
          <div className="space-y-1.5">
            {invitees.map((u, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 px-panel" style={{ boxShadow: '2px 2px 0 #2a1504' }}>
                <div className="w-8 h-8 border-2 border-px-border bg-px-panel2 flex items-center justify-center font-pixel text-[8px] text-px-text">{u.username.slice(0, 2).toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-vt text-sm font-bold text-px-text truncate">{u.username}</div>
                  <div className="font-vt text-[10px] text-px-dim">Level {u.level}</div>
                </div>
                <div className={`px-2 py-0.5 border text-[9px] font-vt font-bold ${u.active ? 'border-px-green text-px-green bg-px-green/10' : 'border-px-border text-px-dim bg-px-panel2'}`}>
                  {u.active ? 'ACTIVE' : 'INACTIVE'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="px-panel p-2.5 text-center" style={{ boxShadow: '2px 2px 0 #2a1504' }}>
      <div className="flex items-center justify-center gap-1 text-px-bright mb-1">{icon}</div>
      <div className="font-vt text-base font-bold text-px-text">{value}</div>
      <div className="font-vt text-[9px] text-px-dim uppercase tracking-wider">{label}</div>
    </div>
  );
}
