import { useEffect, useRef, useState } from 'react';
import { playSfx, vibrate } from '@/audio/gameAudio';

// Boss entrance for Dungeon bosses and Boss Key fights: letterbox, red pulse, title card, drum hits
// and a vibration on phones. It plays once per encounter; the shared phase adds a shorter sting.
export function BossIntro({ encounterKey, bossName, phase, motion }: {
  encounterKey: string | null; bossName: string; phase: 'retinue' | 'shared' | null; motion: boolean;
}) {
  const seen = useRef<string | null>(null);
  const seenPhase = useRef<string | null>(null);
  const [show, setShow] = useState<{ key: string; title: string; name: string } | null>(null);
  const hideTimer = useRef(0);
  const present = (key: string, title: string, name: string, ms: number) => {
    setShow({ key, title, name });
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShow(null), ms);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (!encounterKey || seen.current === encounterKey) return;
    seen.current = encounterKey;
    seenPhase.current = `${encounterKey}:${phase ?? ''}`;
    playSfx('bossIntro');
    vibrate([90, 70, 90, 140, 260]);
    if (motion) present(encounterKey, 'BOSS BATTLE', bossName, 2600);
  }, [encounterKey, bossName, phase, motion]);

  useEffect(() => {
    if (!encounterKey || phase !== 'shared') return;
    const key = `${encounterKey}:shared`;
    if (seenPhase.current === key) return;
    seenPhase.current = key;
    playSfx('bossPhase');
    vibrate([60, 50, 180]);
    if (motion) present(key, 'THE BOSS DESCENDS', bossName, 2000);
  }, [encounterKey, phase, bossName, motion]);

  if (!show) return null;
  return (
    <div key={show.key} className="hl-boss-intro" role="status" aria-live="polite">
      <i className="hl-boss-bar is-top" aria-hidden="true" />
      <i className="hl-boss-bar is-bottom" aria-hidden="true" />
      <i className="hl-boss-vignette" aria-hidden="true" />
      <div className="hl-boss-card">
        <span className="hl-boss-kicker">{show.title}</span>
        <strong className="hl-boss-name">{show.name}</strong>
        <i className="hl-boss-rule" aria-hidden="true" />
      </div>
    </div>
  );
}
