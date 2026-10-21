import type { GameEvent } from '../shared/protocol';
import type { Crate, MazeState, Proj, ProjState, Rect, TankState, Weapon } from '../shared/types';

/** The contract between the game client (net, prediction, UI) and the renderer and audio. */

export interface ViewTank extends TankState {
  name: string;
  /** CSS hex: the player's colour, or their team colour in team mode. */
  color: string;
  isMe: boolean;
  /**
   * TankFlag bits at the drawn tick: tankFlags(t, tick) plus TankFlag.Spinning from the last snapshot,
   * since spinning is server-only state.
   */
  flags: number;
}

export interface ViewProj extends ProjState {
  /** Owner's colour. */
  color: string;
  /** The client thinks it hit a tank and is waiting for the server to confirm. Do not draw it. */
  hidden: boolean;
}

export type ViewPhase = 'attract' | 'countdown' | 'playing' | 'over';

export interface ViewState {
  /** Client tick being drawn, fractional between sim ticks. */
  tick: number;
  phase: ViewPhase;
  maze: MazeState;
  /** Positions are render positions: smoothed and interpolated. */
  tanks: ViewTank[];
  projectiles: ViewProj[];
  crates: Crate[];
  /** The safe area while the storm is active. Everything outside it is storm. null when there is no storm. */
  storm: Rect | null;
  /** Seat of the local player's tank, -1 when spectating. */
  me: number;
  /** World point the follow camera centres on: your tank, or the tank being spectated. */
  focus: { x: number; y: number } | null;
  /** Dotted aim guides (laser guide, aimer upgrade) as flat x, y polylines. */
  aims: number[][];
  /** Ticks until play starts, during the countdown. */
  countdown: number;
}

/** Events the client produces itself from its own simulation. */
export type LocalEvent =
  | { e: 'bounce'; x: number; y: number; kind: Proj }
  | { e: 'expire'; x: number; y: number; kind: Proj }
  /** Instant muzzle flash and sound when the local player fires, before the server confirms. */
  | { e: 'muzzle'; seat: number; x: number; y: number; a: number; weapon: Weapon };

export type AnyEvent = GameEvent | LocalEvent;

export type CameraMode = 'fit' | 'follow';

/**
 * full: every effect, with line wobble, sync jitter, phosphor trails, grain, flicker and the rolling band. soft:
 * scanlines, mask, glow and aberration, steady. off: none, only the game's normal bloom.
 * The game's post pass (Renderer.setCrt) and the DOM layer (CrtScreen in crt.ts) must agree for each level.
 */
export type CrtLevel = 'off' | 'soft' | 'full';
export const CRT_LEVELS: readonly CrtLevel[] = ['full', 'soft', 'off'];

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Renderer {
  /** Rebuild static layers for a new maze and clear decals (tread marks, scorch marks). */
  setMaze(maze: MazeState): void;
  /** A wall's brick hp changed (chipped, broken or regrown). */
  wallChanged(id: number): void;
  /** Spawn effects for an event. The view supplies tank positions and colours. */
  event(ev: AnyEvent, view: ViewState): void;
  /** Big centred pixel text with a pop animation, for the countdown and streak calls. */
  banner(text: string, color?: string): void;
  setCamera(mode: CameraMode): void;
  /** The screen area (CSS px) the arena must fit inside, leaving room for HUD panels. */
  setViewport(rect: ScreenRect): void;
  /** CSS px per world px if the whole maze were fitted into the current viewport. */
  fitScale(maze: { w: number; h: number }): number;
  setCrt(level: CrtLevel): void;
  draw(view: ViewState, dt: number): void;
  drawMinimap(canvas: HTMLCanvasElement, view: ViewState): void;
  worldToScreen(x: number, y: number): { x: number; y: number };
  resize(): void;
}

/**
 * The renderer module also exports, from src/client/render/icons.ts:
 *   weaponIcon(kind: Weapon | CrateKind | typeof CAUSE_STORM, px: number): HTMLCanvasElement
 * a crisp pixel icon scaled to px CSS pixels, used by the DOM HUD and kill feed.
 */

export type UiSound = 'click' | 'join' | 'leave' | 'count' | 'go' | 'win' | 'lose' | 'error';

export interface Sfx {
  /** Create or resume the AudioContext. Call from a user gesture. */
  unlock(): void;
  setMuted(muted: boolean): void;
  event(ev: AnyEvent, view: ViewState): void;
  ui(sound: UiSound): void;
  /** Continuous sounds that depend on state (storm rumble, gatling spin, death ray charge). Called every frame. */
  update(view: ViewState, dt: number): void;
}
