import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

// Android layout only (styled in android.css): a plain notice while the phone has no
// connection. Progress is server-owned, so nothing is lost; the game resumes by itself.
export function OfflineBar() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  if (!offline) return null;
  return <div className="hl-offline-bar" role="status"><WifiOff size={14} aria-hidden="true" /> No connection · progress is safe, the game resumes when you are back online</div>;
}
