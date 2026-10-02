// Production marketing entry: no game, account, wallet or API initialization.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import PremiumLandingView from './theme/premium/PremiumLandingView';

const playUrl = 'https://staging2.heroloop.xyz/#game';
function play() { window.location.assign(playUrl); }
document.documentElement.dataset.hlTheme = 'premium';
// Old bookmarks must enter the test game rather than initialize a Production game.
if (window.location.hash === '#game') window.location.replace(playUrl);
else createRoot(document.getElementById('root')!).render(<StrictMode><PremiumLandingView onPlay={play} /></StrictMode>);
