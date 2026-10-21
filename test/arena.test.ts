import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CLOSE, PROTOCOL_VERSION } from '../src/shared/constants';
import { decodeTank, type MatchMsg, type RoomMsg, type ServerMsg, type SnapMsg, type WelcomeMsg } from '../src/shared/protocol';
import { Input } from '../src/shared/types';
import type { LobbySnapshot } from '../src/worker/lobby';

interface Client {
  ws: WebSocket;
  messages: ServerMsg[];
  closed: Promise<CloseEvent>;
  until<T extends ServerMsg>(match: (m: ServerMsg) => m is T, timeoutMs?: number): Promise<T>;
  send(msg: object | string): void;
}

const url = (code: string, v: string | number = PROTOCOL_VERSION) => `https://tanktangle.test/api/room/${code}/ws?v=${v}`;

async function connect(code: string, v: string | number = PROTOCOL_VERSION): Promise<Client> {
  const res = await exports.default.fetch(url(code, v), { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data !== 'pong') messages.push(JSON.parse(e.data) as ServerMsg);
    for (const l of listeners) l();
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve));
  return {
    ws,
    messages,
    closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    until<T extends ServerMsg>(match: (m: ServerMsg) => m is T, timeoutMs = 5000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          const found = messages.findLast(match);
          if (!found) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out. Got: ${messages.map((m) => m.t).join(',')}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
    },
  };
}

const isRoom =
  (pred: (m: RoomMsg) => boolean = () => true) =>
  (m: ServerMsg): m is RoomMsg =>
    m.t === 'room' && pred(m);
const isWelcome = (m: ServerMsg): m is WelcomeMsg => m.t === 'welcome';
const isMatch = (m: ServerMsg): m is MatchMsg => m.t === 'match';
const snapWhere =
  (pred: (m: SnapMsg) => boolean) =>
  (m: ServerMsg): m is SnapMsg =>
    m.t === 's' && pred(m);
const tankIn = (snap: SnapMsg, seat: number) => {
  const row = snap.T.find((r) => r[0] === seat);
  return row ? decodeTank(row, snap.k) : null;
};

describe('Worker routing', () => {
  it('rejects bad requests before they reach a Durable Object', async () => {
    expect((await exports.default.fetch(url('ABCDE'))).status).toBe(426);
    expect((await exports.default.fetch(url('ABCDE'), { method: 'POST' })).status).toBe(405);
    expect((await exports.default.fetch(url('nope!'), { headers: { Upgrade: 'websocket' } })).status).toBe(400);
    const cross = await exports.default.fetch(url('ABCDE'), { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    const missing = await exports.default.fetch('https://tanktangle.test/api/other');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('tells clients on an old protocol version to reload', async () => {
    const c = await connect('ABCDE', 0);
    expect((await c.closed).code).toBe(CLOSE.outdated);
  });
});

describe('Arena Durable Object', () => {
  it('runs a lobby and a match over real WebSockets, at 60 ticks a second, with inputs that drive the tank', async () => {
    const host = await connect('HKY23');
    host.send({ t: 'hello', pid: 'host-player-token-1', name: 'Host' });
    await host.until(isRoom((m) => m.players.length === 1));

    const guest = await connect('HKY23');
    guest.send('not json');
    guest.send({ t: 'start' });
    guest.send({ t: 'hello', pid: 'bad pid', name: 'Nope' });
    guest.send({ t: 'hello', pid: 'guest-player-token-1', name: '  Guest\u0000  ' });
    const both = await guest.until(isRoom((m) => m.players.length === 2));
    expect(both.players.map((p) => [p.name, p.seat])).toEqual([
      ['Host', 0],
      ['Guest', 1],
    ]);
    expect(both.host).toBe(both.players[0]!.id);

    guest.send({ t: 'settings', s: { lives: 9 } });
    host.send({ t: 'settings', s: { mode: 'timed', minutes: 2, powerups: 0, junk: 1 } });
    const changed = await guest.until(isRoom((m) => m.settings.mode === 'timed'));
    expect(changed.settings).toMatchObject({ lives: 3, minutes: 2, powerups: 0 });

    const snaps: { k: number; at: number }[] = [];
    guest.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data as string) as ServerMsg;
      if (m.t === 's') snaps.push({ k: m.k, at: Date.now() });
    });
    host.send({ t: 'start' });
    const match = await guest.until(isMatch);
    expect(match).toMatchObject({ id: 1, k: 0, playAt: 180 });
    expect(match.walls.length).toBe(match.hp.length);
    await guest.until(isRoom((m) => m.phase === 'playing'), 6000);
    const first = snaps[0]!;
    const last = snaps.at(-1)!;
    const hz = ((last.k - first.k) * 1000) / (last.at - first.at);
    expect(hz).toBeGreaterThan(57);
    expect(hz).toBeLessThan(63);

    const now = await guest.until(snapWhere((s) => s.k > match.playAt));
    const start = tankIn(now, 1)!.tank;
    guest.send({ t: 'in', s: 1, k: now.k + 3, b: Input.Fwd, d: 0 });
    const moved = await guest.until(
      snapWhere((s) => {
        const t = tankIn(s, 1);
        return !!t && t.ack.seq === 1 && Math.hypot(t.tank.x - start.x, t.tank.y - start.y) > 10;
      }),
    );
    expect(tankIn(moved, 1)!.tank.bits).toBe(Input.Fwd);

    host.ws.close(CLOSE.left);
    guest.ws.close(CLOSE.left);
  }, 20000);

  it('hands the seat back to a player who reloads mid-match, who can drive again from seq 1', async () => {
    const host = await connect('RJN45');
    host.send({ t: 'hello', pid: 'rejoin-host-token-1', name: 'Host' });
    await host.until(isRoom((m) => m.players.length === 1));
    const a = await connect('RJN45');
    a.send({ t: 'hello', pid: 'rejoin-player-token', name: 'Ann' });
    const first = await a.until(isWelcome);
    await host.until(isRoom((m) => m.players.length === 2));
    host.send({ t: 'start' });
    await a.until(isRoom((m) => m.phase === 'playing'), 6000);
    const before = await a.until(snapWhere(() => true));
    a.send({ t: 'in', s: 7, k: before.k + 3, b: Input.Left, d: 0 });
    await a.until(snapWhere((s) => tankIn(s, 1)?.ack.seq === 7));

    const b = await connect('RJN45');
    b.send({ t: 'hello', pid: 'rejoin-player-token', name: 'Ann' });
    const second = await b.until(isWelcome);
    expect(second.id).toBe(first.id);
    expect((await a.closed).code).toBe(CLOSE.replaced);
    const rejoined = await b.until(isMatch);
    expect(rejoined.id).toBe(1);
    expect(rejoined.k).toBeGreaterThan(before.k);
    const reset = await b.until(snapWhere((s) => tankIn(s, 1)?.ack.seq === 0));
    const at = tankIn(reset, 1)!.tank;
    b.send({ t: 'in', s: 1, k: reset.k + 3, b: Input.Fwd, d: 0 });
    await b.until(
      snapWhere((s) => {
        const t = tankIn(s, 1);
        return !!t && t.ack.seq === 1 && Math.hypot(t.tank.x - at.x, t.tank.y - at.y) > 10;
      }),
    );
    expect(b.messages.filter(isRoom()).at(-1)!.players[1]).toMatchObject({ id: first.id, seat: 1, connected: true });
    host.ws.close(CLOSE.left);
    b.ws.close(CLOSE.left);
  }, 20000);

  it('tells open sockets the match is gone after the object restarts mid-match', async () => {
    const host = await connect('SNPPY');
    host.send({ t: 'hello', pid: 'sleepy-host-token-1', name: 'Host' });
    await host.until(isRoom((m) => m.players.length === 1));
    host.send({ t: 'addBot', level: 'easy' });
    await host.until(isRoom((m) => m.players.length === 2));

    // A live match keeps a tick timer that blocks test eviction, so save the state a restart would find mid-match.
    const stub = env.ARENA.getByName('SNPPY');
    await runInDurableObject(stub, (_arena, state) => {
      const saved = state.storage.kv.get<LobbySnapshot>('lobby')!;
      state.storage.kv.put('lobby', { ...saved, phase: 'playing', matchId: 1 });
    });
    await evictDurableObject(stub);
    host.messages.length = 0;
    host.send({ t: 'team', team: 1 });
    const back = await host.until(isRoom((m) => m.phase === 'lobby'));
    expect(back.players.map((p) => p.seat)).toEqual([0, 1]);
    host.ws.close(CLOSE.left);
  });
});
