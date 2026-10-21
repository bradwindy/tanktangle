import { Weapon } from '../../shared/types';
import { hexToRgb, mix, type Rgb } from './palette';
import { checker, circlePath, linePath, ringPath } from './raster';

/** Short-lived world-space effects that are shapes rather than particles, plus screen-wide feedback. */

export type BlastStyle = 'fire' | 'energy' | 'toxic' | 'tank';

/** Per style: the shock ring colour and puff colours [rim, body, highlight] from hot to burnt out. */
const BLAST_COLORS: Record<BlastStyle, { ring: string; rows: [string, string, string][] }> = {
  fire: {
    ring: '#fff4c8',
    rows: [
      ['#ffb03a', '#ffe14d', '#ffffff'],
      ['#ff7a2a', '#ffb03a', '#fff7c2'],
      ['#e8431f', '#ff7a2a', '#ffe14d'],
      ['#a82418', '#e8431f', '#ff9a2a'],
      ['#4a1a1e', '#7a2622', '#b8431f'],
    ],
  },
  tank: {
    ring: '#ffffff',
    rows: [
      ['#ffc94d', '#fff7c2', '#ffffff'],
      ['#ff8a2a', '#ffc94d', '#ffffff'],
      ['#f0501f', '#ff8a2a', '#ffe14d'],
      ['#b8261a', '#f0501f', '#ffb03a'],
      ['#3e1a1e', '#6e2420', '#c0431f'],
    ],
  },
  energy: {
    ring: '#ffd6ff',
    rows: [
      ['#f07bff', '#ffd6ff', '#ffffff'],
      ['#c04dff', '#f07bff', '#ffd6ff'],
      ['#8a2bd6', '#c04dff', '#f07bff'],
      ['#5a1a9e', '#8a2bd6', '#c04dff'],
      ['#2e1060', '#4a1a8a', '#7a2bd6'],
    ],
  },
  toxic: {
    ring: '#eaffb0',
    rows: [
      ['#a6ff4a', '#e4ff8a', '#ffffff'],
      ['#5fd23a', '#a6ff4a', '#e4ff8a'],
      ['#2f8f3a', '#5fd23a', '#a6ff4a'],
      ['#1d4f2c', '#2f8f3a', '#5fd23a'],
      ['#123020', '#1d4f2c', '#2f8f3a'],
    ],
  },
};

interface Blast {
  x: number;
  y: number;
  r: number;
  age: number;
  dur: number;
  style: BlastStyle;
  blobs: number[];
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  age: number;
  dur: number;
  color: string;
  thick: number;
}

interface Beam {
  pts: number[];
  age: number;
  dur: number;
  weapon: Weapon;
  color: string;
  glow: string;
}

interface Muzzle {
  x: number;
  y: number;
  a: number;
  age: number;
  dur: number;
  weapon: Weapon;
  color: string;
}

interface Column {
  x: number;
  y: number;
  age: number;
  dur: number;
  color: string;
  height: number;
  width: number;
}

interface Light {
  x: number;
  y: number;
  r: number;
  age: number;
  dur: number;
  color: string;
}

interface Bolt {
  pts: number[];
  age: number;
  dur: number;
}

interface ChargeGlow {
  x: number;
  y: number;
  progress: number;
}

export interface ScreenFx {
  shake: number;
  flash: number;
  flashColor: Rgb;
  aberration: number;
  hurt: number;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

export class Effects {
  readonly screen: ScreenFx = { shake: 0, flash: 0, flashColor: [255, 255, 255], aberration: 0, hurt: 0 };
  private blasts: Blast[] = [];
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  private muzzles: Muzzle[] = [];
  private columns: Column[] = [];
  private bolts: Bolt[] = [];
  private lights: Light[] = [];
  private charges: ChargeGlow[] = [];
  private shakeX = 0;
  private shakeY = 0;

  clear(): void {
    this.blasts.length = 0;
    this.rings.length = 0;
    this.beams.length = 0;
    this.muzzles.length = 0;
    this.columns.length = 0;
    this.bolts.length = 0;
    this.lights.length = 0;
    this.screen.shake = 0;
    this.screen.flash = 0;
    this.screen.aberration = 0;
    this.screen.hurt = 0;
  }

  shake(amount: number): void {
    this.screen.shake = Math.min(9, Math.max(this.screen.shake, amount));
  }

  flash(color: string, amount: number): void {
    if (amount < this.screen.flash) return;
    this.screen.flash = Math.min(0.8, amount);
    this.screen.flashColor = hexToRgb(color);
  }

  aberrate(amount: number): void {
    this.screen.aberration = Math.min(4, Math.max(this.screen.aberration, amount));
  }

  hurt(amount: number): void {
    this.screen.hurt = Math.min(1, Math.max(this.screen.hurt, amount));
  }

  blast(x: number, y: number, r: number, style: BlastStyle, dur = 0.55, delay = 0): void {
    const blobs: number[] = [0, 0, 1];
    const n = 4 + Math.floor(r / 10);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.18 + Math.random() * 0.3);
      blobs.push(Math.cos(a) * d, Math.sin(a) * d, 0.45 + Math.random() * 0.35);
    }
    this.blasts.push({ x, y, r, age: -delay, dur, style, blobs });
  }

  ring(x: number, y: number, r0: number, r1: number, dur: number, color: string, thick = 1): void {
    this.rings.push({ x, y, r0, r1, age: 0, dur, color, thick });
  }

  beam(pts: number[], weapon: Weapon, color: string): void {
    if (pts.length < 4) return;
    const deathRay = weapon === Weapon.DeathRay;
    this.beams.push({
      pts,
      age: 0,
      dur: deathRay ? 0.75 : 0.32,
      weapon,
      color,
      glow: deathRay ? '#c04dff' : mix(color, '#ffffff', 0.25),
    });
  }

  muzzle(x: number, y: number, a: number, weapon: Weapon, color: string): void {
    const dur = weapon === Weapon.Shotgun || weapon === Weapon.DeathRay ? 0.12 : weapon === Weapon.Gatling ? 0.05 : 0.08;
    this.muzzles.push({ x, y, a, age: 0, dur, weapon, color });
  }

  column(x: number, y: number, color: string, dur: number, height: number, width: number): void {
    this.columns.push({ x, y, age: 0, dur, color, height, width });
  }

  /** A short pool of light on the floor under a flash or explosion. */
  light(x: number, y: number, r: number, color: string, dur: number): void {
    if (this.lights.length > 40) this.lights.shift();
    this.lights.push({ x, y, r, age: 0, dur, color });
  }

  bolt(pts: number[]): void {
    this.bolts.push({ pts, age: 0, dur: 0.22 });
  }

  /** A death ray charging glow this frame (cleared after every draw). */
  charge(x: number, y: number, progress: number): void {
    this.charges.push({ x, y, progress });
  }

  update(dt: number, time: number): void {
    const s = this.screen;
    s.shake = Math.max(0, s.shake - dt * (4 + s.shake * 5));
    s.flash = Math.max(0, s.flash - dt * 3.2);
    s.aberration = Math.max(0, s.aberration - dt * 9);
    s.hurt = Math.max(0, s.hurt - dt * 1.6);
    const mag = s.shake;
    this.shakeX = mag * (Math.sin(time * 71.3) * 0.6 + Math.sin(time * 113.7) * 0.4);
    this.shakeY = mag * (Math.cos(time * 83.1) * 0.6 + Math.sin(time * 97.9) * 0.4);
    age(this.blasts, dt);
    age(this.rings, dt);
    age(this.beams, dt);
    age(this.muzzles, dt);
    age(this.columns, dt);
    age(this.bolts, dt);
    age(this.lights, dt);
  }

  get offsetX(): number {
    return this.shakeX;
  }

  get offsetY(): number {
    return this.shakeY;
  }

  /** Floor lights and spawn columns sit under tanks; call before drawing tanks. */
  drawGround(ctx: CanvasRenderingContext2D): void {
    for (const l of this.lights) {
      const fade = 1 - l.age / l.dur;
      const r = l.r * (0.75 + 0.25 * fade);
      const cx = Math.round(l.x);
      const cy = Math.round(l.y);
      ctx.fillStyle = checker(ctx, l.color, 0);
      ctx.globalAlpha = 0.4 * fade;
      ctx.beginPath();
      circlePath(ctx, cx, cy, r);
      ctx.fill();
      ctx.fillStyle = l.color;
      ctx.globalAlpha = 0.12 * fade;
      ctx.beginPath();
      circlePath(ctx, cx, cy, r * 0.72);
      ctx.fill();
      ctx.globalAlpha = 0.16 * fade;
      ctx.beginPath();
      circlePath(ctx, cx, cy, r * 0.42);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const c of this.columns) {
      const t = c.age / c.dur;
      const w = Math.max(1, Math.round(c.width * (1 - t * 0.8)));
      const h = Math.round(c.height * (t < 0.2 ? t / 0.2 : 1));
      const x = Math.round(c.x - w / 2);
      ctx.fillStyle = t > 0.55 ? checker(ctx, c.color) : c.color;
      ctx.fillRect(x, Math.round(c.y - h), w, h);
      ctx.fillStyle = t > 0.7 ? checker(ctx, '#ffffff') : '#ffffff';
      ctx.fillRect(Math.round(c.x) - (w > 2 ? 1 : 0), Math.round(c.y - h), w > 2 ? 2 : 1, h);
    }
  }

  draw(ctx: CanvasRenderingContext2D, time: number): void {
    for (const r of this.rings) {
      const t = r.age / r.dur;
      const radius = r.r0 + (r.r1 - r.r0) * easeOut(t);
      ctx.fillStyle = t > 0.6 ? checker(ctx, r.color, Math.round(time * 30) & 1) : r.color;
      ctx.beginPath();
      ringPath(ctx, Math.round(r.x), Math.round(r.y), radius, Math.max(1, Math.round(r.thick * (1 - t * 0.6))));
      ctx.fill();
    }
    for (const b of this.blasts) if (b.age >= 0) this.drawBlast(ctx, b, time);
    for (const m of this.muzzles) drawMuzzle(ctx, m);
    for (const b of this.beams) drawBeam(ctx, b, time);
    for (const c of this.charges) {
      const r = 1 + c.progress * 4 + Math.sin(time * 40) * 0.6;
      ctx.fillStyle = checker(ctx, '#c04dff', Math.round(time * 30) & 1);
      ctx.beginPath();
      circlePath(ctx, Math.round(c.x), Math.round(c.y), r + 2);
      ctx.fill();
      ctx.fillStyle = '#f07bff';
      ctx.beginPath();
      circlePath(ctx, Math.round(c.x), Math.round(c.y), r);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      circlePath(ctx, Math.round(c.x), Math.round(c.y), Math.max(0.5, r - 2));
      ctx.fill();
    }
    this.charges.length = 0;
    for (const b of this.bolts) {
      if (Math.floor(b.age * 40) % 3 === 2) continue;
      ctx.fillStyle = '#a6ff4a';
      ctx.beginPath();
      for (let i = 0; i + 3 < b.pts.length; i += 2) linePath(ctx, b.pts[i]! - 1, b.pts[i + 1]!, b.pts[i + 2]! - 1, b.pts[i + 3]!, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let i = 0; i + 3 < b.pts.length; i += 2) linePath(ctx, b.pts[i]!, b.pts[i + 1]!, b.pts[i + 2]!, b.pts[i + 3]!, 1);
      ctx.fill();
    }
  }

  /** Puffy pixel fireball: each blob is a rim, a body offset up-left and a highlight, cooling through the rows. */
  private drawBlast(ctx: CanvasRenderingContext2D, b: Blast, time: number): void {
    const t = b.age / b.dur;
    const pal = BLAST_COLORS[b.style];
    const cx = Math.round(b.x);
    const cy = Math.round(b.y);
    const phase = Math.round(time * 30) & 1;
    if (t < 0.45) {
      const k = t / 0.45;
      ctx.fillStyle = k > 0.5 ? checker(ctx, pal.ring, phase) : pal.ring;
      ctx.beginPath();
      ringPath(ctx, cx, cy, b.r * (0.3 + 1.05 * easeOut(k)), k < 0.3 ? 2 : 1);
      ctx.fill();
    }
    const grow = 0.45 + 0.55 * easeOut(Math.min(1, t / 0.3));
    const shrink = t > 0.55 ? 1 - ((t - 0.55) / 0.45) * 0.55 : 1;
    const base = b.r * 0.58 * grow * shrink;
    const row = pal.rows[Math.min(pal.rows.length - 1, Math.floor(t * pal.rows.length * 1.1))]!;
    const rise = t * 6;
    const fading = t > 0.68;
    const layers: [number, number, string][] = [
      [1, 0, row[0]],
      [0.78, 0.16, row[1]],
      [0.42, 0.32, row[2]],
    ];
    for (const [scale, shift, color] of layers) {
      if (fading && scale < 1 && t > 0.85) continue;
      ctx.fillStyle = fading ? checker(ctx, color, phase) : color;
      ctx.beginPath();
      for (let i = 0; i < b.blobs.length; i += 3) {
        const r = base * b.blobs[i + 2]! * scale;
        if (r < 0.6) continue;
        const bx = cx + b.blobs[i]! * grow - r * shift;
        const by = cy + b.blobs[i + 1]! * grow - rise - r * shift;
        circlePath(ctx, Math.round(bx), Math.round(by), r);
      }
      ctx.fill();
    }
    if (t < 0.1) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      circlePath(ctx, cx, cy, b.r * 0.32 * (1 - t / 0.1) + 1);
      ctx.fill();
    }
  }
}

function age<T extends { age: number; dur: number }>(list: T[], dt: number): void {
  let w = 0;
  for (const item of list) {
    item.age += dt;
    if (item.age < item.dur) list[w++] = item;
  }
  list.length = w;
}

function drawMuzzle(ctx: CanvasRenderingContext2D, m: Muzzle): void {
  const t = m.age / m.dur;
  const c = Math.cos(m.a);
  const s = Math.sin(m.a);
  const blob = (d: number, r: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    circlePath(ctx, Math.round(m.x + c * d), Math.round(m.y + s * d), r);
    ctx.fill();
  };
  const fade = 1 - t;
  switch (m.weapon) {
    case Weapon.Shotgun:
      blob(3, 5 * fade + 1, '#ff9a2a');
      blob(6, 4 * fade + 1, '#ffe14d');
      blob(2, 3 * fade, '#ffffff');
      for (const off of [-0.45, 0.45]) {
        ctx.fillStyle = '#ffe14d';
        ctx.beginPath();
        linePath(ctx, m.x + c * 3, m.y + s * 3, m.x + Math.cos(m.a + off) * 11 * fade, m.y + Math.sin(m.a + off) * 11 * fade, 1);
        ctx.fill();
      }
      break;
    case Weapon.Laser:
      blob(1, 4 * fade + 1, m.color);
      blob(1, 2 * fade + 0.5, '#ffffff');
      break;
    case Weapon.DeathRay:
      blob(2, 8 * fade + 2, '#c04dff');
      blob(2, 5 * fade + 1, '#f07bff');
      blob(2, 3 * fade, '#ffffff');
      break;
    case Weapon.Homing:
    case Weapon.Rc:
    case Weapon.Frag:
      blob(2, 3 * fade + 1, '#ffb03a');
      blob(1, 2 * fade, '#ffffff');
      break;
    case Weapon.Mines:
      blob(0, 2 * fade, '#ffd23d');
      break;
    case Weapon.Gatling:
      blob(2, 2 + Math.random(), '#ffd23d');
      blob(4, 1, '#ffffff');
      blob(1, 1, '#ffffff');
      break;
    default:
      blob(2, 2.5 * fade + 1, '#ffd23d');
      blob(4, 1.5 * fade, '#fff7c2');
      blob(1, 1.5 * fade, '#ffffff');
  }
}

function drawBeam(ctx: CanvasRenderingContext2D, b: Beam, time: number): void {
  const t = b.age / b.dur;
  const pts = b.pts;
  if (b.weapon === Weapon.DeathRay) {
    const fade = 1 - t;
    const layers: [number, string][] = [
      [Math.max(1, Math.round(9 * fade + 2)), '#7a2bd6'],
      [Math.max(1, Math.round(6 * fade + 1)), '#c04dff'],
      [Math.max(1, Math.round(3 * fade + 1)), '#f9b8ff'],
      [1, '#ffffff'],
    ];
    for (const [w, color] of layers) {
      ctx.fillStyle = t > 0.6 && w > 2 ? checker(ctx, color, Math.round(time * 30) & 1) : color;
      ctx.beginPath();
      wobblyPath(ctx, pts, w, time, (1 - t) * 2.2);
      ctx.fill();
    }
    return;
  }
  const flicker = Math.floor(time * 50) % 4 === 0 ? 0.6 : 1;
  const glowW = Math.max(1, Math.round((t < 0.15 ? 5 : 4 * (1 - t) + 1) * flicker));
  ctx.fillStyle = t > 0.5 ? checker(ctx, b.glow, Math.round(time * 30) & 1) : b.glow;
  ctx.beginPath();
  for (let i = 0; i + 3 < pts.length; i += 2) linePath(ctx, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!, glowW);
  ctx.fill();
  if (t < 0.75) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const core = t < 0.25 ? 2 : 1;
    for (let i = 0; i + 3 < pts.length; i += 2) linePath(ctx, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!, core);
    ctx.fill();
  }
}

/** A beam that wriggles perpendicular to its path. */
function wobblyPath(ctx: CanvasRenderingContext2D, pts: number[], w: number, time: number, amp: number): void {
  let dist = 0;
  const half = (w - 1) / 2;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!;
    const y0 = pts[i + 1]!;
    const dx = pts[i + 2]! - x0;
    const dy = pts[i + 3]! - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const nx = -dy / len;
    const ny = dx / len;
    for (let d = 0; d < len; d += 1) {
      const wob = Math.sin((dist + d) * 0.21 - time * 38) * amp + Math.sin((dist + d) * 0.07 + time * 17) * amp * 0.5;
      const x = x0 + (dx * d) / len + nx * wob;
      const y = y0 + (dy * d) / len + ny * wob;
      ctx.rect(Math.round(x - half), Math.round(y - half), w, w);
    }
    dist += len;
  }
}
