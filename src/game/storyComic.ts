import type { HeroClass } from './types';
import type { SfxName } from '@/audio/gameAudio';
import { heroFigureSrc } from './art';

// Seeker story comic script (cinematic style approved 2026-10-10: motion comic + 2.5D parallax).
// Every page is a CSS grid of inked panels; each panel is one beat. A panel is either one painted
// illustration (`art`, animated by camera moves and ambient effects) or a composition of story
// layers (`bg` + `figs`). Figure x is the centre in % of panel width, y the bottom offset and h the
// height in % of panel height. Presentation only: no save, no reward.

export interface ComicFigure { src: string; x: number; y?: number; h: number; flip?: boolean; z?: number; dim?: boolean; anim?: 'lunge' | 'recoil' | 'rise' | 'sway' | 'fall' | 'breathe' | 'pull' }
export interface ComicBubble { text: string; who?: string; x: number; y: number; kind?: 'speech' | 'shout' | 'thought' | 'whisper'; tail?: 'down-left' | 'down-right' | 'up-left' | 'up-right' | 'none' }
export type ComicFx = 'shake' | 'flash' | 'dust' | 'glow' | 'gate-close' | 'blackout' | 'desaturate' | 'embers' | 'mist' | 'flicker';
export interface ComicPanel {
  area: string;
  hold: number;
  /** One painted illustration filling the panel. */
  art?: string;
  artPos?: string;
  bg?: string;
  bgPos?: string;
  cam?: 'push' | 'pull' | 'pan-left' | 'pan-right' | 'rise' | 'still';
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
const MORVANE = { idle: story('morvane-idle'), slam: story('morvane-slam'), kneel: story('morvane-kneel') };
const GARRICK = story('garrick');
const ELYRA = story('elyra');
const BG = { arena: story('gate-arena'), battle: story('gate-battle'), altar: story('crypt-altar'), exit: story('crypt-exit') };
// Founder-supplied painted panels (2026-10-12). Speech that is part of the painting stays in it.
const ART = {
  forgiveMe: '/assets/story/comic/betrayal-forgive-me.webp',
  move: '/assets/story/comic/crypt-exit-move.webp',
  slash: '/assets/story/comic/skeleton-slash.webp',
  road: '/assets/story/comic/grave-road-return.webp',
  cameBack: '/assets/story/comic/morvane-you-came-back.webp',
};

function poses(hero: HeroClass) {
  return { stand: heroFigureSrc(hero), wounded: story(`${hero}-wounded`), fallen: story(`${hero}-fallen`) };
}

function altarPanel(hero: HeroClass, area: string, text: string, line: VoiceLine, caption?: string): ComicPanel {
  return {
    area, hold: 4000, bg: BG.altar, bgPos: 'center 72%', cam: 'push', tone: 'bone', fx: ['glow', 'mist'],
    figs: [{ src: poses(hero).fallen, x: 50, y: 30, h: 22 }],
    caption: caption ? { text: caption } : undefined,
    bubbles: [{ text, x: 46, y: 36, tail: 'down-left', kind: 'thought' }],
    sound: [['wind', 0], ['heartbeat', 200], ['levelUp', 900]],
    voice: [line, 1100],
  };
}

// ── Scene 1: betrayal, first death, first awakening ────────────────────────

export function introPages(hero: HeroClass): ComicPage[] {
  const me = poses(hero);
  return [
    {
      areas: '"a a" "b c"', rows: '1.3fr 1fr',
      panels: [
        {
          area: 'a', hold: 4400, bg: BG.arena, bgPos: 'center 62%', cam: 'push', tone: 'night', fx: ['embers'], voice: ['n-broken-gate', 700],
          caption: { text: 'The Broken Gate. Three of us came to end Morvane.' },
          figs: [
            { src: MORVANE.idle, x: 60, y: 14, h: 92, z: 1, dim: true, anim: 'breathe' },
            { src: GARRICK, x: 16, y: 0, h: 58, z: 3 },
            { src: me.stand, x: 42, y: -2, h: 56, z: 4 },
            { src: ELYRA, x: 82, y: 0, h: 56, z: 3, flip: true },
          ],
          sound: [['bossIntro', 0]],
        },
        {
          area: 'b', hold: 2600, bg: BG.battle, bgPos: 'center 70%', cam: 'pull', tone: 'ember', fx: ['shake', 'flash', 'dust'],
          figs: [{ src: MORVANE.slam, x: 58, y: -30, h: 160, anim: 'lunge' }],
          sfx: { text: 'KRA-KOOM!', x: 4, y: 10, rot: -10, size: 44 },
          sound: [['roar', 0], ['crit', 450], ['bossPhase', 700]],
        },
        {
          area: 'c', hold: 2600, bg: BG.battle, bgPos: '30% 80%', cam: 'still', tone: 'ember', fx: ['dust', 'embers'],
          figs: [{ src: me.wounded, x: 50, y: -6, h: 104, anim: 'recoil' }],
          bubbles: [{ text: 'Garrick…!', x: 8, y: 8, tail: 'down-right', kind: 'shout' }], voice: ['h-garrick', 500],
        },
      ],
    },
    {
      areas: '"a" "b"', rows: '1.75fr 1fr', cols: '1fr',
      panels: [
        { area: 'a', hold: 4400, art: ART.forgiveMe, cam: 'push', tone: 'clear', fx: ['embers', 'flicker'], sound: [['heartbeat', 200]], voice: ['g-forgive', 900] },
        {
          area: 'b', hold: 3400, bg: BG.arena, bgPos: 'center 28%', cam: 'push', tone: 'night', fx: ['gate-close', 'shake'],
          figs: [],
          sfx: { text: 'CLANG!', x: 60, y: 46, rot: 8, size: 52 },
          caption: { text: 'Then the gate closed.' }, voice: ['n-gate-closed', 300],
          sound: [['gateSlam', 1200]],
        },
      ],
    },
    {
      areas: '"a" "b" "c"', rows: '1.45fr 1fr .62fr', cols: '1fr',
      panels: [
        {
          area: 'a', hold: 3200, bg: BG.battle, bgPos: 'center 75%', cam: 'push', tone: 'ember', fx: ['shake', 'flash', 'dust', 'embers'],
          caption: { text: 'Alone, I fought on.' },
          figs: [
            { src: MORVANE.slam, x: 70, y: -6, h: 112, anim: 'lunge' },
            { src: me.stand, x: 26, y: -2, h: 64, anim: 'lunge' },
          ],
          sfx: { text: 'THOOM!', x: 30, y: 24, rot: -6, size: 64 },
          voice: ['n-fought-on', 200],
          sound: [['whoosh', 0], ['roar', 500], ['crit', 900], ['death', 1600]],
        },
        {
          area: 'b', hold: 3600, bg: BG.battle, bgPos: 'center 92%', cam: 'still', tone: 'black', fx: ['desaturate', 'mist'],
          figs: [
            { src: me.fallen, x: 46, y: 4, h: 42, anim: 'fall' },
            { src: story('hollow-one'), x: 90, y: 34, h: 26, dim: true },
          ],
          sfx: { text: 'tok… tok… tok…', x: 48, y: 12, rot: 0, size: 18 },
          sound: [['wind', 0], ['knock', 700], ['knock', 1350], ['knock', 2000]],
        },
        { area: 'c', hold: 2800, tone: 'black', cam: 'still', fx: ['glow', 'blackout'], figs: [], caption: { text: 'And then — nothing.', at: 'bottom' }, voice: ['n-nothing', 400] },
      ],
    },
    {
      areas: '"a" "b"', rows: '1fr 1.7fr', cols: '1fr',
      panels: [
        altarPanel(hero, 'a', 'I died. I know I did.', 'h-died', 'Ashen Crypt.'),
        { area: 'b', hold: 3800, art: ART.move, cam: 'push', tone: 'clear', fx: ['mist', 'flicker'], voice: ['h-move', 700] },
      ],
    },
    {
      areas: '"a"', rows: 'auto', cols: '1fr',
      panels: [
        { area: 'a', hold: 3400, art: ART.slash, cam: 'pull', tone: 'clear', fx: ['shake', 'dust'], sfx: { text: 'CRACK!', x: 58, y: 8, rot: 8, size: 58 }, sound: [['whoosh', 200], ['crit', 550], ['death', 900]] },
      ],
    },
  ];
}

// ── Scene 2: armed again, the road back to the gate ────────────────────────

export function gatePages(): ComicPage[] {
  return [{
    areas: '"a"', rows: 'auto', cols: '1fr',
    panels: [{
      area: 'a', hold: 4400, art: ART.road, cam: 'push', tone: 'clear', fx: ['mist'],
      caption: { text: 'Armed again, I took the grave road back to the gate.' },
      sound: [['wind', 0], ['bossIntro', 3400]], voice: ['n-road', 500],
    }],
  }];
}

// ── Scene 3: Morvane was waiting; the second awakening ─────────────────────

export function fallenPages(hero: HeroClass): ComicPage[] {
  const me = poses(hero);
  return [
    {
      areas: '"a"', rows: 'auto', cols: '1fr',
      panels: [{ area: 'a', hold: 4600, art: ART.cameBack, cam: 'push', tone: 'clear', fx: ['embers', 'flicker'], caption: { text: 'He was waiting for me.', at: 'bottom' }, sound: [['roar', 200], ['heartbeat', 3000]], voice: ['n-waiting', 600] }],
    },
    {
      areas: '"a" "b"', rows: '1.2fr 1fr', cols: '1fr',
      panels: [
        altarPanel(hero, 'a', 'Again.', 'h-again', 'The altar. Again.'),
        {
          area: 'b', hold: 4200, bg: BG.altar, bgPos: 'center 85%', cam: 'rise', tone: 'bone', fx: ['mist'], voice: ['h-not-alone', 500],
          figs: [{ src: me.wounded, x: 50, y: -8, h: 110, anim: 'rise' }],
          bubbles: [{ text: 'Alone I can’t win. Then I won’t be alone.', x: 6, y: 8, tail: 'down-right', kind: 'thought' }],
        },
      ],
    },
  ];
}

// ── Scene 4: the real victory and Elyra's trace ────────────────────────────

export function victoryPages(squad: HeroClass[]): ComicPage[] {
  const xs = [24, 50, 76];
  return [
    {
      areas: '"a" "b"', rows: '1.15fr 1fr', cols: '1fr',
      panels: [
        {
          area: 'a', hold: 5000, bg: BG.battle, bgPos: 'center 75%', cam: 'push', tone: 'ember', fx: ['shake', 'flash', 'dust', 'embers'],
          figs: [{ src: MORVANE.kneel, x: 54, y: -8, h: 116, anim: 'fall' }],
          sfx: { text: 'KRRAK!', x: 6, y: 12, rot: -8, size: 60 },
          bubbles: [{ who: 'Morvane', text: 'At last… silence…', x: 54, y: 8, tail: 'down-left', kind: 'whisper' }],
          sound: [['crit', 0], ['roar', 300]], voice: ['m-silence', 1300],
        },
        {
          area: 'b', hold: 4000, bg: BG.arena, bgPos: 'center 30%', cam: 'pull', tone: 'night', fx: ['gate-close'],
          figs: squad.map((heroClass, index) => ({ src: heroFigureSrc(heroClass), x: xs[index] ?? 50, y: -4, h: 64 })),
          caption: { text: 'Where I fell alone, we stand together.', at: 'bottom' },
          sound: [['victory', 300]], voice: ['n-together', 900],
        },
      ],
    },
    {
      areas: '"a" "b"', rows: '1.3fr .7fr', cols: '1fr',
      panels: [
        {
          area: 'a', hold: 5000, bg: BG.arena, bgPos: 'center 30%', cam: 'push', tone: 'violet', fx: ['glow'], voice: ['n-cloak', 500],
          figs: [{ src: story('cloak-scrap'), x: 50, y: 6, h: 70, anim: 'sway' }],
          caption: { text: 'Caught on the inside of the gate: a scrap of Elyra’s cloak.' },
          sound: [['summon', 200]],
        },
        { area: 'b', hold: 3800, tone: 'black', cam: 'still', figs: [], word: 'Blackthorn', caption: { text: 'She came back here. After I died.', at: 'bottom' }, voice: ['n-elyra', 900] },
      ],
    },
  ];
}
