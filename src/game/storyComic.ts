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
  sound?: [SfxName, number][];
  /** Recorded voice line (file id under /assets/story/voice) and its delay in ms. */
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
    full({
      hold: 4800, art: frame('opening-trio'), cam: 'drift', fx: ['embers', 'flicker', 'breath'], voice: ['n-broken-gate', 700],
      caption: { text: 'The Broken Gate. Three of us came to end Morvane.' }, sound: [['bossIntro', 0]],
    }),
    full({
      hold: 3600, art: frame('claw-slam'), cam: 'whip', fx: ['shake', 'flash', 'dust', 'debris', 'embers'],
      sfx: { text: 'KRA-KOOM!', x: 6, y: 18, rot: -10, size: 58 },
      bubbles: [{ text: 'Garrick…!', x: 52, y: 62, tail: 'down-left', kind: 'shout' }], voice: ['h-garrick', 1500],
      sound: [['roar', 0], ['crit', 450], ['bossPhase', 700]],
    }),
    full({
      hold: 4800, art: frame('forgive'), cam: 'push', fx: ['embers', 'flicker'],
      bubbles: [{ who: 'Garrick', text: 'Forgive me, old friend.', x: 40, y: 14, tail: 'down-right' }],
      sound: [['heartbeat', 200]], voice: ['g-forgive', 900],
    }),
    full({
      hold: 4000, art: frame('gate-closes'), cam: 'pull', fx: ['shake', 'dust', 'flicker'],
      sfx: { text: 'CLANG!', x: 54, y: 30, rot: 8, size: 60 },
      caption: { text: 'Then the gate closed.' }, voice: ['n-gate-closed', 300], sound: [['gateSlam', 900]],
    }),
    full({
      hold: 3800, art: frame('last-stand'), cam: 'whip', fx: ['shake', 'flash', 'dust', 'debris', 'embers'],
      caption: { text: 'Alone, I fought on.' }, sfx: { text: 'THOOM!', x: 8, y: 42, rot: -6, size: 70 },
      voice: ['n-fought-on', 200], sound: [['whoosh', 0], ['roar', 500], ['crit', 900], ['death', 1700]],
    }),
    full({
      hold: 4200, art: frame('fallen'), cam: 'push', fx: ['desaturate', 'mist'],
      sfx: { text: 'tok… tok… tok…', x: 30, y: 20, rot: 0, size: 20 },
      sound: [['wind', 0], ['knock', 900], ['knock', 1550], ['knock', 2200]],
    }),
    full({ hold: 2800, tone: 'black', cam: 'still', fx: ['glow', 'blackout'], caption: { text: 'And then — nothing.', at: 'bottom' }, voice: ['n-nothing', 400] }),
    full({
      hold: 4400, art: frame('altar-wake'), cam: 'push', fx: ['mist', 'flicker', 'breath'],
      caption: { text: 'Ashen Crypt.' }, bubbles: [{ text: 'I died. I know I did.', x: 40, y: 44, tail: 'down-left', kind: 'thought' }],
      sound: [['wind', 0], ['heartbeat', 200], ['levelUp', 900]], voice: ['h-died', 1100],
    }),
    full({
      hold: 3800, art: frame('crypt-exit'), cam: 'push', fx: ['mist', 'flicker'],
      bubbles: [{ text: 'No answers. Move.', x: 8, y: 16, tail: 'down-right', kind: 'thought' }], voice: ['h-move', 700],
    }),
  ];
}

// ── Scene 2: armed again, the road back to the gate ────────────────────────

export function gatePages(): ComicPage[] {
  return [full({
    hold: 4400, art: ROAD, cam: 'pan-left', fx: ['mist'],
    caption: { text: 'Armed again, I took the grave road back to the gate.' },
    sound: [['wind', 0], ['bossIntro', 3400]], voice: ['n-road', 500],
  })];
}

// ── Scene 3: Morvane was waiting; the second awakening ─────────────────────

export function fallenPages(): ComicPage[] {
  return [
    full({
      hold: 4600, art: frame('came-back'), cam: 'push', fx: ['embers', 'flicker', 'breath'],
      caption: { text: 'He was waiting for me.', at: 'bottom' },
      bubbles: [{ who: 'Morvane', text: 'You came back.', x: 46, y: 10, tail: 'down-left', kind: 'whisper' }],
      sound: [['roar', 200], ['heartbeat', 3000]], voice: ['n-waiting', 600],
    }),
    full({
      hold: 3800, art: frame('altar-wake'), cam: 'push', fx: ['mist', 'flicker'],
      caption: { text: 'The altar. Again.' }, bubbles: [{ text: 'Again.', x: 44, y: 44, tail: 'down-left', kind: 'thought' }],
      sound: [['wind', 0], ['heartbeat', 200], ['levelUp', 900]], voice: ['h-again', 1100],
    }),
    full({
      hold: 4600, art: frame('rise-again'), cam: 'rise', fx: ['mist', 'flicker', 'embers'], voice: ['h-not-alone', 500],
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
      sound: [['crit', 0], ['roar', 300]], voice: ['m-silence', 1300],
    }),
    full({
      hold: 4400, art: frame('trio-victory'), cam: 'pull', fx: ['embers', 'flicker'],
      caption: { text: 'Where I fell alone, we stand together.', at: 'bottom' }, sound: [['victory', 300]], voice: ['n-together', 900],
    }),
    full({
      hold: 5000, art: frame('elyra-cloak'), cam: 'push', fx: ['mist', 'flicker'], voice: ['n-cloak', 500],
      caption: { text: 'Caught on the inside of the gate: a scrap of Elyra’s cloak.' }, sound: [['summon', 200]],
    }),
    full({ hold: 3800, tone: 'black', cam: 'still', word: 'Blackthorn', caption: { text: 'She came back here. After I died.', at: 'bottom' }, voice: ['n-elyra', 900] }),
  ];
}
