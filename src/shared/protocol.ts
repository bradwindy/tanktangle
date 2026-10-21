import { CODE_ALPHABET, CODE_LENGTH, NAME_MAX } from './constants';
import type { Settings } from './settings';
import { PROJ_STATS } from './weapons';
import { TankFlag, type BotLevel, type Crate, type CrateKind, type Proj, type ProjState, type TankState, type Weapon } from './types';

export type Phase = 'lobby' | 'countdown' | 'playing' | 'over';

export interface PublicPlayer {
  /** Public id. The secret reconnect pid is never broadcast. */
  id: string;
  name: string;
  /** PALETTE index. */
  color: number;
  /** Seat (and tank id) in the current or next match, or -1 when on the bench. */
  seat: number;
  /** 0 in free-for-all, 1 to 4 in team mode. */
  team: number;
  bot: BotLevel | null;
  connected: boolean;
  kills: number;
  deaths: number;
  /** Lives left in lives mode. */
  lives: number;
  /** Out of lives in the current match. Late joiners sit on the bench (seat -1) instead. */
  out: boolean;
}

export interface Award {
  title: string;
  id: string;
  text: string;
}

export interface MatchResult {
  draw: boolean;
  /** Winning player ids: one in free-for-all, the team's members in team mode, the tied leaders on a draw. */
  winners: string[];
  /** Winning team, 0 in free-for-all or on a draw. */
  team: number;
  /** Player ids, best first. */
  standings: string[];
  awards: Award[];
}

export interface RoomMsg {
  t: 'room';
  phase: Phase;
  host: string;
  settings: Settings;
  players: PublicPlayer[];
  /** Timed mode went to sudden death. */
  overtime: boolean;
  result: MatchResult | null;
}

/** [id, kind, cx, cy] */
export type CrateRow = [number, CrateKind, number, number];

/** Sent when a countdown starts, and to anyone who connects or reconnects mid-match. */
export interface MatchMsg {
  t: 'match';
  /** Increments each match, so clients can drop stale state. */
  id: number;
  /** Current match tick. */
  k: number;
  w: number;
  h: number;
  /** WallKind digit per wall id. */
  walls: string;
  /** Brick hp digit per wall id. */
  hp: string;
  crates: CrateRow[];
  /** Tick the countdown ends and tanks can move. */
  playAt: number;
  /** Tick the storm starts, 0 for none. */
  stormAt: number;
  /** Tick a timed match ends, 0 in lives mode. */
  endAt: number;
}

/**
 * [seat, x*10, y*10, a*1000, hp, flags, weapon, ammo, bits, steer, ackSeq, ackTick, margin,
 *  frozenLeft, shieldLeft, speedLeft, aimerLeft, chargeLeft, rc, protectLeft]
 * "Left" fields are ticks remaining from the snapshot tick. ackSeq/ackTick are the last input applied and when.
 * margin = stamped tick - the tick the server was about to run when the input arrived:
 * 0 is just in time, positive is early, negative is late.
 */
export type TankRow = number[];
/** [id, kind, x*10, y*10, vx*10, vy*10, owner, bounces, aux, fuseLeft, deadly, age] */
export type ProjRow = number[];
export type EventRow = number[];

export interface SnapMsg {
  t: 's';
  k: number;
  T: TankRow[];
  P: ProjRow[];
  e?: EventRow[];
}

export interface WelcomeMsg {
  t: 'welcome';
  id: string;
}

export interface ErrorMsg {
  t: 'error';
  reason: string;
}

export type ServerMsg = WelcomeMsg | RoomMsg | MatchMsg | SnapMsg | ErrorMsg;

export type ClientMsg =
  | { t: 'hello'; pid: string; name: string }
  /** Input change (or heartbeat re-send): seq, the tick it applies from, bits, steer byte. */
  | { t: 'in'; s: number; k: number; b: number; d: number }
  | { t: 'settings'; s: Partial<Settings> }
  | { t: 'start' }
  | { t: 'again' }
  | { t: 'addBot'; level: BotLevel }
  | { t: 'removeBot'; id: string }
  | { t: 'team'; team: number };

export const Ev = {
  Fire: 1,
  Hit: 2,
  Death: 3,
  Spawn: 4,
  Brick: 5,
  Crate: 6,
  Pick: 7,
  Boom: 8,
  Beam: 9,
  Block: 10,
  Charge: 11,
  Trigger: 12,
  Storm: 13,
  Overtime: 14,
} as const;

export type GameEvent =
  | { e: typeof Ev.Fire; seat: number; weapon: Weapon; x: number; y: number; a: number }
  | { e: typeof Ev.Hit; seat: number; by: number; x: number; y: number; dmg: number }
  /** by is the credited killer seat, or -1. self is true for a self-kill penalty. cause is a Weapon or CAUSE_STORM. */
  | { e: typeof Ev.Death; seat: number; by: number; cause: number; x: number; y: number; self: boolean }
  | { e: typeof Ev.Spawn; seat: number; x: number; y: number; a: number }
  /** hp 0 is broken, BRICK_HP is fully regrown. */
  | { e: typeof Ev.Brick; wall: number; hp: number }
  | { e: typeof Ev.Crate; id: number; kind: CrateKind; cx: number; cy: number }
  /** seat -1 means the crate was destroyed (storm). */
  | { e: typeof Ev.Pick; id: number; seat: number; kind: CrateKind }
  /** kind is the Weapon that exploded. */
  | { e: typeof Ev.Boom; x: number; y: number; r: number; kind: Weapon }
  /** Laser or death ray path as flat x, y pairs. */
  | { e: typeof Ev.Beam; seat: number; weapon: Weapon; pts: number[] }
  | { e: typeof Ev.Block; seat: number; x: number; y: number }
  | { e: typeof Ev.Charge; seat: number }
  | { e: typeof Ev.Trigger; id: number }
  | { e: typeof Ev.Storm }
  | { e: typeof Ev.Overtime };

const r10 = (v: number) => Math.round(v * 10);
const r1000 = (v: number) => Math.round(v * 1000);
const left = (until: number, k: number) => Math.max(0, until - k);

export function encodeEvent(ev: GameEvent): EventRow {
  switch (ev.e) {
    case Ev.Fire:
      return [ev.e, ev.seat, ev.weapon, r10(ev.x), r10(ev.y), r1000(ev.a)];
    case Ev.Hit:
      return [ev.e, ev.seat, ev.by, r10(ev.x), r10(ev.y), ev.dmg];
    case Ev.Death:
      return [ev.e, ev.seat, ev.by, ev.cause, r10(ev.x), r10(ev.y), ev.self ? 1 : 0];
    case Ev.Spawn:
      return [ev.e, ev.seat, r10(ev.x), r10(ev.y), r1000(ev.a)];
    case Ev.Brick:
      return [ev.e, ev.wall, ev.hp];
    case Ev.Crate:
      return [ev.e, ev.id, ev.kind, ev.cx, ev.cy];
    case Ev.Pick:
      return [ev.e, ev.id, ev.seat, ev.kind];
    case Ev.Boom:
      return [ev.e, r10(ev.x), r10(ev.y), r10(ev.r), ev.kind];
    case Ev.Beam:
      return [ev.e, ev.seat, ev.weapon, ...ev.pts.map(r10)];
    case Ev.Block:
      return [ev.e, ev.seat, r10(ev.x), r10(ev.y)];
    case Ev.Charge:
      return [ev.e, ev.seat];
    case Ev.Trigger:
      return [ev.e, ev.id];
    case Ev.Storm:
    case Ev.Overtime:
      return [ev.e];
  }
}

export function decodeEvent(row: EventRow): GameEvent | null {
  const n = (i: number) => row[i] ?? 0;
  const d10 = (i: number) => n(i) / 10;
  switch (row[0]) {
    case Ev.Fire:
      return { e: Ev.Fire, seat: n(1), weapon: n(2) as Weapon, x: d10(3), y: d10(4), a: n(5) / 1000 };
    case Ev.Hit:
      return { e: Ev.Hit, seat: n(1), by: n(2), x: d10(3), y: d10(4), dmg: n(5) };
    case Ev.Death:
      return { e: Ev.Death, seat: n(1), by: n(2), cause: n(3), x: d10(4), y: d10(5), self: n(6) === 1 };
    case Ev.Spawn:
      return { e: Ev.Spawn, seat: n(1), x: d10(2), y: d10(3), a: n(4) / 1000 };
    case Ev.Brick:
      return { e: Ev.Brick, wall: n(1), hp: n(2) };
    case Ev.Crate:
      return { e: Ev.Crate, id: n(1), kind: n(2) as CrateKind, cx: n(3), cy: n(4) };
    case Ev.Pick:
      return { e: Ev.Pick, id: n(1), seat: n(2), kind: n(3) as CrateKind };
    case Ev.Boom:
      return { e: Ev.Boom, x: d10(1), y: d10(2), r: d10(3), kind: n(4) as Weapon };
    case Ev.Beam:
      return { e: Ev.Beam, seat: n(1), weapon: n(2) as Weapon, pts: row.slice(3).map((v) => v / 10) };
    case Ev.Block:
      return { e: Ev.Block, seat: n(1), x: d10(2), y: d10(3) };
    case Ev.Charge:
      return { e: Ev.Charge, seat: n(1) };
    case Ev.Trigger:
      return { e: Ev.Trigger, id: n(1) };
    case Ev.Storm:
      return { e: Ev.Storm };
    case Ev.Overtime:
      return { e: Ev.Overtime };
    default:
      return null;
  }
}

export interface InputAck {
  seq: number;
  tick: number;
  margin: number;
}

export function tankFlags(t: TankState, k: number): number {
  let f = 0;
  if (t.alive) f |= TankFlag.Alive;
  if (t.shieldUntil > k) f |= TankFlag.Shield;
  if (t.speedUntil > k) f |= TankFlag.Speed;
  if (t.aimerUntil > k) f |= TankFlag.Aimer;
  if (t.protectUntil > k) f |= TankFlag.Protect;
  if (t.chargeUntil > k) f |= TankFlag.Charging;
  if (t.frozenUntil > k) f |= TankFlag.Recoil;
  if (t.rc !== 0) f |= TankFlag.RcControl;
  return f;
}

/** extraFlags carries server-only state such as TankFlag.Spinning. */
export function encodeTank(t: TankState, k: number, ack: InputAck, extraFlags = 0): TankRow {
  return [
    t.seat,
    r10(t.x),
    r10(t.y),
    r1000(t.a),
    t.hp,
    tankFlags(t, k) | extraFlags,
    t.weapon,
    t.ammo,
    t.bits,
    t.steer,
    ack.seq,
    ack.tick,
    ack.margin,
    left(t.frozenUntil, k),
    left(t.shieldUntil, k),
    left(t.speedUntil, k),
    left(t.aimerUntil, k),
    left(t.chargeUntil, k),
    t.rc,
    left(t.protectUntil, k),
  ];
}

export interface DecodedTank {
  tank: TankState;
  flags: number;
  ack: InputAck;
}

/** team is not on the wire. Callers fill it from the room's player list. */
export function decodeTank(row: TankRow, k: number): DecodedTank {
  const n = (i: number) => row[i] ?? 0;
  const until = (i: number) => (n(i) > 0 ? k + n(i) : 0);
  const flags = n(5);
  return {
    tank: {
      seat: n(0),
      team: 0,
      x: n(1) / 10,
      y: n(2) / 10,
      a: n(3) / 1000,
      hp: n(4),
      alive: (flags & TankFlag.Alive) !== 0,
      weapon: n(6) as Weapon,
      ammo: n(7),
      bits: n(8),
      steer: n(9),
      frozenUntil: until(13),
      shieldUntil: until(14),
      speedUntil: until(15),
      aimerUntil: until(16),
      chargeUntil: until(17),
      rc: n(18),
      protectUntil: until(19),
    },
    flags,
    ack: { seq: n(10), tick: n(11), margin: n(12) },
  };
}

export function encodeProj(p: ProjState, k: number): ProjRow {
  return [
    p.id,
    p.kind,
    r10(p.x),
    r10(p.y),
    r10(p.vx),
    r10(p.vy),
    p.owner,
    p.bounces,
    p.aux,
    left(p.fuseAt, k),
    p.deadly ? 1 : 0,
    k - p.bornAt,
  ];
}

/** team is not on the wire. Callers fill it from the owner. */
export function decodeProj(row: ProjRow, k: number): ProjState {
  const n = (i: number) => row[i] ?? 0;
  const kind = n(1) as Proj;
  const stats = PROJ_STATS[kind] ?? PROJ_STATS[1];
  const bornAt = k - n(11);
  return {
    id: n(0),
    kind,
    x: n(2) / 10,
    y: n(3) / 10,
    vx: n(4) / 10,
    vy: n(5) / 10,
    owner: n(6),
    team: 0,
    r: stats.r,
    bornAt,
    dieAt: bornAt + stats.life,
    bounces: n(7),
    aux: n(8),
    fuseAt: n(9) > 0 ? k + n(9) : 0,
    deadly: n(10) === 1,
    hits: 0,
  };
}

export const crateRow = (c: Crate): CrateRow => [c.id, c.kind, c.cx, c.cy];

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .normalize('NFC')
    // Strip control and format characters (bidi overrides, zero-width spaces), but keep the joiners emoji need.
    .replace(/(?![‍\u{e0020}-\u{e007f}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
}
