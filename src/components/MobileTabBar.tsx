import { useEffect, useState } from 'react';
import { Backpack, BookOpen, Dumbbell, KeyRound, LogOut, Menu, MessageCircle, ScrollText, Shield, ShoppingBag, Sparkles, Store, Swords, Trophy, UserPlus, X } from 'lucide-react';
import type { Tab } from './TopMenu';
import { setMobileSection, type MobileSection } from '@/platform/platform';
import { defaultUiTheme, setUiTheme } from '@/theme/uiTheme';

// Android layout only (src/platform/platform.ts): the phone's primary navigation.
// Battle, Quests and Bag switch the Play screen between its three columns; Heroes
// and Summon open their windows; More holds every other window and the footer links.
const MORE_TABS = [
  { id: 'training', label: 'Training', icon: Dumbbell },
  // Crafting has no recipes yet (its window says so); the phone menu shows only working screens.
  { id: 'shop', label: 'Store', icon: ShoppingBag },
  { id: 'market', label: 'Market', icon: Store },
  { id: 'leaderboard', label: 'Ranks', icon: Trophy },
  { id: 'referrals', label: 'Refer', icon: UserPlus },
] satisfies { id: Tab; label: string; icon: typeof Shield }[];

export function MobileTabBar({
  tab, section, moreOpen, onTab, onSection, onMoreOpen, onGuides, onCode, onSupport, onLogout,
}: {
  tab: Tab;
  section: MobileSection;
  moreOpen: boolean;
  onTab: (tab: Tab) => void;
  onSection: (section: MobileSection) => void;
  onMoreOpen: (open: boolean) => void;
  onGuides: () => void;
  onCode: () => void;
  onSupport: () => void;
  onLogout: () => void;
}) {
  useEffect(() => { setMobileSection(section); }, [section]);
  const moreActive = moreOpen || MORE_TABS.some((entry) => entry.id === tab);
  const sectionButton = (id: MobileSection, label: string, Icon: typeof Shield) => {
    const active = tab === 'main' && !moreOpen && section === id;
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => { onMoreOpen(false); onTab('main'); onSection(id); }}>
        <Icon size={20} aria-hidden="true" /><span>{label}</span>
      </button>
    );
  };
  const windowButton = (id: Tab, label: string, Icon: typeof Shield) => {
    const active = tab === id && !moreOpen;
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => { onMoreOpen(false); onTab(id); }}>
        <Icon size={20} aria-hidden="true" /><span>{label}</span>
      </button>
    );
  };
  const [themeLabel] = useState(() => document.documentElement.dataset.hlTheme === 'premium' ? 'Classic UI' : 'Premium UI');

  return (
    <>
      {moreOpen && (
        <div className="hl-more-sheet" role="dialog" aria-modal="true" aria-label="More" onMouseDown={(event) => { if (event.currentTarget === event.target) onMoreOpen(false); }}>
          <div className="hl-more-panel">
            <div className="hl-more-head">
              <span className="section-kicker">More</span>
              <button type="button" className="game-control hl-more-close" onClick={() => onMoreOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="hl-more-grid">
              {MORE_TABS.map((entry) => {
                const Icon = entry.icon;
                return (
                  <button key={entry.id} type="button" className={`game-control hl-more-item ${tab === entry.id ? 'is-active' : ''}`} onClick={() => { onMoreOpen(false); onTab(entry.id); }}>
                    <Icon size={22} aria-hidden="true" /><span>{entry.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="hl-more-links">
              <button type="button" className="game-control" onClick={() => { onMoreOpen(false); onGuides(); }}><BookOpen size={16} aria-hidden="true" /> Guides</button>
              <button type="button" className="game-control" onClick={() => { onMoreOpen(false); onCode(); }}><KeyRound size={16} aria-hidden="true" /> Code</button>
              <button type="button" className="game-control" onClick={() => { onMoreOpen(false); onSupport(); }}><MessageCircle size={16} aria-hidden="true" /> Support</button>
              {defaultUiTheme === 'premium' && <button type="button" className="game-control" onClick={() => setUiTheme(document.documentElement.dataset.hlTheme === 'premium' ? 'classic' : 'premium')}>{themeLabel}</button>}
              <button type="button" className="game-control game-danger" onClick={() => { onMoreOpen(false); onLogout(); }}><LogOut size={16} aria-hidden="true" /> Logout</button>
            </div>
          </div>
        </div>
      )}
      <nav className="hl-tabbar" aria-label="Game navigation">
        {sectionButton('battle', 'Battle', Swords)}
        {sectionButton('quests', 'Quests', ScrollText)}
        {sectionButton('bag', 'Bag', Backpack)}
        {windowButton('heroes', 'Heroes', Shield)}
        {windowButton('summon', 'Summon', Sparkles)}
        <button type="button" className={`hl-tabbar-item ${moreActive ? 'is-active' : ''}`} aria-expanded={moreOpen} onClick={() => onMoreOpen(!moreOpen)}>
          <Menu size={20} aria-hidden="true" /><span>More</span>
        </button>
      </nav>
    </>
  );
}
