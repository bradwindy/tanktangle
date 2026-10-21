import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../src/shared/constants';
import { decodeEvent, Ev, type GameEvent } from '../src/shared/protocol';
import { mulberry32 } from '../src/shared/rng';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';
import { Input, Weapon, type BotLevel } from '../src/shared/types';
import { WEAPON_AMMO } from '../src/shared/weapons';
import { Match } from '../src/worker/match';

type Death = Extract<GameEvent, { e: typeof Ev.Death }>;

interface Played {
  m: Match;
  events: GameEvent[];
  deaths: Death[];
  /** Longest run of ticks any living tank spent driving without moving. */
  longestShove: number;
}

/** A bots-only match. With a weapon, every tank holding just the gun is handed that weapon twice a second. */
function play(levels: BotLevel[], seed: number, settings: Partial<Settings>, maxTicks: number, weapon?: Exclude<Weapon, 0>): Played {
  const teams = settings.teams ?? 0;
  const m = new Match({
    id: 1,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    seats: levels.map((bot, seat) => ({ seat, team: teams ? (seat % teams) + 1 : 0, id: `b${seat}`, bot })),
    rng: mulberry32(seed),
  });
  const events: GameEvent[] = [];
  const last = m.tanks.map((t) => ({ x: t.x, y: t.y }));
  const shove = m.tanks.map(() => 0);
  let longestShove = 0;
  while (!m.over && m.k < maxTicks) {
    if (weapon && m.k % 30 === 0) {
      for (const t of m.tanks) {
        if (!t.alive || t.weapon !== Weapon.Gun || t.rc !== 0 || m.fragOf(t.seat)) continue;
        t.weapon = weapon;
        t.ammo = WEAPON_AMMO[weapon];
      }
    }
    for (const row of m.tick()?.e ?? []) {
      const ev = decodeEvent(row);
      if (ev) events.push(ev);
    }
    m.tanks.forEach((t, i) => {
      const driving = (t.bits & (Input.Fwd | Input.Back)) !== 0 && t.rc === 0 && m.k > m.playAt;
      const still = Math.hypot(t.x - last[i]!.x, t.y - last[i]!.y) < 0.05;
      shove[i] = t.alive && driving && still ? shove[i]! + 1 : 0;
      longestShove = Math.max(longestShove, shove[i]!);
      last[i] = { x: t.x, y: t.y };
    });
  }
  const deaths = events.filter((e): e is Death => e.e === Ev.Death);
  return { m, events, deaths, longestShove };
}

const MINUTE = 60 * TICK_HZ;

describe('bots-only matches', () => {
  it.each(['easy', 'normal', 'hard'] as const)(
    '%s bots find each other in the maze, fight a lives match to the end and pick up crates',
    (level) => {
      for (const seed of [1, 2]) {
        const { m, events, deaths, longestShove } = play([level, level, level, level], seed, { lives: 3 }, 6 * MINUTE);
        expect(m.over).toBe(true);
        expect(m.k).toBeLessThan(4 * MINUTE);
        expect(deaths.filter((d) => d.by >= 0).length).toBeGreaterThanOrEqual(6);
        expect(events.some((e) => e.e === Ev.Pick && e.seat >= 0)).toBe(true);
        expect(m.result!.winners).toHaveLength(1);
        expect(longestShove).toBeLessThan(TICK_HZ);
      }
    },
    60000,
  );

  it('bots on teams finish a timed match, scoring kills for their team', () => {
    const { m, deaths } = play(['easy', 'normal', 'hard', 'easy', 'normal', 'hard'], 3, { mode: 'timed', minutes: 2, teams: 2 }, 3 * MINUTE);
    expect(m.over).toBe(true);
    const enemyKills = deaths.filter((d) => d.by >= 0 && m.tanks[d.by]!.team !== m.tanks[d.seat]!.team).length;
    expect(enemyKills).toBeGreaterThan(10);
    expect(m.result!.team).toBeGreaterThan(0);
  }, 60000);

  it('hard bots beat easy bots by a wide margin', () => {
    let easy = 0;
    let hard = 0;
    for (let seed = 10; seed < 16; seed++) {
      const { m } = play(['easy', 'hard'], seed, { mode: 'timed', minutes: 1, powerups: 0 }, 2 * MINUTE);
      easy += m.seats[0]!.score.kills;
      hard += m.seats[1]!.score.kills;
    }
    expect(hard).toBeGreaterThan(easy * 1.8);
  }, 60000);

  it.each([Weapon.Laser, Weapon.Gatling, Weapon.Shotgun, Weapon.Homing, Weapon.Frag, Weapon.Mines, Weapon.DeathRay, Weapon.Rc] as const)(
    'bots fire weapon %i and kill with it',
    (weapon) => {
      const { deaths, events } = play(['normal', 'normal', 'hard', 'hard'], 40 + weapon, { lives: 3, powerups: 0 }, 4 * MINUTE, weapon);
      expect(events.some((e) => e.e === Ev.Fire && e.weapon === weapon)).toBe(true);
      expect(deaths.filter((d) => d.cause === weapon && !d.self).length).toBeGreaterThanOrEqual(3);
    },
    60000,
  );
});
