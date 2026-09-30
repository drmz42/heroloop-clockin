// Platform layout switch for the Solana Mobile / Seeker Android version
// (docs/game/solana-mobile-hackathon.md). "android" is a phone-first layout:
// bottom tab bar, one main-screen section at a time, full-screen windows and
// Android Back closing them. It exists only in the staging2 build (and in a
// future build with VITE_PLATFORM=android); every other build is always "web",
// so staging.heroloop.xyz and Production are unchanged.
// staging2: add ?platform=android or ?platform=web to any URL (remembered per browser);
// without a choice, touch screens up to 900 px wide get the Android layout.
export type Platform = 'android' | 'web';
export type MobileSection = 'battle' | 'quests' | 'bag';

const STORAGE_KEY = 'heroloop-platform';
const isPlatform = (value: unknown): value is Platform => value === 'android' || value === 'web';

export const androidLayoutAvailable = import.meta.env.MODE === 'staging2' || import.meta.env.VITE_PLATFORM === 'android';

export function resolvePlatform(): Platform {
  if (!androidLayoutAvailable) return 'web';
  if (import.meta.env.VITE_PLATFORM === 'android') return 'android';
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
  return window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches ? 'android' : 'web';
}

export const platform: Platform = typeof window === 'undefined' ? 'web' : resolvePlatform();
export const isAndroidLayout = platform === 'android';

export function applyPlatform() {
  document.documentElement.dataset.hlPlatform = platform;
  if (isAndroidLayout) document.documentElement.dataset.hlSection = 'battle';
}

export function setMobileSection(section: MobileSection) {
  document.documentElement.dataset.hlSection = section;
}
