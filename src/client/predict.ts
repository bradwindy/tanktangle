import { BULLET_MAX_ACTIVE, DT, FIRE_COOLDOWN_TICKS, MUZZLE } from '../shared/constants';
import { decodeProj, decodeTank, type InputAck, type SnapMsg } from '../shared/protocol';
import { deflectOffShield, moveTank, separateTanks, shotOrigin, steerHoming, steerRc, stepProjectile, sweepHitsTank, type WallHit } from '../shared/sim';
import { Input, Proj, sameTeam, TankFlag, Weapon, type MazeState, type ProjState, type TankState } from '../shared/types';
import type { Point } from '../shared/vec';
import { DEATH_RAY, HOMING, LASER, MINES, PROJ_STATS, SHOTGUN } from '../shared/weapons';
import type { LocalEvent } from './view';

/** An input message as sent: seq, the tick it was stamped for, bits and steer byte. */
export interface SentInput {
  seq: number;
  k: number;
  bits: number;
  steer: number;
}

interface LogEntry extends SentInput {
  /** Tick it takes effect in the prediction, by the server's rule. */
  at: number;
}

export interface PredictOptions {
  maze: MazeState;
  playAt: number;
  /** GAME_SPEEDS[settings.speed]. */
  speed: number;
  friendlyFire: boolean;
  /** The local player's seat, -1 when spectating. */
  me: number;
  /** Team of a seat, from the room's player list. Not on the wire. */
  teamOf: (seat: number) => number;
}

export interface Pose {
  x: number;
  y: number;
  a: number;
}

/** A replay longer than this (a tab coming back from the background) jumps ahead instead of simulating every tick. */
const MAX_REPLAY = 240;
/** Shots whose end is a fizzle the client shows itself. Explosives end in the server's Boom event instead. */
const FIZZLES: ReadonlySet<number> = new Set([Proj.Bullet, Proj.Gatling, Proj.Pellet, Proj.Shrapnel]);
/** A frag bomb the client just launched counts as in flight this long, until snapshots show it. */
const FRAG_UNSEEN_TICKS = 30;

/**
 * The client's copy of the match: rebuilt from every snapshot at server tick K, then stepped with the shared sim
 * to the client tick L. The local tank replays the inputs it sent; other tanks repeat their last known input.
 * No damage, pickups or spawning happen here.
 */
export class Prediction {
  /** Last simulated tick (L). */
  tick = 0;
  tanks: TankState[] = [];
  projs: ProjState[] = [];
  /** Projectiles the client thinks hit a tank, waiting for the server to confirm. */
  readonly hidden = new Set<number>();
  /** Seats the last snapshot showed with a spinning gatling (server-only state). */
  readonly spinning = new Set<number>();
  /** Local events since the caller last drained them. */
  events: LocalEvent[] = [];
  /** Tank poses and projectile positions one tick before `tick`, for interpolation. */
  readonly prevTanks = new Map<number, Pose>();
  readonly prevProjs = new Map<number, Point>();
  private log: LogEntry[] = [];
  private snapK = -1;
  private base = { seq: 0, bits: 0, steer: 0 };
  /** Bounce and expire events are only produced for ticks above this, never again during a replay. */
  private emittedTick = -1;
  /** Newest input seq whose Fire press has been judged. Replays reuse the verdict instead of judging again. */
  private judgedSeq = 0;
  /** Presses judged to act, with the weapon they used, until the server acks them. */
  private firedSeqs = new Map<number, Weapon>();
  private lastShotTick = -Infinity;
  private fragAt = -Infinity;
  private hits: WallHit[] = [];
  private targets: Point[] = [];

  constructor(readonly opts: PredictOptions) {}

  get ready(): boolean {
    return this.snapK >= 0;
  }

  get maze(): MazeState {
    return this.opts.maze;
  }

  tankAt(seat: number): TankState | undefined {
    return this.tanks.find((t) => t.seat === seat);
  }

  get mine(): TankState | undefined {
    return this.opts.me >= 0 ? this.tankAt(this.opts.me) : undefined;
  }

  /** Seq numbering restarted (new socket or new match): forget everything sent before. */
  resetInputs(): void {
    this.log = [];
    this.judgedSeq = 0;
    this.firedSeqs.clear();
    this.lastShotTick = -Infinity;
    this.fragAt = -Infinity;
  }

  /** Records an input just sent. Like the server, it takes effect at max(k, previous entry's tick + 1). */
  sent(input: SentInput): void {
    const prev = this.log.at(-1)?.at ?? -Infinity;
    this.log.push({ ...input, at: Math.max(input.k, prev + 1) });
  }

  /** Rebuilds the world from a snapshot and re-simulates up to toTick. Returns the local tank's ack, if any. */
  applySnapshot(msg: SnapMsg, toTick: number): InputAck | null {
    const K = msg.k;
    // The same snapshot again is allowed: it rewinds to exactly the server's state (the final frame of a match).
    if (K < this.snapK) return null;
    this.snapK = K;
    const { me, teamOf } = this.opts;
    let ack: InputAck | null = null;
    this.spinning.clear();
    const tanks: TankState[] = [];
    for (const row of msg.T) {
      const { tank, flags, ack: tankAck } = decodeTank(row, K);
      tank.team = teamOf(tank.seat);
      if (flags & TankFlag.Spinning) this.spinning.add(tank.seat);
      if (tank.seat === me) {
        ack = tankAck;
        this.base = { seq: 0, bits: tank.bits, steer: tank.steer };
      }
      tanks.push(tank);
    }
    tanks.sort((a, b) => a.seat - b.seat);
    this.tanks = tanks;
    this.projs = msg.P.map((row) => {
      const p = decodeProj(row, K);
      p.team = teamOf(p.owner);
      return p;
    });
    this.hidden.clear();
    if (ack) this.schedule(ack, K);
    this.tick = K;
    this.savePrev();
    const end = Math.min(toTick, K + MAX_REPLAY);
    while (this.tick < end) this.step();
    if (this.tick < toTick) this.jumpTo(toTick);
    return ack;
  }

  /**
   * The server applied everything up to ack.seq by tick K. The latest acked input is already in the snapshot's bits;
   * each later one takes effect at max(k, K + 1, previous entry's tick + 1), the same rule the server uses.
   */
  private schedule(ack: InputAck, K: number): void {
    this.log = this.log.filter((e) => e.seq > ack.seq);
    for (const seq of this.firedSeqs.keys()) if (seq <= ack.seq) this.firedSeqs.delete(seq);
    let prev = ack.tick;
    for (const e of this.log) {
      e.at = Math.max(e.k, K + 1, prev + 1);
      prev = e.at;
    }
  }

  /** Skips ahead without simulating. The next snapshot puts everything right. */
  jumpTo(tick: number): void {
    if (tick <= this.tick) return;
    this.tick = tick;
    this.emittedTick = Math.max(this.emittedTick, tick);
    this.savePrev();
  }

  /** Simulates one tick. */
  step(): void {
    const k = this.tick + 1;
    const live = k > this.emittedTick;
    this.savePrev();
    const { maze, playAt, speed } = this.opts;
    const mine = this.mine;
    if (mine) {
      const input = this.inputAt(k);
      const wasFiring = (mine.bits & Input.Fire) !== 0;
      mine.bits = input.bits;
      mine.steer = input.steer;
      if (k >= playAt && !wasFiring && (input.bits & Input.Fire) !== 0) this.ownPress(mine, k, input.seq);
    }
    if (k >= playAt) {
      for (const t of this.tanks) moveTank(t, maze, k, speed);
      separateTanks(this.tanks, maze);
      this.stepProjectiles(k, live);
    }
    this.tick = k;
    if (live) this.emittedTick = k;
  }

  private inputAt(k: number): { seq: number; bits: number; steer: number } {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!;
      if (e.at <= k) return e;
    }
    return this.base;
  }

  private savePrev(): void {
    this.prevTanks.clear();
    for (const t of this.tanks) this.prevTanks.set(t.seat, { x: t.x, y: t.y, a: t.a });
    this.prevProjs.clear();
    for (const p of this.projs) this.prevProjs.set(p.id, { x: p.x, y: p.y });
  }

  /** The local player pressed Fire on tick k: predict what the server will do with it. */
  private ownPress(t: TankState, k: number, seq: number): void {
    const able = t.alive && k >= t.frozenUntil && t.chargeUntil <= k && t.rc === 0;
    const fresh = seq > this.judgedSeq;
    let fires: boolean;
    if (fresh) {
      this.judgedSeq = seq;
      fires = able && !this.ownsFrag(t, k) && this.canShoot(t, k);
      if (fires) {
        this.firedSeqs.set(seq, t.weapon);
        this.lastShotTick = k;
      }
    } else {
      // A replay keeps the first verdict, so a press is never judged twice.
      fires = able && this.firedSeqs.has(seq);
    }
    if (!fires) return;
    const weapon = t.weapon;
    // Like the server: a shot, a gatling spin-up and a death ray charge all end spawn protection.
    t.protectUntil = 0;
    // The gatling spins up and its rounds come from the server.
    if (weapon === Weapon.Gatling) return;
    if (weapon === Weapon.DeathRay) {
      t.chargeUntil = k + DEATH_RAY.chargeTicks;
      return;
    }
    if (weapon === Weapon.Laser) t.frozenUntil = k + LASER.recoilTicks;
    else if (weapon === Weapon.Rc) t.rc = -1;
    else if (weapon === Weapon.Frag) this.fragAt = k;
    if (fresh) this.events.push({ e: 'muzzle', seat: t.seat, ...this.muzzleAt(t), a: t.a, weapon });
    if (weapon !== Weapon.Gun && --t.ammo <= 0) {
      t.weapon = Weapon.Gun;
      t.ammo = 0;
    }
  }

  /** With a frag bomb in flight a press only detonates it. A bomb just launched is not in a snapshot yet. */
  private ownsFrag(t: TankState, k: number): boolean {
    return k - this.fragAt < FRAG_UNSEEN_TICKS || this.projs.some((p) => p.kind === Proj.Frag && p.owner === t.seat);
  }

  private canShoot(t: TankState, k: number): boolean {
    const since = k - this.lastShotTick;
    switch (t.weapon) {
      case Weapon.Gun: {
        // Own bullets are never predicted: count the snapshot's and the shots the server has not applied yet.
        let live = 0;
        for (const p of this.projs) if (p.kind === Proj.Bullet && p.owner === t.seat) live++;
        for (const weapon of this.firedSeqs.values()) if (weapon === Weapon.Gun) live++;
        return since >= FIRE_COOLDOWN_TICKS && live < BULLET_MAX_ACTIVE;
      }
      case Weapon.Shotgun:
        return t.ammo > 0 && since >= SHOTGUN.cooldownTicks;
      case Weapon.Mines:
        return t.ammo > 0 && since >= MINES.cooldownTicks;
      default:
        return t.ammo > 0;
    }
  }

  /** Where the shot leaves the tank. Mines drop from the rear. */
  private muzzleAt(t: TankState): Point {
    if (t.weapon !== Weapon.Mines) return shotOrigin(t, this.maze);
    return { x: t.x - Math.cos(t.a) * MUZZLE, y: t.y - Math.sin(t.a) * MUZZLE };
  }

  private stepProjectiles(k: number, live: boolean): void {
    const maze = this.maze;
    const hits = this.hits;
    let n = 0;
    for (const p of this.projs) {
      this.steer(p, k);
      hits.length = 0;
      const x0 = p.x;
      const y0 = p.y;
      const result = stepProjectile(p, maze, k, hits);
      const shown = live && !this.hidden.has(p.id);
      if (shown) {
        const bounces = result === 'wall' ? hits.length - 1 : hits.length;
        for (let i = 0; i < bounces; i++) this.events.push({ e: 'bounce', x: hits[i]!.x, y: hits[i]!.y, kind: p.kind });
      }
      if (result !== 'alive') {
        if (shown && FIZZLES.has(p.kind)) {
          const end: Point = result === 'wall' ? hits[hits.length - 1]! : p;
          this.events.push({ e: 'expire', x: end.x, y: end.y, kind: p.kind });
        }
        this.hidden.delete(p.id);
        continue;
      }
      if (!this.hidden.has(p.id)) this.touchTanks(p, k, x0, y0);
      this.projs[n++] = p;
    }
    this.projs.length = n;
  }

  private steer(p: ProjState, k: number): void {
    if (p.kind === Proj.Homing) {
      if (p.aux === 0 && k - p.bornAt >= HOMING.straightTicks) {
        p.aux = 1;
        p.deadly = true;
      }
      if (p.aux === 1) steerHoming(p, this.maze, this.targetsFor(p, k), DT);
    } else if (p.kind === Proj.Rc) {
      const owner = this.tankAt(p.owner);
      if (owner && owner.rc === p.id) steerRc(p, owner.bits, DT, owner.steer);
    } else if (p.kind === Proj.Mine && p.aux === 0 && k - p.bornAt >= MINES.armTicks) {
      p.aux = 1;
    }
  }

  /** Living enemies of the projectile's owner that are not spawn protected. */
  private targetsFor(p: ProjState, k: number): Point[] {
    const out = this.targets;
    out.length = 0;
    for (const t of this.tanks) {
      if (t.alive && t.seat !== p.owner && !sameTeam(t.team, p.team) && t.protectUntil <= k) out.push(t);
    }
    return out;
  }

  /**
   * Mirrors the server's skip rules: owner unless deadly, friendly-fire-blocked teammates, protected tanks. Shields
   * reflect. Like the server, a hit is anywhere along the projectile's move this tick, from (x0, y0).
   */
  private touchTanks(p: ProjState, k: number, x0: number, y0: number): void {
    if (PROJ_STATS[p.kind].damage === 0) return;
    const friendlyFire = this.opts.friendlyFire;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const own = t.seat === p.owner;
      if (own && !p.deadly) continue;
      if (!own && !friendlyFire && sameTeam(t.team, p.team)) continue;
      if (t.protectUntil > k) continue;
      if (t.shieldUntil > k) {
        deflectOffShield(p, t);
        continue;
      }
      if (sweepHitsTank(t, x0, y0, p.x, p.y, p.r)) {
        this.hidden.add(p.id);
        return;
      }
    }
  }
}
