// Platform layout switch for the Solana Mobile / Seeker Android version
// (docs/game/solana-mobile-hackathon.md). "android" is a phone-first layout:
// bottom tab bar, one main-screen section at a time, full-screen windows and
// Android Back closing them. It exists only in the staging2 build (and in a
// future build with VITE_PLATFORM=android); every other build is always "web",
// so staging.heroloop.xyz and Production are unchanged.
// staging2: add ?platform=android or ?platform=web to any URL (remembered per browser);
// without a choice, touch screens up to 900 px wide get the Android layout.
import { allowMobileWalletAdapter } from '@/game/solanaWalletRegistry';
import { registerInjectedPhantomFallback } from '@/game/phantomInjectedWallet';

export type Platform = 'android' | 'web';
export type MobileSection = 'battle' | 'quests' | 'bag';

const STORAGE_KEY = 'heroloop-platform';
const isPlatform = (value: unknown): value is Platform => value === 'android' || value === 'web';

export const androidLayoutAvailable = import.meta.env.MODE === 'staging2' || import.meta.env.VITE_PLATFORM === 'android';

// App shell: the page runs inside the Android APK (Trusted Web Activity opened with
// ?source=android) or as an installed standalone app. There is no landing page in the
// app: the player goes straight to wallet sign-in/registration and then the game.
// Chrome shares storage between the APK and the browser, so the flag is kept per tab
// (sessionStorage), not per browser.
function resolveAppShell(): boolean {
  if (!androidLayoutAvailable) return false;
  if (typeof navigator !== 'undefined' && /HeroLoopApp\//.test(navigator.userAgent)) return true;
  // On an Android phone (Chrome, the app or a wallet's in-app browser) the game always opens
  // like an app: hero screen with Play, then wallet sign-in. The marketing landing is for desktop.
  if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)) return true;
  try {
    if (new URLSearchParams(window.location.search).get('source') === 'android') {
      window.sessionStorage.setItem('heroloop-app-shell', '1');
      return true;
    }
    if (window.sessionStorage.getItem('heroloop-app-shell') === '1') return true;
  } catch {
    // Blocked storage: fall through to the display-mode check.
  }
  return window.matchMedia('(display-mode: standalone)').matches;
}

export const isAppShell = typeof window !== 'undefined' && resolveAppShell();

const isAndroidDevice = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
// The native HeroLoop Seeker app (android/seeker-app): a full-screen WebView whose user
// agent carries "HeroLoopApp". Wallets connect through Mobile Wallet Adapter with Android's
// own wallet chooser; there is no browser and no Phantom in-app browser path.
export const isNativeApp = typeof navigator !== 'undefined' && /HeroLoopApp\//.test(navigator.userAgent);

export function resolvePlatform(): Platform {
  if (!androidLayoutAvailable) return 'web';
  if (import.meta.env.VITE_PLATFORM === 'android' || isAppShell) return 'android';
  try {
    const requested = new URLSearchParams(window.location.search).get('platform');
    if (isPlatform(requested)) {
      window.localStorage.setItem(STORAGE_KEY, requested);
      return requested;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isPlatform(saved)) return saved;
  } catch {
    // Storage can be blocked; fall back to the screen check.
  }
  // Every Android phone (and the APK) gets the phone layout; emulators such as BlueStacks
  // report a mouse, so the pointer type is not used for Android devices.
  if (isAndroidDevice) return 'android';
  return window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches ? 'android' : 'web';
}


export const platform: Platform = typeof window === 'undefined' ? 'web' : resolvePlatform();
export const isAndroidLayout = platform === 'android';

// Seeker edition preview (docs/game/seeker-hero-removal-map.md): hides the display-only
// $HERO surfaces. A VITE_EDITION=seeker build always has it; staging2 can preview it with
// ?edition=seeker (remembered; ?edition=standard returns). Hiding is not a control: the
// Seeker backend must also refuse every $HERO action.
export type Edition = 'seeker' | 'standard';
const EDITION_KEY = 'heroloop-edition';

function resolveEdition(): Edition {
  if (import.meta.env.VITE_EDITION === 'seeker') return 'seeker';
  if (!androidLayoutAvailable) return 'standard';
  try {
    const requested = new URLSearchParams(window.location.search).get('edition');
    if (requested === 'seeker' || requested === 'standard') {
      window.localStorage.setItem(EDITION_KEY, requested);
      return requested;
    }
    return window.localStorage.getItem(EDITION_KEY) === 'seeker' ? 'seeker' : 'standard';
  } catch {
    return 'standard';
  }
}

export const edition: Edition = typeof window === 'undefined' ? 'standard' : resolveEdition();

export function applyPlatform() {
  if (androidLayoutAvailable) { registerMobileWalletAdapter(); registerInjectedPhantomFallback(); }
  document.documentElement.dataset.hlPlatform = platform;
  document.documentElement.dataset.hlEdition = edition;
  if (isAndroidLayout) {
    document.documentElement.dataset.hlSection = 'battle';
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = '/assets/manifest-android.webmanifest'; // Nginx serves only / and /assets/ as static files
    document.head.appendChild(manifest);
  }
}

// Mobile Wallet Adapter (https://docs.solanamobile.com/developers/mobile-wallet-adapter):
// on an Android browser or the TWA APK it registers a Wallet Standard wallet named
// "Mobile Wallet Adapter" that hands sign-in to the phone's wallet app (Seed Vault on
// Seeker, Phantom, Solflare…). Loaded lazily and only on Android, so no other build or
// device ships or runs it. Sign-in still goes through the same server SIWS challenge.
export const MOBILE_WALLET_ADAPTER_NAME = 'Mobile Wallet Adapter';

function registerMobileWalletAdapter() {
  if (!/Android/i.test(navigator.userAgent)) return;
  allowMobileWalletAdapter();
  void import('@solana-mobile/wallet-standard-mobile').then(({ registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler }) => {
    registerMwa({
      appIdentity: { name: 'HeroLoop', uri: window.location.origin, icon: 'assets/brand/app-icon-192.png' },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: ['solana:mainnet'],
      chainSelector: createDefaultChainSelector(),
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    });
  }).catch(() => {
    // Without the adapter the landing page keeps its "no wallet detected" state.
  });
}

export function setMobileSection(section: MobileSection) {
  document.documentElement.dataset.hlSection = section;
}

// Fallback when no wallet app answers through Mobile Wallet Adapter: open this page in
// Phantom's own in-app browser, where Phantom injects itself and the usual sign-in works.
// https://docs.phantom.com/phantom-deeplinks/other-methods/browse
// Not offered inside a wallet's own browser (Phantom already injected itself there).
export const canOpenInPhantom = isAndroidDevice && !isNativeApp
  && typeof window !== 'undefined' && !(window as unknown as { phantom?: unknown }).phantom;

export function phantomBrowseUrl(): string {
  const target = new URL(window.location.href);
  // Keep ?source=android so Phantom's browser also opens straight into sign-in, not the landing.
  target.searchParams.set('source', 'android');
  target.hash = 'game';
  return `https://phantom.app/ul/browse/${encodeURIComponent(target.toString())}?ref=${encodeURIComponent(window.location.origin)}`;
}
