import { useEffect, useState } from 'react';
import { Backpack, BookOpen, Crosshair, Dumbbell, KeyRound, LogOut, Menu, MessageCircle, Palette, Pickaxe, ScrollText, Shield, ShoppingBag, Sparkles, Store, Swords, Trophy, UserPlus, X } from 'lucide-react';
import type { Tab } from './TopMenu';
import { OVERLAYS_CLOSE_EVENT } from '@/components/GameProgressBar';
import { setMobileSection, type MobileSection } from '@/platform/platform';
import { defaultUiTheme, setUiTheme } from '@/theme/uiTheme';
import '@/theme/scene/sheets.css';
import { SeekerMinePanel } from '@/components/SeekerMinePanel';

// Android layout only (src/platform/platform.ts): the phone's primary navigation, two rows
// (Founder 2026-10-02). Row 1: Battle, Quests and Bag switch the Play screen between its three
// columns; Heroes, Summon and Market open their windows. Row 2: Training, Store, the upcoming
// $ORE Mine (its own sheet) and PvP ("Soon"), both slightly highlighted, Ranks, and More with Refer and the
// footer links (Founder 2026-10-03: Refer moved into More to make room for PvP). Any item can
// carry a count badge on its icon (`badges`; Quests shows its ready rewards) or a red mark without a
// number (`alerts`, e.g. a Store sale).
export function MobileTabBar({
  tab, section, moreOpen, onTab, onSection, onMoreOpen, onGuides, onCode, onSupport, onLogout, readyQuests = 0, badges = {}, alerts = {},
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
  badges?: Partial<Record<MobileSection | Tab, number>>;
  alerts?: Partial<Record<MobileSection | Tab, boolean>>;
}) {
  const [soon, setSoon] = useState<'mine' | 'pvp' | null>(null);
  const mineOpen = soon !== null;
  const setMineOpen = (open: boolean) => { if (!open) setSoon(null); };
  useEffect(() => {
    const close = (event: Event) => { if (!(event as CustomEvent<{ sheetToggle?: boolean }>).detail?.sheetToggle) setSoon(null); };
    window.addEventListener(OVERLAYS_CLOSE_EVENT, close);
    return () => window.removeEventListener(OVERLAYS_CLOSE_EVENT, close);
  }, []);
  useEffect(() => { setMobileSection(section); }, [section]);
  // While a window covers the Play screen, the screen underneath is not painted (android.css):
  // a phone WebView left the Bag grid showing through an unfinished Summon window.
  useEffect(() => {
    if (tab === 'main') delete document.documentElement.dataset.hlWindow;
    else document.documentElement.dataset.hlWindow = tab;
    return () => { delete document.documentElement.dataset.hlWindow; };
  }, [tab]);
  const countFor = (id: MobileSection | Tab) => (id === 'quests' ? readyQuests : badges[id] ?? 0);
  const icon = (Icon: typeof Shield, count: number, alert = false) => (
    <i className="hl-tabbar-icon" aria-hidden="true">
      <Icon size={20} />
      {count > 0 ? <b className="hl-tabbar-badge">{count > 99 ? '99+' : count}</b> : alert && <b className="hl-tabbar-alert">!</b>}
    </i>
  );
  const sectionButton = (id: MobileSection, label: string, Icon: typeof Shield) => {
    const active = tab === 'main' && !moreOpen && !mineOpen && section === id;
    const count = countFor(id);
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''} ${count > 0 ? 'has-badge' : ''}`} aria-current={active ? 'page' : undefined} aria-label={count > 0 ? (id === 'quests' ? `Quests, ${count} rewards ready` : `${label}, ${count} new`) : label} onClick={() => { onMoreOpen(false); setMineOpen(false); onTab('main'); onSection(id); }}>
        {icon(Icon, count)}<span>{label}</span>
      </button>
    );
  };
  const windowButton = (id: Tab, label: string, Icon: typeof Shield) => {
    const active = tab === id && !moreOpen && !mineOpen;
    const count = countFor(id);
    const alert = count === 0 && alerts[id] === true;
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''} ${count > 0 || alert ? 'has-badge' : ''}`} aria-current={active ? 'page' : undefined} aria-label={count > 0 ? `${label}, ${count} new` : alert ? `${label}, new` : label} onClick={() => { onMoreOpen(false); setMineOpen(false); onTab(id); }}>
        {icon(Icon, count, alert)}<span>{label}</span>
      </button>
    );
  };
  const [themeLabel] = useState(() => document.documentElement.dataset.hlTheme === 'premium' ? 'Classic UI' : 'Premium UI');

  return (
    <>
      {moreOpen && (
        <div className="hl-more-sheet mo-sheet" role="dialog" aria-modal="true" aria-label="More" onMouseDown={(event) => { if (event.currentTarget === event.target) onMoreOpen(false); }}>
          <div className="mo-panel">
            <div className="mo-head">
              <span className="mo-title">More</span>
              <button type="button" className="mo-close" onClick={() => onMoreOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="hl-more-links mo-links">
              <button type="button" className="mo-link" onClick={() => { onMoreOpen(false); onTab('referrals'); }}><i aria-hidden="true"><UserPlus size={19} /></i>Refer</button>
              <button type="button" className="mo-link" onClick={() => { onMoreOpen(false); onGuides(); }}><i aria-hidden="true"><BookOpen size={19} /></i>Guides</button>
              <button type="button" className="mo-link" onClick={() => { onMoreOpen(false); onCode(); }}><i aria-hidden="true"><KeyRound size={19} /></i>Code</button>
              <button type="button" className="mo-link" onClick={() => { onMoreOpen(false); onSupport(); }}><i aria-hidden="true"><MessageCircle size={19} /></i>Support</button>
              {defaultUiTheme === 'premium' && <button type="button" className="mo-link" onClick={() => setUiTheme(document.documentElement.dataset.hlTheme === 'premium' ? 'classic' : 'premium')}><i aria-hidden="true"><Palette size={19} /></i>{themeLabel}</button>}
            </div>
            <button type="button" className="mo-logout" onClick={() => { onMoreOpen(false); onLogout(); }}><LogOut size={16} aria-hidden="true" /> Logout</button>
          </div>
        </div>
      )}
      {soon === 'pvp' && (
        <div className="hl-more-sheet mo-sheet" role="dialog" aria-modal="true" aria-label="PvP" onMouseDown={(event) => { if (event.currentTarget === event.target) setMineOpen(false); }}>
          <div className="mo-panel mo-pvp">
            <div className="mo-head">
              <span className="mo-title">PvP</span>
              <button type="button" className="mo-close" onClick={() => setMineOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="mo-arena">
              <span className="mo-medal" aria-hidden="true"><Swords size={36} /></span>
              <span className="mo-kicker">Arena of Champions</span>
              <strong>Coming soon</strong>
              <span>PvP arena battles open in a future update.</span>
            </div>
          </div>
        </div>
      )}
      {soon === 'mine' && (
        <div className="hl-more-sheet" role="dialog" aria-modal="true" aria-label="$ORE Mine" onMouseDown={(event) => { if (event.currentTarget === event.target) setMineOpen(false); }}>
          <div className="hl-more-panel">
            <div className="hl-more-head">
              <span className="section-kicker">$ORE Mine</span>
              <button type="button" className="game-control hl-more-close" onClick={() => setMineOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="space-y-2.5"><SeekerMinePanel /></div>
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
        <button type="button" className={`hl-tabbar-item hl-tabbar-mine ${soon === 'mine' ? 'is-active' : ''}`} aria-expanded={soon === 'mine'} aria-label="$ORE Mine" onClick={() => { onMoreOpen(false); setSoon(soon === 'mine' ? null : 'mine'); }}>
          <i className="hl-tabbar-icon" aria-hidden="true"><Pickaxe size={20} /></i><span>Mine</span>
        </button>
        <button type="button" className={`hl-tabbar-item hl-tabbar-mine ${soon === 'pvp' ? 'is-active' : ''}`} aria-expanded={soon === 'pvp'} aria-label="PvP, coming soon" onClick={() => { onMoreOpen(false); setSoon(soon === 'pvp' ? null : 'pvp'); }}>
          <i className="hl-tabbar-icon" aria-hidden="true"><Crosshair size={20} /><b className="hl-mine-badge">Soon</b></i><span>PvP</span>
        </button>
        {windowButton('leaderboard', 'Ranks', Trophy)}
        <button type="button" className={`hl-tabbar-item ${moreOpen || tab === 'referrals' ? 'is-active' : ''}`} aria-expanded={moreOpen} onClick={() => { setMineOpen(false); onMoreOpen(!moreOpen); }}>
          {icon(Menu, 0)}<span>More</span>
        </button>
      </nav>
    </>
  );
}
