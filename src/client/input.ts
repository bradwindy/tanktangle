import { Input } from '../shared/types';
import { TAU } from '../shared/vec';

export interface InputState {
  bits: number;
  /** Steer byte: the joystick direction, 256 steps per turn. Kept from the last stick position when released. */
  steer: number;
}

const KEY_BITS: Record<string, number> = {
  KeyW: Input.Fwd,
  ArrowUp: Input.Fwd,
  KeyS: Input.Back,
  ArrowDown: Input.Back,
  KeyA: Input.Left,
  ArrowLeft: Input.Left,
  KeyD: Input.Right,
  ArrowRight: Input.Right,
  Space: Input.Fire,
  Enter: Input.Fire,
  NumpadEnter: Input.Fire,
};

/** Outer radius of the joystick in CSS px. */
const STICK_RADIUS = 52;
const DEADZONE = 12;
/** Inside this share of the radius the tank only turns to face the stick; further out it drives. */
const INNER = 0.45;
/** Once driving, the stick must come back this far inside INNER to stop, so a thumb resting on the line doesn't flicker. */
const INNER_RELEASE = 0.35;

export const steerByte = (angle: number) => Math.round((angle / TAU) * 256) & 255;

const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

export interface ControlsHooks {
  /** Escape pressed. */
  menu(): void;
  /** Every held key and touch was dropped (blur, hidden tab, touch cancel): send the idle input now. */
  cleared(): void;
  /** Any key or touch, for unlocking audio. */
  gesture(): void;
}

interface Stick {
  id: number;
  baseX: number;
  baseY: number;
  dx: number;
  dy: number;
  driving: boolean;
}

/**
 * Keyboard (WASD or arrows, Space or Enter) and touch (floating joystick on the left half, fire on the right half)
 * merged into one input. A Fire tap shorter than a tick still counts: the press is latched until the next sample.
 */
export class Controls {
  /** Only while true are game keys taken from the page (no scrolling with arrows or space). */
  enabled = false;
  private keys = new Set<string>();
  private stick: Stick | null = null;
  private firePointers = new Set<number>();
  private latched = false;
  private steer = 0;
  private layer: HTMLElement | null = null;
  private base: HTMLElement | null = null;
  private knob: HTMLElement | null = null;
  private fireButton: HTMLElement | null = null;

  constructor(private hooks: ControlsHooks) {
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.clear());
    addEventListener('pagehide', () => this.clear());
    addEventListener('touchcancel', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
  }

  /** Wires the touch layer (full screen, under the HUD) and its joystick and fire button elements. */
  attachTouch(layer: HTMLElement, base: HTMLElement, knob: HTMLElement, fireButton: HTMLElement): void {
    this.layer = layer;
    this.base = base;
    this.knob = knob;
    this.fireButton = fireButton;
    layer.addEventListener('pointerdown', (e) => this.onDown(e));
    layer.addEventListener('pointermove', (e) => this.onMove(e));
    layer.addEventListener('pointerup', (e) => this.onUp(e.pointerId));
    layer.addEventListener('pointercancel', (e) => this.onUp(e.pointerId));
    layer.addEventListener('lostpointercapture', (e) => this.onUp(e.pointerId));
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** The input for the next tick. Consumes a latched Fire tap. */
  sample(): InputState {
    let bits = 0;
    const s = this.stick;
    if (s) {
      const dist = Math.hypot(s.dx, s.dy);
      if (dist >= DEADZONE) {
        this.steer = steerByte(Math.atan2(s.dy, s.dx));
        s.driving = dist >= STICK_RADIUS * (s.driving ? INNER_RELEASE : INNER);
        bits = Input.Steer | (s.driving ? Input.Fwd : 0);
      } else {
        s.driving = false;
      }
    } else {
      for (const code of this.keys) bits |= KEY_BITS[code]! & ~Input.Fire;
    }
    if (this.firing || this.latched) bits |= Input.Fire;
    this.latched = false;
    return { bits, steer: this.steer };
  }

  get firing(): boolean {
    return this.firePointers.size > 0 || [...this.keys].some((code) => KEY_BITS[code] === Input.Fire);
  }

  /** Drops every held key and touch. */
  clear(): void {
    const had = this.keys.size > 0 || this.stick !== null || this.firePointers.size > 0 || this.latched;
    this.keys.clear();
    this.firePointers.clear();
    this.latched = false;
    this.endStick();
    this.fireButton?.classList.remove('down');
    if (had) this.hooks.cleared();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down) this.hooks.gesture();
    if (down && e.key === 'Escape') {
      this.hooks.menu();
      return;
    }
    const bit = KEY_BITS[e.code];
    if (bit === undefined || typingIn(e.target)) return;
    if (!this.enabled) {
      this.keys.delete(e.code);
      return;
    }
    e.preventDefault();
    if (!down) {
      this.keys.delete(e.code);
      return;
    }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    this.keys.add(e.code);
    if (bit === Input.Fire) this.latched = true;
  }

  private onDown(e: PointerEvent): void {
    this.hooks.gesture();
    if (!this.enabled) return;
    e.preventDefault();
    try {
      this.layer?.setPointerCapture(e.pointerId);
    } catch {
      // The pointer was already released. Its pointerup still arrives.
    }
    if (e.clientX < innerWidth / 2 && !this.stick) {
      this.stick = { id: e.pointerId, baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0, driving: false };
      this.base?.classList.add('on');
      this.drawStick();
      return;
    }
    this.firePointers.add(e.pointerId);
    this.latched = true;
    this.fireButton?.classList.add('down');
  }

  private onMove(e: PointerEvent): void {
    const s = this.stick;
    if (!s || s.id !== e.pointerId) return;
    let dx = e.clientX - s.baseX;
    let dy = e.clientY - s.baseY;
    const dist = Math.hypot(dx, dy);
    // A floating stick: dragging past the rim pulls the base along, so reversing is always one short move.
    if (dist > STICK_RADIUS) {
      const pull = (dist - STICK_RADIUS) / dist;
      s.baseX += dx * pull;
      s.baseY += dy * pull;
      dx = e.clientX - s.baseX;
      dy = e.clientY - s.baseY;
    }
    s.dx = dx;
    s.dy = dy;
    this.drawStick();
  }

  private onUp(id: number): void {
    if (this.stick?.id === id) {
      this.endStick();
      return;
    }
    if (this.firePointers.delete(id) && this.firePointers.size === 0) this.fireButton?.classList.remove('down');
  }

  private endStick(): void {
    this.stick = null;
    this.base?.classList.remove('on');
  }

  private drawStick(): void {
    const s = this.stick;
    if (!s || !this.base || !this.knob) return;
    this.base.style.transform = `translate(${s.baseX - STICK_RADIUS}px, ${s.baseY - STICK_RADIUS}px)`;
    this.knob.style.transform = `translate(${s.dx}px, ${s.dy}px)`;
  }
}
