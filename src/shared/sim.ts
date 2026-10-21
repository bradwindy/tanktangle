import {
  DT,
  MUZZLE,
  SHIELD_RADIUS,
  STORM_CLOSE_TICKS,
  STORM_MIN_FRACTION,
  TANK_HALF_L,
  TANK_HALF_W,
  TANK_RADIUS,
  TANK_REVERSE,
  TANK_SPEED,
  TANK_TURN,
  TILE,
  WALL,
} from './constants';
import { hWall, isSolid, vWall } from './grid';
import { bfs } from './maze';
import { Input, Proj, WallKind, type MazeState, type ProjState, type Rect, type TankState } from './types';
import { DEATH_RAY, HOMING, MINES, PROJ_STATS, RC, SPEED_BOOST } from './weapons';
import { clamp, steerAngle, turnToward, wrapAngle, type Point } from './vec';

export { wrapAngle } from './vec';

const HL = TANK_HALF_L;
const HW = TANK_HALF_W;
const HALF_WALL = WALL / 2;
/** Distance from a tank's centre to a corner of its box. */
export const TANK_REACH = Math.hypot(HL, HW);
/** Overlap below this counts as touching. */
const EPS = 1e-6;
/** A tank never ends a move deeper in a wall than this. */
const MAX_TANK_DEPTH = 0.5;
const RESOLVE_ITERATIONS = 4;
/** Walls are gathered this far around a tank: its reach plus one tick of movement and pushes. */
const TANK_SWEEP = TANK_REACH + 8;
/** Projectiles move in steps no longer than this, well under the wall thickness. */
const MAX_SUBSTEP = 2;
/** Contacts resolved per projectile substep (two for an inside corner, one spare). */
const MAX_CONTACTS = 3;
const STEER_FORWARD_MAX = (110 * Math.PI) / 180;
const STEER_DRIVE_CONE = (60 * Math.PI) / 180;
/** separateTanks moves each tank at most this far per call, so it can never shove one through a wall. */
const MAX_SEPARATION_PUSH = 3;
/** Ray origins move off a wall by this much after a reflection so the same wall is not hit again. */
const RAY_NUDGE = 1e-4;
const DEATH_RAY_STEP = 4;
const DEATH_RAY_POINT_EVERY = 4;

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface WallHit {
  wall: number;
  /** Contact point on the wall surface. */
  x: number;
  y: number;
  /** The projectile's first wall contact ever. Only that one chips a brick. */
  first: boolean;
}

export type StepResult = 'alive' | 'wall' | 'expired';

export interface RayHit {
  dist: number;
  x: number;
  y: number;
  /** Outward surface normal at the hit. */
  nx: number;
  ny: number;
  wall: number;
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** A reusable list of solid wall rects as [id, x0, y0, x1, y1] rows, so hot paths do not allocate. */
class WallList {
  buf = new Float64Array(5 * 64);
  n = 0;

  /** Gathers every solid wall whose rect touches the box. */
  collect(m: MazeState, qx0: number, qy0: number, qx1: number, qy1: number): number {
    const { w, h } = m;
    const hx0 = Math.max(0, Math.ceil((qx0 - HALF_WALL) / TILE) - 1);
    const hx1 = Math.min(w - 1, Math.floor((qx1 + HALF_WALL) / TILE));
    const hy0 = Math.max(0, Math.ceil((qy0 - HALF_WALL) / TILE));
    const hy1 = Math.min(h, Math.floor((qy1 + HALF_WALL) / TILE));
    const vx0 = Math.max(0, Math.ceil((qx0 - HALF_WALL) / TILE));
    const vx1 = Math.min(w, Math.floor((qx1 + HALF_WALL) / TILE));
    const vy0 = Math.max(0, Math.ceil((qy0 - HALF_WALL) / TILE) - 1);
    const vy1 = Math.min(h - 1, Math.floor((qy1 + HALF_WALL) / TILE));
    const most = Math.max(0, hx1 - hx0 + 1) * Math.max(0, hy1 - hy0 + 1) + Math.max(0, vx1 - vx0 + 1) * Math.max(0, vy1 - vy0 + 1);
    if (most * 5 > this.buf.length) this.buf = new Float64Array(most * 10);
    const buf = this.buf;
    let n = 0;
    for (let y = hy0; y <= hy1; y++) {
      for (let x = hx0; x <= hx1; x++) {
        const id = hWall(w, x, y);
        if (!isSolid(m, id)) continue;
        const o = n++ * 5;
        buf[o] = id;
        buf[o + 1] = x * TILE - HALF_WALL;
        buf[o + 2] = y * TILE - HALF_WALL;
        buf[o + 3] = (x + 1) * TILE + HALF_WALL;
        buf[o + 4] = y * TILE + HALF_WALL;
      }
    }
    for (let y = vy0; y <= vy1; y++) {
      for (let x = vx0; x <= vx1; x++) {
        const id = vWall(w, h, x, y);
        if (!isSolid(m, id)) continue;
        const o = n++ * 5;
        buf[o] = id;
        buf[o + 1] = x * TILE - HALF_WALL;
        buf[o + 2] = y * TILE - HALF_WALL;
        buf[o + 3] = x * TILE + HALF_WALL;
        buf[o + 4] = (y + 1) * TILE + HALF_WALL;
      }
    }
    this.n = n;
    return n;
  }
}

const tankWalls = new WallList();
const projWalls = new WallList();
const rayWalls = new WallList();
const miscWalls = new WallList();

// ---------------------------------------------------------------------------------------------
// Tank box geometry

let pushX = 0;
let pushY = 0;

/**
 * Separating axis test between a box (centre, heading cos/sin, half length along the heading, half width across)
 * and an axis-aligned rect. Returns the overlap on the axis of least overlap, <= 0 when apart.
 * When overlapping, pushX/pushY hold the smallest translation that moves the box out.
 */
function boxRectDepth(cx: number, cy: number, c: number, s: number, hl: number, hw: number, x0: number, y0: number, x1: number, y1: number): number {
  const ex = (x1 - x0) / 2;
  const ey = (y1 - y0) / 2;
  const dx = cx - (x0 + x1) / 2;
  const dy = cy - (y0 + y1) / 2;
  const ac = Math.abs(c);
  const as = Math.abs(s);
  let best = hl * ac + hw * as + ex - Math.abs(dx);
  if (best <= 0) return best;
  let nx = dx < 0 ? -1 : 1;
  let ny = 0;
  const oy = hl * as + hw * ac + ey - Math.abs(dy);
  if (oy <= 0) return oy;
  if (oy < best) {
    best = oy;
    nx = 0;
    ny = dy < 0 ? -1 : 1;
  }
  const du = dx * c + dy * s;
  const ou = hl + ex * ac + ey * as - Math.abs(du);
  if (ou <= 0) return ou;
  if (ou < best) {
    best = ou;
    const sign = du < 0 ? -1 : 1;
    nx = c * sign;
    ny = s * sign;
  }
  const dv = dy * c - dx * s;
  const ov = hw + ex * as + ey * ac - Math.abs(dv);
  if (ov <= 0) return ov;
  if (ov < best) {
    best = ov;
    const sign = dv < 0 ? -1 : 1;
    nx = -s * sign;
    ny = c * sign;
  }
  pushX = nx * best;
  pushY = ny * best;
  return best;
}

/** Distance along a unit direction that separates two intervals on one axis (centre gap d, combined half size r). */
function exitAlong(d: number, r: number, along: number): number {
  if (along > 1e-9) return (r - d) / along;
  if (along < -1e-9) return (r + d) / -along;
  return Infinity;
}

/** How far the tank box must move along the unit vector (dirX, dirY) to stop overlapping the rect. 0 when apart. */
function boxRectExit(cx: number, cy: number, c: number, s: number, x0: number, y0: number, x1: number, y1: number, dirX: number, dirY: number): number {
  if (boxRectDepth(cx, cy, c, s, HL, HW, x0, y0, x1, y1) <= EPS) return 0;
  const ex = (x1 - x0) / 2;
  const ey = (y1 - y0) / 2;
  const dx = cx - (x0 + x1) / 2;
  const dy = cy - (y0 + y1) / 2;
  const ac = Math.abs(c);
  const as = Math.abs(s);
  return Math.min(
    exitAlong(dx, HL * ac + HW * as + ex, dirX),
    exitAlong(dy, HL * as + HW * ac + ey, dirY),
    exitAlong(dx * c + dy * s, HL + ex * ac + ey * as, dirX * c + dirY * s),
    exitAlong(dy * c - dx * s, HW + ex * as + ey * ac, dirY * c - dirX * s),
  );
}

function deepestIn(walls: WallList, x: number, y: number, c: number, s: number): number {
  const buf = walls.buf;
  let deepest = 0;
  for (let i = 0; i < walls.n; i++) {
    const o = i * 5;
    const d = boxRectDepth(x, y, c, s, HL, HW, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!);
    if (d > deepest) deepest = d;
  }
  return deepest;
}

/** Pushes the tank out of every wall in the list by minimum translations. */
function resolveTank(t: TankState, walls: WallList): void {
  const c = Math.cos(t.a);
  const s = Math.sin(t.a);
  const buf = walls.buf;
  for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < walls.n; i++) {
      const o = i * 5;
      if (boxRectDepth(t.x, t.y, c, s, HL, HW, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!) > EPS) {
        t.x += pushX;
        t.y += pushY;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/**
 * Moves the tank along one world axis, then backs it out of any wall along that same axis only.
 * Resolving per axis lets a tank slide along a run of walls without catching on the seams between them.
 */
function slideAxis(t: TankState, walls: WallList, c: number, s: number, delta: number, alongX: boolean): void {
  if (delta === 0) return;
  if (alongX) t.x += delta;
  else t.y += delta;
  const back = delta > 0 ? -1 : 1;
  const dirX = alongX ? back : 0;
  const dirY = alongX ? 0 : back;
  const buf = walls.buf;
  let k = 0;
  for (let i = 0; i < walls.n; i++) {
    const o = i * 5;
    k = Math.max(k, boxRectExit(t.x, t.y, c, s, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!, dirX, dirY));
  }
  k = Math.min(k, Math.abs(delta));
  if (alongX) t.x += dirX * k;
  else t.y += dirY * k;
}

const gatherTankWalls = (t: TankState, m: MazeState) =>
  tankWalls.collect(m, t.x - TANK_SWEEP, t.y - TANK_SWEEP, t.x + TANK_SWEEP, t.y + TANK_SWEEP);

/** Deepest overlap (px) between the tank box and any solid wall. 0 when clear. */
export function tankWallDepth(t: TankState, m: MazeState): number {
  gatherTankWalls(t, m);
  return deepestIn(tankWalls, t.x, t.y, Math.cos(t.a), Math.sin(t.a));
}

/** Whether the tank box, grown by pad, overlaps the rect. Used to stop a brick regrowing on a tank. */
export function tankOverlapsRect(t: TankState, r: Rect, pad = 0): boolean {
  return boxRectDepth(t.x, t.y, Math.cos(t.a), Math.sin(t.a), HL + pad, HW + pad, r.x0, r.y0, r.x1, r.y1) > 0;
}

/** The four box corners as flat x, y pairs: front left, front right, back right, back left (left is -y in tank space). */
export function tankCorners(t: TankState, out: number[] = []): number[] {
  const c = Math.cos(t.a);
  const s = Math.sin(t.a);
  const fx = c * HL;
  const fy = s * HL;
  const sx = -s * HW;
  const sy = c * HW;
  out.length = 8;
  out[0] = t.x + fx - sx;
  out[1] = t.y + fy - sy;
  out[2] = t.x + fx + sx;
  out[3] = t.y + fy + sy;
  out[4] = t.x - fx + sx;
  out[5] = t.y - fy + sy;
  out[6] = t.x - fx - sx;
  out[7] = t.y - fy - sy;
  return out;
}

export function muzzlePoint(t: TankState): Point {
  return { x: t.x + Math.cos(t.a) * MUZZLE, y: t.y + Math.sin(t.a) * MUZZLE };
}

function circleTouchesBox(x: number, y: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x - clamp(x, x0, x1);
  const dy = y - clamp(y, y0, y1);
  return dx * dx + dy * dy <= r * r;
}

/** Whether a circle (r may be 0 for a point) touches a rect: crate pickups, blasts against bricks. */
export const circleTouchesRect = (rect: Rect, x: number, y: number, r: number) => circleTouchesBox(x, y, r, rect.x0, rect.y0, rect.x1, rect.y1);

/** Whether a circle (r may be 0 for a point) touches any solid wall. */
export function circleTouchesWall(m: MazeState, x: number, y: number, r: number): boolean {
  const n = miscWalls.collect(m, x - r, y - r, x + r, y + r);
  const buf = miscWalls.buf;
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    if (circleTouchesBox(x, y, r, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!)) return true;
  }
  return false;
}

/** Ids of the solid walls (steel and unbroken bricks) a circle touches, such as the bricks a blast damages. */
export function wallsInCircle(m: MazeState, x: number, y: number, r: number): number[] {
  const n = miscWalls.collect(m, x - r, y - r, x + r, y + r);
  const buf = miscWalls.buf;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    if (circleTouchesBox(x, y, r, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!)) out.push(buf[o]!);
  }
  return out;
}

/**
 * Where a shot leaves the tank: the muzzle, or the tank centre when the muzzle is inside a wall
 * (tank pressed against it), so the shot cannot start on the far side.
 */
export function shotOrigin(t: TankState, m: MazeState): Point {
  const p = muzzlePoint(t);
  return circleTouchesWall(m, p.x, p.y, 0) ? { x: t.x, y: t.y } : p;
}

/** Circle against the tank's oriented box. */
export function circleHitsTank(t: TankState, x: number, y: number, r: number): boolean {
  const c = Math.cos(t.a);
  const s = Math.sin(t.a);
  const dx = x - t.x;
  const dy = y - t.y;
  const lx = dx * c + dy * s;
  const ly = dy * c - dx * s;
  const ox = lx - clamp(lx, -HL, HL);
  const oy = ly - clamp(ly, -HW, HW);
  return ox * ox + oy * oy <= r * r;
}

let slabNx = 0;
let slabNy = 0;
let slabCorner = false;

/**
 * Ray (origin, direction of any length) against an axis-aligned rect. Returns the entry parameter (0 when the origin
 * is inside), or -1 on a miss. Sets slabNx/slabNy to the entry face normal; a corner entry gets a diagonal normal.
 */
function rayRect(ox: number, oy: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): number {
  let txIn = -Infinity;
  let txOut = Infinity;
  let tyIn = -Infinity;
  let tyOut = Infinity;
  if (dx !== 0) {
    const a = (x0 - ox) / dx;
    const b = (x1 - ox) / dx;
    txIn = Math.min(a, b);
    txOut = Math.max(a, b);
  } else if (ox < x0 || ox > x1) {
    return -1;
  }
  if (dy !== 0) {
    const a = (y0 - oy) / dy;
    const b = (y1 - oy) / dy;
    tyIn = Math.min(a, b);
    tyOut = Math.max(a, b);
  } else if (oy < y0 || oy > y1) {
    return -1;
  }
  const tIn = Math.max(txIn, tyIn);
  const tOut = Math.min(txOut, tyOut);
  if (tOut < tIn || tOut < 0) return -1;
  if (txIn > tyIn) {
    slabNx = dx > 0 ? -1 : 1;
    slabNy = 0;
    slabCorner = false;
  } else if (tyIn > txIn) {
    slabNx = 0;
    slabNy = dy > 0 ? -1 : 1;
    slabCorner = false;
  } else {
    slabNx = (dx > 0 ? -1 : 1) * Math.SQRT1_2;
    slabNy = (dy > 0 ? -1 : 1) * Math.SQRT1_2;
    slabCorner = true;
  }
  return Math.max(tIn, 0);
}

/**
 * First contact of the segment with the tank box grown by pad, as a fraction 0..1 along the segment
 * (0 when the segment starts inside), or null.
 */
export function segmentHitsTank(t: TankState, x0: number, y0: number, x1: number, y1: number, pad = 0): number | null {
  const c = Math.cos(t.a);
  const s = Math.sin(t.a);
  const rx = x0 - t.x;
  const ry = y0 - t.y;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const hit = rayRect(rx * c + ry * s, ry * c - rx * s, dx * c + dy * s, dy * c - dx * s, -HL - pad, -HW - pad, HL + pad, HW + pad);
  return hit >= 0 && hit <= 1 ? hit : null;
}

// ---------------------------------------------------------------------------------------------
// Tanks

/**
 * One tick of movement from t.bits and t.steer. speed is GAME_SPEEDS[setting] and scales driving and turning.
 * Callers skip it during the countdown. The tank slides along walls and never ends up inside one.
 */
export function moveTank(t: TankState, m: MazeState, tick: number, speed: number): void {
  if (!t.alive || t.rc !== 0 || tick < t.frozenUntil) return;
  const boost = tick < t.speedUntil ? SPEED_BOOST : 1;
  const charging = t.chargeUntil > tick;
  const maxTurn = TANK_TURN * speed * boost * (charging ? DEATH_RAY.chargeTurn : 1) * DT;
  const forward = charging ? 0 : TANK_SPEED * speed * boost * DT;
  const bits = t.bits;
  let turn: number;
  let drive = 0;
  if (bits & Input.Steer) {
    const diff = wrapAngle(steerAngle(t.steer) - t.a);
    if (charging || !(bits & Input.Fwd)) {
      turn = clamp(diff, -maxTurn, maxTurn);
    } else if (Math.abs(diff) <= STEER_FORWARD_MAX) {
      turn = clamp(diff, -maxTurn, maxTurn);
      if (Math.abs(diff - turn) < STEER_DRIVE_CONE) drive = forward;
    } else {
      const rear = wrapAngle(diff + Math.PI);
      turn = clamp(rear, -maxTurn, maxTurn);
      if (Math.abs(rear - turn) < STEER_DRIVE_CONE) drive = -forward * TANK_REVERSE;
    }
  } else {
    turn = ((bits & Input.Right ? 1 : 0) - (bits & Input.Left ? 1 : 0)) * maxTurn;
    const fwd = (bits & Input.Fwd) !== 0;
    if (fwd !== ((bits & Input.Back) !== 0)) drive = fwd ? forward : -forward * TANK_REVERSE;
  }

  gatherTankWalls(t, m);
  // Clears slight overlaps first (snapshot rounding on clients), so the per-axis slide below starts clean.
  resolveTank(t, tankWalls);
  if (turn !== 0) {
    const x0 = t.x;
    const y0 = t.y;
    const a0 = t.a;
    t.a = wrapAngle(t.a + turn);
    resolveTank(t, tankWalls);
    if (deepestIn(tankWalls, t.x, t.y, Math.cos(t.a), Math.sin(t.a)) > MAX_TANK_DEPTH) {
      t.x = x0;
      t.y = y0;
      t.a = a0;
    }
  }
  if (drive !== 0) {
    const x0 = t.x;
    const y0 = t.y;
    const c = Math.cos(t.a);
    const s = Math.sin(t.a);
    slideAxis(t, tankWalls, c, s, c * drive, true);
    slideAxis(t, tankWalls, c, s, s * drive, false);
    resolveTank(t, tankWalls);
    if (deepestIn(tankWalls, t.x, t.y, c, s) > MAX_TANK_DEPTH) {
      t.x = x0;
      t.y = y0;
    }
  }
}

let separationStart = new Float64Array(0);

/**
 * Pushes overlapping living tanks apart (circles of TANK_RADIUS, half the overlap each, capped per call),
 * then back out of walls. Pass the tanks in the same order everywhere (by seat) so results match.
 */
export function separateTanks(tanks: readonly TankState[], m: MazeState): void {
  const n = tanks.length;
  if (separationStart.length < n * 2) separationStart = new Float64Array(n * 2);
  const start = separationStart;
  for (let i = 0; i < n; i++) {
    start[i * 2] = tanks[i]!.x;
    start[i * 2 + 1] = tanks[i]!.y;
  }
  const minDist = TANK_RADIUS * 2;
  let pushed = false;
  for (let i = 0; i < n; i++) {
    const a = tanks[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < n; j++) {
      const b = tanks[j]!;
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-9 ? dx / d : 1;
      const ny = d > 1e-9 ? dy / d : 0;
      const push = Math.min(MAX_SEPARATION_PUSH, (minDist - d) / 2);
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      pushed = true;
    }
  }
  if (!pushed) return;
  for (let i = 0; i < n; i++) {
    const t = tanks[i]!;
    if (t.x === start[i * 2] && t.y === start[i * 2 + 1]) continue;
    gatherTankWalls(t, m);
    resolveTank(t, tankWalls);
    if (deepestIn(tankWalls, t.x, t.y, Math.cos(t.a), Math.sin(t.a)) > MAX_TANK_DEPTH) {
      t.x = start[i * 2]!;
      t.y = start[i * 2 + 1]!;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Projectiles

/**
 * A new projectile. Velocity is PROJ_STATS speed * speed (GAME_SPEEDS[setting]) * speedScale along angle a.
 * Bullets pass opts.bounces = settings.bounces. owner can be any { seat, team }, such as a blast's owner.
 */
export function makeProj(
  kind: Proj,
  id: number,
  owner: Pick<TankState, 'seat' | 'team'>,
  x: number,
  y: number,
  a: number,
  tick: number,
  speed: number,
  opts: { bounces?: number; speedScale?: number } = {},
): ProjState {
  const stats = PROJ_STATS[kind];
  const v = stats.speed * speed * (opts.speedScale ?? 1);
  return {
    id,
    kind,
    owner: owner.seat,
    team: owner.team,
    x,
    y,
    vx: Math.cos(a) * v,
    vy: Math.sin(a) * v,
    r: stats.r,
    bornAt: tick,
    dieAt: tick + stats.life,
    bounces: opts.bounces ?? stats.bounces,
    deadly: !stats.ownerSafe,
    aux: 0,
    fuseAt: 0,
    hits: 0,
  };
}

let contactX = 0;
let contactY = 0;
let contactNx = 0;
let contactNy = 0;

/**
 * Circle against a rect. Returns the penetration depth (<= 0 when apart) and sets the contact point and outward normal.
 * A centre inside the rect leaves through the face it came in by (judged from the velocity).
 */
function circleRectDepth(px: number, py: number, r: number, vx: number, vy: number, x0: number, y0: number, x1: number, y1: number): number {
  const qx = clamp(px, x0, x1);
  const qy = clamp(py, y0, y1);
  const dx = px - qx;
  const dy = py - qy;
  const d2 = dx * dx + dy * dy;
  if (d2 > 0) {
    if (d2 >= r * r) return 0;
    const d = Math.sqrt(d2);
    contactX = qx;
    contactY = qy;
    contactNx = dx / d;
    contactNy = dy / d;
    return r - d;
  }
  // Time since crossing each face, going back along the velocity (callers never pass a zero velocity).
  const tx = vx > 0 ? (px - x0) / vx : vx < 0 ? (x1 - px) / -vx : Infinity;
  const ty = vy > 0 ? (py - y0) / vy : vy < 0 ? (y1 - py) / -vy : Infinity;
  const alongX = tx <= ty;
  const toLow = alongX ? vx > 0 : vy > 0;
  if (alongX) {
    contactX = toLow ? x0 : x1;
    contactY = py;
    contactNx = toLow ? -1 : 1;
    contactNy = 0;
    return r + Math.abs(px - contactX);
  }
  contactX = px;
  contactY = toLow ? y0 : y1;
  contactNx = 0;
  contactNy = toLow ? -1 : 1;
  return r + Math.abs(py - contactY);
}

/**
 * One tick for a projectile. Mines slow to a stop over MINES.stopTicks from bornAt. Moves in substeps of at most
 * MAX_SUBSTEP px, reflecting off walls (deepest contact first, so flat runs of walls never act like corners).
 * Each contact appends a WallHit and counts in p.hits, then the projectile dies ('wall') if it had no bounces left,
 * else uses one up (-1 is unlimited) and becomes deadly to its owner.
 */
export function stepProjectile(p: ProjState, m: MazeState, tick: number, hits: WallHit[]): StepResult {
  if (tick >= p.dieAt) return 'expired';
  if (p.kind === Proj.Mine) {
    const age = tick - p.bornAt;
    if (age >= MINES.stopTicks) {
      p.vx = 0;
      p.vy = 0;
      return 'alive';
    }
    if (age >= 1) {
      const f = (MINES.stopTicks - age) / (MINES.stopTicks - age + 1);
      p.vx *= f;
      p.vy *= f;
    }
  }
  const travel = Math.hypot(p.vx, p.vy) * DT;
  if (travel === 0) return 'alive';
  const steps = Math.max(1, Math.ceil(travel / MAX_SUBSTEP));
  const reach = travel + p.r + 1;
  const n = projWalls.collect(m, p.x - reach, p.y - reach, p.x + reach, p.y + reach);
  const buf = projWalls.buf;
  const sub = DT / steps;
  for (let step = 0; step < steps; step++) {
    p.x += p.vx * sub;
    p.y += p.vy * sub;
    for (let contact = 0; contact < MAX_CONTACTS; contact++) {
      let deepest = EPS;
      let wall = -1;
      let hx = 0;
      let hy = 0;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        const d = circleRectDepth(p.x, p.y, p.r, p.vx, p.vy, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!);
        if (d > deepest) {
          deepest = d;
          wall = buf[o]!;
          hx = contactX;
          hy = contactY;
          nx = contactNx;
          ny = contactNy;
        }
      }
      if (wall < 0) break;
      p.x = hx + nx * p.r;
      p.y = hy + ny * p.r;
      const vn = p.vx * nx + p.vy * ny;
      if (vn >= 0) continue;
      p.vx -= 2 * vn * nx;
      p.vy -= 2 * vn * ny;
      hits.push({ wall, x: hx, y: hy, first: p.hits === 0 });
      p.hits++;
      if (p.bounces === 0) return 'wall';
      if (p.bounces > 0) p.bounces--;
      p.deadly = true;
    }
  }
  return 'alive';
}

/** Sets the projectile's heading, keeping its speed. */
function setHeading(p: ProjState, heading: number): void {
  const speed = Math.hypot(p.vx, p.vy);
  p.vx = Math.cos(heading) * speed;
  p.vy = Math.sin(heading) * speed;
}

let homingDist = new Int16Array(0);

const cellAt = (v: number, cells: number) => clamp(Math.floor(v / TILE), 0, cells - 1);

/** Whether no solid wall lies on the straight line between two points. steelOnly lets bricks through (blasts). */
export function clearLine(m: MazeState, x0: number, y0: number, x1: number, y1: number, steelOnly = false): boolean {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len === 0) return true;
  return !castRay(m, x0, y0, (x1 - x0) / len, (y1 - y0) / len, len, steelOnly);
}

/**
 * A hunting homing missile (aux 1) turns toward the target nearest by maze path: straight at it when in view,
 * else toward the next cell centre on the shortest path. Turns at most HOMING.turnRate rad/s, speed unchanged.
 * targets is the caller's filtered list (living, unprotected enemies).
 */
export function steerHoming(p: ProjState, m: MazeState, targets: readonly Point[], dt: number): void {
  if (p.aux !== 1 || targets.length === 0) return;
  const { w, h } = m;
  if (homingDist.length < w * h) homingDist = new Int16Array(w * h);
  const pcx = cellAt(p.x, w);
  const pcy = cellAt(p.y, h);
  const dist = bfs(m, pcx, pcy, homingDist);
  let target: Point | null = null;
  let bestPath = Infinity;
  let bestD2 = Infinity;
  for (const t of targets) {
    const d = dist[cellAt(t.y, h) * w + cellAt(t.x, w)]!;
    if (d < 0) continue;
    const d2 = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
    if (d < bestPath || (d === bestPath && d2 < bestD2)) {
      target = t;
      bestPath = d;
      bestD2 = d2;
    }
  }
  if (!target) return;
  let aimX = target.x;
  let aimY = target.y;
  if (bestPath > 0 && !clearLine(m, p.x, p.y, target.x, target.y)) {
    let cell = cellAt(target.y, h) * w + cellAt(target.x, w);
    while (cell >= 0 && dist[cell]! > 1) cell = downhill(m, dist, cell);
    if (cell >= 0) {
      const cx = cell % w;
      aimX = (cx + 0.5) * TILE;
      aimY = ((cell - cx) / w + 0.5) * TILE;
    }
  }
  const heading = Math.atan2(p.vy, p.vx);
  setHeading(p, turnToward(heading, Math.atan2(aimY - p.y, aimX - p.x), HOMING.turnRate * dt));
}

/** A neighbour of cell, through an open edge, whose BFS distance is one less. -1 when there is none. */
function downhill(m: MazeState, dist: Int16Array, cell: number): number {
  const { w, h } = m;
  const x = cell % w;
  const y = (cell - x) / w;
  const want = dist[cell]! - 1;
  if (y > 0 && dist[cell - w] === want && !isSolid(m, hWall(w, x, y))) return cell - w;
  if (x < w - 1 && dist[cell + 1] === want && !isSolid(m, vWall(w, h, x + 1, y))) return cell + 1;
  if (y < h - 1 && dist[cell + w] === want && !isSolid(m, hWall(w, x, y + 1))) return cell + w;
  if (x > 0 && dist[cell - 1] === want && !isSolid(m, vWall(w, h, x, y))) return cell - 1;
  return -1;
}

/**
 * The owner steers an RC missile: Left/Right turn it at RC.turnRate. With the Steer bit (phone joystick)
 * it turns toward the steer byte's direction instead, without overshooting. Pass the owner's steer byte.
 */
export function steerRc(p: ProjState, bits: number, dt: number, steer = 0): void {
  const maxTurn = RC.turnRate * dt;
  const heading = Math.atan2(p.vy, p.vx);
  if (bits & Input.Steer) {
    setHeading(p, turnToward(heading, steerAngle(steer), maxTurn));
    return;
  }
  const dir = (bits & Input.Right ? 1 : 0) - (bits & Input.Left ? 1 : 0);
  if (dir !== 0) setHeading(p, heading + dir * maxTurn);
}

/**
 * Bounces a projectile off a shield circle around (t.x, t.y) when it touches it moving inward.
 * The projectile becomes deadly to its owner. Returns true on a bounce. Callers check the shield is up.
 */
export function deflectOffShield(p: ProjState, t: Point): boolean {
  const dx = p.x - t.x;
  const dy = p.y - t.y;
  const reach = SHIELD_RADIUS + p.r;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0 || d2 > reach * reach) return false;
  const inward = p.vx * dx + p.vy * dy;
  if (inward >= 0) return false;
  const k = (2 * inward) / d2;
  p.vx -= k * dx;
  p.vy -= k * dy;
  p.deadly = true;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Rays

let rayT = 0;
let rayNx = 0;
let rayNy = 0;
let rayWall = -1;

/** Grid walk over the cells the ray crosses, testing the walls that touch each cell. Results go in rayT/rayNx/rayNy/rayWall. */
function castRay(m: MazeState, ox: number, oy: number, dx: number, dy: number, maxLen: number, steelOnly: boolean): boolean {
  const { w, h } = m;
  let cx = cellAt(ox, w);
  let cy = cellAt(oy, h);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const deltaX = stepX !== 0 ? TILE / Math.abs(dx) : Infinity;
  const deltaY = stepY !== 0 ? TILE / Math.abs(dy) : Infinity;
  let nextX = stepX > 0 ? ((cx + 1) * TILE - ox) / dx : stepX < 0 ? (cx * TILE - ox) / dx : Infinity;
  let nextY = stepY > 0 ? ((cy + 1) * TILE - oy) / dy : stepY < 0 ? (cy * TILE - oy) / dy : Infinity;
  let best = Infinity;
  let bestCorner = false;
  const buf = rayWalls.buf;
  for (;;) {
    const n = rayWalls.collect(m, cx * TILE, cy * TILE, (cx + 1) * TILE, (cy + 1) * TILE);
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      const id = buf[o]!;
      if (steelOnly && m.walls[id] !== WallKind.Steel) continue;
      const t = rayRect(ox, oy, dx, dy, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!, buf[o + 4]!);
      if (t < 0) continue;
      // On an exact tie prefer a face entry: a corner shared with a flush neighbouring wall is not a real corner.
      if (t < best - 1e-9 || (t <= best + 1e-9 && bestCorner && !slabCorner)) {
        best = t;
        bestCorner = slabCorner;
        rayNx = slabNx;
        rayNy = slabNy;
        rayWall = id;
      }
    }
    const exit = Math.min(nextX, nextY);
    if (best <= exit || exit > maxLen) break;
    if (nextX < nextY) {
      cx += stepX;
      if (cx < 0 || cx >= w) break;
      nextX += deltaX;
    } else {
      cy += stepY;
      if (cy < 0 || cy >= h) break;
      nextY += deltaY;
    }
  }
  if (best > maxLen) return false;
  rayT = best;
  return true;
}

/**
 * First solid wall hit by a zero-width ray from (x, y) along the unit vector (dx, dy), within maxLen.
 * An origin inside a wall hits it at dist 0. steelOnly ignores bricks (blast line of sight).
 */
export function raycast(m: MazeState, x: number, y: number, dx: number, dy: number, maxLen: number, steelOnly = false): RayHit | null {
  if ((dx === 0 && dy === 0) || !castRay(m, x, y, dx, dy, maxLen, steelOnly)) return null;
  return { dist: rayT, x: x + dx * rayT, y: y + dy * rayT, nx: rayNx, ny: rayNy, wall: rayWall };
}

/** Entry distance of a ray (unit direction) into a circle, or -1. A ray starting inside the circle ignores it. */
function rayCircle(ox: number, oy: number, dx: number, dy: number, c: Circle): number {
  const fx = ox - c.x;
  const fy = oy - c.y;
  const outside = fx * fx + fy * fy - c.r * c.r;
  if (outside <= 0) return -1;
  const b = fx * dx + fy * dy;
  const disc = b * b - outside;
  if (b >= 0 || disc < 0) return -1;
  return -b - Math.sqrt(disc);
}

/**
 * A reflecting ray as a flat x, y polyline starting at the origin, with up to maxReflections bounces and maxLen total.
 * walls[i] is what was hit at point i + 1: a wall id, or -(k + 1) for mirrors[k] (shield circles).
 * When the path ends on a contact (out of reflections), walls has one entry per point after the origin;
 * when it runs out of length, the last point has no entry.
 */
export function tracePath(
  m: MazeState,
  x: number,
  y: number,
  a: number,
  maxReflections: number,
  maxLen: number,
  mirrors: readonly Circle[] = [],
): { pts: number[]; walls: number[] } {
  const pts = [x, y];
  const walls: number[] = [];
  let ox = x;
  let oy = y;
  let dx = Math.cos(a);
  let dy = Math.sin(a);
  let left = maxLen;
  for (let reflections = 0; ; reflections++) {
    let hit = castRay(m, ox, oy, dx, dy, left, false);
    let t = hit ? rayT : left;
    let nx = rayNx;
    let ny = rayNy;
    let id = rayWall;
    for (let k = 0; k < mirrors.length; k++) {
      const mirror = mirrors[k]!;
      const tm = rayCircle(ox, oy, dx, dy, mirror);
      if (tm < 0 || tm >= t) continue;
      hit = true;
      t = tm;
      nx = (ox + dx * tm - mirror.x) / mirror.r;
      ny = (oy + dy * tm - mirror.y) / mirror.r;
      id = -(k + 1);
    }
    const hx = ox + dx * t;
    const hy = oy + dy * t;
    pts.push(hx, hy);
    if (!hit) break;
    walls.push(id);
    left -= t;
    if (reflections >= maxReflections || left <= 0) break;
    const dot = dx * nx + dy * ny;
    dx -= 2 * dot * nx;
    dy -= 2 * dot * ny;
    ox = hx + nx * RAY_NUDGE;
    oy = hy + ny * RAY_NUDGE;
  }
  return { pts, walls };
}

/** Heading bent toward the nearest target within DEATH_RAY.seekCone, by at most maxTurn. */
function bendToward(x: number, y: number, heading: number, targets: readonly Point[], maxTurn: number): number {
  let bestD2 = Infinity;
  let bend = 0;
  for (const t of targets) {
    const dx = t.x - x;
    const dy = t.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-6 || d2 >= bestD2) continue;
    const diff = wrapAngle(Math.atan2(dy, dx) - heading);
    if (Math.abs(diff) > DEATH_RAY.seekCone) continue;
    bestD2 = d2;
    bend = diff;
  }
  return heading + clamp(bend, -maxTurn, maxTurn);
}

/**
 * The death ray beam as a flat x, y polyline (a point about every 16 px). It marches DEATH_RAY.maxLength in 4 px steps,
 * bending toward the nearest target inside DEATH_RAY.seekCone by at most DEATH_RAY.maxBend rad per 100 px,
 * passes through every interior wall and stops at the inner face of the outer wall.
 * targets is the caller's filtered list (living enemies that are not protected or shielded).
 */
export function deathRayPath(m: MazeState, x: number, y: number, a: number, targets: readonly Point[]): number[] {
  const lo = HALF_WALL;
  const hiX = m.w * TILE - HALF_WALL;
  const hiY = m.h * TILE - HALF_WALL;
  const maxTurn = (DEATH_RAY.maxBend * DEATH_RAY_STEP) / 100;
  const steps = Math.ceil(DEATH_RAY.maxLength / DEATH_RAY_STEP);
  let px = clamp(x, lo, hiX);
  let py = clamp(y, lo, hiY);
  let heading = a;
  const pts = [px, py];
  for (let i = 1; i <= steps; i++) {
    heading = bendToward(px, py, heading, targets, maxTurn);
    const len = Math.min(DEATH_RAY_STEP, DEATH_RAY.maxLength - (i - 1) * DEATH_RAY_STEP);
    const nx = px + Math.cos(heading) * len;
    const ny = py + Math.sin(heading) * len;
    let f = 1;
    if (nx > hiX) f = Math.min(f, (hiX - px) / (nx - px));
    if (nx < lo) f = Math.min(f, (lo - px) / (nx - px));
    if (ny > hiY) f = Math.min(f, (hiY - py) / (ny - py));
    if (ny < lo) f = Math.min(f, (lo - py) / (ny - py));
    if (f < 1) {
      pts.push(px + (nx - px) * f, py + (ny - py) * f);
      return pts;
    }
    px = nx;
    py = ny;
    if (i % DEATH_RAY_POINT_EVERY === 0 || i === steps) pts.push(px, py);
  }
  return pts;
}

/**
 * Ids of the solid walls a polyline (flat x, y pairs) passes within pad of, in path order, each once.
 * For the death ray's brick damage.
 */
export function wallsAlongPath(m: MazeState, pts: readonly number[], pad = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!;
    const y0 = pts[i + 1]!;
    const x1 = pts[i + 2]!;
    const y1 = pts[i + 3]!;
    const n = miscWalls.collect(m, Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad);
    const buf = miscWalls.buf;
    for (let k = 0; k < n; k++) {
      const o = k * 5;
      const id = buf[o]!;
      if (out.includes(id)) continue;
      const t = rayRect(x0, y0, x1 - x0, y1 - y0, buf[o + 1]! - pad, buf[o + 2]! - pad, buf[o + 3]! + pad, buf[o + 4]! + pad);
      if (t >= 0 && t <= 1) out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Storm

/**
 * The safe area during the storm, or null before stormAt (or with stormAt 0). It shrinks linearly from the whole
 * world to a centred rect STORM_MIN_FRACTION of each side (at least 2 cells) over STORM_CLOSE_TICKS, then holds.
 */
export function stormRect(m: { w: number; h: number }, tick: number, stormAt: number): Rect | null {
  if (stormAt <= 0 || tick < stormAt) return null;
  const width = m.w * TILE;
  const height = m.h * TILE;
  const f = Math.min(1, (tick - stormAt) / STORM_CLOSE_TICKS);
  const minW = Math.min(width, Math.max(width * STORM_MIN_FRACTION, 2 * TILE));
  const minH = Math.min(height, Math.max(height * STORM_MIN_FRACTION, 2 * TILE));
  const insetX = ((width - minW) / 2) * f;
  const insetY = ((height - minH) / 2) * f;
  return { x0: insetX, y0: insetY, x1: width - insetX, y1: height - insetY };
}
