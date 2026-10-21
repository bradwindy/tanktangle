import { CLOSE, KEEPALIVE_MS, PROTOCOL_VERSION } from '../shared/constants';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

/** replaced, outdated and full are final: the socket is not reopened. */
export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'outdated' | 'full';

const FINAL: Record<number, NetStatus> = {
  [CLOSE.replaced]: 'replaced',
  [CLOSE.outdated]: 'outdated',
  [CLOSE.full]: 'full',
};

export interface NetHooks {
  /** The hello to send first on every new socket. */
  hello(): ClientMsg;
  /** A socket just opened and sent its hello. */
  opened(): void;
  message(msg: ServerMsg): void;
  status(status: NetStatus): void;
}

/** One room's WebSocket: hello on open, a keepalive ping, and reconnects with backoff. */
export class Net {
  status: NetStatus = 'connecting';
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private code: string,
    private hooks: NetHooks,
  ) {}

  connect(): void {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/room/${this.code}/ws?v=${PROTOCOL_VERSION}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      ws.send(JSON.stringify(this.hooks.hello()));
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, KEEPALIVE_MS);
      this.setStatus('open');
      this.hooks.opened();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        console.error(JSON.stringify({ event: 'bad_server_message' }));
        return;
      }
      this.hooks.message(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopKeepalive();
      if (this.stopped) return;
      const final = FINAL[ev.code];
      if (final) {
        this.stopped = true;
        this.setStatus(final);
        return;
      }
      this.scheduleRetry();
    };
  }

  /** Sends when the socket is open. Returns whether it went out. */
  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Drops the current socket and dials again straight away (the server went quiet). */
  reconnect(): void {
    if (this.stopped) return;
    const ws = this.ws;
    this.ws = null;
    this.stopKeepalive();
    ws?.close();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.setStatus('reconnecting');
    this.connect();
  }

  /** Leaves the room for good. */
  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopKeepalive();
    const ws = this.ws;
    this.ws = null;
    ws?.close(CLOSE.left, 'Left the room');
  }

  private scheduleRetry(): void {
    this.setStatus('reconnecting');
    const delay = Math.min(4000, 250 * 2 ** this.attempts++);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private setStatus(status: NetStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.hooks.status(status);
  }
}
