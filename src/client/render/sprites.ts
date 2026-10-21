import { RARE_CRATES } from '../../shared/weapons';
import { Weapon, type CrateKind } from '../../shared/types';
import { iconMap } from './icons';
import { ICON_OUTLINED, ICON_PALETTE } from './iconmaps';
import { INK, mix, packRgba, tankRamp, WHITE } from './palette';
import {
  blankMap,
  buildAtlas,
  outlineMap,
  paintMap,
  rotateSampled,
  stamp,
  upscale8,
  type PixelMap,
} from './pixels';

/** Tank sprites live in 32x32 cells centred on the tank, facing +x at rotation 0. */
export const CELL = 32;
export const HALF_CELL = 16;
export const ROTATIONS = 64;
export const TREAD_FRAMES = 3;
const ROCKET_CELL = 12;
export const ROCKET_ROTATIONS = 32;
export const CRATE_SIZE = 16;

export const rotationIndex = (a: number, n = ROTATIONS) => {
  const i = Math.round((a / (Math.PI * 2)) * n) % n;
  return i < 0 ? i + n : i;
};

// Body and turret palette indices.
const O = 1;
const TD = 2;
const TM = 3;
const TL = 4;
const SH = 5;
const DK = 6;
const BS = 7;
const LT = 8;
const HI = 9;
const GR = 10;
const LAMP = 11;
// Weapon palette indices (shared LUT for every weapon).
const MD = 12;
const MM = 13;
const ML = 14;
const W = {
  cyanDark: 15,
  cyan: 16,
  cyanHot: 17,
  brassDark: 18,
  brass: 19,
  brassHot: 20,
  shellDark: 21,
  shell: 22,
  shellHot: 23,
  orangeDark: 24,
  orange: 25,
  orangeHot: 26,
  greenDark: 27,
  green: 28,
  greenHot: 29,
  hazard: 30,
  hazardDark: 31,
  violetDark: 32,
  violet: 33,
  violetHot: 34,
  redDark: 35,
  red: 36,
  redHot: 37,
  led: 38,
} as const;

const WEAPON_COLORS: Record<number, string> = {
  [O]: INK,
  [MD]: '#3a3f52',
  [MM]: '#6c7690',
  [ML]: '#aeb9cf',
  [W.cyanDark]: '#1a7fa8',
  [W.cyan]: '#4fe3ff',
  [W.cyanHot]: '#e6fdff',
  [W.brassDark]: '#8a5f1a',
  [W.brass]: '#d9a83a',
  [W.brassHot]: '#ffe68a',
  [W.shellDark]: '#8f1f22',
  [W.shell]: '#e5393a',
  [W.shellHot]: '#ff9a8a',
  [W.orangeDark]: '#a8461a',
  [W.orange]: '#ff8a2a',
  [W.orangeHot]: '#ffd08a',
  [W.greenDark]: '#2f6a22',
  [W.green]: '#7fcf45',
  [W.greenHot]: '#d4ff9a',
  [W.hazard]: '#ffd23d',
  [W.hazardDark]: '#1d1b22',
  [W.violetDark]: '#5d1f9e',
  [W.violet]: '#c45cff',
  [W.violetHot]: '#ffd6ff',
  [W.redDark]: '#8f1f2e',
  [W.red]: '#ff4d5e',
  [W.redHot]: '#ffc0c8',
  [W.led]: '#7dff6a',
};
const WEAPON_LUT_SIZE = 39;

/** Weapon sprite variants: Gatling has two spin frames. */
export const WeaponSprite = {
  Gun: 0,
  Laser: 1,
  GatlingA: 2,
  GatlingB: 3,
  Shotgun: 4,
  Homing: 5,
  Frag: 6,
  Mines: 7,
  DeathRay: 8,
  Rc: 9,
} as const;

export function weaponVariant(weapon: Weapon, spinFrame: number): number {
  switch (weapon) {
    case Weapon.Laser:
      return WeaponSprite.Laser;
    case Weapon.Gatling:
      return spinFrame % 2 ? WeaponSprite.GatlingB : WeaponSprite.GatlingA;
    case Weapon.Shotgun:
      return WeaponSprite.Shotgun;
    case Weapon.Homing:
      return WeaponSprite.Homing;
    case Weapon.Frag:
      return WeaponSprite.Frag;
    case Weapon.Mines:
      return WeaponSprite.Mines;
    case Weapon.DeathRay:
      return WeaponSprite.DeathRay;
    case Weapon.Rc:
      return WeaponSprite.Rc;
    default:
      return WeaponSprite.Gun;
  }
}

function bodyMap(frame: number): PixelMap {
  return paintMap(CELL, CELL, (x, y) => {
    const u = x - 7;
    const v = y - 9;
    if (u < 0 || u > 17 || v < 0 || v > 13) return 0;
    const inHull = v >= 3 && v <= 10 && u >= 1 && u <= 16 && !((u === 1 || u === 16) && (v === 3 || v === 10));
    if (inHull) {
      if (u === 16 && (v === 4 || v === 9)) return LAMP;
      if (v === 3) return u <= 9 ? HI : LT;
      if (u === 1 || v === 4) return LT;
      if (v === 10) return SH;
      if (u === 16 || v === 9) return DK;
      if (u >= 2 && u <= 3 && v >= 5 && v <= 8) return v % 2 ? GR : DK;
      return BS;
    }
    if ((u === 0 || u === 17) && (v === 0 || v === 13)) return 0;
    if (v === 0 || v === 13 || u === 0 || u === 17) return TD;
    if ((u + frame) % 3 === 0) return TD;
    return v === 1 || v === 12 ? TL : TM;
  });
}

function turretMap(): PixelMap {
  return paintMap(CELL, CELL, (x, y) => {
    const dx = x + 0.5 - 15;
    const dy = y + 0.5 - 16;
    if (dx * dx + dy * dy > 3.9 * 3.9) return 0;
    const diag = dx + dy;
    if (diag < -3.2) return HI;
    if (dx >= -2 && dx <= -1 && dy >= -2 && dy <= -1) return HI;
    if (diag > 3.2) return SH;
    if (diag > 1.6) return DK;
    if (dx >= 1 && dx <= 2 && dy >= -1 && dy <= 0) return GR;
    return LT;
  });
}

type Painter = (x: number, y: number) => number;

/** Paints a weapon in canvas coords (tank centre at 16,16, muzzle at x 29). */
function weaponMap(paint: Painter): PixelMap {
  return paintMap(CELL, CELL, paint);
}

function barrel(x: number, y: number, x0: number, x1: number): number {
  if (x < x0 || x > x1) return 0;
  if (y === 15) return ML;
  if (y === 16) return MM;
  return 0;
}

const WEAPON_PAINTERS: Painter[] = [
  // Gun
  (x, y) => {
    if (x >= 27 && x <= 28 && y >= 14 && y <= 17) return y === 14 ? MM : y === 15 ? ML : y === 16 ? MM : MD;
    return barrel(x, y, 17, 26);
  },
  // Laser: rails with a glowing core.
  (x, y) => {
    if (x >= 18 && x <= 26 && (y === 14 || y === 17)) return x % 3 === 0 ? MM : MD;
    if (x >= 17 && x <= 26 && (y === 15 || y === 16)) return y === 15 ? W.cyan : W.cyanDark;
    if (x >= 27 && x <= 28 && (y === 15 || y === 16)) return W.cyanHot;
    if (x === 28 && (y === 14 || y === 17)) return W.cyan;
    return 0;
  },
  // Gatling frame A and B: two barrels that swap highlight as it spins, brass collars.
  (x, y) => gatling(x, y, 0),
  (x, y) => gatling(x, y, 1),
  // Shotgun: short, wide double barrel with a red shell band.
  (x, y) => {
    if (x < 17 || x > 25 || y < 13 || y > 18) return 0;
    if (x >= 18 && x <= 20) return y === 13 ? W.shellHot : y === 18 ? W.shellDark : W.shell;
    if (x >= 24) return y === 14 || y === 17 ? MD : y === 15 || y === 16 ? ML : MM;
    return y === 13 || y === 15 ? ML : y === 18 || y === 16 ? MD : MM;
  },
  // Homing: a missile pod with an orange warhead.
  (x, y) => {
    if (x >= 17 && x <= 23 && y >= 13 && y <= 18) {
      if (y === 13) return ML;
      if (y === 18) return MD;
      return x === 20 ? W.orangeDark : MM;
    }
    if (x >= 24 && x <= 26 && y >= 14 && y <= 17) {
      if (x === 26 && (y === 14 || y === 17)) return 0;
      return y === 14 ? W.orangeHot : y === 17 ? W.orangeDark : W.orange;
    }
    if (x === 27 && (y === 15 || y === 16)) return W.orange;
    return 0;
  },
  // Frag: a fat mortar tube with the bomb peeking out.
  (x, y) => {
    if (x >= 17 && x <= 22 && y >= 13 && y <= 18) return y === 13 ? ML : y === 18 ? MD : x === 22 ? MD : MM;
    if (x >= 23 && x <= 25 && y >= 14 && y <= 17) {
      if (x === 25 && (y === 14 || y === 17)) return 0;
      return y === 14 && x === 23 ? W.greenHot : y === 17 ? W.greenDark : W.green;
    }
    return 0;
  },
  // Mines: a hazard-striped dispenser on the rear deck and a stub gun.
  (x, y) => {
    if (x >= 4 && x <= 9 && y >= 11 && y <= 20) {
      if (x === 4 || y === 11 || y === 20) return MD;
      return (x + y) % 4 < 2 ? W.hazard : W.hazardDark;
    }
    return barrel(x, y, 17, 23);
  },
  // Death ray: twin prongs around a glowing orb.
  (x, y) => {
    if (x >= 18 && x <= 28 && (y === 13 || y === 18)) return x >= 27 ? W.violet : x % 2 ? MM : ML;
    if (x >= 17 && x <= 19 && y >= 14 && y <= 17) return MD;
    const dx = x + 0.5 - 22;
    const dy = y + 0.5 - 16;
    const d = dx * dx + dy * dy;
    if (d <= 1) return W.violetHot;
    if (d <= 3.3) return W.violet;
    if (x >= 24 && x <= 28 && (y === 15 || y === 16)) return x === 28 ? W.violetHot : W.violetDark;
    return 0;
  },
  // RC: a red rocket on a launch rail.
  (x, y) => {
    if (x >= 17 && x <= 24 && (y === 14 || y === 17)) return MD;
    if (x >= 18 && x <= 26 && (y === 15 || y === 16)) {
      if (x === 20) return W.redHot;
      return y === 15 ? W.red : W.redDark;
    }
    if (x === 27 && (y === 15 || y === 16)) return W.redHot;
    return 0;
  },
];

function gatling(x: number, y: number, frame: number): number {
  if (x < 18 || x > 28 || y < 13 || y > 18) return 0;
  if (x === 19 || x === 20 || x === 26) return y === 13 ? W.brassHot : y === 18 ? W.brassDark : W.brass;
  if (y === 13 || y === 18) return MD;
  const lit = frame === 0 ? y === 14 || y === 16 : y === 15 || y === 17;
  return lit ? ML : MD;
}

function rocketMap(rc: boolean): PixelMap {
  // 1 outline, 2 body light, 3 body dark, 4 nose, 5 fin (owner colour), 6 fin dark, 7 exhaust.
  return paintMap(ROCKET_CELL, ROCKET_CELL, (x, y) => {
    if (y < 4 || y > 7) return 0;
    const core = y === 5 || y === 6;
    if (core && x === 2) return 7;
    if (core && x >= 3 && x <= 7) return y === 5 ? 2 : 3;
    if (core && (x === 8 || x === 9)) return x === 9 && rc ? 0 : 4;
    if ((y === 4 || y === 7) && x >= 3 && x <= 4) return y === 4 ? 5 : 6;
    if (rc && y === 4 && x === 7) return 4;
    return 0;
  });
}

interface RotatedSet {
  body: PixelMap[][];
  turret: PixelMap[];
  weapons: PixelMap[][];
  silhouettes: PixelMap[][];
  rockets: PixelMap[][];
}

let rotated: RotatedSet | null = null;

function rotateAll(map: PixelMap, n: number, outline = true): PixelMap[] {
  const big = upscale8(map);
  const out: PixelMap[] = [];
  for (let r = 0; r < n; r++) {
    const m = rotateSampled(big, 8, (r / n) * Math.PI * 2);
    out.push(outline ? outlineMap(m, O) : m);
  }
  return out;
}

function union(maps: PixelMap[]): PixelMap {
  const out = blankMap(maps[0]!.w, maps[0]!.h);
  for (const m of maps) for (let i = 0; i < m.data.length; i++) if (m.data[i]) out.data[i] = 1;
  return out;
}

/** Rotations are computed once (about 900 small sprites), colours are applied per player later. */
function rotations(): RotatedSet {
  if (rotated) return rotated;
  const body: PixelMap[][] = [];
  for (let f = 0; f < TREAD_FRAMES; f++) body.push(rotateAll(bodyMap(f), ROTATIONS));
  const turret = rotateAll(turretMap(), ROTATIONS);
  const weapons = WEAPON_PAINTERS.map((p) => rotateAll(weaponMap(p), ROTATIONS));
  const silhouettes = weapons.map((wr) => wr.map((wm, r) => union([body[0]![r]!, turret[r]!, wm])));
  const rockets = [rotateAll(rocketMap(false), ROCKET_ROTATIONS), rotateAll(rocketMap(true), ROCKET_ROTATIONS)];
  rotated = { body, turret, weapons, silhouettes, rockets };
  return rotated;
}

function lut(colors: Record<number, string>, size: number, alpha = 255): Uint32Array {
  const out = new Uint32Array(size);
  for (const [i, c] of Object.entries(colors)) out[Number(i)] = packRgba(c, alpha);
  return out;
}

function bodyLut(color: string): Uint32Array {
  const r = tankRamp(color);
  return lut(
    {
      [O]: r.outline,
      [TD]: r.treadDark,
      [TM]: r.treadMid,
      [TL]: r.treadLight,
      [SH]: r.shadow,
      [DK]: r.dark,
      [BS]: r.base,
      [LT]: r.light,
      [HI]: r.hi,
      [GR]: r.grille,
      [LAMP]: '#fff3b0',
    },
    12,
  );
}

const solidLut = (fill: string, outline: string, size: number) => {
  const out = new Uint32Array(size).fill(packRgba(fill));
  out[0] = 0;
  out[O] = packRgba(outline);
  return out;
};

function wreckLut(size: number): Uint32Array {
  const out = new Uint32Array(size);
  const tones = ['#141218', '#221f28', '#2d2932', '#3a3540'];
  for (let i = 1; i < size; i++) out[i] = packRgba(i === O ? '#0a090d' : tones[i % tones.length]!, 235);
  return out;
}

/** Lazily built sprite atlases, cached per colour. */
export class SpriteBank {
  private bodies = new Map<string, HTMLCanvasElement>();
  private ghosts = new Map<string, HTMLCanvasElement>();
  private rocketAtlases = new Map<string, HTMLCanvasElement>();
  private crates = new Map<number, HTMLCanvasElement>();
  private weaponAtlas: HTMLCanvasElement | null = null;
  private shadowAtlas: HTMLCanvasElement | null = null;
  private whiteAtlas: HTMLCanvasElement | null = null;
  private wreckBody: HTMLCanvasElement | null = null;
  private wreckWeapons: HTMLCanvasElement | null = null;

  /** Body atlas: rows 0..2 are tread frames, row 3 the turret. */
  body(color: string): HTMLCanvasElement {
    let atlas = this.bodies.get(color);
    if (!atlas) {
      const r = rotations();
      atlas = buildAtlas([...r.body, r.turret], CELL, CELL, bodyLut(color));
      this.bodies.set(color, atlas);
    }
    return atlas;
  }

  /** White body and turret, for the hit flash. */
  white(): HTMLCanvasElement {
    if (!this.whiteAtlas) {
      const r = rotations();
      this.whiteAtlas = buildAtlas([r.body[0]!, r.turret], CELL, CELL, solidLut(WHITE, '#ffd0d0', 12));
    }
    return this.whiteAtlas;
  }

  weapons(): HTMLCanvasElement {
    if (!this.weaponAtlas) {
      this.weaponAtlas = buildAtlas(rotations().weapons, CELL, CELL, lut(WEAPON_COLORS, WEAPON_LUT_SIZE));
    }
    return this.weaponAtlas;
  }

  /** Whole-tank silhouettes per weapon variant, black, for drop shadows. */
  shadows(): HTMLCanvasElement {
    if (!this.shadowAtlas) {
      this.shadowAtlas = buildAtlas(rotations().silhouettes, CELL, CELL, solidLut('#000000', '#000000', 2));
    }
    return this.shadowAtlas;
  }

  /** Whole-tank silhouettes in one colour, for speed afterimages and spawn warp-in. */
  ghost(color: string): HTMLCanvasElement {
    let atlas = this.ghosts.get(color);
    if (!atlas) {
      atlas = buildAtlas(rotations().silhouettes, CELL, CELL, solidLut(color, color, 2));
      this.ghosts.set(color, atlas);
    }
    return atlas;
  }

  /** Charred body (row 0) and turret (row 1) plus weapons, stamped as a wreck decal. */
  wreck(): { body: HTMLCanvasElement; weapons: HTMLCanvasElement } {
    if (!this.wreckBody || !this.wreckWeapons) {
      const r = rotations();
      this.wreckBody = buildAtlas([r.body[1]!, r.turret], CELL, CELL, wreckLut(12));
      this.wreckWeapons = buildAtlas(r.weapons, CELL, CELL, wreckLut(WEAPON_LUT_SIZE));
    }
    return { body: this.wreckBody, weapons: this.wreckWeapons };
  }

  /** Row 0 homing missile, row 1 RC missile, ROCKET_ROTATIONS columns of 12x12. */
  rockets(color: string): HTMLCanvasElement {
    let atlas = this.rocketAtlases.get(color);
    if (!atlas) {
      const ramp = tankRamp(color);
      const table = lut(
        { 1: INK, 2: '#eef2fa', 3: '#9aa3b8', 4: '#ff7a2a', 5: ramp.light, 6: ramp.dark, 7: '#fff3a0' },
        8,
      );
      atlas = buildAtlas(rotations().rockets, ROCKET_CELL, ROCKET_CELL, table);
      this.rocketAtlases.set(color, atlas);
    }
    return atlas;
  }

  crate(kind: CrateKind): HTMLCanvasElement {
    let c = this.crates.get(kind);
    if (!c) {
      c = buildCrate(kind);
      this.crates.set(kind, c);
    }
    return c;
  }
}

export const ROCKET_SIZE = ROCKET_CELL;

/** 16x16 crate: bevelled frame, dark panel, the kind's icon. Weapons steel, upgrades teal, rare gold. */
function buildCrate(kind: CrateKind): HTMLCanvasElement {
  const rare = RARE_CRATES.includes(kind);
  const upgrade = kind >= 9;
  const frame = rare
    ? ['#fff2a0', '#ffd23d', '#b8861a', '#6b4a10']
    : upgrade
      ? ['#b8fff0', '#3fd9c0', '#1f8f86', '#124f52']
      : ['#e2e8f5', '#9aa6c0', '#5d6884', '#343a50'];
  const box = paintMap(CRATE_SIZE, CRATE_SIZE, (x, y) => {
    if (x === 0 || y === 0 || x === CRATE_SIZE - 1 || y === CRATE_SIZE - 1) {
      const corner = (x === 0 || x === CRATE_SIZE - 1) && (y === 0 || y === CRATE_SIZE - 1);
      return corner ? 0 : 1;
    }
    const edge = x === 1 || y === 1 || x === CRATE_SIZE - 2 || y === CRATE_SIZE - 2;
    if (edge) {
      const corner = (x === 1 || x === CRATE_SIZE - 2) && (y === 1 || y === CRATE_SIZE - 2);
      if (corner) return 2;
      return x === 1 || y === 1 ? 3 : 5;
    }
    return 6;
  });
  const icon = iconMap(kind);
  const off = Math.floor((CRATE_SIZE - ICON_OUTLINED) / 2);
  const shifted = blankMap(CRATE_SIZE, CRATE_SIZE);
  stamp(shifted, icon, off, off);
  // Icon indices sit above the crate's own 7 colours.
  const merged = blankMap(CRATE_SIZE, CRATE_SIZE);
  for (let i = 0; i < merged.data.length; i++) {
    const v = shifted.data[i]!;
    merged.data[i] = v ? v + 7 : box.data[i]!;
  }
  const colors: Record<number, string> = {
    1: INK,
    2: frame[0]!,
    3: frame[1]!,
    4: frame[2]!,
    5: frame[2]!,
    6: mix(frame[3]!, INK, 0.45),
  };
  ICON_PALETTE.forEach((c, i) => {
    if (i > 0) colors[i + 7] = i === 1 ? mix(frame[3]!, INK, 0.7) : c;
  });
  return buildAtlas([[merged]], CRATE_SIZE, CRATE_SIZE, lut(colors, ICON_PALETTE.length + 8));
}
