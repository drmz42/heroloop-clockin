import { useEffect, useMemo, useState } from 'react';
import type { Wallet } from '@wallet-standard/base';
import {
  ArrowDown, ArrowRight, Check, ChevronRight, Coins, Gamepad2,
  Gem, Menu, Shield, Sparkles, Swords, UserRound, X, Zap,
} from 'lucide-react';
import type { useGame } from '@/game/useGame';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { HERO_MAP } from '@/game/heroes';
import { playerSync } from '@/game/backend';
import { hasBlockedUsernameLanguage } from '@/game/username';
import { clearSignupAttribution, readSignupAttribution } from '@/game/signupAttribution';
import { clearLegacyState, makeRegisteredStarterState } from '@/game/state';
import { isAndroidLayout } from '@/platform/platform';
import {
  connectSolanaWallet,
  observeCompatibleSolanaWallets,
  solanaAuthEnabled,
} from '@/game/solanaWalletSession';

type GameApi = ReturnType<typeof useGame>;
type StarterId = 'shepherd-common' | 'assassin-common' | 'knight-common' | 'druid-common' | 'archer-common';

async function accountRequest<T>(request: Promise<T | null>): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), 12_000);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

const STARTERS: { id: StarterId; role: string; tagline: string; stat: string }[] = [
  { id: 'shepherd-common', role: 'Mage', tagline: 'Unleash arcane bursts', stat: 'Mana & runes' },
  { id: 'assassin-common', role: 'Assassin', tagline: 'Move through shadows', stat: 'Burst & criticals' },
  { id: 'knight-common', role: 'Warrior', tagline: 'Hold the line', stat: 'High HP & DEF' },
  { id: 'druid-common', role: 'Druid', tagline: 'Command living magic', stat: 'Regen & sustain' },
  { id: 'archer-common', role: 'Crossbowman', tagline: 'Keep relentless tempo', stat: 'Fast bolt attacks' },
];

const LOOP = [
  { icon: Swords, n: '01', title: 'AUTO-BATTLE', text: 'Build your squad and let your heroes fight through dangerous regions—even while you are away.' },
  { icon: Gem, n: '02', title: 'LOOT & BUILD', text: 'Open chests, discover rare gear and shape a build that can break through the next zone.' },
  { icon: Zap, n: '03', title: 'GROW STRONGER', text: 'Level heroes, raise their stars, enchant equipment and climb the global leaderboard.' },
  { icon: Coins, n: '04', title: 'EARN $HERO', text: 'Claim your accumulated rewards, spend tokens in-game or hold them to unlock BOOST MAX.' },
];

export function LandingScreen({ game, legacyWalletMode = null, onAccountReady }: { game: GameApi; legacyWalletMode?: 'link' | 'import' | null; onAccountReady: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  const start = () => {
    setMenuOpen(false);
    setOnboarding(true);
  };

  return (
    <div className="landing min-h-screen overflow-x-hidden bg-[#070711] text-slate-100">
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-[#070711]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 lg:px-8">
          <a href="#top" className="flex items-center">
            <img src="/assets/brand/heroloop-logo.png" alt="HeroLoop" width={180} height={52} className="h-11 w-auto max-w-[180px] object-contain drop-shadow-[0_0_10px_rgba(226,170,61,.25)]" />
          </a>

          <nav className="hidden items-center gap-8 text-xs font-bold uppercase tracking-[.16em] text-slate-400 md:flex">
            <a className="transition hover:text-white" href="#game">Game</a>
            <a className="transition hover:text-white" href="#how">How it works</a>
            <a className="transition hover:text-white" href="#boost">Boost Max</a>
            <a className="transition hover:text-white" href="#faq">FAQ</a>
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-emerald-300">
              Beta live
            </span>
            <button onClick={start} className="landing-cta px-5 py-2 text-xs">Play now</button>
          </div>

          <button onClick={() => setMenuOpen(v => !v)} className="p-2 text-white md:hidden" aria-label="Toggle menu">
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
        {menuOpen && (
          <div className="border-t border-white/10 bg-[#0a0914] p-5 md:hidden">
            <div className="flex flex-col gap-4 text-sm uppercase tracking-widest text-slate-300">
              <a href="#game" onClick={() => setMenuOpen(false)}>Game</a>
              <a href="#how" onClick={() => setMenuOpen(false)}>How it works</a>
              <a href="#boost" onClick={() => setMenuOpen(false)}>Boost Max</a>
              <button onClick={start} className="landing-cta mt-2 py-3">Play now</button>
            </div>
          </div>
        )}
      </header>

      <main>
        <section id="top" className="relative flex min-h-[760px] items-end overflow-hidden pt-16 lg:min-h-screen">
          <img
            src="/assets/heroes/hero-classes-v3.webp"
            alt="The five HeroLoop classes"
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,5,14,.98)_0%,rgba(5,5,14,.86)_32%,rgba(5,5,14,.12)_72%),linear-gradient(0deg,#070711_0%,transparent_45%)]" />
          <div className="absolute inset-0 opacity-30 landing-grid" />

          <div className="relative z-10 mx-auto grid w-full max-w-7xl gap-12 px-5 pb-24 pt-28 lg:grid-cols-[.9fr_1.1fr] lg:px-8 lg:pb-28">
            <div className="max-w-2xl">
              <div className="mb-6 inline-flex items-center gap-2 border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[.2em] text-violet-200">
                <Sparkles size={13} /> Idle RPG on Solana
              </div>
              <h1 className="font-pixel text-[clamp(2rem,5vw,4.8rem)] leading-[1.2] text-white">
                FIGHT.<br /><span className="text-amber-300">LOOT.</span><br />GROW.
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-slate-300 lg:text-xl">
                Assemble your heroes and conquer a world that never sleeps. Your squad battles, levels up and gathers rewards while you are away.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <button onClick={start} className="landing-cta group flex items-center justify-center gap-3 px-7 py-4">
                  <Gamepad2 size={19} /> Play beta <ArrowRight className="transition group-hover:translate-x-1" size={17} />
                </button>
                <a href="#how" className="flex items-center justify-center gap-2 border border-white/15 bg-black/25 px-7 py-4 text-sm font-bold uppercase tracking-wider text-white backdrop-blur transition hover:border-white/35">
                  How it works <ArrowDown size={16} />
                </a>
              </div>
              <div className="mt-9 flex flex-wrap gap-x-7 gap-y-3 text-xs uppercase tracking-widest text-slate-400">
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Browser game</span>
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Auto-battle</span>
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> No download</span>
              </div>
            </div>
          </div>
        </section>

        <section id="game" className="border-y border-white/10 bg-[#0b0a16]">
          <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y divide-white/10 px-5 md:grid-cols-4 md:divide-y-0 lg:px-8">
            {[
              ['5', 'Hero classes'],
              ['9', 'Rarities'],
              ['10', 'Regions'],
              ['24/7', 'With Boost Max'],
            ].map(([value, label]) => (
              <div key={label} className="px-5 py-8 text-center">
                <div className="font-pixel text-xl text-amber-300 lg:text-2xl">{value}</div>
                <div className="mt-2 text-[10px] uppercase tracking-[.22em] text-slate-500">{label}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="relative py-24 lg:py-32">
          <div className="absolute inset-0 opacity-20 landing-grid" />
          <div className="relative mx-auto max-w-7xl px-5 lg:px-8">
            <SectionTitle eyebrow="The loop never stops" title="PLAY ON YOUR TERMS" copy="A deep RPG progression loop without endless clicking. Make the decisions—your heroes handle the grind." />
            <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {LOOP.map(({ icon: Icon, n, title, text }) => (
                <article key={title} className="landing-card group relative overflow-hidden p-6">
                  <span className="absolute right-4 top-3 font-pixel text-3xl text-white/[.035]">{n}</span>
                  <div className="mb-6 grid h-12 w-12 place-items-center border border-violet-400/30 bg-violet-400/10 text-violet-300 transition group-hover:border-amber-300/40 group-hover:text-amber-300">
                    <Icon size={23} />
                  </div>
                  <h3 className="font-pixel text-[10px] text-white">{title}</h3>
                  <p className="mt-4 text-sm leading-6 text-slate-400">{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-white/10 bg-[#0b0a16] py-20 lg:py-28">
          <div className="mx-auto max-w-7xl px-5 lg:px-8">
            <SectionTitle
              eyebrow="Five ways to begin"
              title="CHOOSE YOUR HERO"
              copy="Start with the playstyle that feels right. Every other class can still join your squad later."
            />
            <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-5">
              {STARTERS.map(({ id, role, tagline }) => {
                const hero = HERO_MAP[id];
                const portrait = heroPortraitSrc(hero.id, hero.heroClass, hero.rarity, hero.color);
                return (
                  <button
                    key={id}
                    onClick={start}
                    className="landing-card group grid grid-rows-[auto_auto_1fr] overflow-hidden p-3 text-left transition hover:-translate-y-1 hover:border-amber-300/40"
                  >
                    <div className="relative aspect-square overflow-hidden bg-black/30">
                      <img
                        src={portrait}
                        alt={`${hero.name}, ${role}`}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                        style={heroPortraitStyle(hero.id, hero.heroClass)}
                      />
                      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-[#090811] to-transparent" />
                    </div>
                    <div className="px-2 pb-2 pt-4">
                      <div className="min-h-6 text-[9px] font-bold uppercase tracking-[.2em] text-violet-300">{role}</div>
                      <div className="mt-2 text-xs text-slate-500">{tagline}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section id="boost" className="overflow-hidden border-y border-white/10 bg-[#0b0a16] py-24 lg:py-32">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 lg:grid-cols-2 lg:px-8">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.3em] text-amber-300">Reach 100%</div>
              <h2 className="mt-4 font-pixel text-2xl leading-relaxed text-white lg:text-4xl">UNLOCK<br /><span className="text-amber-300">BOOST MAX</span></h2>
              <p className="mt-5 max-w-xl leading-7 text-slate-400">
                Complete community milestones, use $HERO in-game and keep the required balance in your game wallet. Your status is checked continuously.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <Benefit title="2× mining score" text="A larger share of the same daily pool" />
                <Benefit title="True 24/7 progress" text="No eight-hour storage cap" />
              </div>
            </div>

            <div className="landing-card relative p-6 sm:p-8">
              <div className="absolute -right-24 -top-24 h-56 w-56 rounded-full bg-violet-600/20 blur-3xl" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <span className="font-pixel text-[11px] text-white">BOOST MAX</span>
                  <span className="text-sm font-bold text-amber-300">100%</span>
                </div>
                <div className="mt-4 h-4 overflow-hidden border border-amber-300/40 bg-black/40 p-[3px]">
                  <div className="h-full w-full bg-gradient-to-r from-violet-500 via-fuchsia-400 to-amber-300 shadow-[0_0_20px_rgba(251,191,36,.55)]" />
                </div>
                <div className="mt-7 space-y-3">
                  {['Join the HeroLoop community', 'Follow official updates', 'Enter the Discord guild', 'Spend $HERO in-game', 'Hold $HERO in your game wallet'].map(label => (
                    <div key={label} className="flex items-center gap-3 border border-white/10 bg-white/[.025] px-4 py-3 text-sm text-slate-300">
                      <span className="grid h-5 w-5 place-items-center bg-emerald-400 text-[#07120c]"><Check size={13} strokeWidth={3} /></span>
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="px-5 py-24 text-center lg:py-32">
          <div className="mx-auto max-w-3xl">
            <Shield className="mx-auto text-violet-300" size={34} />
            <h2 className="mt-6 font-pixel text-xl leading-relaxed text-white lg:text-3xl">YOUR ADVENTURE<br />STARTS NOW</h2>
            <p className="mx-auto mt-5 max-w-xl text-slate-400">Continue with a temporary Guest account, choose your first hero and create the name that will appear on the leaderboard.</p>
            <button onClick={start} className="landing-cta mt-9 inline-flex items-center gap-3 px-8 py-4">
              Create hero <ChevronRight size={17} />
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[#05050b] px-5 py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
          <div className="font-pixel text-[10px] text-white">HERO<span className="text-amber-300">LOOP</span></div>
          <p className="text-xs text-slate-600">Beta build · $HERO rewards are currently simulated · © 2026 HeroLoop</p>
        </div>
      </footer>

      {onboarding && <Onboarding game={game} legacyWalletMode={legacyWalletMode} onAccountReady={onAccountReady} onClose={() => setOnboarding(false)} />}
    </div>
  );
}

function SectionTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <div className="text-[10px] font-bold uppercase tracking-[.3em] text-violet-300">{eyebrow}</div>
      <h2 className="mt-4 font-pixel text-xl leading-relaxed text-white lg:text-3xl">{title}</h2>
      <p className="mx-auto mt-5 max-w-2xl leading-7 text-slate-400">{copy}</p>
    </div>
  );
}

function Benefit({ title, text }: { title: string; text: string }) {
  return (
    <div className="border-l-2 border-amber-300 bg-amber-300/[.04] px-4 py-3">
      <div className="text-sm font-bold uppercase tracking-wider text-white">{title}</div>
      <div className="mt-1 text-xs text-slate-500">{text}</div>
    </div>
  );
}

export function Onboarding({ game, legacyWalletMode = null, onAccountReady, onClose, persistent = false }: { game: GameApi; legacyWalletMode?: 'link' | 'import' | null; onAccountReady: () => void; onClose: () => void; persistent?: boolean }) {
  const [step, setStep] = useState(1);
  const [starter, setStarter] = useState<StarterId>('shepherd-common');
  const [username, setUsername] = useState('');
  const [hasAttribution] = useState(() => readSignupAttribution() !== null);
  const [guestReady, setGuestReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [guestId, setGuestId] = useState('');
  const [error, setError] = useState('');
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [selectedWallet, setSelectedWallet] = useState('');
  const [legacyImportConfirmed, setLegacyImportConfirmed] = useState(false);
  const blockedName = hasBlockedUsernameLanguage(username);
  const validName = /^[a-zA-Z0-9_]{3,16}$/.test(username) && !blockedName;

  const heroCards = useMemo(() => STARTERS.map(s => {
    const hero = HERO_MAP[s.id];
    return { ...s, hero, svg: heroPortraitSrc(hero.id, hero.heroClass, hero.rarity, hero.color) };
  }), []);

  useEffect(() => {
    if (!solanaAuthEnabled) return;
    return observeCompatibleSolanaWallets((available) => {
      setWallets(available);
      setSelectedWallet((current) => available.some((wallet) => wallet.name === current)
        ? current
        : available[0]?.name ?? '');
    });
  }, []);

  const connectWallet = async () => {
    const wallet = wallets.find((candidate) => candidate.name === selectedWallet);
    if (!wallet) { setError('No compatible Solana wallet is available.'); return; }
    if (legacyWalletMode === 'import' && !legacyImportConfirmed) {
      setError('Confirm the one-time import before connecting your wallet.');
      return;
    }
    setConnecting(true); setError('');
    try {
      if (legacyWalletMode === 'import') {
        const migrated = await accountRequest(playerSync<{ state: unknown; revision: number; migrated: boolean }>('game_state_migrate', {
          state: game.state,
        }));
        if (!migrated?.state || !Number.isSafeInteger(migrated.revision)) {
          setError('Legacy progress could not be imported safely. Nothing was linked.');
          return;
        }
        game.hydrateServerState(migrated.state);
        clearLegacyState();
      }
      // Wallet approval is human-paced. Do not race it against the 12-second
      // API timeout: the underlying SIWS flow would continue and could finish
      // after the UI incorrectly reported failure.
      const session = await connectSolanaWallet(wallet, {
        // A wallet that already owns a HeroLoop account always signs in to that account (Founder
        // decision 2026-09-29). Only a one-time browser-progress import refuses, because that
        // progress has already been written into this Guest's server account.
        allowExistingAccountLogin: legacyWalletMode !== 'import',
      });
      const account = await accountRequest(playerSync<{ exists: boolean; username: string | null; account_id: string }>('account_status'));
      if (!account) {
        // The wallet and Auth session are already established. Let the game
        // verify the account and offer Retry instead of trapping it on Landing.
        onAccountReady();
        return;
      }
      if (account.account_id !== session.accountId) {
        setError('Account service is unavailable. Please try again.');
        return;
      }
      if (account.exists && account.username) {
        onAccountReady();
        return;
      }
      setGuestReady(true);
      setGuestId(`game-${account.account_id}`);
      setStep(2);
    } catch (reason) {
      const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
      const detail = reason instanceof Error && 'detail' in reason && typeof reason.detail === 'string' && reason.detail
        ? ` (${reason.detail})` : '';
      setError(code === 'wallet_already_linked'
        ? 'This wallet already belongs to another HeroLoop account.'
        : code === 'wallet_signature_rejected'
        ? 'The signature request was cancelled.'
        : code === 'wallet_sign_in_unavailable'
        ? `Phantom sign-in could not start. Reload Phantom and try again.${detail}`
        : code === 'wallet_sign_message_unavailable'
        ? `Phantom sign-message could not start. Reload Phantom and try again.${detail}`
        : code === 'wallet_connect_rejected'
        ? 'Phantom did not authorize the connection. Unlock Phantom, approve the request and try again.'
        : `Wallet authentication failed. Please try again.${/^[a-z0-9_]{3,64}$/.test(code) ? ` (${code})` : ''}`);
    } finally {
      setConnecting(false);
    }
  };

  const continueAsGuest = async () => {
    setGuestReady(true); setConnecting(true); setError('');
    try {
      const account = await accountRequest(playerSync<{ exists: boolean; username: string | null; account_id: string }>('account_status'));
      if (!account) { setError('Account service is unavailable. Please try again.'); return; }
      const temporaryGuestId = `game-${account.account_id}`;
      if (account.exists && account.username) {
        onAccountReady();
        return;
      }
      setGuestId(temporaryGuestId);
      setStep(2);
    } catch {
      setError('Account service is unavailable. Please try again.');
    } finally {
      setConnecting(false);
    }
  };

  const finish = async () => {
    if (!validName || !guestReady || !guestId) return;
    setConnecting(true); setError('');
    try {
      const registrationState = makeRegisteredStarterState(username.trim(), guestId, starter);
      const attribution = readSignupAttribution();
      let registrationError = '';
      const register = () => accountRequest(playerSync<{ created: boolean; username: string; account_id: string; state: unknown; revision: number }>('account_register', {
        username: username.trim(),
        starter_hero_id: starter,
        state: registrationState,
        ...(attribution ? { attribution } : {}),
      }, message => { registrationError = message; }));
      let account = await register();
      if (!account && (!registrationError || registrationError === 'network_error' || registrationError === 'registration_unavailable')) {
        registrationError = '';
        account = await register();
      }
      if (!account?.state || !Number.isSafeInteger(account.revision)) {
        const detail = registrationError === 'invalid_registration' || registrationError === 'invalid_registration_state'
          ? 'Registration data was rejected. Reload the page and try again.'
          : 'Registration service is unavailable. Please try again.';
        setError(detail);
        return;
      }
      clearSignupAttribution();
      game.hydrateServerState(account.state);
      onAccountReady();
    } catch {
      setError('Registration failed. Please try again.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="hl-onboarding fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#030308]/90 p-4 backdrop-blur-md">
      <div className="landing-card relative my-auto w-full max-w-4xl overflow-hidden">
        {!persistent && <button onClick={onClose} className="absolute right-4 top-4 z-10 p-2 text-slate-500 transition hover:text-white" aria-label="Close">
          <X size={20} />
        </button>}
        <div className="border-b border-white/10 px-6 py-5 sm:px-8">
          <div className="text-[10px] uppercase tracking-[.25em] text-violet-300">{step === 1 ? (solanaAuthEnabled ? 'Verify wallet ownership' : 'Check guest account') : 'Create your account'}</div>
          <div className="mt-3 flex items-center gap-2">
            {[1, 2, 3].map(n => (
              <div key={n} className={`h-1.5 flex-1 ${n <= step ? 'bg-amber-300' : 'bg-white/10'}`} />
            ))}
          </div>
        </div>

        <div className="min-h-[470px] p-6 sm:p-8">
          {step === 1 && (
            <div className="mx-auto max-w-xl py-5">
              <div className="mx-auto grid h-14 w-14 place-items-center border border-violet-400/40 bg-violet-400/10 text-violet-300">{solanaAuthEnabled ? <Shield size={26} /> : <UserRound size={26} />}</div>
              <h2 className="mt-6 text-center font-pixel text-sm text-white sm:text-lg">{solanaAuthEnabled ? 'CONNECT SOLANA WALLET' : 'CONTINUE AS GUEST'}</h2>
              <p className="mx-auto mt-3 max-w-md text-center text-sm leading-6 text-slate-400">{solanaAuthEnabled ? (isAndroidLayout ? 'Connect your Solana wallet' : 'Connect Phantom') + ' and sign one free message to prove ownership—no transaction and no gas.' : 'The current beta uses a temporary server account. Existing guests enter directly; new guests continue to registration.'}</p>
              {solanaAuthEnabled && legacyWalletMode && (
                <div className="mx-auto mt-5 max-w-md border border-amber-300/25 bg-amber-300/[.06] p-4 text-xs leading-5 text-amber-100/80">
                  {legacyWalletMode === 'link'
                    ? 'Existing Guest progress was found. A new wallet is linked to this Guest account; a wallet that already has a HeroLoop account signs in to that account instead, and this Guest stays separate. Nothing is copied between accounts.'
                    : 'Browser-only progress was found for this signed-in Guest. Import happens once into that exact server account before the verified wallet is linked.'}
                  {legacyWalletMode === 'import' && (
                    <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-left text-slate-200">
                      <input type="checkbox" checked={legacyImportConfirmed} onChange={(event) => setLegacyImportConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-amber-300" />
                      <span>I own this browser progress and approve its one-time import to the wallet I am about to verify.</span>
                    </label>
                  )}
                </div>
              )}
              <div className="mx-auto mt-7 w-fit border border-emerald-400/25 bg-emerald-400/[.06] px-4 py-2 text-[10px] font-bold uppercase tracking-[.14em] text-emerald-300"><Shield size={12} className="mr-1.5 inline" /> {solanaAuthEnabled ? 'Free ownership proof' : 'Server-saved guest progress'}</div>
              <button onClick={solanaAuthEnabled ? connectWallet : continueAsGuest} disabled={connecting || (solanaAuthEnabled && wallets.length === 0)} className="landing-cta mx-auto mt-4 flex min-h-12 w-full max-w-md items-center justify-center gap-3 px-6 py-4 text-sm font-black uppercase tracking-[.13em] disabled:cursor-not-allowed disabled:opacity-60">
                {solanaAuthEnabled ? <Shield size={19} /> : <UserRound size={19} />} {connecting ? 'Checking account…' : solanaAuthEnabled ? (isAndroidLayout ? 'Connect wallet' : 'Connect Phantom') : 'Continue as Guest'}
              </button>
              {solanaAuthEnabled && wallets.length === 0 && <div className="mx-auto mt-4 max-w-md text-center text-xs text-slate-400">{isAndroidLayout ? 'No Solana wallet app was found on this phone. Install Phantom or use the Seed Vault wallet on Seeker.' : 'Phantom was not detected.'} <a className="text-amber-300 underline underline-offset-4" href="https://phantom.com/" target="_blank" rel="noreferrer">Get Phantom</a></div>}
              {error && <div className="mt-5 border border-rose-400/30 bg-rose-400/10 p-3 text-center text-sm text-rose-300">{error}</div>}
              <div className="mx-auto mt-6 flex max-w-md items-start gap-3 border border-emerald-400/20 bg-emerald-400/[.05] p-4 text-xs leading-5 text-emerald-200/70"><Shield size={16} className="mt-0.5 shrink-0" /><span>{solanaAuthEnabled ? 'HeroLoop never asks for a transaction signature during login. A different wallet cannot inherit this account or its saves.' : 'Your Guest ID is not a wallet address and cannot receive funds. Verified wallet sign-in is a separate future feature.'}</span></div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="font-pixel text-sm text-white sm:text-lg">CHOOSE YOUR FIRST HERO</h2>
              <p className="mt-3 text-sm text-slate-400">Your starter defines the opening playstyle. You can summon every other class later.</p>
              <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {heroCards.map(({ id, role, tagline, stat, hero, svg }) => {
                  const active = starter === id;
                  return (
                    <button key={id} onClick={() => setStarter(id)} className={`relative grid h-full w-full min-w-0 grid-rows-[auto_28px_auto_1fr] overflow-hidden border p-4 text-left transition ${active ? 'border-amber-300 bg-amber-300/10 shadow-[0_0_30px_rgba(251,191,36,.12)]' : 'border-white/10 bg-white/[.025] hover:border-violet-400/50'}`}>
                      {active && <span className="absolute right-3 top-3 grid h-6 w-6 place-items-center bg-amber-300 text-black"><Check size={14} strokeWidth={3} /></span>}
                      <div className="relative mx-auto aspect-square w-full max-w-36 overflow-hidden bg-black/30">
                        <img src={svg} alt={`${hero.name}, ${role}`} style={heroPortraitStyle(hero.id, hero.heroClass)} />
                      </div>
                      <div className="mt-3 flex min-w-0 items-start text-[9px] font-bold uppercase tracking-[.12em] text-violet-300">{role}</div>
                      <div className="mt-3 text-sm text-slate-300">{tagline}</div>
                      <div className="mt-1 text-xs text-slate-500">{stat}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="mx-auto max-w-lg py-8">
              <h2 className="font-pixel text-sm text-white sm:text-lg">CLAIM YOUR NAME</h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">This is your permanent public identity in leaderboards, marketplace listings and guilds.</p>
              <label className="mt-8 block text-[10px] font-bold uppercase tracking-[.2em] text-slate-500">Player name</label>
              <input
                autoFocus
                value={username}
                onChange={e => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16))}
                placeholder="e.g. VoidRunner"
                className="mt-3 w-full border border-white/15 bg-black/40 px-5 py-4 text-lg text-white outline-none transition placeholder:text-slate-700 focus:border-amber-300"
              />
              <div className="mt-3 flex justify-between text-xs">
                <span className={username.length > 0 && !validName ? 'text-rose-400' : 'text-slate-600'}>{blockedName ? 'Choose a respectful player name' : '3–16 letters, numbers or _'}</span>
                <span className="text-slate-600">{username.length}/16</span>
              </div>
              {hasAttribution && <p className="mt-5 text-xs leading-5 text-slate-500">You arrived through a campaign, invite or promo link. We save that link label with your account only to see which campaigns bring players.</p>}
              {error && <div className="mt-5 border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-300">{error}</div>}
            </div>
          )}

        </div>

        <div className="flex items-center justify-between border-t border-white/10 bg-black/20 px-6 py-5 sm:px-8">
{persistent && step === 1 ? <span /> : <button onClick={() => step === 1 ? onClose() : setStep(step - 1)} className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-white">
            {step === 1 ? 'Cancel' : 'Back'}
          </button>}
          {step === 2 ? (
            <button onClick={() => setStep(3)} className="landing-cta flex items-center gap-2 px-6 py-3 disabled:cursor-not-allowed disabled:opacity-30">
              Continue <ArrowRight size={15} />
            </button>
          ) : step === 3 ? (
            <button onClick={finish} disabled={!validName || connecting} className="landing-cta flex items-center gap-2 px-6 py-3 disabled:cursor-not-allowed disabled:opacity-30">
              {connecting ? 'Creating…' : 'Create account'} <Gamepad2 size={16} />
            </button>
          ) : <span />}
        </div>
      </div>
    </div>
  );
}
