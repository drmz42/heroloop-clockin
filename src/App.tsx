import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useGame } from '@/game/useGame';
import { GameNavBar } from '@/components/GameNavBar';
import { FooterBar } from '@/components/FooterBar';
import { OfflineModal } from '@/components/OfflineModal';
import { ChestOpenModal } from '@/components/ChestOpenModal';
import { BoostMaxModal } from '@/components/BoostMaxModal';
import { GameWalletModal } from '@/components/GameWalletModal';
import { PromoCodeModal, type PromoRedemption } from '@/components/PromoCodeModal';
import { LandingScreen } from '@/screens/LandingScreen';
import { MainScreen } from '@/screens/MainScreen';
import { HeroesScreen } from '@/screens/HeroesScreen';
import { SummonScreen } from '@/screens/SummonScreen';
import { TrainingCampScreen } from '@/screens/TrainingCampScreen';
import { ShopScreen } from '@/screens/ShopScreen';
import { CraftingScreen } from '@/screens/CraftingScreen';
import { MarketplaceScreen } from '@/screens/MarketplaceScreen';
import { LeaderboardScreen } from '@/screens/LeaderboardScreen';
import { ReferralsScreen } from '@/screens/ReferralsScreen';
import { GuidesScreen } from '@/screens/GuidesScreen';
import type { Tab } from '@/components/TopMenu';
import { canMineTokens, teamPower as calculateAccountPower } from '@/game/engine';
import { useTokenomics } from '@/game/useTokenomics';
import { demoTokenomicsEnabled, playerSync, supabase, tokenomicsEnabled } from '@/game/backend';
import { clearLegacyState } from '@/game/state';
import {
  compatibleSolanaWallets,
  restoreSolanaWalletSession,
  readWalletBinding,
  revokeSolanaWalletSession,
  setWalletBindingBoost,
  walletBindingExpired,
  solanaAuthEnabled,
  watchSolanaWalletSession,
} from '@/game/solanaWalletSession';

function App() {
  const game = useGame();
  const walletAddress = game.state.walletAddress;
  const hydrateServerState = game.hydrateServerState;
  const mergeServerResourceState = game.mergeServerResourceState;
  const applyServerRevision = game.applyServerRevision;
  const [accountGate, setAccountGate] = useState<'landing' | 'checking' | 'verified' | 'error'>(tokenomicsEnabled ? 'checking' : (walletAddress ? 'verified' : 'landing'));
  const [accountCheckAttempt, setAccountCheckAttempt] = useState(0);
  const [legacyWalletMode, setLegacyWalletMode] = useState<'link' | 'import' | null>(null);
  const [serverStateReady, setServerStateReady] = useState(false);
  const [serverStateRevision, setServerStateRevision] = useState<number | null>(null);
  const serverStateRevisionRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveStateRef = useRef(game.state);
  const saveStateVersionRef = useRef(0);
  const savedStateVersionRef = useRef(0);
  const flushServerSaveRef = useRef<() => void>(() => undefined);
  const accountStatusRequestRef = useRef<Promise<{ exists: boolean; username: string | null; account_id: string } | null> | null>(null);
  const legacyStateRef = useRef(game.state);
  const confirmedIncomeFingerprintRef = useRef('');
  const accountPower = useMemo(
    () => calculateAccountPower(game.state.ownedHeroes, game.state.inventory),
    [game.state.ownedHeroes, game.state.inventory],
  );
  const tokenEligible = canMineTokens(game.state.currentLocation, game.state.accountLevel, game.state.highestLocation);
  const rankLineup = useMemo(() => game.state.team.map((uid) => game.state.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero) => Boolean(hero)).map((hero) => ({ hero_id: hero!.heroId, level: hero!.level, stars: hero!.stars })), [game.state.team, game.state.ownedHeroes]);
  const trainingHeroCount = game.state.trainingCamp.heroUids.filter(Boolean).length;
  const tokenomics = useTokenomics(accountPower, game.state.accountLevel, game.state.username, accountGate === 'verified' ? game.state.walletAddress || null : null, {
    totalKills: game.state.totalKills,
    bossKills: game.state.totalBossKills,
    chestsOpened: game.state.session.chestsOpened,
    heroesOwned: game.state.ownedHeroes.length,
    highestLocation: game.state.highestLocation,
    tokenEligible,
    lineup: rankLineup,
    avatarHeroId: game.state.avatarHeroId,
    summons: game.state.summons,
    totalTokensEarned: game.state.totalTokensEarned,
    trainingHeroCount,
  });
  const autoClaimingRef = useRef(false);
  const demoTokenRemainderRef = useRef(0);
  const claimTokens = tokenomics.claimTokens;
  const refreshIncome = tokenomics.refreshIncome;
  const creditServerTokens = game.creditServerTokens;
  const applyServerTokenClaim = game.applyServerTokenClaim;
  const applyServerBoostStatus = game.applyServerBoostStatus;
  const applyServerPityStatus = game.applyServerPityStatus;
  const applyServerAscensionFocus = game.applyServerAscensionFocus;
  const setServerTokenBalance = game.setServerTokenBalance;
  const pendingTokens = tokenomics.status?.pending_tokens ?? 0;
  const boostStatus = tokenomics.status?.boost ?? null;
  const pityStatus = tokenomics.status?.pity ?? null;
  const ascensionFocusStatus = tokenomics.status?.ascension_focus;
  const serverTokenBalance = tokenomics.status?.token_balance;
  const resourceState = tokenomics.status?.resource_state;
  const resourceRevision = tokenomics.status?.resource_revision;
  const boostActiveKnown = tokenomics.status ? Boolean(tokenomics.status.boost?.active) : undefined;
  useEffect(() => {
    // Boost Max extends the wallet sign-in limit from 8 to 24 hours.
    if (boostActiveKnown !== undefined) setWalletBindingBoost(boostActiveKnown);
  }, [boostActiveKnown]);

  useEffect(() => {
    if (!serverStateReady) legacyStateRef.current = game.state;
  }, [game.state, serverStateReady]);

  useEffect(() => {
    if (!tokenomicsEnabled) { setAccountGate('verified'); return; }
    let cancelled = false;
    setAccountGate('checking');
    let stopWalletEvents: () => void = () => undefined;
    let walletBoundSession = false;
    let limitTimer: number | undefined;
    const loadAccount = async () => {
      if (solanaAuthEnabled) {
        const current = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
        if (current.data.session?.user.is_anonymous !== true) {
          const walletSession = await restoreSolanaWalletSession();
          if (!walletSession) {
            await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
            if (!cancelled) setAccountGate('landing');
            return;
          }
          const wallet = compatibleSolanaWallets().find((candidate) =>
            candidate.name === walletSession.walletName && candidate.accounts.some((account) => account.address === walletSession.address));
          if (!wallet) {
            await revokeSolanaWalletSession('wallet_disconnect');
            await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
            if (!cancelled) setAccountGate('landing');
            return;
          }
          walletBoundSession = true;
          if (!cancelled) setLinkedWalletAddress(walletSession.address);
          limitTimer = window.setInterval(() => {
            const binding = readWalletBinding();
            if (!binding || !walletBindingExpired(binding)) return;
            void revokeSolanaWalletSession('logout').finally(() =>
              supabase.auth.signOut({ scope: 'local' }).finally(() => window.location.replace('/')));
          }, 60_000);
          stopWalletEvents = watchSolanaWalletSession(walletSession, wallet, (reason) => {
            void revokeSolanaWalletSession(reason).finally(() =>
              supabase.auth.signOut({ scope: 'local' }).finally(() => window.location.replace('/')));
          });
        }
      }
      const request = accountStatusRequestRef.current ?? playerSync<{ exists: boolean; username: string | null; account_id: string }>('account_status');
      accountStatusRequestRef.current = request;
      await request.then((account) => {
      if (cancelled) return;
      if (!account) { setAccountGate('error'); return; }
      if (!account.exists || !account.username) {
        setLegacyWalletMode(null);
        setAccountGate('landing');
        return;
      }
      void playerSync<{ state: unknown; revision: number | null }>('game_state_load').then((saved) => {
        if (cancelled || !saved) { setAccountGate('error'); return; }
        if (saved.state && saved.revision) {
          hydrateServerState(saved.state);
          clearLegacyState();
          serverStateRevisionRef.current = saved.revision;
          setServerStateRevision(saved.revision);
          setServerStateReady(true);
          if (solanaAuthEnabled && !walletBoundSession) {
            setLegacyWalletMode('link');
            setAccountGate('landing');
          } else {
            setLegacyWalletMode(null);
            setAccountGate('verified');
          }
          return;
        }
        if (solanaAuthEnabled && !walletBoundSession) {
          setLegacyWalletMode('import');
          setAccountGate('landing');
          return;
        }
        void playerSync<{ state: unknown; revision: number; migrated: boolean }>('game_state_migrate', { state: legacyStateRef.current }).then((migrated) => {
          if (cancelled || !migrated) { setAccountGate('error'); return; }
          hydrateServerState(migrated.state);
          clearLegacyState();
          serverStateRevisionRef.current = migrated.revision;
          setServerStateRevision(migrated.revision);
          setServerStateReady(true);
          setAccountGate('verified');
        });
      });
      }).finally(() => {
        if (accountStatusRequestRef.current === request) accountStatusRequestRef.current = null;
      });
    };
    void loadAccount();
    const onFocus = () => {
      if (!solanaAuthEnabled || !walletBoundSession || document.visibilityState !== 'visible') return;
      void restoreSolanaWalletSession().then((session) => {
        if (session || cancelled) return;
        void supabase.auth.signOut({ scope: 'local' }).finally(() => window.location.replace('/'));
      });
    };
    document.addEventListener('visibilitychange', onFocus);
    return () => { cancelled = true; stopWalletEvents(); window.clearInterval(limitTimer); document.removeEventListener('visibilitychange', onFocus); };
  }, [accountCheckAttempt, hydrateServerState]);

  const [linkedWalletAddress, setLinkedWalletAddress] = useState<string | null>(null);
  const loggingOutRef = useRef(false);
  const logout = async () => {
    if (loggingOutRef.current) return;
    const current = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
    // An anonymous Guest has no recovery path: signing out would orphan its progress.
    if (current.data.session?.user.is_anonymous === true &&
      !window.confirm('Guest progress cannot be recovered after logout. Log out anyway?')) return;
    loggingOutRef.current = true;
    // Best-effort final save; saves are debounced, so flush twice within a short bound.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      flushServerSaveRef.current();
      const deadline = Date.now() + 2_000;
      while (saveInFlightRef.current && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    await revokeSolanaWalletSession('logout').catch(() => undefined);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    window.location.replace('/');
  };

  flushServerSaveRef.current = () => {
    const revision = serverStateRevisionRef.current;
    if (!serverStateReady || revision === null || saveInFlightRef.current) return;
    const state = saveStateRef.current;
    const version = saveStateVersionRef.current;
    if (version <= savedStateVersionRef.current) return;
    const incomeFingerprint = JSON.stringify({
      team: state.team,
      heroes: state.ownedHeroes.map((hero) => ({ uid: hero.uid, heroId: hero.heroId, level: hero.level, stars: hero.stars, equipped: hero.equipped })),
      items: state.inventory.map((item) => ({ uid: item.uid, itemId: item.itemId, level: item.level, enchantLevel: item.enchantLevel, power: item.power })),
      training: state.trainingCamp.heroUids,
      accountLevel: state.accountLevel,
      currentLocation: state.currentLocation,
      highestLocation: state.highestLocation,
    });
    saveInFlightRef.current = true;
    void playerSync<{ revision: number; state?: unknown; conflict?: boolean }>('game_state_save', { state, revision }).then((saved) => {
      if (!saved?.revision) return;
      savedStateVersionRef.current = Math.max(savedStateVersionRef.current, version);
      const latestRevision = serverStateRevisionRef.current ?? 0;
      if (saved.state && saved.revision > latestRevision) hydrateServerState(saved.state);
      if (saved.revision > latestRevision) {
        serverStateRevisionRef.current = saved.revision;
        setServerStateRevision(saved.revision);
      }
      if (incomeFingerprint !== confirmedIncomeFingerprintRef.current) {
        confirmedIncomeFingerprintRef.current = incomeFingerprint;
        void tokenomics.refreshIncome(saved.revision);
      }
    }).finally(() => {
      saveInFlightRef.current = false;
      if (saveStateVersionRef.current > version) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => flushServerSaveRef.current(), 800);
      }
    });
  };

  useEffect(() => {
    saveStateRef.current = game.state;
    saveStateVersionRef.current += 1;
    if (!serverStateReady) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => flushServerSaveRef.current(), 800);
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); };
  }, [game.state, serverStateReady]);

  useEffect(() => {
    if (serverTokenBalance === undefined) return;
    setServerTokenBalance(serverTokenBalance);
  }, [serverTokenBalance, setServerTokenBalance]);

  useEffect(() => {
    if (!boostStatus) return;
    const completed = [
      boostStatus.login_days >= 1,
      boostStatus.online_seconds >= 60,
      boostStatus.tokens_earned >= 10,
      boostStatus.tokens_spent >= 10,
      boostStatus.token_balance >= 1_000,
    ].filter(Boolean).length;
    applyServerBoostStatus(boostStatus.active, completed * 20);
  }, [boostStatus, applyServerBoostStatus]);

  useEffect(() => {
    if (pityStatus) applyServerPityStatus(pityStatus);
  }, [pityStatus, applyServerPityStatus]);

  useEffect(() => {
    if (ascensionFocusStatus) applyServerAscensionFocus(ascensionFocusStatus);
  }, [ascensionFocusStatus, applyServerAscensionFocus]);

  useEffect(() => {
    if (game.serverRevisionHint !== null && game.serverRevisionHint > (serverStateRevisionRef.current ?? 0)) {
      serverStateRevisionRef.current = game.serverRevisionHint;
      setServerStateRevision(game.serverRevisionHint);
    }
  }, [game.serverRevisionHint]);

  useEffect(() => {
    if (game.trainingIncomeRevision !== null) void refreshIncome(game.trainingIncomeRevision);
  }, [game.trainingIncomeRevision, refreshIncome]);

  useEffect(() => {
    if (serverStateRevision !== null) applyServerRevision(serverStateRevision);
  }, [serverStateRevision, applyServerRevision]);

  useEffect(() => {
    if (!resourceState || !resourceRevision || resourceRevision <= (serverStateRevision ?? 0)) return;
    mergeServerResourceState(resourceState);
    serverStateRevisionRef.current = resourceRevision;
    setServerStateRevision(resourceRevision);
  }, [resourceState, resourceRevision, serverStateRevision, mergeServerResourceState]);

  useEffect(() => {
    if (pendingTokens < 1 || autoClaimingRef.current) return;
    autoClaimingRef.current = true;
    void claimTokens().then((result) => {
      if (result) applyServerTokenClaim(result.claimed, result.tokenBalance);
    }).finally(() => { autoClaimingRef.current = false; });
  }, [pendingTokens, claimTokens, applyServerTokenClaim]);

  useEffect(() => {
    const hourlyRate = tokenomics.status?.my_hourly_share ?? 0;
    if (!demoTokenomicsEnabled || !game.state.walletAddress || hourlyRate <= 0) return;
    const timer = window.setInterval(() => {
      // $HERO demo accrual is continuous while online; no active-window cut-off.
      demoTokenRemainderRef.current += hourlyRate / 3600;
      const whole = Math.floor(demoTokenRemainderRef.current);
      if (whole > 0) {
        demoTokenRemainderRef.current -= whole;
        creditServerTokens(whole);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [tokenomics.status?.my_hourly_share, game.state.walletAddress, game.state.boost.active, game.state.activeUntil, creditServerTokens]);
  const [tab, setTab] = useState<Tab>('main');
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const [showBoost, setShowBoost] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showPromoCode, setShowPromoCode] = useState(false);
  const setCombatPresentationVisible = game.setCombatPresentationVisible;

  useEffect(() => {
    setCombatPresentationVisible(accountGate === 'verified' && routePath !== '/wiki' && tab === 'main');
  }, [accountGate, routePath, tab, setCombatPresentationVisible]);

  const applyPromoRedemption = (result: PromoRedemption) => {
    hydrateServerState(result.state);
    serverStateRevisionRef.current = result.revision;
    setServerStateRevision(result.revision);
    setServerTokenBalance(result.token_balance);
  };

  useEffect(() => {
    const handlePopState = () => setRoutePath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const openWiki = () => {
    window.history.pushState(null, '', '/wiki');
    setRoutePath('/wiki');
  };

  const closeWiki = () => {
    window.history.pushState(null, '', '/#game');
    setRoutePath('/');
  };

  useEffect(() => {
    if (accountGate === 'checking' || accountGate === 'error') return;
    if (routePath === '/wiki') return;
    const target = accountGate === 'verified' ? '/#game' : '/';
    if (`${window.location.pathname}${window.location.hash}` !== target) {
      window.history.replaceState(null, '', target);
    }
  }, [accountGate, routePath]);

  if (routePath === '/wiki') {
    return (
      <div className={`game-shell game-motion-${game.state.battleAnimationMode} h-screen overflow-auto bg-px-bg text-px-text`}>
        <div className="sticky top-0 z-20 flex min-h-[54px] items-center justify-between gap-3 border-b border-[#59472d] bg-[#0b0c0a]/95 px-3 py-2 backdrop-blur">
          <img src="/assets/brand/heroloop-logo.png" alt="HeroLoop" width={154} height={46} className="h-9 w-auto max-w-[148px] object-contain" />
          <button type="button" onClick={closeWiki} className="game-control game-primary flex items-center gap-2 px-3 py-2 text-xs font-black">
            <ArrowLeft size={15} aria-hidden="true" /> Back to game
          </button>
        </div>
        <main className="mx-auto min-h-[calc(100vh-54px)] w-full max-w-[1100px]">
          <GuidesScreen />
        </main>
      </div>
    );
  }

  if (accountGate !== 'verified') {
    if (accountGate === 'landing') return <LandingScreen game={game} legacyWalletMode={legacyWalletMode} />;
    return <div className="grid h-screen place-items-center bg-[#07090d] p-4 text-center text-[#d9d0c0]"><div className="material-panel max-w-sm p-5"><div className="section-kicker">Account verification</div><div className="mt-2 text-sm">{accountGate === 'error' ? 'Account service is unavailable.' : 'Checking your registered account…'}</div>{accountGate === 'error' && <button type="button" onClick={() => setAccountCheckAttempt((value) => value + 1)} className="game-control game-primary mt-4 px-4 text-xs font-black">Retry</button>}</div></div>;
  }

  return (
    <div className={`game-shell game-motion-${game.state.battleAnimationMode} flex h-screen flex-col overflow-hidden bg-px-bg text-px-text`}>
      <GameNavBar
        tab={tab}
        onChange={(nextTab) => {
          if (nextTab === 'guides') {
            openWiki();
            return;
          }
          setTab(nextTab);
        }}
        gold={game.state.gold}
        hero={game.state.hero}
        mailCount={0}
        walletAddress={linkedWalletAddress}
        onWalletClick={() => setShowWallet(true)}
        onTokensClick={() => setShowBoost(true)}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <MainScreen game={game} tokenomics={tokenomics} onBoostClick={() => setShowBoost(true)} onGuidesClick={openWiki} />
      </div>

      {tab !== 'main' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-[5px]"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setTab('main');
          }}
        >
          <section className={`relative flex max-h-[calc(100vh-24px)] w-full flex-col overflow-hidden rounded-xl border border-[#9a6a22] bg-[#100f0c] shadow-[0_24px_90px_rgba(0,0,0,.8),0_0_32px_rgba(199,135,31,.12)] ${tab === 'summon' ? 'h-[calc(100vh-32px)] max-w-[1225px]' : tab === 'training' ? 'h-[calc(100vh-32px)] max-w-[1120px]' : tab === 'shop' || tab === 'referrals' ? 'max-w-[760px]' : 'max-w-[980px]'}`}>
            <button
              type="button"
              className="game-control absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center"
              onClick={() => setTab('main')}
              aria-label="Close"
            >
              <X size={17} />
            </button>
            <div className="min-h-0 flex-1 overflow-auto">
              {tab === 'heroes'      && <HeroesScreen game={game} />}
              {tab === 'summon'      && <SummonScreen game={game} rarityCapacity={tokenomics.status?.rarity_capacity} />}
              {tab === 'training'    && <TrainingCampScreen game={game} />}
              {tab === 'crafting'    && <CraftingScreen />}
              {tab === 'shop'        && <ShopScreen game={game} />}
              {tab === 'market'      && <MarketplaceScreen game={game} tokenomics={tokenomics} />}
              {tab === 'leaderboard' && <LeaderboardScreen game={game} />}
              {tab === 'referrals'   && <ReferralsScreen game={game} />}
            </div>
          </section>
        </div>
      )}

      <FooterBar onLogout={() => void logout()} onGuidesClick={openWiki} onCodeClick={() => setShowPromoCode(true)} />

      {game.offlineEarnings && (
        <OfflineModal
          gold={game.offlineEarnings.gold}
          seconds={game.offlineEarnings.seconds}
          chests={game.offlineEarnings.chests}
          xp={game.offlineEarnings.xp}
          onClose={game.collectOffline}
        />
      )}
      {game.chestOpenResult && (
        <ChestOpenModal
          items={game.chestOpenResult}
          game={game}
          heroes={game.state.ownedHeroes}
          onClose={game.closeChestResult}
        />
      )}
      {showBoost && (
        <BoostMaxModal game={game} tokenomics={tokenomics} onClose={() => setShowBoost(false)} />
      )}
      {showWallet && (
        <GameWalletModal
          guestId={game.state.walletAddress}
          walletAddress={linkedWalletAddress}
          balance={game.state.hero}
          pending={tokenomics.status?.pending_tokens ?? 0}
          claimed={tokenomics.status?.total_claimed ?? 0}
          earned={game.state.totalTokensEarned}
          onClose={() => setShowWallet(false)}
        />
      )}
      {showPromoCode && <PromoCodeModal onClose={() => setShowPromoCode(false)} onRedeemed={applyPromoRedemption} />}
    </div>
  );
}

export default App;
