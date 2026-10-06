// Update notice for the native Seeker app (android/seeker-app). The server publishes the newest
// signed APK at /download/<file> with /download/latest.json (ops/install-vps2-apk-download.sh).
// The app's user agent carries "HeroLoopApp/<versionName>" and, from versionCode 13,
// "HeroLoopAppCode/<versionCode>"; older APKs are compared by version name only.
import { useEffect, useState } from 'react';
import { isNativeApp } from '@/platform/platform';

type LatestApk = { fileName: string; versionName: string; versionCode: number };

const DISMISS_KEY = 'heroloop-app-update-dismissed';
const FILE_NAME = /^heroloop-seeker-[0-9A-Za-z.+-]{1,40}-[0-9]{1,9}\.apk$/;

function parseLatest(value: unknown): LatestApk | null {
  if (!value || typeof value !== 'object') return null;
  const { fileName, versionName, versionCode } = value as Record<string, unknown>;
  if (typeof fileName !== 'string' || !FILE_NAME.test(fileName)) return null;
  if (typeof versionName !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(versionName)) return null;
  if (typeof versionCode !== 'number' || !Number.isInteger(versionCode) || versionCode < 1) return null;
  return { fileName, versionName, versionCode };
}

function isOutdated(latest: LatestApk): boolean {
  const agent = navigator.userAgent;
  const name = /HeroLoopApp\/(\S+)/.exec(agent)?.[1];
  const code = Number(/HeroLoopAppCode\/(\d+)/.exec(agent)?.[1]);
  if (Number.isInteger(code) && code > 0) return code < latest.versionCode;
  return Boolean(name) && name !== latest.versionName;
}

export function AppUpdateBanner() {
  const [latest, setLatest] = useState<LatestApk | null>(null);

  useEffect(() => {
    if (!isNativeApp) return;
    const controller = new AbortController();
    fetch('/download/latest.json', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const parsed = parseLatest(body);
        if (!parsed || !isOutdated(parsed)) return;
        try {
          if (window.sessionStorage.getItem(DISMISS_KEY) === String(parsed.versionCode)) return;
        } catch {
          // Blocked storage: show the notice.
        }
        setLatest(parsed);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!latest) return null;
  const host = window.location.host;
  const path = `/download/${latest.fileName}`;
  // The WebView cannot download files itself; an intent link hands the APK to the browser.
  const intentUrl = `intent://${host}${path}#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(`https://${host}${path}`)};end`;
  const dismiss = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, String(latest.versionCode));
    } catch {
      // Blocked storage: hide for this page only.
    }
    setLatest(null);
  };

  return (
    <div className="hl-app-update" role="status">
      <p>
        <strong>Update available: {latest.versionName}</strong>
        <span>{host}{path}</span>
      </p>
      <a className="hl-app-update-get" href={intentUrl}>Download</a>
      <button type="button" className="hl-app-update-close" onClick={dismiss} aria-label="Dismiss update notice">×</button>
    </div>
  );
}
