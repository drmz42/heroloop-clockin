// Mandatory update for the native Seeker app (android/seeker-app). The server publishes the newest
// signed APK at /download/<file> with /download/latest.json (ops/install-vps2-apk-download.sh).
// The app's user agent carries "HeroLoopApp/<versionName>" and, from versionCode 13,
// "HeroLoopAppCode/<versionCode>"; older APKs are compared by version name only.
import { useEffect, useState } from 'react';
import { isNativeApp } from '@/platform/platform';
import logo from '@/theme/premium/assets/logo-heroloop.webp';

type LatestApk = { fileName: string; versionName: string; versionCode: number };

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

// Founder 2026-10-06: an outdated app cannot be played; the gate covers every screen until
// the newer APK is installed.
export function AppUpdateGate() {
  const [latest, setLatest] = useState<LatestApk | null>(null);

  useEffect(() => {
    if (!isNativeApp) return;
    const controller = new AbortController();
    fetch('/download/latest.json', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const parsed = parseLatest(body);
        if (parsed && isOutdated(parsed)) setLatest(parsed);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!latest) return null;
  // Older APKs open staging2.heroloop.xyz; the public download link is always on heroloop.xyz.
  const host = window.location.hostname.endsWith('heroloop.xyz') ? 'heroloop.xyz' : window.location.host;
  const path = `/download/${latest.fileName}`;
  // The WebView cannot download files itself; an intent link hands the APK to the browser.
  const intentUrl = `intent://${host}${path}#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(`https://${host}${path}`)};end`;

  return (
    <div className="hl-app-update" role="alertdialog" aria-modal="true" aria-labelledby="hl-app-update-title">
      <div className="hl-app-update-card">
        <img src={logo} alt="HeroLoop" width={1100} height={367} />
        <h2 id="hl-app-update-title">Update required</h2>
        <p>Version {latest.versionName} is out. Install it to keep playing; your heroes and progress stay on your account.</p>
        <a className="hl-app-update-get" href={intentUrl}>Download update</a>
        <span className="hl-app-update-link">{host}{path}</span>
      </div>
    </div>
  );
}
