import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useGame } from '@/game/useGame';
import { GameNavBar } from '@/components/GameNavBar';
import { FooterBar } from '@/components/FooterBar';
import { OfflineModal } from '@/components/OfflineModal';
import { ChestOpenModal } from '@/components/ChestOpenModal';
import { BoostMaxModal } from '@/components/BoostMaxModal';
import { GameWalletModal } from '@/components/GameWalletModal';
import { WelcomeTutorialModal } from '@/components/WelcomeTutorialModal';
import { LandingScreen } from '@/screens/LandingScreen';
import { MainScreen } from '@/screens/MainScreen';
import { HeroesScreen } from '@/screens/HeroesScreen';
import { SummonScreen } from '@/screens/SummonScreen';
import { TrainingCampScreen } from '@/screens/TrainingCampScreen';
import { ShopScreen } from '@/screens/ShopScreen';
import { MarketplaceScreen } from '@/screens/MarketplaceScreen';
import { LeaderboardScreen } from '@/screens/LeaderboardScreen';
import { ReferralsScreen } from '@/screens/ReferralsScreen';
import type { Tab } from '@/components/TopMenu';
import { canMineTokens, teamPower as calculateAccountPower } from '@/game/engine';
import { useTokenomics } from '@/game/useTokenomics';
import { demoTokenomicsEnabled, playerSync, tokenomicsEnabled } from '@/game/backend';
import { clearLegacyState } from '@/game/state';

function App() {
  const game = useGame();
  const walletAddress = game.state.walletAddress;
  const hydrateServerState = game.hydrateServerState;
  const [accountGate, setAccountGate] = useState<'landing' | 'checking' | 'verified' | 'error'>(tokenomicsEnabled ? 'checking' : (walletAddress ? 'verified' : 'landing'));
  const [accountCheckAttempt, setAccountCheckAttempt] = useState(0);
  const [serverStateReady, setServerStateReady] = useState(false);
  const [serverStateRevision, setServerStateRevision] = useState<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const legacyStateRef = useRef(game.state);
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
  const creditServerTokens = game.creditServerTokens;
  const applyServerTokenClaim = game.applyServerTokenClaim;
  const applyServerBoostStatus = game.applyServerBoostStatus;
  const applyServerPityStatus = game.applyServerPityStatus;
  const setServerTokenBalance = game.setServerTokenBalance;
  const hydrationVersion = game.hydrationVersion;
  const pendingTokens = tokenomics.status?.pending_tokens ?? 0;
  const boostStatus = tokenomics.status?.boost ?? null;
  const pityStatus = tokenomics.status?.pity ?? null;
  const serverTokenBalance = tokenomics.status?.token_balance;
  const resourceState = tokenomics.status?.resource_state;
  const resourceRevision = tokenomics.status?.resource_revision;

  useEffect(() => {
    if (!serverStateReady) legacyStateRef.current = game.state;
  }, [game.state, serverStateReady]);

  useEffect(() => {
    if (!tokenomicsEnabled) { setAccountGate('verified'); return; }
    let cancelled = false;
    setAccountGate('checking');
    void playerSync<{ exists: boolean; username: string | null; account_id: string }>('account_status').then((account) => {
      if (cancelled) return;
      if (!account) { setAccountGate('error'); return; }
      if (!account.exists || !account.username) {
        setAccountGate('landing');
        return;
      }
      void playerSync<{ state: unknown; revision: number | null }>('game_state_load').then((saved) => {
        if (cancelled || !saved) { setAccountGate('error'); return; }
        if (saved.state && saved.revision) {
          hydrateServerState(saved.state);
          clearLegacyState();
          setServerStateRevision(saved.revision);
          setServerStateReady(true);
          setAccountGate('verified');
          return;
        }
        void playerSync<{ state: unknown; revision: number; migrated: boolean }>('game_state_migrate', { state: legacyStateRef.current }).then((migrated) => {
          if (cancelled || !migrated) { setAccountGate('error'); return; }
          hydrateServerState(migrated.state);
          clearLegacyState();
          setServerStateRevision(migrated.revision);
          setServerStateReady(true);
          setAccountGate('verified');
        });
      });
    });
    return () => { cancelled = true; };
  }, [accountCheckAttempt, hydrateServerState, walletAddress]);

  useEffect(() => {
    if (!serverStateReady || serverStateRevision === null) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void playerSync<{ revision: number; state?: unknown; conflict?: boolean }>('game_state_save', { state: game.state, revision: serverStateRevision }).then((saved) => {
        if (saved?.conflict && saved.state) hydrateServerState(saved.state);
        if (saved?.revision) setServerStateRevision(saved.revision);
      });
    }, 800);
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); };
  }, [game.state, hydrateServerState, serverStateReady, serverStateRevision]);

  useEffect(() => {
    if (serverTokenBalance === undefined) return;
    setServerTokenBalance(serverTokenBalance);
  }, [serverTokenBalance, hydrationVersion, setServerTokenBalance]);

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
    if (game.serverRevisionHint !== null) setServerStateRevision(game.serverRevisionHint);
  }, [game.serverRevisionHint]);

  useEffect(() => {
    if (!resourceState || !resourceRevision || resourceRevision <= (serverStateRevision ?? 0)) return;
    hydrateServerState(resourceState);
    setServerStateRevision(resourceRevision);
  }, [resourceState, resourceRevision, serverStateRevision, hydrateServerState]);

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
  const [showBoost, setShowBoost] = useState(false);
  const [showWallet, setShowWallet] = useState(false);

  useEffect(() => {
    const target = accountGate === 'verified' ? '/#game' : '/';
    if (`${window.location.pathname}${window.location.hash}` !== target) {
      window.history.replaceState(null, '', target);
    }
  }, [accountGate]);

  if (accountGate !== 'verified') {
    if (accountGate === 'landing') return <LandingScreen game={game} />;
    return <div className="grid h-screen place-items-center bg-[#07090d] p-4 text-center text-[#d9d0c0]"><div className="material-panel max-w-sm p-5"><div className="section-kicker">Account verification</div><div className="mt-2 text-sm">{accountGate === 'error' ? 'Account service is unavailable.' : 'Checking your registered account…'}</div>{accountGate === 'error' && <button type="button" onClick={() => setAccountCheckAttempt((value) => value + 1)} className="game-control game-primary mt-4 px-4 text-xs font-black">Retry</button>}</div></div>;
  }

  return (
    <div className="game-shell flex h-screen flex-col overflow-hidden bg-px-bg text-px-text">
      <GameNavBar
        tab={tab}
        onChange={setTab}
        gold={game.state.gold}
        hero={game.state.hero}
        username={game.state.username}
        mailCount={0}
        boostActive={!!game.state.boost?.active}
        onBoostClick={() => setShowBoost(true)}
        onWalletClick={() => setShowWallet(true)}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <MainScreen game={game} tokenomics={tokenomics} />
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
              {tab === 'summon'      && <SummonScreen game={game} />}
              {tab === 'training'    && <TrainingCampScreen game={game} />}
              {tab === 'shop'        && <ShopScreen game={game} />}
              {tab === 'market'      && <MarketplaceScreen game={game} tokenomics={tokenomics} />}
              {tab === 'leaderboard' && <LeaderboardScreen game={game} />}
              {tab === 'referrals'   && <ReferralsScreen game={game} />}
            </div>
          </section>
        </div>
      )}

      <FooterBar game={game} />

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
          address={game.state.walletAddress}
          balance={game.state.hero}
          onClose={() => setShowWallet(false)}
        />
      )}
      {game.state.walletAddress && !game.state.tutorial.welcomeCompleted && <WelcomeTutorialModal game={game} />}
    </div>
  );
}

export default App;
