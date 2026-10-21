import { BRICK_HP, GAME_SPEEDS, HEARTBEAT_MS, RESPAWN_TICKS, SHIELD_RADIUS, SNAPSHOT_TIMEOUT_MS, TICK_HZ } from '../shared/constants';
import { decodeMaze } from '../shared/grid';
import { decodeEvent, Ev, tankFlags, type GameEvent, type MatchMsg, type PublicPlayer, type RoomMsg, type ServerMsg, type SnapMsg } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { bulletPath, shotOrigin, stormRect, tracePath, type Circle } from '../shared/sim';
import { Input, sameTeam, TankFlag, Upgrade, WallKind, Weapon, type BotLevel, type Crate, type MazeState, type TankState } from '../shared/types';
import { LASER } from '../shared/weapons';
import { GameClock } from './clock';
import type { FeedEntry, HudModel, HudPlayer, Who } from './hud';
import type { Controls, InputState } from './input';
import { Net, type NetStatus } from './net';
import { Prediction, type Pose } from './predict';
import { Smoother } from './smooth';
import { playerColor } from './ui';
import type { Renderer, Sfx, ViewPhase, ViewProj, ViewState, ViewTank } from './view';

/** A stalled tab more than this many ticks behind re-simulates from the next snapshot instead of catching up. */
const MAX_CATCH_UP = 30;
/** Event effects that waited this long for a frame are skipped (the tab was stalled or hidden). */
const STALE_MS = 250;
/** A local muzzle flash waits this long for the server's matching Fire event. */
const MUZZLE_WAIT_MS = 500;
/**
 * A joystick steer change of STEER_STEP steps goes out at most every STEER_GAP_TICKS. A smaller one waits
 * STEER_HOLD_TICKS and must be at least STEER_HOLD_STEPS, so thumb tremor alone sends nothing.
 */
const STEER_STEP = 3;
const STEER_GAP_TICKS = 3;
const STEER_HOLD_STEPS = 2;
const STEER_HOLD_TICKS = 12;
const AIMER_LENGTH = 640;
const STREAK_WINDOW = 4 * TICK_HZ;
const RAMPAGE = 5;
const WATCHDOG_MS = 250;

export interface SessionHooks {
  room(prev: RoomMsg | null, next: RoomMsg): void;
  status(status: NetStatus): void;
  error(reason: string): void;
  feed(entry: FeedEntry): void;
  /** A new match began: clear the kill feed. */
  matchStarted(): void;
}

export interface SessionDeps {
  renderer: Renderer;
  sfx: Sfx;
  controls: Controls;
  pid: string;
  hooks: SessionHooks;
}

interface Match {
  id: number;
  maze: MazeState;
  crates: Map<number, Crate>;
  playAt: number;
  stormAt: number;
  endAt: number;
  pred: Prediction;
}

interface Streak {
  kills: number;
  recent: number[];
}

const steerSteps = (a: number, b: number) => {
  const d = Math.abs(a - b) & 255;
  return Math.min(d, 256 - d);
};

const clock2 = (ticks: number) => {
  const s = Math.max(0, Math.ceil(ticks / TICK_HZ));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** One room: the socket, the room state, the predicted match, input sending and the per-frame view. */
export class Session {
  room: RoomMsg | null = null;
  myId = '';
  status: NetStatus = 'connecting';
  private net: Net;
  private match: Match | null = null;
  private clock = new GameClock();
  private smoother = new Smoother();
  private pending: SnapMsg | null = null;
  private lastSnap: SnapMsg | null = null;
  /** The match is over and the world shows the server's final snapshot. */
  private frozen = false;
  /** Snapshot events waiting for the next frame, with the snapshot tick and their arrival time. */
  private queue: { k: number; ev: GameEvent; at: number }[] = [];
  private dirtyWalls = new Set<number>();
  private seats = new Map<number, HudPlayer>();
  private seq = 0;
  private lastSent = { bits: 0, steer: 0, k: -1, at: -Infinity };
  private forceSend = false;
  private muzzles: number[] = [];
  private lastSnapAt = 0;
  private streaks = new Map<number, Streak>();
  private myDeathTick = -1;
  private lastCount = 0;
  private goShown = false;
  private spectate = -1;
  private lastFocus: { x: number; y: number } | null = null;
  private alpha = 1;
  private watchdog: ReturnType<typeof setInterval>;
  private tankPool: ViewTank[] = [];
  private projPool: ViewProj[] = [];
  private pose: Pose = { x: 0, y: 0, a: 0 };
  private view: ViewState | null = null;

  constructor(
    readonly code: string,
    name: string,
    private deps: SessionDeps,
  ) {
    this.net = new Net(code, {
      hello: () => ({ t: 'hello', pid: deps.pid, name }),
      opened: () => this.resetInputs(),
      message: (msg) => this.onMessage(msg),
      status: (status) => {
        this.status = status;
        deps.hooks.status(status);
      },
    });
    this.net.connect();
    this.watchdog = setInterval(() => this.watch(), WATCHDOG_MS);
  }

  close(): void {
    clearInterval(this.watchdog);
    this.net.close();
  }

  // ---------------------------------------------------------------------------------------------
  // Room actions

  get me(): PublicPlayer | undefined {
    return this.room?.players.find((p) => p.id === this.myId);
  }

  get isHost(): boolean {
    return !!this.room && this.room.host === this.myId;
  }

  settings(s: Partial<Settings>): void {
    this.net.send({ t: 'settings', s });
  }
  start(): void {
    this.net.send({ t: 'start' });
  }
  again(): void {
    this.net.send({ t: 'again' });
  }
  addBot(level: BotLevel): void {
    this.net.send({ t: 'addBot', level });
  }
  removeBot(id: string): void {
    this.net.send({ t: 'removeBot', id });
  }
  team(team: number): void {
    this.net.send({ t: 'team', team });
  }

  /** The seat of the local player's tank in the current match, or -1 when watching. */
  get mySeat(): number {
    const me = this.me;
    return me && me.seat >= 0 && this.match?.pred.tankAt(me.seat) ? me.seat : -1;
  }

  /** A match is counting down or running. */
  private get inMatch(): boolean {
    const phase = this.room?.phase;
    return (phase === 'countdown' || phase === 'playing') && !!this.match;
  }

  /** Seated in the running match and still has a tank (not out of lives): the controls drive it. */
  get playing(): boolean {
    const me = this.me;
    return this.inMatch && !!me && me.seat >= 0 && !me.out;
  }

  // ---------------------------------------------------------------------------------------------
  // Messages

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        break;
      case 'room':
        this.onRoom(msg);
        break;
      case 'match':
        this.onMatch(msg);
        break;
      case 's':
        this.onSnap(msg);
        break;
      case 'error':
        this.deps.hooks.error(msg.reason);
        break;
    }
  }

  private onRoom(msg: RoomMsg): void {
    const prev = this.room;
    this.room = msg;
    this.seats.clear();
    const teams = msg.settings.teams > 0;
    for (const p of msg.players) if (p.seat >= 0) this.seats.set(p.seat, { player: p, color: playerColor(p, teams) });
    if (msg.phase === 'lobby') {
      this.match = null;
      this.pending = null;
      this.lastSnap = null;
      this.queue = [];
      this.view = null;
    }
    this.configure();
    if (prev?.phase !== 'over' && msg.phase === 'over') this.matchOver(msg);
    if (msg.phase === 'lobby' && prev?.phase === 'lobby') {
      if (msg.players.length > prev.players.length) this.deps.sfx.ui('join');
      else if (msg.players.length < prev.players.length) this.deps.sfx.ui('leave');
    }
    this.deps.hooks.room(prev, msg);
  }

  private matchOver(msg: RoomMsg): void {
    const r = msg.result;
    const me = this.me;
    if (!r || !me || me.seat < 0) return;
    this.deps.sfx.ui(!r.draw && r.winners.includes(me.id) ? 'win' : 'lose');
  }

  /** A full room turned this tab away: try again. */
  retry(): void {
    this.net.tryAgain();
  }

  /** Room changes the prediction depends on: my seat, game speed, friendly fire. */
  private configure(): void {
    const m = this.match;
    const room = this.room;
    if (!m || !room) return;
    const o = m.pred.opts;
    o.me = this.me?.seat ?? -1;
    o.speed = GAME_SPEEDS[room.settings.speed] ?? 1;
    o.friendlyFire = room.settings.friendlyFire;
  }

  private onMatch(msg: MatchMsg): void {
    const now = performance.now();
    const maze = decodeMaze(msg.w, msg.h, msg.walls, msg.hp);
    if (!maze) {
      console.error(JSON.stringify({ event: 'bad_match_message', w: msg.w, h: msg.h }));
      return;
    }
    const crates = new Map(msg.crates.map(([id, kind, cx, cy]) => [id, { id, kind, cx, cy }] as const));
    const old = this.match;
    if (old && old.id === msg.id && old.maze.w === maze.w && old.maze.h === maze.h) {
      // Back after a reconnect: same match, so keep the maze object (the renderer keeps its decals) and patch it.
      // Input seqs already restarted when the socket opened, and inputs may have gone out since: no reset here.
      for (let id = 0; id < maze.hp.length; id++) {
        if (old.maze.hp[id] !== maze.hp[id]) {
          old.maze.hp[id] = maze.hp[id]!;
          this.dirtyWalls.add(id);
        }
      }
      old.crates = crates;
    } else {
      this.clock.reset();
      this.smoother.clear();
      this.queue = [];
      this.pending = null;
      this.lastSnap = null;
      this.frozen = false;
      this.streaks.clear();
      this.myDeathTick = -1;
      this.lastCount = 0;
      this.goShown = msg.k > msg.playAt + TICK_HZ;
      this.spectate = -1;
      this.lastFocus = null;
      this.dirtyWalls.clear();
      this.match = {
        id: msg.id,
        maze,
        crates,
        playAt: msg.playAt,
        stormAt: msg.stormAt,
        endAt: msg.endAt,
        pred: new Prediction({ maze, playAt: msg.playAt, speed: 1, friendlyFire: true, me: -1, teamOf: (seat) => this.seats.get(seat)?.player.team ?? 0 }),
      };
      this.configure();
      this.resetInputs();
      this.deps.hooks.matchStarted();
    }
    this.clock.onSnap(msg.k, now);
    this.lastSnapAt = now;
  }

  private onSnap(msg: SnapMsg): void {
    const m = this.match;
    if (!m) return;
    const now = performance.now();
    this.lastSnapAt = now;
    this.clock.onSnap(msg.k, now);
    for (const row of msg.e ?? []) {
      const ev = decodeEvent(row);
      if (!ev) continue;
      this.applyState(m, ev);
      this.queue.push({ k: msg.k, ev, at: now });
    }
    if (!this.pending || msg.k > this.pending.k) this.pending = msg;
    if (!this.lastSnap || msg.k > this.lastSnap.k) this.lastSnap = msg;
    // A hidden tab never draws, so never dispatches: keep only recent effects.
    if (this.queue.length > 512) this.queue.splice(0, this.queue.length - 256);
  }

  /** Brick, Crate, Pick and Spawn change client state on arrival, even when their effects are too old to show. */
  private applyState(m: Match, ev: GameEvent): void {
    switch (ev.e) {
      case Ev.Brick:
        if (m.maze.walls[ev.wall] === WallKind.Brick) {
          m.maze.hp[ev.wall] = Math.max(0, Math.min(BRICK_HP, ev.hp));
          this.dirtyWalls.add(ev.wall);
        }
        break;
      case Ev.Crate:
        m.crates.set(ev.id, { id: ev.id, kind: ev.kind, cx: ev.cx, cy: ev.cy });
        break;
      case Ev.Pick:
        m.crates.delete(ev.id);
        break;
      case Ev.Spawn:
        this.smoother.snapTank(ev.seat);
        if (this.room && ev.seat === this.me?.seat) this.myDeathTick = -1;
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Input

  /** Seq numbering restarts on every new socket and every new match; the current input goes out at once. */
  private resetInputs(): void {
    this.seq = 0;
    this.lastSent = { bits: 0, steer: this.lastSent.steer, k: -1, at: -Infinity };
    this.forceSend = true;
    this.muzzles = [];
    this.match?.pred.resetInputs();
    this.clock.lead.resetAcks();
  }

  private send(input: InputState, k: number, now: number): void {
    const seq = this.seq + 1;
    if (!this.net.send({ t: 'in', s: seq, k, b: input.bits, d: input.steer })) return;
    this.seq = seq;
    this.lastSent = { bits: input.bits, steer: input.steer, k, at: now };
    this.forceSend = false;
    if (this.mySeat >= 0) this.match?.pred.sent({ seq, k, bits: input.bits, steer: input.steer });
  }

  /**
   * Samples input for tick k and sends it when it changed (at most one message per tick). Everyone in a match
   * heartbeats, spectators included: any message keeps the room's tick loop within its CPU budget.
   */
  private sampleInput(k: number, now: number): void {
    if (!this.inMatch || k <= this.lastSent.k) return;
    if (!this.playing) {
      if (now - this.lastSent.at >= HEARTBEAT_MS) this.send({ bits: 0, steer: this.lastSent.steer }, k, now);
      return;
    }
    const input = this.deps.controls.sample();
    const last = this.lastSent;
    let send = this.forceSend || input.bits !== last.bits || now - last.at >= HEARTBEAT_MS;
    if (!send && input.bits & Input.Steer) {
      const steps = steerSteps(input.steer, last.steer);
      const since = k - last.k;
      send = (steps >= STEER_STEP && since >= STEER_GAP_TICKS) || (steps >= STEER_HOLD_STEPS && since >= STEER_HOLD_TICKS);
    }
    if (send) this.send(input, k, now);
  }

  /** Every key and touch was dropped: tell the server now rather than on the next frame (the tab may be hiding). */
  idle(): void {
    if (!this.playing || this.lastSent.bits === 0) return;
    const now = performance.now();
    this.send({ bits: 0, steer: this.lastSent.steer }, this.nextInputTick(now), now);
  }

  private nextInputTick(now: number): number {
    const tick = Math.max(this.match?.pred.tick ?? 0, this.clock.ready ? this.clock.frame(now).tick : 0);
    return Math.max(tick, this.lastSent.k) + 1;
  }

  /** Runs on a timer, so it works while the tab is hidden and frames stop. */
  private watch(): void {
    if (!this.match || !this.net.open) return;
    const phase = this.room?.phase;
    if (phase !== 'countdown' && phase !== 'playing') return;
    const now = performance.now();
    if (now - this.lastSnapAt > SNAPSHOT_TIMEOUT_MS) {
      this.lastSnapAt = now;
      this.net.reconnect();
      return;
    }
    // Visible tabs heartbeat from the frame loop; a hidden one has no frames.
    if (document.hidden && now - this.lastSent.at >= HEARTBEAT_MS) {
      this.send({ bits: this.lastSent.bits, steer: this.lastSent.steer }, this.nextInputTick(now), now);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Frame

  /** Steps the prediction and builds what to draw. null in the lobby (the caller shows the attract demo). */
  frame(now: number, dt: number): ViewState | null {
    const m = this.match;
    const room = this.room;
    if (!m || !room || room.phase === 'lobby') return null;
    const pred = m.pred;
    const over = room.phase === 'over';
    if (over) {
      // No more extrapolation: show the server's final state.
      if (!this.frozen && this.lastSnap) pred.applySnapshot(this.lastSnap, this.lastSnap.k);
      this.frozen = true;
      this.pending = null;
      this.alpha = 1;
    } else if (this.clock.ready) {
      const f = this.clock.frame(now);
      this.alpha = f.alpha;
      this.advance(pred, f.tick, now);
    }
    if (!pred.ready) return null;
    this.smoother.decay(dt);
    const view = this.buildView(m, over);
    this.view = view;
    if (!over) this.countdown(m, pred.tick);
    return view;
  }

  private advance(pred: Prediction, target: number, now: number): void {
    const snap = this.pending;
    this.pending = null;
    if (!pred.ready) {
      if (snap) this.rebase(pred, snap, Math.max(target, snap.k));
      return;
    }
    if (target < pred.tick) {
      this.stepBack(pred, snap ?? this.lastSnap, target);
      return;
    }
    if (target - pred.tick > MAX_CATCH_UP) {
      if (snap) {
        this.rebase(pred, snap, target);
        this.smoother.clear();
        return;
      }
      pred.jumpTo(target - 1);
    }
    while (pred.tick < target) {
      // After a hitch the input read now belongs to the newest tick; the ticks before it keep the input already sent.
      if (pred.tick + 1 === target) this.sampleInput(target, now);
      pred.step();
    }
    if (snap) {
      this.smoother.capture(pred, this.alpha);
      this.rebase(pred, snap, pred.tick);
      this.smoother.rebase(pred, this.alpha);
    }
  }

  /**
   * The clock went back (the server's tick loop stalled and it is behind): re-simulate from the newest snapshot to
   * the new tick instead of freezing until the server catches up. Inputs already sent were stamped against the old
   * clock, so their acks say nothing about the lead, and new inputs go out from the new tick.
   */
  private stepBack(pred: Prediction, snap: SnapMsg | null, target: number): void {
    this.clock.lead.settle(this.seq);
    if (snap) this.rebase(pred, snap, Math.max(target, snap.k));
    this.smoother.clear();
    this.lastSent.k = Math.min(this.lastSent.k, pred.tick);
  }

  private rebase(pred: Prediction, snap: SnapMsg, toTick: number): void {
    const ack = pred.applySnapshot(snap, toTick);
    if (ack) this.clock.onAck(ack, this.seq);
  }

  private countdown(m: Match, tick: number): void {
    if (tick < m.playAt) {
      const count = Math.ceil((m.playAt - tick) / TICK_HZ);
      if (count !== this.lastCount && count <= 3) {
        this.deps.renderer.banner(String(count), '#ffe14d');
        this.deps.sfx.ui('count');
      }
      this.lastCount = count;
    } else if (!this.goShown) {
      this.goShown = true;
      // A tab that was hidden at the start missed it: no late GO.
      if (tick - m.playAt > TICK_HZ / 2) return;
      this.deps.renderer.banner('GO!', '#5dff6a');
      this.deps.sfx.ui('go');
    }
  }

  private buildView(m: Match, over: boolean): ViewState {
    const pred = m.pred;
    const alpha = this.alpha;
    const tick = pred.tick - 1 + alpha;
    const mySeat = this.mySeat;
    const tanks: ViewTank[] = [];
    for (let i = 0; i < pred.tanks.length; i++) {
      const t = pred.tanks[i]!;
      const pose = this.smoother.tankPose(pred, t, alpha, this.pose);
      const seat = this.seats.get(t.seat);
      const vt = (this.tankPool[i] ??= { ...t, name: '', color: '', isMe: false, flags: 0 });
      Object.assign(vt, t);
      vt.x = pose.x;
      vt.y = pose.y;
      vt.a = pose.a;
      vt.name = seat?.player.name ?? '';
      vt.color = seat?.color ?? '#ffffff';
      vt.isMe = t.seat === mySeat;
      vt.flags = tankFlags(t, pred.tick) | (pred.spinning.has(t.seat) ? TankFlag.Spinning : 0);
      tanks.push(vt);
    }
    const projectiles: ViewProj[] = [];
    for (let i = 0; i < pred.projs.length; i++) {
      const p = pred.projs[i]!;
      const vp = (this.projPool[i] ??= { ...p, color: '', hidden: false });
      Object.assign(vp, p);
      this.smoother.projPos(pred, p, alpha, vp);
      vp.color = this.seats.get(p.owner)?.color ?? '#ffffff';
      vp.hidden = pred.hidden.has(p.id);
      projectiles.push(vp);
    }
    if (this.projPool.length > 2 * projectiles.length + 64) this.projPool.length = projectiles.length;
    const mine = tanks.find((t) => t.isMe);
    const phase: ViewPhase = over ? 'over' : pred.tick < m.playAt ? 'countdown' : 'playing';
    return {
      tick,
      phase,
      maze: m.maze,
      tanks,
      projectiles,
      crates: [...m.crates.values()],
      storm: stormRect(m.maze, tick, m.stormAt),
      me: mySeat,
      focus: this.focus(tanks, mine),
      aims: mine && !over ? this.aims(m, mine, tanks) : [],
      countdown: Math.max(0, m.playAt - tick),
    };
  }

  private focus(tanks: ViewTank[], mine: ViewTank | undefined): { x: number; y: number } | null {
    let target: ViewTank | undefined;
    // Out of lives, the tank stays in the snapshots but its player spectates like anyone else.
    if (mine && !this.me?.out) target = mine.alive ? mine : undefined;
    else target = tanks.find((t) => t.seat === this.spectate && t.alive) ?? this.leader(tanks);
    if (target) this.lastFocus = { x: target.x, y: target.y };
    return this.lastFocus;
  }

  /** The living tank whose player is ahead: most lives then kills in lives mode, most kills otherwise. */
  private leader(tanks: ViewTank[]): ViewTank | undefined {
    const lives = this.room?.settings.mode === 'lives';
    let best: ViewTank | undefined;
    let bestScore = -Infinity;
    for (const t of tanks) {
      const p = this.seats.get(t.seat)?.player;
      if (!t.alive || !p) continue;
      const score = lives ? p.lives * 1000 + p.kills : p.kills * 1000 - p.deaths;
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best;
  }

  /** Spectators step through the living tanks. */
  cycleSpectate(): void {
    const alive = this.match?.pred.tanks.filter((t) => t.alive).map((t) => t.seat) ?? [];
    if (alive.length === 0) return;
    const i = alive.indexOf(this.spectate);
    this.spectate = alive[(i + 1) % alive.length]!;
  }


  /** Laser guide while holding a laser, and the aimer upgrade's bullet path. */
  private aims(m: Match, mine: ViewTank, tanks: ViewTank[]): number[][] {
    const tick = m.pred.tick;
    if (!mine.alive) return [];
    const laser = mine.weapon === Weapon.Laser && mine.ammo > 0;
    if (!laser && mine.aimerUntil <= tick) return [];
    if (laser) {
      const o = shotOrigin(mine, m.maze);
      const mirrors: Circle[] = [];
      for (const t of tanks) if (t !== mine && t.alive && t.shieldUntil > tick) mirrors.push({ x: t.x, y: t.y, r: SHIELD_RADIUS });
      return [tracePath(m.maze, o.x, o.y, mine.a, LASER.maxReflections, LASER.maxLength, mirrors).pts];
    }
    return [bulletPath(m.maze, mine, this.room?.settings.bounces ?? 6, AIMER_LENGTH, m.pred.opts.speed)];
  }

  // ---------------------------------------------------------------------------------------------
  // Events

  /** Hands this frame's events to the renderer and audio. Call after drawing, so the renderer has the match maze. */
  dispatch(view: ViewState, now: number): void {
    const m = this.match;
    if (!m) return;
    const { renderer, sfx } = this.deps;
    for (const id of this.dirtyWalls) renderer.wallChanged(id);
    this.dirtyWalls.clear();
    const local = m.pred.events;
    m.pred.events = [];
    for (const ev of local) {
      if (ev.e === 'muzzle') this.muzzles.push(now);
      renderer.event(ev, view);
      sfx.event(ev, view);
    }
    const queue = this.queue;
    this.queue = [];
    for (const { k, ev, at } of queue) this.react(ev, k, now - at <= STALE_MS, view, now);
  }

  private react(ev: GameEvent, k: number, fresh: boolean, view: ViewState, now: number): void {
    const { renderer, sfx } = this.deps;
    if (ev.e === Ev.Fire && ev.seat === this.mySeat) {
      while (this.muzzles.length > 0 && now - this.muzzles[0]! > MUZZLE_WAIT_MS) this.muzzles.shift();
      // Already shown by the local muzzle flash.
      if (this.muzzles.length > 0) {
        this.muzzles.shift();
        return;
      }
    }
    if (ev.e === Ev.Death) this.onDeath(ev, k, fresh);
    if (!fresh) return;
    renderer.event(ev, view);
    sfx.event(ev, view);
    if (ev.e === Ev.Storm) renderer.banner('STORM!', '#a6ff4a');
    else if (ev.e === Ev.Overtime) renderer.banner('OVERTIME', '#ff9a3d');
  }

  private who(seat: number): Who | null {
    const s = this.seats.get(seat);
    return s ? { name: s.player.name, color: s.color, me: s.player.id === this.myId } : null;
  }

  private onDeath(ev: Extract<GameEvent, { e: typeof Ev.Death }>, k: number, fresh: boolean): void {
    const { renderer } = this.deps;
    const victim = this.who(ev.seat);
    const killerSeat = ev.by >= 0 && ev.by !== ev.seat ? ev.by : -1;
    const killer = killerSeat >= 0 ? this.who(killerSeat) : null;
    const team = (seat: number) => this.seats.get(seat)?.player.team ?? 0;
    const teamKill = killerSeat >= 0 && sameTeam(team(killerSeat), team(ev.seat));
    if (victim) this.deps.hooks.feed({ kind: 'kill', killer, victim, cause: ev.cause, self: ev.self, teamKill });
    this.streaks.delete(ev.seat);
    const mine = this.me?.seat ?? -1;
    if (ev.seat === mine) {
      this.myDeathTick = k;
      if (fresh) renderer.banner('YOU DIED', '#ff4d4d');
    }
    if (killerSeat < 0 || teamKill) return;
    const s = this.streaks.get(killerSeat) ?? { kills: 0, recent: [] };
    this.streaks.set(killerSeat, s);
    s.kills++;
    s.recent = s.recent.filter((t) => k - t <= STREAK_WINDOW);
    s.recent.push(k);
    const call = s.kills % RAMPAGE === 0 ? 'RAMPAGE' : s.recent.length >= 3 ? 'TRIPLE KILL' : s.recent.length === 2 ? 'DOUBLE KILL' : '';
    if (!call || !killer) return;
    if (killerSeat === mine) {
      if (fresh) renderer.banner(call, call === 'RAMPAGE' ? '#ff6bd6' : '#ffe14d');
    } else {
      this.deps.hooks.feed({ kind: 'note', who: killer, text: call });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HUD

  hud(now: number): HudModel | null {
    const m = this.match;
    const room = this.room;
    const view = this.view;
    if (!m || !room || !view || room.phase === 'lobby' || room.phase === 'over') return null;
    const serverTick = this.clock.ready ? this.clock.server.tick(now) : 0;
    const s = room.settings;
    let timer = '';
    let alert = false;
    if (s.mode === 'timed' && m.endAt > 0) {
      const left = m.endAt - serverTick;
      timer = room.overtime || left <= 0 ? 'OVERTIME' : clock2(left);
      alert = room.overtime || left < 10 * TICK_HZ;
    } else if (m.stormAt > 0) {
      const left = m.stormAt - serverTick;
      timer = left > 0 ? `STORM ${clock2(left)}` : 'STORM';
      alert = left < 10 * TICK_HZ;
    }
    const me = this.me;
    const mySeat = this.mySeat;
    const mine = view.tanks.find((t) => t.seat === mySeat);
    let notice = '';
    if (!me || me.seat < 0 || mySeat < 0) notice = 'Spectating - you join next match';
    else if (me.out) notice = 'Out of lives - spectating';
    else if (mine && !mine.alive && this.myDeathTick >= 0) {
      const left = (this.myDeathTick + RESPAWN_TICKS - serverTick) / TICK_HZ;
      notice = left > 0 ? `Respawning in ${left.toFixed(1)}` : 'Respawning...';
    }
    return {
      timer,
      alert,
      teams: s.teams > 0,
      lives: s.mode === 'lives',
      players: [...this.seats.values()],
      myId: this.myId,
      me: mine && !me?.out ? this.tankStatus(mine, view.tick) : null,
      notice,
      canCycle: mySeat < 0 || !!me?.out,
    };
  }

  private tankStatus(t: TankState, tick: number): HudModel['me'] {
    const upgrades: { kind: Upgrade; left: number }[] = [];
    const add = (kind: Upgrade, until: number) => {
      if (until > tick) upgrades.push({ kind, left: (until - tick) / TICK_HZ });
    };
    add(Upgrade.Shield, t.shieldUntil);
    add(Upgrade.Speed, t.speedUntil);
    add(Upgrade.Aimer, t.aimerUntil);
    return { alive: t.alive, hp: t.alive ? t.hp : 0, weapon: t.weapon, ammo: t.ammo, upgrades };
  }
}
