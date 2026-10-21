import { TILE } from '../../shared/constants';
import { RARE_CRATES } from '../../shared/weapons';
import type { Crate } from '../../shared/types';
import { KIND_COLOR } from './palette';
import { checker, circlePath } from './raster';
import { CRATE_SIZE, type SpriteBank } from './sprites';

const DROP_SECONDS = 0.45;

/** Crates bob, drop in when they first appear, and rare ones catch a golden glint. */
export class CrateLayer {
  private firstSeen = new Map<number, number>();
  /** Last known cell of every crate, so a Pick event can find a crate the client already removed. */
  readonly known = new Map<number, Crate>();

  constructor(private sprites: SpriteBank) {}

  reset(): void {
    this.firstSeen.clear();
    this.known.clear();
  }

  noteSpawn(c: Crate, now: number): void {
    this.known.set(c.id, c);
    this.firstSeen.set(c.id, now);
  }

  update(crates: readonly Crate[], now: number): void {
    for (const c of crates) {
      if (!this.firstSeen.has(c.id)) this.firstSeen.set(c.id, now);
      this.known.set(c.id, c);
    }
    if (this.firstSeen.size > crates.length + 16) {
      const live = new Set(crates.map((c) => c.id));
      for (const id of this.firstSeen.keys()) if (!live.has(id)) this.firstSeen.delete(id);
      for (const id of this.known.keys()) if (!live.has(id)) this.known.delete(id);
    }
  }

  draw(ctx: CanvasRenderingContext2D, crates: readonly Crate[], now: number): void {
    for (const c of crates) {
      const cx = c.cx * TILE + TILE / 2;
      const cy = c.cy * TILE + TILE / 2;
      const age = now - (this.firstSeen.get(c.id) ?? now);
      const drop = age < DROP_SECONDS ? dropHeight(age / DROP_SECONDS) : 0;
      const bob = drop > 0 ? 0 : Math.round(Math.sin(now * 3.2 + c.id * 1.7) * 1.2);
      const lift = Math.round(drop) + Math.max(0, -bob) + 1;
      const color = KIND_COLOR[c.kind] ?? '#ffffff';
      const pulse = 0.5 + 0.5 * Math.sin(now * 4 + c.id);
      ctx.fillStyle = checker(ctx, color, Math.floor(now * 4) & 1);
      ctx.globalAlpha = 0.18 + pulse * 0.2;
      ctx.beginPath();
      circlePath(ctx, Math.round(cx), Math.round(cy), 11 + Math.round(pulse));
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#000000';
      const sw = Math.max(6, 14 - Math.round(lift / 3));
      ctx.fillRect(Math.round(cx - sw / 2), Math.round(cy + CRATE_SIZE / 2 - 2), sw, 2);
      ctx.globalAlpha = 1;
      const x = Math.round(cx - CRATE_SIZE / 2);
      const y = Math.round(cy - CRATE_SIZE / 2) - lift;
      ctx.drawImage(this.sprites.crate(c.kind), x, y);
      if (RARE_CRATES.includes(c.kind)) drawGlint(ctx, x, y, now + c.id);
    }
  }
}

function dropHeight(t: number): number {
  if (t < 0.6) {
    const k = t / 0.6;
    return 40 * (1 - k * k);
  }
  const k = (t - 0.6) / 0.4;
  return 5 * Math.sin(k * Math.PI);
}

function drawGlint(ctx: CanvasRenderingContext2D, x: number, y: number, time: number): void {
  const cycle = time % 1.6;
  if (cycle > 0.5) return;
  const k = Math.floor((cycle / 0.5) * (CRATE_SIZE * 2 + 4)) - 2;
  ctx.fillStyle = '#fffbe0';
  ctx.beginPath();
  for (let i = 1; i < CRATE_SIZE - 1; i++) {
    const j = k - i;
    if (j >= 1 && j < CRATE_SIZE - 1) ctx.rect(x + i, y + j, 1, 1);
    if (j + 1 >= 1 && j + 1 < CRATE_SIZE - 1) ctx.rect(x + i, y + j + 1, 1, 1);
  }
  ctx.fill();
}
