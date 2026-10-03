// Store notice marker (Android tab bar, Founder 2026-10-03): a red mark on Store announces a pack
// sale or another Store event until the player opens the Store. To announce one, set STORE_NOTICE_ID
// to a new unique id (e.g. 'pack-sale-2026-10') and deploy; null shows nothing. `?storeNotice=preview`
// shows the mark for design review without recording it as seen.
export const STORE_NOTICE_ID: string | null = null;

const SEEN_KEY = 'heroloop-store-notice-seen';

function previewRequested() {
  try { return new URLSearchParams(window.location.search).get('storeNotice') === 'preview'; } catch { return false; }
}

export function storeNoticeUnseen(): boolean {
  if (previewRequested()) return true;
  if (!STORE_NOTICE_ID) return false;
  try { return window.localStorage.getItem(SEEN_KEY) !== STORE_NOTICE_ID; } catch { return true; }
}

export function markStoreNoticeSeen() {
  if (!STORE_NOTICE_ID || previewRequested()) return;
  try { window.localStorage.setItem(SEEN_KEY, STORE_NOTICE_ID); } catch { /* storage blocked: the mark stays until reload */ }
}
