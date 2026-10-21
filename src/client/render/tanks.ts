import { MAX_SEATS, MUZZLE, SHIELD_RADIUS } from '../../shared/constants';
import { DEATH_RAY, SHIELD_WARN_TICKS } from '../../shared/weapons';
import { TankFlag, Weapon } from '../../shared/types';
import type { ViewTank } from '../view';
import type { Effects } from './effects';
import { DARK_SMOKE, ENERGY, FIRE, GUNMETAL, mix, SMOKE, SPARK } from './palette';
import { Kind, type Particles, type Ramp } from './particles';
import { checker, circlePath, ringPath } from './raster';
import { CELL, HALF_CELL, rotationIndex, weaponVariant, type SpriteBank } from './sprites';
import type { World } from './world';

const GHOSTS = 5;
const RIM = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
const GHOST_EVERY = 0.045;

interface TankVis {
  seen: boolean;
  x: number;
  y: number;
  a: number;
  tread: number;
  treadDist: number;
  ghosts: Float32Array;
  ghostCount: number;
  ghostHead: number;
  ghostClock: number;
  hitAt: number;
  kickAt: number;
  spawnAt: number;
  smokeClock: number;
  sparkClock: number;
  spin: number;
  chargeClock: number;
}

const newVis = (): TankVis => ({
  seen: false,
  x: 0,
  y: 0,
  a: 0,
  tread: 0,
  treadDist: 0,
  ghosts: new Float32Array(GHOSTS * 3),
  ghostCount: 0,
  ghostHead: 0,
  ghostClock: 0,
  hitAt: -10,
  kickAt: -10,
  spawnAt: -10,
  smokeClock: 0,
  sparkClock: 0,
  spin: 0,
  chargeClock: 0,
});

interface Burner {
  x: number;
  y: number;
  left: number;
  clock: number;
}

export class TankLayer {
  private vis: TankVis[] = Array.from({ length: MAX_SEATS }, newVis);
  private burners: Burner[] = [];
  private smoke: Ramp;
  private darkSmoke: Ramp;
  private sparks: Ramp;
  private fire: Ramp;
  private energy: Ramp;
  private steam: Ramp;

  constructor(
    private sprites: SpriteBank,
    private world: World,
    private particles: Particles,
    private fx: Effects,
  ) {
    this.smoke = particles.ramp(SMOKE);
    this.darkSmoke = particles.ramp(DARK_SMOKE);
    this.sparks = particles.ramp(SPARK);
    this.fire = particles.ramp(FIRE.slice(1, 7));
    this.energy = particles.ramp(ENERGY);
    this.steam = particles.ramp(['#eeeeee', '#c0c0c0', '#939393']);
  }

  reset(): void {
    this.vis = Array.from({ length: MAX_SEATS }, newVis);
    this.burners.length = 0;
  }

  /** A wreck that keeps burning for a while after the explosion. */
  burn(x: number, y: number, seconds: number): void {
    if (this.burners.length > 16) this.burners.shift();
    this.burners.push({ x, y, left: seconds, clock: 0 });
  }

  private updateBurners(dt: number): void {
    let w = 0;
    for (const b of this.burners) {
      b.left -= dt;
      b.clock += dt * (10 + b.left * 14);
      while (b.clock >= 1) {
        b.clock -= 1;
        const x = b.x + (Math.random() - 0.5) * 12;
        const y = b.y + (Math.random() - 0.5) * 10;
        if (Math.random() < 0.55) this.particles.spawn(x, y, (Math.random() - 0.5) * 6, -14 - Math.random() * 14, 0.25 + Math.random() * 0.25, this.fire, { size: 1 + Math.round(Math.random()), drag: 1 });
        else this.particles.spawn(x, y, (Math.random() - 0.5) * 6, -12 - Math.random() * 8, 0.8 + Math.random() * 0.6, this.darkSmoke, { kind: Kind.Smoke, size: 2, grow: 5, drag: 1.2 });
      }
      if (b.left > 0) this.burners[w++] = b;
    }
    this.burners.length = w;
  }

  private get(seat: number): TankVis | null {
    return seat >= 0 && seat < MAX_SEATS ? this.vis[seat]! : null;
  }

  hit(seat: number, now: number): void {
    const v = this.get(seat);
    if (v) v.hitAt = now;
  }

  kick(seat: number, now: number): void {
    const v = this.get(seat);
    if (v) v.kickAt = now;
  }

  spawned(seat: number, at: number): void {
    const v = this.get(seat);
    if (!v) return;
    v.spawnAt = at;
    v.seen = false;
  }

  died(seat: number): void {
    const v = this.get(seat);
    if (v) v.seen = false;
  }

  update(tanks: readonly ViewTank[], tick: number, dt: number): void {
    this.updateBurners(dt);
    for (const t of tanks) {
      const v = this.get(t.seat);
      if (!v) continue;
      if (!(t.flags & TankFlag.Alive) || !t.alive) {
        v.seen = false;
        continue;
      }
      if (!v.seen) {
        v.seen = true;
        v.x = t.x;
        v.y = t.y;
        v.a = t.a;
        v.ghostCount = 0;
      }
      const dx = t.x - v.x;
      const dy = t.y - v.y;
      const dist = Math.hypot(dx, dy);
      let da = t.a - v.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (dist < 24) {
        const forward = dx * Math.cos(t.a) + dy * Math.sin(t.a);
        v.tread += forward + Math.abs(da) * 6;
        v.treadDist += dist;
        if (v.treadDist >= 2) {
          v.treadDist = 0;
          this.world.tread(t.x, t.y, t.a);
        }
      }
      v.x = t.x;
      v.y = t.y;
      v.a = t.a;
      if (t.flags & TankFlag.Speed) {
        v.ghostClock += dt;
        if (v.ghostClock >= GHOST_EVERY) {
          v.ghostClock = 0;
          const i = v.ghostHead * 3;
          v.ghosts[i] = t.x;
          v.ghosts[i + 1] = t.y;
          v.ghosts[i + 2] = t.a;
          v.ghostHead = (v.ghostHead + 1) % GHOSTS;
          v.ghostCount = Math.min(GHOSTS, v.ghostCount + 1);
        }
      } else {
        v.ghostCount = 0;
      }
      if (t.flags & TankFlag.Spinning) v.spin += dt * 26;
      this.emitDamage(t, v, dt);
      if (t.flags & TankFlag.Charging) this.emitCharge(t, v, tick, dt);
      if (t.flags & TankFlag.Recoil && Math.random() < dt * 30) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const c = Math.cos(t.a);
        const s = Math.sin(t.a);
        this.particles.spawn(t.x - s * 7 * side, t.y + c * 7 * side, -s * 24 * side, c * 24 * side, 0.35, this.steam, {
          kind: Kind.Smoke,
          size: 1,
          grow: 6,
          drag: 3,
        });
      }
    }
  }

  private emitDamage(t: ViewTank, v: TankVis, dt: number): void {
    if (t.hp >= 3) return;
    const c = Math.cos(t.a);
    const s = Math.sin(t.a);
    const rx = t.x - c * 7;
    const ry = t.y - s * 7;
    const critical = t.hp <= 1;
    v.smokeClock += dt;
    const every = critical ? 0.07 : 0.16;
    while (v.smokeClock >= every) {
      v.smokeClock -= every;
      const ramp = critical ? this.darkSmoke : this.smoke;
      this.particles.spawn(rx + (Math.random() - 0.5) * 3, ry + (Math.random() - 0.5) * 3, -c * 10 + (Math.random() - 0.5) * 8, -s * 10 - 16 - Math.random() * 10, 0.6 + Math.random() * 0.4, ramp, {
        kind: Kind.Smoke,
        size: 1,
        grow: critical ? 4.5 : 3.5,
        drag: 1.2,
      });
    }
    if (critical) {
      v.sparkClock += dt;
      if (v.sparkClock > 0.22) {
        v.sparkClock = Math.random() * 0.12;
        this.particles.burst(rx, ry, 3, this.sparks, 30, 70, 0.15, 0.35, { kind: Kind.Spark, drag: 3 });
        if (Math.random() < 0.6) this.particles.spawn(rx, ry, 0, -10, 0.25, this.fire, { size: 2, drag: 2 });
      }
    }
  }

  private emitCharge(t: ViewTank, v: TankVis, tick: number, dt: number): void {
    const progress = Math.min(1, Math.max(0, 1 - (t.chargeUntil - tick) / DEATH_RAY.chargeTicks));
    const mx = t.x + Math.cos(t.a) * MUZZLE;
    const my = t.y + Math.sin(t.a) * MUZZLE;
    this.fx.charge(mx, my, progress);
    v.chargeClock += dt * (20 + progress * 70);
    while (v.chargeClock >= 1) {
      v.chargeClock -= 1;
      const ang = Math.random() * Math.PI * 2;
      const d = 12 + Math.random() * 10;
      const life = 0.22 + Math.random() * 0.1;
      this.particles.spawn(mx + Math.cos(ang) * d, my + Math.sin(ang) * d, (-Math.cos(ang) * d) / life, (-Math.sin(ang) * d) / life, life, this.energy, {
        kind: Kind.Spark,
      });
    }
    if (progress > 0.6) this.fx.shake(0.4 + progress * 0.6);
  }

  /** spawnFlash (0 to 1) flashes your tank white while the spawn cue shows. */
  draw(ctx: CanvasRenderingContext2D, tanks: readonly ViewTank[], tick: number, now: number, spawnFlash = 0): void {
    const shadows = this.sprites.shadows();
    const weapons = this.sprites.weapons();
    ctx.globalAlpha = 0.42;
    for (const t of tanks) {
      if (!t.alive) continue;
      const v = this.get(t.seat);
      const rot = rotationIndex(t.a);
      const variant = weaponVariant(t.weapon, v ? Math.floor(v.spin) : 0);
      ctx.drawImage(shadows, rot * CELL, variant * CELL, CELL, CELL, Math.round(t.x) - HALF_CELL + 1, Math.round(t.y) - HALF_CELL + 2, CELL, CELL);
    }
    ctx.globalAlpha = 1;
    for (const t of tanks) {
      if (!t.alive) continue;
      const v = this.get(t.seat);
      if (!v) continue;
      this.drawTank(ctx, t, v, tick, now, weapons, t.isMe ? spawnFlash : 0);
    }
  }

  private drawTank(
    ctx: CanvasRenderingContext2D,
    t: ViewTank,
    v: TankVis,
    tick: number,
    now: number,
    weapons: HTMLCanvasElement,
    spawnFlash: number,
  ): void {
    const rot = rotationIndex(t.a);
    const c = Math.cos(t.a);
    const s = Math.sin(t.a);
    const kick = Math.max(0, 1 - (now - v.kickAt) / 0.09) * (t.weapon === Weapon.Shotgun ? 2.5 : 1.5);
    const jitter = t.flags & TankFlag.Recoil ? (Math.floor(now * 40) % 2) - 0.5 : 0;
    const x = Math.round(t.x - c * kick + jitter);
    const y = Math.round(t.y - s * kick);
    const dx = x - HALF_CELL;
    const dy = y - HALF_CELL;
    if (t.isMe) {
      ctx.fillStyle = checker(ctx, t.color, 0);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ringPath(ctx, x, y, 15 + (Math.sin(now * 5) > 0 ? 1 : 0), 1);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (v.ghostCount > 0) {
      const ghost = this.sprites.ghost(mix(t.color, '#ffffff', 0.35));
      const ghostVariant = weaponVariant(t.weapon, 0);
      for (let k = 0; k < v.ghostCount; k++) {
        const i = ((v.ghostHead - 1 - k + GHOSTS * 2) % GHOSTS) * 3;
        ctx.globalAlpha = 0.32 * (1 - k / GHOSTS);
        const gr = rotationIndex(v.ghosts[i + 2]!);
        ctx.drawImage(ghost, gr * CELL, ghostVariant * CELL, CELL, CELL, Math.round(v.ghosts[i]!) - HALF_CELL, Math.round(v.ghosts[i + 1]!) - HALF_CELL, CELL, CELL);
      }
      ctx.globalAlpha = 1;
    }
    const spawnT = (now - v.spawnAt) / 0.4;
    const warping = spawnT >= 0 && spawnT < 1;
    const variant = weaponVariant(t.weapon, Math.floor(v.spin));
    const cueing = spawnFlash > 0 && !warping;
    if (cueing) this.drawSpawnOutline(ctx, rot, variant, dx, dy, spawnFlash);
    const protect = (t.flags & TankFlag.Protect) !== 0;
    if (protect && !cueing && Math.floor(now * 12) % 2 === 0) ctx.globalAlpha = 0.45;
    if (warping) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, CELL, Math.round(CELL * spawnT));
      ctx.clip();
    }
    const flashing = now - v.hitAt < 0.1;
    const frame = ((Math.floor(-v.tread / 1.5) % 3) + 3) % 3;
    if (flashing) {
      const white = this.sprites.white();
      ctx.drawImage(white, rot * CELL, 0, CELL, CELL, dx, dy, CELL, CELL);
      ctx.drawImage(weapons, rot * CELL, variant * CELL, CELL, CELL, dx, dy, CELL, CELL);
      ctx.drawImage(white, rot * CELL, CELL, CELL, CELL, dx, dy, CELL, CELL);
    } else {
      const body = this.sprites.body(t.color);
      ctx.drawImage(body, rot * CELL, frame * CELL, CELL, CELL, dx, dy, CELL, CELL);
      ctx.drawImage(weapons, rot * CELL, variant * CELL, CELL, CELL, dx, dy, CELL, CELL);
      ctx.drawImage(body, rot * CELL, 3 * CELL, CELL, CELL, dx, dy, CELL, CELL);
    }
    if (warping) {
      ctx.restore();
      ctx.globalAlpha = (1 - spawnT) * 0.9;
      ctx.drawImage(this.sprites.ghost('#ffffff'), rot * CELL, variant * CELL, CELL, CELL, dx, dy, CELL, CELL);
    }
    if (cueing && Math.floor(now * 8) % 2 === 0) {
      ctx.globalAlpha = 0.85 * spawnFlash;
      ctx.drawImage(this.sprites.ghost('#ffffff'), rot * CELL, variant * CELL, CELL, CELL, dx, dy, CELL, CELL);
    }
    ctx.globalAlpha = 1;
    if (t.flags & TankFlag.RcControl) this.drawAntenna(ctx, x, y, c, s, now);
    if (t.flags & TankFlag.Aimer) {
      ctx.fillStyle = Math.floor(now * 6) % 2 ? '#ff5a5a' : '#ffffff';
      ctx.fillRect(Math.round(x + c * (MUZZLE + 1)), Math.round(y + s * (MUZZLE + 1)), 1, 1);
    }
    if (protect) this.drawProtect(ctx, x, y, t.color, now);
    if (t.flags & TankFlag.Shield) this.drawShield(ctx, x, y, t, tick, now);
  }

  /** A white rim one pixel outside the tank, alternating with a white silhouette drawn over it. */
  private drawSpawnOutline(ctx: CanvasRenderingContext2D, rot: number, variant: number, dx: number, dy: number, strength: number): void {
    const white = this.sprites.ghost('#ffffff');
    ctx.globalAlpha = strength;
    for (const [ox, oy] of RIM) ctx.drawImage(white, rot * CELL, variant * CELL, CELL, CELL, dx + ox, dy + oy, CELL, CELL);
    ctx.globalAlpha = 1;
  }

  private drawAntenna(ctx: CanvasRenderingContext2D, x: number, y: number, c: number, s: number, now: number): void {
    ctx.fillStyle = GUNMETAL.light;
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const along = -3 - k;
      const side = -2 - k * 0.6;
      ctx.rect(Math.round(x + c * along - s * side), Math.round(y + s * along + c * side), 1, 1);
    }
    ctx.fill();
    const tipX = Math.round(x + c * -8 - s * -5);
    const tipY = Math.round(y + s * -8 + c * -5);
    ctx.fillStyle = Math.floor(now * 5) % 2 ? '#ff4d5e' : '#7dff6a';
    ctx.fillRect(tipX - 1, tipY - 1, 2, 2);
    if (Math.floor(now * 2.5) % 2 === 0) {
      ctx.fillStyle = checker(ctx, '#7dff6a', 0);
      ctx.beginPath();
      ringPath(ctx, tipX, tipY, 3 + ((now * 8) % 3), 1);
      ctx.fill();
    }
  }

  private drawProtect(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, now: number): void {
    ctx.fillStyle = mix(color, '#ffffff', 0.6);
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = now * 4 + (k * Math.PI * 2) / 3;
      ctx.rect(Math.round(x + Math.cos(a) * 13), Math.round(y + Math.sin(a) * 13), 1, 1);
    }
    ctx.fill();
  }

  private drawShield(ctx: CanvasRenderingContext2D, x: number, y: number, t: ViewTank, tick: number, now: number): void {
    const left = t.shieldUntil - tick;
    if (left < SHIELD_WARN_TICKS && Math.floor(now * 8) % 2 === 0) return;
    const r = SHIELD_RADIUS + (Math.sin(now * 6) > 0.6 ? 1 : 0);
    const phase = Math.floor(now * 14) & 1;
    ctx.fillStyle = checker(ctx, '#2ab8e8', phase);
    ctx.beginPath();
    circlePath(ctx, x, y, r - 1);
    ctx.globalAlpha = 0.28;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#6ef0ff';
    ctx.beginPath();
    ringPath(ctx, x, y, r, 1);
    ctx.fill();
    // Two bright arcs sweep around the bubble.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let k = 0; k < 2; k++) {
      const base = now * 2.6 + k * Math.PI;
      for (let j = 0; j < 4; j++) {
        const a = base + j * 0.12;
        ctx.rect(Math.round(x + Math.cos(a) * (r - 0.5) - 0.5), Math.round(y + Math.sin(a) * (r - 0.5) - 0.5), 1, 1);
      }
    }
    ctx.fill();
    ctx.fillStyle = '#c8fbff';
    ctx.fillRect(x - 6, y - 10, 2, 1);
    ctx.fillRect(x - 8, y - 8, 1, 2);
  }
}
