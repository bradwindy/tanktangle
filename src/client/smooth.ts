import { DT } from '../shared/constants';
import { clearLine } from '../shared/sim';
import { Proj, type ProjState, type TankState } from '../shared/types';
import { wrapAngle, type Point } from '../shared/vec';
import type { Pose, Prediction } from './predict';

/** Corrections bigger than this are teleports (respawns, big mispredictions): snap instead of sliding. */
const SNAP_PX = 32;
/** Visual offsets fade at this rate per second. */
const DECAY = 15;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Render positions: the sim state interpolated between the last two ticks, plus a per-entity visual offset that
 * absorbs the jump when a snapshot corrects the prediction and then fades away.
 */
export class Smoother {
  private tankOff = new Map<number, Pose>();
  private projOff = new Map<number, Point>();
  private beforeTanks = new Map<number, Pose>();
  private beforeProjs = new Map<number, Point>();
  private snapped = new Set<number>();
  private scratch: Pose = { x: 0, y: 0, a: 0 };

  clear(): void {
    this.tankOff.clear();
    this.projOff.clear();
    this.snapped.clear();
  }

  /** The tank just spawned: show it exactly where it is, now and after the next rebase. */
  snapTank(seat: number): void {
    this.tankOff.delete(seat);
    this.snapped.add(seat);
  }

  decay(dt: number): void {
    const f = Math.exp(-DECAY * dt);
    for (const o of this.tankOff.values()) {
      o.x *= f;
      o.y *= f;
      o.a *= f;
    }
    for (const o of this.projOff.values()) {
      o.x *= f;
      o.y *= f;
    }
  }

  tankPose(pred: Prediction, t: TankState, alpha: number, out: Pose): Pose {
    const prev = pred.prevTanks.get(t.seat);
    if (prev && Math.abs(t.x - prev.x) + Math.abs(t.y - prev.y) < SNAP_PX) {
      out.x = lerp(prev.x, t.x, alpha);
      out.y = lerp(prev.y, t.y, alpha);
      out.a = wrapAngle(prev.a + wrapAngle(t.a - prev.a) * alpha);
    } else {
      out.x = t.x;
      out.y = t.y;
      out.a = t.a;
    }
    const off = this.tankOff.get(t.seat);
    if (off) {
      out.x += off.x;
      out.y += off.y;
      out.a = wrapAngle(out.a + off.a);
    }
    return out;
  }

  projPos(pred: Prediction, p: ProjState, alpha: number, out: Point): Point {
    const prev = pred.prevProjs.get(p.id);
    if (prev && Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) < SNAP_PX) {
      out.x = lerp(prev.x, p.x, alpha);
      out.y = lerp(prev.y, p.y, alpha);
    } else {
      out.x = p.x;
      out.y = p.y;
    }
    const off = this.projOff.get(p.id);
    if (off) {
      out.x += off.x;
      out.y += off.y;
    }
    return out;
  }

  /** Call just before a snapshot rebase, with the alpha this frame will be drawn at. */
  capture(pred: Prediction, alpha: number): void {
    this.beforeTanks.clear();
    this.beforeProjs.clear();
    for (const t of pred.tanks) if (t.alive) this.beforeTanks.set(t.seat, { ...this.tankPose(pred, t, alpha, this.scratch) });
    for (const p of pred.projs) if (!pred.hidden.has(p.id)) this.beforeProjs.set(p.id, { ...this.projPos(pred, p, alpha, this.scratch) });
  }

  /** Call just after the rebase: whatever moved becomes an offset that fades out. */
  rebase(pred: Prediction, alpha: number): void {
    this.tankOff.clear();
    this.projOff.clear();
    for (const t of pred.tanks) {
      const before = this.beforeTanks.get(t.seat);
      if (!before || !t.alive || this.snapped.has(t.seat)) continue;
      const now = this.tankPose(pred, t, alpha, this.scratch);
      const off = { x: before.x - now.x, y: before.y - now.y, a: wrapAngle(before.a - now.a) };
      if (Math.hypot(off.x, off.y) <= SNAP_PX) this.tankOff.set(t.seat, off);
    }
    for (const p of pred.projs) {
      const now = this.projPos(pred, p, alpha, this.scratch);
      const before = this.beforeProjs.get(p.id) ?? this.launchPoint(pred, p);
      if (!before) continue;
      const off = { x: before.x - now.x, y: before.y - now.y };
      if (Math.hypot(off.x, off.y) <= SNAP_PX) this.projOff.set(p.id, off);
    }
    this.snapped.clear();
  }

  /**
   * A projectile seen for the first time is already some way from where it was fired (its age plus the client's lead).
   * Starting it from its launch point makes it leave the muzzle instead of popping up ahead of it.
   */
  private launchPoint(pred: Prediction, p: ProjState): Point | null {
    if (p.kind === Proj.Mine) return null;
    const back = (pred.tick - p.bornAt) * DT;
    const x = p.x - p.vx * back;
    const y = p.y - p.vy * back;
    return clearLine(pred.maze, x, y, p.x, p.y) ? { x, y } : null;
  }
}
