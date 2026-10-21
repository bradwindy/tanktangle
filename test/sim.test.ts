import { describe, expect, it } from 'vitest';
import {
  BRICK_HP,
  BRICK_RATIOS,
  DT,
  GAME_SPEEDS,
  STORM_CLOSE_TICKS,
  TANK_RADIUS,
  TANK_REVERSE,
  TANK_SPEED,
  TANK_TURN,
  TILE,
} from '../src/shared/constants';
import { emptyMaze, hWall, isSolid, vWall, wallRect } from '../src/shared/grid';
import { edgeWall, generateMaze, mazeSizeFor, spreadCells, type Dir } from '../src/shared/maze';
import { mulberry32, type Rng } from '../src/shared/rng';
import {
  bulletPath,
  circleHitsTank,
  clearLine,
  deathRayPath,
  deflectOffShield,
  makeProj,
  moveTank,
  raycast,
  segmentHitsTank,
  separateTanks,
  shotOrigin,
  steerHoming,
  steerRc,
  stepProjectile,
  stormRect,
  tankWallDepth,
  tracePath,
  wallsAlongPath,
  wallsInCircle,
  type WallHit,
} from '../src/shared/sim';
import { Input, Proj, Weapon, WallKind, type MazeState, type ProjState, type TankState } from '../src/shared/types';
import { TAU } from '../src/shared/vec';
import { DEATH_RAY, HOMING, MINES, PROJ_STATS, RC, SPEED_BOOST } from '../src/shared/weapons';

function tank(over: Partial<TankState> = {}): TankState {
  return {
    seat: 0,
    team: 0,
    x: 24,
    y: 24,
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
    ...over,
  };
}

const OWNER = { seat: 0, team: 0 };
const cellOf = (v: number) => Math.floor(v / TILE);

/** Whether moving between two cells in one tick could only have happened through open space. */
function legalCellChange(m: MazeState, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return true;
  if (Math.abs(dx) + Math.abs(dy) === 1) {
    const dir: Dir = dy === -1 ? 0 : dx === 1 ? 1 : dy === 1 ? 2 : 3;
    return !isSolid(m, edgeWall(m, ax, ay, dir));
  }
  if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
    // Crossing a grid post diagonally: any wall touching the post fills it.
    const px = Math.max(ax, bx);
    const py = Math.max(ay, by);
    return [hWall(m.w, px - 1, py), hWall(m.w, px, py), vWall(m.w, m.h, px, py - 1), vWall(m.w, m.h, px, py)].every((id) => !isSolid(m, id));
  }
  return false;
}

function randomInput(t: TankState, rng: Rng): void {
  if (rng() < 0.4) {
    t.bits = Input.Steer | (rng() < 0.7 ? Input.Fwd : 0);
    t.steer = Math.floor(rng() * 256);
  } else {
    const turns = [0, Input.Left, Input.Right, Input.Left | Input.Right];
    const drives = [0, Input.Fwd, Input.Fwd, Input.Back, Input.Fwd | Input.Back];
    t.bits = turns[Math.floor(rng() * turns.length)]! | drives[Math.floor(rng() * drives.length)]!;
  }
}

describe('moveTank', () => {
  it('never lets a tank pass through or rest inside a wall', () => {
    let deepest = 0;
    let illegal = 0;
    let travelled = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = mulberry32(seed);
      const count = 2 + (seed % 11);
      const { w, h } = mazeSizeFor(count, (seed % 7) - 3);
      const m = generateMaze(rng, { w, h, brickRatio: BRICK_RATIOS[seed % 5]! });
      const speed = GAME_SPEEDS[seed % 5]!;
      const tanks = spreadCells(m, Math.min(count, 6), rng).map((c, seat) =>
        tank({ seat, x: (c.cx + 0.5) * TILE, y: (c.cy + 0.5) * TILE, a: rng() * TAU }),
      );
      for (let tick = 0; tick < 900; tick++) {
        for (const t of tanks) {
          if (tick % 20 === 0 || rng() < 0.05) randomInput(t, rng);
          if (rng() < 0.002) t.speedUntil = tick + 120;
        }
        const before = tanks.map((t) => [cellOf(t.x), cellOf(t.y), t.x, t.y] as const);
        for (const t of tanks) moveTank(t, m, tick, speed);
        separateTanks(tanks, m);
        tanks.forEach((t, i) => {
          const [cx, cy, x, y] = before[i]!;
          deepest = Math.max(deepest, tankWallDepth(t, m));
          if (!legalCellChange(m, cx, cy, cellOf(t.x), cellOf(t.y))) illegal++;
          travelled += Math.hypot(t.x - x, t.y - y);
        });
      }
    }
    expect(illegal).toBe(0);
    expect(deepest).toBeLessThanOrEqual(0.5);
    expect(travelled).toBeGreaterThan(30 * 3 * 900 * 0.5);
  });

  it('slides along a run of walls past post seams without catching', () => {
    // A wall right across the maze at y = 96, with walls hanging down from three of its posts.
    // Their top ends sit flush with the wall's top face, which is where a naive push catches.
    const m = emptyMaze(6, 3);
    for (let x = 0; x < 6; x++) m.walls[hWall(6, x, 2)] = WallKind.Steel;
    for (const x of [1, 2, 3]) m.walls[vWall(6, 3, x, 2)] = WallKind.Steel;
    const t = tank({ x: 30, y: 80, a: Math.PI / 3, bits: Input.Fwd });
    for (let tick = 0; tick < 240; tick++) moveTank(t, m, tick, 1);
    expect(t.x).toBeGreaterThan(180);
    expect(t.y).toBeLessThan(96);
    expect(tankWallDepth(t, m)).toBeLessThanOrEqual(0.5);
  });

  it('keeps sliding from a pose rounded slightly into a wall (client snapshots)', () => {
    const m = emptyMaze(4, 3);
    const a = Math.PI / 3;
    const bottom = 9 * Math.sin(a) + 7 * Math.cos(a);
    const t = tank({ x: 60, y: 141 - bottom + 0.05, a, bits: Input.Fwd });
    moveTank(t, m, 0, 1);
    expect(t.x - 60).toBeCloseTo(TANK_SPEED * DT * Math.cos(a), 6);
    expect(tankWallDepth(t, m)).toBeLessThan(1e-6);
  });

  it('follows the movement rules', () => {
    const m = emptyMaze(5, 5);
    const run = (over: Partial<TankState>, speed = 1) => {
      const t = tank({ x: 120, y: 120, ...over });
      moveTank(t, m, 10, speed);
      return t;
    };
    const step = TANK_SPEED * DT;
    const turn = TANK_TURN * DT;

    expect(run({ bits: Input.Fwd }).x).toBeCloseTo(120 + step, 9);
    expect(run({ bits: Input.Back }).x).toBeCloseTo(120 - step * TANK_REVERSE, 9);
    expect(run({ bits: Input.Fwd | Input.Back }).x).toBe(120);
    expect(run({ bits: Input.Fwd, speedUntil: 11 }, 1.3).x).toBeCloseTo(120 + step * 1.3 * SPEED_BOOST, 9);
    expect(run({ bits: Input.Right }).a).toBeCloseTo(turn, 9);
    expect(run({ bits: Input.Left | Input.Right }).a).toBe(0);

    for (const frozen of [{ alive: false }, { rc: 5 }, { frozenUntil: 11 }]) {
      const t = run({ bits: Input.Fwd | Input.Right, ...frozen });
      expect([t.x, t.y, t.a]).toEqual([120, 120, 0]);
    }
    const charging = run({ bits: Input.Fwd | Input.Right, chargeUntil: 11 });
    expect(charging.x).toBe(120);
    expect(charging.a).toBeCloseTo(turn * DEATH_RAY.chargeTurn, 12);

    // Joystick: the inner part of the stick (no Fwd) only turns.
    const inner = run({ bits: Input.Steer, steer: 64 });
    expect([inner.x, inner.a]).toEqual([120, turn]);
    expect(run({ bits: Input.Steer, steer: 1 }).a).toBeCloseTo(TAU / 256, 12);
    // Pushed toward where it faces: drives. 90 degrees off: turns first. Behind: backs up toward it.
    expect(run({ bits: Input.Steer | Input.Fwd, steer: 0 }).x).toBeCloseTo(120 + step, 9);
    const side = run({ bits: Input.Steer | Input.Fwd, steer: 64 });
    expect([side.x, side.a]).toEqual([120, turn]);
    const behind = run({ bits: Input.Steer | Input.Fwd, steer: 128 });
    expect(behind.x).toBeCloseTo(120 - step * TANK_REVERSE, 9);
    expect(behind.a).toBe(0);
  });
});

describe('separateTanks', () => {
  it('pushes overlapping living tanks apart and keeps them out of walls', () => {
    const m = emptyMaze(4, 4);
    const a = tank({ seat: 0, x: 100, y: 100 });
    const b = tank({ seat: 1, x: 104, y: 100 });
    const dead = tank({ seat: 2, x: 102, y: 100, alive: false });
    for (let i = 0; i < 10; i++) separateTanks([a, b, dead], m);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThanOrEqual(2 * TANK_RADIUS - 1e-9);
    expect([dead.x, dead.y]).toEqual([102, 100]);

    const pinned = tank({ seat: 0, x: 12, y: 100 });
    const pusher = tank({ seat: 1, x: 16, y: 100 });
    for (let i = 0; i < 20; i++) separateTanks([pinned, pusher], m);
    expect(tankWallDepth(pinned, m)).toBeLessThanOrEqual(0.5);
    expect(pinned.x).toBeGreaterThanOrEqual(12 - 0.5);
    // The wall cancels the pinned tank's half of each push, so the gap closes geometrically.
    expect(pusher.x - pinned.x).toBeGreaterThan(2 * TANK_RADIUS - 0.01);
  });
});

describe('tank hit tests', () => {
  it('test circles and segments against the oriented box', () => {
    const t = tank({ x: 100, y: 100, a: Math.PI / 2 });
    expect(circleHitsTank(t, 100, 100 + 9 + 1.9, 2)).toBe(true);
    expect(circleHitsTank(t, 100, 100 + 9 + 2.1, 2)).toBe(false);
    expect(circleHitsTank(t, 100 + 7 + 1.9, 100, 2)).toBe(true);
    expect(circleHitsTank(t, 100 + 9 + 1, 100, 2)).toBe(false);
    expect(segmentHitsTank(t, 50, 100, 150, 100)).toBeCloseTo((93 - 50) / 100, 9);
    expect(segmentHitsTank(t, 50, 120, 150, 120)).toBeNull();
    expect(segmentHitsTank(t, 50, 113, 150, 113, 5)).toBeCloseTo((88 - 50) / 100, 9);
    expect(segmentHitsTank(t, 100, 100, 150, 150)).toBe(0);
    expect(segmentHitsTank(t, 50, 100, 80, 100)).toBeNull();
  });
});

function distToPolyline(x: number, y: number, pts: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!;
    const y0 = pts[i + 1]!;
    const dx = pts[i + 2]! - x0;
    const dy = pts[i + 3]! - y0;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - x0 - dx * u, y - y0 - dy * u));
  }
  return best;
}

function stepUntilHit(p: ProjState, m: MazeState, tick = 0, limit = 600): { hits: WallHit[]; tick: number } {
  const hits: WallHit[] = [];
  while (hits.length === 0 && tick < limit) stepProjectile(p, m, tick++, hits);
  return { hits, tick };
}

describe('stepProjectile', () => {
  it('reflects off a flat wall at the same speed', () => {
    const m = emptyMaze(4, 4);
    const p = makeProj(Proj.Bullet, 1, OWNER, 100, 40, -Math.PI / 3, 0, 1, { bounces: 3 });
    const vx = p.vx;
    expect(p.deadly).toBe(false);
    const { hits } = stepUntilHit(p, m);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.wall).toBe(hWall(4, 2, 0));
    expect(hits[0]!.y).toBeCloseTo(3, 9);
    expect([hits[0]!.nx, hits[0]!.ny]).toEqual([0, 1]);
    expect(hits[0]!.first).toBe(true);
    expect(p.vx).toBeCloseTo(vx, 9);
    expect(p.vy).toBeCloseTo(PROJ_STATS[Proj.Bullet].speed * Math.sin(Math.PI / 3), 9);
    expect(p.y).toBeGreaterThanOrEqual(3 + p.r - 1e-9);
    expect([p.bounces, p.deadly, p.hits]).toEqual([2, true, 1]);
  });

  it('reflects off a wall end along the corner normal, and out of an inside corner', () => {
    const m = emptyMaze(4, 4);
    // Wall on x = 96 from y = 48 to 96: its rect ends at y = 99 with corners at x = 93 and 99.
    m.walls[vWall(4, 4, 2, 1)] = WallKind.Steel;
    const corner = makeProj(Proj.Bullet, 1, OWNER, 140, 140, (-3 * Math.PI) / 4, 0, 1);
    stepUntilHit(corner, m);
    const speed = PROJ_STATS[Proj.Bullet].speed;
    expect(corner.vx).toBeCloseTo(speed * Math.SQRT1_2, 6);
    expect(corner.vy).toBeCloseTo(speed * Math.SQRT1_2, 6);

    const inside = makeProj(Proj.Bullet, 2, OWNER, 40, 40, (-3 * Math.PI) / 4, 0, 1);
    const { hits } = stepUntilHit(inside, m);
    expect(hits.map((h) => h.wall).sort()).toEqual([hWall(4, 0, 0), vWall(4, 4, 0, 0)].sort());
    expect(inside.vx).toBeCloseTo(speed * Math.SQRT1_2, 6);
    expect(inside.vy).toBeCloseTo(speed * Math.SQRT1_2, 6);
  });

  it('never tunnels through walls, even at top speed', () => {
    let illegal = 0;
    let deepest = 0;
    let bounces = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed);
      const m = generateMaze(rng, { w: 13, h: 8, brickRatio: 0.5 });
      const rects = Array.from(m.walls.keys())
        .filter((id) => isSolid(m, id))
        .map((id) => wallRect(m, id));
      const projs = Array.from({ length: 30 }, (_, i) => {
        const kind = i % 2 ? Proj.Pellet : Proj.Gatling;
        const p = makeProj(kind, i, OWNER, (Math.floor(rng() * 13) + 0.5) * TILE, (Math.floor(rng() * 8) + 0.5) * TILE, rng() * TAU, 0, 1.3);
        p.bounces = -1;
        p.dieAt = Infinity;
        return p;
      });
      const hits: WallHit[] = [];
      for (let tick = 0; tick < 300; tick++) {
        for (const p of projs) {
          const cx = cellOf(p.x);
          const cy = cellOf(p.y);
          hits.length = 0;
          stepProjectile(p, m, tick, hits);
          bounces += hits.length;
          if (!legalCellChange(m, cx, cy, cellOf(p.x), cellOf(p.y))) illegal++;
          for (const r of rects) {
            if (p.x < r.x0 - 4 || p.x > r.x1 + 4 || p.y < r.y0 - 4 || p.y > r.y1 + 4) continue;
            const qx = Math.min(Math.max(p.x, r.x0), r.x1);
            const qy = Math.min(Math.max(p.y, r.y0), r.y1);
            deepest = Math.max(deepest, p.r - Math.hypot(p.x - qx, p.y - qy));
          }
        }
      }
    }
    expect(illegal).toBe(0);
    expect(deepest).toBeLessThan(1e-6);
    expect(bounces).toBeGreaterThan(1000);
  });

  it('counts bounces, dies on the wall after the last one, and expires at dieAt', () => {
    const m = emptyMaze(3, 3);
    const p = makeProj(Proj.Bullet, 1, OWNER, 72, 72, 0, 0, 1, { bounces: 2 });
    const hits: WallHit[] = [];
    let result = 'alive';
    for (let tick = 0; result === 'alive' && tick < 2000; tick++) result = stepProjectile(p, m, tick, hits);
    expect(result).toBe('wall');
    expect(hits.map((h) => h.first)).toEqual([true, false, false]);
    expect(p.hits).toBe(3);

    const shrapnel = makeProj(Proj.Shrapnel, 2, OWNER, 72, 72, 0, 0, 1);
    expect(shrapnel.deadly).toBe(true);
    expect(stepUntilHit(shrapnel, m).hits).toHaveLength(1);

    const q = makeProj(Proj.Bullet, 3, OWNER, 72, 72, 0, 100, 1);
    expect(q.dieAt).toBe(100 + PROJ_STATS[Proj.Bullet].life);
    expect(stepProjectile(q, m, q.dieAt - 1, [])).toBe('alive');
    expect(stepProjectile(q, m, q.dieAt, [])).toBe('expired');
  });

  it('slows a mine to a stop over MINES.stopTicks from bornAt', () => {
    const m = emptyMaze(5, 5);
    const p = makeProj(Proj.Mine, 1, OWNER, 100, 120, 0, 50, 1);
    for (let tick = 50; tick < 50 + MINES.stopTicks + 10; tick++) stepProjectile(p, m, tick, []);
    expect(p.x - 100).toBeCloseTo((PROJ_STATS[Proj.Mine].speed * DT * (MINES.stopTicks + 1)) / 2, 9);
    expect([p.vx, p.vy, p.y]).toEqual([0, 0, 120]);
  });
});

describe('missile steering', () => {
  it('homing missiles follow the maze path round a wall to the target', () => {
    // A wall down from the top at x = 96 that the missile has to go round underneath.
    const m = emptyMaze(4, 3);
    m.walls[vWall(4, 3, 2, 0)] = WallKind.Steel;
    m.walls[vWall(4, 3, 2, 1)] = WallKind.Steel;
    const p = makeProj(Proj.Homing, 1, OWNER, 40, 40, 0, 0, 1);
    p.aux = 1;
    const target = { x: 150, y: 40 };
    const speed = Math.hypot(p.vx, p.vy);
    let tick = 0;
    for (; tick < 600 && Math.hypot(p.x - target.x, p.y - target.y) > 8; tick++) {
      const before = Math.atan2(p.vy, p.vx);
      steerHoming(p, m, [target], DT);
      const turned = Math.abs(Math.atan2(Math.sin(Math.atan2(p.vy, p.vx) - before), Math.cos(Math.atan2(p.vy, p.vx) - before)));
      expect(turned).toBeLessThanOrEqual(HOMING.turnRate * DT + 1e-9);
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(speed, 9);
      stepProjectile(p, m, tick, []);
    }
    expect(tick).toBeLessThan(600);

    const idle = makeProj(Proj.Homing, 2, OWNER, 40, 40, 0, 0, 1);
    steerHoming(idle, m, [target], DT);
    expect(idle.vy).toBe(0);
  });

  it('steers RC missiles with left and right or toward the joystick direction', () => {
    const p = makeProj(Proj.Rc, 1, OWNER, 100, 100, 0, 0, 1);
    steerRc(p, Input.Right, DT);
    expect(Math.atan2(p.vy, p.vx)).toBeCloseTo(RC.turnRate * DT, 12);
    steerRc(p, Input.Left | Input.Right | Input.Fwd, DT);
    expect(Math.atan2(p.vy, p.vx)).toBeCloseTo(RC.turnRate * DT, 12);
    steerRc(p, Input.Steer, DT, 128);
    expect(Math.atan2(p.vy, p.vx)).toBeCloseTo(2 * RC.turnRate * DT, 12);
    steerRc(p, Input.Steer, DT, 0);
    steerRc(p, Input.Steer, DT, 0);
    expect(Math.atan2(p.vy, p.vx)).toBeCloseTo(0, 12);
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(PROJ_STATS[Proj.Rc].speed, 9);
  });

  it('shields bounce projectiles moving inward only', () => {
    const shield = { x: 100, y: 100 };
    const incoming = makeProj(Proj.Bullet, 1, OWNER, 115, 100, Math.PI, 0, 1);
    expect(deflectOffShield(incoming, shield)).toBe(true);
    expect(incoming.vx).toBeGreaterThan(0);
    expect(incoming.deadly).toBe(true);
    const outgoing = makeProj(Proj.Bullet, 2, OWNER, 113, 100, 0, 0, 1);
    expect(deflectOffShield(outgoing, shield)).toBe(false);
    expect(deflectOffShield(makeProj(Proj.Bullet, 3, OWNER, 130, 100, Math.PI, 0, 1), shield)).toBe(false);
  });
});

describe('rays', () => {
  it('raycasts to the first solid wall, optionally past bricks', () => {
    const m = emptyMaze(4, 3);
    const brick = vWall(4, 3, 2, 1);
    m.walls[brick] = WallKind.Brick;
    m.hp[brick] = BRICK_HP;
    expect(raycast(m, 24, 72, 1, 0, 1000)).toEqual({ dist: 69, x: 93, y: 72, nx: -1, ny: 0, wall: brick });
    expect(raycast(m, 24, 72, 1, 0, 1000, true)).toMatchObject({ dist: 165, wall: vWall(4, 3, 4, 1) });
    expect(raycast(m, 24, 72, 1, 0, 50)).toBeNull();
    expect(clearLine(m, 24, 72, 150, 72)).toBe(false);
    expect(clearLine(m, 24, 72, 150, 72, true)).toBe(true);
    expect(wallsInCircle(m, 96, 50, 4)).toEqual([brick]);
    expect(wallsInCircle(m, 72, 72, 20)).toEqual([]);
    m.hp[brick] = 0;
    expect(raycast(m, 24, 72, 1, 0, 1000)?.wall).toBe(vWall(4, 3, 4, 1));
    expect(raycast(m, 24, 72, 0, -1, 1000)).toMatchObject({ dist: 69, ny: 1, wall: hWall(4, 0, 0) });
  });

  it('traces reflections, reports the walls hit and stops at maxLen', () => {
    const m = emptyMaze(4, 3);
    const flat = tracePath(m, 24, 72, 0, 2, 10000);
    const want = [24, 72, 189, 72, 3, 72, 189, 72];
    flat.pts.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 3));
    expect(flat.walls).toEqual([vWall(4, 3, 4, 1), vWall(4, 3, 0, 1), vWall(4, 3, 4, 1)]);

    const angled = tracePath(m, 24, 24, Math.PI / 4, 1, 10000);
    const angledWant = [24, 24, 141, 141, 189, 93];
    angled.pts.forEach((v, i) => expect(v).toBeCloseTo(angledWant[i]!, 3));
    expect(angled.walls).toEqual([hWall(4, 2, 3), vWall(4, 3, 4, 1)]);

    expect(tracePath(m, 24, 72, 0, 5, 100)).toEqual({ pts: [24, 72, 124, 72], walls: [] });

    const mirrored = tracePath(m, 24, 72, 0, 1, 10000, [{ x: 100, y: 72, r: 14 }]);
    [24, 72, 86, 72, 3, 72].forEach((v, i) => expect(mirrored.pts[i]).toBeCloseTo(v, 3));
    expect(mirrored.walls).toEqual([-1, vWall(4, 3, 0, 1)]);
  });

  it('previews a bullet as it flies, catching a wall end that a zero-width ray slips past', () => {
    const m = emptyMaze(4, 3);
    // Wall on x = 96 from y = 48 to 96: its rect ends at y = 99, so a shot along y = 100.5 clears it by 1.5 px.
    m.walls[vWall(4, 3, 2, 1)] = WallKind.Steel;
    const t = tank({ x: 31, y: 100.5 });
    const o = shotOrigin(t, m);
    expect(tracePath(m, o.x, o.y, 0, 6, 640).walls[0]).toBe(vWall(4, 3, 4, 2));
    const path = bulletPath(m, t, 6, 640, 1);
    expect(path.slice(0, 2)).toEqual([44, 100.5]);
    // 2 px a tick from x = 44 puts the r = 2 bullet's centre at (92, 100.5), inside reach of the corner (93, 99).
    // It bounces off along the corner normal (-1, 1.5) / sqrt(3.25), then down to the bottom wall.
    expect(path[2]).toBeCloseTo(93 - 2 / Math.sqrt(3.25), 6);
    expect(path[3]).toBeCloseTo(99 + 3 / Math.sqrt(3.25), 6);
    expect(path[5]).toBeCloseTo(3 * TILE - 3 - 2, 6);
  });

  it('bulletPath stays on a real bullet\'s track up to maxLen at every game speed', () => {
    let worst = 0;
    let bounces = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const rng = mulberry32(seed);
      const m = generateMaze(rng, { w: 12, h: 8, brickRatio: 0.5 });
      for (let i = 0; i < 20; i++) {
        const speed = GAME_SPEEDS[i % GAME_SPEEDS.length]!;
        const t = tank({ x: (Math.floor(rng() * m.w) + 0.5) * TILE, y: (Math.floor(rng() * m.h) + 0.5) * TILE, a: rng() * TAU });
        const path = bulletPath(m, t, 6, 640, speed);
        bounces += path.length / 2 - 2;
        const o = shotOrigin(t, m);
        const p = makeProj(Proj.Bullet, 1, t, o.x, o.y, t.a, 0, speed, { bounces: 6 });
        const step = Math.hypot(p.vx, p.vy) * DT;
        for (let k = 0; (k + 1) * step <= 640 + 1e-6; k++) {
          const result = stepProjectile(p, m, k, []);
          worst = Math.max(worst, distToPolyline(p.x, p.y, path));
          if (result !== 'alive') break;
        }
        expect(Math.hypot(p.x - path.at(-2)!, p.y - path.at(-1)!)).toBeLessThan(1e-6);
      }
    }
    // Contacts put the bullet back out of the wall along the normal, a jog of at most one 2 px substep.
    expect(worst).toBeLessThan(2);
    expect(bounces).toBeGreaterThan(200);
  });

  it('death ray passes interior walls, stops at the boundary and bends toward targets within limits', () => {
    const m = generateMaze(mulberry32(3), { w: 17, h: 11, brickRatio: 0.5 });
    const straight = deathRayPath(m, 30, 264, 0, []);
    expect(straight.filter((_, i) => i % 2 === 1).every((y) => y === 264)).toBe(true);
    expect(straight.at(-2)).toBeCloseTo(17 * TILE - 3, 9);
    const crossed = [];
    for (let x = 1; x <= 17; x++) if (isSolid(m, vWall(17, 11, x, 5))) crossed.push(vWall(17, 11, x, 5));
    expect(crossed.length).toBeGreaterThan(2);
    expect(wallsAlongPath(m, straight)).toEqual(crossed);

    const target = { x: 400, y: 384 };
    const bent = deathRayPath(m, 30, 264, 0, [target]);
    let closest = Infinity;
    let length = 0;
    let lastHeading = 0;
    for (let i = 0; i + 3 < bent.length; i += 2) {
      const dx = bent[i + 2]! - bent[i]!;
      const dy = bent[i + 3]! - bent[i + 1]!;
      const len = Math.hypot(dx, dy);
      const heading = Math.atan2(dy, dx);
      if (len > 1) expect(Math.abs(heading - lastHeading)).toBeLessThanOrEqual((DEATH_RAY.maxBend * 16) / 100 + 1e-9);
      if (len > 1) lastHeading = heading;
      length += len;
      closest = Math.min(closest, Math.hypot(bent[i + 2]! - target.x, bent[i + 3]! - target.y));
    }
    expect(closest).toBeLessThan(DEATH_RAY.width);
    expect(length).toBeLessThanOrEqual(DEATH_RAY.maxLength + 1e-6);

    const behind = deathRayPath(m, 400, 264, 0, [{ x: 100, y: 264 }]);
    expect(behind.filter((_, i) => i % 2 === 1).every((y) => y === 264)).toBe(true);
  });
});

describe('stormRect', () => {
  it('shrinks the safe area linearly to a centred minimum, then holds', () => {
    const m = { w: 17, h: 11 };
    const W = 17 * TILE;
    const H = 11 * TILE;
    expect(stormRect(m, 500, 0)).toBeNull();
    expect(stormRect(m, 99, 100)).toBeNull();
    expect(stormRect(m, 100, 100)).toEqual({ x0: 0, y0: 0, x1: W, y1: H });
    const end = stormRect(m, 100 + STORM_CLOSE_TICKS, 100)!;
    expect(end.x1 - end.x0).toBeCloseTo(W * 0.3, 9);
    expect(end.y1 - end.y0).toBeCloseTo(H * 0.3, 9);
    expect((end.x0 + end.x1) / 2).toBeCloseTo(W / 2, 9);
    const half = stormRect(m, 100 + STORM_CLOSE_TICKS / 2, 100)!;
    expect(half.x0).toBeCloseTo(end.x0 / 2, 9);
    expect(stormRect(m, 100 + STORM_CLOSE_TICKS * 3, 100)).toEqual(end);
    const small = stormRect({ w: 5, h: 4 }, 100 + STORM_CLOSE_TICKS, 100)!;
    expect([small.x1 - small.x0, small.y1 - small.y0]).toEqual([2 * TILE, 2 * TILE]);
  });
});

describe('determinism', () => {
  function run(seed: number): string {
    const rng = mulberry32(seed);
    const m = generateMaze(rng, { w: 13, h: 8, brickRatio: 0.5 });
    const tanks = spreadCells(m, 4, rng).map((c, seat) => tank({ seat, x: (c.cx + 0.5) * TILE, y: (c.cy + 0.5) * TILE }));
    const projs: ProjState[] = [];
    const hits: WallHit[] = [];
    for (let tick = 0; tick < 400; tick++) {
      for (const t of tanks) {
        if (tick % 15 === 0) randomInput(t, rng);
        if (tick % 40 === t.seat) projs.push(makeProj(Proj.Bullet, projs.length + 1, t, t.x, t.y, t.a, tick, 1, { bounces: 6 }));
      }
      for (const t of tanks) moveTank(t, m, tick, 1);
      separateTanks(tanks, m);
      for (const p of projs) stepProjectile(p, m, tick, hits);
    }
    return JSON.stringify({ tanks, projs, hits });
  }

  it('gives identical states for identical inputs', () => {
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });
});
