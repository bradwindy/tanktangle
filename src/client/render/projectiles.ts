import { MINES } from '../../shared/weapons';
import { Proj, sameTeam } from '../../shared/types';
import type { ViewProj } from '../view';
import { FIRE, GUNMETAL, INK, mix, SMOKE, tankRamp } from './palette';
import { Kind, type Particles, type Ramp } from './particles';
import { checker, circlePath, ringPath } from './raster';
import { ROCKET_ROTATIONS, ROCKET_SIZE, rotationIndex, type SpriteBank } from './sprites';

const TRAIL = 8;

interface Trail {
  id: number;
  pts: Float32Array;
  head: number;
  count: number;
  frame: number;
  smokeClock: number;
}

interface TrailColors {
  head: string;
  ramp: string[];
}

/** Projectiles: glowing heads, position-history trails (so they bend around bounces), rocket smoke. */
export class ProjectileLayer {
  private trails = new Map<number, Trail>();
  private pool: Trail[] = [];
  private frame = 0;
  private colorCache = new Map<string, TrailColors>();
  private smoke: Ramp;
  private flame: Ramp;

  constructor(
    private sprites: SpriteBank,
    private particles: Particles,
  ) {
    this.smoke = particles.ramp(SMOKE.slice(0, 4));
    this.flame = particles.ramp(FIRE.slice(1, 6));
  }

  reset(): void {
    for (const t of this.trails.values()) this.pool.push(t);
    this.trails.clear();
  }

  private colors(color: string): TrailColors {
    let c = this.colorCache.get(color);
    if (!c) {
      const r = tankRamp(color);
      c = { head: mix(color, '#ffffff', 0.55), ramp: [r.hi, r.light, r.light, r.base, r.dark, r.shadow] };
      this.colorCache.set(color, c);
    }
    return c;
  }

  update(projs: readonly ViewProj[], dt: number): void {
    this.frame++;
    for (const p of projs) {
      if (p.hidden) continue;
      let t = this.trails.get(p.id);
      if (!t) {
        t = this.pool.pop() ?? { id: 0, pts: new Float32Array(TRAIL * 2), head: 0, count: 0, frame: 0, smokeClock: 0 };
        t.id = p.id;
        t.head = 0;
        t.count = 0;
        t.smokeClock = 0;
        this.trails.set(p.id, t);
      }
      t.frame = this.frame;
      const last = ((t.head - 1 + TRAIL) % TRAIL) * 2;
      if (t.count === 0 || Math.abs(t.pts[last]! - p.x) + Math.abs(t.pts[last + 1]! - p.y) >= 1) {
        t.pts[t.head * 2] = p.x;
        t.pts[t.head * 2 + 1] = p.y;
        t.head = (t.head + 1) % TRAIL;
        t.count = Math.min(TRAIL, t.count + 1);
      }
      if (p.kind === Proj.Homing || p.kind === Proj.Rc) {
        t.smokeClock += dt;
        while (t.smokeClock > 0.022) {
          t.smokeClock -= 0.022;
          const sp = Math.hypot(p.vx, p.vy) || 1;
          const bx = p.x - (p.vx / sp) * 5;
          const by = p.y - (p.vy / sp) * 5;
          this.particles.spawn(bx + (Math.random() - 0.5) * 2, by + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 0.55 + Math.random() * 0.35, this.smoke, {
            kind: Kind.Smoke,
            size: 1,
            grow: 5,
            drag: 2,
          });
          if (Math.random() < 0.5) this.particles.spawn(bx, by, (-p.vx / sp) * 20, (-p.vy / sp) * 20, 0.08, this.flame, { size: 1 });
        }
      }
    }
    for (const [id, t] of this.trails) {
      if (t.frame !== this.frame) {
        this.trails.delete(id);
        this.pool.push(t);
      }
    }
  }

  /** Mines sit on the floor under the tanks. */
  drawMines(ctx: CanvasRenderingContext2D, projs: readonly ViewProj[], me: number, myTeam: number, tick: number, now: number): void {
    for (const p of projs) if (!p.hidden && p.kind === Proj.Mine) this.drawMine(ctx, p, me, myTeam, tick, now);
  }

  drawFlying(ctx: CanvasRenderingContext2D, projs: readonly ViewProj[], tick: number, now: number): void {
    for (const p of projs) {
      if (p.hidden || p.kind === Proj.Mine) continue;
      const t = this.trails.get(p.id);
      if (t && t.count > 1) this.drawTrail(ctx, p, t);
    }
    for (const p of projs) {
      if (p.hidden || p.kind === Proj.Mine) continue;
      this.drawHead(ctx, p, tick, now);
    }
  }

  private drawTrail(ctx: CanvasRenderingContext2D, p: ViewProj, t: Trail): void {
    const len = p.kind === Proj.Bullet ? 7 : p.kind === Proj.Gatling ? 4 : p.kind === Proj.Pellet ? 3 : p.kind === Proj.Shrapnel ? 3 : 0;
    if (len === 0) return;
    const colors =
      p.kind === Proj.Bullet
        ? this.colors(p.color).ramp
        : p.kind === Proj.Shrapnel
          ? ['#ffb03a', '#ff7a2a', '#c42a1f']
          : ['#fff4a8', '#ffd23d', '#ff9a2a', '#c45a1a'];
    let px = p.x;
    let py = p.y;
    const n = Math.min(len, t.count);
    for (let k = 0; k < n; k++) {
      const i = ((t.head - 1 - k + TRAIL * 2) % TRAIL) * 2;
      const x = t.pts[i]!;
      const y = t.pts[i + 1]!;
      const color = colors[Math.min(colors.length - 1, Math.floor((k / n) * colors.length))]!;
      ctx.fillStyle = k > n * 0.6 ? checker(ctx, color, k & 1) : color;
      ctx.beginPath();
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x - px), Math.abs(y - py))));
      for (let s = 1; s <= steps; s++) {
        ctx.rect(Math.round(px + ((x - px) * s) / steps), Math.round(py + ((y - py) * s) / steps), 1, 1);
      }
      ctx.fill();
      px = x;
      py = y;
    }
  }

  private drawHead(ctx: CanvasRenderingContext2D, p: ViewProj, tick: number, now: number): void {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    switch (p.kind) {
      case Proj.Bullet: {
        const c = this.colors(p.color);
        ctx.fillStyle = p.color;
        ctx.fillRect(x - 2, y - 1, 4, 2);
        ctx.fillRect(x - 1, y - 2, 2, 4);
        ctx.fillStyle = c.head;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 1, y - 1, 1, 1);
        return;
      }
      case Proj.Gatling:
        ctx.fillStyle = '#ffd23d';
        ctx.fillRect(x - 1, y - 1, 2, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 1, y - 1, 1, 1);
        return;
      case Proj.Pellet:
        ctx.fillStyle = '#ff9a2a';
        ctx.fillRect(x - 1, y - 1, 2, 2);
        ctx.fillStyle = '#fff7c2';
        ctx.fillRect(x, y - 1, 1, 1);
        return;
      case Proj.Shrapnel:
        ctx.fillStyle = Math.floor(now * 30 + p.id) % 2 ? '#ffe14d' : '#ff7a2a';
        ctx.fillRect(x - 1, y - 1, 2, 2);
        return;
      case Proj.Homing:
      case Proj.Rc: {
        const atlas = this.sprites.rockets(p.color);
        const a = Math.atan2(p.vy, p.vx);
        const rot = rotationIndex(a, ROCKET_ROTATIONS);
        const row = p.kind === Proj.Rc ? 1 : 0;
        const half = ROCKET_SIZE / 2;
        ctx.drawImage(atlas, rot * ROCKET_SIZE, row * ROCKET_SIZE, ROCKET_SIZE, ROCKET_SIZE, x - half, y - half, ROCKET_SIZE, ROCKET_SIZE);
        const c = Math.cos(a);
        const s = Math.sin(a);
        ctx.fillStyle = Math.random() < 0.5 ? '#fff3a0' : '#ffb03a';
        ctx.fillRect(Math.round(p.x - c * 5) - 1, Math.round(p.y - s * 5) - 1, 2, 2);
        const blinkOn = p.kind === Proj.Rc ? Math.floor(now * 6) % 2 === 0 : p.aux === 1 && Math.floor(now * 10) % 2 === 0;
        if (blinkOn) {
          ctx.fillStyle = p.kind === Proj.Rc ? '#7dff6a' : '#ff3d3d';
          ctx.fillRect(Math.round(p.x + c * 3), Math.round(p.y + s * 3) - 1, 1, 1);
        }
        return;
      }
      case Proj.Frag: {
        const left = Math.max(0, (p.fuseAt || p.dieAt) - tick);
        const rate = left < 60 ? 14 : left < 150 ? 7 : 3.5;
        const blink = Math.floor(now * rate) % 2 === 0;
        const r = blink ? 3.5 : 3;
        ctx.fillStyle = INK;
        ctx.beginPath();
        circlePath(ctx, x, y, r + 1);
        ctx.fill();
        ctx.fillStyle = '#4f6a2a';
        ctx.beginPath();
        circlePath(ctx, x, y, r);
        ctx.fill();
        ctx.fillStyle = p.color;
        ctx.fillRect(x - 3, y, 7, 1);
        ctx.fillStyle = '#9fd45a';
        ctx.fillRect(x - 2, y - 2, 2, 1);
        ctx.fillStyle = blink ? '#ff3d3d' : '#5a1a1c';
        ctx.fillRect(x, y - 4, 1, 1);
        if (blink) {
          ctx.fillStyle = '#ffd6d6';
          ctx.fillRect(x, y - 5, 1, 1);
        }
        return;
      }
    }
  }

  private drawMine(ctx: CanvasRenderingContext2D, p: ViewProj, me: number, myTeam: number, tick: number, now: number): void {
    const friendly = p.owner === me || (me >= 0 && sameTeam(p.team, myTeam));
    const triggered = p.aux === 2;
    const phase = (p.id * 0.37) % 2;
    if (!friendly && !triggered) {
      const t = (now + phase) % 2;
      if (t > 0.18) return;
      ctx.globalAlpha = 0.28;
    }
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    ctx.fillStyle = INK;
    ctx.beginPath();
    circlePath(ctx, x, y, 4.5);
    ctx.rect(x - 1, y - 6, 2, 12);
    ctx.rect(x - 6, y - 1, 12, 2);
    ctx.fill();
    ctx.fillStyle = GUNMETAL.dark;
    ctx.beginPath();
    circlePath(ctx, x, y, 3.5);
    ctx.fill();
    ctx.fillStyle = GUNMETAL.mid;
    ctx.fillRect(x - 1, y - 5, 2, 2);
    ctx.fillRect(x - 1, y + 3, 2, 2);
    ctx.fillRect(x - 5, y - 1, 2, 2);
    ctx.fillRect(x + 3, y - 1, 2, 2);
    ctx.fillRect(x - 3, y - 3, 2, 1);
    let light: string;
    if (triggered) {
      light = Math.floor(now * 14) % 2 ? '#ff2a2a' : '#ffffff';
    } else if (p.aux === 1) {
      const armedAt = p.bornAt + MINES.armTicks;
      const pulse = (tick - armedAt) % 60 < 8;
      light = pulse ? mix(p.color, '#ffffff', 0.5) : tankRamp(p.color).base;
    } else {
      light = '#575757';
    }
    ctx.fillStyle = light;
    ctx.fillRect(x - 1, y - 1, 2, 2);
    ctx.globalAlpha = 1;
    if (triggered) {
      ctx.fillStyle = checker(ctx, '#ff3d3d', Math.floor(now * 20) & 1);
      ctx.beginPath();
      ringPath(ctx, x, y, MINES.triggerRadius + 2 + ((now * 30) % 6), 1);
      ctx.fill();
    }
  }
}
