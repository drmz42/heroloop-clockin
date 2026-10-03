import heroHost from '@/theme/premium/assets/hero-host.webp';
import logo from '@/theme/premium/assets/logo-heroloop.webp';
import { BuildVersion } from '@/platform/BuildVersion';
import '@/theme/premium/premium-landing.css';
import './app-loading.css';

/** Keep the start-screen artwork visible while code, wallet and save data load. */
export function AppLoadingScreen({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="l5-root hl-app-entry hl-app-loading">
      <main>
        <section className="l5-hero" aria-label="HeroLoop">
          <div className="l5-hero-art" style={{ backgroundImage: `url(${heroHost})` }} aria-hidden="true" />
          <div className="l5-hero-fade" aria-hidden="true" />
          <div className="l5-hero-copy">
            <p className="l5-eyebrow">Collect heroes. Conquer the endless loop.</p>
            <h1><img src={logo} alt="HeroLoop" width={1100} height={367} /></h1>
            <p className="l5-tagline">A dark-fantasy AFK RPG</p>
            <div className="hl-app-loading-status" role="status" aria-live="polite">
              {onRetry ? 'Account service is unavailable.' : <><span className="hl-app-loading-spinner" aria-hidden="true" />Loading…</>}
            </div>
            {onRetry && <button type="button" onClick={onRetry} className="game-control game-primary hl-app-loading-retry">Retry</button>}
          </div>
        </section>
      </main>
      <BuildVersion />
    </div>
  );
}
