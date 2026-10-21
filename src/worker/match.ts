import {
  AUTO_FIRE_TICKS,
  BRICK_HP,
  BRICK_RATIOS,
  BRICK_REGROW_TICKS,
  BULLET_MAX_ACTIVE,
  COUNTDOWN_TICKS,
  DT,
  FIRE_COOLDOWN_TICKS,
  GAME_SPEEDS,
  KILL_CREDIT_TICKS,
  MAX_HP,
  MAX_INPUT_LEAD_TICKS,
  MAX_QUEUED_INPUTS,
  OVERTIME_MAX_TICKS,
  RESPAWN_TICKS,
  SHIELD_RADIUS,
  SNAP_EVERY,
  SPAWN_PROTECT_TICKS,
  STORM_DAMAGE_EVERY,
  STORM_START_TICKS,
  TANK_HALF_L,
  TANK_RADIUS,
  TICK_HZ,
} from '../shared/constants';
import { cellCenter, encodeMaze, wallRect } from '../shared/grid';
import { generateMaze, mazeSizeFor, spreadCells } from '../shared/maze';
import {
  crateRow,
  encodeEvent,
  encodeProj,
  encodeTank,
  Ev,
  type EventRow,
  type GameEvent,
  type InputAck,
  type MatchMsg,
  type MatchResult,
  type SnapMsg,
} from '../shared/protocol';
import { randRange, type Rng } from '../shared/rng';
import type { Settings } from '../shared/settings';
import {
  circleHitsTank,
  circleTouchesRect,
  circleTouchesWall,
  clearLine,
  deathRayPath,
  deflectOffShield,
  inRect,
  makeProj,
  moveTank,
  segmentHitsTank,
  separateTanks,
  shotOrigin,
  steerHoming,
  steerRc,
  stepProjectile,
  stormRect,
  tankOverlapsRect,
  tracePath,
  wallsAlongPath,
  wallsInCircle,
  type Circle,
  type WallHit,
} from '../shared/sim';
import {
  CAUSE_STORM,
  Input,
  INPUT_MASK,
  Proj,
  sameTeam,
  TankFlag,
  Upgrade,
  WallKind,
  Weapon,
  type BotLevel,
  type Crate,
  type CrateKind,
  type MazeState,
  type ProjState,
  type Rect,
  type TankState,
} from '../shared/types';
import { TAU, type Point } from '../shared/vec';
import {
  BLAST,
  CRATE_CAP,
  CRATE_HALF,
  CRATE_INTERVAL_JITTER,
  CRATE_INTERVAL_S,
  DEATH_RAY,
  FRAG,
  GATLING,
  HOMING,
  LASER,
  MINES,
  PROJ_STATS,
  SHOTGUN,
  UPGRADE_TICKS,
  WEAPON_AMMO,
} from '../shared/weapons';
import { Bot, type BotWorld } from './bot';
import { crateCell, crateKind, openAngle, spawnCell } from './placement';
import { newScore, pickAwards, rank, type SeatScore } from './results';

export interface MatchSeat {
  seat: number;
  team: number;
  /** Public player id, used in the result. */
  id: string;
  bot: BotLevel | null;
}

export interface MatchOptions {
  id: number;
  settings: Settings;
  /** Seats 0 to n - 1, in seat order. */
  seats: readonly MatchSeat[];
  rng: Rng;
  /** A fixed maze instead of a generated one (tests). */
  maze?: MazeState;
}

interface QueuedInput {
  seq: number;
  k: number;
  bits: number;
  steer: number;
  margin: number;
}

export interface Seat {
  readonly seat: number;
  readonly id: string;
  readonly tank: TankState;
  readonly bot: Bot | null;
  readonly score: SeatScore;
  /** False once the player left the match. Their tank is gone for good. */
  present: boolean;
  queue: QueuedInput[];
  lastSeq: number;
  ack: InputAck;
  /** Bits applied on the previous tick, for fire edges. */
  prevBits: number;
  /** Tick to respawn at, 0 when not waiting. */
  respawnAt: number;
  lifeStart: number;
  /** Last enemy to damage this tank, for kill credit, -1 for none. */
  lastDamager: number;
  lastDamagedAt: number;
  lastShotAt: number;
  spinning: boolean;
  spunBefore: boolean;
  spinReadyAt: number;
  nextRoundAt: number;
  /** Id of this tank's live frag bomb, 0 for none. */
  fragId: number;
}

interface Blast {
  x: number;
  y: number;
  kind: Weapon;
  owner: number;
  team: number;
  /** The shot that caused it, for accuracy stats. 0 for none. */
  shot: number;
}

const NO_SHOT = -1_000_000;
const FIRST_CRATE_TICKS = 2 * TICK_HZ;
const REGROW_RETRY_TICKS = TICK_HZ;
const MAX_MARGIN = 999;

const PROJ_CAUSE: Record<Proj, Weapon> = {
  [Proj.Bullet]: Weapon.Gun,
  [Proj.Gatling]: Weapon.Gatling,
  [Proj.Pellet]: Weapon.Shotgun,
  [Proj.Shrapnel]: Weapon.Frag,
  [Proj.Homing]: Weapon.Homing,
  [Proj.Frag]: Weapon.Frag,
  [Proj.Mine]: Weapon.Mines,
  [Proj.Rc]: Weapon.Rc,
};

const isExplosive = (kind: Proj) => kind === Proj.Homing || kind === Proj.Frag || kind === Proj.Rc || kind === Proj.Mine;

/**
 * One match: the authoritative world and every rule. Pure: no Durable Object APIs, no wall clock, randomness from rng.
 * Time moves only through tick(), one fixed step of DT. Tick 0 is the countdown start.
 */
export class Match implements BotWorld {
  readonly id: number;
  readonly settings: Settings;
  readonly maze: MazeState;
  readonly seats: Seat[];
  /** The seats' tanks by seat. A tank that left stays here, dead. */
  readonly tanks: TankState[];
  projectiles: ProjState[] = [];
  crates: Crate[] = [];
  k = 0;
  readonly playAt = COUNTDOWN_TICKS;
  readonly stormAt: number;
  readonly endAt: number;
  overtime = false;
  over = false;
  result: MatchResult | null = null;
  /** Bumps whenever a kills, deaths, lives or out value changes. */
  version = 0;

  private readonly rng: Rng;
  private readonly speed: number;
  private readonly crateCap: number;
  private nextCrateAt: number;
  private nextId = 1;
  private nextCrateId = 1;
  private pending: EventRow[] = [];
  private blasts: Blast[] = [];
  private dead = new Set<number>();
  private blocked = new Set<number>();
  private shrapnelCause = new Map<number, Weapon>();
  private hitShots = new Set<number>();
  /** Broken bricks by wall id, with the tick they try to regrow. */
  private broken = new Map<number, number>();
  private hits: WallHit[] = [];

  constructor(opts: MatchOptions) {
    this.id = opts.id;
    this.settings = opts.settings;
    this.rng = opts.rng;
    this.speed = GAME_SPEEDS[opts.settings.speed] ?? 1;
    const n = opts.seats.length;
    const lives = opts.settings.mode === 'lives';
    this.stormAt = lives ? this.playAt + STORM_START_TICKS : 0;
    this.endAt = lives ? 0 : this.playAt + opts.settings.minutes * 60 * TICK_HZ;
    if (opts.maze) {
      this.maze = opts.maze;
    } else {
      const size = mazeSizeFor(n, opts.settings.mazeSize);
      this.maze = generateMaze(this.rng, { ...size, brickRatio: BRICK_RATIOS[opts.settings.bricks] ?? 0.5 });
    }
    const powerups = opts.settings.powerups;
    this.crateCap = powerups > 0 ? (CRATE_CAP[powerups] ?? 0) + Math.floor(n / 4) : 0;
    this.nextCrateAt = this.playAt + FIRST_CRATE_TICKS;

    const cells = spreadCells(this.maze, n, this.rng);
    this.seats = opts.seats.map((s, i) => {
      const cell = cells[i] ?? { cx: 0, cy: 0 };
      const at = cellCenter(cell.cx, cell.cy);
      const tank: TankState = {
        seat: s.seat,
        team: s.team,
        x: at.x,
        y: at.y,
        a: openAngle(this.maze, cell),
        hp: MAX_HP,
        alive: true,
        bits: 0,
        steer: 0,
        weapon: Weapon.Gun,
        ammo: 0,
        frozenUntil: 0,
        chargeUntil: 0,
        rc: 0,
        shieldUntil: 0,
        speedUntil: 0,
        aimerUntil: 0,
        protectUntil: 0,
      };
      this.emit({ e: Ev.Spawn, seat: s.seat, x: tank.x, y: tank.y, a: tank.a });
      return {
        seat: s.seat,
        id: s.id,
        tank,
        bot: s.bot ? new Bot(s.seat, s.bot, this.rng) : null,
        score: newScore(lives ? opts.settings.lives : 0),
        present: true,
        queue: [],
        lastSeq: 0,
        ack: { seq: 0, tick: 0, margin: 0 },
        prevBits: 0,
        respawnAt: 0,
        lifeStart: this.playAt,
        lastDamager: -1,
        lastDamagedAt: 0,
        lastShotAt: NO_SHOT,
        spinning: false,
        spunBefore: false,
        spinReadyAt: 0,
        nextRoundAt: 0,
        fragId: 0,
      };
    });
    this.tanks = this.seats.map((s) => s.tank);
  }

  // -------------------------------------------------------------------------------------------
  // Inputs

  /** Queues a person's input. Stale seqs are ignored; inputs stamped too far ahead apply now. */
  queueInput(seat: number, seq: number, k: number, bits: number, steer: number): void {
    const s = this.seats[seat];
    if (!s || !s.present || s.bot || seq <= s.lastSeq) return;
    s.lastSeq = seq;
    const next = this.k + 1;
    const margin = Math.max(-MAX_MARGIN, Math.min(MAX_MARGIN, k - next));
    s.queue.push({ seq, k: k > next + MAX_INPUT_LEAD_TICKS ? next : k, bits: bits & INPUT_MASK, steer: steer & 255, margin });
    if (s.queue.length > MAX_QUEUED_INPUTS) s.queue.shift();
  }

  /** A socket bound to the seat (join or reconnect): its client starts counting seqs from 1 again. */
  resetInput(seat: number): void {
    const s = this.seats[seat];
    if (!s) return;
    s.queue = [];
    s.lastSeq = 0;
    s.ack = { seq: 0, tick: 0, margin: 0 };
  }

  /** The seat's socket dropped: stop driving and firing until it comes back. */
  releaseInput(seat: number): void {
    const s = this.seats[seat];
    if (!s) return;
    s.queue = [];
    s.tank.bits = 0;
    s.tank.steer = 0;
  }

  /** The player left for good. Their tank is removed, and in lives mode they are out. */
  removeSeat(seat: number): void {
    const s = this.seats[seat];
    if (!s || !s.present) return;
    s.present = false;
    s.queue = [];
    this.endLife(s);
    const t = s.tank;
    t.alive = false;
    t.bits = 0;
    if (t.rc) this.removeById(t.rc);
    s.respawnAt = 0;
    if (!s.score.out) {
      s.score.out = true;
      s.score.outTick = this.k;
    }
    if (this.settings.mode === 'lives') s.score.lives = 0;
    this.version++;
  }

  private applyInputs(): void {
    for (const s of this.seats) {
      if (!s.present) continue;
      if (s.bot) {
        s.bot.drive(this, s.tank);
        continue;
      }
      const head = s.queue[0];
      if (!head || head.k > this.k) continue;
      s.queue.shift();
      s.tank.bits = head.bits;
      s.tank.steer = head.steer;
      s.ack = { seq: head.seq, tick: this.k, margin: head.margin };
    }
  }

  // -------------------------------------------------------------------------------------------
  // The tick

  /** Runs one tick. Returns a snapshot when one is due, and always on the tick the match ends. */
  tick(): SnapMsg | null {
    if (this.over) return null;
    const k = ++this.k;
    this.applyInputs();
    if (k >= this.playAt) {
      if (k === this.stormAt) this.emit({ e: Ev.Storm });
      for (const s of this.seats) this.updateTank(s);
      for (const t of this.tanks) if (t.alive) moveTank(t, this.maze, k, this.speed);
      separateTanks(this.tanks, this.maze);
      this.pickUpCrates();
      this.stepProjectiles();
      this.explode();
      this.regrowBricks();
      this.storm();
      this.spawnCrates();
      this.checkEnd();
    }
    for (const s of this.seats) s.prevBits = s.tank.bits;
    return this.over || k % SNAP_EVERY === 0 ? this.snapshot() : null;
  }

  snapshot(): SnapMsg {
    const k = this.k;
    const msg: SnapMsg = {
      t: 's',
      k,
      T: this.seats.filter((s) => s.present).map((s) => encodeTank(s.tank, k, s.ack, s.spinning ? TankFlag.Spinning : 0)),
      P: this.projectiles.map((p) => encodeProj(p, k)),
    };
    if (this.pending.length > 0) {
      msg.e = this.pending;
      this.pending = [];
    }
    return msg;
  }

  matchMsg(): MatchMsg {
    const { walls, hp } = encodeMaze(this.maze);
    return {
      t: 'match',
      id: this.id,
      k: this.k,
      w: this.maze.w,
      h: this.maze.h,
      walls,
      hp,
      crates: this.crates.map(crateRow),
      playAt: this.playAt,
      stormAt: this.stormAt,
      endAt: this.endAt,
    };
  }

  /** The live frag bomb a seat can detonate, if any. */
  fragOf(seat: number): ProjState | undefined {
    const id = this.seats[seat]?.fragId ?? 0;
    return id ? this.projectiles.find((p) => p.id === id) : undefined;
  }

  private emit(ev: GameEvent): void {
    this.pending.push(encodeEvent(ev));
  }

  private isEnemy(a: number, b: number): boolean {
    const ta = this.tanks[a];
    const tb = this.tanks[b];
    return a !== b && !!ta && !!tb && !sameTeam(ta.team, tb.team);
  }

  /** Friendly fire is off and these are two different teammates. */
  private ffBlocked(attackerTeam: number, attacker: number, target: TankState): boolean {
    return !this.settings.friendlyFire && attacker !== target.seat && sameTeam(attackerTeam, target.team);
  }

  // -------------------------------------------------------------------------------------------
  // Tanks: respawn and weapons

  private updateTank(s: Seat): void {
    const t = s.tank;
    const k = this.k;
    if (!t.alive) {
      if (s.present && !s.score.out && s.respawnAt > 0 && k >= s.respawnAt) this.respawn(s);
      return;
    }
    const fire = (t.bits & Input.Fire) !== 0;
    const rising = fire && (s.prevBits & Input.Fire) === 0;

    if (t.rc !== 0) {
      if (rising) this.detonateById(t.rc);
      return;
    }
    if (s.fragId !== 0) {
      const frag = this.fragOf(s.seat);
      if (!frag) s.fragId = 0;
      else {
        if (rising && k - frag.bornAt >= FRAG.minDetonateTicks) this.detonate(frag, frag.owner, frag.team);
        return;
      }
    }
    if (t.chargeUntil > 0) {
      if (k >= t.chargeUntil) this.releaseDeathRay(s);
      return;
    }
    if (k < t.frozenUntil) return;

    switch (t.weapon) {
      case Weapon.Gun: {
        const ready = k - s.lastShotAt >= FIRE_COOLDOWN_TICKS && this.liveBullets(t.seat) < BULLET_MAX_ACTIVE;
        if (ready && (rising || (fire && k - s.lastShotAt >= AUTO_FIRE_TICKS))) {
          const o = shotOrigin(t, this.maze);
          this.launch(s, Proj.Bullet, o.x, o.y, t.a, { bounces: this.settings.bounces });
          this.fired(s, Weapon.Gun, o, t.a);
        }
        break;
      }
      case Weapon.Gatling:
        this.gatling(s, fire, rising);
        break;
      case Weapon.Shotgun:
        if (rising && k - s.lastShotAt >= SHOTGUN.cooldownTicks) this.shotgun(s);
        break;
      case Weapon.Mines:
        if (rising && k - s.lastShotAt >= MINES.cooldownTicks) this.dropMine(s);
        break;
      case Weapon.Laser:
        if (rising) this.laser(s);
        break;
      case Weapon.Homing:
      case Weapon.Frag:
      case Weapon.Rc:
        if (rising) this.missile(s, t.weapon);
        break;
      case Weapon.DeathRay:
        if (rising) {
          t.chargeUntil = k + DEATH_RAY.chargeTicks;
          this.unprotect(t);
          this.emit({ e: Ev.Charge, seat: t.seat });
        }
        break;
    }
  }

  private liveBullets(seat: number): number {
    let n = 0;
    for (const p of this.projectiles) if (p.kind === Proj.Bullet && p.owner === seat && !this.dead.has(p.id)) n++;
    return n;
  }

  private launch(s: Seat, kind: Proj, x: number, y: number, a: number, opts?: { bounces?: number; speedScale?: number }): ProjState {
    const p = makeProj(kind, this.nextId++, s.tank, x, y, a, this.k, this.speed, opts);
    this.projectiles.push(p);
    if (kind !== Proj.Mine) s.score.shots++;
    return p;
  }

  /** Bookkeeping for every shot: cooldown, spawn protection ends, and the Fire event. */
  private fired(s: Seat, weapon: Weapon, at: Point, a: number): void {
    s.lastShotAt = this.k;
    this.unprotect(s.tank);
    this.emit({ e: Ev.Fire, seat: s.seat, weapon, x: at.x, y: at.y, a });
  }

  private unprotect(t: TankState): void {
    if (t.protectUntil > this.k) t.protectUntil = this.k;
  }

  private useAmmo(s: Seat): void {
    const t = s.tank;
    t.ammo--;
    if (t.ammo > 0) return;
    t.ammo = 0;
    t.weapon = Weapon.Gun;
    s.spinning = false;
  }

  private gatling(s: Seat, fire: boolean, rising: boolean): void {
    const t = s.tank;
    const k = this.k;
    if (!fire) {
      s.spinning = false;
      return;
    }
    if (rising) {
      s.spinning = true;
      s.spinReadyAt = k + (s.spunBefore ? GATLING.respinTicks : GATLING.spinUpTicks);
      s.spunBefore = true;
      this.unprotect(t);
    }
    if (!s.spinning || k < s.spinReadyAt || k < s.nextRoundAt) return;
    const o = shotOrigin(t, this.maze);
    const a = t.a + randRange(this.rng, -GATLING.spread, GATLING.spread);
    this.launch(s, Proj.Gatling, o.x, o.y, a);
    this.fired(s, Weapon.Gatling, o, a);
    s.nextRoundAt = k + GATLING.everyTicks;
    this.useAmmo(s);
  }

  private shotgun(s: Seat): void {
    const t = s.tank;
    const o = shotOrigin(t, this.maze);
    const n = SHOTGUN.pellets;
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? -SHOTGUN.spread + (2 * SHOTGUN.spread * i) / (n - 1) : 0;
      const a = t.a + spread + randRange(this.rng, -SHOTGUN.jitter, SHOTGUN.jitter);
      const speedScale = 1 + randRange(this.rng, -SHOTGUN.speedJitter, SHOTGUN.speedJitter);
      this.launch(s, Proj.Pellet, o.x, o.y, a, { speedScale });
    }
    this.fired(s, Weapon.Shotgun, o, t.a);
    this.useAmmo(s);
  }

  private dropMine(s: Seat): void {
    const t = s.tank;
    const r = PROJ_STATS[Proj.Mine].r;
    const back = TANK_HALF_L + r + 1;
    let at = { x: t.x - Math.cos(t.a) * back, y: t.y - Math.sin(t.a) * back };
    if (circleTouchesWall(this.maze, at.x, at.y, r) || !clearLine(this.maze, t.x, t.y, at.x, at.y)) at = { x: t.x, y: t.y };
    const a = t.a + Math.PI;
    this.launch(s, Proj.Mine, at.x, at.y, a);
    this.fired(s, Weapon.Mines, at, a);
    this.useAmmo(s);
  }

  private missile(s: Seat, weapon: Weapon): void {
    const t = s.tank;
    const o = shotOrigin(t, this.maze);
    const kind = weapon === Weapon.Homing ? Proj.Homing : weapon === Weapon.Frag ? Proj.Frag : Proj.Rc;
    const p = this.launch(s, kind, o.x, o.y, t.a);
    if (kind === Proj.Frag) s.fragId = p.id;
    if (kind === Proj.Rc) t.rc = p.id;
    this.fired(s, weapon, o, t.a);
    this.useAmmo(s);
  }

  private laser(s: Seat): void {
    const t = s.tank;
    const k = this.k;
    const o = shotOrigin(t, this.maze);
    const mirrorTanks = this.tanks.filter((m) => m.alive && m.seat !== t.seat && m.shieldUntil > k);
    const mirrors: Circle[] = mirrorTanks.map((m) => ({ x: m.x, y: m.y, r: SHIELD_RADIUS }));
    const { pts, walls } = tracePath(this.maze, o.x, o.y, t.a, LASER.maxReflections, LASER.maxLength, mirrors);
    const shot = this.nextId++;
    s.score.shots++;
    const hit = this.laserVictim(t, pts);
    if (hit) {
      const i = hit.seg * 2;
      const x = pts[i]! + (pts[i + 2]! - pts[i]!) * hit.f;
      const y = pts[i + 1]! + (pts[i + 3]! - pts[i + 1]!) * hit.f;
      pts.length = i + 2;
      pts.push(x, y);
    }
    // walls[j] is what the beam hit at point j + 1. Only contacts before the victim's segment count.
    const contacts = hit ? hit.seg : walls.length;
    for (let j = 0; j < contacts; j++) {
      const id = walls[j]!;
      if (id >= 0) this.chipBrick(id, LASER.brick, t.seat);
      else {
        const m = mirrorTanks[-id - 1];
        if (m) this.emit({ e: Ev.Block, seat: m.seat, x: pts[(j + 1) * 2]!, y: pts[(j + 1) * 2 + 1]! });
      }
    }
    this.emit({ e: Ev.Beam, seat: t.seat, weapon: Weapon.Laser, pts });
    this.fired(s, Weapon.Laser, o, t.a);
    t.frozenUntil = k + LASER.recoilTicks;
    this.useAmmo(s);
    if (hit) this.applyDamage(hit.victim, LASER.damage, t.seat, Weapon.Laser, shot, hit.seg > 0);
  }

  /** The first tank the beam touches: segment index and fraction along it. The shooter only counts after a reflection. */
  private laserVictim(shooter: TankState, pts: readonly number[]): { victim: Seat; seg: number; f: number } | null {
    const k = this.k;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      let best: { victim: Seat; seg: number; f: number } | null = null;
      for (const v of this.seats) {
        const vt = v.tank;
        if (!vt.alive || vt.protectUntil > k || vt.shieldUntil > k) continue;
        if ((vt.seat === shooter.seat && i === 0) || this.ffBlocked(shooter.team, shooter.seat, vt)) continue;
        const f = segmentHitsTank(vt, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
        if (f !== null && (!best || f < best.f)) best = { victim: v, seg: i / 2, f };
      }
      if (best) return best;
    }
    return null;
  }

  private releaseDeathRay(s: Seat): void {
    const t = s.tank;
    const k = this.k;
    t.chargeUntil = 0;
    const o = shotOrigin(t, this.maze);
    const targets = this.tanks.filter((v) => v.alive && this.isEnemy(t.seat, v.seat) && v.protectUntil <= k && v.shieldUntil <= k);
    const pts = deathRayPath(this.maze, o.x, o.y, t.a, targets);
    const shot = this.nextId++;
    s.score.shots++;
    this.emit({ e: Ev.Beam, seat: t.seat, weapon: Weapon.DeathRay, pts });
    this.fired(s, Weapon.DeathRay, o, t.a);
    this.useAmmo(s);
    for (const id of wallsAlongPath(this.maze, pts, DEATH_RAY.width / 2)) this.chipBrick(id, DEATH_RAY.brick, t.seat);
    for (const v of this.seats) {
      const vt = v.tank;
      if (!vt.alive || vt.seat === t.seat || vt.protectUntil > k || this.ffBlocked(t.team, t.seat, vt)) continue;
      if (!this.nearPath(vt, pts, DEATH_RAY.width)) continue;
      if (vt.shieldUntil > k) this.emit({ e: Ev.Block, seat: vt.seat, x: vt.x, y: vt.y });
      else this.applyDamage(v, DEATH_RAY.damage, t.seat, Weapon.DeathRay, shot);
    }
  }

  private nearPath(t: TankState, pts: readonly number[], pad: number): boolean {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      if (segmentHitsTank(t, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!, pad) !== null) return true;
    }
    return false;
  }

  private respawn(s: Seat): void {
    const t = s.tank;
    const k = this.k;
    const cell = spawnCell(
      this.maze,
      this.rng,
      stormRect(this.maze, k, this.stormAt),
      this.tanks.filter((o) => o.alive && this.isEnemy(s.seat, o.seat)),
      this.projectiles,
      this.tanks.filter((o) => o.alive),
    );
    const at = cellCenter(cell.cx, cell.cy);
    t.x = at.x;
    t.y = at.y;
    t.a = openAngle(this.maze, cell);
    t.hp = MAX_HP;
    t.alive = true;
    t.weapon = Weapon.Gun;
    t.ammo = 0;
    t.protectUntil = k + SPAWN_PROTECT_TICKS;
    s.respawnAt = 0;
    s.lifeStart = k;
    s.lastShotAt = NO_SHOT;
    this.emit({ e: Ev.Spawn, seat: t.seat, x: t.x, y: t.y, a: t.a });
  }

  // -------------------------------------------------------------------------------------------
  // Damage and death

  private applyDamage(s: Seat, amount: number, by: number, cause: number, shot = 0, ricochet = false): void {
    const t = s.tank;
    const k = this.k;
    if (!t.alive || amount <= 0 || t.shieldUntil > k || t.protectUntil > k) return;
    const attacker = by >= 0 ? this.seats[by] : undefined;
    if (attacker && this.ffBlocked(attacker.tank.team, by, t)) return;
    t.hp = Math.max(0, t.hp - amount);
    if (attacker && this.isEnemy(by, t.seat)) {
      s.lastDamager = by;
      s.lastDamagedAt = k;
      if (shot && !this.hitShots.has(shot)) {
        this.hitShots.add(shot);
        attacker.score.hits++;
      }
    }
    if (by === t.seat) s.score.selfDamage += amount;
    this.emit({ e: Ev.Hit, seat: t.seat, by, x: t.x, y: t.y, dmg: amount });
    if (t.hp <= 0) this.kill(s, by, cause, ricochet);
  }

  private kill(s: Seat, by: number, cause: number, ricochet: boolean): void {
    const t = s.tank;
    const k = this.k;
    let killer = by >= 0 && by !== t.seat ? by : -1;
    if (killer < 0 && s.lastDamager >= 0 && k - s.lastDamagedAt <= KILL_CREDIT_TICKS) killer = s.lastDamager;
    let self = false;
    const ks = killer >= 0 ? this.seats[killer]?.score : undefined;
    if (ks) {
      if (this.isEnemy(killer, t.seat)) {
        if (s.score.kills > 0 && s.score.kills >= this.topKills()) ks.kingslayer++;
        ks.kills++;
        if (ricochet && killer === by) ks.ricochetKills++;
      } else {
        ks.kills--;
      }
    } else if (by === t.seat) {
      s.score.kills--;
      self = true;
    }
    s.score.deaths++;
    this.endLife(s);
    if (this.settings.mode === 'lives') {
      s.score.lives = Math.max(0, s.score.lives - 1);
      if (s.score.lives === 0) {
        s.score.out = true;
        s.score.outTick = k;
      }
    }
    s.respawnAt = s.score.out ? 0 : k + RESPAWN_TICKS;
    this.emit({ e: Ev.Death, seat: t.seat, by: killer, cause, x: t.x, y: t.y, self });
    t.alive = false;
    t.hp = 0;
    t.weapon = Weapon.Gun;
    t.ammo = 0;
    t.chargeUntil = 0;
    t.frozenUntil = 0;
    t.shieldUntil = 0;
    t.speedUntil = 0;
    t.aimerUntil = 0;
    t.protectUntil = 0;
    if (t.rc) this.removeById(t.rc);
    t.rc = 0;
    s.fragId = 0;
    s.spinning = false;
    s.spunBefore = false;
    s.lastDamager = -1;
    this.version++;
  }

  private endLife(s: Seat): void {
    if (s.tank.alive && this.k >= this.playAt) s.score.longestLife = Math.max(s.score.longestLife, this.k - s.lifeStart);
  }

  private topKills(): number {
    let top = 0;
    for (const s of this.seats) top = Math.max(top, s.score.kills);
    return top;
  }

  // -------------------------------------------------------------------------------------------
  // Crates

  private pickUpCrates(): void {
    if (this.crates.length === 0) return;
    this.crates = this.crates.filter((c) => {
      const at = cellCenter(c.cx, c.cy);
      const rect: Rect = { x0: at.x - CRATE_HALF, y0: at.y - CRATE_HALF, x1: at.x + CRATE_HALF, y1: at.y + CRATE_HALF };
      for (const s of this.seats) {
        const t = s.tank;
        if (!t.alive || !circleTouchesRect(rect, t.x, t.y, TANK_RADIUS)) continue;
        if (c.kind === Upgrade.Repair && t.hp >= MAX_HP) continue;
        this.give(s, c.kind);
        s.score.crates++;
        this.emit({ e: Ev.Pick, id: c.id, seat: t.seat, kind: c.kind });
        return false;
      }
      return true;
    });
  }

  private give(s: Seat, kind: CrateKind): void {
    const t = s.tank;
    const k = this.k;
    switch (kind) {
      case Upgrade.Shield:
        t.shieldUntil = k + UPGRADE_TICKS[Upgrade.Shield];
        return;
      case Upgrade.Speed:
        t.speedUntil = k + UPGRADE_TICKS[Upgrade.Speed];
        return;
      case Upgrade.Aimer:
        t.aimerUntil = k + UPGRADE_TICKS[Upgrade.Aimer];
        return;
      case Upgrade.Repair:
        t.hp = MAX_HP;
        return;
      default:
        t.chargeUntil = 0;
        s.spinning = false;
        s.spunBefore = false;
        t.weapon = kind;
        t.ammo = WEAPON_AMMO[kind];
    }
  }

  private spawnCrates(): void {
    if (this.crateCap === 0 || this.k < this.nextCrateAt) return;
    if (this.crates.length < this.crateCap) this.spawnCrate();
    const tanks = Math.max(1, this.seats.length);
    const mean = (CRATE_INTERVAL_S[this.settings.powerups] ?? 7) * Math.min(1, 4 / tanks);
    const jitter = 1 + randRange(this.rng, -CRATE_INTERVAL_JITTER, CRATE_INTERVAL_JITTER);
    this.nextCrateAt = this.k + Math.max(1, Math.round(mean * jitter * TICK_HZ));
  }

  private spawnCrate(): void {
    const safe = stormRect(this.maze, this.k, this.stormAt);
    const cell = crateCell(this.maze, this.rng, safe, this.tanks.filter((t) => t.alive), this.crates);
    if (!cell) return;
    const crate: Crate = { id: this.nextCrateId++, kind: crateKind(this.rng), cx: cell.cx, cy: cell.cy };
    this.crates.push(crate);
    this.emit({ e: Ev.Crate, id: crate.id, kind: crate.kind, cx: crate.cx, cy: crate.cy });
  }

  // -------------------------------------------------------------------------------------------
  // Projectiles and blasts

  private stepProjectiles(): void {
    const k = this.k;
    for (const p of this.projectiles) {
      if (this.dead.has(p.id)) continue;
      if (!this.special(p)) continue;
      this.hits.length = 0;
      const result = stepProjectile(p, this.maze, k, this.hits);
      const brick = PROJ_STATS[p.kind].brick;
      if (brick > 0) for (const h of this.hits) if (h.first) this.chipBrick(h.wall, brick, p.owner);
      if (result === 'expired') {
        if (p.kind === Proj.Mine || !isExplosive(p.kind)) this.remove(p);
        else this.detonate(p, p.owner, p.team);
      } else if (result === 'wall') {
        this.remove(p);
      } else if (p.kind !== Proj.Mine) {
        this.hitTanks(p);
      }
    }
    this.mineContacts();
    if (this.dead.size > 0) {
      this.projectiles = this.projectiles.filter((p) => !this.dead.has(p.id));
      this.dead.clear();
    }
  }

  /** Per-kind behaviour before a projectile moves. Returns false when it is gone. */
  private special(p: ProjState): boolean {
    const k = this.k;
    switch (p.kind) {
      case Proj.Homing:
        if (p.aux === 0 && k - p.bornAt >= HOMING.straightTicks) {
          p.aux = 1;
          p.deadly = true;
        }
        if (p.aux === 1) {
          const targets = this.tanks.filter((t) => t.alive && t.protectUntil <= k && t.seat !== p.owner && !sameTeam(t.team, p.team));
          steerHoming(p, this.maze, targets, DT);
        }
        return true;
      case Proj.Rc: {
        const owner = this.tanks[p.owner];
        if (owner?.alive && owner.rc === p.id) steerRc(p, owner.bits, DT, owner.steer);
        return true;
      }
      case Proj.Mine:
        if (p.aux === 0 && k - p.bornAt >= MINES.armTicks) p.aux = 1;
        if (p.aux === 1 && this.mineTriggered(p)) {
          p.aux = 2;
          p.fuseAt = k + MINES.fuseTicks;
          this.emit({ e: Ev.Trigger, id: p.id });
        }
        if (p.aux === 2 && k >= p.fuseAt) {
          this.detonate(p, p.owner, p.team);
          return false;
        }
        return true;
      default:
        return true;
    }
  }

  private mineTriggered(p: ProjState): boolean {
    const reach = TANK_RADIUS + MINES.triggerRadius;
    for (const t of this.tanks) {
      if (!t.alive || t.protectUntil > this.k || this.ffBlocked(p.team, p.owner, t)) continue;
      if ((t.x - p.x) ** 2 + (t.y - p.y) ** 2 <= reach * reach) return true;
    }
    return false;
  }

  /** Projectile against tanks: shields reflect, everything else hits the first tank it touches. */
  private hitTanks(p: ProjState): void {
    const k = this.k;
    const reach = SHIELD_RADIUS + p.r;
    for (const s of this.seats) {
      const t = s.tank;
      if (!t.alive) continue;
      const dx = p.x - t.x;
      const dy = p.y - t.y;
      if (dx * dx + dy * dy > reach * reach) continue;
      if ((t.seat === p.owner && !p.deadly) || t.protectUntil > k || this.ffBlocked(p.team, p.owner, t)) continue;
      if (t.shieldUntil > k) {
        if (deflectOffShield(p, t) && !this.blocked.has(p.id)) {
          this.blocked.add(p.id);
          this.emit({ e: Ev.Block, seat: t.seat, x: p.x, y: p.y });
        }
        continue;
      }
      if (!circleHitsTank(t, p.x, p.y, p.r)) continue;
      const shot = p.kind === Proj.Shrapnel ? 0 : p.id;
      this.applyDamage(s, PROJ_STATS[p.kind].damage, p.owner, this.causeOf(p), shot, p.hits > 0);
      if (isExplosive(p.kind)) this.detonate(p, p.owner, p.team);
      else this.remove(p);
      return;
    }
  }

  /** Any other projectile touching a mine sets it off, credited to whoever shot it. */
  private mineContacts(): void {
    for (const mine of this.projectiles) {
      if (mine.kind !== Proj.Mine || this.dead.has(mine.id)) continue;
      for (const q of this.projectiles) {
        if (q.kind === Proj.Mine || this.dead.has(q.id)) continue;
        const reach = mine.r + q.r;
        if ((q.x - mine.x) ** 2 + (q.y - mine.y) ** 2 > reach * reach) continue;
        this.detonate(mine, q.owner, q.team);
        if (isExplosive(q.kind)) this.detonate(q, q.owner, q.team);
        else this.remove(q);
        break;
      }
    }
  }

  private causeOf(p: ProjState): Weapon {
    return p.kind === Proj.Shrapnel ? (this.shrapnelCause.get(p.id) ?? Weapon.Frag) : PROJ_CAUSE[p.kind];
  }

  private detonateById(id: number): void {
    const p = this.projectiles.find((q) => q.id === id && !this.dead.has(q.id));
    if (p) this.detonate(p, p.owner, p.team);
    else {
      const owner = this.tanks.find((t) => t.rc === id);
      if (owner) owner.rc = 0;
    }
  }

  /** Removes an explosive projectile and queues its blast. */
  private detonate(p: ProjState, owner: number, team: number): void {
    if (this.dead.has(p.id)) return;
    this.remove(p);
    this.blasts.push({ x: p.x, y: p.y, kind: PROJ_CAUSE[p.kind], owner, team, shot: p.kind === Proj.Mine ? 0 : p.id });
  }

  private removeById(id: number): void {
    const p = this.projectiles.find((q) => q.id === id);
    if (p) this.remove(p);
  }

  private remove(p: ProjState): void {
    this.dead.add(p.id);
    this.blocked.delete(p.id);
    this.shrapnelCause.delete(p.id);
    const owner = this.seats[p.owner];
    if (!owner) return;
    if (p.kind === Proj.Rc && owner.tank.rc === p.id) owner.tank.rc = 0;
    if (p.kind === Proj.Frag && owner.fragId === p.id) owner.fragId = 0;
  }

  /** Resolves the blasts queued this tick. Shrapnel that reaches a mine sets it off on a later tick. */
  private explode(): void {
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i]!;
      const stats = BLAST[b.kind];
      if (!stats) continue;
      this.emit({ e: Ev.Boom, x: b.x, y: b.y, r: stats.r, kind: b.kind });
      for (const s of this.seats) {
        const t = s.tank;
        if (!t.alive) continue;
        const d = Math.hypot(t.x - b.x, t.y - b.y);
        if (d > stats.r || !clearLine(this.maze, b.x, b.y, t.x, t.y, true)) continue;
        this.applyDamage(s, Math.max(1, Math.ceil(stats.damage * (1 - d / stats.r))), b.owner, b.kind, b.shot);
      }
      for (const id of wallsInCircle(this.maze, b.x, b.y, stats.r)) this.chipBrick(id, stats.brick, b.owner);
      const start = this.rng() * TAU;
      const owner = { seat: b.owner, team: b.team };
      for (let j = 0; j < stats.shrapnel; j++) {
        const p = makeProj(Proj.Shrapnel, this.nextId++, owner, b.x, b.y, start + (j * TAU) / stats.shrapnel, this.k, this.speed);
        this.projectiles.push(p);
        this.shrapnelCause.set(p.id, b.kind);
      }
    }
    this.blasts.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Bricks, storm, end

  private chipBrick(id: number, amount: number, by: number): void {
    const m = this.maze;
    const hp = m.hp[id] ?? 0;
    if (m.walls[id] !== WallKind.Brick || hp === 0 || amount <= 0) return;
    const next = Math.max(0, hp - amount);
    m.hp[id] = next;
    this.emit({ e: Ev.Brick, wall: id, hp: next });
    if (next > 0) return;
    this.broken.set(id, this.k + BRICK_REGROW_TICKS);
    const s = by >= 0 ? this.seats[by] : undefined;
    if (s) s.score.bricks++;
  }

  private regrowBricks(): void {
    for (const [id, at] of this.broken) {
      if (this.k < at) continue;
      const rect = wallRect(this.maze, id);
      const blocked =
        this.tanks.some((t) => t.alive && tankOverlapsRect(t, rect, 1)) ||
        this.projectiles.some((p) => circleTouchesRect(rect, p.x, p.y, p.r));
      if (blocked) {
        this.broken.set(id, this.k + REGROW_RETRY_TICKS);
        continue;
      }
      this.broken.delete(id);
      this.maze.hp[id] = BRICK_HP;
      this.emit({ e: Ev.Brick, wall: id, hp: BRICK_HP });
    }
  }

  private storm(): void {
    const k = this.k;
    const safe = stormRect(this.maze, k, this.stormAt);
    if (!safe) return;
    this.crates = this.crates.filter((c) => {
      const at = cellCenter(c.cx, c.cy);
      if (inRect(safe, at.x, at.y)) return true;
      this.emit({ e: Ev.Pick, id: c.id, seat: -1, kind: c.kind });
      return false;
    });
    if (k === this.stormAt || (k - this.stormAt) % STORM_DAMAGE_EVERY !== 0) return;
    for (const s of this.seats) {
      if (s.tank.alive && !inRect(safe, s.tank.x, s.tank.y)) this.applyDamage(s, 1, -1, CAUSE_STORM);
    }
  }

  private checkEnd(): void {
    const team = this.settings.teams > 0;
    const side = (s: Seat) => (team ? s.tank.team : s.seat + 100);
    if (this.settings.mode === 'lives') {
      const standing = this.seats.filter((s) => s.present && !s.score.out);
      const sides = new Set(standing.map(side));
      if (sides.size <= 1) this.finish(standing.length > 0 ? [...sides][0]! : null);
      return;
    }
    const present = new Set(this.seats.filter((s) => s.present).map(side));
    if (present.size <= 1) {
      this.finish(present.size === 1 ? [...present][0]! : null);
      return;
    }
    if (this.k < this.endAt) return;
    const totals = new Map<number, number>();
    for (const s of this.seats) totals.set(side(s), (totals.get(side(s)) ?? 0) + s.score.kills);
    const top = Math.max(...totals.values());
    const leaders = [...totals].filter(([, v]) => v === top).map(([k]) => k);
    if (leaders.length === 1) this.finish(leaders[0]!);
    else if (!this.overtime) {
      this.overtime = true;
      this.emit({ e: Ev.Overtime });
    } else if (this.k >= this.endAt + OVERTIME_MAX_TICKS) this.finish(null, leaders);
  }

  /** Ends the match. winner is a team number in team mode, else seat + 100. null is a draw between tied. */
  private finish(winner: number | null, tied: number[] = []): void {
    this.over = true;
    for (const s of this.seats) this.endLife(s);
    const team = this.settings.teams > 0;
    const sideOf = (s: Seat) => (team ? s.tank.team : s.seat + 100);
    const entries = this.seats.map((s) => ({ seat: s.seat, id: s.id, score: s.score }));
    const ranked = rank(this.settings.mode, entries);
    let winners: Seat[];
    if (winner !== null) winners = this.seats.filter((s) => sideOf(s) === winner);
    else if (tied.length > 0) winners = this.seats.filter((s) => tied.includes(sideOf(s)));
    else {
      const last = Math.max(0, ...this.seats.map((s) => s.score.outTick));
      winners = this.seats.filter((s) => s.score.outTick === last && last > 0);
    }
    this.result = {
      draw: winner === null,
      winners: ranked.filter((e) => winners.some((w) => w.seat === e.seat)).map((e) => e.id),
      team: winner !== null && team ? winner : 0,
      standings: ranked.map((e) => e.id),
      awards: pickAwards(ranked),
    };
    this.version++;
  }
}
