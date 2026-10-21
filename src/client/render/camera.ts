import { TILE } from '../../shared/constants';

/** Pure camera maths, shared by the renderer and its tests. Screen units are CSS px, world units world px. */

/** World px shown around the maze in fit mode (outer walls stick out by WALL / 2). */
export const FIT_MARGIN = 10;
/** On the follow camera the viewport's short side shows at least this many world px. */
export const FOLLOW_SPAN = 5 * TILE + 2 * FIT_MARGIN;
export const FOLLOW_MIN_SCALE = 1.5;
export const FOLLOW_MAX_SCALE = 3;

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fitScale(worldW: number, worldH: number, view: ViewRect): number {
  if (view.w <= 0 || view.h <= 0) return 1;
  return Math.min(view.w / (worldW + 2 * FIT_MARGIN), view.h / (worldH + 2 * FIT_MARGIN));
}

export function followScale(view: ViewRect): number {
  const short = Math.min(view.w, view.h);
  return Math.min(FOLLOW_MAX_SCALE, Math.max(FOLLOW_MIN_SCALE, short / FOLLOW_SPAN));
}

/**
 * Clamps a camera centre on one axis so the window [c - half, c + half] stays inside [lo, hi].
 * When the window is wider than the range, the range is centred instead.
 */
export function clampAxis(c: number, half: number, lo: number, hi: number): number {
  if (hi - lo <= half * 2) return (lo + hi) / 2;
  return Math.min(hi - half, Math.max(lo + half, c));
}

/** Exponential smoothing factor for a rate per second over dt seconds. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export interface CameraView {
  /** CSS px per world px. */
  scale: number;
  /** World point at the left/top edge of the stage. */
  left: number;
  top: number;
}

/** Places world point (cx, cy) at the centre of the viewport rect. */
export function cameraView(cx: number, cy: number, scale: number, view: ViewRect): CameraView {
  return {
    scale,
    left: cx - (view.x + view.w / 2) / scale,
    top: cy - (view.y + view.h / 2) / scale,
  };
}

export const toScreen = (cam: CameraView, x: number, y: number) => ({
  x: (x - cam.left) * cam.scale,
  y: (y - cam.top) * cam.scale,
});
