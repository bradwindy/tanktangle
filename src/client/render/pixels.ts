/** Palette-indexed pixel maps: the source format for every sprite. Index 0 is transparent. */
export interface PixelMap {
  w: number;
  h: number;
  data: Uint8Array;
}

export const blankMap = (w: number, h: number): PixelMap => ({ w, h, data: new Uint8Array(w * h) });

export function paintMap(w: number, h: number, fn: (x: number, y: number) => number): PixelMap {
  const map = blankMap(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) map.data[y * w + x] = fn(x, y);
  return map;
}

/** Rows of characters, '.' transparent, others looked up in key. Unknown characters throw so typos surface early. */
export function parseMap(rows: readonly string[], key: Readonly<Record<string, number>>): PixelMap {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const map = blankMap(w, h);
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`pixel map row ${y} is ${row.length} wide, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = row[x]!;
      if (ch === '.') continue;
      const v = key[ch];
      if (v === undefined) throw new Error(`pixel map has unknown colour '${ch}'`);
      map.data[y * w + x] = v;
    }
  });
  return map;
}

export const pixelAt = (m: PixelMap, x: number, y: number) =>
  x < 0 || y < 0 || x >= m.w || y >= m.h ? 0 : m.data[y * m.w + x]!;

/** Draws src onto dst at (dx, dy), skipping transparent pixels. */
export function stamp(dst: PixelMap, src: PixelMap, dx: number, dy: number): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const v = src.data[y * src.w + x]!;
      const tx = x + dx;
      const ty = y + dy;
      if (v && tx >= 0 && ty >= 0 && tx < dst.w && ty < dst.h) dst.data[ty * dst.w + tx] = v;
    }
  }
}

/** EPX / Scale2x: doubles the map while keeping edges crisp, so a later rotation stays clean. */
function scale2x(src: PixelMap): PixelMap {
  const { w, h } = src;
  const out = blankMap(w * 2, h * 2);
  const ow = w * 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = src.data[y * w + x]!;
      const a = pixelAt(src, x, y - 1);
      const b = pixelAt(src, x + 1, y);
      const c = pixelAt(src, x - 1, y);
      const d = pixelAt(src, x, y + 1);
      const i = y * 2 * ow + x * 2;
      out.data[i] = c === a && c !== d && a !== b ? a : p;
      out.data[i + 1] = a === b && a !== c && b !== d ? b : p;
      out.data[i + ow] = d === c && d !== b && c !== a ? c : p;
      out.data[i + ow + 1] = b === d && b !== a && d !== c ? d : p;
    }
  }
  return out;
}

/** RotSprite style: upscale 8x with Scale2x, ready for rotateSampled. */
export const upscale8 = (src: PixelMap) => scale2x(scale2x(scale2x(src)));

/**
 * Rotates an 8x upscaled map (clockwise on screen for positive angles) and samples it back down to the
 * original size, around the map centre. Nearest sampling of the smooth upscale gives clean pixel rotations.
 */
export function rotateSampled(big: PixelMap, factor: number, angle: number): PixelMap {
  const w = big.w / factor;
  const h = big.h / factor;
  const out = blankMap(w, h);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ox = x + 0.5 - cx;
      const oy = y + 0.5 - cy;
      const sx = (ox * cos + oy * sin + cx) * factor;
      const sy = (-ox * sin + oy * cos + cy) * factor;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= big.w || iy >= big.h) continue;
      out.data[y * w + x] = big.data[iy * big.w + ix]!;
    }
  }
  return out;
}

/** Adds a one pixel outline of colour index around every opaque pixel, in place. */
export function outlineMap(m: PixelMap, index: number, diagonal = false): PixelMap {
  const src = m.data.slice();
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (src[y * m.w + x]) continue;
      const near = (dx: number, dy: number) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && src[ny * m.w + nx] !== 0;
      };
      const hit =
        near(1, 0) ||
        near(-1, 0) ||
        near(0, 1) ||
        near(0, -1) ||
        (diagonal && (near(1, 1) || near(-1, 1) || near(1, -1) || near(-1, -1)));
      if (hit) m.data[y * m.w + x] = index;
    }
  }
  return m;
}

/** Writes a map into a Uint32 pixel buffer using a packed colour lookup table. Index 0 stays untouched. */
export function blitPacked(
  dst: Uint32Array,
  dstW: number,
  map: PixelMap,
  dx: number,
  dy: number,
  lut: Uint32Array,
): void {
  for (let y = 0; y < map.h; y++) {
    const row = (y + dy) * dstW + dx;
    for (let x = 0; x < map.w; x++) {
      const v = map.data[y * map.w + x]!;
      if (v) dst[row + x] = lut[v]!;
    }
  }
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, alpha = true): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { alpha });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Renders cells of maps into one atlas canvas: cells[row][col], each cellW x cellH. */
export function buildAtlas(
  cells: readonly (readonly PixelMap[])[],
  cellW: number,
  cellH: number,
  lut: Uint32Array,
): HTMLCanvasElement {
  const rows = cells.length;
  const cols = Math.max(...cells.map((r) => r.length));
  const canvas = makeCanvas(cols * cellW, rows * cellH);
  const ctx = ctx2d(canvas);
  const img = ctx.createImageData(canvas.width, canvas.height);
  const buf = new Uint32Array(img.data.buffer);
  cells.forEach((row, r) => row.forEach((m, c) => blitPacked(buf, canvas.width, m, c * cellW, r * cellH, lut)));
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function mapToCanvas(map: PixelMap, lut: Uint32Array): HTMLCanvasElement {
  return buildAtlas([[map]], map.w, map.h, lut);
}
