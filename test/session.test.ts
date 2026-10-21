import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Controls, InputState } from '../src/client/input';
import { MAX_STALL_TICKS } from '../src/client/clock';
import { Session } from '../src/client/session';
import type { Renderer, Sfx } from '../src/client/view';
import { TICK_MS } from '../src/shared/constants';
import { emptyMaze, encodeMaze } from '../src/shared/grid';
import { encodeEvent, encodeTank, Ev, type EventRow, type MatchMsg, type PublicPlayer, type ServerMsg } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import { Input, Weapon, type TankState } from '../src/shared/types';

/** Stands in for the browser WebSocket: the test opens it, feeds it server messages and reads what was sent. */
class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor() {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

function player(id: string, seat: number, extra: Partial<PublicPlayer> = {}): PublicPlayer {
  return { id, name: id, color: seat, seat, team: 0, bot: null, connected: true, kills: 0, deaths: 0, lives: 3, out: false, ...extra };
}

function tank(seat: number, x: number, y: number, extra: Partial<TankState> = {}): TankState {
  return {
    seat,
    team: 0,
    x,
    y,
    a: 0,
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

const noop = new Proxy({}, { get: () => () => {} });

/** A Session joined to a running lives match as player 'me', with time and input under the test's control. */
function joined(players: PublicPlayer[]) {
  let now = 1000;
  let input: InputState = { bits: 0, steer: 0 };
  const events: unknown[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const renderer = new Proxy({}, { get: (_, key) => (key === 'event' ? (ev: unknown) => events.push(ev) : () => {}) }) as Renderer;
  const controls = { sample: () => input } as unknown as Controls;
  const session = new Session('ABCDE', 'me', { renderer, sfx: noop as Sfx, controls, pid: 'pid', hooks: noop as never });
  const socket = () => FakeSocket.all.at(-1)!;
  const maze = emptyMaze(10, 6);
  socket().open();
  socket().receive({ t: 'welcome', id: 'me' });
  socket().receive({ t: 'room', phase: 'playing', host: 'me', settings: DEFAULT_SETTINGS, players, overtime: false, result: null });
  const match: MatchMsg = { t: 'match', id: 1, k: 100, w: maze.w, h: maze.h, ...encodeMaze(maze), crates: [], playAt: 0, stormAt: 0, endAt: 0 };
  socket().receive(match);
  return {
    session,
    socket,
    match,
    events,
    get now() {
      return now;
    },
    set input(next: InputState) {
      input = next;
    },
    /** Moves time on. */
    wait(ms: number) {
      now += ms;
    },
    snap(k: number, tanks: TankState[], e?: EventRow[]) {
      socket().receive({ t: 's', k, T: tanks.map((t) => encodeTank(t, k, { seq: 0, tick: 0, margin: 0 })), P: [], e });
    },
    frame() {
      const view = session.frame(now, TICK_MS / 1000);
      if (view) session.dispatch(view, now);
      return view;
    },
    /** The input messages sent on the current socket. */
    inputs() {
      return socket()
        .sent.map((s) => JSON.parse(s) as { t: string; s: number; k: number })
        .filter((m) => m.t === 'in');
    },
  };
}

describe('session', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lets a player who is out of lives follow the leader and step through the other tanks', () => {
    const h = joined([player('me', 0, { lives: 0, out: true }), player('a', 1, { lives: 1 }), player('b', 2, { lives: 2 })]);
    h.snap(102, [tank(0, 50, 50, { alive: false }), tank(1, 100, 100), tank(2, 300, 150)]);
    expect(h.frame()?.focus).toEqual({ x: 300, y: 150 });
    expect(h.session.hud(h.now)?.canCycle).toBe(true);
    h.session.cycleSpectate();
    expect(h.frame()?.focus).toEqual({ x: 100, y: 100 });
    h.session.close();
  });

  it('carries on its input seqs when the match message comes back after a reconnect', () => {
    const h = joined([player('me', 0), player('a', 1)]);
    const tanks = [tank(0, 50, 50), tank(1, 300, 150)];
    h.snap(102, tanks);
    h.frame();
    h.socket().drop();
    vi.advanceTimersByTime(1000);
    h.socket().open();
    h.wait(TICK_MS);
    h.frame();
    expect(h.inputs().map((m) => m.s)).toEqual([1]);
    // The server binds the socket to the seat (seqs restart there too), then replies with the same match.
    h.socket().receive({ ...h.match, k: 104 });
    h.input = { bits: Input.Fwd, steer: 0 };
    h.wait(TICK_MS);
    h.frame();
    expect(h.inputs().map((m) => m.s)).toEqual([1, 2]);
    h.session.close();
  });

  it('stamps input read after a hitch with the newest tick, not the oldest one caught up on', () => {
    const h = joined([player('me', 0), player('a', 1)]);
    h.snap(102, [tank(0, 50, 50), tank(1, 300, 150)]);
    h.frame();
    h.wait(300);
    h.input = { bits: Input.Fwd, steer: 0 };
    const view = h.frame()!;
    expect(h.inputs().at(-1)!.k).toBe(Math.floor(view.tick) + 1);
    h.session.close();
  });

  it('caps joystick steer messages: a fast sweep at one per 3 ticks, thumb tremor at none', () => {
    const h = joined([player('me', 0), player('a', 1)]);
    h.snap(102, [tank(0, 50, 50), tank(1, 300, 150)]);
    h.frame();
    const count = (ticks: number, steerAt: (i: number) => number) => {
      const before = h.inputs().length;
      for (let i = 0; i < ticks; i++) {
        h.input = { bits: Input.Steer | Input.Fwd, steer: steerAt(i) & 255 };
        h.wait(TICK_MS);
        h.frame();
      }
      return h.inputs().length - before;
    };
    // 4 steps a tick is a quick flick (about 340 degrees a second). The first message is the Steer bits change.
    expect(count(30, (i) => 4 * i)).toBe(10);
    // Then held still with a one-step wobble: nothing until the heartbeat.
    count(5, () => 120);
    expect(count(50, (i) => 120 + (i % 2))).toBe(0);
    h.session.close();
  });

  it('keeps going when the server stalls and falls behind, rather than freezing until it catches up', () => {
    const h = joined([player('me', 0), player('a', 1)]);
    const tanks = [tank(0, 50, 50), tank(1, 300, 150)];
    let k = 102;
    h.snap(k, tanks);
    let last = -1;
    let stalled = 0;
    let longest = 0;
    for (let i = 0; i < 300; i++) {
      // The server's tick loop stops for 1.5 s and then carries on from the same tick.
      if ((i < 60 || i >= 150) && ++k % 2 === 0) h.snap(k, tanks);
      if (i === 160) h.input = { bits: Input.Fwd, steer: 0 };
      const tick = h.frame()!.tick;
      if (i === 160) expect(h.inputs().at(-1)).toMatchObject({ b: Input.Fwd });
      stalled = tick > last ? 0 : stalled + 1;
      longest = Math.max(longest, stalled);
      last = tick;
      h.wait(TICK_MS);
    }
    expect(longest).toBeLessThanOrEqual(MAX_STALL_TICKS);
    h.session.close();
  });

  it('shows the effects of a snapshot that came in late on a jittery link', () => {
    const h = joined([player('me', 0), player('a', 1)]);
    const tanks = [tank(0, 50, 50), tank(1, 300, 150)];
    for (let k = 102; k <= 130; k += 2) {
      h.snap(k, tanks);
      h.frame();
      h.wait(2 * TICK_MS);
    }
    // Tick 132 is held up 200 ms by a lost packet.
    h.wait(200);
    h.snap(132, tanks, [encodeEvent({ e: Ev.Boom, x: 100, y: 100, r: 20, kind: Weapon.Frag })]);
    h.frame();
    expect(h.events).toContainEqual(expect.objectContaining({ e: Ev.Boom }));
    h.session.close();
  });
});
