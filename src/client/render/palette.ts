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
export const INK = '#0b0b0b';
export const VOID = '#090909';
export const WHITE = '#ffffff';

/** The world is neutral grey so the colour belongs to tanks, shots, crates and explosions. */
export const FLOOR = {
  base: '#2a2a2a',
  alt: '#2d2d2d',
  seam: '#1e1e1e',
  bevel: '#333333',
  speckLight: '#383838',
  speckDark: '#232323',
  detail: '#3d3d3d',
  detailDark: '#191919',
  voidDot: '#161616',
};

/** Kept darker than a white tank so it never reads as a wall. */
export const STEEL = {
  outline: '#0e0e0e',
  dark: '#444444',
  base: '#626262',
  light: '#7a7a7a',
  hi: '#9a9a9a',
  rivet: '#c8c8c8',
  seam: '#363636',
};

/** Muted brown, darker and redder than the tan player colour. */
export const BRICK = {
  outline: '#140e0b',
  mortar: '#2c211c',
  dark: '#563526',
  base: '#7a4d3a',
  alt: '#704634',
  light: '#8e5c46',
  hi: '#a8735a',
  crack: '#1c130f',
  rubble: '#452f25',
};

/** Hot to cool: white core, yellow, orange, red, ember, soot. */
export const FIRE = ['#ffffff', '#fff7c2', '#ffe14d', '#ffb03a', '#ff7a2a', '#e8431f', '#a82418', '#5a1a1c', '#2e2228'];
export const SPARK = ['#ffffff', '#fff4a8', '#ffd23d', '#ff9a2a', '#e8551f'];
export const SMOKE = ['#ababab', '#888888', '#696969', '#4c4c4c', '#363636'];
export const DARK_SMOKE = ['#4c4c4c', '#363636', '#262626', '#1a1a1a'];
/** Barrels, mines and antennas. */
export const GUNMETAL = { dark: '#3e3e3e', mid: '#717171', light: '#b3b3b3' };
export const DUST = ['#cbb59a', '#a48b70', '#7c6650', '#5a4a3c'];
export const TOXIC = ['#e4ff8a', '#a6ff4a', '#5fd23a', '#2f8f3a', '#1d4f2c'];
export const ENERGY = ['#ffffff', '#ffc8ff', '#f07bff', '#c04dff', '#7a2bd6', '#3d1a80'];
export const CYAN = ['#ffffff', '#c8fbff', '#6ef0ff', '#2ab8e8', '#1a6fb8'];
export const BRASS = ['#fff0a0', '#e8c25a', '#b8862a', '#7a5418'];

/** Accent colour for each weapon (crate tint, barrel glow, popup text). Index is the Weapon or Upgrade value. */
export const KIND_COLOR: Record<number, string> = {
  0: '#eeeeee',
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
    treadDark: mix('#1e1e1e', color, 0.1),
    treadMid: mix('#3a3a3a', color, 0.22),
    treadLight: mix('#5e5e5e', color, 0.26),
  };
}
