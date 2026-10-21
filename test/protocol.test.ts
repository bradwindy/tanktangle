import { describe, expect, it } from 'vitest';
import { GAME_SPEEDS, NAME_MAX } from '../src/shared/constants';
import { emptyMaze, vWall } from '../src/shared/grid';
import { decodeProj, decodeTank, encodeProj, encodeTank, sanitizeName } from '../src/shared/protocol';
import { makeProj, moveTank } from '../src/shared/sim';
import { Input, Proj, WallKind, Weapon, type TankState } from '../src/shared/types';

const NO_ACK = { seq: 0, tick: 0, margin: 0 };

function tank(x: number, y: number, a: number): TankState {
  return {
    seat: 3,
    team: 0,
    x,
    y,
    a,
    hp: 2,
    alive: true,
    bits: Input.Fwd,
    steer: 0,
    weapon: Weapon.Gun,
    ammo: 0,
    frozenUntil: 0,
    chargeUntil: 0,
    rc: 0,
    shieldUntil: 0,
    speedUntil: 0,
    aimerUntil: 0,
    protectUntil: 0,
  };
}

describe('snapshot rows', () => {
  it('carry positions to 0.01 px and angles to 1e-4 rad', () => {
    const t = tank(251.0593787740596, 200.54451260848583, -2.1363304979527737);
    const back = decodeTank(encodeTank(t, 10, NO_ACK), 10).tank;
    expect(Math.abs(back.x - t.x)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(back.y - t.y)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(back.a - t.a)).toBeLessThanOrEqual(0.00005);

    const p = makeProj(Proj.Bullet, 7, t, 123.456789, 98.765432, 0.123456, 4, GAME_SPEEDS[4]);
    const q = decodeProj(encodeProj(p, 10), 10);
    for (const key of ['x', 'y', 'vx', 'vy'] as const) expect(Math.abs(q[key] - p[key])).toBeLessThanOrEqual(0.005);
  });

  it('let a replay keep up with the server while a turning tank scrapes a wall end', () => {
    // At 0.1 px rounding this replay took the other side of the wall end and was 2.3 px off within 4 ticks.
    const m = emptyMaze(10, 7);
    m.walls[vWall(10, 7, 5, 3)] = WallKind.Steel;
    const server = tank(251.0593787740596, 200.54451260848583, -2.1363304979527737);
    server.bits = Input.Fwd | Input.Right;
    const client = decodeTank(encodeTank(server, 0, NO_ACK), 0).tank;
    for (let k = 1; k <= 8; k++) {
      moveTank(server, m, k, GAME_SPEEDS[4]);
      moveTank(client, m, k, GAME_SPEEDS[4]);
    }
    expect(Math.hypot(client.x - server.x, client.y - server.y)).toBeLessThan(0.05);
  });
});

describe('sanitizeName', () => {
  it('keeps real names, collapsing spaces and capping the length', () => {
    expect(sanitizeName('  Ann   Lee ')).toBe('Ann Lee');
    const family = 'Zo\u00eb \u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    expect(sanitizeName(family)).toBe(family);
    const scotland = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}';
    expect(sanitizeName(scotland)).toBe(scotland);
    expect(sanitizeName('ab\u202ecd\u200b')).toBe('abcd');
    expect(Array.from(sanitizeName('x'.repeat(40)))).toHaveLength(NAME_MAX);
    expect(sanitizeName(42)).toBe('');
  });

  it('returns nothing for names that draw as blank, so callers fall back', () => {
    const blanks = ['\u200d'.repeat(20), '\u{e0041}'.repeat(16), '\u0301'.repeat(10), '\ufe0f'.repeat(5), '\u3164'.repeat(5), '\u2800'.repeat(5), '\u200b \u200b'];
    for (const name of blanks) expect(sanitizeName(name)).toBe('');
  });

  it('allows at most two stacked combining marks', () => {
    expect(sanitizeName('a' + '\u0301'.repeat(30))).toBe('\u00e1\u0301\u0301');
  });
});
