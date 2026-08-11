import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// eslint-disable-next-line react-refresh/only-export-components
const Landing4Screen = lazy(() => import('../test/landing4/Landing4Screen.tsx'));
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

  const gameRoute = window.location.hash === '#game' || window.location.pathname === '/wiki';
  const Screen = window.location.pathname === '/' && !gameRoute
    ? Landing4Screen
    : GameScreen;

  return <Screen />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}><RootScreen /></Suspense>
  </StrictMode>
);
