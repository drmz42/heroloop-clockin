// Game sound: one looping music track plus synthesized interface and combat effects (no sample files).
// Two player switches (effects, music) persist per device; everything is silent until the first touch
// because Android WebView and browsers only start audio after a user gesture.
import { useSyncExternalStore } from 'react';

export type SfxName =
  | 'tap' | 'tab' | 'sheet' | 'hit' | 'crit' | 'heal' | 'miss' | 'death' | 'victory' | 'defeat'
  | 'coin' | 'claim' | 'purchase' | 'error' | 'levelUp' | 'equip' | 'summon'
  | 'chestCharge' | 'chestRattle' | 'chestBurst' | 'cardFly' | 'bossIntro' | 'bossPhase';

const MUSIC_SRC = '/assets/audio/shadows-of-the-void-v1.mp3';
const MUSIC_VOLUME = 0.3;
const SFX_KEY = 'hl-audio-sfx';
const MUSIC_KEY = 'hl-audio-music';

function readFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) !== 'off'; } catch { return true; }
}
function writeFlag(key: string, on: boolean) {
  try { window.localStorage.setItem(key, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
}

const SFX_VOLUME_KEY = 'hl-audio-sfx-volume';
const MUSIC_VOLUME_KEY = 'hl-audio-music-volume';
function readLevel(key: string): number {
  try { const value = Number(window.localStorage.getItem(key)); return window.localStorage.getItem(key) !== null && value >= 0 && value <= 1 ? value : 1; } catch { return 1; }
}
function writeLevel(key: string, value: number) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
}

let settings = { sfx: readFlag(SFX_KEY), music: readFlag(MUSIC_KEY), sfxVolume: readLevel(SFX_VOLUME_KEY), musicVolume: readLevel(MUSIC_VOLUME_KEY) };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let music: HTMLAudioElement | null = null;
let musicFade = 0;
let duckUntil = 0;
let unlocked = false;
let installed = 0;
const lastPlayed = new Map<SfxName, number>();

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14; compressor.knee.value = 12; compressor.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0.62 * settings.sfxVolume;
    master.connect(compressor); compressor.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } catch { ctx = null; }
  return ctx;
}

interface ToneOptions { type?: OscillatorType; gain?: number; attack?: number; at?: number; to?: number; detune?: number; filter?: number }
function tone(freq: number, dur: number, o: ToneOptions = {}) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + (o.at ?? 0);
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur);
  if (o.detune) osc.detune.value = o.detune;
  const peak = o.gain ?? 0.2;
  const attack = o.attack ?? 0.005;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let head: AudioNode = osc;
  if (o.filter) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.filter;
    osc.connect(lp); head = lp;
  }
  head.connect(env); env.connect(master);
  osc.start(t); osc.stop(t + dur + 0.05);
}

interface NoiseOptions { type?: BiquadFilterType; freq?: number; to?: number; q?: number; gain?: number; attack?: number; at?: number }
function hiss(dur: number, o: NoiseOptions = {}) {
  if (!ctx || !master || !noise) return;
  const t = ctx.currentTime + (o.at ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = noise; src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = o.type ?? 'lowpass';
  filter.frequency.setValueAtTime(o.freq ?? 1200, t);
  if (o.to) filter.frequency.exponentialRampToValueAtTime(Math.max(30, o.to), t + dur);
  filter.Q.value = o.q ?? 0.8;
  const env = ctx.createGain();
  const attack = o.attack ?? 0.004;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter); filter.connect(env); env.connect(master);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}

/** A struck bell: inharmonic partials make it read as metal rather than a beep. */
function bell(freq: number, dur: number, gain: number, at = 0) {
  tone(freq, dur, { gain, at });
  tone(freq * 2.76, dur * 0.6, { gain: gain * 0.35, at });
  tone(freq * 5.4, dur * 0.35, { gain: gain * 0.16, at });
}

const vary = (value: number, spread = 0.08) => value * (1 - spread + Math.random() * spread * 2);

const PLAYERS: Record<SfxName, (tier: number) => void> = {
  tap: () => { hiss(0.03, { type: 'bandpass', freq: 2400, q: 1.4, gain: 0.07 }); tone(vary(540), 0.05, { gain: 0.035, to: 380 }); },
  tab: () => { hiss(0.04, { type: 'bandpass', freq: 1800, q: 1.2, gain: 0.08 }); tone(vary(220), 0.09, { gain: 0.07, to: 150 }); },
  sheet: () => hiss(0.22, { type: 'bandpass', freq: 380, to: 1700, q: 1.1, gain: 0.08, attack: 0.06 }),
  hit: () => { tone(vary(150), 0.11, { gain: 0.32, to: 55 }); hiss(0.07, { freq: vary(1400), to: 300, gain: 0.16 }); },
  crit: () => {
    tone(vary(120), 0.2, { gain: 0.45, to: 40 });
    hiss(0.16, { type: 'highpass', freq: 2500, gain: 0.12 });
    tone(1210, 0.32, { type: 'triangle', gain: 0.07, at: 0.01 }); tone(1830, 0.26, { type: 'triangle', gain: 0.05, at: 0.01 });
  },
  heal: () => { tone(620, 0.25, { gain: 0.05, to: 940, attack: 0.04 }); tone(930, 0.3, { gain: 0.035, to: 1400, attack: 0.06, at: 0.05 }); },
  miss: () => hiss(0.12, { type: 'bandpass', freq: 600, to: 2600, q: 2, gain: 0.06, attack: 0.03 }),
  death: () => { hiss(0.5, { freq: 900, to: 120, gain: 0.2, attack: 0.01 }); tone(95, 0.45, { gain: 0.22, to: 38 }); bell(311, 0.6, 0.03, 0.08); },
  victory: () => {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.42, { type: 'sawtooth', gain: 0.06, filter: 2400, attack: 0.02, at: i * 0.075 }));
    bell(1568, 0.7, 0.04, 0.3);
  },
  defeat: () => [392, 311, 233].forEach((f, i) => tone(f, 0.55, { type: 'triangle', gain: 0.08, attack: 0.03, at: i * 0.18 })),
  coin: () => { bell(vary(1568, 0.03), 0.28, 0.06); bell(vary(2093, 0.03), 0.34, 0.05, 0.06); },
  claim: () => { PLAYERS.coin(0); [784, 988, 1175].forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.05, at: 0.08 + i * 0.07 })); },
  purchase: () => { for (let i = 0; i < 5; i++) bell(vary(1700 + i * 140, 0.04), 0.3, 0.045, i * 0.05); tone(392, 0.5, { type: 'sawtooth', gain: 0.04, filter: 1400, at: 0.05 }); },
  error: () => { tone(165, 0.12, { type: 'square', gain: 0.05, filter: 900 }); tone(140, 0.16, { type: 'square', gain: 0.05, filter: 900, at: 0.14 }); },
  levelUp: () => {
    [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.5, { type: 'triangle', gain: 0.07, at: i * 0.07 }));
    hiss(0.9, { type: 'highpass', freq: 5000, gain: 0.05, attack: 0.3, at: 0.15 });
  },
  equip: () => { hiss(0.06, { type: 'bandpass', freq: 3000, q: 3, gain: 0.08 }); bell(880, 0.25, 0.04, 0.02); },
  summon: () => { hiss(1.1, { type: 'bandpass', freq: 300, to: 2400, q: 4, gain: 0.12, attack: 0.5 }); tone(110, 1.2, { type: 'sawtooth', gain: 0.05, filter: 600, attack: 0.4 }); },
  chestCharge: () => {
    hiss(1.35, { type: 'bandpass', freq: 220, to: 3200, q: 3, gain: 0.16, attack: 1.1 });
    tone(70, 1.35, { type: 'sawtooth', gain: 0.07, to: 160, filter: 500, attack: 1 });
  },
  chestRattle: () => { for (let i = 0; i < 3; i++) hiss(0.04, { type: 'bandpass', freq: vary(950), q: 2.5, gain: 0.14, at: i * 0.055 }); },
  chestBurst: (tier) => {
    tone(82, 0.8, { gain: 0.6, to: 30 });
    hiss(0.9, { freq: 5200, to: 240, gain: 0.32 });
    bell(tier >= 4 ? 1318 : 1046, 1.4, 0.07, 0.04);
    bell(tier >= 4 ? 1976 : 1568, 1.2, 0.05, 0.1);
  },
  cardFly: () => hiss(0.12, { type: 'bandpass', freq: 900, to: 3200, q: 1.5, gain: 0.05, attack: 0.03 }),
  bossIntro: () => {
    tone(55, 0.9, { gain: 0.6, to: 32 }); hiss(0.5, { freq: 400, to: 80, gain: 0.25 });
    tone(55, 0.9, { gain: 0.55, to: 32, at: 0.42 }); hiss(0.5, { freq: 400, to: 80, gain: 0.22, at: 0.42 });
    tone(98, 1.6, { type: 'sawtooth', gain: 0.1, filter: 700, attack: 0.5, at: 0.75 });
    tone(147, 1.4, { type: 'sawtooth', gain: 0.07, filter: 700, attack: 0.5, at: 0.85 });
  },
  bossPhase: () => { tone(65, 0.7, { gain: 0.45, to: 34 }); tone(131, 1.1, { type: 'sawtooth', gain: 0.07, filter: 800, attack: 0.3, at: 0.1 }); },
};

/** Rarity sting for one revealed card: higher tiers ring higher and add a choir pad. */
export function playReveal(tier: number) {
  if (!settings.sfx || !unlocked || !audio()) return;
  const notes = [660, 740, 880, 988, 1175, 1318, 1480, 1568];
  const f = notes[Math.min(notes.length - 1, Math.max(0, tier))];
  bell(f, 0.5 + tier * 0.12, 0.05 + Math.min(tier, 6) * 0.01);
  if (tier >= 3) hiss(0.4 + tier * 0.1, { type: 'highpass', freq: 4200, gain: 0.04 + tier * 0.006, attack: 0.08 });
  if (tier >= 4) {
    [f / 2, f / 2 * 1.26, f / 2 * 1.5].forEach((n) => tone(n, 1.6, { type: 'sawtooth', gain: 0.035, filter: 1800, attack: 0.25, detune: 7 }));
    [f, f * 1.26, f * 1.5, f * 2].forEach((n, i) => tone(n, 0.5, { type: 'triangle', gain: 0.05, at: 0.12 + i * 0.08 }));
  }
}

const THROTTLE_MS: Partial<Record<SfxName, number>> = { tap: 40, hit: 90, crit: 120, heal: 160, miss: 120, death: 140, coin: 60, cardFly: 35 };

export function playSfx(name: SfxName, tier = 0) {
  if (!settings.sfx || !unlocked || document.visibilityState === 'hidden' || !audio()) return;
  const now = performance.now();
  const gap = THROTTLE_MS[name];
  if (gap && now - (lastPlayed.get(name) ?? 0) < gap) return;
  lastPlayed.set(name, now);
  try { PLAYERS[name](tier); } catch { /* audio graph unavailable */ }
}

/** Short vibration on supported devices; silent where the Vibration API or permission is missing. */
export function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

function musicElement(): HTMLAudioElement {
  if (!music) {
    music = new Audio(MUSIC_SRC);
    music.loop = true; music.preload = 'none'; music.volume = 0;
  }
  return music;
}

function fadeMusic(target: number, ms: number, pauseAtEnd = false) {
  const el = music;
  if (!el) return;
  window.clearInterval(musicFade);
  const from = el.volume;
  const started = performance.now();
  musicFade = window.setInterval(() => {
    const k = Math.min(1, (performance.now() - started) / ms);
    el.volume = Math.max(0, Math.min(1, from + (target - from) * k));
    if (k >= 1) { window.clearInterval(musicFade); if (pauseAtEnd) el.pause(); }
  }, 40);
}

function musicTarget() { return (performance.now() < duckUntil ? MUSIC_VOLUME * 0.35 : MUSIC_VOLUME) * settings.musicVolume; }

function syncMusic() {
  if (!installed || !unlocked) return;
  if (settings.music && document.visibilityState !== 'hidden') {
    const el = musicElement();
    if (el.paused) void el.play().then(() => fadeMusic(musicTarget(), 1800)).catch(() => undefined);
    else fadeMusic(musicTarget(), 400);
  } else if (music && !music.paused) {
    fadeMusic(0, 350, true);
  }
}

/** Lowers the music while a big moment (chest, summon) plays its own sound. */
export function duckMusic(ms: number) {
  duckUntil = performance.now() + ms;
  if (music && !music.paused) fadeMusic(MUSIC_VOLUME * 0.35 * settings.musicVolume, 250);
  window.setTimeout(() => { if (performance.now() >= duckUntil) syncMusic(); }, ms + 20);
}

export function setSfxEnabled(on: boolean) { settings = { ...settings, sfx: on }; writeFlag(SFX_KEY, on); emit(); if (on) playSfx('tap'); }
export function setMusicEnabled(on: boolean) { settings = { ...settings, music: on }; writeFlag(MUSIC_KEY, on); emit(); syncMusic(); }
/** Volume mixer (More → Settings): 0..1 per channel, saved on this device. */
export function setSfxVolume(value: number) {
  const level = Math.max(0, Math.min(1, value));
  settings = { ...settings, sfxVolume: level }; writeLevel(SFX_VOLUME_KEY, level); emit();
  if (master) master.gain.value = 0.62 * level;
}
export function setMusicVolume(value: number) {
  const level = Math.max(0, Math.min(1, value));
  settings = { ...settings, musicVolume: level }; writeLevel(MUSIC_VOLUME_KEY, level); emit();
  if (music && !music.paused) { window.clearInterval(musicFade); music.volume = musicTarget(); }
}

export function useAudioSettings() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => settings, () => settings);
}

function unlock() {
  const context = audio();
  if (context && context.state === 'suspended') void context.resume().catch(() => undefined);
  unlocked = true;
  syncMusic();
}

function onClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target.closest('button, a, [role="button"], [role="tab"], select') : null;
  if (!target || target.closest('[data-sfx="off"]') || (target as HTMLButtonElement).disabled) return;
  playSfx(target.closest('.hl-tabbar-item') ? 'tab' : 'tap');
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    if (music && !music.paused) { window.clearInterval(musicFade); music.pause(); }
    if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
  } else {
    if (ctx && ctx.state === 'suspended' && unlocked) void ctx.resume().catch(() => undefined);
    syncMusic();
  }
}

/** Mount once for the game screen; returns the cleanup that stops the music when the game unmounts. */
export function installGameAudio(): () => void {
  installed += 1;
  if (installed === 1) {
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    if (unlocked) syncMusic();
  }
  return () => {
    installed -= 1;
    if (installed > 0) return;
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
    document.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
    if (music) { window.clearInterval(musicFade); music.pause(); }
  };
}
