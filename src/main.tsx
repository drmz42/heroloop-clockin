import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const showLanding4 = window.location.pathname === '/' && window.location.hash !== '#game';
// eslint-disable-next-line react-refresh/only-export-components
const RootScreen = showLanding4
  ? lazy(() => import('../test/landing4/Landing4Screen.tsx'))
  : lazy(() => import('./App.tsx'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}><RootScreen /></Suspense>
  </StrictMode>
);
