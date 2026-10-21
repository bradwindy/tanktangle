import { TILE } from '../../shared/constants';
import { isSolid, wallCount, wallRect } from '../../shared/grid';
import { WallKind, type MazeState } from '../../shared/types';
import type { ViewState } from '../view';
import { BRICK, FLOOR, INK, KIND_COLOR, mix, rgba, STEEL, VOID } from './palette';
import { ctx2d, makeCanvas } from './pixels';

const BORDER = 3;

/** Draws the whole maze into a small HUD canvas: walls, storm, crates, tanks and the camera window. */
export class Minimap {
  private walls: HTMLCanvasElement | null = null;
  private wallsFor: MazeState | null = null;
  private wallsSize = '';
  private dirty = true;

  invalidate(): void {
    this.dirty = true;
  }

  draw(canvas: HTMLCanvasElement, view: ViewState, camera: { x0: number; y0: number; x1: number; y1: number } | null, time: number): void {
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = ctx2d(canvas);
    const m = view.maze;
    const ww = m.w * TILE;
    const wh = m.h * TILE;
    const pad = BORDER * dpr;
    const scale = Math.min((bw - pad * 2) / ww, (bh - pad * 2) / wh);
    const ox = Math.round((bw - ww * scale) / 2);
    const oy = Math.round((bh - wh * scale) / 2);
    const sx = (x: number) => ox + x * scale;
    const sy = (y: number) => oy + y * scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.fillStyle = rgba(VOID, 0.82);
    ctx.fillRect(0, 0, bw, bh);
    ctx.fillStyle = FLOOR.base;
    ctx.fillRect(ox, oy, Math.round(ww * scale), Math.round(wh * scale));
    const key = `${bw}x${bh}`;
    if (this.dirty || this.wallsFor !== m || this.wallsSize !== key || !this.walls) {
      this.walls = renderWalls(m, bw, bh, scale, ox, oy, dpr);
      this.wallsFor = m;
      this.wallsSize = key;
      this.dirty = false;
    }
    if (view.storm) {
      const s = view.storm;
      ctx.fillStyle = 'rgba(95,210,58,0.42)';
      const x0 = sx(Math.max(0, s.x0));
      const y0 = sy(Math.max(0, s.y0));
      const x1 = sx(Math.min(ww, s.x1));
      const y1 = sy(Math.min(wh, s.y1));
      ctx.fillRect(ox, oy, ww * scale, y0 - oy);
      ctx.fillRect(ox, y1, ww * scale, oy + wh * scale - y1);
      ctx.fillRect(ox, y0, x0 - ox, y1 - y0);
      ctx.fillRect(x1, y0, ox + ww * scale - x1, y1 - y0);
      ctx.strokeStyle = '#a6ff4a';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
    }
    ctx.drawImage(this.walls, 0, 0);
    const dot = Math.max(2, Math.round(2 * dpr));
    for (const c of view.crates) {
      if (Math.floor(time * 3 + c.id) % 3 === 0) continue;
      ctx.fillStyle = KIND_COLOR[c.kind] ?? '#ffffff';
      ctx.fillRect(Math.round(sx((c.cx + 0.5) * TILE)) - dot / 2, Math.round(sy((c.cy + 0.5) * TILE)) - dot / 2, dot, dot);
    }
    const tankDot = Math.max(3, Math.round(3 * dpr));
    for (const t of view.tanks) {
      if (!t.alive) continue;
      const x = Math.round(sx(t.x));
      const y = Math.round(sy(t.y));
      const size = t.isMe ? tankDot + 2 : tankDot;
      ctx.fillStyle = INK;
      ctx.fillRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2);
      ctx.fillStyle = t.isMe ? mix(t.color, '#ffffff', 0.35) : t.color;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      if (t.isMe && Math.floor(time * 3) % 2 === 0) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeRect(x - size / 2 - 2.5, y - size / 2 - 2.5, size + 5, size + 5);
      }
    }
    if (camera) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(1, dpr);
      const x0 = Math.round(sx(Math.max(-TILE, camera.x0)));
      const y0 = Math.round(sy(Math.max(-TILE, camera.y0)));
      const x1 = Math.round(sx(Math.min(ww + TILE, camera.x1)));
      const y1 = Math.round(sy(Math.min(wh + TILE, camera.y1)));
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    }
  }
}

function renderWalls(m: MazeState, bw: number, bh: number, scale: number, ox: number, oy: number, dpr: number): HTMLCanvasElement {
  const c = makeCanvas(bw, bh);
  const ctx = ctx2d(c);
  const n = wallCount(m.w, m.h);
  const minW = Math.max(1, Math.round(dpr));
  for (const pass of [WallKind.Brick, WallKind.Steel]) {
    ctx.fillStyle = pass === WallKind.Steel ? STEEL.light : BRICK.hi;
    for (let id = 0; id < n; id++) {
      if (m.walls[id] !== pass || !isSolid(m, id)) continue;
      const r = wallRect(m, id);
      const x = Math.floor(ox + r.x0 * scale);
      const y = Math.floor(oy + r.y0 * scale);
      const w = Math.max(minW, Math.round((r.x1 - r.x0) * scale));
      const h = Math.max(minW, Math.round((r.y1 - r.y0) * scale));
      ctx.fillRect(x, y, w, h);
    }
  }
  return c;
}
