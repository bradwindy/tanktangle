/** Bump when client and server messages change shape, so stale tabs are told to reload. */
export const PROTOCOL_VERSION = 3;

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const DT = 1 / TICK_HZ;
/** Snapshots go out every SNAP_EVERY ticks (30 Hz). */
export const SNAP_EVERY = 2;

export const MAX_SEATS = 12;
/** Seats plus a bench of spectators. */
export const MAX_CONNECTIONS = 24;
export const MAX_TEAMS = 4;
export const NAME_MAX = 16;
export const MAX_MESSAGE_BYTES = 2048;
/** Messages per second per socket before extras are dropped. */
export const RATE_LIMIT_PER_SEC = 120;
/**
 * During a match a client that has sent nothing for this long re-sends its current input as a normal 'in'.
 * It keeps the room's CPU budget topped up and heals a dropped input.
 */
export const HEARTBEAT_MS = 1000;
/** During a match a client that has had no snapshot for this long reconnects. */
export const SNAPSHOT_TIMEOUT_MS = 3000;
export const KEEPALIVE_MS = 20000;
export const RECONNECT_GRACE_MS = 15000;
export const LOBBY_GRACE_MS = 8000;
/** Inputs stamped further ahead than this are applied as if stamped now. */
export const MAX_INPUT_LEAD_TICKS = 60;
/** More than the client's MAX_LEAD (40), so a client at its highest lead sending every tick never loses a queued input. */
export const MAX_QUEUED_INPUTS = 48;

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

// World units are pixels of the pixel-art grid. x grows right, y grows down,
// angle 0 points along +x and grows clockwise on screen.
export const TILE = 48;
export const WALL = 6;

export const COUNTDOWN_TICKS = 3 * TICK_HZ;
export const RESPAWN_TICKS = 2 * TICK_HZ;
export const SPAWN_PROTECT_TICKS = 2 * TICK_HZ;
/** A death within this long of damage from someone else credits them. */
export const KILL_CREDIT_TICKS = 5 * TICK_HZ;
export const OVERTIME_MAX_TICKS = 60 * TICK_HZ;

export const TANK_HALF_W = 7;
export const TANK_HALF_L = 9;
/** Tank-to-tank separation radius. */
export const TANK_RADIUS = 9;
/** Distance from tank centre to the muzzle. */
export const MUZZLE = 13;
export const TANK_SPEED = 84;
export const TANK_REVERSE = 0.7;
export const TANK_TURN = 3.6;
export const MAX_HP = 3;
export const SHIELD_RADIUS = 14;

export const BULLET_MAX_ACTIVE = 5;
/** Shortest gap between standard shots. */
export const FIRE_COOLDOWN_TICKS = 9;
/** Holding fire repeats standard shots this often. */
export const AUTO_FIRE_TICKS = 21;

export const BRICK_HP = 3;
export const BRICK_REGROW_TICKS = 30 * TICK_HZ;

export const STORM_START_TICKS = 180 * TICK_HZ;
export const STORM_CLOSE_TICKS = 90 * TICK_HZ;
export const STORM_DAMAGE_EVERY = 90;
/** The storm stops when the safe area is this fraction of the maze in each axis. */
export const STORM_MIN_FRACTION = 0.3;

/** Speed multipliers for the game speed setting, by index. */
export const GAME_SPEEDS = [0.75, 0.9, 1, 1.15, 1.3] as const;
/** Brick share of interior walls for the brick density setting, by index. */
export const BRICK_RATIOS = [0, 0.25, 0.5, 0.75, 1] as const;
/** Each maze size step scales the cell count by this factor. */
export const MAZE_SIZE_STEP = 1.18;

/** Player colours. Players pick one in the lobby; bots and anyone without a pick get the lowest free one. */
export const PALETTE = [
  '#e8453c',
  '#f08a24',
  '#f2c230',
  '#9bd13b',
  '#3cc46a',
  '#2ec4b6',
  '#3aa0e8',
  '#4a64e8',
  '#9a5be8',
  '#e85bb5',
  '#f2f2f2',
  '#b08a64',
] as const;

export const PALETTE_NAMES = ['Red', 'Orange', 'Yellow', 'Lime', 'Green', 'Teal', 'Sky', 'Blue', 'Violet', 'Pink', 'White', 'Tan'] as const;

export const isPaletteIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < PALETTE.length;

/** Team colours for teams 1 to 4. Index 0 is unused. */
export const TEAM_COLORS = ['', '#e8453c', '#3aa0e8', '#3cc46a', '#f2c230'] as const;
export const TEAM_NAMES = ['', 'Red', 'Blue', 'Green', 'Gold'] as const;

/** Application WebSocket close codes. */
export const CLOSE = {
  replaced: 4000,
  outdated: 4001,
  full: 4002,
  left: 4003,
} as const;
