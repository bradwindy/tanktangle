import type { Rect } from '../../shared/types';
import type { Effects } from './effects';
import { TOXIC } from './palette';
import { Kind, type Particles, type Ramp } from './particles';
import { ctx2d, makeCanvas } from './pixels';
import { hash2 } from './world';

const TEX = 64;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Tileable value noise in [0, 1). */
function noise(x: number, y: number, period: number, seed: number): number {
  const fx = x / period;
  const fy = y / period;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const n = TEX / period;
  const v = (i: number, j: number) => hash2(((i % n) + n) % n, ((j % n) + n) % n, seed);
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
  const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

/** A dithered toxic cloud tile. Ordered dithering keeps it pixel art and lets the arena show through. */
function cloudTile(seed: number, colors: readonly string[], density: number): HTMLCanvasElement {
  const c = makeCanvas(TEX, TEX);
  const ctx = ctx2d(c);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const v = noise(x, y, 16, seed) * 0.65 + noise(x, y, 8, seed + 1) * 0.35;
      const threshold = (BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16;
      const level = v * density;
      if (level < threshold) continue;
      const band = Math.min(colors.length - 1, Math.floor(((level - threshold) / Math.max(0.01, 1 - threshold)) * colors.length * 1.4));
      ctx.fillStyle = colors[band]!;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** The closing storm: drifting dithered clouds outside the safe rect, a glowing fence, lightning. */
export class StormLayer {
  private deep: HTMLCanvasElement | null = null;
  private wisps: HTMLCanvasElement | null = null;
  private patterns = new Map<HTMLCanvasElement, CanvasPattern | null>();
  private boltClock = 0.8;
  private sparkClock = 0;
  private toxic: Ramp;

  constructor(
    private fx: Effects,
    private particles: Particles,
  ) {
    this.toxic = particles.ramp(TOXIC);
  }

  private pattern(ctx: CanvasRenderingContext2D, tile: HTMLCanvasElement): CanvasPattern | null {
    if (!this.patterns.has(tile)) this.patterns.set(tile, ctx.createPattern(tile, 'repeat'));
    return this.patterns.get(tile) ?? null;
  }

  update(safe: Rect | null, world: Rect, dt: number): boolean {
    if (!safe) return false;
    this.boltClock -= dt;
    let bolt = false;
    if (this.boltClock <= 0) {
      this.boltClock = 0.5 + Math.random() * 1.6;
      const p = randomOutside(safe, world);
      if (p) {
        const pts = [p.x, p.y];
        let x = p.x;
        let y = p.y;
        const dir = Math.random() * Math.PI * 2;
        for (let i = 0; i < 7; i++) {
          x += Math.cos(dir) * 9 + (Math.random() - 0.5) * 12;
          y += Math.sin(dir) * 9 + (Math.random() - 0.5) * 12;
          pts.push(Math.round(x), Math.round(y));
        }
        this.fx.bolt(pts);
        bolt = true;
      }
    }
    this.sparkClock += dt * 40;
    while (this.sparkClock >= 1) {
      this.sparkClock -= 1;
      const side = Math.floor(Math.random() * 4);
      const u = Math.random();
      const x = side === 0 ? safe.x0 + (safe.x1 - safe.x0) * u : side === 1 ? safe.x1 : side === 2 ? safe.x0 + (safe.x1 - safe.x0) * u : safe.x0;
      const y = side === 0 ? safe.y0 : side === 1 ? safe.y0 + (safe.y1 - safe.y0) * u : side === 2 ? safe.y1 : safe.y0 + (safe.y1 - safe.y0) * u;
      const nx = side === 1 ? -1 : side === 3 ? 1 : 0;
      const ny = side === 0 ? 1 : side === 2 ? -1 : 0;
      this.particles.spawn(x, y, nx * (6 + Math.random() * 10) + (Math.random() - 0.5) * 6, ny * (6 + Math.random() * 10) + (Math.random() - 0.5) * 6, 0.6 + Math.random() * 0.6, this.toxic, {
        kind: Kind.Square,
        drag: 1,
      });
    }
    return bolt;
  }

  draw(ctx: CanvasRenderingContext2D, safe: Rect, world: Rect, time: number): void {
    this.deep ??= cloudTile(5, ['#0e2618', '#143a22', '#1d522c', '#2a6e34'], 1.05);
    this.wisps ??= cloudTile(9, ['#2f8f3a', '#4fb83a', '#7fd84a'], 0.62);
    const x0 = Math.floor(safe.x0);
    const y0 = Math.floor(safe.y0);
    const x1 = Math.ceil(safe.x1);
    const y1 = Math.ceil(safe.y1);
    const regions: [number, number, number, number][] = [
      [world.x0, world.y0, world.x1 - world.x0, y0 - world.y0],
      [world.x0, y1, world.x1 - world.x0, world.y1 - y1],
      [world.x0, y0, x0 - world.x0, y1 - y0],
      [x1, y0, world.x1 - x1, y1 - y0],
    ];
    ctx.fillStyle = 'rgba(30,110,40,0.16)';
    for (const [rx, ry, rw, rh] of regions) if (rw > 0 && rh > 0) ctx.fillRect(rx, ry, rw, rh);
    const layers: [HTMLCanvasElement, number, number, number][] = [
      [this.deep, 9, 4, 0.7],
      [this.wisps, -14, 7, 0.55],
    ];
    for (const [tile, vx, vy, alpha] of layers) {
      const pat = this.pattern(ctx, tile);
      if (!pat) continue;
      const ox = Math.round((time * vx) % TEX);
      const oy = Math.round((time * vy) % TEX);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.fillStyle = pat;
      ctx.globalAlpha = alpha;
      for (const [rx, ry, rw, rh] of regions) if (rw > 0 && rh > 0) ctx.fillRect(rx - ox, ry - oy, rw, rh);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // The fence: a bright line with marching dashes, and a dim line just outside it.
    ctx.fillStyle = '#2f8f3a';
    ctx.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, 1);
    ctx.fillRect(x0 - 2, y1 + 1, x1 - x0 + 4, 1);
    ctx.fillRect(x0 - 2, y0 - 2, 1, y1 - y0 + 4);
    ctx.fillRect(x1 + 1, y0 - 2, 1, y1 - y0 + 4);
    ctx.fillStyle = '#a6ff4a';
    ctx.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, 1);
    ctx.fillRect(x0 - 1, y1, x1 - x0 + 2, 1);
    ctx.fillRect(x0 - 1, y0 - 1, 1, y1 - y0 + 2);
    ctx.fillRect(x1, y0 - 1, 1, y1 - y0 + 2);
    const march = Math.floor(time * 24) % 8;
    ctx.fillStyle = '#f4ffd0';
    ctx.beginPath();
    for (let x = x0 + march; x < x1; x += 8) {
      ctx.rect(x, y0 - 1, 3, 1);
      ctx.rect(x1 - (x - x0) - 3, y1, 3, 1);
    }
    for (let y = y0 + march; y < y1; y += 8) {
      ctx.rect(x1, y, 1, 3);
      ctx.rect(x0 - 1, y1 - (y - y0) - 3, 1, 3);
    }
    ctx.fill();
  }
}

function randomOutside(safe: Rect, world: Rect): { x: number; y: number } | null {
  for (let i = 0; i < 8; i++) {
    const x = world.x0 + Math.random() * (world.x1 - world.x0);
    const y = world.y0 + Math.random() * (world.y1 - world.y0);
    if (x < safe.x0 - 6 || x > safe.x1 + 6 || y < safe.y0 - 6 || y > safe.y1 + 6) return { x, y };
  }
  return null;
}
