import { Hammer, LockKeyhole } from 'lucide-react';

export function CraftingScreen() {
  return (
    <div className="premium-screen game-scrollbar h-full overflow-y-auto p-3">
      <div className="material-panel mx-auto max-w-3xl p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-lg border border-[#8f6933] bg-black/30 text-[#e2b45f]"><Hammer size={24} /></span>
          <div><div className="section-kicker">Crafting</div><h2 className="text-xl font-black text-[#eee2ce]">Forge</h2></div>
        </div>
        <div className="mt-5 rounded-lg border border-[#59462e] bg-black/25 p-4 text-center">
          <LockKeyhole className="mx-auto text-[#a88a59]" size={24} />
          <p className="mt-2 text-sm font-bold text-[#d4c6b1]">Recipes are not defined yet</p>
          <p className="mt-1 text-xs text-[#8f887d]">Crafting cannot consume items or resources until recipes and server settlement are approved.</p>
        </div>
      </div>
    </div>
  );
}
