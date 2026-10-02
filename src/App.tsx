import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { bagItemCount, useGame } from '@/game/useGame';
import { GameNavBar } from '@/components/GameNavBar';
import { GameProgressBar } from '@/components/GameProgressBar';
import { isolatedHackathon } from '@/game/editionStorage';
import { readyQuestCount } from '@/game/tutorialProgress';
import { FooterBar } from '@/components/FooterBar';
import { MobileTabBar } from '@/components/MobileTabBar';
import { isAndroidLayout, isAppShell, type MobileSection } from '@/platform/platform';
import { SupportTicketModal } from '@/components/SupportTicketModal';
import { MailboxModal } from '@/components/MailboxModal';
import { OfflineModal } from '@/components/OfflineModal';
import { ChestOpenModal } from '@/components/ChestOpenModal';
import { BoostMaxModal } from '@/components/BoostMaxModal';
import { GameWalletModal } from '@/components/GameWalletModal';
import { PromoCodeModal, type PromoRedemption } from '@/components/PromoCodeModal';
import { LandingScreen } from '@/screens/LandingScreen';
import { BuildVersion } from '@/platform/BuildVersion';
import { AppEntryScreen } from '@/platform/AppEntryScreen';
import { HERO_MAP } from '@/game/heroes';
import { OfflineBar } from '@/platform/OfflineBar';
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
import { demoTokenomicsEnabled, playerSync, authClient, tokenomicsEnabled } from '@/game/backend';
import { isAuthTransient, runAuthCall } from '@/game/authTransient';
import { clearLegacyState, inventoryCapacity } from '@/game/state';
import {
  compatibleSolanaWallets,
  restoreSolanaWalletSession,
  readWalletBinding,
  revokeSolanaWalletSession,
  setWalletBindingBoost,
  walletBindingExpired,
  solanaAuthEnabled,
  nativeMwaSession,
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
  const saveConflictStreakRef = useRef(0);
  const lastScheduledTeamRef = useRef(game.state.team.join('|'));
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
        // A temporary Auth failure - including a rejected getSession() call - keeps the stored
        // identity and offers Retry instead of signing out.
        const current = await runAuthCall(() => authClient.auth.getSession());
        if (isAuthTransient(current)) { if (!cancelled) setAccountGate('error'); return; }
        if (current.data.session?.user.is_anonymous !== true) {
          let walletSession: Awaited<ReturnType<typeof restoreSolanaWalletSession>>;
          try {
            walletSession = await restoreSolanaWalletSession();
          } catch {
            if (!cancelled) setAccountGate('error');
            return;
          }
          if (!walletSession) {
            await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
            if (!cancelled) setAccountGate('landing');
            return;
          }
          const walletOptional = nativeMwaSession(walletSession.walletName);
          const wallet = compatibleSolanaWallets().find((candidate) =>
            candidate.name === walletSession.walletName && candidate.accounts.some((account) => account.address === walletSession.address));
          if (!wallet && !walletOptional) {
            await revokeSolanaWalletSession('wallet_disconnect');
            await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
            if (!cancelled) setAccountGate('landing');
            return;
          }
          walletBoundSession = true;
          if (!cancelled) setLinkedWalletAddress(walletSession.address);
          limitTimer = window.setInterval(() => {
            const binding = readWalletBinding();
            if (!binding || !walletBindingExpired(binding)) return;
            void revokeSolanaWalletSession('logout').finally(() =>
              authClient.auth.signOut({ scope: 'local' }).finally(() => window.location.replace('/')));
          }, 60_000);
          if (wallet) stopWalletEvents = watchSolanaWalletSession(walletSession, wallet, (reason) => {
            void revokeSolanaWalletSession(reason).finally(() =>
              authClient.auth.signOut({ scope: 'local' }).finally(() => window.location.replace('/')));
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
        void authClient.auth.signOut({ scope: 'local' }).finally(() => window.location.replace('/'));
      }).catch(() => undefined); // temporary failure: keep playing, the next focus re-checks
    };
    document.addEventListener('visibilitychange', onFocus);
    return () => { cancelled = true; stopWalletEvents(); window.clearInterval(limitTimer); document.removeEventListener('visibilitychange', onFocus); };
  }, [accountCheckAttempt, hydrateServerState]);

  const [linkedWalletAddress, setLinkedWalletAddress] = useState<string | null>(null);
  const loggingOutRef = useRef(false);
  const logout = async () => {
    if (loggingOutRef.current) return;
    // A temporary Auth failure here must not silently skip the Guest data-loss confirmation below
    // (a rejected/unresolved session check is neither confirmed-anonymous nor confirmed-linked).
    const current = await runAuthCall(() => authClient.auth.getSession());
    if (isAuthTransient(current)) {
      window.alert('Account service unavailable, please try again.');
      return;
    }
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
    await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
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
    let retryScheduled = false;
    let saveError = '';
    const rememberRevision = (nextRevision: number) => {
      const latestRevision = serverStateRevisionRef.current ?? 0;
      if (nextRevision > latestRevision) {
        serverStateRevisionRef.current = nextRevision;
        setServerStateRevision(nextRevision);
      }
    };
    const scheduleSaveRetry = (minimumDelay = 0) => {
      saveConflictStreakRef.current += 1;
      const retryDelay = Math.max(minimumDelay, Math.min(8_000, 800 * (2 ** Math.min(saveConflictStreakRef.current, 3))));
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => flushServerSaveRef.current(), retryDelay);
      retryScheduled = true;
    };
    void (async () => {
      let saved = await playerSync<{ revision: number; state?: unknown; conflict?: boolean }>('game_state_save', { state, revision }, (error) => { saveError = error; });
      // A 409 includes the current revision. Rebase the exact pending client
      // intent once; the server still canonicalizes all protected progression,
      // currency and inventory fields before it writes.
      if (saved?.conflict && Number.isInteger(saved.revision) && saved.revision > 0) {
        rememberRevision(saved.revision);
        saved = await playerSync<{ revision: number; state?: unknown; conflict?: boolean }>('game_state_save', { state, revision: saved.revision }, (error) => { saveError = error; });
      }
      if (!saved?.revision) {
        scheduleSaveRetry(saveError === 'rate_limited' ? 65_000 : 0);
        return;
      }
      if (saved.conflict) {
        rememberRevision(saved.revision);
        scheduleSaveRetry();
        return;
      }
      saveConflictStreakRef.current = 0;
      savedStateVersionRef.current = Math.max(savedStateVersionRef.current, version);
      game.confirmPersistedFormation(state.team);
      const latestRevision = serverStateRevisionRef.current ?? 0;
      // Never overwrite a newer local action with this older successful save.
      if (saved.state && saved.revision > latestRevision && saveStateVersionRef.current === version) hydrateServerState(saved.state);
      rememberRevision(saved.revision);
      if (incomeFingerprint !== confirmedIncomeFingerprintRef.current) {
        confirmedIncomeFingerprintRef.current = incomeFingerprint;
        void tokenomics.refreshIncome(saved.revision);
      }
    })().finally(() => {
      saveInFlightRef.current = false;
      if (!retryScheduled && saveStateVersionRef.current > version) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => flushServerSaveRef.current(), 800);
      }
    });
  };

  useEffect(() => {
    saveStateRef.current = game.state;
    saveStateVersionRef.current += 1;
    if (!serverStateReady) return;
    const teamKey = game.state.team.join('|');
    const formationChanged = teamKey !== lastScheduledTeamRef.current;
    lastScheduledTeamRef.current = teamKey;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => flushServerSaveRef.current(), formationChanged ? 0 : 800);
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
  const [mobileSection, setMobileSection] = useState<MobileSection>('battle');
  const [moreOpen, setMoreOpen] = useState(false);
  // Android layout: a window or the More sheet takes one history entry, so the
  // system Back button closes it instead of leaving the game.
  const overlayOpen = isAndroidLayout && (tab !== 'main' || moreOpen);
  const overlayHistory = useRef({ pushed: false, ignoreNextPop: false });
  useEffect(() => {
    if (!isAndroidLayout) return;
    const entry = overlayHistory.current;
    if (overlayOpen && !entry.pushed) {
      window.history.pushState({ heroloopOverlay: true }, '');
      entry.pushed = true;
    } else if (!overlayOpen && entry.pushed) {
      entry.pushed = false;
      entry.ignoreNextPop = true;
      window.history.back();
    }
  }, [overlayOpen]);
  useEffect(() => {
    if (!isAndroidLayout) return;
    const entry = overlayHistory.current;
    const onPop = () => {
      if (entry.ignoreNextPop) { entry.ignoreNextPop = false; return; }
      if (!entry.pushed) return;
      entry.pushed = false;
      setMoreOpen(false);
      setTab('main');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const openQuests = () => {
    setTab('main');
    setMoreOpen(false);
    setMobileSection('quests');
    window.requestAnimationFrame(() => document.getElementById('game-quest-list')?.scrollIntoView({ block: 'start' }));
  };
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const [showBoost, setShowBoost] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showPromoCode, setShowPromoCode] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [showMail, setShowMail] = useState(false);
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
    // Guides opened from the More sheet reuse its history entry; closing the sheet must not
    // step Back over the new /wiki entry (Android layout).
    const entry = overlayHistory.current;
    if (entry.pushed) {
      entry.pushed = false;
      window.history.replaceState(null, '', '/wiki');
    } else {
      window.history.pushState(null, '', '/wiki');
    }
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
    // The Android app opens on the landing hero with one Play button; Play leads to
    // wallet sign-in or registration. The marketing sections of the landing stay on the web.
    if (accountGate === 'landing' && isAppShell) return <AppEntryScreen game={game} legacyWalletMode={legacyWalletMode} onAccountReady={() => setAccountCheckAttempt((value) => value + 1)} />;
    if (accountGate === 'landing') return <LandingScreen game={game} legacyWalletMode={legacyWalletMode} onAccountReady={() => setAccountCheckAttempt((value) => value + 1)} />;
    return <div className="grid h-screen place-items-center bg-[#07090d] p-4 text-center text-[#d9d0c0]"><div className="material-panel max-w-sm p-5"><div className="section-kicker">Account verification</div><div className="mt-2 text-sm">{accountGate === 'error' ? 'Account service is unavailable.' : 'Checking your registered account…'}</div>{accountGate === 'error' && <button type="button" onClick={() => setAccountCheckAttempt((value) => value + 1)} className="game-control game-primary mt-4 px-4 text-xs font-black">Retry</button>}</div>{isAppShell && <BuildVersion />}</div>;
  }

  return (
    <div className={`game-shell ${isolatedHackathon ? 'has-game-progress' : ''} game-motion-${game.state.battleAnimationMode} flex h-screen flex-col overflow-hidden bg-px-bg text-px-text`}>
      {isolatedHackathon && <GameProgressBar power={game.teamPower()} readyQuests={readyQuestCount(game.state)} identity={game.state.walletAddress} onQuestsClick={openQuests} commander={isAndroidLayout ? { heroId: HERO_MAP[game.state.avatarHeroId] ? game.state.avatarHeroId : game.state.ownedHeroes[0]?.heroId ?? '', level: game.state.accountLevel } : undefined}  boost={isAndroidLayout ? { active: game.state.boost.active, onClick: () => setShowBoost(true) } : undefined} />}
      {isAndroidLayout && <OfflineBar />}
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
        mailCount={game.mailCount}
        onMailClick={() => setShowMail(true)}
        walletAddress={linkedWalletAddress}
        onWalletClick={() => setShowWallet(true)}
        onTokensClick={() => setShowBoost(true)}
      />

      {tokenomics.status?.account_restriction && (
        <div role="status" data-account-restriction={tokenomics.status.account_restriction} className="border-b border-[#9a6a22] bg-[#2a1f0e] px-4 py-2 text-center text-xs leading-snug text-[#f0d9a8]">
          {tokenomics.status.account_restriction === 'hold'
            ? 'Your account is under extended review. Your progress and rewards are safe. Market, purchases and withdrawals are paused; please contact support.'
            : 'Account check in progress. It usually takes up to 1 hour, sometimes longer. No need to worry: your progress and rewards are safe and full play returns soon. We check accounts to catch cheaters, and this may be a false alarm. Market, purchases and withdrawals are paused meanwhile.'}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <MainScreen game={game} tokenomics={tokenomics} onBoostClick={() => setShowBoost(true)} onGuidesClick={openWiki} onRewardBoostClick={() => setTab('shop')} onQuestsClick={openQuests} />
      </div>

      {tab !== 'main' && (
        <div
          className="game-window-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-[5px]"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setTab('main');
          }}
        >
          <section className={`game-window relative flex max-h-[calc(100vh-24px)] w-full flex-col overflow-hidden rounded-xl border border-[#9a6a22] bg-[#100f0c] shadow-[0_24px_90px_rgba(0,0,0,.8),0_0_32px_rgba(199,135,31,.12)] ${tab === 'summon' ? 'h-[calc(100vh-32px)] max-w-[1225px]' : tab === 'training' ? 'h-[calc(100vh-32px)] max-w-[1120px]' : tab === 'shop' || tab === 'referrals' ? 'max-w-[760px]' : 'max-w-[980px]'}`}>
            <button
              type="button"
              className="game-control game-window-close absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center"
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

      {isAndroidLayout ? (
        <MobileTabBar
          readyQuests={readyQuestCount(game.state)}
          tab={tab}
          section={mobileSection}
          moreOpen={moreOpen}
          onTab={setTab}
          onSection={setMobileSection}
          onMoreOpen={setMoreOpen}
          onGuides={openWiki}
          onCode={() => setShowPromoCode(true)}
          onSupport={() => setShowSupport(true)}
          onLogout={() => void logout()}
        />
      ) : (
        <FooterBar onLogout={() => void logout()} onGuidesClick={openWiki} onCodeClick={() => setShowPromoCode(true)} onSupportClick={() => setShowSupport(true)} />
      )}

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
          onPurchase={game.applySeekerPurchase}
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
      {showSupport && <SupportTicketModal onClose={() => setShowSupport(false)} />}
      {showMail && <MailboxModal onClose={() => setShowMail(false)} loadMail={game.loadMail} claimMail={game.claimMail} freeSlots={inventoryCapacity(game.state) - bagItemCount(game.state)} />}
    </div>
  );
}

export default App;
