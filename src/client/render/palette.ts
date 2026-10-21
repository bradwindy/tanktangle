export type Rgb = [number, number, number];

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (h.length < 6 || !Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = ([r, g, b]: Rgb) =>
  '#' + ((1 << 24) | (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)).toString(16).slice(1);

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
};

/** Packs a colour for a little-endian Uint32 view of ImageData (bytes R, G, B, A). */
export function packRgba(hex: string, alpha = 255): number {
  const [r, g, b] = hexToRgb(hex);
  return ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Outlines, the darkest ink everywhere. */
export const INK = '#0b0a12';
export const VOID = '#08070d';
export const WHITE = '#ffffff';

export const FLOOR = {
  base: '#1c1930',
  alt: '#1f1c36',
  seam: '#141224',
  bevel: '#25213e',
  speckLight: '#2a2646',
  speckDark: '#161427',
  detail: '#2f2a4e',
  detailDark: '#100e1c',
  voidDot: '#15131f',
};

export const STEEL = {
  outline: '#0d0c16',
  dark: '#39405a',
  base: '#5a6582',
  light: '#8592b2',
  hi: '#b8c4e0',
  rivet: '#e2e9f8',
  seam: '#2a3045',
};

export const BRICK = {
  outline: '#1b0b09',
  mortar: '#3f241c',
  dark: '#8a3820',
  base: '#b5502f',
  alt: '#a6472a',
  light: '#d6704a',
  hi: '#f2a06e',
  crack: '#2a120c',
  rubble: '#5e2a1c',
};

/** Hot to cool: white core, yellow, orange, red, ember, soot. */
export const FIRE = ['#ffffff', '#fff7c2', '#ffe14d', '#ffb03a', '#ff7a2a', '#e8431f', '#a82418', '#5a1a1c', '#2e2228'];
export const SPARK = ['#ffffff', '#fff4a8', '#ffd23d', '#ff9a2a', '#e8551f'];
export const SMOKE = ['#a9a5b8', '#86829a', '#67637d', '#4b4861', '#35334a'];
export const DUST = ['#cbb59a', '#a48b70', '#7c6650', '#5a4a3c'];
export const TOXIC = ['#e4ff8a', '#a6ff4a', '#5fd23a', '#2f8f3a', '#1d4f2c'];
export const ENERGY = ['#ffffff', '#ffc8ff', '#f07bff', '#c04dff', '#7a2bd6', '#3d1a80'];
export const CYAN = ['#ffffff', '#c8fbff', '#6ef0ff', '#2ab8e8', '#1a6fb8'];
export const BRASS = ['#fff0a0', '#e8c25a', '#b8862a', '#7a5418'];

/** Accent colour for each weapon (crate tint, barrel glow, popup text). Index is the Weapon or Upgrade value. */
export const KIND_COLOR: Record<number, string> = {
  0: '#e8ecf5',
  1: '#5ef2ff',
  2: '#ffcf4a',
  3: '#ff6a3d',
  4: '#ff9a2a',
  5: '#8fe04f',
  6: '#ffd23d',
  7: '#d66bff',
  8: '#ff4d6a',
  9: '#5ec8ff',
  10: '#6dff8a',
  11: '#ffe14d',
  12: '#ff5a5a',
  99: '#a6ff4a',
};

interface TankRamp {
  outline: string;
  shadow: string;
  dark: string;
  base: string;
  light: string;
  hi: string;
  grille: string;
  treadDark: string;
  treadMid: string;
  treadLight: string;
}

export const luma = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** Very bright player colours are toned down a little so tank bodies do not bloom like light sources. */
const MAX_TANK_LUMA = 0.76;

export function tankRamp(input: string): TankRamp {
  const l = luma(input);
  const color = l > MAX_TANK_LUMA ? mix(input, INK, 1 - MAX_TANK_LUMA / l) : input;
  return {
    outline: mix(color, INK, 0.86),
    shadow: mix(color, INK, 0.62),
    dark: mix(color, INK, 0.42),
    base: mix(color, INK, 0.16),
    light: color,
    hi: mix(color, WHITE, 0.38),
    grille: mix(color, INK, 0.72),
    treadDark: mix('#1d1b29', color, 0.1),
    treadMid: mix('#37344a', color, 0.22),
    treadLight: mix('#5a566e', color, 0.26),
  };
}
