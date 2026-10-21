import { TICK_HZ } from './constants';
import { Proj, Upgrade, Weapon, type CrateKind } from './types';

export interface ProjStats {
  r: number;
  /** px/s at game speed 1. */
  speed: number;
  /** Ticks before it expires. */
  life: number;
  /** Damage on a direct tank hit. 0 means it never hits tanks directly. */
  damage: number;
  /** Wall bounces before the next wall hit destroys it, -1 for unlimited. Bullets use the bounces setting instead. */
  bounces: number;
  /** Damage dealt to a brick it touches. */
  brick: number;
  /** Harmless to its owner until its first wall bounce (homing: until it starts hunting). */
  ownerSafe: boolean;
}

export const PROJ_STATS: Record<Proj, ProjStats> = {
  [Proj.Bullet]: { r: 2, speed: 120, life: 8 * TICK_HZ, damage: 1, bounces: 6, brick: 1, ownerSafe: true },
  [Proj.Gatling]: { r: 1.5, speed: 170, life: 96, damage: 1, bounces: 2, brick: 1, ownerSafe: true },
  [Proj.Pellet]: { r: 1.5, speed: 220, life: 30, damage: 1, bounces: 1, brick: 1, ownerSafe: true },
  [Proj.Shrapnel]: { r: 1.5, speed: 200, life: 24, damage: 1, bounces: 0, brick: 0, ownerSafe: false },
  [Proj.Homing]: { r: 3, speed: 105, life: 10 * TICK_HZ, damage: 3, bounces: -1, brick: 0, ownerSafe: true },
  [Proj.Frag]: { r: 4, speed: 100, life: 5 * TICK_HZ, damage: 2, bounces: -1, brick: 0, ownerSafe: true },
  [Proj.Mine]: { r: 4, speed: 90, life: 60 * TICK_HZ, damage: 0, bounces: -1, brick: 0, ownerSafe: false },
  [Proj.Rc]: { r: 3, speed: 110, life: 8 * TICK_HZ, damage: 3, bounces: -1, brick: 0, ownerSafe: true },
};

export interface BlastStats {
  r: number;
  /** Damage at the centre, falling linearly to 1 at the edge. Steel walls between the blast and a tank block it. */
  damage: number;
  /** Damage to every brick the blast circle touches. */
  brick: number;
  /** Shrapnel thrown out evenly around the circle. */
  shrapnel: number;
}

export const BLAST: Partial<Record<Weapon, BlastStats>> = {
  [Weapon.Homing]: { r: 20, damage: 1, brick: 2, shrapnel: 0 },
  [Weapon.Frag]: { r: 30, damage: 2, brick: 3, shrapnel: 24 },
  [Weapon.Mines]: { r: 36, damage: 3, brick: 3, shrapnel: 16 },
  [Weapon.Rc]: { r: 26, damage: 2, brick: 3, shrapnel: 0 },
};

export const LASER = {
  damage: 3,
  maxReflections: 6,
  maxLength: 900,
  /** Brick damage at each reflection off a brick. */
  brick: 1,
  recoilTicks: 12,
} as const;

export const DEATH_RAY = {
  chargeTicks: 90,
  /** Turn speed multiplier while charging. */
  chargeTurn: 0.5,
  damage: 3,
  /** Tanks within this distance of the beam are hit. */
  width: 8,
  maxLength: 1200,
  /** The beam bends toward the nearest enemy inside this half-angle, at most this many radians per 100 px. */
  seekCone: Math.PI / 6,
  maxBend: 0.4,
  brick: 3,
} as const;

export const GATLING = { rounds: 24, spinUpTicks: 24, respinTicks: 12, everyTicks: 5, spread: 0.12 } as const;
export const SHOTGUN = { blasts: 3, pellets: 9, spread: 0.35, jitter: 0.03, speedJitter: 0.1, cooldownTicks: 36 } as const;
export const MINES = { count: 3, cooldownTicks: 18, armTicks: 36, fuseTicks: 24, triggerRadius: 10, stopTicks: 24 } as const;
export const HOMING = { straightTicks: 90, turnRate: 5.5 } as const;
export const FRAG = { minDetonateTicks: 12 } as const;
export const RC = { turnRate: 6 } as const;

/** Rounds per pickup for each special weapon. */
export const WEAPON_AMMO: Record<Exclude<Weapon, 0>, number> = {
  [Weapon.Laser]: 1,
  [Weapon.Gatling]: GATLING.rounds,
  [Weapon.Shotgun]: SHOTGUN.blasts,
  [Weapon.Homing]: 1,
  [Weapon.Frag]: 1,
  [Weapon.Mines]: MINES.count,
  [Weapon.DeathRay]: 1,
  [Weapon.Rc]: 1,
};

export const UPGRADE_TICKS: Record<Exclude<Upgrade, typeof Upgrade.Repair>, number> = {
  [Upgrade.Shield]: 6 * TICK_HZ,
  [Upgrade.Speed]: 10 * TICK_HZ,
  [Upgrade.Aimer]: 10 * TICK_HZ,
};
export const SPEED_BOOST = 1.35;
/** The shield blinks for this long before it ends. */
export const SHIELD_WARN_TICKS = 90;

export const CRATE_NAMES: Record<CrateKind, string> = {
  [Weapon.Laser]: 'Laser',
  [Weapon.Gatling]: 'Gatling',
  [Weapon.Shotgun]: 'Shotgun',
  [Weapon.Homing]: 'Homing missile',
  [Weapon.Frag]: 'Frag bomb',
  [Weapon.Mines]: 'Mines',
  [Weapon.DeathRay]: 'Death ray',
  [Weapon.Rc]: 'RC missile',
  [Upgrade.Shield]: 'Shield',
  [Upgrade.Repair]: 'Repair kit',
  [Upgrade.Speed]: 'Speed boost',
  [Upgrade.Aimer]: 'Aimer',
};

/** Relative odds of each crate kind. Rare kinds get a golden crate. */
export const CRATE_WEIGHTS: Record<CrateKind, number> = {
  [Weapon.Laser]: 10,
  [Weapon.Gatling]: 10,
  [Weapon.Shotgun]: 10,
  [Weapon.Homing]: 7,
  [Weapon.Frag]: 7,
  [Weapon.Mines]: 6,
  [Weapon.DeathRay]: 3,
  [Weapon.Rc]: 4,
  [Upgrade.Shield]: 8,
  [Upgrade.Repair]: 8,
  [Upgrade.Speed]: 6,
  [Upgrade.Aimer]: 5,
};
export const RARE_CRATES: readonly CrateKind[] = [Weapon.DeathRay, Weapon.Rc];

/**
 * Per power-up frequency setting: base crate cap (plus one per 4 tanks) and mean seconds between spawns.
 * The interval is multiplied by min(1, 4 / tanks) so big games get crates as often per player.
 */
export const CRATE_CAP = [0, 1, 2, 3, 5] as const;
export const CRATE_INTERVAL_S = [0, 12, 7, 4, 2] as const;
/** Spawn intervals vary by up to this fraction either way. */
export const CRATE_INTERVAL_JITTER = 0.4;
/** Crates spawn at least this many cells (by maze path) from every living tank, relaxing when no cell qualifies. */
export const CRATE_MIN_PATH_CELLS = 3;
/** Pickup happens when the tank's circle touches this square around the cell centre. */
export const CRATE_HALF = 6;
