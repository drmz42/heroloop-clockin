import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './theme/premium/premium-game.css';
import './platform/android.css';
import { captureSignupAttribution } from './game/signupAttribution';
import { applyUiTheme, resolveUiTheme } from './theme/uiTheme';
import { applyPlatform, isAppShell, webGameEntryAllowed } from './platform/platform';
import { AppLoadingScreen } from './platform/AppLoadingScreen';
import { AppUpdateBanner } from './platform/AppUpdateBanner';

captureSignupAttribution();
const uiTheme = resolveUiTheme();
applyUiTheme(uiTheme);
applyPlatform();

// eslint-disable-next-line react-refresh/only-export-components
const Landing4Screen = lazy(() => import('../test/landing4/Landing4Screen.tsx'));
// eslint-disable-next-line react-refresh/only-export-components
const PremiumLandingScreen = lazy(() => import('./theme/premium/PremiumLandingScreen.tsx'));
// eslint-disable-next-line react-refresh/only-export-components
const GameScreen = lazy(() => import('./App.tsx'));

// eslint-disable-next-line react-refresh/only-export-components
function RootScreen() {
  const [, setRoute] = useState(() => window.location.pathname + window.location.hash);

  useEffect(() => {
    const handleRouteChange = () => setRoute(window.location.pathname + window.location.hash);
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('popstate', handleRouteChange);
    return () => {
      window.removeEventListener('hashchange', handleRouteChange);
      window.removeEventListener('popstate', handleRouteChange);
    };
  }, []);

  // The Android app has no landing page: every entry goes to the game (sign-in first).
  // While web entry is off, browsers (Android Chrome included) start on the landing, whose Play is inert.
  const gameRoute = (isAppShell && webGameEntryAllowed) || window.location.hash === '#game' || window.location.pathname === '/wiki';
  const Screen = window.location.pathname === '/' && !gameRoute
    ? (uiTheme === 'premium' ? PremiumLandingScreen : Landing4Screen)
    : GameScreen;

  return <Screen />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<AppLoadingScreen />}><RootScreen /></Suspense>
    <AppUpdateBanner />
  </StrictMode>
);
