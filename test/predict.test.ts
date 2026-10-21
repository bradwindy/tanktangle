import { describe, expect, it } from 'vitest';
import { Prediction, type PredictOptions } from '../src/client/predict';
import { BULLET_MAX_ACTIVE, FIRE_COOLDOWN_TICKS, TANK_HALF_L, TANK_HALF_W, TICK_HZ, TILE } from '../src/shared/constants';
import { emptyMaze } from '../src/shared/grid';
import { decodeTank, encodeProj, encodeTank, type InputAck, type SnapMsg } from '../src/shared/protocol';
import { makeProj, moveTank } from '../src/shared/sim';
import { Input, Proj, Weapon, type ProjState, type TankState } from '../src/shared/types';
import { DEATH_RAY, LASER, PROJ_STATS } from '../src/shared/weapons';

const NO_ACK: InputAck = { seq: 0, tick: 0, margin: 0 };

function tank(seat: number, x: number, y: number, a = 0, extra: Partial<TankState> = {}): TankState {
  return {
    seat,
    team: 0,
    x,
    y,
    a,
    hp: 3,
    alive: true,
    bits: 0,
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
    ...extra,
  };
}

function snap(k: number, tanks: TankState[], acks: InputAck[] = [], projs: ProjState[] = []): SnapMsg {
  return { t: 's', k, T: tanks.map((t, i) => encodeTank(t, k, acks[i] ?? NO_ACK)), P: projs.map((p) => encodeProj(p, k)) };
}

function predictor(opts: Partial<PredictOptions> = {}): Prediction {
  return new Prediction({ maze: emptyMaze(8, 5), playAt: 0, speed: 1, friendlyFire: true, me: 0, teamOf: () => 0, ...opts });
}

/** The same tank as decoded from the snapshot row, driven by hand: bits[k] is the input applied on tick k. */
function reference(t: TankState, K: number, from: number, to: number, bitsAt: (k: number) => number): TankState {
  const ref = decodeTank(encodeTank(t, K, NO_ACK), K).tank;
  const m = emptyMaze(8, 5);
  for (let k = from; k <= to; k++) {
    ref.bits = bitsAt(k);
    moveTank(ref, m, k, 1);
  }
  return ref;
}

describe('prediction replay', () => {
  it('applies unacked inputs at max(k, K + 1, previous + 1), like the server', () => {
    const pred = predictor();
    const start = tank(0, 2 * TILE, 2.5 * TILE);
    // Both were stamped before the snapshot tick but the server has not applied them yet.
    pred.sent({ seq: 1, k: 5, bits: Input.Fwd, steer: 0 });
    pred.sent({ seq: 2, k: 6, bits: Input.Fwd | Input.Right, steer: 0 });
    pred.sent({ seq: 3, k: 14, bits: 0, steer: 0 });
    pred.applySnapshot(snap(8, [start]), 20);
    const bitsAt = (k: number) => (k >= 14 ? 0 : k >= 10 ? Input.Fwd | Input.Right : k >= 9 ? Input.Fwd : 0);
    const ref = reference(start, 8, 9, 20, bitsAt);
    const mine = pred.mine!;
    expect(mine.x).toBeCloseTo(ref.x, 9);
    expect(mine.y).toBeCloseTo(ref.y, 9);
    expect(mine.a).toBeCloseTo(ref.a, 9);
    expect(mine.x).toBeGreaterThan(start.x + 4);
  });

  it('starts from the snapshot bits for the latest acked input and drops acked entries', () => {
    const pred = predictor();
    pred.sent({ seq: 1, k: 3, bits: Input.Fwd, steer: 0 });
    pred.sent({ seq: 2, k: 12, bits: 0, steer: 0 });
    const start = tank(0, 2 * TILE, 2.5 * TILE, 0, { bits: Input.Fwd });
    pred.applySnapshot(snap(8, [start], [{ seq: 1, tick: 4, margin: 1 }]), 16);
    const ref = reference(start, 8, 9, 16, (k) => (k >= 12 ? 0 : Input.Fwd));
    expect(pred.mine!.x).toBeCloseTo(ref.x, 9);
    // A later snapshot acking seq 2 leaves nothing to replay: the tank just sits where the server put it.
    const stopped = tank(0, ref.x, ref.y, 0, { bits: 0 });
    pred.applySnapshot(snap(14, [stopped], [{ seq: 2, tick: 12, margin: 0 }]), 18);
    expect(pred.mine!.x).toBeCloseTo(decodeTank(encodeTank(stopped, 14, NO_ACK), 14).tank.x, 9);
  });

  it('predicts laser recoil from my own press, flashes the muzzle once, and never again on replay', () => {
    const pred = predictor();
    const start = tank(0, 2 * TILE, 2.5 * TILE, 0, { weapon: Weapon.Laser, ammo: 1 });
    pred.applySnapshot(snap(10, [start]), 10);
    pred.sent({ seq: 1, k: 11, bits: Input.Fwd | Input.Fire, steer: 0 });
    for (let i = 0; i < 4; i++) pred.step();
    const mine = pred.mine!;
    expect(mine.frozenUntil).toBe(11 + LASER.recoilTicks);
    expect(mine.x).toBe(decodeTank(encodeTank(start, 10, NO_ACK), 10).tank.x);
    expect(pred.events.filter((e) => e.e === 'muzzle')).toHaveLength(1);
    // The snapshot from before the server applied the press is replayed: same recoil, no second flash.
    pred.applySnapshot(snap(12, [start]), 14);
    expect(pred.mine!.frozenUntil).toBe(13 + LASER.recoilTicks);
    expect(pred.events.filter((e) => e.e === 'muzzle')).toHaveLength(1);
    // Recoil over, the held Fwd drives the tank.
    pred.applySnapshot(snap(16, [start]), 17 + LASER.recoilTicks + 4);
    expect(pred.mine!.x).toBeGreaterThan(start.x + 1);
  });

  it('counts my shots the server has not applied yet against the bullet cap', () => {
    const pred = predictor();
    const me = tank(0, TILE / 2, TILE / 2);
    const flying = Array.from({ length: BULLET_MAX_ACTIVE - 1 }, (_, i) => makeProj(Proj.Bullet, i + 1, me, 3 * TILE, (i + 0.5) * TILE, 0, 0, 1, { bounces: 6 }));
    pred.applySnapshot(snap(10, [me], [], flying), 10);
    // Two taps a cooldown apart, both before any snapshot shows the first shot: only the first one can fire.
    const second = 12 + FIRE_COOLDOWN_TICKS;
    pred.sent({ seq: 1, k: 11, bits: Input.Fire, steer: 0 });
    pred.sent({ seq: 2, k: 12, bits: 0, steer: 0 });
    pred.sent({ seq: 3, k: second, bits: Input.Fire, steer: 0 });
    for (let k = 11; k <= second + 2; k++) pred.step();
    expect(pred.events.filter((e) => e.e === 'muzzle')).toHaveLength(1);
  });

  it('ends my spawn protection on a gatling spin-up or a death ray charge, like the server, and keeps it so on replay', () => {
    for (const weapon of [Weapon.Gatling, Weapon.DeathRay]) {
      const pred = predictor();
      const start = tank(0, 2 * TILE, 2.5 * TILE, 0, { weapon, ammo: 5, protectUntil: 100 });
      pred.applySnapshot(snap(10, [start]), 10);
      pred.sent({ seq: 1, k: 11, bits: Input.Fire, steer: 0 });
      pred.step();
      expect(pred.mine!.protectUntil).toBe(0);
      pred.applySnapshot(snap(10, [start]), 12);
      expect(pred.mine!.protectUntil).toBe(0);
      expect(pred.mine!.chargeUntil).toBe(weapon === Weapon.DeathRay ? 11 + DEATH_RAY.chargeTicks : 0);
      // Neither shows a muzzle flash: the rounds and the beam come from the server.
      expect(pred.events.filter((e) => e.e === 'muzzle')).toHaveLength(0);
    }
  });

  it('emits bounce events once, even when a snapshot replays the same bounce', () => {
    const pred = predictor({ me: -1 });
    const owner = tank(0, TILE / 2, TILE / 2);
    // Heading straight at the right-hand outer wall: it bounces within a few ticks.
    const bullet = makeProj(Proj.Bullet, 1, owner, 8 * TILE - 20, 2.5 * TILE, 0, 0, 1, { bounces: 3 });
    pred.applySnapshot(snap(0, [owner], [], [bullet]), 0);
    for (let i = 0; i < 20; i++) pred.step();
    expect(pred.events.filter((e) => e.e === 'bounce')).toHaveLength(1);
    pred.applySnapshot(snap(2, [owner], [], [makeProj(Proj.Bullet, 1, owner, 8 * TILE - 16, 2.5 * TILE, 0, 2, 1, { bounces: 3 })]), 20);
    expect(pred.events.filter((e) => e.e === 'bounce')).toHaveLength(1);
  });
});

describe('prediction hide rule', () => {
  const y = 2.5 * TILE;
  /** A bullet fired by seat 1 from just left of a tank at seat 0 and flown into it. */
  function shoot(target: Partial<TankState>, opts: Partial<PredictOptions> = {}, owner = 1, deadly = false) {
    const pred = predictor({ me: -1, ...opts });
    const victim = tank(0, 4 * TILE, y, 0, target);
    const shooter = tank(1, TILE, y);
    const p = makeProj(Proj.Bullet, 7, owner === 0 ? victim : shooter, 4 * TILE - 30, y, 0, 0, 1, { bounces: 3 });
    p.deadly = deadly;
    pred.applySnapshot(snap(0, [victim, shooter], [], [p]), 30);
    return { pred, p: pred.projs.find((q) => q.id === 7) };
  }

  it('hides a bullet that reaches an enemy tank', () => {
    expect(shoot({}).pred.hidden.has(7)).toBe(true);
  });

  it('lets it pass the owner (until deadly), spawn-protected tanks and friendly-fire-blocked teammates', () => {
    expect(shoot({}, {}, 0).pred.hidden.has(7)).toBe(false);
    expect(shoot({}, {}, 0, true).pred.hidden.has(7)).toBe(true);
    expect(shoot({ protectUntil: 100 }).pred.hidden.has(7)).toBe(false);
    const teams = { teamOf: () => 1 };
    expect(shoot({}, { ...teams, friendlyFire: false }).pred.hidden.has(7)).toBe(false);
    expect(shoot({}, { ...teams, friendlyFire: true }).pred.hidden.has(7)).toBe(true);
  });

  it('hides a fast pellet that only touches a tank corner between tick ends, like the server', () => {
    const pred = predictor({ me: -1 });
    const victim = tank(0, 4 * TILE, y);
    const shooter = tank(1, TILE, y);
    // A path 1 px off the tank's corner, diagonally: it touches the box for about 2 px of each 3.7 px tick.
    const along = (s: number) => ({ x: victim.x + TANK_HALF_L + (1 + s) / Math.SQRT2, y: victim.y + TANK_HALF_W + (1 - s) / Math.SQRT2 });
    const from = along(-1.8 - PROJ_STATS[Proj.Pellet].speed / TICK_HZ);
    const p = makeProj(Proj.Pellet, 7, shooter, from.x, from.y, -Math.PI / 4, 0, 1);
    pred.applySnapshot(snap(0, [victim, shooter], [], [p]), 2);
    expect(pred.hidden.has(7)).toBe(true);
  });

  it('bounces off a shield instead of hiding', () => {
    const { pred, p } = shoot({ shieldUntil: 100 });
    expect(pred.hidden.has(7)).toBe(false);
    expect(p!.vx).toBeLessThan(0);
    expect(p!.deadly).toBe(true);
  });
});
