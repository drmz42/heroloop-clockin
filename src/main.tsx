import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// eslint-disable-next-line react-refresh/only-export-components
const RootScreen = window.location.pathname === '/landing4'
  ? lazy(() => import('../test/landing4/Landing4Screen.tsx'))
  : lazy(() => import('./App.tsx'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}><RootScreen /></Suspense>
  </StrictMode>
);
