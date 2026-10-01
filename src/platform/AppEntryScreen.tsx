// Start screen of the Android app (src/platform/platform.ts isAppShell): only the top of
// the premium landing - art, logo, one Play button. Play opens wallet sign-in or
// registration; a signed-in player never sees this screen, the game opens directly.
import { useState } from 'react';
import type { useGame } from '@/game/useGame';
import { Onboarding } from '@/screens/LandingScreen';
import { ArtButton } from '@/theme/premium/PremiumLandingScreen';
import heroHost from '@/theme/premium/assets/hero-host.webp';
import logo from '@/theme/premium/assets/logo-heroloop.webp';
import playArt from '@/theme/premium/assets/btn-play.webp';
import '@/theme/premium/premium-landing.css';

export function AppEntryScreen({ game, legacyWalletMode = null, onAccountReady }: {
  game: ReturnType<typeof useGame>;
  legacyWalletMode?: 'link' | 'import' | null;
  onAccountReady: () => void;
}) {
  const [signingIn, setSigningIn] = useState(false);
  return (
    <div className="l5-root hl-app-entry">
      <main>
        <section className="l5-hero" aria-labelledby="hl-app-entry-title">
          <div className="l5-hero-art" style={{ backgroundImage: `url(${heroHost})` }} aria-hidden="true" />
          <div className="l5-hero-fade" aria-hidden="true" />
          <div className="l5-hero-copy">
            <p className="l5-eyebrow">Collect heroes. Conquer the endless loop.</p>
            <h1 id="hl-app-entry-title"><img src={logo} alt="HeroLoop" width={1100} height={367} /></h1>
            <p className="l5-tagline">A dark-fantasy AFK RPG</p>
            <div className="l5-hero-cta">
              <ArtButton art={playArt} label="Play" onClick={() => setSigningIn(true)} className="l5-play" />
            </div>
            <p className="l5-micro">Sign in with your Solana wallet · no transaction, no gas</p>
          </div>
        </section>
      </main>
      {signingIn && <Onboarding game={game} legacyWalletMode={legacyWalletMode} onAccountReady={onAccountReady} onClose={() => setSigningIn(false)} />}
    </div>
  );
}
