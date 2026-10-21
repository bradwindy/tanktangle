import { BRICK_HP, MUZZLE, SHIELD_RADIUS, TILE } from '../../shared/constants';
import { wallRect } from '../../shared/grid';
import { Ev } from '../../shared/protocol';
import { CRATE_NAMES } from '../../shared/weapons';
import { Proj, sameTeam, Upgrade, Weapon, type CrateKind, type MazeState } from '../../shared/types';
import type { AnyEvent, ViewState, ViewTank } from '../view';
import type { CrateLayer } from './crates';
import type { Effects } from './effects';
import type { Overlay } from './overlay';
import { BRASS, BRICK, CYAN, DUST, ENERGY, FIRE, KIND_COLOR, mix, SMOKE, SPARK, TOXIC } from './palette';
import { Kind, type Particles, type Ramp } from './particles';
import { weaponVariant } from './sprites';
import type { TankLayer } from './tanks';
import type { World } from './world';

export interface FxContext {
  now: number;
  particles: Particles;
  fx: Effects;
  world: World;
  tanks: TankLayer;
  crates: CrateLayer;
  overlay: Overlay;
  maze: MazeState | null;
  /** 1 near the listener (your tank or the camera centre), falling to 0.25 far away. */
  near(x: number, y: number): number;
  /** Scales shake and flashes down when the player prefers reduced motion. */
  motion: number;
}

export class EventFx {
  private r: Record<string, Ramp>;
  private colorRamps = new Map<string, Ramp>();

  constructor(private particles: Particles) {
    this.r = {
      fire: particles.ramp(FIRE),
      flame: particles.ramp(FIRE.slice(1, 7)),
      spark: particles.ramp(SPARK),
      smoke: particles.ramp(SMOKE),
      soot: particles.ramp(['#5a5a5a', '#404040', '#2a2a2a', '#1c1c1c']),
      dust: particles.ramp(DUST),
      brick: particles.ramp([BRICK.hi, BRICK.light, BRICK.base, BRICK.dark]),
      steel: particles.ramp(['#ffffff', '#e2e2e2', '#ababab']),
      toxic: particles.ramp(TOXIC),
      energy: particles.ramp(ENERGY),
      cyan: particles.ramp(CYAN),
      brass: particles.ramp(BRASS),
      white: particles.ramp(['#ffffff', '#fff7c2', '#ffe14d']),
      heal: particles.ramp(['#ffffff', '#c8ffd0', '#6dff8a', '#239a4a']),
      gold: particles.ramp(['#ffffff', '#fff2a0', '#ffd23d', '#b8861a']),
    };
  }

  private ramp(name: string): Ramp {
    return this.r[name]!;
  }

  /** Brightest to darkest shades of a colour, for sparkles and tank debris. */
  private colorRamp(color: string): Ramp {
    let r = this.colorRamps.get(color);
    if (!r) {
      r = this.particles.ramp(['#ffffff', mix(color, '#ffffff', 0.5), color, mix(color, '#000000', 0.35), mix(color, '#000000', 0.6)]);
      this.colorRamps.set(color, r);
    }
    return r;
  }

  handle(ev: AnyEvent, view: ViewState, c: FxContext): void {
    const p = this.particles;
    const tank = (seat: number): ViewTank | undefined => view.tanks.find((t) => t.seat === seat);
    switch (ev.e) {
      case 'muzzle':
      case Ev.Fire: {
        const t = tank(ev.seat);
        this.fire(ev.weapon, ev.x, ev.y, ev.a, t?.color ?? '#ffffff', c);
        c.tanks.kick(ev.seat, c.now);
        return;
      }
      case 'bounce': {
        const n = ev.kind === Proj.Bullet ? 5 : ev.kind === Proj.Mine ? 0 : 2;
        if (n) p.burst(ev.x, ev.y, n, this.ramp('spark'), 30, 90, 0.08, 0.2, { kind: Kind.Spark, drag: 4 });
        if (ev.kind === Proj.Homing || ev.kind === Proj.Rc || ev.kind === Proj.Frag) p.burst(ev.x, ev.y, 3, this.ramp('dust'), 10, 30, 0.2, 0.4, { kind: Kind.Smoke, grow: 4, drag: 3 });
        return;
      }
      case 'expire': {
        if (ev.kind === Proj.Bullet || ev.kind === Proj.Gatling || ev.kind === Proj.Pellet || ev.kind === Proj.Shrapnel) {
          p.burst(ev.x, ev.y, 2, this.ramp('smoke'), 4, 12, 0.25, 0.45, { kind: Kind.Smoke, size: 1, grow: 4, drag: 2 });
          p.burst(ev.x, ev.y, 2, this.ramp('spark'), 15, 40, 0.06, 0.14, { kind: Kind.Spark });
        }
        return;
      }
      case Ev.Hit: {
        const t = tank(ev.seat);
        const color = t?.color ?? '#ffffff';
        p.burst(ev.x, ev.y, 12, this.ramp('spark'), 40, 130, 0.1, 0.3, { kind: Kind.Spark, drag: 3 });
        p.burst(ev.x, ev.y, 5, this.colorRamp(color), 30, 80, 0.4, 0.8, { kind: Kind.Debris, vz: 70, size: 2, settle: true, drag: 1 });
        p.burst(ev.x, ev.y, 3, this.ramp('smoke'), 5, 20, 0.4, 0.7, { kind: Kind.Smoke, size: 2, grow: 5, drag: 2 });
        c.fx.ring(ev.x, ev.y, 2, 9, 0.18, '#ffffff', 1);
        c.tanks.hit(ev.seat, c.now);
        c.overlay.popup(`-${ev.dmg}`, ev.dmg >= 3 ? '#ffe14d' : '#ff6a5a', ev.x, ev.y - 6, ev.dmg >= 3 ? 16 : 12);
        if (t?.isMe) {
          c.fx.hurt(0.75);
          c.fx.shake(5 * c.motion);
          c.fx.aberrate(1.8 * c.motion);
        } else {
          c.fx.shake(1.5 * c.near(ev.x, ev.y) * c.motion);
        }
        return;
      }
      case Ev.Death: {
        const t = tank(ev.seat);
        const color = t?.color ?? '#ffffff';
        this.tankExplosion(ev.x, ev.y, color, c);
        if (t) c.world.wreck(ev.x, ev.y, t.a, weaponVariant(t.weapon, 0));
        c.tanks.died(ev.seat);
        c.tanks.burn(ev.x, ev.y, 2.5);
        const killer = ev.by >= 0 && !ev.self ? tank(ev.by) : undefined;
        if (killer?.isMe && ev.by !== ev.seat) {
          const teamKill = t !== undefined && sameTeam(killer.team, t.team);
          c.overlay.popup(teamKill ? '-1' : '+1', teamKill ? '#ff4d4d' : '#ffe14d', ev.x, ev.y - 22, 16, 1.2);
        }
        if (ev.self) c.overlay.popup('OOPS!', '#ffe14d', ev.x, ev.y - 14, 12, 1.3);
        if (t?.isMe) {
          c.fx.hurt(1);
          c.fx.flash('#ff2a2a', 0.35 * c.motion);
          c.fx.shake(9 * c.motion);
          c.fx.aberrate(3.5 * c.motion);
        }
        return;
      }
      case Ev.Spawn: {
        const t = tank(ev.seat);
        const color = t?.color ?? '#ffffff';
        c.tanks.spawned(ev.seat, c.now);
        c.fx.column(ev.x, ev.y + 8, mix(color, '#ffffff', 0.3), 0.55, 70, 11);
        c.fx.ring(ev.x, ev.y, 22, 3, 0.35, color, 2);
        c.fx.ring(ev.x, ev.y, 4, 20, 0.45, '#ffffff', 1);
        const ramp = this.colorRamp(color);
        for (let k = 0; k < 18; k++) {
          const a = (k / 18) * Math.PI * 2;
          const d = 18 + Math.random() * 6;
          const life = 0.3 + Math.random() * 0.1;
          p.spawn(ev.x + Math.cos(a) * d, ev.y + Math.sin(a) * d, (-Math.cos(a) * d) / life, (-Math.sin(a) * d) / life, life, ramp, { kind: Kind.Spark });
        }
        return;
      }
      case Ev.Brick: {
        this.brick(ev.wall, ev.hp, c);
        return;
      }
      case Ev.Crate: {
        c.crates.noteSpawn({ id: ev.id, kind: ev.kind, cx: ev.cx, cy: ev.cy }, c.now);
        const x = (ev.cx + 0.5) * TILE;
        const y = (ev.cy + 0.5) * TILE;
        const color = KIND_COLOR[ev.kind] ?? '#ffffff';
        c.fx.column(x, y + 6, color, 0.7, 80, 7);
        c.fx.ring(x, y, 3, 18, 0.5, color, 1);
        p.burst(x, y - 30, 14, this.colorRamp(color), 5, 30, 0.5, 0.9, { kind: Kind.Square, a: Math.PI / 2, spread: 0.6, jitter: 6 });
        return;
      }
      case Ev.Pick: {
        this.pick(ev.id, ev.seat, ev.kind, view, c);
        return;
      }
      case Ev.Boom: {
        this.boom(ev.x, ev.y, ev.r, ev.kind, c);
        return;
      }
      case Ev.Beam: {
        const t = tank(ev.seat);
        this.beam(ev.pts, ev.weapon, t?.color ?? '#ffffff', c);
        return;
      }
      case Ev.Block: {
        const t = tank(ev.seat);
        const cx = t?.x ?? ev.x;
        const cy = t?.y ?? ev.y;
        c.fx.ring(cx, cy, SHIELD_RADIUS, SHIELD_RADIUS + 7, 0.3, '#c8fbff', 1);
        p.burst(ev.x, ev.y, 10, this.ramp('cyan'), 40, 110, 0.12, 0.3, { kind: Kind.Spark, drag: 3 });
        c.fx.shake(1 * c.near(ev.x, ev.y) * c.motion);
        return;
      }
      case Ev.Charge: {
        const t = tank(ev.seat);
        if (!t) return;
        const mx = t.x + Math.cos(t.a) * MUZZLE;
        const my = t.y + Math.sin(t.a) * MUZZLE;
        c.fx.ring(mx, my, 24, 2, 0.4, '#c04dff', 2);
        c.fx.ring(t.x, t.y, 30, 10, 0.6, '#7a2bd6', 1);
        return;
      }
      case Ev.Trigger: {
        const mine = view.projectiles.find((q) => q.id === ev.id);
        if (!mine) return;
        c.fx.ring(mine.x, mine.y, 3, 16, 0.3, '#ff3d3d', 2);
        c.fx.ring(mine.x, mine.y, 3, 22, 0.5, '#ffffff', 1);
        c.overlay.popup('!', '#ff3d3d', mine.x, mine.y - 8, 16, 0.6);
        return;
      }
      case Ev.Storm: {
        c.fx.flash('#a6ff4a', 0.3 * c.motion);
        c.fx.shake(4 * c.motion);
        if (c.maze) {
          const w = c.maze.w * TILE;
          const h = c.maze.h * TILE;
          for (let k = 0; k < 4; k++) {
            const x = k % 2 ? w - 10 : 10;
            const y = k < 2 ? 10 : h - 10;
            const pts = [x, y];
            let px = x;
            let py = y;
            for (let i = 0; i < 6; i++) {
              px += (w / 2 - px) * 0.08 + (Math.random() - 0.5) * 14;
              py += (h / 2 - py) * 0.08 + (Math.random() - 0.5) * 14;
              pts.push(Math.round(px), Math.round(py));
            }
            c.fx.bolt(pts);
          }
        }
        return;
      }
      case Ev.Overtime: {
        c.fx.flash('#ff7a2a', 0.3 * c.motion);
        c.fx.shake(4 * c.motion);
        c.fx.aberrate(2 * c.motion);
        return;
      }
    }
  }

  private fire(weapon: Weapon, x: number, y: number, a: number, color: string, c: FxContext): void {
    const p = this.particles;
    c.fx.muzzle(x, y, a, weapon, color);
    const glow = weapon === Weapon.Laser ? mix(color, '#ffffff', 0.3) : weapon === Weapon.DeathRay ? '#c04dff' : '#ffb03a';
    const size = weapon === Weapon.DeathRay ? 44 : weapon === Weapon.Shotgun ? 26 : weapon === Weapon.Mines ? 0 : 16;
    if (size) c.fx.light(x + Math.cos(a) * 3, y + Math.sin(a) * 3, size, glow, weapon === Weapon.DeathRay ? 0.4 : 0.12);
    const near = c.near(x, y);
    switch (weapon) {
      case Weapon.Gatling: {
        p.burst(x, y, 2, this.ramp('spark'), 40, 90, 0.06, 0.14, { kind: Kind.Spark, a, spread: 0.35 });
        const side = a + Math.PI / 2;
        p.spawn(x - Math.cos(a) * 8, y - Math.sin(a) * 8, Math.cos(side) * (30 + Math.random() * 20), Math.sin(side) * (30 + Math.random() * 20), 0.5, this.ramp('brass'), {
          kind: Kind.Debris,
          vz: 60 + Math.random() * 30,
          size: 1,
          drag: 2,
        });
        return;
      }
      case Weapon.Shotgun:
        p.burst(x, y, 10, this.ramp('spark'), 60, 150, 0.08, 0.2, { kind: Kind.Spark, a, spread: 0.6, drag: 3 });
        p.burst(x, y, 6, this.ramp('smoke'), 10, 40, 0.5, 0.9, { kind: Kind.Smoke, a, spread: 0.6, size: 2, grow: 6, drag: 3 });
        c.fx.shake(2 * near * c.motion);
        return;
      case Weapon.Laser:
        p.burst(x, y, 8, this.ramp('cyan'), 30, 90, 0.1, 0.25, { kind: Kind.Spark, a, spread: 1.2, drag: 3 });
        c.fx.ring(x, y, 2, 10, 0.2, mix(color, '#ffffff', 0.4), 1);
        c.fx.shake(1.5 * near * c.motion);
        return;
      case Weapon.DeathRay:
        p.burst(x, y, 30, this.ramp('energy'), 40, 160, 0.15, 0.5, { kind: Kind.Spark, drag: 2.5 });
        c.fx.ring(x, y, 4, 30, 0.35, '#f07bff', 2);
        c.fx.shake(5 * near * c.motion);
        c.fx.flash('#c04dff', 0.22 * near * c.motion);
        c.fx.aberrate(3 * near * c.motion);
        return;
      case Weapon.Homing:
      case Weapon.Rc: {
        const bx = x - Math.cos(a) * 18;
        const by = y - Math.sin(a) * 18;
        p.burst(bx, by, 8, this.ramp('smoke'), 15, 45, 0.5, 1, { kind: Kind.Smoke, a: a + Math.PI, spread: 0.7, size: 2, grow: 6, drag: 3 });
        p.burst(x, y, 6, this.ramp('flame'), 20, 60, 0.1, 0.25, { a, spread: 0.5, drag: 3 });
        c.fx.shake(1.5 * near * c.motion);
        return;
      }
      case Weapon.Frag:
        p.burst(x, y, 6, this.ramp('smoke'), 10, 35, 0.4, 0.8, { kind: Kind.Smoke, a, spread: 0.8, size: 2, grow: 5, drag: 3 });
        c.fx.ring(x, y, 2, 8, 0.2, '#d4ff9a', 1);
        c.fx.shake(1.2 * near * c.motion);
        return;
      case Weapon.Mines:
        p.burst(x, y, 6, this.ramp('dust'), 10, 30, 0.3, 0.6, { kind: Kind.Smoke, size: 1, grow: 4, drag: 3 });
        return;
      default:
        p.burst(x, y, 3, this.ramp('spark'), 40, 90, 0.06, 0.16, { kind: Kind.Spark, a, spread: 0.5, drag: 3 });
        p.spawn(x, y, Math.cos(a) * 12, Math.sin(a) * 12, 0.35, this.ramp('smoke'), { kind: Kind.Smoke, size: 1, grow: 5, drag: 3 });
    }
  }

  private tankExplosion(x: number, y: number, color: string, c: FxContext): void {
    const p = this.particles;
    c.fx.blast(x, y, 30, 'tank', 0.8);
    c.fx.blast(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 14, 16, 'fire', 0.5, 0.12);
    c.fx.blast(x + (Math.random() - 0.5) * 18, y + (Math.random() - 0.5) * 18, 12, 'fire', 0.45, 0.24);
    c.fx.ring(x, y, 6, 46, 0.45, '#ffffff', 2);
    p.burst(x, y, 44, this.ramp('fire'), 20, 120, 0.3, 0.8, { size: 2, drag: 2.2 });
    p.burst(x, y, 30, this.ramp('spark'), 60, 200, 0.2, 0.6, { kind: Kind.Spark, drag: 2 });
    p.burst(x, y, 20, this.colorRamp(color), 30, 130, 0.6, 1.3, { kind: Kind.Debris, vz: 150, size: 2, settle: true, drag: 0.6 });
    p.burst(x, y, 8, this.ramp('soot'), 40, 110, 0.7, 1.4, { kind: Kind.Debris, vz: 180, size: 3, settle: true, drag: 0.6 });
    p.burst(x, y, 22, this.ramp('soot'), 8, 40, 1, 2, { kind: Kind.Smoke, size: 3, grow: 9, drag: 1.5, jitter: 6 });
    c.world.scorch(x, y, 24);
    c.fx.light(x, y, 54, '#ff9a3d', 0.7);
    const near = c.near(x, y);
    c.fx.shake(7 * near * c.motion);
    c.fx.flash('#fff2d0', 0.22 * near * c.motion);
    c.fx.aberrate(2.5 * near * c.motion);
  }

  private boom(x: number, y: number, r: number, kind: Weapon, c: FxContext): void {
    const p = this.particles;
    const big = r >= 28;
    c.fx.blast(x, y, r, 'fire', 0.45 + r / 90);
    if (big) c.fx.blast(x + (Math.random() - 0.5) * r * 0.5, y + (Math.random() - 0.5) * r * 0.5, r * 0.5, 'fire', 0.4, 0.1);
    c.fx.ring(x, y, r * 0.3, r * 1.25, 0.4, '#fff4c8', 2);
    p.burst(x, y, Math.round(r * 1.3), this.ramp('fire'), r * 0.6, r * 3.5, 0.25, 0.7, { size: 2, drag: 2.5 });
    p.burst(x, y, Math.round(r * 0.9), this.ramp('spark'), r * 2, r * 6, 0.15, 0.45, { kind: Kind.Spark, drag: 2 });
    p.burst(x, y, Math.round(r * 0.6), this.ramp('soot'), 5, r, 0.9, 1.7, { kind: Kind.Smoke, size: 3, grow: 7, drag: 1.5, jitter: r * 0.3 });
    if (kind === Weapon.Mines) p.burst(x, y, 12, this.ramp('dust'), 30, 110, 0.5, 1, { kind: Kind.Debris, vz: 130, size: 2, settle: true, drag: 0.8 });
    c.world.scorch(x, y, r * 0.8);
    c.fx.light(x, y, r * 1.9, '#ff9a3d', 0.5);
    const near = c.near(x, y);
    c.fx.shake((r / 5) * near * c.motion);
    if (big) {
      c.fx.flash('#fff2d0', 0.16 * near * c.motion);
      c.fx.aberrate(2 * near * c.motion);
    }
  }

  private beam(pts: number[], weapon: Weapon, color: string, c: FxContext): void {
    const p = this.particles;
    c.fx.beam(pts, weapon, color);
    const n = pts.length;
    if (n < 4) return;
    const ex = pts[n - 2]!;
    const ey = pts[n - 1]!;
    const near = c.near(ex, ey);
    if (weapon === Weapon.DeathRay) {
      let carry = 0;
      for (let i = 0; i + 3 < n; i += 2) {
        const dx = pts[i + 2]! - pts[i]!;
        const dy = pts[i + 3]! - pts[i + 1]!;
        const len = Math.hypot(dx, dy);
        for (let d = carry; d < len; d += 20) {
          p.burst(pts[i]! + (dx * d) / len, pts[i + 1]! + (dy * d) / len, 2, this.ramp('energy'), 10, 50, 0.5, 1.2, { kind: Kind.Spark, drag: 3 });
        }
        carry = Math.max(0, carry - len);
      }
      c.fx.blast(ex, ey, 18, 'energy', 0.5);
      c.fx.light(ex, ey, 40, '#c04dff', 0.6);
      c.fx.shake(6 * near * c.motion);
      c.fx.flash('#c04dff', 0.2 * c.motion);
      c.fx.aberrate(3.5 * c.motion);
      return;
    }
    const glow = this.colorRamp(color);
    for (let i = 2; i + 1 < n - 2; i += 2) p.burst(pts[i]!, pts[i + 1]!, 6, glow, 30, 90, 0.12, 0.3, { kind: Kind.Spark, drag: 3 });
    p.burst(ex, ey, 14, this.ramp('white'), 40, 140, 0.15, 0.35, { kind: Kind.Spark, drag: 3 });
    c.fx.ring(ex, ey, 2, 12, 0.25, mix(color, '#ffffff', 0.5), 1);
    c.fx.light(ex, ey, 22, mix(color, '#ffffff', 0.3), 0.3);
    c.fx.shake(2 * near * c.motion);
  }

  private brick(wall: number, hp: number, c: FxContext): void {
    const m = c.maze;
    if (!m || wall < 0 || wall >= m.walls.length) return;
    const p = this.particles;
    const r = wallRect(m, wall);
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const horizontal = r.x1 - r.x0 > r.y1 - r.y0;
    const span = (horizontal ? r.x1 - r.x0 : r.y1 - r.y0) / 2 - 3;
    if (hp >= BRICK_HP) {
      p.burst(cx, cy, 10, this.ramp('gold'), 5, 25, 0.4, 0.8, { jitter: span, a: -Math.PI / 2, spread: 0.6 });
      return;
    }
    if (hp === 0) {
      for (let k = 0; k < 26; k++) {
        const u = (Math.random() * 2 - 1) * span;
        p.burst(horizontal ? cx + u : cx, horizontal ? cy : cy + u, 1, this.ramp('brick'), 20, 90, 0.6, 1.2, { kind: Kind.Debris, vz: 110, size: Math.random() < 0.4 ? 2 : 1, settle: true, drag: 0.8 });
      }
      for (let k = 0; k < 12; k++) {
        const u = (Math.random() * 2 - 1) * span;
        p.spawn(horizontal ? cx + u : cx, horizontal ? cy : cy + u, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0.8 + Math.random() * 0.6, this.ramp('dust'), {
          kind: Kind.Smoke,
          size: 3,
          grow: 6,
          drag: 2,
        });
      }
      c.fx.shake(2.5 * c.near(cx, cy) * c.motion);
      return;
    }
    const u = (Math.random() * 2 - 1) * span * 0.8;
    const x = horizontal ? cx + u : cx;
    const y = horizontal ? cy : cy + u;
    p.burst(x, y, 6, this.ramp('brick'), 20, 70, 0.4, 0.8, { kind: Kind.Debris, vz: 80, size: 1, settle: true, drag: 1 });
    p.burst(x, y, 4, this.ramp('dust'), 5, 25, 0.4, 0.8, { kind: Kind.Smoke, size: 2, grow: 5, drag: 2 });
  }

  /** A course of bricks regrowing puffs a little dust. */
  regrowStep(x: number, y: number): void {
    this.particles.burst(x, y, 3, this.ramp('dust'), 5, 20, 0.3, 0.6, { kind: Kind.Smoke, size: 1, grow: 4, drag: 2 });
    this.particles.burst(x, y, 2, this.ramp('gold'), 10, 30, 0.2, 0.4, {});
  }

  private pick(id: number, seat: number, kind: CrateKind, view: ViewState, c: FxContext): void {
    const p = this.particles;
    const crate = c.crates.known.get(id);
    const t = seat >= 0 ? view.tanks.find((q) => q.seat === seat) : undefined;
    const x = crate ? (crate.cx + 0.5) * TILE : (t?.x ?? 0);
    const y = crate ? (crate.cy + 0.5) * TILE : (t?.y ?? 0);
    c.crates.known.delete(id);
    if (seat < 0) {
      p.burst(x, y, 14, this.ramp('toxic'), 10, 60, 0.6, 1.1, { kind: Kind.Smoke, size: 2, grow: 6, drag: 2 });
      p.burst(x, y, 10, this.ramp('toxic'), 30, 90, 0.2, 0.5, { kind: Kind.Spark, drag: 3 });
      return;
    }
    const color = KIND_COLOR[kind] ?? '#ffffff';
    const ramp = this.colorRamp(color);
    p.burst(x, y, 26, ramp, 30, 120, 0.25, 0.6, { kind: Kind.Spark, drag: 3 });
    p.burst(x, y, 8, ramp, 20, 70, 0.5, 0.9, { kind: Kind.Debris, vz: 100, size: 1, drag: 1 });
    c.fx.ring(x, y, 4, 24, 0.35, color, 2);
    const tx = t?.x ?? x;
    const ty = t?.y ?? y;
    if (kind === Upgrade.Repair) p.burst(tx, ty, 14, this.ramp('heal'), 8, 25, 0.6, 1.1, { a: -Math.PI / 2, spread: 0.5, jitter: 9 });
    if (kind === Upgrade.Shield) c.fx.ring(tx, ty, 4, SHIELD_RADIUS + 2, 0.3, '#6ef0ff', 2);
    if (kind === Upgrade.Speed) p.burst(tx, ty, 12, this.ramp('white'), 60, 140, 0.15, 0.3, { kind: Kind.Spark, drag: 2 });
    if (kind === Upgrade.Aimer) c.fx.ring(tx, ty, 20, 6, 0.35, '#ff5a5a', 1);
    const name = CRATE_NAMES[kind]?.toUpperCase() ?? '';
    c.overlay.popup(`${name}!`, color, tx, ty - 30, t?.isMe ? 12 : 10, t?.isMe ? 1.4 : 1.1);
    if (t?.isMe) c.fx.flash(color, 0.12 * c.motion);
  }
}

