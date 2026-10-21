export interface Point {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Turns angle a toward target by at most maxStep radians, never overshooting. */
export function turnToward(a: number, target: number, maxStep: number): number {
  return wrapAngle(a + clamp(wrapAngle(target - a), -maxStep, maxStep));
}

/** Angle of a steer byte: 0 is +x, 64 is +y (down), 256 steps per turn. */
export const steerAngle = (steer: number) => ((steer & 255) * TAU) / 256;
