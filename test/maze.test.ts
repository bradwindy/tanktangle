import { describe, expect, it } from 'vitest';
import { BRICK_HP } from '../src/shared/constants';
import { emptyMaze, hWall, isOuterWall, vWall } from '../src/shared/grid';
import { bfs, canMove, generateMaze, mazeSizeFor, nextStep, spreadCells } from '../src/shared/maze';
import { mulberry32 } from '../src/shared/rng';
import { WallKind, type MazeState } from '../src/shared/types';

const cells = (tanks: number, step: number) => {
  const s = mazeSizeFor(tanks, step);
  return s.w * s.h;
};

/** Interior wall ids of a w x h maze with the two cells each one separates. */
function interiorEdges(w: number, h: number): { id: number; a: number; b: number }[] {
  const out = [];
  for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) out.push({ id: hWall(w, x, y), a: (y - 1) * w + x, b: y * w + x });
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) out.push({ id: vWall(w, h, x, y), a: y * w + x - 1, b: y * w + x });
  return out;
}

const SIZES = [
  [5, 4],
  [8, 5],
  [13, 8],
  [17, 11],
  [30, 18],
] as const;

describe('mazeSizeFor', () => {
  it('gives the design sizes, grows with tanks and the size setting, and clamps', () => {
    expect(mazeSizeFor(2, 0)).toEqual({ w: 8, h: 5 });
    expect(mazeSizeFor(12, 0)).toEqual({ w: 17, h: 11 });
    for (let t = 2; t < 12; t++) expect(cells(t + 1, 0)).toBeGreaterThanOrEqual(cells(t, 0));
    for (let s = -3; s < 3; s++) {
      expect(cells(2, s + 1)).toBeGreaterThan(cells(2, s));
      expect(cells(6, s + 1)).toBeGreaterThan(cells(6, s));
    }
    for (let t = 0; t <= 12; t++) {
      for (let s = -3; s <= 3; s++) {
        const { w, h } = mazeSizeFor(t, s);
        expect(w).toBeGreaterThanOrEqual(5);
        expect(w).toBeLessThanOrEqual(30);
        expect(h).toBeGreaterThanOrEqual(4);
        expect(h).toBeLessThanOrEqual(18);
      }
    }
  });
});

describe('generateMaze', () => {
  it('connects every cell without breaking bricks, with steel outer walls and full-hp bricks', () => {
    for (const [w, h] of SIZES) {
      for (let seed = 1; seed <= 20; seed++) {
        const m = generateMaze(mulberry32(seed * 7919 + w), { w, h, brickRatio: 0.5 });
        expect(m.walls.length).toBe(m.hp.length);
        expect(Array.from(bfs(m, 0, 0)).every((d) => d >= 0)).toBe(true);
        for (let id = 0; id < m.walls.length; id++) {
          if (isOuterWall(m, id)) expect(m.walls[id]).toBe(WallKind.Steel);
          expect(m.hp[id]).toBe(m.walls[id] === WallKind.Brick ? BRICK_HP : 0);
        }
      }
    }
  });

  it('adds loops and carves at least one open 2x2 room', () => {
    for (const [w, h] of SIZES) {
      for (let seed = 1; seed <= 10; seed++) {
        const m = generateMaze(mulberry32(seed), { w, h, brickRatio: 0 });
        const open = interiorEdges(w, h).filter((e) => m.walls[e.id] === WallKind.None).length;
        expect(open).toBeGreaterThan(w * h - 1);
        let rooms = 0;
        for (let y = 0; y < h - 1; y++) {
          for (let x = 0; x < w - 1; x++) {
            const inner = [vWall(w, h, x + 1, y), vWall(w, h, x + 1, y + 1), hWall(w, x, y + 1), hWall(w, x + 1, y + 1)];
            if (inner.every((id) => m.walls[id] === WallKind.None)) rooms++;
          }
        }
        expect(rooms).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('honours the brick ratio', () => {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      let bricks = 0;
      let walls = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const m = generateMaze(mulberry32(seed), { w: 17, h: 11, brickRatio: ratio });
        for (const e of interiorEdges(17, 11)) {
          if (m.walls[e.id] === WallKind.None) continue;
          walls++;
          if (m.walls[e.id] === WallKind.Brick) bricks++;
        }
      }
      expect(bricks / walls).toBeCloseTo(ratio, 1);
    }
  });

  it('is deterministic for a seed', () => {
    const a = generateMaze(mulberry32(42), { w: 17, h: 11, brickRatio: 0.5 });
    const b = generateMaze(mulberry32(42), { w: 17, h: 11, brickRatio: 0.5 });
    const c = generateMaze(mulberry32(43), { w: 17, h: 11, brickRatio: 0.5 });
    expect(Array.from(a.walls)).toEqual(Array.from(b.walls));
    expect(Array.from(a.walls)).not.toEqual(Array.from(c.walls));
  });
});

describe('navigation', () => {
  /**
   * 3x2 grid:  (0,0) | (1,0) [ (2,0)      steel between (0,0)-(1,0); bricks seal (2,0) off
   *            (0,1)   (1,1)   (2,1)
   */
  function fixture(): MazeState {
    const m = emptyMaze(3, 2);
    m.walls[vWall(3, 2, 1, 0)] = WallKind.Steel;
    for (const id of [vWall(3, 2, 2, 0), hWall(3, 2, 1)]) {
      m.walls[id] = WallKind.Brick;
      m.hp[id] = BRICK_HP;
    }
    return m;
  }

  it('canMove, bfs and nextStep respect walls, bricks and the edge', () => {
    const m = fixture();
    expect(canMove(m, 0, 0, 1)).toBe(false);
    expect(canMove(m, 0, 0, 2)).toBe(true);
    expect(canMove(m, 0, 0, 0)).toBe(false);
    expect(canMove(m, 0, 0, 3)).toBe(false);
    expect(Array.from(bfs(m, 0, 0))).toEqual([0, 3, -1, 1, 2, 3]);
    expect(nextStep(m, 0, 0, 1, 0)).toEqual({ cx: 0, cy: 1 });
    expect(nextStep(m, 1, 0, 1, 0)).toEqual({ cx: 1, cy: 0 });
    expect(nextStep(m, 0, 0, 2, 0)).toBeNull();

    m.hp[hWall(3, 2, 1)] = 0;
    expect(canMove(m, 2, 1, 0)).toBe(true);
    expect(Array.from(bfs(m, 0, 0))).toEqual([0, 3, 4, 1, 2, 3]);
    expect(nextStep(m, 2, 1, 2, 0)).toEqual({ cx: 2, cy: 0 });
  });

  it('walking nextStep reaches the goal in the BFS distance', () => {
    const m = generateMaze(mulberry32(11), { w: 17, h: 11, brickRatio: 0.5 });
    const rng = mulberry32(12);
    for (let i = 0; i < 40; i++) {
      const from = { cx: Math.floor(rng() * 17), cy: Math.floor(rng() * 11) };
      const to = { cx: Math.floor(rng() * 17), cy: Math.floor(rng() * 11) };
      const want = bfs(m, to.cx, to.cy)[from.cy * 17 + from.cx]!;
      let at = from;
      let steps = 0;
      while (at.cx !== to.cx || at.cy !== to.cy) {
        at = nextStep(m, at.cx, at.cy, to.cx, to.cy)!;
        steps++;
      }
      expect(steps).toBe(want);
    }
  });

  it('spreads cells far apart and away from avoided cells', () => {
    const m = generateMaze(mulberry32(5), { w: 17, h: 11, brickRatio: 0.5 });
    const picks = spreadCells(m, 12, mulberry32(9));
    expect(new Set(picks.map((c) => c.cy * 17 + c.cx)).size).toBe(12);
    let closest = Infinity;
    for (const a of picks) {
      const d = bfs(m, a.cx, a.cy);
      for (const b of picks) if (a !== b) closest = Math.min(closest, d[b.cy * 17 + b.cx]!);
    }
    expect(closest).toBeGreaterThanOrEqual(4);

    const avoid = picks.slice(0, 3);
    const nearest = (cell: number) => Math.min(...avoid.map((a) => bfs(m, a.cx, a.cy)[cell]!));
    const [pick] = spreadCells(m, 1, mulberry32(1), avoid);
    let best = 0;
    for (let i = 0; i < 17 * 11; i++) best = Math.max(best, nearest(i));
    expect(nearest(pick!.cy * 17 + pick!.cx)).toBe(best);
  });
});
