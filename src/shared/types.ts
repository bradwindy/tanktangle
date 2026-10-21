export const Weapon = {
  Gun: 0,
  Laser: 1,
  Gatling: 2,
  Shotgun: 3,
  Homing: 4,
  Frag: 5,
  Mines: 6,
  DeathRay: 7,
  Rc: 8,
} as const;
export type Weapon = (typeof Weapon)[keyof typeof Weapon];

export const Upgrade = {
  Shield: 9,
  Repair: 10,
  Speed: 11,
  Aimer: 12,
} as const;
export type Upgrade = (typeof Upgrade)[keyof typeof Upgrade];

/** What a crate holds: any weapon except the standard gun, or an upgrade. */
export type CrateKind = Exclude<Weapon, 0> | Upgrade;
export const CRATE_KINDS: readonly CrateKind[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Death cause for the storm. Other causes are the Weapon that did the damage. */
export const CAUSE_STORM = 99;

export const Proj = {
  Bullet: 1,
  Gatling: 2,
  Pellet: 3,
  Shrapnel: 4,
  Homing: 5,
  Frag: 6,
  Mine: 7,
  Rc: 8,
} as const;
export type Proj = (typeof Proj)[keyof typeof Proj];

export const WallKind = { None: 0, Brick: 1, Steel: 2 } as const;
export type WallKind = (typeof WallKind)[keyof typeof WallKind];

/** Input bits. With Steer set, the steer byte is the direction to drive and Fwd means the stick is pushed. */
export const Input = {
  Fwd: 1,
  Back: 2,
  Left: 4,
  Right: 8,
  Fire: 16,
  Steer: 32,
} as const;
export const INPUT_MASK = 63;

/** Tank flag bits sent in snapshots. */
export const TankFlag = {
  Alive: 1,
  Shield: 2,
  Speed: 4,
  Aimer: 8,
  Protect: 16,
  Charging: 32,
  Recoil: 64,
  RcControl: 128,
  Spinning: 256,
} as const;

/** Team 0 is free-for-all, so two team-0 tanks are never teammates. */
export const sameTeam = (a: number, b: number) => a !== 0 && a === b;

export type BotLevel = 'easy' | 'normal' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'normal', 'hard'];

/**
 * The maze grid. Walls sit on cell edges and are indexed by wall id:
 * horizontal walls first, id = y * w + x for y in 0..h (the top edge of cell x,y; y = h is the bottom edge),
 * then vertical walls, id = w * (h + 1) + y * (w + 1) + x for x in 0..w (the left edge of cell x,y; x = w is the right edge).
 * Outer edges are always steel.
 */
export interface MazeLayout {
  w: number;
  h: number;
  /** WallKind per wall id. */
  walls: Uint8Array;
}

export interface MazeState extends MazeLayout {
  /** Brick hit points per wall id, 0 to BRICK_HP. 0 means broken and passable. Ignored for steel and empty edges. */
  hp: Uint8Array;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TankState {
  seat: number;
  /** 0 in free-for-all, 1 to 4 in team mode. */
  team: number;
  x: number;
  y: number;
  a: number;
  hp: number;
  alive: boolean;
  /** Input currently applied. */
  bits: number;
  steer: number;
  weapon: Weapon;
  ammo: number;
  /** No moving or turning before this tick (laser recoil). */
  frozenUntil: number;
  /** While charging a death ray it fires at this tick. 0 when not charging. */
  chargeUntil: number;
  /** Id of the RC missile this tank is steering, 0 when none. The tank cannot move while steering. */
  rc: number;
  shieldUntil: number;
  speedUntil: number;
  aimerUntil: number;
  protectUntil: number;
}

export interface ProjState {
  id: number;
  kind: Proj;
  owner: number;
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  bornAt: number;
  dieAt: number;
  /** Wall bounces left before the next wall hit destroys it. -1 is unlimited. */
  bounces: number;
  /** Whether it can hurt its owner yet. */
  deadly: boolean;
  /** Mine: 0 unarmed, 1 armed, 2 triggered. Homing: 0 flying straight, 1 hunting. Otherwise 0. */
  aux: number;
  /** Tick a triggered mine or a frag bomb goes off. 0 when not set. */
  fuseAt: number;
  /** Wall contacts so far. Only the first contact chips a brick. Server-side only, 0 on clients. */
  hits: number;
}

export interface Crate {
  id: number;
  kind: CrateKind;
  cx: number;
  cy: number;
}
