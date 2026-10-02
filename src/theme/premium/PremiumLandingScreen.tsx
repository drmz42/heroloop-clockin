// Game-enabled landing controller. The public website imports only its presentation view.
import { useEffect, useState } from 'react';
import { useGame } from '@/game/useGame';
import { Onboarding } from '@/screens/LandingScreen';
import { setUiTheme } from '@/theme/uiTheme';
import PremiumLandingView from './PremiumLandingView';
export { ArtButton } from './PremiumLandingView';

export default function PremiumLandingScreen() {
  const game = useGame();
  const [onboarding, setOnboarding] = useState(false);
  useEffect(() => {
    if (game.state.walletAddress) window.location.replace('/#game');
  }, [game.state.walletAddress]);
  return <PremiumLandingView onPlay={() => setOnboarding(true)} referralTotal={game.state.referral?.invitedUsers?.length ?? 0} onClassic={() => setUiTheme('classic')}>
    {onboarding && <Onboarding game={game} onAccountReady={() => window.location.replace('/#game')} onClose={() => setOnboarding(false)} />}
  </PremiumLandingView>;
}
