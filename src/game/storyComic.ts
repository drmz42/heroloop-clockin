import type { SfxName } from '@/audio/gameAudio';

// Seeker story comic script (Founder 2026-10-12, option B): every beat is one full-screen painted
// frame (`art`, generated per scene) brought to life in code by camera moves, impacts and ambient
// effects. A page with rows 'full' fills the screen; other pages stay CSS grids of inked panels, and a
// panel may still compose story layers (`bg` + `figs`). Figure x is the centre in % of panel width, y the bottom offset and h the
// height in % of panel height. Presentation only: no save, no reward.

export interface ComicFigure { src: string; x: number; y?: number; h: number; flip?: boolean; z?: number; dim?: boolean; anim?: 'lunge' | 'recoil' | 'rise' | 'sway' | 'fall' | 'breathe' | 'pull' }
export interface ComicBubble { text: string; who?: string; x: number; y: number; kind?: 'speech' | 'shout' | 'thought' | 'whisper'; tail?: 'down-left' | 'down-right' | 'up-left' | 'up-right' | 'none' }
export type ComicFx = 'shake' | 'flash' | 'dust' | 'glow' | 'gate-close' | 'blackout' | 'desaturate' | 'embers' | 'mist' | 'flicker' | 'debris' | 'breath';
export interface ComicPanel {
  area: string;
  hold: number;
  /** One painted illustration filling the panel. */
  art?: string;
  artPos?: string;
  bg?: string;
  bgPos?: string;
  cam?: 'push' | 'pull' | 'pan-left' | 'pan-right' | 'rise' | 'still' | 'whip' | 'drift';
  tone?: 'night' | 'ember' | 'violet' | 'bone' | 'black' | 'clear';
  figs?: ComicFigure[];
  caption?: { text: string; at?: 'top' | 'bottom' };
  bubbles?: ComicBubble[];
  sfx?: { text: string; x: number; y: number; rot?: number; size?: number };
  fx?: ComicFx[];
  word?: string;
  /** Where the glow mark appears, in % of the panel; flat = lying on the floor. */
  glow?: { x: number; y: number; size: number; flat?: boolean; dim?: boolean };
  sound?: [SfxName, number][];
  /** Recorded voice line (currently unused: the story is text only, Founder 2026-10-12). */
  voice?: [VoiceLine, number];
}
export interface ComicPage { areas: string; rows: string; cols?: string; panels: ComicPanel[] }

// Story voice lines, rendered offline (Piper TTS) into /assets/story/voice/<id>.mp3.
export type VoiceLine = 'n-broken-gate' | 'n-gate-closed' | 'n-fought-on' | 'n-nothing' | 'n-road' | 'n-waiting' | 'n-together'
  | 'n-elyra' | 'n-cloak' | 'h-garrick' | 'h-died' | 'h-move' | 'h-again' | 'h-not-alone' | 'g-forgive' | 'm-came-back' | 'm-silence';
export const voiceSrc = (line: VoiceLine) => `/assets/story/voice/${line}.mp3`;

const story = (name: string) => `/assets/story/${name}.webp`;
const frame = (name: string) => `/assets/story/comic/${name}.webp`;
const ROAD = story('grave-road');
/** Title card art (also used by StoryBox). */
export const STORY_TITLE_ART = frame('opening-trio');

/** One full-screen painted beat. */
function full(panel: Omit<ComicPanel, 'area'>): ComicPage {
  return { areas: '"a"', rows: 'full', cols: '1fr', panels: [{ area: 'a', tone: 'clear', ...panel }] };
}

// ── Scene 1: betrayal, first death, first awakening ────────────────────────
// The painted frames show the warrior protagonist (warrior-only story, Founder 2026-10-12).

export function introPages(): ComicPage[] {
  return [
    // The fight: hard, and Garrick's promise.
    full({ hold: 4400, art: frame('approach'), cam: 'drift', fx: ['mist', 'embers'], caption: { text: 'The Broken Gate. Three of us came to end Morvane.' }, sound: [['wind', 0]] }),
    full({ hold: 4200, art: frame('opening-trio'), cam: 'push', fx: ['embers', 'flicker', 'breath'], caption: { text: 'Every company before us had died here.' }, sound: [['bossIntro', 0], ['roar', 900]] }),
    full({
      hold: 3800, art: frame('fight-block'), cam: 'whip', fx: ['shake', 'flash', 'debris', 'embers'], sfx: { text: 'KLANG!', x: 52, y: 20, rot: 8, size: 56 },
      bubbles: [{ who: 'Garrick', text: 'Hold the line!', x: 6, y: 58, tail: 'up-right', kind: 'shout' }], sound: [['crit', 300], ['hit', 500]],
    }),
    full({
      hold: 4400, art: frame('fight-bind'), cam: 'drift', fx: ['flicker', 'embers'], caption: { text: 'Elyra pinned his arm. I went for the strike.', at: 'bottom' },
      bubbles: [{ who: 'Garrick', text: 'Go! I’ve got your back!', x: 34, y: 10, tail: 'down-left', kind: 'shout' }], sound: [['summon', 200], ['whoosh', 2000]],
    }),
    full({
      hold: 4000, art: frame('fight-cut'), cam: 'whip', fx: ['shake', 'flash', 'embers'], sfx: { text: 'SHHK!', x: 8, y: 24, rot: -8, size: 54 },
      caption: { text: 'The wound closed before my eyes.', at: 'bottom' }, sound: [['crit', 200], ['roar', 1400]],
    }),
    full({ hold: 4400, art: frame('spent'), cam: 'push', fx: ['mist', 'breath', 'embers'], caption: { text: 'Elyra’s power ran dry. Garrick’s shield split. He kept coming.' }, sound: [['heartbeat', 300]] }),
    full({
      hold: 3600, art: frame('claw-slam'), cam: 'whip', fx: ['shake', 'flash', 'dust', 'debris', 'embers'], sfx: { text: 'KRA-KOOM!', x: 6, y: 18, rot: -10, size: 58 },
      sound: [['roar', 0], ['crit', 450], ['bossPhase', 700]],
    }),
    // The betrayal: he could reach me, he chose the gate, and he closed it himself.
    full({
      hold: 4000, art: frame('hero-calls'), cam: 'push', fx: ['breath', 'embers'],
      bubbles: [{ text: 'Garrick! Your back — I need it now!', x: 8, y: 52, tail: 'down-left', kind: 'shout' }], sound: [['heartbeat', 200]],
    }),
    full({ hold: 4400, art: frame('garrick-choice'), artPos: '92% center', cam: 'push', fx: ['flicker', 'breath'], caption: { text: 'He could have reached me. He looked at the gate instead.' } }),
    full({
      hold: 4400, art: frame('garrick-turns'), cam: 'push', fx: ['flicker'],
      bubbles: [{ who: 'Garrick', text: 'Forgive me, old friend.', x: 30, y: 12, tail: 'down-left' }], sound: [['heartbeat', 200]],
    }),
    full({ hold: 4000, art: frame('forgive'), cam: 'push', fx: ['embers', 'flicker'], caption: { text: 'He turned his back and dragged Elyra away.' } }),
    full({
      hold: 3800, art: frame('elyra-no'), cam: 'pull', fx: ['flicker', 'embers'],
      bubbles: [{ who: 'Elyra', text: 'No! He’s still alive!', x: 40, y: 12, tail: 'down-left', kind: 'shout' }],
    }),
    full({ hold: 4400, art: frame('garrick-lever'), cam: 'push', fx: ['flicker', 'dust'], caption: { text: 'He looked me in the eye. Then he let the gate fall.' }, sound: [['whoosh', 1400]] }),
    full({
      hold: 3800, art: frame('gate-closes'), cam: 'pull', fx: ['shake', 'dust', 'flicker'], sfx: { text: 'CLANG!', x: 54, y: 30, rot: 8, size: 60 },
      caption: { text: 'Locked in. With him.' }, sound: [['gateSlam', 600]],
    }),
    // The first death.
    full({ hold: 3800, art: frame('rise-alone'), cam: 'rise', fx: ['mist', 'embers', 'breath'], caption: { text: 'Alone, I fought on.' }, sound: [['heartbeat', 0], ['roar', 2200]] }),
    full({
      hold: 3400, art: frame('last-stand'), cam: 'whip', fx: ['shake', 'flash', 'dust', 'debris', 'embers'], sfx: { text: 'THOOM!', x: 8, y: 42, rot: -6, size: 70 },
      sound: [['whoosh', 0], ['roar', 500], ['crit', 900]],
    }),
    full({
      hold: 3400, art: frame('sword-breaks'), cam: 'whip', fx: ['shake', 'flash', 'debris'], sfx: { text: 'KRANG!', x: 52, y: 14, rot: 8, size: 58 },
      caption: { text: 'My blade broke on his claw.', at: 'bottom' }, sound: [['crit', 200]],
    }),
    full({ hold: 3600, art: frame('pinned'), cam: 'push', fx: ['breath', 'embers'], sound: [['heartbeat', 0], ['roar', 1600]] }),
    full({ hold: 3400, art: frame('death-pov'), cam: 'push', fx: ['shake', 'breath'], caption: { text: 'The last thing I saw was his claw.', at: 'bottom' }, sound: [['crit', 900], ['death', 1300]] }),
    full({ hold: 2800, tone: 'black', cam: 'still', fx: ['blackout'], caption: { text: 'And then — nothing.', at: 'bottom' } }),
    full({
      // The Hollow One is already there in the dark: a small silhouette, no spotlight.
      hold: 4600, art: frame('hollow-watch'), artPos: '15% center', cam: 'push', fx: ['mist'], sfx: { text: 'tok… tok… tok…', x: 30, y: 20, rot: 0, size: 20 },
      sound: [['wind', 0], ['knock', 900], ['knock', 1550], ['knock', 2200]],
    }),
    full({ hold: 4400, art: frame('mark-awakens'), cam: 'push', fx: ['mist', 'breath'], sound: [['summon', 600]] }),
    // The return: why he lives, and why he walks into the crypt fight.
    full({ hold: 4400, art: frame('altar-glow'), cam: 'push', fx: ['mist', 'flicker'], caption: { text: 'Ashen Crypt.' }, sound: [['levelUp', 600]] }),
    full({
      hold: 3600, art: frame('eyes-open'), cam: 'whip', fx: ['flash'], sound: [['heartbeat', 0]],
      bubbles: [{ text: 'I died. I know I did.', x: 8, y: 14, tail: 'down-right', kind: 'thought' }],
    }),
    full({
      hold: 4000, art: frame('altar-wake'), cam: 'push', fx: ['mist', 'flicker', 'breath'],
      bubbles: [{ text: 'How am I still alive?', x: 40, y: 44, tail: 'down-left', kind: 'thought' }], sound: [['wind', 0]],
    }),
    full({
      hold: 4200, art: frame('healed-wound'), cam: 'push', fx: ['flicker'],
      bubbles: [{ text: 'The wound is gone. Only this mark.', x: 8, y: 12, tail: 'down-right', kind: 'thought' }],
    }),
    full({ hold: 4000, art: frame('sword-found'), cam: 'drift', fx: ['mist', 'flicker'], caption: { text: 'My sword was gone. The dead had one to spare.' } }),
    full({
      hold: 3600, art: frame('crypt-exit'), cam: 'push', fx: ['mist', 'flicker'],
      bubbles: [{ text: 'No answers. Move.', x: 8, y: 16, tail: 'down-right', kind: 'thought' }],
    }),
    full({ hold: 3800, art: frame('skeletons-rise'), cam: 'pull', fx: ['shake', 'mist', 'flicker'], caption: { text: 'The crypt was not empty.' }, sound: [['knock', 300], ['knock', 700], ['roar', 1400]] }),
  ];
}

// ── Scene 2: armed again, the road back to the gate ────────────────────────

export function gatePages(): ComicPage[] {
  return [full({
    hold: 4400, art: ROAD, cam: 'pan-left', fx: ['mist'],
    caption: { text: 'Armed again, I took the grave road back to the gate.' },
    sound: [['wind', 0], ['bossIntro', 3400]],
  })];
}

// ── Scene 3: Morvane was waiting; the second awakening ─────────────────────

export function fallenPages(): ComicPage[] {
  return [
    full({
      hold: 4600, art: frame('came-back'), cam: 'push', fx: ['embers', 'flicker', 'breath'],
      caption: { text: 'He was waiting for me.', at: 'bottom' },
      bubbles: [{ who: 'Morvane', text: 'You came back.', x: 46, y: 10, tail: 'down-left', kind: 'whisper' }],
      sound: [['roar', 200], ['heartbeat', 3000]],
    }),
    // The second death, shown as clearly as the first, so the return to the altar follows.
    full({ hold: 3400, art: frame('pinned'), cam: 'push', fx: ['breath', 'embers'], caption: { text: 'Not strong enough. Not yet.', at: 'bottom' }, sound: [['heartbeat', 0], ['roar', 1400]] }),
    full({ hold: 3200, art: frame('death-pov'), cam: 'push', fx: ['shake', 'breath'], caption: { text: 'The claw again.', at: 'bottom' }, sound: [['crit', 800], ['death', 1200]] }),
    full({ hold: 2600, tone: 'black', cam: 'still', fx: ['blackout'], caption: { text: 'Darkness. Again.', at: 'bottom' } }),
    full({ hold: 3800, art: frame('mark-awakens'), cam: 'push', fx: ['mist', 'breath'], sound: [['summon', 600]] }),
    full({
      hold: 3800, art: frame('altar-wake'), cam: 'push', fx: ['mist', 'flicker'],
      caption: { text: 'The altar. Again.' }, bubbles: [{ text: 'Again.', x: 44, y: 44, tail: 'down-left', kind: 'thought' }],
      sound: [['wind', 0], ['heartbeat', 200], ['levelUp', 900]],
    }),
    full({
      hold: 4600, art: frame('rise-again'), cam: 'rise', fx: ['mist', 'flicker', 'embers'],
      bubbles: [{ text: 'Alone I can’t win. Then I won’t be alone.', x: 6, y: 10, tail: 'down-right', kind: 'thought' }],
    }),
  ];
}

// ── Scene 4: the real victory and Elyra's trace ────────────────────────────

export function victoryPages(): ComicPage[] {
  return [
    full({
      hold: 5000, art: frame('morvane-kneels'), cam: 'whip', fx: ['shake', 'flash', 'dust', 'debris', 'embers'],
      sfx: { text: 'KRRAK!', x: 6, y: 18, rot: -8, size: 62 },
      bubbles: [{ who: 'Morvane', text: 'At last… silence…', x: 46, y: 10, tail: 'down-left', kind: 'whisper' }],
      sound: [['crit', 0], ['roar', 300]],
    }),
    full({
      hold: 4400, art: frame('trio-victory'), cam: 'pull', fx: ['embers', 'flicker'],
      caption: { text: 'Where I fell alone, we stand together.', at: 'bottom' }, sound: [['victory', 300]],
    }),
    full({
      hold: 5000, art: frame('elyra-cloak'), cam: 'push', fx: ['mist', 'flicker'],
      caption: { text: 'Caught on the inside of the gate: a scrap of Elyra’s cloak.' }, sound: [['summon', 200]],
    }),
    full({ hold: 3800, tone: 'black', cam: 'still', word: 'Blackthorn', caption: { text: 'She came back here. After I died.', at: 'bottom' } }),
  ];
}
