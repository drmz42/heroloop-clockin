import { useState } from 'react';
import { Users, Copy, Check, Gift } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

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

  return (
    <div className="themed-screen themed-screen-referrals flex h-full flex-col overflow-y-auto no-scrollbar">
      <div className="shrink-0 border-b border-[#4f412e] px-4 py-3">
        <h2 className="flex items-center gap-2 font-pixel text-sm text-gold-glow"><Users size={16} /> Referrals</h2>
        <p className="mt-1 font-vt text-xs text-px-dim">Invite heroes · earn 3 tiers deep on eligible $HERO earnings.</p>
      </div>

      <div className="mx-auto w-full max-w-2xl space-y-3 p-4">
        <div className="rounded-xl border border-[#9a6a22] bg-[#17130d] p-3">
          <div className="grid grid-cols-[72px_1fr_auto] items-center gap-2 text-sm">
            <span className="text-[10px] font-bold uppercase text-px-dim">Your code</span>
            <strong className="font-pixel text-base tracking-widest text-[#ffd268]">{ref.code}</strong>
            <button onClick={() => copy('code')} className="game-control min-h-9 px-3 font-bold">{copied === 'code' ? <Check size={14} /> : <Copy size={14} />} Copy</button>
            <span className="text-[10px] font-bold uppercase text-px-dim">Your link</span>
            <span className="truncate font-vt text-xs text-px-text">{refLink}</span>
            <button onClick={() => copy('link')} className="game-control min-h-9 px-3 font-bold">{copied === 'link' ? <Check size={14} /> : <Copy size={14} />} Copy</button>
          </div>
        </div>

        <div className="stat-tile flex items-center justify-between gap-3 p-3">
          <div><div className="text-[10px] font-bold uppercase text-px-dim">Claimable now</div><div className="flex items-center gap-2 font-vt text-2xl font-bold text-[#ffd268]"><HeroTokenIcon size={18} />{formatNum(ref.pendingReward)} <span className="text-xs">$HERO</span></div></div>
          <button onClick={game.claimReferralReward} disabled={ref.pendingReward <= 0} className="game-primary min-h-11 rounded-lg px-6 font-bold"><Gift size={16} className="inline" /> Claim</button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatBox label="Tier 1 · 8%" value={String(invitees.length)} icon={<Users size={14} />} />
          <StatBox label="Tier 2 · 3%" value="0" icon={<Users size={14} />} />
          <StatBox label="Tier 3 · 1%" value="0" icon={<Users size={14} />} />
          <StatBox label="Total team" value={String(invitees.length)} icon={<Users size={14} />} />
        </div>

        <div className="stat-tile p-3">
          <div className="mb-2 font-pixel text-[10px] text-px-bright">EARNINGS BY TIER</div>
          <div className="grid grid-cols-2 gap-y-1 border-b border-[#3f3527] pb-2 font-vt text-sm"><span className="text-px-dim">Tier 1 · 8%</span><b className="text-right">{formatNum(ref.totalEarned + ref.pendingReward)}</b><span className="text-px-dim">Tier 2 · 3%</span><b className="text-right">0</b><span className="text-px-dim">Tier 3 · 1%</span><b className="text-right">0</b></div>
          <div className="mt-2 grid grid-cols-2 font-vt text-sm"><span className="text-px-dim">Already claimed</span><b className="text-right">{formatNum(ref.alreadyClaimed)}</b></div>
        </div>

        <div className="stat-tile p-3">
          <div className="mb-2 font-pixel text-[10px] text-px-bright">YOUR DIRECT INVITES ({invitees.length})</div>
          <div className="space-y-1.5">
            {invitees.length === 0 && <div className="intentional-empty p-3 text-center font-vt text-sm text-px-dim">No direct invites yet. Share your referral link.</div>}
            {invitees.map((u, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md border border-[#443722] bg-black/20 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="font-vt text-sm font-bold text-px-text truncate">{u.username}</div>
                </div>
                <span className="font-vt text-xs text-px-dim">Lv {u.level}</span>
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
    <div className="stat-tile p-2.5 text-center">
      <div className="flex items-center justify-center gap-1 text-px-bright mb-1">{icon}</div>
      <div className="font-vt text-base font-bold text-px-text">{value}</div>
      <div className="font-vt text-[9px] text-px-dim uppercase tracking-wider">{label}</div>
    </div>
  );
}
