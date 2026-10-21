import { DT, PALETTE, TANK_HALF_W, TICK_HZ } from '../shared/constants';
import { cellCenter, cellOf } from '../shared/grid';
import { generateMaze, mazeSizeFor, nextStep, spreadCells, type Cell } from '../shared/maze';
import { mulberry32, randInt, randRange, type Rng } from '../shared/rng';
import { clearLine, makeProj, moveTank, separateTanks, shotOrigin, stepProjectile, type WallHit } from '../shared/sim';
import { CRATE_KINDS, Input, Proj, TankFlag, Weapon, type Crate, type MazeState, type ProjState, type TankState } from '../shared/types';
import { wrapAngle } from '../shared/vec';
import { steerByte } from './input';
import type { LocalEvent, ViewProj, ViewState, ViewTank } from './view';

const TANKS = 4;
const CRATES = 3;
const NEW_MAZE_TICKS = 32 * TICK_HZ;
const MAX_STEPS_PER_FRAME = 5;
const MAX_BULLETS = 3;
const STUCK_TICKS = TICK_HZ;

interface Driver {
  goal: Cell;
  fireAt: number;
  checkAt: number;
  checkX: number;
  checkY: number;
  reverseUntil: number;
}

const blankTank = (seat: number): TankState => ({
  seat,
  team: 0,
  x: 0,
  y: 0,
  a: 0,
  hp: 3,
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
});

/** The home-screen demo: four tanks wander a maze firing harmless bouncing bullets. No damage, no AI. */
export class Attract {
  /** Muzzle flashes and bounces for the renderer since the last drain. */
  events: LocalEvent[] = [];
  private rng: Rng;
  private maze!: MazeState;
  private tanks: TankState[] = [];
  private drivers: Driver[] = [];
  private projs: ProjState[] = [];
  private crates: Crate[] = [];
  private prev = new Map<string, { x: number; y: number; a: number }>();
  private tick = 0;
  private acc = 0;
  private nextId = 1;
  private hits: WallHit[] = [];

  constructor(seed: number) {
    this.rng = mulberry32(seed);
    this.reset();
  }

  private reset(): void {
    const { w, h } = mazeSizeFor(TANKS, 0);
    this.maze = generateMaze(this.rng, { w, h, brickRatio: 0.5 });
    this.tick = 0;
    this.projs = [];
    this.prev.clear();
    const cells = spreadCells(this.maze, TANKS + CRATES, this.rng);
    this.tanks = [];
    this.drivers = [];
    for (let i = 0; i < TANKS; i++) {
      const t = blankTank(i);
      const c = cellCenter(cells[i]!.cx, cells[i]!.cy);
      t.x = c.x;
      t.y = c.y;
      t.a = randRange(this.rng, -Math.PI, Math.PI);
      this.tanks.push(t);
      this.drivers.push({ goal: this.randomCell(), fireAt: randInt(this.rng, 120), checkAt: STUCK_TICKS, checkX: t.x, checkY: t.y, reverseUntil: 0 });
    }
    this.crates = cells.slice(TANKS).map((c, i) => ({ id: i + 1, kind: CRATE_KINDS[randInt(this.rng, CRATE_KINDS.length)]!, cx: c.cx, cy: c.cy }));
  }

  private randomCell(): Cell {
    return { cx: randInt(this.rng, this.maze.w), cy: randInt(this.rng, this.maze.h) };
  }

  frame(dt: number): ViewState {
    this.acc = Math.min(this.acc + dt, MAX_STEPS_PER_FRAME * DT);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.step();
    }
    return this.view(this.acc / DT);
  }

  private step(): void {
    if (this.tick >= NEW_MAZE_TICKS) this.reset();
    const k = ++this.tick;
    this.prev.clear();
    for (const t of this.tanks) this.prev.set(`t${t.seat}`, { x: t.x, y: t.y, a: t.a });
    for (const p of this.projs) this.prev.set(`p${p.id}`, { x: p.x, y: p.y, a: 0 });
    for (let i = 0; i < this.tanks.length; i++) this.drive(this.tanks[i]!, this.drivers[i]!, k);
    for (const t of this.tanks) moveTank(t, this.maze, k, 1);
    separateTanks(this.tanks, this.maze);
    let n = 0;
    for (const p of this.projs) {
      this.hits.length = 0;
      const result = stepProjectile(p, this.maze, k, this.hits);
      this.hits.forEach((hit, i) => {
        const last = result === 'wall' && i === this.hits.length - 1;
        this.events.push({ e: last ? 'expire' : 'bounce', x: hit.x, y: hit.y, kind: p.kind });
      });
      if (result === 'expired') this.events.push({ e: 'expire', x: p.x, y: p.y, kind: p.kind });
      if (result === 'alive') this.projs[n++] = p;
    }
    this.projs.length = n;
  }

  /** Follows the maze path to a random goal cell, steering like a phone joystick, and fires now and then. */
  private drive(t: TankState, d: Driver, k: number): void {
    if (k >= d.checkAt) {
      if (Math.hypot(t.x - d.checkX, t.y - d.checkY) < 6) {
        d.goal = this.randomCell();
        d.reverseUntil = k + 30;
      }
      d.checkAt = k + STUCK_TICKS;
      d.checkX = t.x;
      d.checkY = t.y;
    }
    if (k < d.reverseUntil) {
      t.bits = Input.Back | Input.Left;
      return;
    }
    const cx = Math.min(this.maze.w - 1, Math.max(0, cellOf(t.x)));
    const cy = Math.min(this.maze.h - 1, Math.max(0, cellOf(t.y)));
    if (cx === d.goal.cx && cy === d.goal.cy) d.goal = this.randomCell();
    const step = nextStep(this.maze, cx, cy, d.goal.cx, d.goal.cy);
    if (!step) {
      d.goal = this.randomCell();
      t.bits = 0;
      return;
    }
    let aim = cellCenter(step.cx, step.cy);
    if (!this.roomy(t, aim)) aim = cellCenter(cx, cy);
    const toAim = Math.atan2(aim.y - t.y, aim.x - t.x);
    t.steer = steerByte(toAim);
    t.bits = Input.Steer | (Math.hypot(aim.x - t.x, aim.y - t.y) > 2 ? Input.Fwd : 0);
    if (k >= d.fireAt) {
      d.fireAt = k + randInt(this.rng, 150) + 70;
      this.fire(t, k);
    }
  }

  /** Whether the tank's whole width fits along the straight line to the point, so it will not catch a corner. */
  private roomy(t: TankState, p: { x: number; y: number }): boolean {
    const a = Math.atan2(p.y - t.y, p.x - t.x);
    const ox = -Math.sin(a) * TANK_HALF_W;
    const oy = Math.cos(a) * TANK_HALF_W;
    return clearLine(this.maze, t.x + ox, t.y + oy, p.x + ox, p.y + oy) && clearLine(this.maze, t.x - ox, t.y - oy, p.x - ox, p.y - oy);
  }

  private fire(t: TankState, k: number): void {
    let mine = 0;
    for (const p of this.projs) if (p.owner === t.seat) mine++;
    if (mine >= MAX_BULLETS) return;
    const o = shotOrigin(t, this.maze);
    this.projs.push(makeProj(Proj.Bullet, this.nextId++, t, o.x, o.y, t.a, k, 1, { bounces: 6 }));
    this.events.push({ e: 'muzzle', seat: t.seat, x: o.x, y: o.y, a: t.a, weapon: Weapon.Gun });
  }

  private view(alpha: number): ViewState {
    const lerp = (key: string, x: number, y: number, a: number) => {
      const p = this.prev.get(key);
      if (!p) return { x, y, a };
      return { x: p.x + (x - p.x) * alpha, y: p.y + (y - p.y) * alpha, a: wrapAngle(p.a + wrapAngle(a - p.a) * alpha) };
    };
    const tanks: ViewTank[] = this.tanks.map((t) => {
      const pose = lerp(`t${t.seat}`, t.x, t.y, t.a);
      return { ...t, ...pose, name: '', color: PALETTE[t.seat]!, isMe: false, flags: TankFlag.Alive };
    });
    const projectiles: ViewProj[] = this.projs.map((p) => {
      const pos = lerp(`p${p.id}`, p.x, p.y, 0);
      return { ...p, x: pos.x, y: pos.y, color: PALETTE[p.owner]!, hidden: false };
    });
    return {
      tick: this.tick - 1 + alpha,
      phase: 'attract',
      maze: this.maze,
      tanks,
      projectiles,
      crates: this.crates,
      storm: null,
      me: -1,
      focus: null,
      aims: [],
      countdown: 0,
    };
  }
}
