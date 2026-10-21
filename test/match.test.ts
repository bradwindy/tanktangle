import { describe, expect, it } from 'vitest';
import {
  BRICK_HP,
  BRICK_REGROW_TICKS,
  COUNTDOWN_TICKS,
  KILL_CREDIT_TICKS,
  MAX_HP,
  OVERTIME_MAX_TICKS,
  RESPAWN_TICKS,
  SPAWN_PROTECT_TICKS,
  STORM_CLOSE_TICKS,
  STORM_DAMAGE_EVERY,
  STORM_START_TICKS,
  TANK_HALF_L,
  TANK_HALF_W,
  TICK_HZ,
  TILE,
} from '../src/shared/constants';
import { cellCenter, cellOf, emptyMaze, vWall } from '../src/shared/grid';
import { generateMaze, mazeSizeFor } from '../src/shared/maze';
import { decodeEvent, Ev, type GameEvent } from '../src/shared/protocol';
import { mulberry32 } from '../src/shared/rng';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';
import { inRect, makeProj, stormRect } from '../src/shared/sim';
import { CAUSE_STORM, Input, Proj, TankFlag, Upgrade, WallKind, Weapon, type CrateKind, type MazeState } from '../src/shared/types';
import { DEATH_RAY, FRAG, GATLING, HOMING, MINES, PROJ_STATS, SHOTGUN, UPGRADE_TICKS, WEAPON_AMMO } from '../src/shared/weapons';
import { Match } from '../src/worker/match';
import { spawnCell } from '../src/worker/placement';

type Event<E extends number> = Extract<GameEvent, { e: E }>;

/** A maze with only the steel boundary, plus the walls given. */
function maze(w: number, h: number, walls: [number, number][] = []): MazeState {
  const m = emptyMaze(w, h);
  for (const [id, kind] of walls) {
    m.walls[id] = kind;
    m.hp[id] = kind === WallKind.Brick ? BRICK_HP : 0;
  }
  return m;
}

function makeMatch(opts: { settings?: Partial<Settings>; teams?: number[]; w?: number; h?: number; walls?: [number, number][] } = {}) {
  const teams = opts.teams ?? [0, 0];
  return new Match({
    id: 1,
    settings: { ...DEFAULT_SETTINGS, powerups: 0, ...opts.settings },
    seats: teams.map((team, seat) => ({ seat, team, id: `p${seat}`, bot: null })),
    rng: mulberry32(7),
    maze: maze(opts.w ?? 7, opts.h ?? 3, opts.walls),
  });
}

/** Ticks n times and returns the events the snapshots carried. */
function run(m: Match, n = 1): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n && !m.over; i++) {
    for (const row of m.tick()?.e ?? []) {
      const ev = decodeEvent(row);
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** Ticks until done, then one more snapshot so events from the deciding tick arrive. */
function runUntil(m: Match, done: () => boolean, max = 2000): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < max && !done() && !m.over; i++) out.push(...run(m));
  if (m.k % 2 === 1) out.push(...run(m));
  return out;
}

const events = <E extends number>(list: GameEvent[], e: E) => list.filter((x): x is Event<E> => x.e === e);

/** Skips the countdown, then puts each tank at a cell facing the given angle, unprotected. */
function start(m: Match, at: [number, number, number][]): void {
  run(m, COUNTDOWN_TICKS);
  at.forEach(([cx, cy, a], seat) => place(m, seat, cx, cy, a));
}

function place(m: Match, seat: number, cx: number, cy: number, a: number): void {
  const t = m.tanks[seat]!;
  const c = cellCenter(cx, cy);
  t.x = c.x;
  t.y = c.y;
  t.a = a;
  t.protectUntil = 0;
}

/** A press and release of Fire. */
function tap(m: Match, seat: number): GameEvent[] {
  const t = m.tanks[seat]!;
  t.bits |= Input.Fire;
  const out = run(m);
  t.bits &= ~Input.Fire;
  return [...out, ...run(m)];
}

const RIGHT = 0;
const LEFT = Math.PI;
const DOWN = Math.PI / 2;

describe('inputs', () => {
  it('applies one queued input per tick at its stamped tick and acks it with the margin', () => {
    const m = makeMatch();
    m.queueInput(0, 1, 5, Input.Fwd, 0);
    m.queueInput(0, 1, 9, Input.Back, 0);
    m.queueInput(0, 2, 5, Input.Fwd | Input.Fire, 0);
    run(m, 4);
    expect(m.tanks[0]!.bits).toBe(0);
    run(m);
    expect(m.tanks[0]!.bits).toBe(Input.Fwd);
    expect(m.seats[0]!.ack).toEqual({ seq: 1, tick: 5, margin: 4 });
    run(m);
    expect(m.tanks[0]!.bits).toBe(Input.Fwd | Input.Fire);
    expect(m.seats[0]!.ack).toEqual({ seq: 2, tick: 6, margin: 4 });
  });

  it('starts counting seqs again when a socket rebinds, and stops the tank when it drops', () => {
    const m = makeMatch();
    m.queueInput(0, 40, 1, Input.Fwd, 0);
    run(m);
    m.resetInput(0);
    expect(m.seats[0]!.ack).toEqual({ seq: 0, tick: 0, margin: 0 });
    m.queueInput(0, 1, m.k + 1, Input.Left, 0);
    run(m);
    expect(m.tanks[0]!.bits).toBe(Input.Left);
    m.releaseInput(0);
    expect(m.tanks[0]!.bits).toBe(0);
  });

  it('holds tanks still through the countdown, then lets them drive', () => {
    const m = makeMatch();
    const t = m.tanks[0]!;
    const x0 = t.x;
    const y0 = t.y;
    t.bits = Input.Fwd;
    run(m, COUNTDOWN_TICKS - 1);
    expect([t.x, t.y]).toEqual([x0, y0]);
    run(m, 10);
    expect(Math.hypot(t.x - x0, t.y - y0)).toBeGreaterThan(5);
  });
});

describe('snapshots and the match message', () => {
  it('sends every tank and projectile every other tick, and the maze and timers at the start', () => {
    const m = makeMatch({ settings: { mode: 'timed', minutes: 2 } });
    const msg = m.matchMsg();
    expect(msg).toMatchObject({ t: 'match', id: 1, k: 0, w: 7, h: 3, playAt: COUNTDOWN_TICKS, stormAt: 0 });
    expect(msg.endAt).toBe(COUNTDOWN_TICKS + 2 * 60 * TICK_HZ);
    expect(m.tick()).toBeNull();
    const snap = m.tick()!;
    expect(snap.k).toBe(2);
    expect(snap.T.map((row) => row[0])).toEqual([0, 1]);
    expect(events((snap.e ?? []).map((r) => decodeEvent(r)!), Ev.Spawn)).toHaveLength(2);
  });
});

describe('lives mode', () => {
  it('ends with the last tank that has lives left, and flushes the deciding events on any tick', () => {
    const m = makeMatch({ settings: { lives: 1 } });
    start(m, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
    ]);
    m.tanks[1]!.hp = 1;
    const seen = [...tap(m, 0)];
    let last = null;
    while (!m.over && m.k < 1000) {
      last = m.tick();
      for (const row of last?.e ?? []) seen.push(decodeEvent(row)!);
    }
    expect(m.over).toBe(true);
    expect(last?.k).toBe(m.k);
    expect(events(seen, Ev.Death)).toEqual([expect.objectContaining({ seat: 1, by: 0, self: false })]);
    expect(m.result).toMatchObject({ draw: false, winners: ['p0'], team: 0, standings: ['p0', 'p1'] });
    expect(m.seats[1]!.score).toMatchObject({ lives: 0, out: true, deaths: 1 });
  });

  it('respawns after the delay with spawn protection that shots pass through, until the tank fires', () => {
    const m = makeMatch({ settings: { lives: 3 } });
    start(m, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
    ]);
    m.tanks[1]!.hp = 1;
    tap(m, 0);
    runUntil(m, () => !m.tanks[1]!.alive);
    const diedAt = m.k;
    const spawns = events(
      runUntil(m, () => m.tanks[1]!.alive),
      Ev.Spawn,
    );
    expect(m.k - diedAt).toBe(RESPAWN_TICKS);
    expect(spawns).toEqual([expect.objectContaining({ seat: 1 })]);
    const t = m.tanks[1]!;
    expect(t.hp).toBe(MAX_HP);
    expect(t.protectUntil).toBe(m.k + SPAWN_PROTECT_TICKS);

    place(m, 1, 4, 1, LEFT);
    t.protectUntil = m.k + SPAWN_PROTECT_TICKS;
    run(m, 30);
    tap(m, 0);
    const hits = events(run(m, 70), Ev.Hit);
    expect(hits).toEqual([]);
    expect(t.hp).toBe(MAX_HP);
    tap(m, 1);
    expect(t.protectUntil).toBeLessThanOrEqual(m.k);
  });

  it('respawns inside a fully closed storm, never on the enemy holding its middle', () => {
    const rng = mulberry32(12);
    const m = generateMaze(rng, { ...mazeSizeFor(12, 0), brickRatio: 0.5 });
    const safe = stormRect(m, 1000 + STORM_CLOSE_TICKS, 1000)!;
    const enemy = cellCenter(cellOf((safe.x0 + safe.x1) / 2), cellOf((safe.y0 + safe.y1) / 2));
    for (let i = 0; i < 50; i++) {
      const { cx, cy } = spawnCell(m, rng, safe, [enemy], [], [enemy]);
      const at = cellCenter(cx, cy);
      expect(inRect(safe, at.x, at.y)).toBe(true);
      expect(at).not.toEqual(enemy);
    }
  });

  it('closes a storm that hurts tanks outside the safe area', () => {
    const m = makeMatch({ settings: { lives: 9 } });
    start(m, [
      [0, 0, DOWN],
      [3, 1, LEFT],
    ]);
    expect(m.stormAt).toBe(COUNTDOWN_TICKS + STORM_START_TICKS);
    const seen = runUntil(m, () => m.k >= m.stormAt + 30 * STORM_DAMAGE_EVERY, 20000);
    expect(events(seen, Ev.Storm)).toHaveLength(1);
    const stormHits = events(seen, Ev.Hit).filter((h) => h.by === -1);
    expect(stormHits.length).toBeGreaterThan(0);
    expect(stormHits.every((h) => h.seat === 0)).toBe(true);
    expect(events(seen, Ev.Death).some((d) => d.seat === 0 && d.cause === CAUSE_STORM && d.by === -1 && !d.self)).toBe(true);
    expect(m.seats[0]!.score.kills).toBe(0);
  });
});

describe('timed mode', () => {
  it('ends at the clock with the top killer the winner', () => {
    const m = makeMatch({ settings: { mode: 'timed', minutes: 1 } });
    start(m, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
    ]);
    m.tanks[1]!.hp = 1;
    tap(m, 0);
    runUntil(m, () => m.over, m.endAt + 10);
    expect(m.k).toBe(m.endAt);
    expect(m.result).toMatchObject({ draw: false, winners: ['p0'], standings: ['p0', 'p1'] });
  });

  it('goes to overtime on a tie and ends on the next kill, or in a draw when overtime runs out', () => {
    const m = makeMatch({ settings: { mode: 'timed', minutes: 1 } });
    const seen = runUntil(m, () => m.k >= m.endAt, m.endAt + 10);
    expect(m.over).toBe(false);
    expect(m.overtime).toBe(true);
    expect(events([...seen, ...run(m, 2)], Ev.Overtime)).toHaveLength(1);
    place(m, 0, 1, 1, RIGHT);
    place(m, 1, 4, 1, LEFT);
    m.tanks[0]!.hp = 1;
    tap(m, 1);
    runUntil(m, () => m.over, 200);
    expect(m.result).toMatchObject({ draw: false, winners: ['p1'] });

    const tie = makeMatch({ settings: { mode: 'timed', minutes: 1 } });
    runUntil(tie, () => tie.over, tie.endAt + OVERTIME_MAX_TICKS + 10);
    expect(tie.k).toBe(tie.endAt + OVERTIME_MAX_TICKS);
    expect(tie.result).toMatchObject({ draw: true, team: 0 });
    expect(tie.result!.winners.sort()).toEqual(['p0', 'p1']);
  });
});

describe('scoring', () => {
  it('costs a kill for killing yourself with your own ricochet', () => {
    const m = makeMatch({ settings: { mode: 'timed' } });
    start(m, [
      [1, 1, LEFT],
      [5, 1, LEFT],
    ]);
    m.tanks[0]!.hp = 1;
    const deaths = events([...tap(m, 0), ...runUntil(m, () => !m.tanks[0]!.alive, 200)], Ev.Death);
    expect(deaths).toEqual([expect.objectContaining({ seat: 0, by: -1, cause: Weapon.Gun, self: true })]);
    expect(m.seats[0]!.score).toMatchObject({ kills: -1, deaths: 1, selfDamage: 1 });
  });

  it('costs a kill for a team kill with friendly fire on, and team kills do no damage with it off', () => {
    const on = makeMatch({ settings: { mode: 'timed', teams: 2, friendlyFire: true }, teams: [1, 1, 2] });
    start(on, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
      [6, 0, LEFT],
    ]);
    on.tanks[1]!.hp = 1;
    tap(on, 0);
    runUntil(on, () => !on.tanks[1]!.alive, 200);
    expect(on.tanks[1]!.alive).toBe(false);
    expect(on.seats[0]!.score.kills).toBe(-1);

    const off = makeMatch({ settings: { mode: 'timed', teams: 2, friendlyFire: false }, teams: [1, 1, 2] });
    start(off, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
      [6, 0, LEFT],
    ]);
    off.tanks[1]!.hp = 1;
    tap(off, 0);
    const hits = events(run(off, 150), Ev.Hit);
    expect(hits.filter((h) => h.seat === 1)).toEqual([]);
    expect(off.tanks[1]!.alive).toBe(true);
  });

  it('never treats free-for-all players as teammates, even with friendly fire off', () => {
    const m = makeMatch({ settings: { mode: 'timed', teams: 0, friendlyFire: false } });
    start(m, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
    ]);
    m.tanks[1]!.hp = 1;
    tap(m, 0);
    runUntil(m, () => !m.tanks[1]!.alive, 200);
    expect(m.seats[0]!.score.kills).toBe(1);
  });

  it('credits the last enemy to damage you when you die by your own hand soon after', () => {
    const credit = (gap: number) => {
      const m = makeMatch({ settings: { mode: 'timed' } });
      start(m, [
        [1, 1, LEFT],
        [4, 1, LEFT],
      ]);
      place(m, 1, 5, 1, LEFT);
      // Seat 1 shoots seat 0 in the back from across the room.
      place(m, 0, 2, 1, LEFT);
      m.tanks[0]!.shieldUntil = 0;
      tap(m, 1);
      runUntil(m, () => m.tanks[0]!.hp < MAX_HP, 300);
      expect(m.tanks[0]!.hp).toBe(MAX_HP - 1);
      run(m, gap);
      place(m, 0, 1, 1, LEFT);
      m.tanks[0]!.hp = 1;
      tap(m, 0);
      runUntil(m, () => !m.tanks[0]!.alive, 200);
      return m;
    };
    const soon = credit(30);
    expect(soon.seats[1]!.score.kills).toBe(1);
    expect(soon.seats[0]!.score.kills).toBe(0);
    const late = credit(KILL_CREDIT_TICKS + 10);
    expect(late.seats[1]!.score.kills).toBe(0);
    expect(late.seats[0]!.score.kills).toBe(-1);
  });
});

describe('crates', () => {
  const pick = (kind: CrateKind) => {
    const m = makeMatch({ settings: { mode: 'timed' } });
    start(m, [
      [1, 1, RIGHT],
      [5, 1, LEFT],
    ]);
    m.crates.push({ id: 99, kind, cx: 1, cy: 1 });
    const picks = events(run(m, 2), Ev.Pick);
    return { m, t: m.tanks[0]!, picks };
  };

  it.each([Weapon.Laser, Weapon.Gatling, Weapon.Shotgun, Weapon.Homing, Weapon.Frag, Weapon.Mines, Weapon.DeathRay, Weapon.Rc] as const)(
    'weapon %i replaces the gun with full ammo',
    (kind) => {
      const { m, t, picks } = pick(kind);
      expect(picks).toEqual([{ e: Ev.Pick, id: 99, seat: 0, kind }]);
      expect([t.weapon, t.ammo]).toEqual([kind, WEAPON_AMMO[kind]]);
      expect(m.crates).toEqual([]);
      expect(m.seats[0]!.score.crates).toBe(1);
    },
  );

  it.each([Upgrade.Shield, Upgrade.Speed, Upgrade.Aimer] as const)('upgrade %i runs for its time', (kind) => {
    const { m, t } = pick(kind);
    const until = kind === Upgrade.Shield ? t.shieldUntil : kind === Upgrade.Speed ? t.speedUntil : t.aimerUntil;
    expect(until).toBe(m.k - 1 + UPGRADE_TICKS[kind]);
  });

  it('repair kits heal, and stay put for a tank at full health', () => {
    const full = pick(Upgrade.Repair);
    expect(full.picks).toEqual([]);
    expect(full.m.crates).toHaveLength(1);
    full.t.hp = 1;
    run(full.m, 2);
    expect(full.t.hp).toBe(MAX_HP);
    expect(full.m.crates).toEqual([]);
  });

  it('spawns crates away from tanks once play starts', () => {
    const m = makeMatch({ settings: { mode: 'timed', powerups: 2 }, w: 9, h: 3 });
    start(m, [
      [0, 1, RIGHT],
      [1, 1, LEFT],
    ]);
    const seen = runUntil(m, () => m.crates.length > 0, 400);
    const crate = events(seen, Ev.Crate)[0]!;
    expect(m.k).toBe(m.playAt + 2 * TICK_HZ);
    expect(crate.cx).toBeGreaterThanOrEqual(4);
    expect(m.crates).toEqual([{ id: crate.id, kind: crate.kind, cx: crate.cx, cy: crate.cy }]);
  });
});

describe('weapons', () => {
  const duel = (weapon: Weapon, at: [number, number, number][] = [[1, 1, RIGHT], [4, 1, LEFT]], w = 7, walls: [number, number][] = []) => {
    const m = makeMatch({ settings: { mode: 'timed' }, w, walls });
    start(m, at);
    const t = m.tanks[0]!;
    t.weapon = weapon;
    t.ammo = weapon === Weapon.Gun ? 0 : WEAPON_AMMO[weapon];
    return { m, t, target: m.tanks[1]! };
  };

  it('laser: goes through a shielded teammate with friendly fire off, rather than bouncing back at the shooter', () => {
    const m = makeMatch({ settings: { mode: 'timed', teams: 2, friendlyFire: false }, teams: [1, 1, 2], w: 9, h: 2 });
    start(m, [
      [0, 0, RIGHT],
      [2, 0, RIGHT],
      [6, 0, LEFT],
    ]);
    const [me, mate, enemy] = m.tanks;
    mate!.shieldUntil = m.k + 600;
    me!.weapon = Weapon.Laser;
    me!.ammo = 1;
    tap(m, 0);
    expect([me!.hp, mate!.hp, enemy!.alive]).toEqual([MAX_HP, MAX_HP, false]);
  });

  it('laser: hits instantly for 3, freezes the shooter briefly, and returns to the gun', () => {
    const { m, t, target } = duel(Weapon.Laser);
    t.bits = Input.Fire | Input.Fwd;
    const seen = run(m, 2);
    expect(events(seen, Ev.Beam)).toEqual([expect.objectContaining({ seat: 0, weapon: Weapon.Laser })]);
    expect(target.alive).toBe(false);
    expect(t.weapon).toBe(Weapon.Gun);
    const x = t.x;
    run(m, 5);
    expect(t.x).toBe(x);
  });

  it('gatling: spins up while held, then fires a round every few ticks', () => {
    const { m, t } = duel(Weapon.Gatling, [
      [1, 0, RIGHT],
      [5, 2, LEFT],
    ]);
    t.bits = Input.Fire;
    run(m, GATLING.spinUpTicks - 1);
    expect(m.projectiles).toEqual([]);
    const snap = m.tick()!;
    expect((snap.T[0]![5]! & TankFlag.Spinning) !== 0).toBe(true);
    run(m, GATLING.everyTicks * 3);
    expect(m.projectiles.filter((p) => p.kind === Proj.Gatling).length).toBeGreaterThanOrEqual(3);
    expect(t.ammo).toBeLessThan(WEAPON_AMMO[Weapon.Gatling]);
  });

  it('shotgun: one blast throws a spread of pellets', () => {
    const { m, t } = duel(Weapon.Shotgun, [
      [1, 0, RIGHT],
      [5, 2, LEFT],
    ]);
    tap(m, 0);
    expect(m.projectiles.filter((p) => p.kind === Proj.Pellet)).toHaveLength(SHOTGUN.pellets);
    expect(t.ammo).toBe(SHOTGUN.blasts - 1);
  });

  it('homing missile: flies straight, then hunts the enemy round the maze and blows up on it', () => {
    const { m, target } = duel(
      Weapon.Homing,
      [
        [5, 0, LEFT],
        [9, 2, LEFT],
      ],
      10,
    );
    tap(m, 0);
    const missile = m.projectiles.find((p) => p.kind === Proj.Homing)!;
    run(m, HOMING.straightTicks);
    expect(missile.aux).toBe(1);
    const booms = events(
      runUntil(m, () => !target.alive, 600),
      Ev.Boom,
    );
    expect(target.alive).toBe(false);
    expect(booms[0]).toMatchObject({ kind: Weapon.Homing });
  });

  it('frag bomb: a second press sets it off in a blast of shrapnel', () => {
    const { m } = duel(Weapon.Frag, [
      [1, 0, RIGHT],
      [5, 2, LEFT],
    ]);
    tap(m, 0);
    expect(m.projectiles.filter((p) => p.kind === Proj.Frag)).toHaveLength(1);
    run(m, FRAG.minDetonateTicks);
    const booms = events(tap(m, 0), Ev.Boom);
    expect(booms).toEqual([expect.objectContaining({ kind: Weapon.Frag })]);
    expect(m.projectiles.filter((p) => p.kind === Proj.Shrapnel)).toHaveLength(24);
    expect(m.fragOf(0)).toBeUndefined();
  });

  it('mines: drop behind, arm, trigger when an enemy drives up, then explode', () => {
    const { m, target } = duel(Weapon.Mines, [
      [3, 1, RIGHT],
      [6, 1, LEFT],
    ]);
    tap(m, 0);
    const mine = m.projectiles.find((p) => p.kind === Proj.Mine)!;
    expect(mine.x).toBeLessThan(m.tanks[0]!.x);
    run(m, MINES.armTicks);
    expect(mine.aux).toBe(1);
    place(m, 0, 6, 0, RIGHT);
    target.x = mine.x - 20;
    target.y = mine.y;
    target.a = 0;
    target.bits = Input.Fwd;
    const seen = runUntil(m, () => !m.projectiles.includes(mine), 200);
    expect(events(seen, Ev.Trigger)).toEqual([{ e: Ev.Trigger, id: mine.id }]);
    expect(events(seen, Ev.Boom)).toEqual([expect.objectContaining({ kind: Weapon.Mines })]);
    expect(target.hp).toBeLessThan(MAX_HP);
  });

  it('mines ignore each other but go off when a bullet touches them', () => {
    const m = makeMatch({ settings: { mode: 'timed' } });
    start(m, [
      [0, 0, RIGHT],
      [6, 0, LEFT],
    ]);
    const owner = { seat: 0, team: 0 };
    const c = cellCenter(3, 2);
    m.projectiles.push(makeProj(Proj.Mine, 500, owner, c.x, c.y, 0, m.k, 1), makeProj(Proj.Mine, 501, owner, c.x + 4, c.y, 0, m.k, 1));
    for (const p of m.projectiles) p.vx = p.vy = 0;
    expect(events(run(m, 10), Ev.Boom)).toEqual([]);
    m.projectiles.push(makeProj(Proj.Bullet, 502, { seat: 1, team: 0 }, c.x - 30, c.y, 0, m.k, 1));
    const booms = events(run(m, 30), Ev.Boom);
    expect(booms.length).toBe(2);
  });

  it('death ray: charges, then fires a beam through walls', () => {
    const { m, t, target } = duel(
      Weapon.DeathRay,
      [
        [1, 1, RIGHT],
        [5, 1, LEFT],
      ],
      7,
      [[vWall(7, 3, 3, 1), WallKind.Steel]],
    );
    const charge = events(tap(m, 0), Ev.Charge);
    expect(charge).toEqual([{ e: Ev.Charge, seat: 0 }]);
    expect(t.chargeUntil).toBeGreaterThan(m.k);
    const seen = runUntil(m, () => !target.alive, DEATH_RAY.chargeTicks + 5);
    expect(events(seen, Ev.Beam)).toEqual([expect.objectContaining({ seat: 0, weapon: Weapon.DeathRay })]);
    expect(target.alive).toBe(false);
  });

  it('RC missile: holds the tank still, steers with the turn keys, and blows up on the next press', () => {
    const { m, t } = duel(Weapon.Rc, [
      [1, 0, RIGHT],
      [6, 2, LEFT],
    ]);
    tap(m, 0);
    const rc = m.projectiles.find((p) => p.kind === Proj.Rc)!;
    expect(t.rc).toBe(rc.id);
    const x = t.x;
    t.bits = Input.Fwd | Input.Right;
    run(m, 10);
    expect(t.x).toBe(x);
    expect(Math.atan2(rc.vy, rc.vx)).toBeGreaterThan(0.3);
    t.bits = 0;
    const booms = events(tap(m, 0), Ev.Boom);
    expect(booms).toEqual([expect.objectContaining({ kind: Weapon.Rc })]);
    expect(t.rc).toBe(0);
  });

  it('a fast pellet that only touches a tank corner between tick ends still hits it', () => {
    const m = makeMatch({ settings: { mode: 'timed' } });
    start(m, [
      [0, 0, RIGHT],
      [4, 1, RIGHT],
    ]);
    const t = m.tanks[1]!;
    // A path 1 px off the tank's corner, diagonally: it touches the box for about 2 px of each 3.7 px tick.
    const along = (s: number) => ({ x: t.x + TANK_HALF_L + (1 + s) / Math.SQRT2, y: t.y + TANK_HALF_W + (1 - s) / Math.SQRT2 });
    const from = along(-1.8 - PROJ_STATS[Proj.Pellet].speed / TICK_HZ);
    m.projectiles.push(makeProj(Proj.Pellet, 900, { seat: 0, team: 0 }, from.x, from.y, -Math.PI / 4, m.k, 1));
    run(m, 2);
    expect(t.hp).toBe(MAX_HP - 1);
    expect(m.projectiles).toEqual([]);
  });

  it('shield: no damage, and shots bounce off it', () => {
    const { m, target } = duel(Weapon.Gun);
    target.shieldUntil = m.k + 600;
    tap(m, 0);
    const seen = run(m, 70);
    expect(events(seen, Ev.Block)).toEqual([expect.objectContaining({ seat: 1 })]);
    expect(target.hp).toBe(MAX_HP);
    const bullet = m.projectiles.find((p) => p.kind === Proj.Bullet);
    expect(bullet?.vx ?? 0).toBeLessThan(0);
  });

  it('speed boost: drives farther in the same time', () => {
    const distance = (boost: boolean) => {
      const m = makeMatch({ settings: { mode: 'timed' } });
      start(m, [
        [0, 1, RIGHT],
        [6, 0, LEFT],
      ]);
      const t = m.tanks[0]!;
      if (boost) t.speedUntil = m.k + 600;
      const x = t.x;
      t.bits = Input.Fwd;
      run(m, 30);
      return t.x - x;
    };
    expect(distance(true)).toBeGreaterThan(distance(false) * 1.3);
  });
});

describe('bricks', () => {
  const brick = vWall(7, 3, 4, 1);

  it('chip on a projectile’s first wall contact only, and smash in blasts', () => {
    const m = makeMatch({ settings: { mode: 'timed' }, walls: [[brick, WallKind.Brick]] });
    start(m, [
      [0, 0, RIGHT],
      [6, 0, LEFT],
    ]);
    const c = cellCenter(2, 1);
    m.projectiles.push(makeProj(Proj.Bullet, 900, { seat: 0, team: 0 }, c.x, c.y, 0, m.k, 1, { bounces: 6 }));
    const first = events(run(m, 60), Ev.Brick);
    expect(first).toEqual([{ e: Ev.Brick, wall: brick, hp: BRICK_HP - 1 }]);
    expect(events(run(m, 240), Ev.Brick)).toEqual([]);
    expect(m.maze.hp[brick]).toBe(BRICK_HP - 1);

    const frag = makeProj(Proj.Frag, 901, { seat: 0, team: 0 }, 4 * TILE - 8, c.y, 0, m.k, 1);
    frag.vx = frag.vy = 0;
    frag.dieAt = m.k + 1;
    m.projectiles.push(frag);
    const smashed = events(run(m, 2), Ev.Brick);
    expect(smashed).toEqual([{ e: Ev.Brick, wall: brick, hp: 0 }]);
    expect(m.seats[0]!.score.bricks).toBe(1);
  });

  it('regrow after a while, but not while a tank sits in the gap', () => {
    const m = makeMatch({ settings: { mode: 'timed' }, walls: [[brick, WallKind.Brick]] });
    start(m, [
      [0, 0, RIGHT],
      [6, 0, LEFT],
    ]);
    const c = cellCenter(3, 1);
    const frag = makeProj(Proj.Frag, 901, { seat: 0, team: 0 }, c.x, c.y, 0, m.k, 1);
    frag.dieAt = m.k + 1;
    m.projectiles.push(frag);
    run(m, 40);
    expect(m.maze.hp[brick]).toBe(0);
    m.tanks[1]!.x = 4 * TILE;
    m.tanks[1]!.y = c.y;
    m.tanks[1]!.a = 0;
    m.tanks[1]!.hp = MAX_HP;
    m.tanks[1]!.alive = true;
    run(m, BRICK_REGROW_TICKS + 30);
    expect(m.maze.hp[brick]).toBe(0);
    place(m, 1, 6, 2, LEFT);
    const regrow = events(run(m, TICK_HZ + 2), Ev.Brick);
    expect(regrow).toEqual([{ e: Ev.Brick, wall: brick, hp: BRICK_HP }]);
  });
});

describe('players leaving', () => {
  it('removes the tank, puts the player out, and ends the match when one side is left', () => {
    const m = makeMatch({ settings: { lives: 3 }, teams: [0, 0, 0] });
    start(m, [
      [1, 1, RIGHT],
      [4, 1, LEFT],
      [6, 0, LEFT],
    ]);
    m.removeSeat(2);
    run(m);
    expect(m.snapshot().T.map((row) => row[0])).toEqual([0, 1]);
    expect(m.seats[2]!.score).toMatchObject({ out: true, lives: 0 });
    expect(m.over).toBe(false);
    m.removeSeat(1);
    run(m);
    expect(m.result).toMatchObject({ draw: false, winners: ['p0'] });
  });
});
