import { LOBBY_GRACE_MS, MAX_CONNECTIONS, MAX_SEATS, PALETTE, RECONNECT_GRACE_MS } from '../shared/constants';
import type { MatchResult, Phase, PublicPlayer, RoomMsg, ServerMsg } from '../shared/protocol';
import { mulberry32 } from '../shared/rng';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/settings';
import { BOT_LEVELS, type BotLevel } from '../shared/types';
import { BOT_NAMES } from './bot';
import { Match } from './match';

export interface LobbyIO {
  send(pid: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  random(): number;
  newId(): string;
  now(): number;
}

export interface Player {
  /** Secret reconnect token. Never broadcast. */
  pid: string;
  id: string;
  name: string;
  color: number;
  seat: number;
  team: number;
  bot: BotLevel | null;
  connected: boolean;
  /** When the socket dropped (ms), or -1 while connected or once the grace is spent. */
  goneAt: number;
  kills: number;
  deaths: number;
  lives: number;
  out: boolean;
}

export interface LobbySnapshot {
  phase: Phase;
  settings: Settings;
  host: string;
  players: Player[];
  result: MatchResult | null;
  overtime: boolean;
  matchId: number;
}

/** Score updates during a match go out at most this often (ticks), about 10 a second. */
const ROOM_EVERY_TICKS = 6;
const MIN_TANKS = 2;

/**
 * One room's people and phases, independent of Durable Object plumbing.
 * Phases: lobby -> countdown -> playing -> over -> (again) -> lobby. The match itself lives in Match.
 */
export class Lobby {
  phase: Phase = 'lobby';
  settings: Settings = { ...DEFAULT_SETTINGS };
  players: Player[] = [];
  /** Host pid. */
  host = '';
  result: MatchResult | null = null;
  overtime = false;
  match: Match | null = null;

  private matchId = 0;
  private scoreVersion = -1;
  private roomDirty = false;
  private roomSentAt = 0;

  constructor(private readonly io: LobbyIO) {}

  get inMatch(): boolean {
    return this.phase === 'countdown' || this.phase === 'playing';
  }

  snapshot(): LobbySnapshot {
    return {
      phase: this.phase,
      settings: this.settings,
      host: this.host,
      players: this.players,
      result: this.result,
      overtime: this.overtime,
      matchId: this.matchId,
    };
  }

  /**
   * Rebuilds after the Durable Object restarts. A match cannot survive that, so it falls back to the lobby
   * (a finished match keeps its results). Players without a live socket get a fresh grace.
   * Returns true when a match was cut short.
   */
  restore(snap: LobbySnapshot, livePids: ReadonlySet<string>): boolean {
    const now = this.io.now();
    this.settings = sanitizeSettings(snap.settings);
    this.players = snap.players.map((p) => {
      const connected = p.bot !== null || livePids.has(p.pid);
      return { ...p, connected, goneAt: connected ? -1 : now };
    });
    this.host = snap.host;
    this.matchId = snap.matchId;
    this.result = snap.result;
    this.overtime = snap.overtime;
    const cut = snap.phase === 'countdown' || snap.phase === 'playing';
    this.phase = snap.phase === 'over' ? 'over' : 'lobby';
    if (this.phase === 'lobby') this.resetForLobby();
    this.ensureHost();
    return cut;
  }

  private find(pid: string): Player | undefined {
    return this.players.find((p) => p.pid === pid);
  }

  private publicPlayer(p: Player): PublicPlayer {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      seat: p.seat,
      team: p.team,
      bot: p.bot,
      connected: p.connected,
      kills: p.kills,
      deaths: p.deaths,
      lives: p.lives,
      out: p.out,
    };
  }

  roomMsg(): RoomMsg {
    return {
      t: 'room',
      phase: this.phase,
      host: this.find(this.host)?.id ?? '',
      settings: this.settings,
      players: this.players.map((p) => this.publicPlayer(p)),
      overtime: this.overtime,
      result: this.result,
    };
  }

  broadcastRoom(): void {
    this.roomDirty = false;
    this.roomSentAt = this.match?.k ?? 0;
    this.io.broadcast(this.roomMsg());
  }

  // -------------------------------------------------------------------------------------------
  // People

  /** Whether a hello with this pid would fit in the room. */
  canJoin(pid: string): boolean {
    return !!this.find(pid) || this.players.length < MAX_CONNECTIONS;
  }

  /** A socket said hello: a new player, or someone coming back to their seat. */
  join(pid: string, name: string): boolean {
    let p = this.find(pid);
    if (p) {
      p.connected = true;
      p.goneAt = -1;
      p.name = name;
      if (this.match && p.seat >= 0) this.match.resetInput(p.seat);
    } else {
      if (this.players.length >= MAX_CONNECTIONS) return false;
      p = this.addPlayer(pid, name, null);
    }
    this.ensureHost();
    this.io.send(pid, { t: 'welcome', id: p.id });
    this.broadcastRoom();
    if (this.match) this.io.send(pid, this.match.matchMsg());
    return true;
  }

  /** A socket closed. A dropped connection keeps its place for a grace period; pressing Leave (quit) drops at once. */
  leave(pid: string, quit: boolean): void {
    const p = this.find(pid);
    if (!p) return;
    p.connected = false;
    p.goneAt = this.io.now();
    if (this.match && p.seat >= 0) this.match.releaseInput(p.seat);
    if (quit) this.drop(p);
    this.ensureHost();
    if (this.wipeIfEmpty()) return;
    if (this.phase === 'lobby') this.reseat();
    this.broadcastRoom();
  }

  /** Spends the grace of anyone who has not come back. Returns true if anything changed. */
  purge(): boolean {
    const now = this.io.now();
    const grace = this.inMatch ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS;
    const gone = this.players.filter((p) => !p.connected && p.goneAt >= 0 && now - p.goneAt >= grace);
    if (gone.length === 0) return false;
    for (const p of gone) this.drop(p);
    if (this.wipeIfEmpty()) return true;
    if (this.phase === 'lobby') this.reseat();
    this.ensureHost();
    this.broadcastRoom();
    return true;
  }

  /** The earliest time purge() could change something, or null. */
  nextPurgeAt(): number | null {
    const grace = this.inMatch ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS;
    const times = this.players.filter((p) => !p.connected && p.goneAt >= 0).map((p) => p.goneAt + grace);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** Removes a player whose grace is spent. Seated players stay listed until the next lobby so results still read. */
  private drop(p: Player): void {
    p.goneAt = -1;
    if (this.match && p.seat >= 0) {
      this.match.removeSeat(p.seat);
      p.out = true;
    } else if (!(this.phase === 'over' && p.seat >= 0)) {
      this.players = this.players.filter((q) => q !== p);
    }
  }

  /** Forgets everything once no person is connected or about to come back. */
  private wipeIfEmpty(): boolean {
    if (this.players.some((p) => !p.bot && (p.connected || p.goneAt >= 0))) return false;
    this.players = [];
    this.match = null;
    this.phase = 'lobby';
    this.result = null;
    this.overtime = false;
    this.host = '';
    return true;
  }

  /** Keeps the host while they are connected or inside their grace, else the first connected person takes over. */
  private ensureHost(): void {
    const host = this.find(this.host);
    if (host && !host.bot && (host.connected || host.goneAt >= 0)) return;
    this.host = this.players.find((p) => p.connected && !p.bot)?.pid ?? '';
  }

  private addPlayer(pid: string, name: string, bot: BotLevel | null): Player {
    const used = new Set(this.players.map((q) => q.color));
    const color = PALETTE.findIndex((_, i) => !used.has(i));
    const p: Player = {
      pid,
      id: this.io.newId(),
      name,
      color: color < 0 ? this.players.length % PALETTE.length : color,
      seat: -1,
      team: 0,
      bot,
      connected: true,
      goneAt: -1,
      kills: 0,
      deaths: 0,
      lives: this.settings.lives,
      out: false,
    };
    this.players.push(p);
    if (this.phase === 'lobby') this.reseat();
    return p;
  }

  /**
   * Seats people first in list order, then bots in the order they were added. People past the seat count wait on
   * the bench; bots that no longer fit are removed (the most recently added go first).
   */
  private reseat(): void {
    const people = this.players.filter((p) => !p.bot).slice(0, MAX_SEATS);
    const bots = this.players.filter((p) => p.bot).slice(0, MAX_SEATS - people.length);
    const seated = new Set([...people, ...bots]);
    this.players = this.players.filter((p) => !p.bot || seated.has(p));
    let seat = 0;
    for (const p of this.players) {
      if (seated.has(p)) {
        p.seat = seat++;
      } else {
        p.seat = -1;
        p.team = 0;
      }
    }
    this.fillTeams();
  }

  /** Puts every seated player without a valid team on the smallest team. */
  private fillTeams(): void {
    const teams = this.settings.teams;
    const seated = this.players.filter((p) => p.seat >= 0);
    if (teams === 0) {
      for (const p of seated) p.team = 0;
      return;
    }
    const counts = new Array<number>(teams + 1).fill(0);
    for (const p of seated) if (p.team >= 1 && p.team <= teams) counts[p.team]!++;
    for (const p of seated) {
      if (p.team >= 1 && p.team <= teams) continue;
      let smallest = 1;
      for (let team = 2; team <= teams; team++) if (counts[team]! < counts[smallest]!) smallest = team;
      p.team = smallest;
      counts[smallest]!++;
    }
  }

  private resetScores(): void {
    for (const p of this.players) {
      p.kills = 0;
      p.deaths = 0;
      p.lives = this.settings.lives;
      p.out = false;
    }
  }

  private resetForLobby(): void {
    this.match = null;
    this.resetScores();
    this.reseat();
  }

  // -------------------------------------------------------------------------------------------
  // Messages

  input(pid: string, msg: { s?: unknown; k?: unknown; b?: unknown; d?: unknown }): void {
    const p = this.find(pid);
    if (!this.match || !p || p.seat < 0 || p.bot) return;
    const { s, k, b, d } = msg;
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(k) || !Number.isInteger(b) || !Number.isInteger(d)) return;
    if ((s as number) <= 0) return;
    this.match.queueInput(p.seat, s as number, k as number, b as number, d as number);
  }

  updateSettings(pid: string, partial: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    const merged = { ...this.settings, ...(typeof partial === 'object' && partial !== null ? partial : {}) };
    const next = sanitizeSettings(merged, this.settings);
    const teamsChanged = next.teams !== this.settings.teams;
    this.settings = next;
    if (teamsChanged) {
      for (const p of this.players) p.team = 0;
      this.fillTeams();
    }
    for (const p of this.players) p.lives = next.lives;
    this.broadcastRoom();
  }

  setTeam(pid: string, team: unknown): void {
    const p = this.find(pid);
    if (!p || this.phase !== 'lobby' || p.seat < 0 || this.settings.teams === 0) return;
    if (!Number.isInteger(team) || (team as number) < 1 || (team as number) > this.settings.teams) return;
    p.team = team as number;
    this.broadcastRoom();
  }

  addBot(pid: string, level: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby' || !BOT_LEVELS.includes(level as BotLevel)) return;
    if (this.players.filter((p) => p.seat >= 0).length >= MAX_SEATS || this.players.length >= MAX_CONNECTIONS) return;
    const taken = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${this.players.length + 1}`;
    this.addPlayer(`bot:${this.io.newId()}`, name, level as BotLevel);
    this.broadcastRoom();
  }

  removeBot(pid: string, id: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    const bot = this.players.find((p) => p.bot && p.id === id);
    if (!bot) return;
    this.players = this.players.filter((p) => p !== bot);
    this.reseat();
    this.broadcastRoom();
  }

  /** Why the host cannot start yet, or null when they can. */
  startProblem(): string | null {
    const seated = this.players.filter((p) => p.seat >= 0 && p.connected);
    if (seated.length < MIN_TANKS) return 'Needs at least 2 tanks';
    if (this.settings.teams > 0 && new Set(seated.map((p) => p.team)).size < 2) return 'Needs players on at least 2 teams';
    return null;
  }

  start(pid: string): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    if (this.startProblem()) {
      this.broadcastRoom();
      return;
    }
    this.players = this.players.filter((p) => p.connected);
    this.reseat();
    if (this.startProblem()) {
      this.broadcastRoom();
      return;
    }
    this.resetScores();
    const seats = this.players
      .filter((p) => p.seat >= 0)
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ seat: p.seat, team: p.team, id: p.id, bot: p.bot }));
    this.matchId++;
    this.match = new Match({
      id: this.matchId,
      settings: { ...this.settings },
      seats,
      rng: mulberry32(Math.floor(this.io.random() * 0x100000000)),
    });
    this.scoreVersion = this.match.version;
    this.phase = 'countdown';
    this.result = null;
    this.overtime = false;
    this.broadcastRoom();
    this.io.broadcast(this.match.matchMsg());
  }

  /** Back to the lobby after a match. People on the bench get seats first, ahead of bots. */
  again(pid: string): void {
    if (pid !== this.host || this.phase !== 'over') return;
    const people = this.players.filter((p) => p.connected && !p.bot);
    const bots = this.players.filter((p) => p.bot);
    this.players = [...people.filter((p) => p.seat < 0), ...people.filter((p) => p.seat >= 0), ...bots];
    this.phase = 'lobby';
    this.result = null;
    this.overtime = false;
    this.resetForLobby();
    this.ensureHost();
    this.broadcastRoom();
  }

  // -------------------------------------------------------------------------------------------
  // The match loop

  /** One match tick. The Durable Object calls this 60 times a second while inMatch. */
  tick(): void {
    if (!this.match || !this.inMatch) return;
    this.purge();
    const m = this.match;
    if (!m || !this.inMatch) return;
    const snap = m.tick();
    if (snap) this.io.broadcast(snap);
    if (m.version !== this.scoreVersion) this.syncScores(m);
    if (m.overtime !== this.overtime) {
      this.overtime = m.overtime;
      this.roomDirty = true;
    }
    if (m.over) {
      this.result = m.result;
      this.phase = 'over';
      this.match = null;
      this.broadcastRoom();
      return;
    }
    if (this.phase === 'countdown' && m.k >= m.playAt) {
      this.phase = 'playing';
      this.broadcastRoom();
      return;
    }
    if (this.roomDirty && m.k - this.roomSentAt >= ROOM_EVERY_TICKS) this.broadcastRoom();
  }

  private syncScores(m: Match): void {
    this.scoreVersion = m.version;
    for (const p of this.players) {
      const s = p.seat >= 0 ? m.seats[p.seat] : undefined;
      if (!s) continue;
      p.kills = s.score.kills;
      p.deaths = s.score.deaths;
      p.lives = s.score.lives;
      p.out = s.score.out;
    }
    this.roomDirty = true;
  }
}
