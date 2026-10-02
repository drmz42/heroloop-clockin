import { useEffect, useState } from 'react';
import { Backpack, BookOpen, Dumbbell, KeyRound, LogOut, Menu, MessageCircle, Pickaxe, ScrollText, Shield, ShoppingBag, Sparkles, Store, Swords, Trophy, UserPlus, X } from 'lucide-react';
import type { Tab } from './TopMenu';
import { setMobileSection, type MobileSection } from '@/platform/platform';
import { defaultUiTheme, setUiTheme } from '@/theme/uiTheme';

// Android layout only (src/platform/platform.ts): the phone's primary navigation, two rows
// (Founder 2026-10-02). Row 1: Battle, Quests and Bag switch the Play screen between its three
// columns; Heroes, Summon and Market open their windows. Row 2: Training, Store, the upcoming
// $ORE Mine (slightly highlighted), Ranks, Refer, and More with the footer links.
export function MobileTabBar({
  tab, section, moreOpen, onTab, onSection, onMoreOpen, onGuides, onCode, onSupport, onLogout, readyQuests = 0,
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
  readyQuests?: number;
}) {
  const [mineOpen, setMineOpen] = useState(false);
  useEffect(() => { setMobileSection(section); }, [section]);
  // While a window covers the Play screen, the screen underneath is not painted (android.css):
  // a phone WebView left the Bag grid showing through an unfinished Summon window.
  useEffect(() => {
    if (tab === 'main') delete document.documentElement.dataset.hlWindow;
    else document.documentElement.dataset.hlWindow = tab;
    return () => { delete document.documentElement.dataset.hlWindow; };
  }, [tab]);
  const sectionButton = (id: MobileSection, label: string, Icon: typeof Shield) => {
    const active = tab === 'main' && !moreOpen && !mineOpen && section === id;
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''} ${id === 'quests' && readyQuests > 0 ? 'quest-reward-ready' : ''}`} aria-current={active ? 'page' : undefined} aria-label={id === 'quests' && readyQuests > 0 ? `Quests, ${readyQuests} rewards ready` : label} onClick={() => { onMoreOpen(false); setMineOpen(false); onTab('main'); onSection(id); }}>
        <Icon size={20} aria-hidden="true" /><span>{label}</span>
        {id === 'quests' && readyQuests > 0 && <b className="hl-quest-ready-badge" aria-hidden="true">{readyQuests}</b>}
      </button>
    );
  };
  const windowButton = (id: Tab, label: string, Icon: typeof Shield) => {
    const active = tab === id && !moreOpen && !mineOpen;
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => { onMoreOpen(false); setMineOpen(false); onTab(id); }}>
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
      {mineOpen && (
        <div className="hl-more-sheet" role="dialog" aria-modal="true" aria-label="$ORE Mine" onMouseDown={(event) => { if (event.currentTarget === event.target) setMineOpen(false); }}>
          <div className="hl-more-panel">
            <div className="hl-more-head">
              <span className="section-kicker">$ORE Mine</span>
              <button type="button" className="game-control hl-more-close" onClick={() => setMineOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="hl-mine-soon"><Pickaxe size={34} aria-hidden="true" /><strong>Coming soon</strong><span>The $ORE Mine opens in a future update.</span></div>
          </div>
        </div>
      )}
      <nav className="hl-tabbar" aria-label="Game navigation">
        {sectionButton('battle', 'Battle', Swords)}
        {sectionButton('quests', 'Quests', ScrollText)}
        {sectionButton('bag', 'Bag', Backpack)}
        {windowButton('heroes', 'Heroes', Shield)}
        {windowButton('summon', 'Summon', Sparkles)}
        {windowButton('market', 'Market', Store)}
        {windowButton('training', 'Training', Dumbbell)}
        {windowButton('shop', 'Store', ShoppingBag)}
        <button type="button" className={`hl-tabbar-item hl-tabbar-mine ${mineOpen ? 'is-active' : ''}`} aria-expanded={mineOpen} aria-label="$ORE Mine, coming soon" onClick={() => { onMoreOpen(false); setMineOpen(!mineOpen); }}>
          <Pickaxe size={20} aria-hidden="true" /><span>Mine</span><b className="hl-mine-badge" aria-hidden="true">Soon</b>
        </button>
        {windowButton('leaderboard', 'Ranks', Trophy)}
        {windowButton('referrals', 'Refer', UserPlus)}
        <button type="button" className={`hl-tabbar-item ${moreOpen ? 'is-active' : ''}`} aria-expanded={moreOpen} onClick={() => { setMineOpen(false); onMoreOpen(!moreOpen); }}>
          <Menu size={20} aria-hidden="true" /><span>More</span>
        </button>
      </nav>
    </>
  );
}
