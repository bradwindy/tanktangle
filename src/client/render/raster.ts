/**
 * Pixel-exact drawing primitives. They add whole-pixel rects to the current path so the caller can fill
 * many shapes with one fill() call, and canvas anti-aliasing never softens the pixel art.
 */

const spanCache = new Map<number, Int16Array>();

/** Half widths of a filled circle per row, for rows -R..R where R = ceil(r). */
function spans(r: number): Int16Array {
  const key = Math.round(r * 4);
  let s = spanCache.get(key);
  if (!s) {
    const rr = key / 4;
    const R = Math.ceil(rr);
    s = new Int16Array(R * 2 + 1);
    for (let dy = -R; dy <= R; dy++) {
      const v = rr * rr - dy * dy;
      s[dy + R] = v < 0 ? -1 : Math.round(Math.sqrt(v));
    }
    spanCache.set(key, s);
  }
  return s;
}

/** Adds a filled pixel circle centred on pixel (cx, cy). */
export function circlePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  if (r <= 0.5) {
    ctx.rect(cx, cy, 1, 1);
    return;
  }
  const s = spans(r);
  const R = (s.length - 1) / 2;
  for (let dy = -R; dy <= R; dy++) {
    const hw = s[dy + R]!;
    if (hw >= 0) ctx.rect(cx - hw, cy + dy, hw * 2 + 1, 1);
  }
}

/** Adds a pixel ring (annulus) between radius r - thick and r. */
export function ringPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, thick: number): void {
  const outer = spans(r);
  const inner = spans(Math.max(0, r - thick));
  const R = (outer.length - 1) / 2;
  const Ri = (inner.length - 1) / 2;
  for (let dy = -R; dy <= R; dy++) {
    const ho = outer[dy + R]!;
    if (ho < 0) continue;
    const hi = Math.abs(dy) <= Ri && r - thick > 0 ? inner[dy + Ri]! : -1;
    if (hi < 0) {
      ctx.rect(cx - ho, cy + dy, ho * 2 + 1, 1);
    } else if (ho > hi) {
      ctx.rect(cx - ho, cy + dy, ho - hi, 1);
      ctx.rect(cx + hi + 1, cy + dy, ho - hi, 1);
    }
  }
}

/** Adds a line of w x w pixel squares from (x0, y0) to (x1, y1), one per pixel step. */
export function linePath(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w = 1,
  skipFirst = false,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const half = (w - 1) / 2;
  for (let i = skipFirst ? 1 : 0; i <= steps; i++) {
    const t = i / steps;
    ctx.rect(Math.round(x0 + dx * t - half), Math.round(y0 + dy * t - half), w, w);
  }
}

/** Adds dots every `gap` px along a flat polyline, starting `offset` px in. */
export function dottedPath(ctx: CanvasRenderingContext2D, pts: readonly number[], gap: number, offset: number, size = 1) {
  let carry = offset % gap;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!;
    const y0 = pts[i + 1]!;
    const dx = pts[i + 2]! - x0;
    const dy = pts[i + 3]! - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;
    let d = carry;
    while (d < len) {
      ctx.rect(Math.round(x0 + (dx * d) / len) - (size >> 1), Math.round(y0 + (dy * d) / len) - (size >> 1), size, size);
      d += gap;
    }
    carry = d - len;
  }
}

const patterns = new WeakMap<CanvasRenderingContext2D, Map<string, (CanvasPattern | string)[]>>();

function makeChecker(ctx: CanvasRenderingContext2D, color: string, phase: number): CanvasPattern | string {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 2;
  const g = c.getContext('2d');
  if (!g) return color;
  g.fillStyle = color;
  g.fillRect(phase, 0, 1, 1);
  g.fillRect(1 - phase, 1, 1, 1);
  return ctx.createPattern(c, 'repeat') ?? color;
}

/** A 2x2 checkerboard of one colour, for dithered fades that stay pixel-crisp. Patterns are anchored in user space. */
export function checker(ctx: CanvasRenderingContext2D, color: string, phase = 0): CanvasPattern | string {
  let byCtx = patterns.get(ctx);
  if (!byCtx) {
    byCtx = new Map();
    patterns.set(ctx, byCtx);
  }
  let pair = byCtx.get(color);
  if (!pair) {
    pair = [makeChecker(ctx, color, 0), makeChecker(ctx, color, 1)];
    byCtx.set(color, pair);
  }
  return pair[phase & 1]!;
}
