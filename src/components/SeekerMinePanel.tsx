import { useState } from 'react';
import { AlertTriangle, BookOpen, ChevronDown, Lock, Pickaxe } from 'lucide-react';
import { MINE_GUIDE, MINE_LIMIT_ROWS, MINE_STAKE_TIERS, type MineStakeTier } from '@/game/seekerMine';

// Preview of the ORE Mine. No session, round or SOL movement can start from here.
export function SeekerMinePanel() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [stake, setStake] = useState<MineStakeTier>(MINE_STAKE_TIERS[0]);

  return (
    <>
      <div className="stat-tile flex items-start gap-2.5 p-3">
        <Pickaxe size={18} className="mt-0.5 shrink-0 text-[#e0a83c]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-black text-[#f6d283]">ORE Mine</h3>
            <span className="rounded-full border border-[#5d4a2f] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#aaa397]">Coming soon</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#d9d1c0]">Play one-minute ORE rounds on Solana with your in-game SOL. Read the guide before you start.</p>
        </div>
      </div>

      <button type="button" aria-expanded={guideOpen} aria-controls="seeker-mine-guide" onClick={() => setGuideOpen(open => !open)}
        className="game-control flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-sm font-bold text-[#f6d283]">
        <span className="flex items-center gap-2"><BookOpen size={15} aria-hidden="true" /> Guide &amp; Terms</span>
        <ChevronDown size={15} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${guideOpen ? 'rotate-180' : ''}`} />
      </button>
      {guideOpen && (
        <div id="seeker-mine-guide" className="stat-tile space-y-2.5 p-3 text-xs leading-5">
          {MINE_GUIDE.map(section => (
            <section key={section.title}>
              <h4 className={`font-black ${section.title.startsWith('Risks') ? 'text-rose-200' : 'text-[#f6d283]'}`}>{section.title}</h4>
              <p className="text-[#d9d1c0]">{section.body}</p>
            </section>
          ))}
          <p className="text-[#aaa397]">Before your first session you will be asked to confirm that you have read these terms.</p>
        </div>
      )}

      <fieldset className="stat-tile p-3">
        <legend className="float-left mb-2 w-full text-xs font-bold text-[#aaa397]">Stake per round</legend>
        <div className="clear-both grid grid-cols-3 gap-2">
          {MINE_STAKE_TIERS.map(tier => (
            <button key={tier} type="button" aria-pressed={stake === tier} onClick={() => setStake(tier)}
              className={`game-control min-h-11 px-2 text-sm font-black tabular-nums ${stake === tier ? 'text-[#f6d283] ring-1 ring-[#e0a83c]' : 'text-[#8f887b]'}`}>
              {tier} SOL
            </button>
          ))}
        </div>
      </fieldset>

      <dl className="stat-tile grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 p-3 text-xs">
        {MINE_LIMIT_ROWS.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[#aaa397]">{label}</dt>
            <dd className="text-right font-bold tabular-nums text-[#d9d1c0]">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>A game of chance: you can lose the SOL you stake. Only use SOL you can afford to lose.</span>
      </div>

      <button type="button" disabled
        className="game-control flex min-h-12 w-full items-center justify-center gap-2 px-4 py-3 font-black text-[#f6d283] disabled:opacity-45">
        <Lock size={16} aria-hidden="true" /> Mining opens soon
      </button>
    </>
  );
}
