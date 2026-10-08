import { useEffect, useRef } from 'react';
import { isAndroidLayout } from './platform';

type Entry = { pushed: boolean; ignoreNextPop: boolean; close: { current: () => void } };

// Open windows in opening order. Android Back (history.back) closes only the newest one, so a
// Wallet opened over Quests closes alone (Founder 2026-10-08: Quests, Bag, Boost Max, Wallet and
// Commander did not react to Back).
const stack: Entry[] = [];
let ignoredPops = 0;
let listening = false;

function onPop() {
  if (ignoredPops > 0) { ignoredPops -= 1; return; }
  while (stack.length > 0) {
    const top = stack.pop()!;
    // openWiki (App.tsx) may hand an entry's history slot to /wiki by clearing `pushed`.
    if (!top.pushed) continue;
    top.pushed = false;
    top.close.current();
    return;
  }
}

/** One Back entry for an open Android window or sheet (Mine, PvP, Quests, Bag, Boost Max, Wallet, Commander). */
export function useAndroidOverlayHistory(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  const history = useRef<Entry>({ pushed: false, ignoreNextPop: false, close });

  useEffect(() => {
    if (!isAndroidLayout || listening) return;
    listening = true;
    window.addEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!isAndroidLayout) return;
    const entry = history.current;
    if (open && !entry.pushed) {
      window.history.pushState({ heroloopOverlay: true }, '');
      entry.pushed = true;
      stack.push(entry);
    } else if (!open) {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (entry.pushed) {
        entry.pushed = false;
        ignoredPops += 1;
        window.history.back();
      }
    }
  }, [open]);

  useEffect(() => () => {
    const entry = history.current;
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (entry.pushed && isAndroidLayout) {
      entry.pushed = false;
      ignoredPops += 1;
      window.history.back();
    }
  }, []);

  return history;
}
