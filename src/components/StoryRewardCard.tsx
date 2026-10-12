import { useEffect, useState } from 'react';
import { bagItemCount, type GameApi } from '@/game/useGame';
import { inventoryCapacity } from '@/game/state';
import { versionedAsset } from '@/game/assetVersion';
import { currentTutorialObjective } from '@/game/tutorialProgress';
import { storyHoldsTutorialBundle } from '@/game/storyBox';
import { playSfx } from '@/audio/gameAudio';
import '@/theme/story/story-reward.css';

// Story rewards (Founder 2026-10-12): while the story runs, each finished Tutorial step pops up as a
// story reward with its picture and a Claim button. The claim is the ordinary server-owned Tutorial
// Quest claim; the card only presents it. Tutorial Chests open the same way, through the server.

type Art = 'chests' | 'scrolls' | 'key';

// Seeker tutorial rewards (Founder 2026-10-12): one bundle after the story's second death; every
// other step pays nothing and advances on its own, without a card.
const REWARDS: Record<string, { art: Art; amount: string; line: string }> = {
  'defeat-10-enemies': { art: 'chests', amount: '20 Tutorial Chests · 2 Summon Scrolls · 1 Boss Key', line: 'Old steel from the crypt, a call for allies, and the key to the Broken Gate.' },
};

function RewardArt({ art }: { art: Art }) {
  const src = { chests: '/assets/ui/chest-ceremony-v1.webp', scrolls: '/assets/ui/summon-scroll-v1.webp', key: '/assets/ui/boss-key-v2.webp' }[art];
  return <img className={`sr-art is-${art}`} src={versionedAsset(src)} alt="" draggable={false} />;
}

export function StoryRewardCard({ game }: { game: GameApi }) {
  const { state } = game;
  const objective = currentTutorialObjective(state);
  const held = storyHoldsTutorialBundle(state);
  const reward = objective?.ready && !held ? REWARDS[objective.id] : undefined;
  const chests = state.tutorial.chestBalance;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState<string | null>(null);
  const key = reward ? `claim:${objective?.id}` : chests > 0 ? `chests:${chests >= 10 ? 10 : 1}` : null;
  useEffect(() => { setError(''); }, [key]);
  // A finished step with no reward is claimed silently so the story moves on.
  const silentStep = objective?.ready && !REWARDS[objective.id] ? objective.id : null;
  useEffect(() => {
    if (!silentStep || busy) return;
    setBusy(true);
    // A refused claim (e.g. the server has not counted the progress yet) retries after a pause, not in a loop.
    void game.claimTutorialQuest(silentStep).then((failure) => { if (failure) window.setTimeout(() => setBusy(false), 5000); else setBusy(false); }, () => window.setTimeout(() => setBusy(false), 5000));
    // busy is a dependency: the next silent step must start once the previous claim settles.
  }, [silentStep, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!key || hidden === key || game.chestOpening || game.chestOpenResult || state.bossBattleActive) return null;

  const claim = async () => {
    if (!objective) return;
    setBusy(true); setError('');
    try {
      const failure = await game.claimTutorialQuest(objective.id);
      if (failure) setError('Could not claim the reward. Please try again.');
      else {
        playSfx('claim');
        // Seeker mails quest rewards; the story bundle is taken from the Mail at once so the chests are ready.
        await game.claimMail(null);
      }
    } finally { setBusy(false); }
  };
  const open = (count: 1 | 10) => {
    if (inventoryCapacity(state) - bagItemCount(state) < count) { setError('Your bag is full. Make room first.'); return; }
    playSfx('chestBurst');
    void game.openTutorialChests(count);
  };

  return (
    <div className="story-reward" role="dialog" aria-label="Story reward">
      <div className="story-reward-card">
        <small className="sb-kicker">{reward ? 'Story reward' : 'Tutorial Chests'}</small>
        <div className="sr-stage"><RewardArt art={reward ? reward.art : 'chests'} /></div>
        <h2>{reward ? reward.amount : `${chests} chest${chests === 1 ? '' : 's'} to open`}</h2>
        <p>{reward ? reward.line : 'Open them and equip what you find on your hero.'}</p>
        {error && <p role="alert" className="sr-error">{error}</p>}
        {reward
          ? <button type="button" className="game-control game-primary sb-cta" disabled={busy} onClick={claim}>{busy ? 'Claiming…' : 'Claim'}</button>
          : <button type="button" className="game-control game-primary sb-cta" onClick={() => open(chests >= 10 ? 10 : 1)}>{chests >= 10 ? 'Open 10' : 'Open'}</button>}
        <button type="button" className="sr-later" onClick={() => setHidden(key)}>Later</button>
      </div>
    </div>
  );
}
