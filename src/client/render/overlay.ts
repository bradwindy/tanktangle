import { MAX_HP, TANK_HALF_L } from '../../shared/constants';
import type { ViewState, ViewTank } from '../view';
import { toScreen, type CameraView, type ViewRect } from './camera';
import { INK, mix, rgba } from './palette';
import { ctx2d, makeCanvas } from './pixels';

/** Canvas text matches the UI: heavy Handjet for banners, popups and the YOU plate, Share Tech Mono for name tags. */
export const HEADING_FONT = (px: number) => `800 ${px}px Handjet, ui-monospace, monospace`;
export const TAG_FONT = (px: number) => `${px}px "Share Tech Mono", ui-monospace, monospace`;
/** Share of the font size Handjet's capitals take up, across and above the baseline. */
const HEADING_ADVANCE = 0.45;
const HEADING_CAP = 0.67;
/** Popup sizes were tuned for a square pixel font. Handjet caps are shorter, so popups scale up to match. */
const POPUP_SCALE = 1.6;
const PHOSPHOR = '#f2f2ee';

interface Popup {
  key: string;
  text: string;
  color: string;
  size: number;
  x: number;
  y: number;
  age: number;
  dur: number;
  sprite: TextSprite | null;
}

interface Banner {
  text: string;
  color: string;
  age: number;
  dur: number;
  sprite: TextSprite | null;
  size: number;
}

interface TextSprite {
  canvas: HTMLCanvasElement;
  /** Device px from the canvas top to the alphabetic baseline. */
  baseline: number;
  /** Width of the text itself, without the outline and glow margin. */
  textW: number;
}

/**
 * Renders outlined, drop-shadowed text into its own canvas at device resolution. glow is the phosphor glow's blur as
 * a share of the font size, 0 for none.
 */
function renderText(text: string, font: (px: number) => string, px: number, color: string, glow: number): TextSprite {
  const o = Math.max(1, Math.round(px / 12));
  const blur = glow > 0 ? Math.max(2, Math.round(px * glow)) : 0;
  const pad = o * 2 + blur;
  const css = font(px);
  const probe = ctx2d(makeCanvas(1, 1));
  probe.font = css;
  const textW = Math.ceil(probe.measureText(text).width);
  const ascent = Math.round(px * 0.95);
  const c = makeCanvas(textW + pad * 2, ascent + Math.round(px * 0.3) + pad * 2 + o);
  const ctx = ctx2d(c);
  ctx.font = css;
  ctx.textBaseline = 'alphabetic';
  const x = pad;
  const y = pad + ascent;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(text, x, y + o * 2);
  if (blur > 0) {
    ctx.shadowColor = rgba(color, 0.75);
    ctx.shadowBlur = blur;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = INK;
  for (let dx = -o; dx <= o; dx += o) for (let dy = -o; dy <= o; dy += o) if (dx || dy) ctx.fillText(text, x + dx, y + dy);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return { canvas: c, baseline: y, textW };
}

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let v = cache.get(key);
  if (v === undefined) {
    if (cache.size > 64) cache.clear();
    v = make();
    cache.set(key, v);
  }
  return v;
}

const ARROW_W = 11;
const ARROW_H = 10;
const SHAFT = 4;

/** Down-pointing arrow in art pixels: a 5 wide shaft over a head that narrows to a point. */
function inArrow(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= ARROW_W || y >= ARROW_H) return false;
  if (y < SHAFT) return x >= 3 && x <= 7;
  const inset = y - SHAFT;
  return x >= inset && x <= ARROW_W - 1 - inset;
}

/**
 * The spawn arrow at device resolution: player colour, lit left edge, shaded right edge, a dark outline and a drop
 * shadow one art pixel down. The tip sits on the bottom edge of the outline (or the top edge when flipped).
 */
function renderArrow(color: string, px: number, up: boolean): HTMLCanvasElement {
  const cols = ARROW_W + 2;
  const rows = ARROW_H + 2;
  const c = makeCanvas(cols * px, (rows + 1) * px);
  const ctx = ctx2d(c);
  const shape = (x: number, y: number) => inArrow(x - 1, up ? ARROW_H - y : y - 1);
  const outline = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (shape(x + dx, y + dy)) return true;
    return false;
  };
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (outline(x, y)) ctx.fillRect(x * px, (y + 1) * px, px, px);
  const light = mix(color, '#ffffff', 0.45);
  const shade = mix(color, INK, 0.35);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!outline(x, y)) continue;
      ctx.fillStyle = !shape(x, y) ? INK : !shape(x - 1, y) ? light : !shape(x + 1, y) ? shade : color;
      ctx.fillRect(x * px, y * px, px, px);
    }
  }
  return c;
}

/** The YOU plate over the spawn arrow: dark text on a phosphor block with a dark border and a swatch of your colour. */
function renderPlate(color: string, px: number, dpr: number, glow: boolean): TextSprite {
  const css = HEADING_FONT(px);
  const probe = ctx2d(makeCanvas(1, 1));
  probe.font = css;
  const textW = Math.ceil(probe.measureText('YOU').width);
  const border = Math.max(2, Math.round(3 * dpr));
  const padX = Math.round(12 * dpr);
  const padY = Math.round(7 * dpr);
  const swatch = Math.round(px * 0.6);
  const gap = Math.round(8 * dpr);
  const halo = glow ? Math.round(12 * dpr) : 0;
  const capH = Math.round(px * HEADING_CAP);
  const innerW = padX * 2 + swatch + gap + textW;
  const innerH = padY * 2 + capH;
  const c = makeCanvas(innerW + (border + halo) * 2, innerH + (border + halo) * 2);
  const ctx = ctx2d(c);
  const x0 = halo + border;
  const y0 = halo + border;
  if (glow) {
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = halo;
  }
  ctx.fillStyle = INK;
  ctx.fillRect(halo, halo, innerW + border * 2, innerH + border * 2);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = PHOSPHOR;
  ctx.fillRect(x0, y0, innerW, innerH);
  const ring = Math.max(1, Math.round(2 * dpr));
  const sy = y0 + Math.round((innerH - swatch) / 2);
  ctx.fillStyle = INK;
  ctx.fillRect(x0 + padX, sy, swatch, swatch);
  ctx.fillStyle = color;
  ctx.fillRect(x0 + padX + ring, sy + ring, swatch - ring * 2, swatch - ring * 2);
  ctx.font = css;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.fillText('YOU', x0 + padX + swatch + gap, y0 + padY + capH);
  return { canvas: c, baseline: 0, textW: c.width };
}

/** Points out the local tank. strength fades it out, age drives the bounce, bounce scales it (reduced motion). */
export interface SpawnMarker {
  strength: number;
  age: number;
  bounce: number;
}

const HEADING_GLOW = 0.4;
const TAG_GLOW = 0.22;

/** The display-resolution text layer: name tags, health pips, damage numbers, pickup popups, the spawn arrow, banners. */
export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private glow = true;
  private tags = new Map<string, TextSprite>();
  private labels = new Map<string, TextSprite>();
  private arrows = new Map<string, HTMLCanvasElement>();
  private popups: Popup[] = [];
  private banner: Banner | null = null;
  /** Device px y of the top of your name tag this frame, so the spawn arrow sits above it. */
  private myTagTop: number | null = null;
  /** Device px rows the spawn arrow and your tank cover this frame, which the banner moves out of. */
  private keepClear: { top: number; bottom: number } | null = null;

  constructor(private readonly target: HTMLCanvasElement) {
    this.ctx = ctx2d(target);
  }

  /** The canvas drawn into, for the post pass to composite. */
  get canvas(): HTMLCanvasElement {
    return this.target;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.w = cssW;
    this.h = cssH;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.target.width !== bw || this.target.height !== bh) {
      this.target.width = bw;
      this.target.height = bh;
      this.ctx = ctx2d(this.target);
    }
    this.invalidateText();
  }

  /** Phosphor glow around text, on whenever the CRT look is. */
  setGlow(on: boolean): void {
    if (on === this.glow) return;
    this.glow = on;
    this.invalidateText();
  }

  /** Cached text was measured with fallback fonts until the web font loads. */
  invalidateText(): void {
    this.tags.clear();
    this.labels.clear();
    for (const p of this.popups) p.sprite = null;
    if (this.banner) this.banner.sprite = null;
  }

  popup(text: string, color: string, x: number, y: number, size = 8, dur = 0.9): void {
    const key = text + color + size;
    const same = this.popups.find((p) => p.key === key && p.age < 0.12 && Math.abs(p.x - x) < 12 && Math.abs(p.y - y) < 12);
    if (same) return;
    if (this.popups.length > 24) this.popups.shift();
    this.popups.push({ key, text, color, size, x, y, age: 0, dur, sprite: null });
  }

  showBanner(text: string, color: string): void {
    this.banner = { text, color, age: 0, dur: text.length <= 3 ? 0.9 : 1.5, sprite: null, size: 0 };
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

  /** Redraws the layer. Returns false when nothing was drawn, so the post pass can skip compositing it. */
  draw(view: ViewState, cam: CameraView, viewport: ViewRect, showTags: boolean, marker: SpawnMarker): boolean {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.target.width, this.target.height);
    ctx.imageSmoothingEnabled = false;
    this.myTagTop = null;
    let drew = showTags && this.drawTags(view, cam);
    const glow = this.glow ? HEADING_GLOW : 0;
    for (const p of this.popups) {
      p.sprite ??= renderText(p.text, HEADING_FONT, Math.round(p.size * POPUP_SCALE * dpr), p.color, glow);
      const c = p.sprite.canvas;
      const t = p.age / p.dur;
      const s = toScreen(cam, p.x, p.y);
      const pop = t < 0.12 ? 1.5 - (t / 0.12) * 0.5 : 1;
      const rise = (1 - (1 - t) * (1 - t)) * 22;
      ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      const w = Math.round(c.width * pop);
      const h = Math.round(c.height * pop);
      ctx.drawImage(c, Math.round(s.x * dpr - w / 2), Math.round((s.y - rise) * dpr - h / 2), w, h);
      drew = true;
    }
    ctx.globalAlpha = 1;
    this.keepClear = null;
    if (marker.strength > 0) {
      const me = view.tanks.find((t) => t.isMe && t.alive);
      if (me) {
        this.drawSpawnArrow(me, cam, viewport, marker);
        drew = true;
      }
    }
    if (this.banner) {
      this.drawBanner(this.banner, viewport);
      drew = true;
    }
    return drew;
  }

  /**
   * A bouncing arrow labelled YOU above your tank, at a fixed screen size so it stays big when a large maze is
   * fitted to the screen. Flips below the tank, pointing up, when it would leave the top of the viewport.
   */
  private drawSpawnArrow(t: ViewTank, cam: CameraView, viewport: ViewRect, marker: SpawnMarker): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const px = Math.max(3, Math.round(4.5 * dpr));
    const gap = Math.round(3 * dpr);
    const maxBounce = 10 * dpr * marker.bounce;
    const bounce = Math.round(Math.abs(Math.sin(marker.age * 5)) * maxBounce);
    const s = toScreen(cam, t.x, t.y);
    const reach = (TANK_HALF_L + 2) * cam.scale * dpr;
    const plate = remember(this.labels, `plate|${t.color}|${dpr}|${this.glow}`, () => renderPlate(t.color, Math.round(26 * dpr), dpr, this.glow));
    const down = remember(this.arrows, `${px}|0`, () => renderArrow(PHOSPHOR, px, false));
    const arrowH = (ARROW_H + 2) * px;
    const plateH = plate.canvas.height;
    const tankTop = Math.min(s.y * dpr - reach, this.myTagTop ?? Infinity);
    const highest = tankTop - gap - maxBounce - arrowH - gap - plateH;
    const up = highest < viewport.y * dpr;
    const arrow = up ? remember(this.arrows, `${px}|1`, () => renderArrow(PHOSPHOR, px, true)) : down;
    const half = Math.max(arrow.width, plate.canvas.width) / 2;
    const cx = Math.min((viewport.x + viewport.w) * dpr - half, Math.max(viewport.x * dpr + half, s.x * dpr));
    const arrowTop = up ? s.y * dpr + reach + gap + bounce : tankTop - gap - bounce - arrowH;
    const plateTop = up ? arrowTop + arrowH + gap : arrowTop - gap - plateH;
    this.keepClear = up
      ? { top: s.y * dpr - reach, bottom: plateTop + plateH + maxBounce }
      : { top: plateTop - maxBounce, bottom: s.y * dpr + reach };
    ctx.globalAlpha = marker.strength * Math.min(1, marker.age / 0.15);
    ctx.drawImage(arrow, Math.round(cx - arrow.width / 2), Math.round(arrowTop));
    ctx.drawImage(plate.canvas, Math.round(cx - plate.canvas.width / 2), Math.round(plateTop));
    ctx.globalAlpha = 1;
  }

  private drawTags(view: ViewState, cam: CameraView): boolean {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const fontPx = Math.round(Math.min(18, Math.max(13, cam.scale * 5.5)) * dpr);
    const glow = this.glow ? TAG_GLOW : 0;
    let drew = false;
    for (const t of view.tanks) {
      if (!t.alive || !t.name) continue;
      const color = t.isMe ? PHOSPHOR : mix(t.color, '#ffffff', 0.2);
      const tag = remember(this.tags, `${t.name}|${color}|${fontPx}|${glow}`, () => renderText(t.name, TAG_FONT, fontPx, color, glow));
      const s = toScreen(cam, t.x, t.y - TANK_HALF_L - 3);
      const pipH = 3 * dpr;
      const showPips = t.isMe || t.hp < MAX_HP;
      const baseY = Math.round(s.y * dpr) - (showPips ? pipH + 2 * dpr : 0);
      const baseline = baseY - Math.round(fontPx * 0.22);
      if (t.isMe) {
        ctx.fillStyle = t.color;
        const ax = Math.round(s.x * dpr);
        const ay = baseline - Math.round(fontPx * 0.78) - Math.round(4 * dpr);
        const a = Math.round(3 * dpr);
        this.myTagTop = ay - a;
        ctx.fillRect(ax - a, ay - a, a * 2, Math.max(1, Math.round(dpr)));
        ctx.fillRect(ax - Math.round(a / 2), ay - a + Math.round(dpr), a, Math.max(1, Math.round(dpr)));
      }
      ctx.drawImage(tag.canvas, Math.round(s.x * dpr - tag.canvas.width / 2), baseline - tag.baseline);
      if (showPips) this.drawPips(Math.round(s.x * dpr), baseY + Math.round(dpr), t.hp, t.color);
      drew = true;
    }
    return drew;
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
      ctx.fillStyle = i < hp ? (hp === 1 ? '#ff4d4d' : mix(color, '#ffffff', 0.15)) : '#2e2e2e';
      ctx.fillRect(x, top, size, size);
      x += size + gap;
    }
  }

  private drawBanner(b: Banner, viewport: ViewRect): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const n = Math.max(1, b.text.length);
    const cap = n <= 3 ? 170 : 104;
    const cssSize = Math.max(16, Math.min(cap, Math.floor((viewport.w * 0.86) / (n * HEADING_ADVANCE))));
    const size = Math.round(cssSize * dpr);
    if (!b.sprite || b.size !== size) {
      b.sprite = renderText(b.text, HEADING_FONT, size, b.color, this.glow ? HEADING_GLOW : 0);
      b.size = size;
    }
    const c = b.sprite.canvas;
    const t = b.age;
    const out = b.dur - t;
    let scale = 1;
    if (t < 0.12) scale = 2.4 - (t / 0.12) * 1.55;
    else if (t < 0.22) scale = 0.85 + ((t - 0.12) / 0.1) * 0.15;
    if (out < 0.25) scale = 1 + (1 - out / 0.25) * 0.25;
    ctx.globalAlpha = out < 0.25 ? out / 0.25 : 1;
    const w = Math.round(c.width * scale);
    const h = Math.round(c.height * scale);
    const cx = (viewport.x + viewport.w / 2) * dpr;
    let cy = (viewport.y + viewport.h * 0.42) * dpr;
    // The countdown must not cover the YOU arrow, which in the follow camera sits mid-screen with it.
    const clear = this.keepClear;
    if (clear && cy + c.height / 2 > clear.top && cy - c.height / 2 < clear.bottom) {
      const top = viewport.y * dpr;
      const bottom = (viewport.y + viewport.h) * dpr;
      cy = clear.top - top > bottom - clear.bottom ? (top + clear.top) / 2 : (clear.bottom + bottom) / 2;
    }
    ctx.drawImage(c, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
    ctx.globalAlpha = 1;
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }
}
