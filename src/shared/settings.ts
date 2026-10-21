export type Mode = 'lives' | 'timed';

export interface Settings {
  mode: Mode;
  /** Lives each, lives mode only. */
  lives: number;
  /** Match length, timed mode only. */
  minutes: number;
  /** Maze size relative to the player-count default, -3 to 3. */
  mazeSize: number;
  /** 0 is free-for-all, otherwise the number of teams. */
  teams: 0 | 2 | 3 | 4;
  friendlyFire: boolean;
  /** Power-up frequency, 0 (off) to 4 (frantic). */
  powerups: number;
  /** Index into BRICK_RATIOS. */
  bricks: number;
  /** Index into GAME_SPEEDS. */
  speed: number;
  /** Wall bounces of a standard bullet. */
  bounces: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'lives',
  lives: 3,
  minutes: 4,
  mazeSize: 0,
  teams: 0,
  friendlyFire: true,
  powerups: 2,
  bricks: 2,
  speed: 2,
  bounces: 6,
};

export const LIMITS = {
  lives: [1, 9],
  minutes: [1, 10],
  mazeSize: [-3, 3],
  powerups: [0, 4],
  bricks: [0, 4],
  speed: [0, 4],
  bounces: [1, 12],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

function int(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Whitelists and clamps every field, keeping prev for anything missing or invalid. */
export function sanitizeSettings(input: unknown, prev: Settings = DEFAULT_SETTINGS): Settings {
  const s = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return {
    mode: s.mode === 'lives' || s.mode === 'timed' ? s.mode : prev.mode,
    lives: int(s.lives, LIMITS.lives, prev.lives),
    minutes: int(s.minutes, LIMITS.minutes, prev.minutes),
    mazeSize: int(s.mazeSize, LIMITS.mazeSize, prev.mazeSize),
    teams: s.teams === 0 || s.teams === 2 || s.teams === 3 || s.teams === 4 ? s.teams : prev.teams,
    friendlyFire: typeof s.friendlyFire === 'boolean' ? s.friendlyFire : prev.friendlyFire,
    powerups: int(s.powerups, LIMITS.powerups, prev.powerups),
    bricks: int(s.bricks, LIMITS.bricks, prev.bricks),
    speed: int(s.speed, LIMITS.speed, prev.speed),
    bounces: int(s.bounces, LIMITS.bounces, prev.bounces),
  };
}
