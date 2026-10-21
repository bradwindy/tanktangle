import { TICK_MS } from '../shared/constants';
import type { InputAck } from '../shared/protocol';

/** Snapshots this recent set the clock. The least delayed one anchors it. */
const WINDOW_MS = 1000;
export const START_LEAD = 4;
export const MIN_LEAD = 1;
export const MAX_LEAD = 40;
/** An ack this early (in ticks) counts toward lowering the lead. */
const EARLY_MARGIN = 3;
/** New acks in a row that must be early before the lead drops a tick. */
const EARLY_STREAK = 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Estimates the server tick from snapshot arrivals. offset is the smallest (arrival - k * TICK_MS) seen over the
 * last second, so the estimate follows the least delayed snapshot and ignores jitter above it.
 */
export class ServerClock {
  private arrivals: { at: number; offset: number }[] = [];
  private offset = Infinity;
  private lastK = -1;

  reset(): void {
    this.arrivals = [];
    this.offset = Infinity;
    this.lastK = -1;
  }

  get ready(): boolean {
    return Number.isFinite(this.offset);
  }

  onSnap(k: number, now: number): void {
    if (k < this.lastK) this.reset();
    this.lastK = k;
    this.arrivals.push({ at: now, offset: now - k * TICK_MS });
    while (this.arrivals.length > 1 && this.arrivals[0]!.at < now - WINDOW_MS) this.arrivals.shift();
    let min = Infinity;
    for (const a of this.arrivals) if (a.offset < min) min = a.offset;
    this.offset = min;
  }

  /** Estimated server tick at time now (fractional). Only meaningful once ready. */
  tick(now: number): number {
    return (now - this.offset) / TICK_MS;
  }
}

/**
 * How many ticks the client sim runs ahead of the server estimate, so inputs stamped for the next client tick
 * reach the server just in time. It adapts only on acks of inputs sent since the lead last changed, so the acks
 * of inputs already in flight with the old lead do not push it again.
 */
export class Lead {
  value = START_LEAD;
  private lastSeq = 0;
  private settledSeq = 0;
  private earlyStreak = 0;

  /** Seq numbering restarts (new socket or new match). The lead itself carries over. */
  resetAcks(): void {
    this.lastSeq = 0;
    this.settledSeq = 0;
    this.earlyStreak = 0;
  }

  /** sentSeq is the newest seq sent so far. Returns true when the lead changed. */
  onAck(ack: InputAck, sentSeq: number): boolean {
    if (ack.seq <= this.lastSeq) return false;
    this.lastSeq = ack.seq;
    if (ack.seq <= this.settledSeq) return false;
    const before = this.value;
    if (ack.margin < 0) {
      this.value += 1 - ack.margin;
      this.earlyStreak = 0;
    } else if (ack.margin > EARLY_MARGIN) {
      if (++this.earlyStreak >= EARLY_STREAK) {
        this.value -= 1;
        this.earlyStreak = 0;
      }
    } else {
      this.earlyStreak = 0;
    }
    this.value = clamp(this.value, MIN_LEAD, MAX_LEAD);
    if (this.value === before) return false;
    this.settledSeq = sentSeq;
    return true;
  }
}

export interface ClockFrame {
  /** The client sim tick L to have simulated up to. Never goes backwards. */
  tick: number;
  /** Interpolation between the sim states at tick - 1 and tick, 0 to 1. */
  alpha: number;
}

/** The client sim clock: L = floor(estimated server tick + lead), stalling instead of stepping back. */
export class GameClock {
  readonly server = new ServerClock();
  readonly lead = new Lead();
  private last = -1;

  /** A new match: the server tick starts again from 0. */
  reset(): void {
    this.server.reset();
    this.lead.resetAcks();
    this.last = -1;
  }

  get ready(): boolean {
    return this.server.ready;
  }

  onSnap(k: number, now: number): void {
    this.server.onSnap(k, now);
  }

  onAck(ack: InputAck, sentSeq: number): boolean {
    return this.lead.onAck(ack, sentSeq);
  }

  /** How far behind the server estimate a tick is, in ticks. */
  age(k: number, now: number): number {
    return this.server.ready ? this.server.tick(now) - k : 0;
  }

  frame(now: number): ClockFrame {
    if (!this.server.ready) return { tick: Math.max(0, this.last), alpha: 1 };
    const target = this.server.tick(now) + this.lead.value;
    const whole = Math.floor(target);
    if (whole < this.last) return { tick: this.last, alpha: 1 };
    this.last = whole;
    return { tick: whole, alpha: target - whole };
  }
}
