import { BRICK_HP, MAZE_SIZE_STEP } from './constants';
import { hWall, isSolid, vWall, wallCount } from './grid';
import { randInt, type Rng } from './rng';
import { WallKind, type MazeState } from './types';
import { clamp } from './vec';

/** Share of the walls left after carving that are knocked out again to make loops. */
const LOOP_CHANCE = 0.22;
/** One open 2x2 room per this many cells. */
const CELLS_PER_ROOM = 45;
const ROOM_TRIES = 12;

export const MAZE_MIN_W = 5;
export const MAZE_MAX_W = 30;
export const MAZE_MIN_H = 4;
export const MAZE_MAX_H = 18;

/** 0 up, 1 right, 2 down, 3 left. */
export type Dir = 0 | 1 | 2 | 3;
export const DIRS: readonly Dir[] = [0, 1, 2, 3];
export const DIR_X = [0, 1, 0, -1] as const;
export const DIR_Y = [-1, 0, 1, 0] as const;

export interface Cell {
  cx: number;
  cy: number;
}

/** Grid size for a tank count and the maze size setting (-3 to 3). Aspect is about 16:10. */
export function mazeSizeFor(tanks: number, sizeStep: number): { w: number; h: number } {
  const cells = (12 + 14 * Math.max(0, tanks)) * MAZE_SIZE_STEP ** sizeStep;
  const w = Math.round(Math.sqrt(cells * 1.6));
  const h = Math.round(cells / w);
  return { w: clamp(w, MAZE_MIN_W, MAZE_MAX_W), h: clamp(h, MAZE_MIN_H, MAZE_MAX_H) };
}

/**
 * A random spanning-tree maze with extra loops and a few open 2x2 rooms.
 * Every cell is reachable without breaking a brick. Outer walls are steel.
 */
export function generateMaze(rng: Rng, opts: { w: number; h: number; brickRatio: number }): MazeState {
  const { w, h } = opts;
  const present = new Uint8Array(wallCount(w, h)).fill(1);
  const edges = shuffledInteriorEdges(w, h, rng);
  carveSpanningTree(w * h, edges, present);
  addLoops(w, h, edges, present, rng);
  carveRooms(w, h, present, rng);
  return assignKinds(w, h, present, opts.brickRatio, rng);
}

interface Edge {
  id: number;
  a: number;
  b: number;
}

function shuffledInteriorEdges(w: number, h: number, rng: Rng): Edge[] {
  const edges: Edge[] = [];
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) edges.push({ id: hWall(w, x, y), a: (y - 1) * w + x, b: y * w + x });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) edges.push({ id: vWall(w, h, x, y), a: y * w + x - 1, b: y * w + x });
  }
  for (let i = edges.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const tmp = edges[i]!;
    edges[i] = edges[j]!;
    edges[j] = tmp;
  }
  return edges;
}

/** Kruskal: knock out each wall that joins two cells not yet connected. */
function carveSpanningTree(cells: number, edges: readonly Edge[], present: Uint8Array): void {
  const parent = new Int32Array(cells);
  for (let i = 0; i < cells; i++) parent[i] = i;
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    present[e.id] = 0;
  }
}

/** Removes some remaining walls, but never leaves two neighbouring cells with no walls at all (open plains). */
function addLoops(w: number, h: number, edges: readonly Edge[], present: Uint8Array, rng: Rng): void {
  const wallsAround = (cell: number) => {
    const x = cell % w;
    const y = (cell - x) / w;
    return present[hWall(w, x, y)]! + present[hWall(w, x, y + 1)]! + present[vWall(w, h, x, y)]! + present[vWall(w, h, x + 1, y)]!;
  };
  const makesPlain = (cell: number) => {
    if (wallsAround(cell) > 0) return false;
    // A cell with no walls is never on the border, so all four neighbours exist.
    return wallsAround(cell - w) === 0 || wallsAround(cell + w) === 0 || wallsAround(cell - 1) === 0 || wallsAround(cell + 1) === 0;
  };
  for (const e of edges) {
    if (present[e.id] === 0 || rng() >= LOOP_CHANCE) continue;
    present[e.id] = 0;
    if (makesPlain(e.a) || makesPlain(e.b)) present[e.id] = 1;
  }
}

function carveRooms(w: number, h: number, present: Uint8Array, rng: Rng): void {
  if (w < 2 || h < 2) return;
  const count = Math.max(1, Math.round((w * h) / CELLS_PER_ROOM));
  const used = new Uint8Array(w * h);
  for (let r = 0; r < count; r++) {
    let rx = 0;
    let ry = 0;
    for (let attempt = 0; attempt < ROOM_TRIES; attempt++) {
      rx = randInt(rng, w - 1);
      ry = randInt(rng, h - 1);
      const i = ry * w + rx;
      if (!used[i] && !used[i + 1] && !used[i + w] && !used[i + w + 1]) break;
    }
    const i = ry * w + rx;
    used[i] = used[i + 1] = used[i + w] = used[i + w + 1] = 1;
    present[vWall(w, h, rx + 1, ry)] = 0;
    present[vWall(w, h, rx + 1, ry + 1)] = 0;
    present[hWall(w, rx, ry + 1)] = 0;
    present[hWall(w, rx + 1, ry + 1)] = 0;
  }
}

function assignKinds(w: number, h: number, present: Uint8Array, brickRatio: number, rng: Rng): MazeState {
  const n = present.length;
  const m: MazeState = { w, h, walls: new Uint8Array(n), hp: new Uint8Array(n) };
  const hCount = w * (h + 1);
  for (let id = 0; id < n; id++) {
    const outer = id < hCount ? id < w || id >= w * h : (id - hCount) % (w + 1) === 0 || (id - hCount) % (w + 1) === w;
    if (outer) {
      m.walls[id] = WallKind.Steel;
    } else if (present[id]) {
      if (rng() < brickRatio) {
        m.walls[id] = WallKind.Brick;
        m.hp[id] = BRICK_HP;
      } else {
        m.walls[id] = WallKind.Steel;
      }
    }
  }
  return m;
}

const inGrid = (m: { w: number; h: number }, cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < m.w && cy < m.h;

/** The wall id between cell (cx, cy) and its neighbour in dir. */
export function edgeWall(m: { w: number; h: number }, cx: number, cy: number, dir: Dir): number {
  switch (dir) {
    case 0:
      return hWall(m.w, cx, cy);
    case 1:
      return vWall(m.w, m.h, cx + 1, cy);
    case 2:
      return hWall(m.w, cx, cy + 1);
    case 3:
      return vWall(m.w, m.h, cx, cy);
  }
}

/** Whether a tank can drive from cell (cx, cy) to its neighbour in dir. False at a solid wall or the maze edge. */
export function canMove(m: MazeState, cx: number, cy: number, dir: Dir): boolean {
  if (!inGrid(m, cx, cy) || !inGrid(m, cx + DIR_X[dir], cy + DIR_Y[dir])) return false;
  return !isSolid(m, edgeWall(m, cx, cy, dir));
}

let queue = new Int32Array(0);

/**
 * Path distance in cells from (cx, cy) to every cell, row-major (cy * w + cx). -1 is unreachable.
 * Unbroken bricks block. Pass out (at least w * h long) to reuse a buffer.
 */
export function bfs(m: MazeState, cx: number, cy: number, out?: Int16Array): Int16Array {
  const { w, h } = m;
  const n = w * h;
  const dist = out && out.length >= n ? out : new Int16Array(n);
  dist.fill(-1, 0, n);
  if (!inGrid(m, cx, cy)) return dist;
  if (queue.length < n) queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const start = cy * w + cx;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cell = queue[head++]!;
    const x = cell % w;
    const y = (cell - x) / w;
    const next = dist[cell]! + 1;
    if (y > 0 && dist[cell - w] === -1 && !isSolid(m, hWall(w, x, y))) {
      dist[cell - w] = next;
      queue[tail++] = cell - w;
    }
    if (x < w - 1 && dist[cell + 1] === -1 && !isSolid(m, vWall(w, h, x + 1, y))) {
      dist[cell + 1] = next;
      queue[tail++] = cell + 1;
    }
    if (y < h - 1 && dist[cell + w] === -1 && !isSolid(m, hWall(w, x, y + 1))) {
      dist[cell + w] = next;
      queue[tail++] = cell + w;
    }
    if (x > 0 && dist[cell - 1] === -1 && !isSolid(m, vWall(w, h, x, y))) {
      dist[cell - 1] = next;
      queue[tail++] = cell - 1;
    }
  }
  return dist;
}

/**
 * Given distances from a BFS rooted at the goal, the neighbour of (cx, cy) one step closer to the goal.
 * null when (cx, cy) is unreachable or is the goal itself.
 */
export function stepToward(m: MazeState, dist: Int16Array, cx: number, cy: number): Cell | null {
  if (!inGrid(m, cx, cy)) return null;
  const d = dist[cy * m.w + cx]!;
  if (d <= 0) return null;
  for (const dir of DIRS) {
    const nx = cx + DIR_X[dir];
    const ny = cy + DIR_Y[dir];
    if (canMove(m, cx, cy, dir) && dist[ny * m.w + nx] === d - 1) return { cx: nx, cy: ny };
  }
  return null;
}

let navDist = new Int16Array(0);

/**
 * The neighbouring cell on a shortest path from one cell to another.
 * Returns the goal cell itself when already there, and null when the goal is unreachable.
 */
export function nextStep(m: MazeState, fromCx: number, fromCy: number, toCx: number, toCy: number): Cell | null {
  if (!inGrid(m, fromCx, fromCy) || !inGrid(m, toCx, toCy)) return null;
  if (fromCx === toCx && fromCy === toCy) return { cx: toCx, cy: toCy };
  if (navDist.length < m.w * m.h) navDist = new Int16Array(m.w * m.h);
  return stepToward(m, bfs(m, toCx, toCy, navDist), fromCx, fromCy);
}

/**
 * n cells spread out by path distance (farthest-point sampling), also keeping away from the avoid cells.
 * Ties are broken at random. Cells repeat only when n exceeds the cell count.
 */
export function spreadCells(m: MazeState, n: number, rng: Rng, avoid: readonly Cell[] = []): Cell[] {
  const cells = m.w * m.h;
  const nearest = new Int32Array(cells).fill(0x7fffffff);
  const dist = new Int16Array(cells);
  const mark = (cx: number, cy: number) => {
    bfs(m, cx, cy, dist);
    for (let i = 0; i < cells; i++) {
      const d = dist[i]!;
      if (d >= 0 && d < nearest[i]!) nearest[i] = d;
    }
  };
  let marked = 0;
  for (const a of avoid) {
    if (!inGrid(m, a.cx, a.cy)) continue;
    mark(a.cx, a.cy);
    marked++;
  }
  const out: Cell[] = [];
  const ties: number[] = [];
  for (let k = 0; k < n; k++) {
    let pick: number;
    if (marked === 0) {
      pick = randInt(rng, cells);
    } else {
      let best = -1;
      ties.length = 0;
      for (let i = 0; i < cells; i++) {
        const d = nearest[i]!;
        if (d > best) {
          best = d;
          ties.length = 0;
        }
        if (d === best) ties.push(i);
      }
      pick = ties[randInt(rng, ties.length)]!;
    }
    const cx = pick % m.w;
    const cy = (pick - cx) / m.w;
    out.push({ cx, cy });
    nearest[pick] = 0;
    mark(cx, cy);
    marked++;
  }
  return out;
}
