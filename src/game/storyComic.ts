import type { HeroClass } from './types';
import type { SfxName } from '@/audio/gameAudio';
import { heroFigureSrc } from './art';

// Story Box motion comic script (cinematic style approved 2026-10-10: motion comic + 2.5D parallax).
// Every page is a CSS grid of inked panels; each panel is one beat. Figure x is the centre in % of
// panel width, y the bottom offset and h the height in % of panel height. Presentation only.

export interface ComicFigure { src: string; x: number; y?: number; h: number; flip?: boolean; z?: number; dim?: boolean; anim?: 'lunge' | 'recoil' | 'rise' | 'sway' | 'fall' | 'breathe' | 'pull' }
export interface ComicBubble { text: string; who?: string; x: number; y: number; kind?: 'speech' | 'shout' | 'thought' | 'whisper'; tail?: 'down-left' | 'down-right' | 'up-left' | 'up-right' | 'none' }
export type ComicFx = 'shake' | 'flash' | 'dust' | 'glow' | 'gate-close' | 'blackout' | 'desaturate';
export interface ComicPanel {
  area: string;
  hold: number;
  bg?: string;
  bgPos?: string;
  cam?: 'push' | 'pull' | 'pan-left' | 'pan-right' | 'rise' | 'still';
  tone?: 'night' | 'ember' | 'violet' | 'bone' | 'black';
  figs: ComicFigure[];
  caption?: { text: string; at?: 'top' | 'bottom' };
  bubbles?: ComicBubble[];
  sfx?: { text: string; x: number; y: number; rot?: number; size?: number };
  fx?: ComicFx[];
  word?: string;
  sound?: [SfxName, number][];
}
export interface ComicPage { areas: string; rows: string; cols?: string; panels: ComicPanel[] }

const story = (name: string) => `/assets/story/${name}.webp`;
const MORVANE = { idle: story('morvane-idle'), slam: story('morvane-slam'), kneel: story('morvane-kneel') };
const GARRICK = story('garrick');
const ELYRA = story('elyra');
const BG = { arena: story('gate-arena'), battle: story('gate-battle'), altar: story('crypt-altar'), exit: story('crypt-exit'), road: story('grave-road') };

function poses(hero: HeroClass) {
  return { stand: heroFigureSrc(hero), wounded: story(`${hero}-wounded`), fallen: story(`${hero}-fallen`) };
}

// ── S00: betrayal and first death ──────────────────────────────────────────

export function betrayalPages(hero: HeroClass): ComicPage[] {
  const me = poses(hero);
  return [
    {
      areas: '"a a" "b b" "c d"', rows: '1.35fr 1fr 1fr',
      panels: [
        {
          area: 'a', hold: 3800, bg: BG.arena, bgPos: 'center 62%', cam: 'push', tone: 'night',
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
          figs: [{ src: MORVANE.slam, x: 58, y: -38, h: 175, anim: 'lunge' }],
          sfx: { text: 'KRA-KOOM!', x: 6, y: 14, rot: -10, size: 64 },
          sound: [['crit', 120], ['bossPhase', 500]],
        },
        {
          area: 'c', hold: 2600, bg: BG.battle, bgPos: '30% 80%', cam: 'still', tone: 'ember', fx: ['dust'],
          figs: [{ src: me.wounded, x: 50, y: -6, h: 104, anim: 'recoil' }],
          bubbles: [{ text: 'Garrick…!', x: 8, y: 8, tail: 'down-right', kind: 'shout' }],
        },
        {
          area: 'd', hold: 3400, bg: BG.arena, bgPos: 'center 40%', cam: 'push', tone: 'night',
          figs: [{ src: GARRICK, x: 46, y: -118, h: 200, flip: true }],
          bubbles: [{ who: 'Garrick', text: '…I’m sorry.', x: 8, y: 8, tail: 'down-right', kind: 'whisper' }],
          caption: { text: 'He saw me. He knew I was alive.', at: 'bottom' },
        },
      ],
    },
    {
      areas: '"a a" "b c" "d d"', rows: '1.15fr 1fr 1.2fr',
      panels: [
        {
          area: 'a', hold: 3400, bg: BG.arena, bgPos: 'center 55%', cam: 'pan-left', tone: 'violet',
          figs: [
            { src: GARRICK, x: 24, y: -4, h: 92, anim: 'pull' },
            { src: ELYRA, x: 64, y: -4, h: 96, flip: true, anim: 'sway' },
          ],
          bubbles: [
            { who: 'Elyra', text: 'No! We can’t leave!', x: 40, y: 64, tail: 'up-right', kind: 'shout' },
            { who: 'Garrick', text: 'There’s no time!', x: 4, y: 30, tail: 'down-right' },
          ],
        },
        {
          area: 'b', hold: 2600, bg: BG.battle, bgPos: '40% 85%', cam: 'push', tone: 'violet', fx: ['glow'],
          figs: [{ src: me.wounded, x: 50, y: -10, h: 112 }],
          caption: { text: 'A mark burned on me.', at: 'bottom' },
        },
        {
          area: 'c', hold: 2600, bg: BG.arena, bgPos: 'center 35%', cam: 'push', tone: 'violet',
          figs: [{ src: ELYRA, x: 50, y: -128, h: 210, flip: true }],
          caption: { text: 'Elyra saw it.', at: 'bottom' },
        },
        {
          area: 'd', hold: 3600, bg: BG.arena, bgPos: 'center 28%', cam: 'push', tone: 'night', fx: ['gate-close', 'shake'],
          figs: [],
          sfx: { text: 'CLANG!', x: 56, y: 60, rot: 8, size: 60 },
          caption: { text: 'Then the gate closed.' },
          sound: [['bossPhase', 1700], ['crit', 2300]],
        },
      ],
    },
    {
      areas: '"a" "b" "c"', rows: '1.45fr 1fr .62fr', cols: '1fr',
      panels: [
        {
          area: 'a', hold: 3200, bg: BG.battle, bgPos: 'center 75%', cam: 'push', tone: 'ember', fx: ['shake', 'flash', 'dust'],
          caption: { text: 'Alone, I fought on.' },
          figs: [
            { src: MORVANE.slam, x: 70, y: -6, h: 112, anim: 'lunge' },
            { src: me.stand, x: 26, y: -2, h: 64, anim: 'lunge' },
          ],
          sfx: { text: 'THOOM!', x: 30, y: 24, rot: -6, size: 64 },
          sound: [['heroAttack', 0], ['crit', 700], ['death', 1500]],
        },
        {
          area: 'b', hold: 3600, bg: BG.battle, bgPos: 'center 92%', cam: 'still', tone: 'black', fx: ['desaturate'],
          figs: [
            { src: me.fallen, x: 46, y: 4, h: 42, anim: 'fall' },
            { src: story('hollow-one'), x: 90, y: 34, h: 26, dim: true },
          ],
          sfx: { text: 'tok… tok… tok…', x: 48, y: 12, rot: 0, size: 18 },
          sound: [['tap', 600], ['tap', 1250], ['tap', 1900]],
        },
        {
          area: 'c', hold: 2600, tone: 'black', cam: 'still', fx: ['glow', 'blackout'],
          figs: [],
          caption: { text: 'And then — nothing.', at: 'bottom' },
        },
      ],
    },
  ];
}

// ── S01 / S05: awakening at the altar ──────────────────────────────────────

export function awakenPages(hero: HeroClass, again: boolean): ComicPage[] {
  const me = poses(hero);
  if (again) {
    return [{
      areas: '"a" "b"', rows: '1.2fr 1fr', cols: '1fr',
      panels: [
        {
          area: 'a', hold: 2600, bg: BG.altar, bgPos: 'center 72%', cam: 'push', tone: 'bone', fx: ['glow'],
          figs: [{ src: me.fallen, x: 50, y: 30, h: 22 }],
          caption: { text: 'The altar. Again.' },
          sound: [['levelUp', 200]],
        },
        {
          area: 'b', hold: 3000, bg: BG.altar, bgPos: 'center 85%', cam: 'rise', tone: 'bone',
          figs: [{ src: me.wounded, x: 50, y: -8, h: 110, anim: 'rise' }],
          bubbles: [{ text: 'Then I rise again.', x: 6, y: 8, tail: 'down-right', kind: 'thought' }],
        },
      ],
    }];
  }
  return [{
    areas: '"a a" "b c"', rows: '1.3fr 1fr',
    panels: [
      {
        area: 'a', hold: 3400, bg: BG.altar, bgPos: 'center 72%', cam: 'push', tone: 'bone', fx: ['glow'],
        figs: [{ src: me.fallen, x: 50, y: 30, h: 22 }],
        caption: { text: 'Ashen Crypt.' },
        bubbles: [{ text: 'I died. I know I did.', x: 50, y: 40, tail: 'down-left', kind: 'thought' }],
        sound: [['levelUp', 300]],
      },
      {
        area: 'b', hold: 2600, bg: BG.altar, bgPos: 'center 88%', cam: 'rise', tone: 'bone',
        figs: [{ src: me.wounded, x: 50, y: -10, h: 116, anim: 'rise' }],
        bubbles: [{ text: 'How am I still alive?', x: 6, y: 6, tail: 'down-right', kind: 'thought' }],
      },
      {
        area: 'c', hold: 3000, bg: BG.exit, bgPos: '52% center', cam: 'push', tone: 'night',
        figs: [
          { src: story('skeleton'), x: 34, y: 28, h: 30, dim: true, anim: 'sway' },
          { src: story('skeleton'), x: 56, y: 30, h: 26, dim: true, flip: true, anim: 'sway' },
          { src: story('skeleton'), x: 74, y: 27, h: 32, dim: true, anim: 'sway' },
        ],
        bubbles: [{ text: 'No answers. Move.', x: 6, y: 6, tail: 'none' }],
      },
    ],
  }];
}

// ── S08 victory and S09 Elyra's trace ──────────────────────────────────────

export function victoryPages(squad: HeroClass[]): ComicPage[] {
  const xs = [24, 50, 76];
  return [{
    areas: '"a" "b"', rows: '1.15fr 1fr', cols: '1fr',
    panels: [
      {
        area: 'a', hold: 3200, bg: BG.battle, bgPos: 'center 75%', cam: 'push', tone: 'ember', fx: ['shake', 'flash', 'dust'],
        figs: [{ src: MORVANE.kneel, x: 54, y: -8, h: 116, anim: 'fall' }],
        sfx: { text: 'KRRAK!', x: 6, y: 12, rot: -8, size: 60 },
        bubbles: [{ who: 'Morvane', text: 'At last… silence…', x: 54, y: 8, tail: 'down-left', kind: 'whisper' }],
        sound: [['crit', 0], ['bossPhase', 600]],
      },
      {
        area: 'b', hold: 3400, bg: BG.arena, bgPos: 'center 30%', cam: 'pull', tone: 'night', fx: ['gate-close'],
        figs: squad.map((heroClass, index) => ({ src: heroFigureSrc(heroClass), x: xs[index] ?? 50, y: -4, h: 64 })),
        caption: { text: 'Where I fell alone, we stand together.', at: 'bottom' },
        sound: [['victory', 300]],
      },
    ],
  }];
}

export function cluePages(): ComicPage[] {
  return [{
    areas: '"a" "b"', rows: '1.3fr .7fr', cols: '1fr',
    panels: [
      {
        area: 'a', hold: 3600, bg: BG.arena, bgPos: 'center 30%', cam: 'push', tone: 'violet', fx: ['glow'],
        figs: [{ src: story('cloak-scrap'), x: 50, y: 6, h: 70, anim: 'sway' }],
        caption: { text: 'Caught on the inside of the gate: a scrap of Elyra’s cloak.' },
        sound: [['summon', 200]],
      },
      {
        area: 'b', hold: 3000, tone: 'black', cam: 'still', figs: [],
        word: 'Blackthorn',
        caption: { text: 'She came back here. After I died.', at: 'bottom' },
      },
    ],
  }];
}
