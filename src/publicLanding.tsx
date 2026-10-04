// Production marketing entry: no game, account, wallet or API initialization.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import PremiumLandingView from './theme/premium/PremiumLandingView';

// Founder 2026-10-04: Play is disabled on the public website and leads nowhere, so no test
// host name ships in this bundle. To restore, give play() a destination again.
function play() { /* disabled */ }
document.documentElement.dataset.hlTheme = 'premium';
createRoot(document.getElementById('root')!).render(<StrictMode><PremiumLandingView onPlay={play} /></StrictMode>);
