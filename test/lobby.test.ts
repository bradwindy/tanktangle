import { describe, expect, it } from 'vitest';
import { COUNTDOWN_TICKS, LOBBY_GRACE_MS, MAX_SEATS, RECONNECT_GRACE_MS, TICK_MS } from '../src/shared/constants';
import type { RoomMsg, ServerMsg, SnapMsg } from '../src/shared/protocol';
import { Input } from '../src/shared/types';
import { Lobby } from '../src/worker/lobby';

function makeLobby() {
  const sent: { to: string; msg: ServerMsg }[] = [];
  let ids = 0;
  let seed = 1;
  const clock = { now: 1_000_000 };
  const lobby = new Lobby({
    send: (pid, msg) => sent.push({ to: pid, msg }),
    broadcast: (msg) => sent.push({ to: '*', msg }),
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
    newId: () => `id${ids++}`,
    now: () => clock.now,
  });
  const rooms = () => sent.filter((s): s is { to: string; msg: RoomMsg } => s.msg.t === 'room').map((s) => s.msg);
  const lastRoom = () => rooms().at(-1)!;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.now += TICK_MS;
      lobby.tick();
    }
  };
  const join = (...names: string[]) => names.forEach((n) => lobby.join(`pid-${n}`, n));
  const seats = () => lastRoom().players.map((p) => `${p.name}:${p.seat}`);
  return { lobby, sent, clock, rooms, lastRoom, tick, join, seats };
}

describe('seating', () => {
  it('seats people in join order with the lowest free colour, and benches anyone past 12 seats', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a', 'b', 'c');
    lobby.leave('pid-b', true);
    join('d');
    expect(lastRoom().players.map((p) => [p.name, p.seat, p.color])).toEqual([
      ['a', 0, 0],
      ['c', 1, 2],
      ['d', 2, 1],
    ]);
    for (let i = 0; i < MAX_SEATS; i++) join(`x${i}`);
    expect(lastRoom().players.filter((p) => p.seat >= 0)).toHaveLength(MAX_SEATS);
    expect(lastRoom().players.filter((p) => p.seat < 0).map((p) => p.name)).toEqual(['x9', 'x10', 'x11']);
  });

  it('gives a person the seat of the newest bot when the lobby is full', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('host');
    for (let i = 0; i < MAX_SEATS - 1; i++) lobby.addBot('pid-host', 'easy');
    expect(lastRoom().players).toHaveLength(MAX_SEATS);
    const newest = lastRoom().players.at(-1)!;
    join('late');
    const players = lastRoom().players;
    expect(players.find((p) => p.name === 'late')!.seat).toBeGreaterThanOrEqual(0);
    expect(players.some((p) => p.id === newest.id)).toBe(false);
    const seated = players.filter((p) => p.seat >= 0);
    expect(seated).toHaveLength(MAX_SEATS);
    expect(new Set(seated.map((p) => p.color)).size).toBe(MAX_SEATS);
  });

  it('never broadcasts the secret pid', () => {
    const { sent, join } = makeLobby();
    join('a', 'b');
    expect(JSON.stringify(sent.map((s) => s.msg))).not.toContain('pid-');
  });
});

describe('colours', () => {
  const colorOf = (room: RoomMsg, name: string) => room.players.find((p) => p.name === name)!.color;
  const seatedUnique = (room: RoomMsg) => {
    const seated = room.players.filter((p) => p.seat >= 0).map((p) => p.color);
    return new Set(seated).size === seated.length;
  };

  it('lets a person take a free colour or a bot one, never another person one, and only in the lobby', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a', 'b');
    lobby.addBot('pid-a', 'easy');
    const bot = lastRoom().players.find((p) => p.bot)!;
    lobby.pickColor('pid-a', colorOf(lastRoom(), 'b'));
    expect(colorOf(lastRoom(), 'a')).toBe(0);
    lobby.pickColor('pid-a', 7);
    expect(colorOf(lastRoom(), 'a')).toBe(7);
    lobby.pickColor('pid-b', bot.color);
    expect(colorOf(lastRoom(), 'b')).toBe(bot.color);
    expect(colorOf(lastRoom(), bot.name)).not.toBe(bot.color);
    expect(seatedUnique(lastRoom())).toBe(true);
    lobby.start('pid-a');
    lobby.pickColor('pid-a', 9);
    expect(colorOf(lastRoom(), 'a')).toBe(7);
  });

  it('gives a newcomer their remembered colour, taking it from a bot but not from a person', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a');
    lobby.addBot('pid-a', 'normal');
    const botColor = lastRoom().players.find((p) => p.bot)!.color;
    lobby.join('pid-b', 'b', botColor);
    lobby.join('pid-c', 'c', colorOf(lastRoom(), 'a'));
    expect(colorOf(lastRoom(), 'b')).toBe(botColor);
    expect(colorOf(lastRoom(), 'c')).not.toBe(colorOf(lastRoom(), 'a'));
    expect(seatedUnique(lastRoom())).toBe(true);
  });
});

describe('host', () => {
  it('keeps the host through a reconnect grace, then hands over', () => {
    const { lobby, join, lastRoom, clock } = makeLobby();
    join('a', 'b');
    const [a, b] = lastRoom().players;
    lobby.leave('pid-a', false);
    expect(lastRoom().host).toBe(a!.id);
    clock.now += LOBBY_GRACE_MS - 1;
    lobby.purge();
    expect(lastRoom().host).toBe(a!.id);
    clock.now += 2;
    lobby.purge();
    expect(lastRoom().host).toBe(b!.id);
    expect(lastRoom().players.map((p) => p.name)).toEqual(['b']);
  });

  it('only lets the host change settings, add bots or start, and sanitises settings', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a', 'b');
    lobby.updateSettings('pid-b', { lives: 9 });
    lobby.addBot('pid-b', 'hard');
    lobby.start('pid-b');
    expect(lastRoom()).toMatchObject({ phase: 'lobby', settings: { lives: 3 } });
    expect(lastRoom().players).toHaveLength(2);
    lobby.updateSettings('pid-a', { lives: 99, minutes: 2.5, bounces: 4, evil: true, mode: 'chaos' });
    expect(lastRoom().settings).toMatchObject({ lives: 9, minutes: 4, bounces: 4, mode: 'lives' });
    expect('evil' in lastRoom().settings).toBe(false);
    lobby.addBot('pid-a', 'genius');
    expect(lastRoom().players).toHaveLength(2);
  });
});

describe('teams', () => {
  it('balances new players and bots onto the smallest team, rebalances on a team count change, and allows switching', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a');
    lobby.updateSettings('pid-a', { teams: 3 });
    join('b', 'c');
    lobby.addBot('pid-a', 'normal');
    expect(lastRoom().players.map((p) => p.team)).toEqual([1, 2, 3, 1]);
    lobby.setTeam('pid-c', 1);
    lobby.setTeam('pid-b', 7);
    expect(lastRoom().players.map((p) => p.team)).toEqual([1, 2, 1, 1]);
    lobby.updateSettings('pid-a', { teams: 2 });
    expect(lastRoom().players.map((p) => p.team)).toEqual([1, 2, 1, 2]);
    lobby.updateSettings('pid-a', { teams: 0 });
    expect(lastRoom().players.map((p) => p.team)).toEqual([0, 0, 0, 0]);
  });

  it('sends nothing for a team or settings message that changes nothing, or a start that cannot happen', () => {
    const { lobby, join, rooms, lastRoom } = makeLobby();
    join('a', 'b');
    lobby.updateSettings('pid-a', { teams: 2 });
    lobby.setTeam('pid-b', 1);
    const before = rooms().length;
    lobby.setTeam('pid-b', 1);
    lobby.updateSettings('pid-a', { teams: 2, lives: lastRoom().settings.lives });
    lobby.start('pid-a');
    expect(rooms()).toHaveLength(before);
  });

  it('will not start a team game with everyone on one team', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a', 'b');
    lobby.updateSettings('pid-a', { teams: 2 });
    lobby.setTeam('pid-b', 1);
    expect(lobby.startProblem()).toMatch(/teams/);
    lobby.start('pid-a');
    expect(lastRoom().phase).toBe('lobby');
    lobby.setTeam('pid-b', 2);
    lobby.start('pid-a');
    expect(lastRoom().phase).toBe('countdown');
  });
});

describe('matches', () => {
  it('needs two tanks, then counts down, plays and sends snapshots', () => {
    const { lobby, join, lastRoom, sent, tick } = makeLobby();
    join('a');
    lobby.start('pid-a');
    expect(lastRoom().phase).toBe('lobby');
    lobby.addBot('pid-a', 'easy');
    lobby.start('pid-a');
    expect(lastRoom().phase).toBe('countdown');
    expect(sent.at(-1)!.msg).toMatchObject({ t: 'match', id: 1, k: 0, playAt: COUNTDOWN_TICKS });
    tick(COUNTDOWN_TICKS);
    expect(lastRoom().phase).toBe('playing');
    const snaps = sent.filter((s) => s.msg.t === 's').map((s) => s.msg as SnapMsg);
    expect(snaps.length).toBe(COUNTDOWN_TICKS / 2);
    expect(snaps.at(-1)!.T).toHaveLength(2);
  });

  it('applies inputs, and a reconnect keeps the seat and can drive again from seq 1', () => {
    const { lobby, join, sent, tick, lastRoom } = makeLobby();
    join('a', 'b');
    lobby.start('pid-a');
    tick(COUNTDOWN_TICKS);
    const match = lobby.match!;
    lobby.input('pid-b', { s: 50, k: match.k + 1, b: Input.Fwd, d: 0 });
    lobby.input('pid-b', { s: 51, k: 'soon', b: 0, d: 0 });
    tick();
    expect(match.tanks[1]!.bits).toBe(Input.Fwd);
    lobby.leave('pid-b', false);
    expect(match.tanks[1]!.bits).toBe(0);
    const before = lastRoom().players[1]!;
    sent.length = 0;
    lobby.join('pid-b', 'b');
    expect(sent.filter((s) => s.to === 'pid-b').map((s) => s.msg.t)).toEqual(['welcome', 'match']);
    expect(lastRoom().players[1]).toMatchObject({ id: before.id, seat: 1, connected: true });
    lobby.input('pid-b', { s: 1, k: match.k + 1, b: Input.Left, d: 0 });
    tick();
    expect(match.tanks[1]!.bits).toBe(Input.Left);
    expect(match.seats[1]!.ack.seq).toBe(1);
  });

  it('benches a late joiner as a spectator, then seats them over the newest bot on play again', () => {
    const { lobby, join, sent, lastRoom } = makeLobby();
    join('host');
    for (let i = 0; i < MAX_SEATS - 1; i++) lobby.addBot('pid-host', 'easy');
    const newestBot = lastRoom().players.at(-1)!;
    lobby.start('pid-host');
    sent.length = 0;
    join('late');
    expect(sent.filter((s) => s.to === 'pid-late').map((s) => s.msg.t)).toEqual(['welcome', 'match']);
    expect(lastRoom().players.find((p) => p.name === 'late')!.seat).toBe(-1);
    // Every tank but the last bot leaves, so the match ends when play starts.
    for (let seat = 0; seat < MAX_SEATS - 1; seat++) lobby.match!.removeSeat(seat);
    for (let i = 0; i <= COUNTDOWN_TICKS && lobby.match; i++) lobby.tick();
    expect(lastRoom().phase).toBe('over');
    lobby.again('pid-host');
    const room = lastRoom();
    expect(room.phase).toBe('lobby');
    expect(room.players.find((p) => p.name === 'late')!.seat).toBe(0);
    expect(room.players.some((p) => p.id === newestBot.id)).toBe(false);
    const seated = room.players.filter((p) => p.seat >= 0);
    expect(seated).toHaveLength(MAX_SEATS);
    expect(new Set(seated.map((p) => p.color)).size).toBe(MAX_SEATS);
  });

  it('drops a seated player whose grace runs out, and flushes the last snapshot before the result', () => {
    const { lobby, join, sent, tick, clock } = makeLobby();
    join('a', 'b');
    lobby.start('pid-a');
    tick(COUNTDOWN_TICKS + 1);
    lobby.leave('pid-b', false);
    clock.now += RECONNECT_GRACE_MS;
    sent.length = 0;
    tick();
    const order = sent.map((s) => s.msg.t);
    expect(order.slice(-2)).toEqual(['s', 'room']);
    const over = sent.at(-1)!.msg as RoomMsg;
    expect(over.phase).toBe('over');
    expect(over.result).toMatchObject({ draw: false, winners: [over.players[0]!.id] });
    expect(over.players[1]).toMatchObject({ out: true, seat: 1 });
  });

  it('copies kills, deaths and lives into the room message, at most every few ticks', () => {
    const { lobby, join, rooms, lastRoom, tick } = makeLobby();
    join('a', 'b');
    lobby.start('pid-a');
    tick(COUNTDOWN_TICKS + 1);
    const m = lobby.match!;
    const before = rooms().length;
    for (let i = 0; i < 12; i++) {
      m.seats[1]!.score.deaths = i + 1;
      m.seats[1]!.score.lives = 2;
      m.seats[0]!.score.kills = i + 1;
      m.version++;
      tick();
    }
    expect(rooms().length - before).toBe(2);
    tick(6);
    expect(lastRoom().players.map((p) => [p.kills, p.deaths, p.lives])).toEqual([
      [12, 0, 3],
      [0, 12, 2],
    ]);
  });
});

describe('restarts and empty rooms', () => {
  it('falls back to the lobby when a restart cuts a match short, and keeps finished results', () => {
    const a = makeLobby();
    a.join('a', 'b');
    a.lobby.start('pid-a');
    const snap = JSON.parse(JSON.stringify(a.lobby.snapshot()));
    const b = makeLobby();
    expect(b.lobby.restore(snap, new Set(['pid-a']))).toBe(true);
    expect(b.lobby.phase).toBe('lobby');
    expect(b.lobby.players.map((p) => [p.name, p.seat, p.connected])).toEqual([
      ['a', 0, true],
      ['b', 1, false],
    ]);
    expect(b.lobby.nextPurgeAt()).toBe(b.clock.now + LOBBY_GRACE_MS);

    const over = { ...snap, phase: 'over' as const, result: { draw: true, winners: [], team: 0, standings: [], awards: [] } };
    const c = makeLobby();
    expect(c.lobby.restore(over, new Set(['pid-a']))).toBe(false);
    expect(c.lobby.roomMsg()).toMatchObject({ phase: 'over', result: { draw: true } });
  });

  it('moves bots saved before the Expert level up one level, and keeps newer saves as they are', () => {
    const a = makeLobby();
    a.join('a');
    for (const level of ['easy', 'normal', 'hard'] as const) a.lobby.addBot('pid-a', level);
    const snap = JSON.parse(JSON.stringify(a.lobby.snapshot()));
    const levels = (l: Lobby) => l.players.filter((p) => p.bot).map((p) => p.bot);
    const old = makeLobby();
    old.lobby.restore({ ...snap, botLevels: undefined }, new Set(['pid-a']));
    expect(levels(old.lobby)).toEqual(['normal', 'hard', 'expert']);
    const current = makeLobby();
    current.lobby.restore(snap, new Set(['pid-a']));
    expect(levels(current.lobby)).toEqual(['easy', 'normal', 'hard']);
  });

  it('wipes the room once nobody is connected or coming back', () => {
    const { lobby, join, clock } = makeLobby();
    join('a');
    lobby.addBot('pid-a', 'easy');
    lobby.leave('pid-a', false);
    expect(lobby.players).toHaveLength(2);
    clock.now += LOBBY_GRACE_MS;
    lobby.purge();
    expect(lobby.players).toEqual([]);
  });

  it('turns new people away once the room holds as many as it can', () => {
    const { lobby } = makeLobby();
    for (let i = 0; i < 24; i++) expect(lobby.join(`pid-${i}`, `p${i}`)).toBe(true);
    expect(lobby.canJoin('pid-new')).toBe(false);
    expect(lobby.join('pid-new', 'new')).toBe(false);
    expect(lobby.canJoin('pid-3')).toBe(true);
  });
});

describe('start and play again', () => {
  it('keep someone inside their reconnect grace, who comes back to the same id and seat', () => {
    const { lobby, join, lastRoom } = makeLobby();
    join('a', 'b', 'c');
    const b = lastRoom().players[1]!;
    lobby.leave('pid-b', false);
    lobby.start('pid-a');
    expect(lobby.match!.seats).toHaveLength(3);
    lobby.join('pid-b', 'b');
    expect(lastRoom().players[1]).toMatchObject({ id: b.id, seat: 1, connected: true });

    lobby.match!.removeSeat(1);
    lobby.match!.removeSeat(2);
    for (let i = 0; i <= COUNTDOWN_TICKS && lobby.match; i++) lobby.tick();
    expect(lastRoom().phase).toBe('over');
    lobby.leave('pid-b', false);
    lobby.again('pid-a');
    expect(lastRoom().players.find((p) => p.name === 'b')).toMatchObject({ id: b.id, connected: false });
  });
});
