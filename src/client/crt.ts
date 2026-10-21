import './crt.css';
import { svg } from './dom';
import { hsyncJitter } from './render/jitter';
import type { CrtLevel } from './view';

const GLOW_ID = 'crt-glow';
/** Scanline pitch in CSS px. */
const SCAN_PITCH = 3;
/** Matches the slack around .crt-noise in crt.css. */
const NOISE_TILE = 128;
/** Repainting the tube costs a few ms per megapixel, so a burst of resizes is painted once at the end. */
const REBUILD_DELAY_MS = 160;
/** Share of the screen's short side rounded off at each corner. */
const CORNER_RADIUS = 0.02;
/** CSS px of shading just inside the screen's edge. */
const RIM = 12;
const MASK_TINTS = [
  [255, 72, 72],
  [72, 255, 72],
  [72, 112, 255],
] as const;

type LitLevel = Exclude<CrtLevel, 'off'>;

/**
 * The UI root's filter. Text glows and fringes through text-shadow in crt.css. Full adds an SVG glow in each
 * element's own colour, so borders and bars glow too. A CSS drop-shadow would glow in one colour and haze the dark
 * panels, so it cannot give the same look.
 */
const UI_FILTER: Record<LitLevel, string> = {
  full: `url(#${GLOW_ID})`,
  soft: 'blur(0.3px)',
};

interface TubeLook {
  /** Darkness of the gap between scanlines. */
  scan: number;
  /** Strength of the aperture grille's colour stripes. */
  mask: number;
  /** Darkening toward the edges, 0 for none. */
  vignette: number;
  /** Rounded corners and a shaded rim. */
  corners: boolean;
}

const TUBES: Record<LitLevel, TubeLook> = {
  full: { scan: 0.26, mask: 0.035, vignette: 0.55, corners: true },
  soft: { scan: 0.2, mask: 0.028, vignette: 0, corners: false },
};

/**
 * The CRT look over the DOM UI and the whole screen: phosphor glow and fringe on the UI, the game's sync jitter, and
 * one screen layer of scanlines, mask, noise, flicker, rolling band, vignette and corners.
 */
export class CrtScreen {
  private level: CrtLevel = 'off';
  private readonly layer = document.createElement('div');
  private readonly tube = document.createElement('canvas');
  private readonly noise = document.createElement('canvas');
  private readonly reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  private tubeKey = '';
  private noiseKey = '';
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private raf = 0;
  private shift = 0;

  constructor(private readonly ui: HTMLElement) {
    ui.classList.add('crt-ui');
    this.layer.className = 'crt-screen';
    this.layer.setAttribute('aria-hidden', 'true');
    this.tube.className = 'crt-tube';
    this.noise.className = 'crt-noise';
    const band = document.createElement('div');
    band.className = 'crt-band';
    const flicker = document.createElement('div');
    flicker.className = 'crt-flicker';
    this.layer.append(this.tube, this.noise, band, flicker);

    const defs = svg('svg', { class: 'crt-defs', 'aria-hidden': 'true', focusable: 'false' });
    const filter = svg('filter', { id: GLOW_ID, x: '0', y: '0', width: '1', height: '1', 'color-interpolation-filters': 'sRGB' });
    const soft = svg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '0.35', result: 'soft' });
    const halo = svg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '3', result: 'halo' });
    const dim = svg('feComponentTransfer', { in: 'halo', result: 'glow' });
    dim.append(svg('feFuncA', { type: 'linear', slope: '0.4' }));
    const merge = svg('feMerge', {});
    merge.append(svg('feMergeNode', { in: 'glow' }), svg('feMergeNode', { in: 'soft' }));
    filter.append(soft, halo, dim, merge);
    defs.append(filter);
    document.body.append(defs, this.layer);

    const resized = () => this.schedule(REBUILD_DELAY_MS);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resized).observe(ui);
    else addEventListener('resize', resized);
  }

  setLevel(level: CrtLevel): void {
    document.documentElement.dataset.crt = level;
    if (level === this.level) return;
    this.level = level;
    this.ui.style.filter = level === 'off' ? '' : UI_FILTER[level];
    this.schedule(0);
    this.loop();
  }

  private size(): { w: number; h: number } {
    return { w: this.ui.clientWidth || innerWidth, h: this.ui.clientHeight || innerHeight };
  }

  private schedule(delay: number): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), delay);
  }

  private rebuild(): void {
    const level = this.level;
    const { w, h } = this.size();
    if (level === 'off' || w < 2 || h < 2) return;
    const tubeKey = `${w}x${h}|${level}`;
    if (tubeKey !== this.tubeKey) {
      paintTube(this.tube, w, h, TUBES[level]);
      this.tubeKey = tubeKey;
    }
    if (level === 'full' && this.noiseKey !== `${w}x${h}`) {
      paintNoise(this.noise, w + NOISE_TILE, h + NOISE_TILE);
      this.noiseKey = `${w}x${h}`;
    }
  }

  private loop(): void {
    if (this.level === 'full') {
      if (!this.raf) this.raf = requestAnimationFrame(this.tick);
      return;
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.setShift(0);
  }

  private readonly tick = (): void => {
    if (this.level !== 'full') {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
    // The 2D fallback renderer does not jitter the game, so the UI holds still with it.
    const still = this.reduceMotion?.matches || document.documentElement.dataset.presenter === '2d';
    this.setShift(still ? 0 : hsyncJitter(performance.now() / 1000));
  };

  /** The UI's half of the sync kick. The renderer reads the same hsyncJitter clock, so both jump together. */
  private setShift(px: number): void {
    if (px === this.shift) return;
    this.shift = px;
    this.ui.style.translate = px ? `${px}px 0` : '';
  }
}

/**
 * Paints the static part of the screen layer at 1 canvas px per CSS px. Built bottom up in premultiplied alpha: mask
 * tint, then scanline, vignette, and the rim and rounded corners.
 */
function paintTube(canvas: HTMLCanvasElement, w: number, h: number, look: TubeLook): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const lit = (t: number) => Math.pow(4 * t * (1 - t), 0.2);
  const litX = Float32Array.from({ length: w }, (_, x) => lit((x + 0.5) / w));
  const radius = Math.min(w, h) * CORNER_RADIUS;
  let o = 0;
  for (let y = 0; y < h; y++) {
    const scan = look.scan * Math.pow(0.5 + 0.5 * Math.cos(((y % SCAN_PITCH) / SCAN_PITCH) * Math.PI * 2), 1.5);
    const litY = lit((y + 0.5) / h);
    const ey = Math.min(y + 0.5, h - y - 0.5);
    for (let x = 0; x < w; x++, o += 4) {
      const tint = MASK_TINTS[(x % 3) as 0 | 1 | 2];
      let a = look.mask;
      let r = tint[0] * a;
      let g = tint[1] * a;
      let b = tint[2] * a;
      let k = scan;
      r *= 1 - k;
      g *= 1 - k;
      b *= 1 - k;
      a += k * (1 - a);
      if (look.vignette > 0) {
        k = look.vignette * (1 - litX[x] * litY);
        r *= 1 - k;
        g *= 1 - k;
        b *= 1 - k;
        a += k * (1 - a);
      }
      if (look.corners) {
        const ex = Math.min(x + 0.5, w - x - 0.5);
        const cx = radius - ex;
        const cy = radius - ey;
        const inside = cx > 0 && cy > 0 ? radius - Math.hypot(cx, cy) : Math.min(ex, ey);
        const rim = 1 - Math.max(0, inside) / RIM;
        k = Math.max(rim > 0 ? 0.45 * rim * rim : 0, 1 - Math.min(1, Math.max(0, inside + 0.5)));
        r *= 1 - k;
        g *= 1 - k;
        b *= 1 - k;
        a += k * (1 - a);
      }
      if (a > 0) {
        px[o] = r / a;
        px[o + 1] = g / a;
        px[o + 2] = b / a;
        px[o + 3] = a * 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Grey grain at 1 canvas px per CSS px, tiled from one random tile. */
function paintNoise(canvas: HTMLCanvasElement, w: number, h: number): void {
  const tile = document.createElement('canvas');
  tile.width = NOISE_TILE;
  tile.height = NOISE_TILE;
  const tctx = tile.getContext('2d');
  if (!tctx) return;
  const img = tctx.createImageData(NOISE_TILE, NOISE_TILE);
  for (let i = 0; i < img.data.length; i += 4) {
    const grey = Math.random() * 256;
    img.data[i] = grey;
    img.data[i + 1] = grey;
    img.data[i + 2] = grey;
    img.data[i + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const pattern = ctx?.createPattern(tile, 'repeat');
  if (!ctx || !pattern) return;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
}
