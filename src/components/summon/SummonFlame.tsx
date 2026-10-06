import { useEffect, useRef } from 'react';

// A small additive particle fire for one Summon altar. Particles rise from the brazier,
// converge into a tip and cool from a white core through the altar's tone to a dark tip.
// One canvas per altar, sprites pre-rendered once, the loop pauses off-screen, in a hidden
// tab and while the reveal covers the screen; Reduced Motion draws one still frame.
type Palette = readonly [core: string, mid: string, outer: string, tip: string];

const FLAME_PALETTES: Record<'violet' | 'gold' | 'crimson', Palette> = {
  violet: ['#fff4ff', '#e2b8ff', '#9a4dff', '#3a1080'],
  gold: ['#fffbea', '#ffd27a', '#ff8d22', '#8a2c04'],
  crimson: ['#fff1e0', '#ffad6b', '#ff4a1f', '#7a0e04'],
};

interface Particle { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; seed: number }

function sprite(color: string, px: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const r = px / 2;
  const n = Number.parseInt(color.slice(1), 16);
  const rgb = `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, `rgba(${rgb}, 1)`);
  g.addColorStop(.3, `rgba(${rgb}, .6)`);
  g.addColorStop(.65, `rgba(${rgb}, .18)`);
  g.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  return canvas;
}

export function SummonFlame({ tone, lit, busy, still, paused, className }: {
  tone: keyof typeof FLAME_PALETTES;
  lit: boolean;
  busy: boolean;
  still: boolean;
  paused: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ lit, busy, paused });
  live.current = { lit, busy, paused };

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // Particles are drawn into a half-resolution buffer and scaled up: the upscale blends
    // neighbouring particles into one continuous body instead of visible bubbles.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const buffer = document.createElement('canvas');
    const bctx = buffer.getContext('2d');
    if (!bctx) return;
    const scale = .5;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      buffer.width = Math.max(1, Math.round(w * scale));
      buffer.height = Math.max(1, Math.round(h * scale));
      bctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    };
    resize();
    const sprites = FLAME_PALETTES[tone].map((color) => sprite(color, 64));
    const particles: Particle[] = [];
    const sparks: Particle[] = [];
    let spawnDebt = 0;
    let sparkDebt = 0;
    let time = Math.random() * 10;

    const spawn = (intensity: number) => {
      const spread = w * (.13 + .04 * intensity);
      const offset = (Math.random() - .5) * 2;
      particles.push({
        x: w / 2 + offset * spread,
        y: h * .9,
        vx: -offset * w * .05,
        vy: h * (.7 + Math.random() * .6) * (.8 + .3 * intensity),
        age: 0,
        // Particles near the middle live longer, which shapes the tongue's pointed tip.
        life: (.35 + Math.random() * .4) * (1.25 - Math.abs(offset) * .5),
        size: w * (.16 + Math.random() * .12) * (.85 + .2 * intensity),
        seed: Math.random() * 100,
      });
    };

    const step = (dt: number) => {
      const { lit: isLit, busy: isBusy } = live.current;
      const intensity = isBusy ? 1.6 : isLit ? 1 : .18;
      time += dt;
      spawnDebt += dt * (isBusy ? 320 : isLit ? 240 : 16);
      while (spawnDebt >= 1 && particles.length < 320) { spawn(intensity); spawnDebt -= 1; }
      sparkDebt += dt * (isBusy ? 14 : isLit ? 4 : 0);
      while (sparkDebt >= 1 && sparks.length < 24) {
        sparks.push({ x: w / 2 + (Math.random() - .5) * w * .2, y: h * .6, vx: (Math.random() - .5) * w * .5, vy: h * (.5 + Math.random() * .5), age: 0, life: .7 + Math.random() * .7, size: .8 + Math.random() * .9, seed: Math.random() * 100 });
        sparkDebt -= 1;
      }
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const p = sparks[i];
        p.age += dt;
        if (p.age >= p.life || p.y < 0) { sparks.splice(i, 1); continue; }
        p.vx += Math.sin(time * 6 + p.seed) * w * 1.2 * dt;
        p.x += p.vx * dt;
        p.y -= p.vy * dt;
      }
      // Slow gusts bend the whole flame; fast noise makes the tongues flicker.
      const gust = Math.sin(time * 1.7) * .6 + Math.sin(time * 4.3 + 1.2) * .3;
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        p.age += dt;
        if (p.age >= p.life) { particles.splice(i, 1); continue; }
        const t = p.age / p.life;
        const flick = Math.sin(time * 11 + p.seed) * w * .5 * t;
        p.vx += ((w / 2 - p.x) * 7 + gust * w * .7 * t + flick) * dt;
        p.vx *= 1 - 2.2 * dt;
        p.vy += h * .9 * dt;
        p.x += p.vx * dt;
        p.y -= p.vy * dt;
      }
    };

    const draw = () => {
      bctx.clearRect(0, 0, w, h);
      bctx.globalCompositeOperation = 'lighter';
      // A steady hot glow at the base ties the tongues to the brazier.
      const { lit: isLit, busy: isBusy } = live.current;
      if (isLit || isBusy) {
        bctx.globalAlpha = isBusy ? .4 : .28;
        bctx.drawImage(sprites[1], w * .25, h * .72, w * .5, h * .26);
        bctx.globalAlpha = isBusy ? .35 : .22;
        bctx.drawImage(sprites[0], w * .36, h * .78, w * .28, h * .17);
      }
      for (const p of particles) {
        const t = p.age / p.life;
        const stage = t < .12 ? 0 : t < .36 ? 1 : t < .68 ? 2 : 3;
        const size = p.size * (1 - t * .6);
        const fadeIn = Math.min(1, p.age / .06);
        bctx.globalAlpha = fadeIn * (1 - t * t) * (stage === 0 ? .16 : stage === 1 ? .24 : stage === 2 ? .26 : .13);
        bctx.drawImage(sprites[stage], p.x - size / 2, p.y - size, size, size * 2);
      }
      bctx.globalAlpha = 1;
      bctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);
      // Sparks stay sharp, so they are drawn at full resolution.
      ctx.globalCompositeOperation = 'lighter';
      for (const p of sparks) {
        const t = p.age / p.life;
        ctx.globalAlpha = (1 - t) * .9;
        const r = p.size * dpr * 2.2;
        ctx.drawImage(sprites[t < .4 ? 0 : 1], p.x * dpr - r, p.y * dpr - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    if (still) {
      for (let i = 0; i < 90; i += 1) step(1 / 60);
      draw();
      return undefined;
    }

    let frame = 0;
    let last = performance.now();
    let visible = true;
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; })
      : null;
    observer?.observe(canvas);
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden || live.current.paused) return;
      if (canvas.clientWidth !== w || canvas.clientHeight !== h) resize();
      step(dt);
      draw();
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [tone, still]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
