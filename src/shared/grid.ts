import { BRICK_HP, TILE, WALL } from './constants';
import { WallKind, type MazeState, type Rect } from './types';

/** Wall id helpers. See MazeLayout for the indexing. */

export const wallCount = (w: number, h: number) => w * (h + 1) + (w + 1) * h;
/** The top edge of cell (x, y). y = h is the bottom boundary. */
export const hWall = (w: number, x: number, y: number) => y * w + x;
/** The left edge of cell (x, y). x = w is the right boundary. */
export const vWall = (w: number, h: number, x: number, y: number) => w * (h + 1) + y * (w + 1) + x;

export interface WallCoords {
  horizontal: boolean;
  x: number;
  y: number;
}

export function wallCoords(m: { w: number; h: number }, id: number): WallCoords {
  const hn = m.w * (m.h + 1);
  if (id < hn) return { horizontal: true, x: id % m.w, y: Math.floor(id / m.w) };
  const v = id - hn;
  return { horizontal: false, x: v % (m.w + 1), y: Math.floor(v / (m.w + 1)) };
}

/** The wall's solid rectangle in world px. Rectangles overlap at the grid posts so corners are filled. */
export function wallRect(m: { w: number; h: number }, id: number): Rect {
  const c = wallCoords(m, id);
  const half = WALL / 2;
  if (c.horizontal) {
    return { x0: c.x * TILE - half, y0: c.y * TILE - half, x1: (c.x + 1) * TILE + half, y1: c.y * TILE + half };
  }
  return { x0: c.x * TILE - half, y0: c.y * TILE - half, x1: c.x * TILE + half, y1: (c.y + 1) * TILE + half };
}

/** [top, right, bottom, left] wall ids of a cell. */
export function cellWalls(m: { w: number; h: number }, cx: number, cy: number): [number, number, number, number] {
  return [hWall(m.w, cx, cy), vWall(m.w, m.h, cx + 1, cy), hWall(m.w, cx, cy + 1), vWall(m.w, m.h, cx, cy)];
}

export function isSolid(m: MazeState, id: number): boolean {
  const kind = m.walls[id];
  return kind === WallKind.Steel || (kind === WallKind.Brick && (m.hp[id] ?? 0) > 0);
}

export function isOuterWall(m: { w: number; h: number }, id: number): boolean {
  const c = wallCoords(m, id);
  return c.horizontal ? c.y === 0 || c.y === m.h : c.x === 0 || c.x === m.w;
}

export const worldWidth = (m: { w: number }) => m.w * TILE;
export const worldHeight = (m: { h: number }) => m.h * TILE;
export const cellCenter = (cx: number, cy: number) => ({ x: (cx + 0.5) * TILE, y: (cy + 0.5) * TILE });
export const cellOf = (v: number) => Math.floor(v / TILE);

/**
 * Calls fn once for each solid wall whose rectangle could be within r of (x, y).
 * Coarse: callers do the exact overlap test.
 */
export function forEachSolidWallNear(
  m: MazeState,
  x: number,
  y: number,
  r: number,
  fn: (id: number, rect: Rect) => void,
): void {
  const reach = r + WALL;
  const cx0 = Math.max(0, cellOf(x - reach));
  const cx1 = Math.min(m.w - 1, cellOf(x + reach));
  const cy0 = Math.max(0, cellOf(y - reach));
  const cy1 = Math.min(m.h - 1, cellOf(y + reach));
  for (let gy = cy0; gy <= cy1 + 1; gy++) {
    for (let gx = cx0; gx <= cx1; gx++) {
      const id = hWall(m.w, gx, gy);
      if (isSolid(m, id)) fn(id, wallRect(m, id));
    }
  }
  for (let gy = cy0; gy <= cy1; gy++) {
    for (let gx = cx0; gx <= cx1 + 1; gx++) {
      const id = vWall(m.w, m.h, gx, gy);
      if (isSolid(m, id)) fn(id, wallRect(m, id));
    }
  }
}

/** An empty maze with steel outer walls. */
export function emptyMaze(w: number, h: number): MazeState {
  const n = wallCount(w, h);
  const m: MazeState = { w, h, walls: new Uint8Array(n), hp: new Uint8Array(n) };
  for (let id = 0; id < n; id++) if (isOuterWall(m, id)) m.walls[id] = WallKind.Steel;
  return m;
}

export function encodeMaze(m: MazeState): { walls: string; hp: string } {
  return { walls: m.walls.join(''), hp: m.hp.join('') };
}

/** Returns null if the strings do not match the size. */
export function decodeMaze(w: number, h: number, walls: string, hp: string): MazeState | null {
  const n = wallCount(w, h);
  if (walls.length !== n || hp.length !== n) return null;
  const m: MazeState = { w, h, walls: new Uint8Array(n), hp: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    m.walls[i] = Math.min(2, walls.charCodeAt(i) - 48) | 0;
    m.hp[i] = Math.min(BRICK_HP, Math.max(0, hp.charCodeAt(i) - 48)) | 0;
  }
  return m;
}
