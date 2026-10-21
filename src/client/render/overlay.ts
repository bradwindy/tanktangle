import { MAX_HP, TANK_HALF_L } from '../../shared/constants';
import type { ViewState } from '../view';
import { toScreen, type CameraView, type ViewRect } from './camera';
import { INK, mix } from './palette';
import { ctx2d, makeCanvas } from './pixels';

export const HEADING_FONT = '"Press Start 2P", monospace';
export const BODY_FONT = 'VT323, monospace';

interface Popup {
  key: string;
  text: string;
  color: string;
  size: number;
  x: number;
  y: number;
  age: number;
  dur: number;
  canvas: HTMLCanvasElement | null;
}

interface Banner {
  text: string;
  color: string;
  age: number;
  dur: number;
  canvas: HTMLCanvasElement | null;
  size: number;
}

/** Renders outlined, drop-shadowed text into its own canvas at device resolution. */
function renderText(text: string, font: string, px: number, color: string, arcade: boolean): HTMLCanvasElement {
  const o = Math.max(1, Math.round(px / 8));
  const probe = ctx2d(makeCanvas(1, 1));
  probe.font = `${px}px ${font}`;
  const w = Math.ceil(probe.measureText(text).width) + o * 4;
  const h = Math.ceil(px * 1.25) + o * 5;
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.font = `${px}px ${font}`;
  ctx.textBaseline = 'top';
  const x = o * 2;
  const y = o * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(text, x, y + o * 2);
  ctx.fillStyle = INK;
  for (let dx = -o; dx <= o; dx += o) for (let dy = -o; dy <= o; dy += o) if (dx || dy) ctx.fillText(text, x + dx, y + dy);
  if (arcade) {
    const g = ctx.createLinearGradient(0, y, 0, y + px);
    g.addColorStop(0, mix(color, '#ffffff', 0.65));
    g.addColorStop(0.45, mix(color, '#ffffff', 0.65));
    g.addColorStop(0.46, color);
    g.addColorStop(0.8, color);
    g.addColorStop(0.81, mix(color, INK, 0.35));
    g.addColorStop(1, mix(color, INK, 0.35));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = color;
  }
  ctx.fillText(text, x, y);
  return c;
}

/** The display-resolution text layer: name tags, health pips, damage numbers, pickup popups, banners. */
export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private tags = new Map<string, HTMLCanvasElement>();
  private popups: Popup[] = [];
  private banner: Banner | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = ctx2d(canvas);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.w = cssW;
    this.h = cssH;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.ctx = ctx2d(this.canvas);
    }
    this.invalidateText();
  }

  /** Cached text was measured with fallback fonts until the pixel fonts load. */
  invalidateText(): void {
    this.tags.clear();
    for (const p of this.popups) p.canvas = null;
    if (this.banner) this.banner.canvas = null;
  }

  popup(text: string, color: string, x: number, y: number, size = 8, dur = 0.9): void {
    const key = text + color + size;
    const same = this.popups.find((p) => p.key === key && p.age < 0.12 && Math.abs(p.x - x) < 12 && Math.abs(p.y - y) < 12);
    if (same) return;
    if (this.popups.length > 24) this.popups.shift();
    this.popups.push({ key, text, color, size, x, y, age: 0, dur, canvas: null });
  }

  showBanner(text: string, color: string): void {
    this.banner = { text, color, age: 0, dur: text.length <= 3 ? 0.9 : 1.5, canvas: null, size: 0 };
  }

  update(dt: number): void {
    let w = 0;
    for (const p of this.popups) {
      p.age += dt;
      if (p.age < p.dur) this.popups[w++] = p;
    }
    this.popups.length = w;
    if (this.banner) {
      this.banner.age += dt;
      if (this.banner.age >= this.banner.dur) this.banner = null;
    }
  }

  draw(view: ViewState, cam: CameraView, viewport: ViewRect, showTags: boolean): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    if (showTags) this.drawTags(view, cam);
    for (const p of this.popups) {
      p.canvas ??= renderText(p.text, HEADING_FONT, Math.round(p.size * dpr), p.color, true);
      const t = p.age / p.dur;
      const s = toScreen(cam, p.x, p.y);
      const pop = t < 0.12 ? 1.5 - (t / 0.12) * 0.5 : 1;
      const rise = (1 - (1 - t) * (1 - t)) * 22;
      ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      const w = Math.round(p.canvas.width * pop);
      const h = Math.round(p.canvas.height * pop);
      ctx.drawImage(p.canvas, Math.round(s.x * dpr - w / 2), Math.round((s.y - rise) * dpr - h / 2), w, h);
    }
    ctx.globalAlpha = 1;
    if (this.banner) this.drawBanner(this.banner, viewport);
  }

  private drawTags(view: ViewState, cam: CameraView): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const fontPx = Math.round(Math.min(22, Math.max(15, cam.scale * 6.5)) * dpr);
    for (const t of view.tanks) {
      if (!t.alive || !t.name) continue;
      const key = `${t.name}|${t.color}|${t.isMe ? 1 : 0}|${fontPx}`;
      let tag = this.tags.get(key);
      if (!tag) {
        tag = renderText(t.name, BODY_FONT, fontPx, t.isMe ? '#ffffff' : mix(t.color, '#ffffff', 0.2), false);
        if (this.tags.size > 64) this.tags.clear();
        this.tags.set(key, tag);
      }
      const s = toScreen(cam, t.x, t.y - TANK_HALF_L - 3);
      const pipH = 3 * dpr;
      const showPips = t.isMe || t.hp < MAX_HP;
      const baseY = Math.round(s.y * dpr) - (showPips ? pipH + 2 * dpr : 0);
      const x = Math.round(s.x * dpr - tag.width / 2);
      const y = baseY - tag.height + Math.round(fontPx * 0.25);
      if (t.isMe) {
        ctx.fillStyle = t.color;
        const ax = Math.round(s.x * dpr);
        const ay = y - Math.round(4 * dpr);
        const a = Math.round(3 * dpr);
        ctx.fillRect(ax - a, ay - a, a * 2, Math.max(1, Math.round(dpr)));
        ctx.fillRect(ax - Math.round(a / 2), ay - a + Math.round(dpr), a, Math.max(1, Math.round(dpr)));
      }
      ctx.drawImage(tag, x, y);
      if (showPips) this.drawPips(Math.round(s.x * dpr), baseY + Math.round(dpr), t.hp, t.color);
    }
  }

  private drawPips(cx: number, top: number, hp: number, color: string): void {
    const ctx = this.ctx;
    const d = this.dpr;
    const size = Math.round(4 * d);
    const gap = Math.round(2 * d);
    const total = MAX_HP * size + (MAX_HP - 1) * gap;
    let x = cx - Math.round(total / 2);
    for (let i = 0; i < MAX_HP; i++) {
      ctx.fillStyle = INK;
      ctx.fillRect(x - Math.round(d), top - Math.round(d), size + Math.round(2 * d), size + Math.round(2 * d));
      ctx.fillStyle = i < hp ? (hp === 1 ? '#ff4d4d' : mix(color, '#ffffff', 0.15)) : '#2a2638';
      ctx.fillRect(x, top, size, size);
      x += size + gap;
    }
  }

  private drawBanner(b: Banner, viewport: ViewRect): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const n = Math.max(1, b.text.length);
    const cap = n <= 3 ? 112 : 72;
    const cssSize = Math.max(16, Math.min(cap, Math.floor((viewport.w * 0.86) / n / 8) * 8));
    const size = Math.round(cssSize * dpr);
    if (!b.canvas || b.size !== size) {
      b.canvas = renderText(b.text, HEADING_FONT, size, b.color, true);
      b.size = size;
    }
    const t = b.age;
    const out = b.dur - t;
    let scale = 1;
    if (t < 0.12) scale = 2.4 - (t / 0.12) * 1.55;
    else if (t < 0.22) scale = 0.85 + ((t - 0.12) / 0.1) * 0.15;
    if (out < 0.25) scale = 1 + (1 - out / 0.25) * 0.25;
    ctx.globalAlpha = out < 0.25 ? out / 0.25 : 1;
    const w = Math.round(b.canvas.width * scale);
    const h = Math.round(b.canvas.height * scale);
    const cx = (viewport.x + viewport.w / 2) * dpr;
    const cy = (viewport.y + viewport.h * 0.42) * dpr;
    ctx.drawImage(b.canvas, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
    ctx.globalAlpha = 1;
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }
}
