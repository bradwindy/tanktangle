import type { CAUSE_STORM, CrateKind, Weapon } from '../../shared/types';
import { ICON_KEY, ICON_OUTLINE_INDEX, ICON_OUTLINED, ICON_PALETTE, ICON_ROWS, type IconKind } from './iconmaps';
import { packRgba } from './palette';
import { blankMap, ctx2d, makeCanvas, mapToCanvas, outlineMap, parseMap, stamp, type PixelMap } from './pixels';

const LUT = new Uint32Array(ICON_PALETTE.map((c, i) => (i === 0 ? 0 : packRgba(c))));
const maps = new Map<number, PixelMap>();
const sprites = new Map<number, HTMLCanvasElement>();

/** The outlined 12x12 pixel map of an icon. */
export function iconMap(kind: IconKind): PixelMap {
  let map = maps.get(kind);
  if (!map) {
    const rows = ICON_ROWS[kind] ?? ICON_ROWS[0];
    map = blankMap(ICON_OUTLINED, ICON_OUTLINED);
    stamp(map, parseMap(rows, ICON_KEY), 1, 1);
    outlineMap(map, ICON_OUTLINE_INDEX, true);
    maps.set(kind, map);
  }
  return map;
}

/** The icon at one canvas pixel per icon pixel, for drawing into the low-res world. */
export function iconSprite(kind: IconKind): HTMLCanvasElement {
  let c = sprites.get(kind);
  if (!c) {
    c = mapToCanvas(iconMap(kind), LUT);
    sprites.set(kind, c);
  }
  return c;
}

/**
 * A crisp pixel icon scaled to px CSS pixels for the DOM HUD and kill feed.
 * Icon pixels are drawn at a whole-number scale so every pixel stays square. Returns a new canvas each call.
 */
export function weaponIcon(kind: Weapon | CrateKind | typeof CAUSE_STORM, px: number): HTMLCanvasElement {
  const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  const device = Math.max(ICON_OUTLINED, Math.round(px * dpr));
  const canvas = makeCanvas(device, device);
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  canvas.style.imageRendering = 'pixelated';
  const scale = Math.max(1, Math.floor(device / ICON_OUTLINED));
  const size = ICON_OUTLINED * scale;
  const offset = Math.floor((device - size) / 2);
  ctx2d(canvas).drawImage(iconSprite(kind), offset, offset, size, size);
  return canvas;
}
