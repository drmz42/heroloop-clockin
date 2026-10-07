// Mandatory update for the native Seeker app (android/seeker-app). The server publishes the newest
// signed APK at /download/<file> with /download/latest.json (ops/install-vps2-apk-download.sh).
// The app's user agent carries "HeroLoopApp/<versionName>" and, from versionCode 13,
// "HeroLoopAppCode/<versionCode>"; older APKs are compared by version name only.
import { useEffect, useState } from 'react';
import { isNativeApp } from '@/platform/platform';
import { Download, ShieldCheck } from 'lucide-react';
import heroHost from '@/theme/premium/assets/hero-host.webp';
import logo from '@/theme/premium/assets/logo-heroloop.webp';
import '@/theme/premium/premium-onboarding.css';

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
  // Before build 15, APK links on GAME_HOST stay in a WebView without download support.
  // www is outside every released GAME_HOST and redirects to the same public HTTPS file.
  const installedCode = Number(/HeroLoopAppCode\/(\d+)/.exec(navigator.userAgent)?.[1]);
  const publicHost = installedCode >= 15 ? 'heroloop.xyz' : 'www.heroloop.xyz';
  const host = window.location.hostname.endsWith('heroloop.xyz') ? publicHost : window.location.host;
  const path = `/download/${latest.fileName}`;
  // The Android shell opens this direct HTTPS link in an external browser.
  const downloadUrl = `https://${host}${path}`;

  const installed = /HeroLoopApp\/(\S+)/.exec(navigator.userAgent)?.[1];

  // Same forged window, stone panel, crest and crimson seal as wallet sign-in (premium-onboarding.css).
  return (
    <div className="hl-app-update onb-overlay" role="alertdialog" aria-modal="true" aria-labelledby="hl-app-update-title">
      <div className="hl-app-update-art" style={{ backgroundImage: `url(${heroHost})` }} aria-hidden="true" />
      <div className="hl-app-update-shade" aria-hidden="true" />
      <div className="hl-app-update-inner">
        <img className="hl-app-update-logo" src={logo} alt="HeroLoop" width={1100} height={367} />
        <div className="onb-card hl-app-update-card">
          <div className="onb-head"><p className="onb-kicker">New version</p></div>
          <div className="onb-crest" aria-hidden="true">
            <img src="/assets/brand/heroloop-emblem.png" alt="" width={160} height={160} draggable={false} />
            <Download size={18} className="onb-crest-icon" />
          </div>
          <h2 id="hl-app-update-title" className="onb-title">UPDATE REQUIRED</h2>
          <p className="onb-copy">A new version of HeroLoop is ready. Install it to continue your adventure.</p>
          <p className="hl-app-update-versions">
            {installed && <><span>{installed}</span><b aria-hidden="true">→</b></>}
            <strong>{latest.versionName}</strong>
          </p>
          <a className="onb-cta onb-cta-primary" href={downloadUrl}><Download size={18} aria-hidden="true" />Download update</a>
          <div className="onb-note onb-note-safe">
            <ShieldCheck size={18} aria-hidden="true" />
            <span>Your heroes, items and progress are saved on your account and stay after the update.</span>
          </div>
          <p className="hl-app-update-link">{host}{path}</p>
        </div>
      </div>
    </div>
  );
}
