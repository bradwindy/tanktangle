/** Pooled pixel particles: struct-of-arrays, no per-frame allocation, drawn in one path per colour. */

export const MAX_PARTICLES = 1500;

export const Kind = {
  /** Solid square, colour walks along its ramp over its life. */
  Square: 0,
  /** Translucent, grows, drawn under everything else. */
  Smoke: 1,
  /** Flies up (z), bounces on the floor and can settle as a decal speck. */
  Debris: 2,
  /** Square with a one-pixel tail along its velocity. */
  Spark: 3,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export interface Ramp {
  start: number;
  len: number;
}

const GRAVITY = 320;
const SMOKE_ALPHA = [0.16, 0.28, 0.4, 0.52];

export interface SpawnOpts {
  size?: number;
  kind?: Kind;
  drag?: number;
  z?: number;
  vz?: number;
  grow?: number;
  settle?: boolean;
}

export class Particles {
  count = 0;
  readonly x = new Float32Array(MAX_PARTICLES);
  readonly y = new Float32Array(MAX_PARTICLES);
  readonly vx = new Float32Array(MAX_PARTICLES);
  readonly vy = new Float32Array(MAX_PARTICLES);
  readonly z = new Float32Array(MAX_PARTICLES);
  readonly vz = new Float32Array(MAX_PARTICLES);
  readonly life = new Float32Array(MAX_PARTICLES);
  readonly max = new Float32Array(MAX_PARTICLES);
  readonly drag = new Float32Array(MAX_PARTICLES);
  readonly size = new Float32Array(MAX_PARTICLES);
  readonly grow = new Float32Array(MAX_PARTICLES);
  readonly kind = new Uint8Array(MAX_PARTICLES);
  readonly settle = new Uint8Array(MAX_PARTICLES);
  readonly c0 = new Uint16Array(MAX_PARTICLES);
  readonly cn = new Uint8Array(MAX_PARTICLES);
  private cursor = 0;
  private palette: string[] = [];
  private ramps = new Map<string, Ramp>();
  private keys = new Uint32Array(MAX_PARTICLES);
  private order = new Uint16Array(MAX_PARTICLES);
  private counts = new Uint32Array(0);

  ramp(colors: readonly string[]): Ramp {
    const key = colors.join();
    let r = this.ramps.get(key);
    if (!r) {
      r = { start: this.palette.length, len: colors.length };
      this.palette.push(...colors);
      this.ramps.set(key, r);
    }
    return r;
  }

  colorOf(i: number): string {
    const t = 1 - this.life[i]! / this.max[i]!;
    return this.palette[this.c0[i]! + Math.min(this.cn[i]! - 1, Math.floor(t * this.cn[i]!))]!;
  }

  spawn(x: number, y: number, vx: number, vy: number, life: number, ramp: Ramp, o: SpawnOpts = {}): void {
    let i = this.count;
    if (i >= MAX_PARTICLES) {
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      i = this.cursor;
    } else {
      this.count++;
    }
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.z[i] = o.z ?? 0;
    this.vz[i] = o.vz ?? 0;
    this.life[i] = life;
    this.max[i] = life;
    this.drag[i] = o.drag ?? 0;
    this.size[i] = o.size ?? 1;
    this.grow[i] = o.grow ?? 0;
    this.kind[i] = o.kind ?? Kind.Square;
    this.settle[i] = o.settle ? 1 : 0;
    this.c0[i] = ramp.start;
    this.cn[i] = ramp.len;
  }

  /** Random burst helper: n particles from (x, y) at speeds lo..hi, in angle a +- spread. */
  burst(
    x: number,
    y: number,
    n: number,
    ramp: Ramp,
    speedLo: number,
    speedHi: number,
    lifeLo: number,
    lifeHi: number,
    o: SpawnOpts & { a?: number; spread?: number; jitter?: number } = {},
  ): void {
    const a = o.a ?? 0;
    const spread = o.spread ?? Math.PI;
    const jitter = o.jitter ?? 0;
    const opts: SpawnOpts = { ...o };
    for (let k = 0; k < n; k++) {
      const ang = a + (Math.random() * 2 - 1) * spread;
      const sp = speedLo + Math.random() * (speedHi - speedLo);
      const life = lifeLo + Math.random() * (lifeHi - lifeLo);
      if (o.vz !== undefined) opts.vz = o.vz * (0.6 + Math.random() * 0.8);
      this.spawn(
        x + (Math.random() * 2 - 1) * jitter,
        y + (Math.random() * 2 - 1) * jitter,
        Math.cos(ang) * sp,
        Math.sin(ang) * sp,
        life,
        ramp,
        opts,
      );
    }
  }

  clear(): void {
    this.count = 0;
  }

  update(dt: number, onSettle: (x: number, y: number, color: string) => void): void {
    let i = 0;
    while (i < this.count) {
      const life = this.life[i]! - dt;
      if (life <= 0) {
        if (this.settle[i]) onSettle(this.x[i]!, this.y[i]!, this.colorOf(i));
        this.kill(i);
        continue;
      }
      this.life[i] = life;
      const d = this.drag[i]!;
      if (d > 0) {
        const f = 1 / (1 + d * dt);
        this.vx[i]! *= f;
        this.vy[i]! *= f;
      }
      this.x[i]! += this.vx[i]! * dt;
      this.y[i]! += this.vy[i]! * dt;
      if (this.kind[i] === Kind.Debris) {
        let vz = this.vz[i]! - GRAVITY * dt;
        let z = this.z[i]! + vz * dt;
        if (z < 0) {
          z = 0;
          vz = Math.abs(vz) < 30 ? 0 : -vz * 0.42;
          this.vx[i]! *= 0.55;
          this.vy[i]! *= 0.55;
        }
        this.z[i] = z;
        this.vz[i] = vz;
      }
      const g = this.grow[i]!;
      if (g !== 0) this.size[i] = Math.max(1, this.size[i]! + g * dt);
      i++;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.x[i] = this.x[last]!;
    this.y[i] = this.y[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.z[i] = this.z[last]!;
    this.vz[i] = this.vz[last]!;
    this.life[i] = this.life[last]!;
    this.max[i] = this.max[last]!;
    this.drag[i] = this.drag[last]!;
    this.size[i] = this.size[last]!;
    this.grow[i] = this.grow[last]!;
    this.kind[i] = this.kind[last]!;
    this.settle[i] = this.settle[last]!;
    this.c0[i] = this.c0[last]!;
    this.cn[i] = this.cn[last]!;
  }

  /** Smoke first (translucent), then debris shadows, then solid particles, grouped by colour. */
  draw(ctx: CanvasRenderingContext2D): void {
    const n = this.count;
    if (n === 0) return;
    const colors = this.palette.length;
    const buckets = colors * 4 * 2;
    if (this.counts.length < buckets + 1) this.counts = new Uint32Array(buckets + 1);
    const counts = this.counts;
    counts.fill(0, 0, buckets + 1);
    for (let i = 0; i < n; i++) {
      const t = 1 - this.life[i]! / this.max[i]!;
      const ci = this.c0[i]! + Math.min(this.cn[i]! - 1, Math.floor(t * this.cn[i]!));
      const smoke = this.kind[i] === Kind.Smoke;
      const level = smoke ? Math.min(3, Math.floor((1 - t) * 4)) : 0;
      const key = (smoke ? 0 : colors * 4) + ci * 4 + level;
      this.keys[i] = key;
      counts[key + 1]!++;
    }
    for (let b = 1; b <= buckets; b++) counts[b]! += counts[b - 1]!;
    for (let i = 0; i < n; i++) this.order[counts[this.keys[i]!]!++] = i;
    // counts[b] is now the end of bucket b, which is also the start of bucket b + 1.
    let start = 0;
    let shadowsDone = false;
    for (let b = 0; b < buckets; b++) {
      const end = counts[b]!;
      if (!shadowsDone && b >= colors * 4) {
        this.drawShadows(ctx);
        shadowsDone = true;
      }
      if (end === start) continue;
      const smoke = b < colors * 4;
      const ci = Math.floor((smoke ? b : b - colors * 4) / 4);
      ctx.fillStyle = this.palette[ci]!;
      ctx.globalAlpha = smoke ? SMOKE_ALPHA[b % 4]! : 1;
      ctx.beginPath();
      for (let k = start; k < end; k++) {
        const i = this.order[k]!;
        const s = Math.max(1, Math.round(this.size[i]!));
        const px = Math.round(this.x[i]! - s / 2);
        const py = Math.round(this.y[i]! - this.z[i]! - s / 2);
        ctx.rect(px, py, s, s);
        if (this.kind[i] === Kind.Spark) {
          ctx.rect(Math.round(this.x[i]! - this.vx[i]! * 0.014 - s / 2), Math.round(this.y[i]! - this.vy[i]! * 0.014 - s / 2), s, s);
        }
      }
      ctx.fill();
      start = end;
    }
    if (!shadowsDone) this.drawShadows(ctx);
    ctx.globalAlpha = 1;
  }

  private drawShadows(ctx: CanvasRenderingContext2D): void {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.kind[i] !== Kind.Debris || this.z[i]! < 1.5) continue;
      const s = Math.max(1, Math.round(this.size[i]!));
      ctx.rect(Math.round(this.x[i]! - s / 2), Math.round(this.y[i]! - s / 2), s, s);
      any = true;
    }
    if (any) ctx.fill();
  }
}
