import { TICK_HZ } from '../../shared/constants';
import type { ViewState } from '../view';

const SPAWN_SECONDS = 3;
/** At match start the cue runs through the countdown and this long into play. */
const PLAY_SECONDS = 2;
const FADE_SECONDS = 0.5;

/**
 * Decides when to point out the local tank: through the countdown plus a little play, after every respawn,
 * and when the tank is first seen in a match (a reconnect). Times are renderer seconds.
 */
export class SpawnCue {
  private start = 0;
  private end = 0;
  private wasAlive = false;

  reset(): void {
    this.end = 0;
    this.wasAlive = false;
  }

  /** Your tank spawned (the Spawn event), even if it never looked dead to this client. */
  spawned(now: number): void {
    this.begin(now, now + SPAWN_SECONDS);
  }

  update(view: ViewState, now: number): void {
    const me = view.tanks.find((t) => t.isMe);
    const alive = !!me?.alive && view.phase !== 'over' && view.phase !== 'attract';
    if (!alive) {
      this.wasAlive = false;
      this.end = 0;
      return;
    }
    if (!this.wasAlive) this.begin(now, now + SPAWN_SECONDS);
    this.wasAlive = true;
    if (view.phase === 'countdown') this.begin(now, now + view.countdown / TICK_HZ + PLAY_SECONDS);
  }

  private begin(now: number, end: number): void {
    if (now >= this.end) this.start = now;
    this.end = Math.max(this.end, end);
  }

  /** 0 when hidden, otherwise 1, fading to 0 over the last half second. */
  strength(now: number): number {
    if (now >= this.end) return 0;
    return Math.min(1, (this.end - now) / FADE_SECONDS);
  }

  /** Seconds since the cue appeared, for its animation. */
  age(now: number): number {
    return now - this.start;
  }
}
