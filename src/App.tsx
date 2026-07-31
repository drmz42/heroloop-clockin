import { useState } from 'react';
import { useGame } from '@/game/useGame';
import { GameNavBar } from '@/components/GameNavBar';
import { FooterBar } from '@/components/FooterBar';
import { OfflineModal } from '@/components/OfflineModal';
import { ChestOpenModal } from '@/components/ChestOpenModal';
import { BoostMaxModal } from '@/components/BoostMaxModal';
import { GameWalletModal } from '@/components/GameWalletModal';
import { LandingScreen } from '@/screens/LandingScreen';
import { MainScreen } from '@/screens/MainScreen';
import { HeroesScreen } from '@/screens/HeroesScreen';
import { SummonScreen } from '@/screens/SummonScreen';
import { ShopScreen } from '@/screens/ShopScreen';
import { MarketplaceScreen } from '@/screens/MarketplaceScreen';
import { LeaderboardScreen } from '@/screens/LeaderboardScreen';
import { ReferralsScreen } from '@/screens/ReferralsScreen';
import type { Tab } from '@/components/TopMenu';

function App() {
  const game = useGame();
  const [tab, setTab] = useState<Tab>('main');
  const [showBoost, setShowBoost] = useState(false);
  const [showWallet, setShowWallet] = useState(false);

  if (!game.state.walletAddress) {
    return <LandingScreen game={game} />;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-px-bg text-px-text">
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
        {tab === 'main'        && <MainScreen       game={game} />}
        {tab === 'heroes'      && <HeroesScreen     game={game} />}
        {tab === 'summon'      && <SummonScreen     game={game} />}
        {tab === 'shop'        && <ShopScreen       game={game} />}
        {tab === 'market'      && <MarketplaceScreen game={game} />}
        {tab === 'leaderboard' && <LeaderboardScreen game={game} />}
        {tab === 'referrals'   && <ReferralsScreen  game={game} />}
      </div>

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
        <BoostMaxModal game={game} onClose={() => setShowBoost(false)} />
      )}
      {showWallet && (
        <GameWalletModal
          address={game.state.walletAddress}
          balance={game.state.hero}
          onClose={() => setShowWallet(false)}
        />
      )}
    </div>
  );
}

export default App;
