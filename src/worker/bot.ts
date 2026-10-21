import { DT, GAME_SPEEDS, MAX_HP, SHIELD_RADIUS, TANK_HALF_L, TANK_HALF_W, TANK_RADIUS, TANK_SPEED, TICK_HZ, TILE, WALL } from '../shared/constants';
import { cellCenter } from '../shared/grid';
import { bfs, canMove, DIRS, DIR_X, DIR_Y } from '../shared/maze';
import type { Rng } from '../shared/rng';
import type { Settings } from '../shared/settings';
import { clearLine, inRect, makeProj, raycast, shotOrigin, stepProjectile, stormRect, tracePath, type WallHit } from '../shared/sim';
import { Input, Proj, sameTeam, Upgrade, Weapon, type BotLevel, type Crate, type CrateKind, type MazeState, type ProjState, type TankState } from '../shared/types';
import { clamp, TAU, wrapAngle, type Point } from '../shared/vec';
import { BLAST, FRAG, LASER, PROJ_STATS } from '../shared/weapons';

export const BOT_NAMES = ['Rusty', 'Treads', 'Boomer', 'Sarge', 'Clank', 'Dozer', 'Ricochet', 'Bolt', 'Major', 'Sparky', 'Turret', 'Gizmo'];

/** What a bot can see of the match. Match implements it. */
export interface BotWorld {
  readonly k: number;
  readonly playAt: number;
  readonly stormAt: number;
  readonly maze: MazeState;
  readonly settings: Settings;
  /** Tanks by seat. Dead and departed tanks have alive false. */
  readonly tanks: readonly TankState[];
  readonly projectiles: readonly ProjState[];
  readonly crates: readonly Crate[];
  fragOf(seat: number): ProjState | undefined;
  /** The tick the seat last fired a shot. */
  shotAt(seat: number): number;
}

interface Skill {
  /** Ticks between plans: the bot's reaction time. */
  plan: number;
  /** Error (rad) in the angle the bot turns to when it lines up a shot. */
  aimError: number;
  /** It fires when its shot path passes this close (px) to an enemy's centre. Bigger is sloppier. */
  hitMargin: number;
  /** Most wall bounces it plans a shot around. */
  bankDepth: number;
  /** Headings tried when searching for two-bounce shots, a divisor of 256. 0 skips the search. */
  fan: number;
  /** Share of a moving target's travel it aims ahead by. */
  lead: number;
  /** Chance per plan that it pulls the trigger on a lined-up shot. Lower hesitates longer. */
  trigger: number;
  /** Chance it reacts to a shot heading its way. */
  dodge: number;
  /** Cells it will detour for a crate. */
  crateRange: number;
  /** Rates crates by usefulness instead of taking the nearest. */
  weighCrates: boolean;
  /** Backs away from fights at 1 hp. */
  careful: boolean;
  /** Whose mines it routes around: its own, its team's too, or every mine it can spot. */
  mines: 'own' | 'team' | 'all';
}

export const BOT_SKILL: Record<BotLevel, Skill> = {
  easy: { plan: 15, aimError: 0.1, hitMargin: 13, bankDepth: 0, fan: 0, lead: 0, trigger: 0.4, dodge: 0.1, crateRange: 4, weighCrates: false, careful: false, mines: 'own' },
  normal: { plan: 9, aimError: 0.035, hitMargin: 9, bankDepth: 1, fan: 0, lead: 0.6, trigger: 0.8, dodge: 0.5, crateRange: 6, weighCrates: false, careful: true, mines: 'team' },
  hard: { plan: 6, aimError: 0.012, hitMargin: 8, bankDepth: 2, fan: 64, lead: 1, trigger: 1, dodge: 0.9, crateRange: 8, weighCrates: true, careful: true, mines: 'all' },
};

/** A point a shot path must reach (enemy) or must not reach first (the bot itself, teammates, shields). */
interface Mark {
  /** Where the shot is expected to meet it, for traced paths. */
  x: number;
  y: number;
  r: number;
  enemy: boolean;
  self: boolean;
  /** Where it is now and how fast the bot thinks it is going, for the flown check. */
  x0: number;
  y0: number;
  vx: number;
  vy: number;
}

type Move =
  | { kind: 'stop' }
  | { kind: 'drive'; x: number; y: number }
  | { kind: 'aim'; a: number }
  | { kind: 'raw'; bits: number; steer?: number }
  /** Steering an RC missile toward a point. */
  | { kind: 'missile'; id: number; x: number; y: number };

interface Seen {
  x: number;
  y: number;
  k: number;
  vx: number;
  vy: number;
}

const STOP: Move = { kind: 'stop' };
/** Longest shot path a bot traces, px. */
const MAX_SHOT = 700;
/** Drive only when roughly facing the waypoint; otherwise turn on the spot first. */
const DRIVE_CONE = 1.2;
const ARRIVED = 3;
const STUCK_TICKS = 30;
const UNSTICK_TICKS = 24;
const THREAT_RANGE = 3 * TILE;
const THREAT_SECONDS = 0.8;
/** Room needed beside the tank to sidestep a shot, px. */
const SIDESTEP = 12;
/** After a shot the bot holds still this long rather than drive into its own ricochet. */
const POST_SHOT_TICKS = 24;
/** Bank shots consider wall faces up to this far beyond the shooter and target. */
const MIRROR_REACH = 4 * TILE;
const MIRROR_TARGETS = 2;
const REFINE_ANGLES = 3;
const BAD_HEADING_TICKS = 60;
/**
 * A bot that has neither moved PROGRESS_PX nor fired for NO_PROGRESS_TICKS is going nowhere (aiming at a shot it
 * never takes, or turning back and forth between a shot and its route), so it stops lining up shots and moves on.
 */
const NO_PROGRESS_TICKS = 2 * TICK_HZ;
const PROGRESS_PX = 8;
const MOVE_ON_TICKS = 1.5 * TICK_HZ;
/** Heading change per steer byte step. */
const STEER_STEP = TAU / 256;
const STRING_PULL = 4;
const SHOTGUN_RANGE = 2.5 * TILE;
const DEATH_RAY_RANGE = 5 * TILE;
const FRAG_TRIGGER = 1.5 * TILE;
const MISSILE_RANGE = 12;
const HOMING_RUN = 2 * TILE;
const RC_RUN = 0.6 * TILE;
/** Shrapnel flies about this far, so a bot stays farther than this from its own frag when it sets it off. */
const SHRAPNEL_REACH = 90;
const MINE_CHASE_CELLS = 4;
const STORM_LOOKAHEAD = 4 * TICK_HZ;
const WEAPON_VALUE: Record<Exclude<Weapon, 0>, number> = {
  [Weapon.Laser]: 9,
  [Weapon.Gatling]: 7,
  [Weapon.Shotgun]: 6,
  [Weapon.Homing]: 8,
  [Weapon.Frag]: 6,
  [Weapon.Mines]: 4,
  [Weapon.DeathRay]: 10,
  [Weapon.Rc]: 7,
};

const angleByte = (a: number) => Math.round((wrapAngle(a) / TAU) * 256) & 255;
const cellIndex = (m: MazeState, x: number, y: number) =>
  clamp(Math.floor(y / TILE), 0, m.h - 1) * m.w + clamp(Math.floor(x / TILE), 0, m.w - 1);
const centreOf = (m: MazeState, cell: number) => cellCenter(cell % m.w, Math.floor(cell / m.w));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

let queue = new Int32Array(0);

/**
 * Path distance in cells from start to every cell (-1 unreachable), like the maze BFS,
 * but never entering a blocked cell other than the start.
 */
function routeAround(m: MazeState, start: number, blocked: Uint8Array, out: Int16Array): void {
  const n = m.w * m.h;
  out.fill(-1, 0, n);
  if (queue.length < n) queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  out[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cell = queue[head++]!;
    const cx = cell % m.w;
    const cy = (cell - cx) / m.w;
    for (const dir of DIRS) {
      if (!canMove(m, cx, cy, dir)) continue;
      const next = cell + DIR_Y[dir] * m.w + DIR_X[dir];
      if (out[next] !== -1 || blocked[next]) continue;
      out[next] = out[cell]! + 1;
      queue[tail++] = next;
    }
  }
}

/**
 * Walks a shot path and returns the first mark it passes within reach of and how far along that is, plus how close
 * it came to any enemy (for ranking near misses). The shot leaves from the bot, so the bot's own mark only counts
 * once the path has bounced.
 */
function walk(pts: readonly number[], marks: readonly Mark[]): { first: Mark | null; at: number; miss: number } {
  let travelled = 0;
  let miss = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!;
    const y0 = pts[i + 1]!;
    const dx = pts[i + 2]! - x0;
    const dy = pts[i + 3]! - y0;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    let first: Mark | null = null;
    let firstAt = Infinity;
    for (const mk of marks) {
      const u = len2 > 0 ? clamp(((mk.x - x0) * dx + (mk.y - y0) * dy) / len2, 0, 1) : 0;
      const d = Math.hypot(x0 + dx * u - mk.x, y0 + dy * u - mk.y);
      const at = travelled + u * len;
      if (mk.self && i === 0) continue;
      if (mk.enemy && d < miss) miss = d;
      if (d <= mk.r && at < firstAt) {
        first = mk;
        firstAt = at;
      }
    }
    if (first) return { first, at: firstAt, miss };
    travelled += len;
  }
  return { first: null, at: Infinity, miss };
}

/** One computer player's brain. It re-plans every few ticks and holds its plan in between. */
export class Bot {
  private readonly skill: Skill;
  private move: Move = STOP;
  private fire = false;
  private firedLast = false;
  /** The fire bit is being held down for the gatling, not pressed. */
  private holding = false;
  private heldLast = false;
  private distances = new Int16Array(0);
  private blocked = new Uint8Array(0);
  private missileDist = new Int16Array(0);
  private seen: Seen[] = [];
  private lastX = 0;
  private lastY = 0;
  private lastA = 0;
  private stuckTicks = 0;
  private unstickUntil = 0;
  private pauseUntil = 0;
  /** Headings (steer bytes) whose flown shot missed, with the tick to forget them, and where the bot was. */
  private bad = new Map<number, number>();
  private badX = 0;
  private badY = 0;
  private hits: WallHit[] = [];
  /** Where the bot was when it last moved or fired, and when. */
  private progressX = 0;
  private progressY = 0;
  private progressAt = 0;
  private skipAimUntil = 0;
  private wanderTo = -1;

  constructor(
    readonly seat: number,
    readonly level: BotLevel,
    private readonly rng: Rng,
  ) {
    this.skill = BOT_SKILL[level];
  }

  /** Sets the tank's bits and steer for this tick. */
  drive(w: BotWorld, t: TankState): void {
    if ((w.k + this.seat * 7) % this.skill.plan === 0) this.plan(w, t);
    this.apply(w, t);
  }

  private apply(w: BotWorld, t: TankState): void {
    let bits = 0;
    let steer = t.steer;
    const m = this.move;
    switch (m.kind) {
      case 'drive': {
        const dx = m.x - t.x;
        const dy = m.y - t.y;
        if (dx * dx + dy * dy < ARRIVED * ARRIVED) break;
        const a = Math.atan2(dy, dx);
        steer = angleByte(a);
        bits = Input.Steer | (Math.abs(wrapAngle(a - t.a)) < DRIVE_CONE ? Input.Fwd : 0);
        break;
      }
      case 'aim':
        steer = angleByte(m.a);
        bits = Input.Steer;
        break;
      case 'raw':
        bits = m.bits;
        steer = m.steer ?? steer;
        break;
      case 'missile': {
        const p = w.projectiles.find((q) => q.id === m.id);
        if (p) steer = angleByte(Math.atan2(m.y - p.y, m.x - p.x));
        bits = Input.Steer;
        break;
      }
      case 'stop':
        break;
    }
    if (this.fire) bits |= Input.Fire;
    t.bits = bits;
    t.steer = steer;
  }

  /** Fire on this plan if the last plan was not firing, so the press is a fresh edge. */
  private press(): void {
    if (!this.firedLast) this.fire = true;
  }

  /**
   * Fires a lined-up shot, after the bot's hesitation. Returns the heading to turn to, or to hold while it hesitates,
   * so it does not wander off a shot it is about to take. null once it fired or when there is no shot.
   */
  private take(shot: { now: boolean; aim: number } | null, k: number): number | null {
    if (shot?.now && this.rng() < this.skill.trigger) {
      this.press();
      if (this.fire) this.pauseUntil = k + POST_SHOT_TICKS;
    }
    return this.fire ? null : (shot?.aim ?? null);
  }

  /** Keep fire down across plans. A hold must start with a fresh edge too. */
  private hold(): void {
    if (this.firedLast && !this.heldLast) return;
    this.fire = true;
    this.holding = true;
  }

  private plan(w: BotWorld, t: TankState): void {
    this.track(w);
    this.fire = false;
    this.holding = false;
    if (!t.alive) {
      this.move = STOP;
      this.firedLast = false;
      this.stuckTicks = 0;
      this.progressAt = w.k;
      return;
    }
    if (w.k >= this.unstickUntil) this.think(w, t);
    this.firedLast = this.fire;
    this.heldLast = this.holding;
    this.lastX = t.x;
    this.lastY = t.y;
    this.lastA = t.a;
  }

  private think(w: BotWorld, t: TankState): void {
    const k = w.k;
    const m = w.maze;
    if (this.checkStuck(t)) {
      this.move = { kind: 'raw', bits: Input.Back | (this.rng() < 0.5 ? Input.Left : Input.Right) };
      this.unstickUntil = k + UNSTICK_TICKS;
      return;
    }
    if (this.distances.length < m.w * m.h) this.distances = new Int16Array(m.w * m.h);
    routeAround(m, cellIndex(m, t.x, t.y), this.mineCells(w, t), this.distances);
    const enemies = w.tanks.filter((o) => o.alive && o.seat !== t.seat && !sameTeam(o.team, t.team));

    if (t.rc !== 0) {
      this.steerMissile(w, t, enemies);
      return;
    }
    if (t.chargeUntil > k) {
      const target = this.nearest(t, enemies);
      this.move = target ? { kind: 'aim', a: Math.atan2(target.y - t.y, target.x - t.x) } : STOP;
      return;
    }
    const frag = w.fragOf(t.seat);
    if (frag) this.detonateFrag(w, t, frag, enemies);

    const immune = t.shieldUntil > k || t.protectUntil > k;
    let dodging = false;
    if (this.skill.dodge > 0 && !(immune && this.level === 'hard')) {
      const threat = this.threat(w, t);
      if (threat && this.rng() < this.skill.dodge) dodging = this.dodge(w, t, threat);
    }
    const aim = frag ? null : this.shoot(w, t, enemies);
    if (this.stalled(w, t)) this.skipAimUntil = k + MOVE_ON_TICKS;
    if (dodging) return;
    if (aim !== null && k >= this.skipAimUntil) this.move = { kind: 'aim', a: aim };
    else if (frag || k < this.pauseUntil) this.move = { kind: 'aim', a: this.watch(t, enemies) };
    else this.navigate(w, t, enemies);
  }

  /** Records where every tank is, to estimate velocities for leading shots. */
  private track(w: BotWorld): void {
    const maxSpeed = TANK_SPEED * 2 * (GAME_SPEEDS[w.settings.speed] ?? 1);
    for (const o of w.tanks) {
      const prev = this.seen[o.seat];
      if (prev && o.alive && w.k > prev.k) {
        const dt = (w.k - prev.k) * DT;
        prev.vx = (o.x - prev.x) / dt;
        prev.vy = (o.y - prev.y) / dt;
        if (Math.hypot(prev.vx, prev.vy) > maxSpeed) prev.vx = prev.vy = 0;
      } else if (prev) {
        prev.vx = prev.vy = 0;
      }
      this.seen[o.seat] = { x: o.x, y: o.y, k: w.k, vx: prev?.vx ?? 0, vy: prev?.vy ?? 0 };
    }
  }

  /** True when the bot meant to drive or turn but has done neither for a while (wedged by walls). */
  private checkStuck(t: TankState): boolean {
    const moved = Math.hypot(t.x - this.lastX, t.y - this.lastY) > 0.5 || Math.abs(wrapAngle(t.a - this.lastA)) > 0.02;
    const m = this.move;
    const trying = (m.kind === 'drive' && dist(t, m) >= ARRIVED * 2) || (m.kind === 'aim' && Math.abs(wrapAngle(m.a - t.a)) > STEER_STEP);
    if (!trying || moved) {
      this.stuckTicks = 0;
      return false;
    }
    this.stuckTicks += this.skill.plan;
    if (this.stuckTicks < STUCK_TICKS) return false;
    this.stuckTicks = 0;
    return true;
  }

  /** True once the bot has played NO_PROGRESS_TICKS without moving PROGRESS_PX or firing. Then it starts counting again. */
  private stalled(w: BotWorld, t: TankState): boolean {
    const progress =
      w.k <= w.playAt ||
      Math.hypot(t.x - this.progressX, t.y - this.progressY) > PROGRESS_PX ||
      w.shotAt(this.seat) >= this.progressAt;
    const stalled = !progress && w.k - this.progressAt >= NO_PROGRESS_TICKS;
    if (progress || stalled) {
      this.progressX = t.x;
      this.progressY = t.y;
      this.progressAt = w.k;
    }
    return stalled;
  }

  /** Cells holding mines this bot knows about and must not drive into. */
  private mineCells(w: BotWorld, t: TankState): Uint8Array {
    const n = w.maze.w * w.maze.h;
    if (this.blocked.length < n) this.blocked = new Uint8Array(n);
    this.blocked.fill(0, 0, n);
    const rule = this.skill.mines;
    for (const p of w.projectiles) {
      if (p.kind !== Proj.Mine) continue;
      const known = rule === 'all' || p.owner === t.seat || (rule === 'team' && sameTeam(p.team, t.team));
      if (known) this.blocked[cellIndex(w.maze, p.x, p.y)] = 1;
    }
    return this.blocked;
  }

  /** Where to face while holding still: the nearest enemy, else keep the heading. */
  private watch(t: TankState, enemies: readonly TankState[]): number {
    const look = this.nearest(t, enemies);
    return look ? Math.atan2(look.y - t.y, look.x - t.x) : t.a;
  }

  private nearest(t: TankState, tanks: readonly TankState[]): TankState | null {
    let best: TankState | null = null;
    for (const o of tanks) if (!best || dist(t, o) < dist(t, best)) best = o;
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // Shooting

  /** Decides whether to fire this plan. Returns the heading to turn to or hold for a shot, or null to keep moving. */
  private shoot(w: BotWorld, t: TankState, enemies: readonly TankState[]): number | null {
    const k = w.k;
    if (k < t.frozenUntil) return null;
    // A hard bot uses its spawn protection to get moving, and only shoots once it is about to run out anyway.
    if (this.level === 'hard' && t.protectUntil > k + this.skill.plan) return null;
    switch (t.weapon) {
      case Weapon.Gun:
      case Weapon.Frag:
        return this.take(this.lineUp(w, t, enemies, t.weapon === Weapon.Gun ? Proj.Bullet : Proj.Frag), k);
      case Weapon.Gatling: {
        const shot = this.lineUp(w, t, enemies, Proj.Gatling);
        // Spin up while lining up, so the barrel is turning when the shot opens, and keep the heading while it fires.
        if (shot && (shot.now || Math.abs(wrapAngle(shot.aim - t.a)) < 0.3)) this.hold();
        return shot?.aim ?? null;
      }
      case Weapon.Shotgun:
        return this.take(this.lineUp(w, t, enemies.filter((e) => dist(t, e) < SHOTGUN_RANGE), Proj.Pellet), k);
      case Weapon.Laser:
        return this.take(this.lineUp(w, t, enemies, null), k);
      case Weapon.Homing:
      case Weapon.Rc:
        return this.launchMissile(w, t, enemies);
      case Weapon.Mines:
        this.maybeDropMine(w, t, enemies);
        return null;
      case Weapon.DeathRay: {
        const target = this.nearest(
          t,
          enemies.filter((e) => e.protectUntil <= k && e.shieldUntil <= k && dist(t, e) < DEATH_RAY_RANGE),
        );
        if (!target) return null;
        const a = Math.atan2(target.y - t.y, target.x - t.x);
        if (Math.abs(wrapAngle(a - t.a)) < 0.3) this.press();
        return a;
      }
    }
  }

  /**
   * Looks for a shot with a projectile kind (null for the laser): whether the current heading already hits,
   * and otherwise the best angle to turn to (direct, banked off one wall, or for hard bots a two-bounce search).
   */
  private lineUp(w: BotWorld, t: TankState, enemies: readonly TankState[], kind: Proj | null): { now: boolean; aim: number } | null {
    const m = w.maze;
    const o = shotOrigin(t, m);
    const gameSpeed = GAME_SPEEDS[w.settings.speed] ?? 1;
    const stats = kind === null ? null : PROJ_STATS[kind];
    const speed = stats ? stats.speed * gameSpeed : Infinity;
    const range = stats ? Math.min(MAX_SHOT, speed * stats.life * DT) : LASER.maxLength;
    const bounces = kind === Proj.Bullet ? w.settings.bounces : stats ? (stats.bounces < 0 ? 3 : stats.bounces) : LASER.maxReflections;
    const depth = Math.min(this.skill.bankDepth, bounces);
    // Trace one bounce past the plan, so a shot that comes straight back is turned down.
    // The laser always traces its full path: every reflection can hit, including the shooter.
    const traceDepth = kind === null ? LASER.maxReflections : Math.min(bounces, depth + 1);
    const marks = this.marks(w, t, enemies, o, speed, kind === null);
    if (!marks.some((mk) => mk.enemy)) return null;
    const minRange = kind === Proj.Frag ? SHRAPNEL_REACH + TANK_RADIUS : 0;
    const probe = (a: number) => {
      // Trace from where the muzzle will be once the tank has turned to a.
      const from = shotOrigin({ ...t, a }, m);
      const r = walk(tracePath(m, from.x, from.y, a, traceDepth, range).pts, marks);
      return { ...r, hit: !!r.first?.enemy && r.at >= minRange };
    };

    // A traced ray has no width, so before firing a projectile, fly a real one: they part ways at wall corners.
    if (kind === null ? probe(t.a).hit : this.flies(w, t, kind, speed, range, marks, minRange)) return { now: true, aim: t.a };
    if (kind !== null && probe(t.a).hit) this.markBad(w.k, t);
    // Only headings the steer byte can reach are worth planning for, so candidates snap to it.
    const best = { a: 0, cost: Infinity };
    const tryByte = (b: number, penalty: number) => {
      if ((this.bad.get(b & 255) ?? 0) > w.k) return;
      const a = b * STEER_STEP;
      const cost = Math.abs(wrapAngle(a - t.a)) + penalty;
      if (cost >= best.cost || !probe(a).hit) return;
      best.a = a;
      best.cost = cost;
    };
    const consider = (a: number, penalty: number) => {
      const b = a / STEER_STEP;
      tryByte(Math.floor(b), penalty);
      if (Math.ceil(b) !== Math.floor(b)) tryByte(Math.ceil(b), penalty);
    };
    // Candidates are worked out from the tank centre, not the muzzle: the muzzle sits on the centre's ray at every
    // heading, so the angles stay right, and the same, while the tank turns toward them.
    const targets = marks.filter((mk) => mk.enemy).sort((a, b) => dist(t, a) - dist(t, b));
    for (const mk of targets) if (clearLine(m, t.x, t.y, mk.x, mk.y)) consider(Math.atan2(mk.y - t.y, mk.x - t.x), 0);
    if (depth >= 1) {
      for (const mk of targets.slice(0, MIRROR_TARGETS)) for (const a of this.mirrorAngles(m, t, mk)) consider(a, 0.3);
    }
    if (depth >= 2 && this.skill.fan > 0 && best.cost === Infinity) {
      const near: { b: number; miss: number }[] = [];
      const step = 256 / this.skill.fan;
      for (let b = 0; b < 256; b += step) {
        const r = probe(b * STEER_STEP);
        if (r.hit) tryByte(b, 0.5);
        else if (r.miss < TILE) near.push({ b, miss: r.miss });
      }
      near.sort((a, b) => a.miss - b.miss);
      const reach = Math.floor(step / 2);
      for (const n of near.slice(0, REFINE_ANGLES)) for (let d = -reach; d <= reach; d++) if (d !== 0) tryByte(n.b + d, 0.5);
    }
    if (best.cost === Infinity) return null;
    return { now: false, aim: best.a + (this.rng() * 2 - 1) * this.skill.aimError };
  }

  /**
   * Flies the projectile the tank would fire now, step by step as the match will, against marks that move
   * as the bot expects. True when it reaches an enemy first, at least minRange px out.
   */
  private flies(w: BotWorld, t: TankState, kind: Proj, speed: number, range: number, marks: readonly Mark[], minRange: number): boolean {
    const m = w.maze;
    const o = shotOrigin(t, m);
    const bounces = kind === Proj.Bullet ? w.settings.bounces : undefined;
    const p = makeProj(kind, 0, t, o.x, o.y, t.a, 0, GAME_SPEEDS[w.settings.speed] ?? 1, { bounces });
    const steps = Math.ceil(range / (speed * DT));
    this.hits.length = 0;
    for (let k = 1; k <= steps; k++) {
      if (stepProjectile(p, m, k, this.hits) !== 'alive') return false;
      const time = k * DT;
      for (const mk of marks) {
        if (mk.self && p.hits === 0) continue;
        const dx = p.x - mk.x0 - mk.vx * time;
        const dy = p.y - mk.y0 - mk.vy * time;
        if (dx * dx + dy * dy <= mk.r * mk.r) return mk.enemy && speed * time >= minRange;
      }
    }
    return false;
  }

  /** The current heading looked good traced but not flown: skip it for a while unless the bot moves. */
  private markBad(k: number, t: TankState): void {
    if (Math.hypot(t.x - this.badX, t.y - this.badY) > 4) {
      this.bad.clear();
      this.badX = t.x;
      this.badY = t.y;
    }
    this.bad.set(angleByte(t.a), k + BAD_HEADING_TICKS);
  }

  /** Enemies to hit (led by their speed), and the bot, teammates and shields a shot must not reach first. */
  private marks(w: BotWorld, t: TankState, enemies: readonly TankState[], o: Point, speed: number, laser: boolean): Mark[] {
    const k = w.k;
    const still = (x: number, y: number, r: number, self = false): Mark => ({ x, y, r, enemy: false, self, x0: x, y0: y, vx: 0, vy: 0 });
    const marks: Mark[] = [still(t.x, t.y, TANK_RADIUS + 4, true)];
    for (const e of enemies) {
      if (e.protectUntil > k) continue;
      if (e.shieldUntil > k) {
        marks.push(still(e.x, e.y, SHIELD_RADIUS + 2));
        continue;
      }
      const seen = this.seen[e.seat];
      const vx = (seen?.vx ?? 0) * this.skill.lead;
      const vy = (seen?.vy ?? 0) * this.skill.lead;
      const time = Number.isFinite(speed) ? dist(o, e) / speed : 0;
      marks.push({
        x: e.x + vx * time,
        y: e.y + vy * time,
        r: laser ? Math.min(this.skill.hitMargin, TANK_HALF_W + 2) : this.skill.hitMargin,
        enemy: true,
        self: false,
        x0: e.x,
        y0: e.y,
        vx,
        vy,
      });
    }
    if (w.settings.friendlyFire) {
      for (const o2 of w.tanks) {
        if (o2.alive && o2.seat !== t.seat && sameTeam(o2.team, t.team)) marks.push(still(o2.x, o2.y, TANK_RADIUS + 6));
      }
    }
    return marks;
  }

  /** Angles that bounce a straight shot off one wall face onto the target: aim at its mirror image. */
  private mirrorAngles(m: MazeState, o: Point, target: Point): number[] {
    const out: number[] = [];
    const half = WALL / 2;
    const add = (x: number, y: number) => out.push(Math.atan2(y - o.y, x - o.x));
    const loX = Math.min(o.x, target.x);
    const hiX = Math.max(o.x, target.x);
    for (let c = 0; c <= m.w; c++) {
      const right = c * TILE + half;
      if (right < loX && loX - right < MIRROR_REACH) add(2 * right - target.x, target.y);
      const left = c * TILE - half;
      if (left > hiX && left - hiX < MIRROR_REACH) add(2 * left - target.x, target.y);
    }
    const loY = Math.min(o.y, target.y);
    const hiY = Math.max(o.y, target.y);
    for (let r = 0; r <= m.h; r++) {
      const down = r * TILE + half;
      if (down < loY && loY - down < MIRROR_REACH) add(target.x, 2 * down - target.y);
      const up = r * TILE - half;
      if (up > hiY && up - hiY < MIRROR_REACH) add(target.x, 2 * up - target.y);
    }
    return out;
  }

  /** Homing and RC missiles: launch along the maze path toward the nearest reachable enemy. */
  private launchMissile(w: BotWorld, t: TankState, enemies: readonly TankState[]): number | null {
    const m = w.maze;
    let target = -1;
    let best = Infinity;
    for (const e of enemies) {
      const d = this.distances[cellIndex(m, e.x, e.y)]!;
      if (d >= 0 && d < best && d <= MISSILE_RANGE) {
        best = d;
        target = cellIndex(m, e.x, e.y);
      }
    }
    if (target < 0) return null;
    const enemy = enemies.find((e) => cellIndex(m, e.x, e.y) === target)!;
    const o = shotOrigin(t, m);
    const direct = clearLine(m, o.x, o.y, enemy.x, enemy.y);
    const toward = direct || best === 0 ? enemy : centreOf(m, this.pathTo(m, this.distances, target)[0]!);
    const a = Math.atan2(toward.y - t.y, toward.x - t.x);
    // A homing missile flies straight for a while and bounces back deadly from a near wall. RC steers, so needs less.
    const need = t.weapon === Weapon.Homing ? HOMING_RUN : RC_RUN;
    if ((raycast(m, o.x, o.y, Math.cos(a), Math.sin(a), need)?.dist ?? need) < need) return null;
    if (Math.abs(wrapAngle(a - t.a)) < 0.2) {
      this.press();
      return null;
    }
    return a;
  }

  /** Mines go down behind the bot as it drives away: when an enemy follows, or now and then on the move. */
  private maybeDropMine(w: BotWorld, t: TankState, enemies: readonly TankState[]): void {
    if (this.move.kind !== 'drive' || !(t.bits & Input.Fwd)) return;
    const m = w.maze;
    const chaser = enemies.some((e) => {
      const d = this.distances[cellIndex(m, e.x, e.y)]!;
      const behind = Math.abs(wrapAngle(Math.atan2(e.y - t.y, e.x - t.x) - t.a)) > 2;
      return d >= 2 && d <= MINE_CHASE_CELLS && behind;
    });
    if (chaser || this.rng() < 0.08) this.press();
  }

  private detonateFrag(w: BotWorld, t: TankState, frag: ProjState, enemies: readonly TankState[]): void {
    if (w.k - frag.bornAt < FRAG.minDetonateTicks) return;
    if (dist(t, frag) < SHRAPNEL_REACH && clearLine(w.maze, frag.x, frag.y, t.x, t.y)) return;
    if (enemies.some((e) => dist(e, frag) < FRAG_TRIGGER && clearLine(w.maze, frag.x, frag.y, e.x, e.y, true))) this.press();
  }

  /** While an RC missile flies: steer it along the maze toward the nearest enemy and blow it up beside them. */
  private steerMissile(w: BotWorld, t: TankState, enemies: readonly TankState[]): void {
    const m = w.maze;
    const p = w.projectiles.find((q) => q.id === t.rc);
    if (!p) {
      this.move = STOP;
      return;
    }
    if (this.missileDist.length < m.w * m.h) this.missileDist = new Int16Array(m.w * m.h);
    const from = cellIndex(m, p.x, p.y);
    const d = bfs(m, from % m.w, Math.floor(from / m.w), this.missileDist);
    let target: TankState | null = null;
    let best = Infinity;
    for (const e of enemies) {
      const de = d[cellIndex(m, e.x, e.y)]!;
      const score = de < 0 ? Infinity : de * TILE + dist(p, e) * 0.01;
      if (score < best) {
        best = score;
        target = e;
      }
    }
    if (!target) {
      this.move = { kind: 'missile', id: p.id, x: p.x + p.vx, y: p.y + p.vy };
      return;
    }
    const blast = BLAST[Weapon.Rc]!.r;
    if (dist(p, target) < blast * 0.8 && dist(p, t) > blast + TANK_RADIUS) this.press();
    let goal: Point = target;
    if (!clearLine(m, p.x, p.y, target.x, target.y)) {
      goal = centreOf(m, this.pathTo(m, d, cellIndex(m, target.x, target.y))[0]!);
    }
    this.move = { kind: 'missile', id: p.id, x: goal.x, y: goal.y };
  }

  // -------------------------------------------------------------------------------------------
  // Dodging

  /** The soonest projectile that will pass through the bot within THREAT_SECONDS. */
  private threat(w: BotWorld, t: TankState): ProjState | null {
    let best: ProjState | null = null;
    let soonest = Infinity;
    for (const p of w.projectiles) {
      if (p.kind === Proj.Mine || (p.owner === t.seat && !p.deadly)) continue;
      if (!w.settings.friendlyFire && p.owner !== t.seat && sameTeam(p.team, t.team)) continue;
      const rx = t.x - p.x;
      const ry = t.y - p.y;
      if (rx * rx + ry * ry > THREAT_RANGE * THREAT_RANGE) continue;
      const v2 = p.vx * p.vx + p.vy * p.vy;
      if (v2 === 0) continue;
      const when = (rx * p.vx + ry * p.vy) / v2;
      if (when < 0 || when > THREAT_SECONDS || when >= soonest) continue;
      const reach = TANK_RADIUS + p.r + 4;
      if ((rx - p.vx * when) ** 2 + (ry - p.vy * when) ** 2 > reach * reach) continue;
      if (!clearLine(w.maze, p.x, p.y, t.x, t.y)) continue;
      best = p;
      soonest = when;
    }
    return best;
  }

  /** Drives forward or back along the hull, whichever ends farther from the projectile's line. */
  private dodge(w: BotWorld, t: TankState, p: ProjState): boolean {
    const c = Math.cos(t.a);
    const s = Math.sin(t.a);
    const speed = Math.hypot(p.vx, p.vy);
    const ux = p.vx / speed;
    const uy = p.vy / speed;
    const missAt = (x: number, y: number) => Math.abs((x - p.x) * uy - (y - p.y) * ux);
    let bits = 0;
    let best = missAt(t.x, t.y);
    for (const dir of [1, -1]) {
      const room = (raycast(w.maze, t.x, t.y, c * dir, s * dir, 3 * TILE)?.dist ?? 3 * TILE) - TANK_HALF_L;
      const step = Math.min(room, TILE / 2);
      if (step < 6) continue;
      const miss = missAt(t.x + c * dir * step, t.y + s * dir * step);
      if (miss > best) {
        best = miss;
        bits = dir > 0 ? Input.Fwd : Input.Back;
      }
    }
    if (bits) {
      this.move = { kind: 'raw', bits };
      return true;
    }
    // Coming straight along the hull: driving forward or back cannot help, so turn and drive out sideways.
    let side = 0;
    let room = SIDESTEP;
    for (const dir of [1, -1]) {
      const r = raycast(w.maze, t.x, t.y, -uy * dir, ux * dir, 2 * TILE)?.dist ?? 2 * TILE;
      if (r - TANK_HALF_W > room) {
        room = r - TANK_HALF_W;
        side = dir;
      }
    }
    if (!side) return false;
    this.move = { kind: 'raw', bits: Input.Steer | Input.Fwd, steer: angleByte(Math.atan2(ux * side, -uy * side)) };
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Navigation

  private navigate(w: BotWorld, t: TankState, enemies: readonly TankState[]): void {
    const m = w.maze;
    const here = cellIndex(m, t.x, t.y);
    const goal = this.goal(w, t, enemies);
    if (goal === null) {
      this.move = STOP;
      return;
    }
    if (goal.cell === here) {
      this.move = dist(t, goal.at) < ARRIVED ? STOP : { kind: 'drive', x: goal.at.x, y: goal.at.y };
      return;
    }
    const path = this.pathTo(m, this.distances, goal.cell);
    let next = centreOf(m, path[0]!);
    for (let i = Math.min(path.length, STRING_PULL) - 1; i > 0; i--) {
      const at = i === path.length - 1 ? goal.at : centreOf(m, path[i]!);
      if (this.roomy(m, t, at)) {
        next = at;
        break;
      }
    }
    this.move = { kind: 'drive', x: next.x, y: next.y };
  }

  /** Where to go: out of the storm, away from a fight at 1 hp, to a crate, to the nearest enemy, or anywhere. */
  private goal(w: BotWorld, t: TankState, enemies: readonly TankState[]): { cell: number; at: Point } | null {
    const k = w.k;
    const m = w.maze;
    const n = m.w * m.h;
    const d = this.distances;
    const reachable = (cell: number) => d[cell]! >= 0;
    const pick = (score: (cell: number) => number) => {
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < n; i++) {
        if (!reachable(i)) continue;
        const s = score(i);
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      }
      return best;
    };
    const atCell = (cell: number) => ({ cell, at: centreOf(m, cell) });

    const safe = w.stormAt > 0 ? stormRect(m, Math.max(k + STORM_LOOKAHEAD, w.stormAt), w.stormAt) : null;
    if (safe && k + STORM_LOOKAHEAD >= w.stormAt) {
      const inside = (p: Point) => inRect({ x0: safe.x0 + 8, y0: safe.y0 + 8, x1: safe.x1 - 8, y1: safe.y1 - 8 }, p.x, p.y);
      if (!inside(t)) {
        const cell = pick((i) => (inside(centreOf(m, i)) ? -d[i]! : -Infinity));
        if (cell >= 0 && inside(centreOf(m, cell))) return atCell(cell);
      }
    }

    const threatened = enemies.some((e) => {
      const de = d[cellIndex(m, e.x, e.y)]!;
      return de >= 0 && de <= 3;
    });
    if (this.skill.careful && t.hp === 1 && t.shieldUntil <= k && threatened) {
      const repair = w.crates.find((c) => c.kind === Upgrade.Repair && reachable(c.cy * m.w + c.cx) && d[c.cy * m.w + c.cx]! <= this.skill.crateRange);
      if (repair) return atCell(repair.cy * m.w + repair.cx);
      const cell = pick((i) => (d[i]! > 6 ? -Infinity : Math.min(...enemies.map((e) => dist(centreOf(m, i), e)))));
      if (cell >= 0) return atCell(cell);
    }

    const crate = this.bestCrate(w, t);
    if (crate) return atCell(crate.cy * m.w + crate.cx);

    let target: TankState | null = null;
    let best = Infinity;
    for (const e of enemies) {
      const de = d[cellIndex(m, e.x, e.y)]!;
      if (de >= 0 && de < best) {
        best = de;
        target = e;
      }
    }
    if (target) return { cell: cellIndex(m, target.x, target.y), at: { x: target.x, y: target.y } };

    if (this.wanderTo < 0 || this.wanderTo === cellIndex(m, t.x, t.y) || !reachable(this.wanderTo)) {
      this.wanderTo = pick(() => this.rng());
    }
    return this.wanderTo >= 0 ? atCell(this.wanderTo) : null;
  }

  private bestCrate(w: BotWorld, t: TankState): Crate | null {
    const m = w.maze;
    let best: Crate | null = null;
    let bestScore = -Infinity;
    for (const c of w.crates) {
      const d = this.distances[c.cy * m.w + c.cx]!;
      if (d < 0 || d > this.skill.crateRange) continue;
      const value = this.crateValue(c.kind, t);
      if (value <= 0) continue;
      const score = this.skill.weighCrates ? value - d * 0.6 : -d;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private crateValue(kind: CrateKind, t: TankState): number {
    switch (kind) {
      case Upgrade.Repair:
        return t.hp < MAX_HP ? 4 + (MAX_HP - t.hp) * 3 : 0;
      case Upgrade.Shield:
        return 7;
      case Upgrade.Speed:
        return 4;
      case Upgrade.Aimer:
        return 1;
      default:
        return WEAPON_VALUE[kind] * (t.weapon === Weapon.Gun ? 1 : 0.3);
    }
  }

  /** Cells from the first step to the goal, given BFS distances from the start. Just [goal] when there or unreachable. */
  private pathTo(m: MazeState, d: Int16Array, goal: number): number[] {
    const path = [goal];
    let cell = goal;
    while (d[cell]! > 1) {
      const next = this.stepFrom(m, d, cell);
      if (next < 0) break;
      path.push(next);
      cell = next;
    }
    return path.reverse();
  }

  /** A neighbour of cell one step closer to the BFS origin, or -1. */
  private stepFrom(m: MazeState, d: Int16Array, cell: number): number {
    const cx = cell % m.w;
    const cy = Math.floor(cell / m.w);
    const want = d[cell]! - 1;
    if (want < 0) return -1;
    for (const dir of DIRS) {
      const nx = cx + DIR_X[dir];
      const ny = cy + DIR_Y[dir];
      if (canMove(m, cx, cy, dir) && d[ny * m.w + nx] === want) return ny * m.w + nx;
    }
    return -1;
  }

  /** Whether the tank's whole width fits along a straight line to the point. */
  private roomy(m: MazeState, t: TankState, to: Point): boolean {
    const dx = to.x - t.x;
    const dy = to.y - t.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return true;
    const ox = (-dy / len) * (TANK_HALF_W + 1);
    const oy = (dx / len) * (TANK_HALF_W + 1);
    return (
      clearLine(m, t.x, t.y, to.x, to.y) &&
      clearLine(m, t.x + ox, t.y + oy, to.x + ox, to.y + oy) &&
      clearLine(m, t.x - ox, t.y - oy, to.x - ox, to.y - oy)
    );
  }
}
