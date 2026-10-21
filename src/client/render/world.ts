import { BRICK_HP, TILE, WALL } from '../../shared/constants';
import { isOuterWall, wallCoords, wallCount, wallRect } from '../../shared/grid';
import { WallKind, type MazeState } from '../../shared/types';
import { BRICK, FLOOR, hexToRgb, packRgba, STEEL, VOID } from './palette';
import { ctx2d, makeCanvas } from './pixels';
import { CELL, HALF_CELL, rotationIndex, type SpriteBank } from './sprites';

/** Every world layer extends this far past the maze edge. */
export const PAD = 32;
const REGROW_SECONDS = 0.55;
const DECAL_FADE_EVERY = 0.5;

const MAT_NONE = 0;
const MAT_BRICK = 1;
const MAT_STEEL = 2;
const MAT_RUBBLE = 3;

/** Small integer hash to [0, 1). Deterministic so walls look the same every time they are redrawn. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const P = {
  void: packRgba(VOID),
  voidDot: packRgba(FLOOR.voidDot),
  base: packRgba(FLOOR.base),
  alt: packRgba(FLOOR.alt),
  seam: packRgba(FLOOR.seam),
  bevel: packRgba(FLOOR.bevel),
  speckLight: packRgba(FLOOR.speckLight),
  speckDark: packRgba(FLOOR.speckDark),
  detail: packRgba(FLOOR.detail),
  detailDark: packRgba(FLOOR.detailDark),
  shadow: packRgba('#000000', 105),
  steelOutline: packRgba(STEEL.outline),
  steelDark: packRgba(STEEL.dark),
  steelBase: packRgba(STEEL.base),
  steelLight: packRgba(STEEL.light),
  steelHi: packRgba(STEEL.hi),
  steelRivet: packRgba(STEEL.rivet),
  steelSeam: packRgba(STEEL.seam),
  brickOutline: packRgba(BRICK.outline),
  brickMortar: packRgba(BRICK.mortar),
  brickDark: packRgba(BRICK.dark),
  brickBase: packRgba(BRICK.base),
  brickAlt: packRgba(BRICK.alt),
  brickLight: packRgba(BRICK.light),
  brickHi: packRgba(BRICK.hi),
  brickCrack: packRgba(BRICK.crack),
  rubble: packRgba(BRICK.rubble),
  rubbleLight: packRgba(BRICK.dark),
  ledCyan: packRgba('#7ff6ff'),
  ledRed: packRgba('#ff5a6a'),
  sootBase: packRgba('#8e3f28'),
  sootLight: packRgba('#a8573a'),
};

interface Regrow {
  id: number;
  start: number;
  sprite: HTMLCanvasElement;
  x0: number;
  y0: number;
  horizontal: boolean;
  lastStep: number;
}

export interface WorldHooks {
  /** A brick course popped back into place at this world point. */
  regrowStep(x: number, y: number): void;
}

/** Static and slowly changing layers: floor, decals, walls with shadows. Layer px = world px + PAD. */
export class World {
  maze: MazeState | null = null;
  floor: HTMLCanvasElement = makeCanvas(1, 1);
  decals: HTMLCanvasElement = makeCanvas(1, 1);
  walls: HTMLCanvasElement = makeCanvas(1, 1);
  private decalCtx: CanvasRenderingContext2D = ctx2d(this.decals);
  private wallCtx: CanvasRenderingContext2D = ctx2d(this.walls);
  private wallImg: ImageData | null = null;
  private wallBuf = new Uint32Array(0);
  private mat = new Uint8Array(0);
  private matHp = new Uint8Array(0);
  private lw = 0;
  private lh = 0;
  private shownHp = new Uint8Array(0);
  private regrows: Regrow[] = [];
  private fadeClock = 0;
  private scorchCache = new Map<number, HTMLCanvasElement>();

  constructor(
    private sprites: SpriteBank,
    private hooks: WorldHooks,
  ) {}

  setMaze(m: MazeState): void {
    this.maze = m;
    this.lw = m.w * TILE + PAD * 2;
    this.lh = m.h * TILE + PAD * 2;
    this.floor = buildFloor(m, this.lw, this.lh);
    this.decals = makeCanvas(this.lw, this.lh);
    this.decalCtx = ctx2d(this.decals);
    this.walls = makeCanvas(this.lw, this.lh);
    this.wallCtx = ctx2d(this.walls);
    this.wallImg = this.wallCtx.createImageData(this.lw, this.lh);
    this.wallBuf = new Uint32Array(this.wallImg.data.buffer);
    this.mat = new Uint8Array(this.lw * this.lh);
    this.matHp = new Uint8Array(this.lw * this.lh);
    this.shownHp = m.hp.slice();
    this.regrows = [];
    this.fadeClock = 0;
    this.renderRegion(0, 0, this.lw, this.lh);
  }

  /** Returns how the wall changed so the caller can add effects: 'break', 'chip', 'regrow' or null. */
  wallChanged(id: number, now: number): 'break' | 'chip' | 'regrow' | null {
    const m = this.maze;
    if (!m || id < 0 || id >= m.walls.length || m.walls[id] !== WallKind.Brick) return null;
    const before = this.shownHp[id]!;
    const after = m.hp[id]!;
    if (before === after) return null;
    const pending = this.regrows.findIndex((r) => r.id === id);
    if (pending >= 0) this.regrows.splice(pending, 1);
    this.shownHp[id] = after;
    const r = wallRect(m, id);
    const x0 = Math.floor(r.x0) + PAD;
    const y0 = Math.floor(r.y0) + PAD;
    const x1 = Math.ceil(r.x1) + PAD;
    const y1 = Math.ceil(r.y1) + PAD;
    if (before === 0 && after > 0) {
      this.renderRegion(x0 - 3, y0 - 3, x1 + 3, y1 + 3);
      const sprite = this.copyRegion(x0, y0, x1, y1);
      this.shownHp[id] = 0;
      this.renderRegion(x0 - 3, y0 - 3, x1 + 3, y1 + 3);
      this.shownHp[id] = after;
      this.regrows.push({ id, start: now, sprite, x0: x0 - PAD, y0: y0 - PAD, horizontal: wallCoords(m, id).horizontal, lastStep: -1 });
      return 'regrow';
    }
    this.renderRegion(x0 - 3, y0 - 3, x1 + 3, y1 + 3);
    return after === 0 ? 'break' : after < before ? 'chip' : null;
  }

  /** The brick hp the walls layer is showing (regrowing bricks still count as broken until they finish). */
  private effectiveHp(id: number): number {
    return this.regrows.some((r) => r.id === id) ? 0 : this.shownHp[id]!;
  }

  update(dt: number, now: number): void {
    this.fadeClock += dt;
    if (this.fadeClock >= DECAL_FADE_EVERY) {
      this.fadeClock = 0;
      const ctx = this.decalCtx;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.03)';
      ctx.fillRect(0, 0, this.lw, this.lh);
      ctx.globalCompositeOperation = 'source-over';
    }
    for (let i = this.regrows.length - 1; i >= 0; i--) {
      const r = this.regrows[i]!;
      const t = (now - r.start) / REGROW_SECONDS;
      const len = r.horizontal ? r.sprite.width : r.sprite.height;
      const step = Math.min(len, Math.floor(t * len / 6) * 6);
      if (step !== r.lastStep && t < 1) {
        r.lastStep = step;
        const along = step + 3;
        this.hooks.regrowStep(
          r.x0 + (r.horizontal ? along : r.sprite.width / 2),
          r.y0 + (r.horizontal ? r.sprite.height / 2 : along),
        );
      }
      if (t >= 1) {
        this.regrows.splice(i, 1);
        const x0 = r.x0 + PAD;
        const y0 = r.y0 + PAD;
        this.renderRegion(x0 - 3, y0 - 3, x0 + r.sprite.width + 3, y0 + r.sprite.height + 3);
      }
    }
  }

  /** Draws the walls layer and any bricks mid-regrow. ctx is in world coords. */
  drawWalls(ctx: CanvasRenderingContext2D, now: number, sx: number, sy: number, sw: number, sh: number): void {
    blitLayer(ctx, this.walls, sx, sy, sw, sh);
    for (const r of this.regrows) {
      const t = Math.min(1, (now - r.start) / REGROW_SECONDS);
      const w = r.sprite.width;
      const h = r.sprite.height;
      if (r.horizontal) {
        const shown = Math.min(w, Math.ceil((t * w) / 6) * 6);
        ctx.drawImage(r.sprite, 0, 0, shown, h, r.x0, r.y0, shown, h);
      } else {
        const shown = Math.min(h, Math.ceil((t * h) / 6) * 6);
        ctx.drawImage(r.sprite, 0, 0, w, shown, r.x0, r.y0, w, shown);
      }
    }
  }

  drawFloor(ctx: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number): void {
    blitLayer(ctx, this.floor, sx, sy, sw, sh);
    blitLayer(ctx, this.decals, sx, sy, sw, sh);
  }

  tread(x: number, y: number, a: number): void {
    const ctx = this.decalCtx;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.fillStyle = 'rgba(6,5,12,0.26)';
    for (const side of [-5, 5]) {
      const px = Math.round(x - c * 6 - s * side) + PAD;
      const py = Math.round(y - s * 6 + c * side) + PAD;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
  }

  scorch(x: number, y: number, r: number): void {
    const radius = Math.max(4, Math.min(48, Math.round(r)));
    let sprite = this.scorchCache.get(radius);
    if (!sprite) {
      sprite = buildScorch(radius);
      this.scorchCache.set(radius, sprite);
    }
    const ctx = this.decalCtx;
    ctx.save();
    ctx.translate(Math.round(x) + PAD, Math.round(y) + PAD);
    ctx.scale(Math.random() < 0.5 ? -1 : 1, Math.random() < 0.5 ? -1 : 1);
    ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
    ctx.restore();
  }

  wreck(x: number, y: number, a: number, weaponVariant: number): void {
    const { body, weapons } = this.sprites.wreck();
    const rot = rotationIndex(a);
    const dx = Math.round(x) + PAD - HALF_CELL;
    const dy = Math.round(y) + PAD - HALF_CELL;
    const ctx = this.decalCtx;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(body, rot * CELL, 0, CELL, CELL, dx, dy, CELL, CELL);
    ctx.drawImage(weapons, rot * CELL, weaponVariant * CELL, CELL, CELL, dx, dy, CELL, CELL);
    ctx.drawImage(body, rot * CELL, CELL, CELL, CELL, dx, dy, CELL, CELL);
    ctx.globalAlpha = 1;
  }

  /** A single settled debris pixel. */
  speck(x: number, y: number, color: string): void {
    const ctx = this.decalCtx;
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x) + PAD, Math.round(y) + PAD, 1, 1);
    ctx.globalAlpha = 1;
  }

  private copyRegion(x0: number, y0: number, x1: number, y1: number): HTMLCanvasElement {
    const w = x1 - x0;
    const h = y1 - y0;
    const c = makeCanvas(w, h);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(w, h);
    const out = new Uint32Array(img.data.buffer);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = this.wallBuf[(y + y0) * this.lw + x + x0]!;
        // Skip shadow pixels so the regrow sprite is just the bricks.
        out[y * w + x] = v === P.shadow ? 0 : v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Re-rasterises walls and shadows inside a layer-px rectangle. */
  private renderRegion(rx0: number, ry0: number, rx1: number, ry1: number): void {
    const m = this.maze;
    if (!m || !this.wallImg) return;
    const lw = this.lw;
    const x0 = Math.max(0, rx0);
    const y0 = Math.max(0, ry0);
    const x1 = Math.min(lw, rx1);
    const y1 = Math.min(this.lh, ry1);
    if (x1 <= x0 || y1 <= y0) return;
    const mx0 = Math.max(0, x0 - 3);
    const my0 = Math.max(0, y0 - 3);
    const mx1 = Math.min(lw, x1 + 3);
    const my1 = Math.min(this.lh, y1 + 3);
    for (let y = my0; y < my1; y++) {
      this.mat.fill(MAT_NONE, y * lw + mx0, y * lw + mx1);
      this.matHp.fill(0, y * lw + mx0, y * lw + mx1);
    }
    const n = wallCount(m.w, m.h);
    for (const pass of [WallKind.Brick, WallKind.Steel]) {
      for (let id = 0; id < n; id++) {
        if (m.walls[id] !== pass) continue;
        const r = wallRect(m, id);
        const wx0 = Math.max(mx0, Math.floor(r.x0) + PAD);
        const wy0 = Math.max(my0, Math.floor(r.y0) + PAD);
        const wx1 = Math.min(mx1, Math.ceil(r.x1) + PAD);
        const wy1 = Math.min(my1, Math.ceil(r.y1) + PAD);
        if (wx1 <= wx0 || wy1 <= wy0) continue;
        const hp = pass === WallKind.Steel ? BRICK_HP : this.effectiveHp(id);
        const outer = isOuterWall(m, id);
        for (let y = wy0; y < wy1; y++) {
          for (let x = wx0; x < wx1; x++) {
            const i = y * lw + x;
            if (pass === WallKind.Steel || outer) {
              this.mat[i] = MAT_STEEL;
              continue;
            }
            if (this.mat[i] === MAT_STEEL) continue;
            if (hp === 0) {
              if (this.mat[i] === MAT_NONE) this.mat[i] = MAT_RUBBLE;
              continue;
            }
            if (hp === 1 && brickMissing(x - PAD, y - PAD)) {
              if (this.mat[i] === MAT_NONE) this.mat[i] = MAT_RUBBLE;
              continue;
            }
            this.mat[i] = MAT_BRICK;
            this.matHp[i] = Math.max(this.matHp[i]!, hp);
          }
        }
      }
    }
    const solid = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= lw || y >= this.lh) return false;
      const v = this.mat[y * lw + x]!;
      return v === MAT_BRICK || v === MAT_STEEL;
    };
    const buf = this.wallBuf;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * lw + x;
        const v = this.mat[i]!;
        if (v === MAT_BRICK || v === MAT_STEEL) {
          const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1);
          if (edge) {
            buf[i] = v === MAT_STEEL ? P.steelOutline : P.brickOutline;
            continue;
          }
          const top = !solid(x, y - 2) || !solid(x - 2, y);
          const bottom = !solid(x, y + 2) || !solid(x + 2, y);
          buf[i] =
            v === MAT_STEEL
              ? steelPixel(x - PAD, y - PAD, top, bottom)
              : brickPixel(x - PAD, y - PAD, this.matHp[i]!, top, bottom);
          continue;
        }
        if (solid(x - 2, y - 2) || solid(x - 1, y - 2) || solid(x - 2, y - 1)) {
          buf[i] = P.shadow;
          continue;
        }
        if (v === MAT_RUBBLE) {
          const hsh = hash2(x, y, 7);
          buf[i] = hsh < 0.24 ? P.rubble : hsh < 0.32 ? P.rubbleLight : 0;
          continue;
        }
        buf[i] = 0;
      }
    }
    this.wallCtx.putImageData(this.wallImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
}

function blitLayer(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number) {
  const lx0 = Math.max(0, sx + PAD);
  const ly0 = Math.max(0, sy + PAD);
  const lx1 = Math.min(layer.width, sx + sw + PAD);
  const ly1 = Math.min(layer.height, sy + sh + PAD);
  if (lx1 <= lx0 || ly1 <= ly0) return;
  ctx.drawImage(layer, lx0, ly0, lx1 - lx0, ly1 - ly0, lx0 - PAD, ly0 - PAD, lx1 - lx0, ly1 - ly0);
}

/** Wall-local coordinates: across is 0..5 over the wall's thickness, along runs the wall's length. */
function wallLocal(wx: number, wy: number): { horizontal: boolean; across: number; along: number; post: boolean } {
  const half = WALL / 2;
  const hy = (((wy + half) % TILE) + TILE) % TILE;
  const hx = (((wx + half) % TILE) + TILE) % TILE;
  const horizontal = hy < WALL;
  return {
    horizontal,
    across: horizontal ? hy : hx,
    along: horizontal ? wx + 1200 : wy + 1200,
    post: hy < WALL && hx < WALL,
  };
}

function brickId(wx: number, wy: number): [number, number] {
  const l = wallLocal(wx, wy);
  if (l.horizontal) {
    const course = l.across < 3 ? 0 : 1;
    return [Math.floor((l.along + course * 3) / 6), wy - l.across + course];
  }
  const course = Math.floor(l.along / 3);
  return [course, wx - l.across + 99];
}

function brickMissing(wx: number, wy: number): boolean {
  const [a, b] = brickId(wx, wy);
  return hash2(a, b, 3) < 0.3;
}

function brickPixel(wx: number, wy: number, hp: number, top: boolean, bottom: boolean): number {
  const l = wallLocal(wx, wy);
  const [a, b] = brickId(wx, wy);
  let joint: boolean;
  let firstRow: boolean;
  if (l.horizontal) {
    const course = l.across < 3 ? 0 : 1;
    joint = (l.along + course * 3) % 6 === 0;
    firstRow = l.across === 1 || l.across === 3;
  } else {
    joint = l.along % 3 === 2;
    firstRow = l.along % 3 === 0;
  }
  if (joint) return P.brickMortar;
  const tone = hash2(a, b, 1);
  const damaged = hp < BRICK_HP;
  if (damaged) {
    const crackChance = hp === 1 ? 0.75 : 0.45;
    if (hash2(a, b, 5) < crackChance) {
      const k = Math.floor(hash2(a, b, 6) * 4);
      const pos = l.horizontal ? (l.along + l.across + k) % 5 : (l.across + (l.along % 3) + k) % 4;
      if (pos === 0) return P.brickCrack;
    }
  }
  if (top) return damaged ? P.brickLight : P.brickHi;
  if (bottom) return P.brickDark;
  if (damaged && hash2(a, b, 9) < (hp === 1 ? 0.6 : 0.35)) return firstRow ? P.sootLight : P.sootBase;
  if (firstRow) return tone < 0.2 ? P.brickBase : P.brickLight;
  return tone < 0.25 ? P.brickAlt : tone > 0.9 ? P.brickDark : P.brickBase;
}

function steelPixel(wx: number, wy: number, top: boolean, bottom: boolean): number {
  const l = wallLocal(wx, wy);
  if (l.post) {
    const px = (((wx + WALL / 2) % TILE) + TILE) % TILE;
    const py = (((wy + WALL / 2) % TILE) + TILE) % TILE;
    if (px === 2 && py === 2) {
      const led = hash2(Math.floor((wx + WALL / 2) / TILE), Math.floor((wy + WALL / 2) / TILE), 31);
      return led < 0.18 ? P.ledCyan : led < 0.26 ? P.ledRed : P.steelRivet;
    }
    if (px === 3 && py === 3) return P.steelSeam;
    if (top) return P.steelHi;
    if (bottom) return P.steelDark;
    return P.steelLight;
  }
  if (top) return P.steelHi;
  if (bottom) return P.steelDark;
  const along = l.along;
  if (along % 24 === 0) return P.steelSeam;
  if (along % 24 === 1) return P.steelLight;
  if (along % 12 === 6 && l.across === 2) return P.steelRivet;
  if (along % 12 === 7 && l.across === 3) return P.steelSeam;
  return P.steelBase;
}

function buildFloor(m: MazeState, lw: number, lh: number): HTMLCanvasElement {
  const canvas = makeCanvas(lw, lh);
  const ctx = ctx2d(canvas, false);
  const img = ctx.createImageData(lw, lh);
  const buf = new Uint32Array(img.data.buffer);
  const mw = m.w * TILE;
  const mh = m.h * TILE;
  const seed = m.w * 131 + m.h * 7;
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const wx = x - PAD;
      const wy = y - PAD;
      const i = y * lw + x;
      if (wx < 0 || wy < 0 || wx >= mw || wy >= mh) {
        buf[i] = (wx & 7) === 0 && (wy & 7) === 0 ? P.voidDot : P.void;
        continue;
      }
      const tx = Math.floor(wx / 24);
      const ty = Math.floor(wy / 24);
      const lx = wx - tx * 24;
      const ly = wy - ty * 24;
      if (lx === 0 || ly === 0) {
        buf[i] = P.seam;
        continue;
      }
      if (lx === 1 || ly === 1) {
        buf[i] = P.bevel;
        continue;
      }
      const n = hash2(wx, wy, seed);
      if (n < 0.018) {
        buf[i] = P.speckLight;
        continue;
      }
      if (n < 0.04) {
        buf[i] = P.speckDark;
        continue;
      }
      buf[i] = hash2(tx, ty, seed + 1) < 0.5 ? P.base : P.alt;
    }
  }
  decorateFloor(buf, lw, m, seed);
  lightFloor(buf, lw, lh, m, seed);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const LAMP_COLORS = ['#3fd9c0', '#c04dff', '#ff9a3d', '#4da6ff', '#ff4d8a'].map(hexToRgb);

/** Soft pools of coloured light baked into the floor, in dithered steps so they stay pixel art. */
function lightFloor(buf: Uint32Array, lw: number, lh: number, m: MazeState, seed: number): void {
  for (let cy = 0; cy < m.h; cy++) {
    for (let cx = 0; cx < m.w; cx++) {
      if (hash2(cx, cy, seed + 21) > 0.16) continue;
      const [lr, lg, lb] = LAMP_COLORS[Math.floor(hash2(cx, cy, seed + 22) * LAMP_COLORS.length)]!;
      const r = 40 + hash2(cx, cy, seed + 23) * 34;
      const ox = PAD + cx * TILE + TILE / 2;
      const oy = PAD + cy * TILE + TILE / 2;
      const x0 = Math.max(PAD, Math.floor(ox - r));
      const x1 = Math.min(lw - PAD, Math.ceil(ox + r));
      const y0 = Math.max(PAD, Math.floor(oy - r));
      const y1 = Math.min(lh - PAD, Math.ceil(oy + r));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const d = Math.hypot(x + 0.5 - ox, y + 0.5 - oy) / r;
          if (d >= 1) continue;
          const f = (1 - d) * (1 - d);
          const step = Math.floor(f * 3 + (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16);
          if (step <= 0) continue;
          const k = step * 0.075;
          const i = y * lw + x;
          const v = buf[i]!;
          const pr = v & 255;
          const pg = (v >> 8) & 255;
          const pb = (v >> 16) & 255;
          buf[i] = ((255 << 24) | (Math.round(pb + (lb - pb) * k) << 16) | (Math.round(pg + (lg - pg) * k) << 8) | Math.round(pr + (lr - pr) * k)) >>> 0;
        }
      }
    }
  }
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Sparse details: bolts in tile corners, floor vents and hairline cracks. */
function decorateFloor(buf: Uint32Array, lw: number, m: MazeState, seed: number) {
  const put = (wx: number, wy: number, c: number) => {
    buf[(wy + PAD) * lw + wx + PAD] = c;
  };
  for (let ty = 0; ty < m.h * 2; ty++) {
    for (let tx = 0; tx < m.w * 2; tx++) {
      const ox = tx * 24;
      const oy = ty * 24;
      const roll = hash2(tx, ty, seed + 11);
      if (roll < 0.22) {
        for (const [bx, by] of [
          [4, 4],
          [19, 4],
          [4, 19],
          [19, 19],
        ] as const) {
          put(ox + bx, oy + by, P.detail);
          put(ox + bx + 1, oy + by + 1, P.detailDark);
        }
      } else if (roll < 0.3) {
        for (let y = 0; y < 7; y++) {
          for (let x = 0; x < 12; x++) {
            const edge = x === 0 || y === 0 || x === 11 || y === 6;
            put(ox + 6 + x, oy + 8 + y, edge ? P.detail : y % 2 ? P.detailDark : P.seam);
          }
        }
      } else if (roll < 0.37) {
        let x = 4 + Math.floor(hash2(tx, ty, seed + 12) * 14);
        let y = 4 + Math.floor(hash2(tx, ty, seed + 13) * 14);
        for (let k = 0; k < 9; k++) {
          put(ox + x, oy + y, P.detailDark);
          x = Math.min(21, Math.max(3, x + (hash2(k, tx, ty) < 0.5 ? 1 : 0)));
          y = Math.min(21, Math.max(3, y + (hash2(k, ty, tx) < 0.6 ? 1 : -1)));
        }
      }
    }
  }
}

function buildScorch(r: number): HTMLCanvasElement {
  const size = r * 2 + 2;
  const c = makeCanvas(size, size);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(size, size);
  const buf = new Uint32Array(img.data.buffer);
  const dark = packRgba('#050407', 150);
  const mid = packRgba('#0c0a0f', 95);
  const ember = packRgba('#3a1d14', 120);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2;
      const dy = y + 0.5 - size / 2;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      const n = hash2(x, y, r);
      const wobble = 0.82 + hash2(Math.floor(Math.atan2(dy, dx) * 3), r, 2) * 0.3;
      if (d > wobble) continue;
      const density = 1 - d / wobble;
      if (n < density * 0.95) buf[y * size + x] = d < 0.45 * wobble ? dark : n < density * 0.3 ? ember : mid;
      else if (n < 0.08) buf[y * size + x] = mid;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
