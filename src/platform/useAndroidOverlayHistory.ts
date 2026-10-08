import { useEffect, useRef } from 'react';
import { isAndroidLayout } from './platform';

/** One Back entry for the active Android window or sheet, including Mine and PvP. */
export function useAndroidOverlayHistory(open: boolean, onClose: () => void) {
  const history = useRef({ pushed: false, ignoreNextPop: false });
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!isAndroidLayout) return;
    const entry = history.current;
    if (open && !entry.pushed) {
      window.history.pushState({ heroloopOverlay: true }, '');
      entry.pushed = true;
    } else if (!open && entry.pushed) {
      entry.pushed = false;
      entry.ignoreNextPop = true;
      window.history.back();
    }
  }, [open]);

  useEffect(() => {
    if (!isAndroidLayout) return;
    const entry = history.current;
    const onPop = () => {
      if (entry.ignoreNextPop) { entry.ignoreNextPop = false; return; }
      if (!entry.pushed) return;
      entry.pushed = false;
      close.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return history;
}
