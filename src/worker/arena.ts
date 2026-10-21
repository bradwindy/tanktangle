import { DurableObject } from 'cloudflare:workers';
import { CLOSE, MAX_CONNECTIONS, MAX_MESSAGE_BYTES, RATE_LIMIT_PER_SEC, TICK_HZ } from '../shared/constants';
import { sanitizeName, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { Lobby, type LobbySnapshot } from './lobby';

interface Attachment {
  pid: string;
}

interface Bucket {
  tokens: number;
  at: number;
}

const PID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SNAPSHOT_KEY = 'lobby';
const STALL_MS = 1000;
const MAX_CATCH_UP = 4;
/** Open sockets allowed at once, with room for reloads that overlap their old socket. */
const MAX_SOCKETS = MAX_CONNECTIONS * 2;

const log = (event: string, err: unknown) => console.error(JSON.stringify({ event, error: String(err) }));

/** One Durable Object per room code. Uses the WebSocket Hibernation API so an idle lobby costs nothing. */
export class Arena extends DurableObject<Env> {
  private lobby: Lobby;
  private sockets = new Map<string, WebSocket>();
  private loop: ReturnType<typeof setTimeout> | null = null;
  private loopStart = 0;
  private ticksRun = 0;
  private lastTickAt = 0;
  private purgeTimer: ReturnType<typeof setTimeout> | null = null;
  private buckets = new WeakMap<WebSocket, Bucket>();
  private saved = '';
  /** A match was cut short by a restart while sockets stayed open. Tell them on the next message. */
  private announceRestore = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lobby = new Lobby({
      send: (pid, msg) => this.send(this.sockets.get(pid), msg),
      broadcast: (msg) => {
        const data = JSON.stringify(msg);
        for (const ws of this.sockets.values()) this.sendRaw(ws, data);
      },
      random: Math.random,
      newId: () => crypto.randomUUID().slice(0, 8),
      now: Date.now,
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.pid && ws.readyState === WebSocket.OPEN) this.sockets.set(att.pid, ws);
    }
    const snap = ctx.storage.kv.get<LobbySnapshot>(SNAPSHOT_KEY);
    if (snap) {
      this.announceRestore = this.lobby.restore(snap, new Set(this.sockets.keys())) && this.sockets.size > 0;
      this.schedulePurge();
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      server.accept();
      server.close(CLOSE.full, 'Room is full');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES || !this.allow(ws)) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message) as ClientMsg;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    this.watchdog();
    if (this.announceRestore) {
      this.announceRestore = false;
      this.lobby.broadcastRoom();
    }
    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;

    if (msg.t === 'hello') {
      if (pid || typeof msg.pid !== 'string' || !PID_RE.test(msg.pid)) return;
      if (!this.lobby.canJoin(msg.pid)) {
        this.closeQuietly(ws, CLOSE.full, 'Room is full');
        return;
      }
      const previous = this.sockets.get(msg.pid);
      ws.serializeAttachment({ pid: msg.pid } satisfies Attachment);
      this.sockets.set(msg.pid, ws);
      if (previous && previous !== ws) this.closeQuietly(previous, CLOSE.replaced, 'Opened in another tab');
      this.lobby.join(msg.pid, sanitizeName(msg.name) || 'Player');
      await this.afterChange();
      return;
    }
    if (!pid || this.sockets.get(pid) !== ws) return;

    switch (msg.t) {
      case 'in':
        // Inputs change nothing that is saved, so they skip the storage check.
        this.lobby.input(pid, msg);
        return;
      case 'settings':
        this.lobby.updateSettings(pid, msg.s);
        break;
      case 'start':
        this.lobby.start(pid);
        break;
      case 'again':
        this.lobby.again(pid);
        break;
      case 'addBot':
        this.lobby.addBot(pid, msg.level);
        break;
      case 'removeBot':
        this.lobby.removeBot(pid, msg.id);
        break;
      case 'team':
        this.lobby.setTeam(pid, msg.team);
        break;
      default:
        return;
    }
    await this.afterChange();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.disconnect(ws, code === CLOSE.left);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnect(ws, false);
  }

  private async disconnect(ws: WebSocket, quit: boolean): Promise<void> {
    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;
    if (!pid) return;
    // After waking from hibernation the closing socket is no longer listed, so a missing entry still counts.
    const current = this.sockets.get(pid);
    if (current && current !== ws) return;
    this.sockets.delete(pid);
    this.lobby.leave(pid, quit);
    await this.afterChange();
  }

  /** Token bucket per socket. Messages over the rate are dropped. */
  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b) {
      b = { tokens: RATE_LIMIT_PER_SEC, at: now };
      this.buckets.set(ws, b);
    }
    b.tokens = Math.min(RATE_LIMIT_PER_SEC, b.tokens + ((now - b.at) * RATE_LIMIT_PER_SEC) / 1000);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  /** Persists lobby-level state when it changed, and starts or stops the timers. Never runs inside a tick. */
  private async afterChange(): Promise<void> {
    if (this.lobby.players.length === 0) {
      this.stopLoop();
      this.clearPurge();
      this.saved = '';
      await this.ctx.storage.deleteAll();
      return;
    }
    // Skip no-op writes: ignored messages must not cost a row write each.
    const snap = this.lobby.snapshot();
    const json = JSON.stringify(snap);
    if (json !== this.saved) {
      this.ctx.storage.kv.put(SNAPSHOT_KEY, snap);
      this.saved = json;
    }
    if (this.lobby.inMatch) {
      this.clearPurge();
      this.startLoop();
    } else {
      this.stopLoop();
      this.schedulePurge();
    }
  }

  /** Outside a match there is no tick, so a one-shot timer ends the grace of anyone who left. */
  private schedulePurge(): void {
    const at = this.lobby.nextPurgeAt();
    if (this.purgeTimer || at === null) return;
    this.purgeTimer = setTimeout(
      () => {
        this.purgeTimer = null;
        this.lobby.purge();
        this.afterChange().catch((err) => log('purge_failed', err));
      },
      Math.max(0, at - Date.now()) + 50,
    );
  }

  private clearPurge(): void {
    if (!this.purgeTimer) return;
    clearTimeout(this.purgeTimer);
    this.purgeTimer = null;
  }

  private startLoop(): void {
    if (this.loop) return;
    this.lastTickAt = this.loopStart = Date.now();
    this.ticksRun = 0;
    this.scheduleTicks();
  }

  /** Aims each timer at the next tick boundary, so ticks follow the wall clock however the runtime rounds delays. */
  private scheduleTicks(): void {
    const next = this.loopStart + ((this.ticksRun + 1) * 1000) / TICK_HZ;
    this.loop = setTimeout(() => this.runTicks(), Math.max(0, Math.ceil(next - Date.now())));
  }

  private runTicks(): void {
    const now = Date.now();
    this.lastTickAt = now;
    const due = Math.floor(((now - this.loopStart) * TICK_HZ) / 1000);
    this.ticksRun = Math.max(this.ticksRun, due - MAX_CATCH_UP);
    try {
      while (this.ticksRun < due && this.lobby.inMatch) {
        this.ticksRun++;
        this.lobby.tick();
      }
    } catch (err) {
      log('tick_failed', err);
    }
    if (this.lobby.inMatch) {
      this.scheduleTicks();
      return;
    }
    this.loop = null;
    this.afterChange().catch((err) => log('match_end_failed', err));
  }

  private stopLoop(): void {
    if (!this.loop) return;
    clearTimeout(this.loop);
    this.loop = null;
  }

  /** The runtime can stop running the tick timer when the object runs out of CPU budget. Restart it if ticks stalled. */
  private watchdog(): void {
    if (this.loop && this.lobby.inMatch && Date.now() - this.lastTickAt > STALL_MS) {
      console.warn(JSON.stringify({ event: 'tick_stall_restart', stalledMs: Date.now() - this.lastTickAt }));
      this.stopLoop();
      this.startLoop();
    }
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  private send(ws: WebSocket | undefined, msg: ServerMsg): void {
    if (ws) this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // The socket is closing. webSocketClose cleans up.
    }
  }
}
