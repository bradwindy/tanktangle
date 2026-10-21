import { TILE } from '../shared/constants';
import { cellCenter, cellOf } from '../shared/grid';
import { bfs, DIR_X, DIR_Y, DIRS, type Cell } from '../shared/maze';
import { randInt, type Rng } from '../shared/rng';
import { inRect, raycast } from '../shared/sim';
import type { Crate, CrateKind, MazeState, Rect } from '../shared/types';
import type { Point } from '../shared/vec';
import { CRATE_MIN_PATH_CELLS, CRATE_WEIGHTS } from '../shared/weapons';

/** Where respawning tanks and new crates go. Pure maze queries, randomness from rng. */

const FAR = 32767;
/** A projectile this close (px) to a respawn spot makes it worse. */
const SPAWN_PROJ_RADIUS = 2 * TILE;
const SPAWN_CANDIDATES = 16;
const DIR_ANGLE = [-Math.PI / 2, 0, Math.PI / 2, Math.PI] as const;

/** Shortest path distance in cells from any of the points to each cell. FAR when there are none. */
export function pathDistanceFrom(m: MazeState, from: readonly Point[]): Int16Array {
  const n = m.w * m.h;
  const near = new Int16Array(n).fill(FAR);
  const dist = new Int16Array(n);
  for (const p of from) {
    bfs(m, cellOf(p.x), cellOf(p.y), dist);
    for (let i = 0; i < n; i++) {
      const d = dist[i]!;
      if (d >= 0 && d < near[i]!) near[i] = d;
    }
  }
  return near;
}

/** The heading with the longest clear run from the cell centre, so a tank spawns facing open space. */
export function openAngle(m: MazeState, cell: Cell): number {
  const at = cellCenter(cell.cx, cell.cy);
  let best = 0;
  let bestLen = -1;
  for (const dir of DIRS) {
    const len = raycast(m, at.x, at.y, DIR_X[dir], DIR_Y[dir], 4000)?.dist ?? 4000;
    if (len > bestLen) {
      bestLen = len;
      best = DIR_ANGLE[dir];
    }
  }
  return best;
}

/**
 * A respawn cell: of random candidates inside the safe area, the one farthest by path from the nearest enemy,
 * marked down for projectiles nearby and for a tank already in the cell.
 */
export function spawnCell(
  m: MazeState,
  rng: Rng,
  safe: Rect | null,
  enemies: readonly Point[],
  projectiles: readonly Point[],
  tanks: readonly Point[],
): Cell {
  const near = pathDistanceFrom(m, enemies);
  let best: Cell | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < SPAWN_CANDIDATES; i++) {
    const c = randInt(rng, m.w * m.h);
    const cx = c % m.w;
    const cy = (c - cx) / m.w;
    const at = cellCenter(cx, cy);
    if (safe && !inRect(safe, at.x, at.y)) continue;
    let score = Math.min(near[c]!, 99);
    for (const p of projectiles) if (Math.hypot(p.x - at.x, p.y - at.y) < SPAWN_PROJ_RADIUS) score -= 3;
    for (const t of tanks) if (cellOf(t.x) === cx && cellOf(t.y) === cy) score -= 4;
    if (score > bestScore) {
      bestScore = score;
      best = { cx, cy };
    }
  }
  if (best) return best;
  // Every candidate was in the storm: take the cell at the middle of the safe area.
  const r = safe ?? { x0: 0, y0: 0, x1: m.w * TILE, y1: m.h * TILE };
  return { cx: cellOf((r.x0 + r.x1) / 2), cy: cellOf((r.y0 + r.y1) / 2) };
}

/**
 * A crate cell inside the safe area with no crate on it, at least CRATE_MIN_PATH_CELLS by path from every tank,
 * relaxing to 2 and then anywhere. null when every cell is taken.
 */
export function crateCell(m: MazeState, rng: Rng, safe: Rect | null, tanks: readonly Point[], crates: readonly Crate[]): Cell | null {
  const near = pathDistanceFrom(m, tanks);
  const taken = new Set(crates.map((c) => c.cy * m.w + c.cx));
  const free: number[] = [];
  for (let i = 0; i < m.w * m.h; i++) {
    const at = cellCenter(i % m.w, Math.floor(i / m.w));
    if (!taken.has(i) && (!safe || inRect(safe, at.x, at.y))) free.push(i);
  }
  for (const need of [CRATE_MIN_PATH_CELLS, 2, 0]) {
    const ok = free.filter((i) => near[i]! >= need);
    if (ok.length === 0) continue;
    const cell = ok[randInt(rng, ok.length)]!;
    return { cx: cell % m.w, cy: Math.floor(cell / m.w) };
  }
  return null;
}

const KINDS = Object.keys(CRATE_WEIGHTS).map(Number) as CrateKind[];
const TOTAL_WEIGHT = KINDS.reduce((sum, kind) => sum + CRATE_WEIGHTS[kind], 0);

/** A crate kind drawn by CRATE_WEIGHTS. */
export function crateKind(rng: Rng): CrateKind {
  let roll = rng() * TOTAL_WEIGHT;
  for (const kind of KINDS) {
    roll -= CRATE_WEIGHTS[kind];
    if (roll < 0) return kind;
  }
  return KINDS[KINDS.length - 1]!;
}
