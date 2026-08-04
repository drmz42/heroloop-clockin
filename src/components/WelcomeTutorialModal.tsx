import { useState } from 'react';
import { ChevronRight, Coins, Shield, Sparkles, Swords, X } from 'lucide-react';
import type { GameApi } from '@/game/useGame';

const STEPS = [
  { title: 'Enter the fight', text: 'Your active heroes battle automatically. Keep an eye on their levels, health and the current location in the Play screen.', Icon: Swords, accent: '#e4b55d' },
  { title: 'Build your formation', text: 'Open Heroes to choose up to three fighters. Equipment, stars and hero levels shape your total team Power.', Icon: Shield, accent: '#83b7e8' },
  { title: 'Turn loot into power', text: 'Battles earn Gold, XP and chests. Open chests, equip level-appropriate gear and keep improving your lineup.', Icon: Coins, accent: '#cf85dc' },
  { title: 'Grow beyond the battlefield', text: 'Summon new heroes, use the Training Camp for reserve heroes and watch your $HERO earnings in the footer.', Icon: Sparkles, accent: '#b5df83' },
];

export function WelcomeTutorialModal({ game }: { game: GameApi }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const Icon = current.Icon;
  const last = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/75 p-4 backdrop-blur-[5px]" role="dialog" aria-modal="true" aria-labelledby="welcome-tutorial-title">
      <section className="welcome-tutorial relative w-full max-w-lg overflow-hidden rounded-2xl border border-[#9a6a22] p-5 shadow-[0_24px_90px_rgba(0,0,0,.85)]">
        <button type="button" onClick={game.completeWelcomeTutorial} className="game-control absolute right-3 top-3 grid h-8 w-8 place-items-center" aria-label="Close tutorial"><X size={15} /></button>
        <div className="section-kicker">First expedition · {step + 1}/{STEPS.length}</div>
        <div className="mt-5 flex items-start gap-4"><div className="welcome-tutorial-icon" style={{ color: current.accent, borderColor: `${current.accent}88`, boxShadow: `0 0 25px ${current.accent}22` }}><Icon size={30} /></div><div className="min-w-0"><h2 id="welcome-tutorial-title" className="font-vt text-2xl font-black text-[#f4d991]">{current.title}</h2><p className="mt-2 text-sm leading-6 text-[#c1b6a2]">{current.text}</p></div></div>
        <div className="mt-6 flex gap-1.5" aria-label="Tutorial progress">{STEPS.map((item, index) => <span key={item.title} className={`h-1.5 flex-1 rounded-full ${index <= step ? 'bg-[#d8a849]' : 'bg-[#4c4030]'}`} />)}</div>
        <div className="mt-5 flex items-center justify-between gap-3"><span className="text-[10px] text-[#817665]">You can revisit the systems from the top menu.</span><button type="button" onClick={() => last ? game.completeWelcomeTutorial() : setStep((value) => value + 1)} className="game-control game-primary flex h-9 items-center gap-2 px-4 text-xs font-black">{last ? 'Start expedition' : 'Next'} {!last && <ChevronRight size={14} />}</button></div>
      </section>
    </div>
  );
}
