import { goldHealingEnabled } from '../../managed/functions/player-sync/automatic-healing.mjs';
import { isolatedHackathon } from '@/game/editionStorage';
import type { GameApi } from '@/game/useGame';

// Automatic healing and battle graphics. Seeker shows them in More (Founder 2026-10-08);
// the web keeps the settings button in the battle HUD.
export function BattleSettings({ game, onPicked }: { game: GameApi; onPicked?: () => void }) {
  const { state } = game;
  return (
    <>
      {isolatedHackathon && <section className="mb-2 border-b border-[#80683f]/50 pb-2" aria-label="Healing settings">
        <h3 className="ui-text-medium font-bold text-emerald-300">Automatic healing</h3>
        <p className="my-1 ui-text-small leading-relaxed text-[#c4bba7]">At 50% HP or below, a hero drinks one Ordinary Potion. It restores 100% maximum HP over 20 seconds, with a 30-second cooldown from drinking.</p>
        <label className="flex items-center gap-2 py-1 ui-text-medium text-[#e8decd]"><input type="checkbox" checked={goldHealingEnabled(state.autoPot)} onChange={event => game.setAutoPot({ enabled: true, goldHealingOptOut: !event.target.checked, healingInfoSeen: true })} className="h-4 w-4 accent-emerald-400" /> Spend Gold on healing</label>
        <p className="ui-text-small leading-relaxed text-[#9e9687]">Stock first; then 3 Gold per bottle if enabled. Healing arrives every 5 seconds. Damage continues during healing. Normal battles only; no potions in Boss Hunts or Dungeons. Changes apply next wave.</p>
      </section>}
      <div className="mb-1.5 ui-text-small font-black uppercase tracking-[.14em] text-[#efd18a]">Battle graphics</div>
      {([
        ['spectacular', 'Maximum', 'Full battle movement, glows and effects'],
        ['light', 'Medium', 'Battle effects stay; decorative glows rest. Saves battery'],
        ['off', 'Minimum', 'Static portraits; essential feedback only. Best battery life'],
      ] as const).map(([mode, label, description]) => <button key={mode} type="button" onClick={() => { game.setBattleAnimationMode(mode); onPicked?.(); }} className={`mt-1 w-full rounded-md border px-2 py-1.5 text-left ${state.battleAnimationMode === mode ? 'border-amber-400/60 bg-amber-400/12' : 'border-white/10 bg-black/25 hover:border-white/20'}`} aria-pressed={state.battleAnimationMode === mode}><span className="block ui-text-small font-black text-[#e8decd]">{label}</span><span className="block ui-text-small text-[#8f887b]">{description}</span></button>)}
    </>
  );
}
