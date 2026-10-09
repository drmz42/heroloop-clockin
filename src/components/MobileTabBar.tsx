import { useEffect, useState, type ReactNode } from 'react';
import { Backpack, BookOpen, Castle, ChevronLeft, ChevronRight, Crosshair, Crown, Dumbbell, KeyRound, LogOut, Menu, MessageCircle, PawPrint, Pickaxe, ScrollText, Send, Shield, ShoppingBag, Sparkles, Store, Swords, Trophy, Twitter, UserPlus, Wallet, Volume2, VolumeX, Music, Settings2 } from 'lucide-react';
import { setMusicEnabled, setMusicVolume, setSfxEnabled, setSfxVolume, useAudioSettings } from '@/audio/gameAudio';
import type { Tab } from './TopMenu';
import { OVERLAYS_CLOSE_EVENT } from '@/components/GameProgressBar';
import { setMobileSection, type MobileSection } from '@/platform/platform';
import '@/theme/scene/sheets.css';
import { SeekerMinePanel } from '@/components/SeekerMinePanel';
import { buildVersionLabel } from '@/platform/buildInfo';
import { MINE_OPEN_EVENT, markSeekerTourStep } from '@/game/seekerTour';
import { closeAndroidOverlayThen, useAndroidOverlayHistory } from '@/platform/useAndroidOverlayHistory';
import { shortWalletAddress } from '@/components/walletAddress';

// Android layout only (src/platform/platform.ts): the phone's primary navigation, two rows
// (Founder 2026-10-02). Row 1: Battle, Quests and Bag switch the Play screen between its three
// columns; Heroes, Summon and Market open their windows. Row 2: PvP ("Season"), Wallet, the
// upcoming $ORE Mine (its own sheet), Store, Ranks, and More with Training, Refer and the footer links
// (Founder 2026-10-09: Wallet moved from More between PvP and Mine). Any item can
// carry a count badge on its icon (`badges`; Quests shows its ready rewards) or a red mark without a
// number (`alerts`, e.g. a Store sale).

// More sheet v3 (Founder 2026-10-06): a painted keep with art banners for the upcoming Season Pass,
// Guilds and Pets, the live Refer banner and forged plates for the footer links. The three upcoming
// features only open a "Coming soon" teaser; they grant nothing and promise no amounts.
type Upcoming = 'pass' | 'guilds' | 'pets';
const UPCOMING: Record<Upcoming, { title: string; kicker: string; line: string; points: string[]; Icon: typeof Shield }> = {
  pass: { title: 'Season Pass', kicker: 'Coming in Season 2', line: 'Climb the season track for exclusive rewards.', points: ['Free and premium reward tracks', 'Season quests and milestones', 'Exclusive cosmetics each season'], Icon: Crown },
  guilds: { title: 'Guilds', kicker: 'Brotherhood', line: 'Raise a banner with your allies.', points: ['Found or join a guild', 'Guild raids against epic bosses', 'Guild ranks and a shared hall'], Icon: Castle },
  pets: { title: 'Pets', kicker: 'Companions', line: 'Tame companions that fight at your side.', points: ['Hatch and raise companions', 'Pets assist your heroes in battle', 'Evolve rare forms'], Icon: PawPrint },
};

// Living More art (sheets.css "More v4"): masked art layers breathe or sway, light layers flicker.
const MO_LIFE: Record<'pass' | 'guilds' | 'pets', Array<[string, 'art' | 'light']>> = {
  pass: [['a', 'light'], ['b', 'light'], ['s1', 'light'], ['s2', 'light'], ['s3', 'light'], ['s4', 'light'], ['s5', 'light'], ['s6', 'light']],
  guilds: [['a', 'art'], ['b', 'light'], ['c', 'light']],
  pets: [['a', 'art'], ['b', 'art'], ['c', 'light'], ['d', 'light']],
};
function MoLife({ id }: { id: string }) {
  const layers = MO_LIFE[id as keyof typeof MO_LIFE];
  return layers ? <>{layers.map(([key, kind]) => <i key={key} className={`mo-life mo-life-${kind} mo-life-${key}`} aria-hidden="true" />)}</> : null;
}

export function MobileTabBar({
  tab, section, moreOpen, onTab, onSection, onMoreOpen, onGuides, onCode, onSupport, onLogout, readyQuests = 0, badges = {}, alerts = {},
  claimQuest, motionOff = false, onSheetOpenChange, onPass, settings, walletAddress = null, onWallet,
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
  /** Mine quests claim through the same server settlement as the Quest Board. */
  claimQuest?: (id: string) => Promise<boolean>;
  motionOff?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
  /** Seeker: the Season Pass banner opens the live Premium Pass in Events. */
  onPass?: () => void;
  /** Seeker: automatic healing and battle graphics (moved out of the battle burger). */
  settings?: ReactNode;
  /** Seeker: Wallet opens from the bottom row between PvP and Mine. */
  walletAddress?: string | null;
  onWallet?: () => void;
}) {
  const [soon, setSoon] = useState<'mine' | 'pvp' | null>(null);
  const audioSettings = useAudioSettings();
  const mineOpen = soon !== null;
  useEffect(() => { onSheetOpenChange?.(mineOpen); }, [mineOpen, onSheetOpenChange]);
  const [teaser, setTeaser] = useState<Upcoming | null>(null);
  // Back from a Season Pass/feature teaser returns to the More list.
  useAndroidOverlayHistory(moreOpen && teaser !== null, () => setTeaser(null));
  useEffect(() => { if (!moreOpen) setTeaser(null); }, [moreOpen]);
  // Settings (Founder 2026-10-09): healing, sound mixer, battle graphics, Support, Code and Wiki.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsHistory = useAndroidOverlayHistory(moreOpen && settingsOpen, () => setSettingsOpen(false));
  useEffect(() => { if (!moreOpen) setSettingsOpen(false); }, [moreOpen]);
  const setMineOpen = (open: boolean) => { if (!open) setSoon(null); };
  useEffect(() => {
    const close = (event: Event) => { if (!(event as CustomEvent<{ sheetToggle?: boolean }>).detail?.sheetToggle) setSoon(null); };
    window.addEventListener(OVERLAYS_CLOSE_EVENT, close);
    return () => window.removeEventListener(OVERLAYS_CLOSE_EVENT, close);
  }, []);
  // The battle screen's Next-step card and income details open the Mine sheet directly.
  useEffect(() => {
    const openMine = () => { onMoreOpen(false); setSoon('mine'); };
    window.addEventListener(MINE_OPEN_EVENT, openMine);
    return () => window.removeEventListener(MINE_OPEN_EVENT, openMine);
  }, [onMoreOpen]);
  useEffect(() => { if (soon === 'mine') markSeekerTourStep('mine'); }, [soon]);
  useEffect(() => { if (tab === 'shop') markSeekerTourStep('store'); }, [tab]);
  useEffect(() => { setMobileSection(section); }, [section]);
  // While a window covers the Play screen, the screen underneath is not painted (android.css):
  // a phone WebView left the Bag grid showing through an unfinished Summon window.
  useEffect(() => {
    if (tab === 'main') delete document.documentElement.dataset.hlWindow;
    else document.documentElement.dataset.hlWindow = tab;
    return () => { delete document.documentElement.dataset.hlWindow; };
  }, [tab]);
  const countFor = (id: MobileSection | Tab) => (id === 'quests' ? readyQuests : badges[id] ?? 0);
  const icon = (Icon: typeof Shield, count: number, alert = false, tag?: string) => (
    <i className="hl-tabbar-icon" aria-hidden="true">
      <Icon size={20} />
      {count > 0 ? <b className="hl-tabbar-badge">{count > 99 ? '99+' : count}</b> : alert ? <b className="hl-tabbar-alert">!</b> : tag && <b className="hl-mine-badge">{tag}</b>}
    </i>
  );
  const guideFor = (id: MobileSection | Tab) => ({ battle: 'battle boss', quests: 'claim open-chests', bag: 'equip', summon: 'summon', heroes: 'formation' } as Partial<Record<MobileSection | Tab, string>>)[id];
  const sectionButton = (id: MobileSection, label: string, Icon: typeof Shield) => {
    const active = tab === 'main' && !moreOpen && !mineOpen && section === id;
    const count = countFor(id);
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''} ${count > 0 ? 'has-badge' : ''}`} aria-current={active ? 'page' : undefined} data-guide={guideFor(id)} aria-label={count > 0 ? (id === 'quests' ? `Quests, ${count} rewards ready` : `${label}, ${count} new`) : label} onClick={() => { onMoreOpen(false); setMineOpen(false); onTab('main'); onSection(id); }}>
        {icon(Icon, count)}<span>{label}</span>
      </button>
    );
  };
  const windowButton = (id: Tab, label: string, Icon: typeof Shield, tag?: string) => {
    const active = tab === id && !moreOpen && !mineOpen;
    const count = countFor(id);
    const alert = count === 0 && alerts[id] === true;
    return (
      <button type="button" className={`hl-tabbar-item ${active ? 'is-active' : ''} ${count > 0 || alert ? 'has-badge' : ''}`} aria-current={active ? 'page' : undefined} data-guide={guideFor(id)} aria-label={count > 0 ? `${label}, ${count} new` : alert ? `${label}, new` : label} onClick={() => { onMoreOpen(false); setMineOpen(false); onTab(id); }}>
        {icon(Icon, count, alert, tag)}<span>{label}</span>
      </button>
    );
  };

  return (
    <>
      {moreOpen && (
        <div className="hl-more-sheet mo-sheet mo-v3" role="dialog" aria-modal="true" aria-label="More" onMouseDown={(event) => { if (event.currentTarget === event.target) onMoreOpen(false); }}>
          <div className="mo-panel mo-keep">
            <div className="mo-keep-art" aria-hidden="true" />
            <div className="mo-head">
              {(teaser || settingsOpen) && <button type="button" className="mo-close mo-back" onClick={() => { setTeaser(null); setSettingsOpen(false); }} aria-label="Back"><ChevronLeft size={20} /></button>}
              <span className="mo-title">{settingsOpen ? 'Settings' : teaser ? UPCOMING[teaser].title : 'More'}</span>
            </div>
            {/* The list scrolls; the footer row (socials, Settings, Logout) stays put (Founder 2026-10-09). */}
            <div className="mo-scroll">
            {settingsOpen ? (
              <div className="mo-settings-page">
                <section className="mo-set-group" aria-label="Sound">
                  <h4>Sound</h4>
                  {([['sfx', 'Sound effects', Volume2, audioSettings.sfx, audioSettings.sfxVolume, setSfxEnabled, setSfxVolume],
                    ['music', 'Music', Music, audioSettings.music, audioSettings.musicVolume, setMusicEnabled, setMusicVolume]] as const).map(([id, label, Icon, on, level, toggle, setLevel]) => (
                    <div key={id} className={`mo-set-row ${on ? '' : 'is-off'}`}>
                      <button type="button" className="mo-set-toggle" aria-pressed={on} aria-label={`${label} ${on ? 'on' : 'off'}`} onClick={() => toggle(!on)}>{on ? <Icon size={16} /> : <VolumeX size={16} />}</button>
                      <span className="mo-set-label">{label}</span>
                      <input type="range" min={0} max={100} step={5} value={Math.round(level * 100)} disabled={!on} aria-label={`${label} volume`}
                        onChange={(event) => setLevel(Number(event.target.value) / 100)} />
                      <b className="mo-set-value">{on ? `${Math.round(level * 100)}%` : 'Off'}</b>
                    </div>
                  ))}
                </section>
                {settings && <section className="mo-set-group" aria-label="Battle">{settings}</section>}
                <div className="mo-links">
                  <button type="button" className="mo-link" onClick={() => { onMoreOpen(false); onSupport(); }}><i aria-hidden="true"><MessageCircle size={17} /></i>Support</button>
                  <button type="button" className="mo-link" onClick={() => { onMoreOpen(false); onCode(); }}><i aria-hidden="true"><KeyRound size={17} /></i>Code</button>
                  <button type="button" className="mo-link" onClick={() => {
                    setSettingsOpen(false);
                    closeAndroidOverlayThen(settingsHistory, () => { onMoreOpen(false); onGuides(); });
                  }}><i aria-hidden="true"><BookOpen size={17} /></i>Wiki</button>
                </div>
              </div>
            ) : teaser ? (
              <div className={`mo-teaser mo-art-${teaser}`}>
                <div className="mo-teaser-art" aria-hidden="true" />
                <MoLife id={teaser} />
                <span className="mo-medal" aria-hidden="true">{(() => { const TeaserIcon = UPCOMING[teaser].Icon; return <TeaserIcon size={34} />; })()}</span>
                <span className="mo-kicker">{UPCOMING[teaser].kicker}</span>
                <strong>Season 2</strong>
                <span className="mo-teaser-line">{UPCOMING[teaser].line}</span>
                {teaser === 'pass' && (
                  <ol className="mo-track" aria-hidden="true">
                    {[1, 2, 3, 4, 5].map((tier) => <li key={tier} className={tier === 5 ? 'is-crown' : ''}><b><span>{tier === 5 ? <Crown size={14} /> : tier}</span></b></li>)}
                  </ol>
                )}
                <ul className="mo-points">{UPCOMING[teaser].points.map((point) => <li key={point}>{point}</li>)}</ul>
              </div>
            ) : (
              <div className="mo-body">
                <button type="button" className="mo-banner mo-banner-hero mo-art-pass" onClick={() => { if (onPass) { onMoreOpen(false); onPass(); } else setTeaser('pass'); }}>
                  <MoLife id="pass" />
                  <span className="mo-banner-text"><span className="mo-kicker">{onPass ? 'Season 1 · 100 levels' : UPCOMING.pass.kicker}</span><strong>{onPass ? 'Battle Pass' : 'Season Pass'}</strong><span>{onPass ? 'Free, Empowered and Collector reward tracks.' : UPCOMING.pass.line}</span></span>
                  <em className="mo-soon">{onPass ? 'Live' : 'Season 2'}</em><ChevronRight className="mo-chev" size={18} aria-hidden="true" />
                </button>
                <div className="mo-pair">
                  {(['guilds', 'pets'] as const).map((id) => {
                    const { title, kicker, Icon } = UPCOMING[id];
                    return (
                      <button type="button" key={id} className={`mo-banner mo-tile mo-art-${id}`} onClick={() => setTeaser(id)}>
                        <MoLife id={id} />
                        <i className="mo-tile-icon" aria-hidden="true"><Icon size={18} /></i>
                        <span className="mo-banner-text"><span className="mo-kicker">{kicker}</span><strong>{title}</strong></span>
                        <em className="mo-soon">Season 2</em>
                      </button>
                    );
                  })}
                </div>
                <div className="mo-pair mo-pair-short">
                  <button type="button" className="mo-banner mo-tile mo-art-training" onClick={() => { onMoreOpen(false); onTab('training'); }}>
                    <i className="mo-tile-icon" aria-hidden="true"><Dumbbell size={18} /></i>
                    <span className="mo-banner-text"><span className="mo-kicker">Train heroes</span><strong>Training</strong></span>
                  </button>
                  <button type="button" className="mo-banner mo-tile mo-art-refer" onClick={() => { onMoreOpen(false); onTab('referrals'); }}>
                    <i className="mo-tile-icon" aria-hidden="true"><UserPlus size={18} /></i>
                    <span className="mo-banner-text"><span className="mo-kicker">Share the spoils</span><strong>Refer friends</strong></span>
                  </button>
                </div>
                <p className="mo-version" aria-label={`Version: ${buildVersionLabel}`}>{buildVersionLabel}</p>
              </div>
            )}
            </div>
            {!settingsOpen && !teaser && <div className="mo-footer">
              <div className="mo-socials" role="group" aria-label="Social networks">
                <a className="mo-social" href="https://t.me/heroloopgame" target="_blank" rel="noopener noreferrer" aria-label="Telegram" title="Telegram"><Send size={19} aria-hidden="true" /></a>
                <a className="mo-social" href="https://x.com/heroloopgame" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)" title="X (Twitter)"><Twitter size={19} aria-hidden="true" /></a>
              </div>
              <button type="button" className="mo-settings-btn" onClick={() => setSettingsOpen(true)}><Settings2 size={15} aria-hidden="true" />Settings</button>
              <button type="button" className="mo-logout" onClick={() => { onMoreOpen(false); onLogout(); }}><LogOut size={14} aria-hidden="true" /> Logout</button>
            </div>}
          </div>
        </div>
      )}
      {soon === 'pvp' && (
        <div className="hl-more-sheet mo-sheet" role="dialog" aria-modal="true" aria-label="PvP" onMouseDown={(event) => { if (event.currentTarget === event.target) setMineOpen(false); }}>
          <div className="mo-panel mo-pvp">
            <div className="mo-head">
              <span className="mo-title">PvP</span>
            </div>
            <div className="mo-arena">
              <span className="mo-medal" aria-hidden="true"><Swords size={36} /></span>
              <span className="mo-kicker">Arena of Champions</span>
              <strong>Season 2</strong>
              <span>PvP arena battles open with Season 2.</span>
            </div>
          </div>
        </div>
      )}
      {soon === 'mine' && (
        <div className="hl-more-sheet mn-sheet" role="dialog" aria-modal="true" aria-label="$ORE Mine">
          <SeekerMinePanel onClose={() => setMineOpen(false)} claimQuest={claimQuest} still={motionOff} />
        </div>
      )}
      <nav className={`hl-tabbar${onWallet ? '' : ' hl-tabbar-5'}`} aria-label="Game navigation">
        {sectionButton('battle', 'Battle', Swords)}
        {sectionButton('quests', 'Quests', ScrollText)}
        {sectionButton('bag', 'Bag', Backpack)}
        {windowButton('heroes', 'Heroes', Shield)}
        {windowButton('summon', 'Summon', Sparkles)}
        {windowButton('market', 'Market', Store)}
        <button type="button" className={`hl-tabbar-item hl-tabbar-mine ${soon === 'pvp' ? 'is-active' : ''}`} aria-expanded={soon === 'pvp'} aria-label="PvP, Season 2" onClick={() => { onMoreOpen(false); setSoon(soon === 'pvp' ? null : 'pvp'); }}>
          <i className="hl-tabbar-icon" aria-hidden="true"><Crosshair size={20} /><b className="hl-mine-badge">Season</b></i><span>PvP</span>
        </button>
        {onWallet && <button type="button" className="hl-tabbar-item" onClick={() => { onMoreOpen(false); setMineOpen(false); onWallet(); }} aria-label={walletAddress ? `Open wallet ${shortWalletAddress(walletAddress)}` : 'Open account'} title={walletAddress ?? 'Account'}>
          {icon(Wallet, 0)}<span>Wallet</span>
        </button>}
        <button type="button" className={`hl-tabbar-item hl-tabbar-mine ${soon === 'mine' ? 'is-active' : ''}`} aria-expanded={soon === 'mine'} aria-label="$ORE Mine" onClick={() => { onMoreOpen(false); setSoon(soon === 'mine' ? null : 'mine'); }}>
          <i className="hl-tabbar-icon" aria-hidden="true"><Pickaxe size={20} /><b className="hl-mine-badge">ORE</b></i><span>Mine</span>
        </button>
        {windowButton('shop', 'Store', ShoppingBag, 'SKR')}
        {windowButton('leaderboard', 'Ranks', Trophy)}
        <button type="button" className={`hl-tabbar-item ${moreOpen || tab === 'referrals' || tab === 'training' ? 'is-active' : ''}`} aria-expanded={moreOpen} onClick={() => { setMineOpen(false); onMoreOpen(!moreOpen); }}>
          {icon(Menu, 0)}<span>More</span>
        </button>
      </nav>
    </>
  );
}
