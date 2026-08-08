import { Sword, Users, Sparkles, Store, ShoppingCart, Trophy, Gift, Dumbbell } from 'lucide-react';

export type Tab = 'main' | 'heroes' | 'summon' | 'training' | 'crafting' | 'shop' | 'market' | 'leaderboard' | 'referrals';

const TABS: { id: Tab; label: string; icon: typeof Sword }[] = [
  { id: 'main',        label: 'Play',    icon: Sword    },
  { id: 'heroes',      label: 'Heroes',  icon: Users    },
  { id: 'summon',      label: 'Summon',  icon: Sparkles },
  { id: 'training',    label: 'Training', icon: Dumbbell },
  { id: 'shop',        label: 'Store',   icon: Store    },
  { id: 'market',      label: 'Market',  icon: ShoppingCart },
  { id: 'leaderboard', label: 'Ranks',   icon: Trophy   },
  { id: 'referrals',   label: 'Refer',   icon: Gift     },
];

export function TopMenu({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="flex items-center justify-center gap-0.5 px-2 py-1 bg-px-panel border-b-2 border-px-border shrink-0 overflow-x-auto no-scrollbar">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`relative flex items-center gap-1.5 px-2.5 py-1.5 font-vt text-sm font-bold tracking-wide whitespace-nowrap border-2 transition-none ${active ? 'px-btn-active bg-px-gold/20 border-px-bright text-px-bright' : 'border-transparent text-px-dim hover:text-px-text hover:bg-px-panel2'}`}
          >
            <Icon size={15} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
