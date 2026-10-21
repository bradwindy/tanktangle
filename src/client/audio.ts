import { BRICK_HP, TILE } from '../shared/constants';
import { Ev } from '../shared/protocol';
import { DEATH_RAY } from '../shared/weapons';
import { Proj, TankFlag, Upgrade, Weapon, type CrateKind } from '../shared/types';
import type { AnyEvent, Sfx, UiSound, ViewState } from './view';

/** Synthesised 8-bit sound effects. Every entry point is safe to call before unlock, while muted, or without Web Audio. */

const MASTER = 0.55;
const MAX_VOICES = 48;

type Wave = OscillatorType;

interface Place {
  gain: number;
  pan: number;
}

const CENTRE: Place = { gain: 1, pan: 0 };

/** Minimum ms between two plays of the same sound. */
const THROTTLE: Record<string, number> = {
  ricochet: 32,
  expire: 60,
  hit: 25,
  boom: 45,
  chip: 30,
  fire0: 35,
  fire2: 28,
  pick: 60,
  crate: 80,
  block: 50,
  trigger: 100,
  death: 40,
};

class SynthSfx implements Sfx {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;
  private voices = 0;
  private last = new Map<string, number>();
  private listenerX = 0;
  private listenerY = 0;
  private stormGain: GainNode | null = null;
  private stormFilter: BiquadFilterNode | null = null;
  private spinGain: GainNode | null = null;
  private spinOsc: OscillatorNode | null = null;
  private chargeGain: GainNode | null = null;
  private chargeOsc: OscillatorNode | null = null;
  private chargeOsc2: OscillatorNode | null = null;

  unlock(): void {
    try {
      if (!this.ctx) this.build();
      const ctx = this.ctx;
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
      // iOS only starts output once a buffer plays inside the gesture.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start();
    } catch {
      // Audio is optional: a failed unlock leaves the game silent.
    }
  }

  private build(): void {
    const Ctor =
      globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER;
    master.connect(comp);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(master);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    this.master = master;
    this.bus = bus;
    this.noise = noise;
    this.buildLoops(ctx, bus, noise);
  }

  /** Continuous voices (storm rumble, gatling whirr, death ray charge) that update() fades in and out. */
  private buildLoops(ctx: AudioContext, bus: GainNode, noise: AudioBuffer): void {
    const storm = ctx.createBufferSource();
    storm.buffer = noise;
    storm.loop = true;
    const stormFilter = ctx.createBiquadFilter();
    stormFilter.type = 'lowpass';
    stormFilter.frequency.value = 220;
    stormFilter.Q.value = 0.7;
    const stormGain = ctx.createGain();
    stormGain.gain.value = 0;
    storm.connect(stormFilter).connect(stormGain).connect(bus);
    storm.start();

    const spin = ctx.createOscillator();
    spin.type = 'sawtooth';
    spin.frequency.value = 90;
    const spinTrem = ctx.createOscillator();
    spinTrem.type = 'square';
    spinTrem.frequency.value = 28;
    const spinTremDepth = ctx.createGain();
    spinTremDepth.gain.value = 0.5;
    const spinAmp = ctx.createGain();
    spinAmp.gain.value = 0.5;
    const spinFilter = ctx.createBiquadFilter();
    spinFilter.type = 'bandpass';
    spinFilter.frequency.value = 700;
    spinFilter.Q.value = 1.2;
    const spinGain = ctx.createGain();
    spinGain.gain.value = 0;
    spinTrem.connect(spinTremDepth).connect(spinAmp.gain);
    spin.connect(spinAmp).connect(spinFilter).connect(spinGain).connect(bus);
    spin.start();
    spinTrem.start();

    const charge = ctx.createOscillator();
    charge.type = 'square';
    charge.frequency.value = 150;
    const charge2 = ctx.createOscillator();
    charge2.type = 'sawtooth';
    charge2.frequency.value = 152;
    const chargeFilter = ctx.createBiquadFilter();
    chargeFilter.type = 'lowpass';
    chargeFilter.frequency.value = 2400;
    const chargeGain = ctx.createGain();
    chargeGain.gain.value = 0;
    charge.connect(chargeFilter);
    charge2.connect(chargeFilter);
    chargeFilter.connect(chargeGain).connect(bus);
    charge.start();
    charge2.start();

    this.stormGain = stormGain;
    this.stormFilter = stormFilter;
    this.spinGain = spinGain;
    this.spinOsc = spin;
    this.chargeGain = chargeGain;
    this.chargeOsc = charge;
    this.chargeOsc2 = charge2;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.02);
    } catch {
      // ignore
    }
  }

  private ready(): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running' || !this.bus) return null;
    return ctx;
  }

  private allow(key: string): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const gap = THROTTLE[key] ?? 12;
    const now = ctx.currentTime * 1000;
    const prev = this.last.get(key) ?? -1e9;
    if (now - prev < gap) return false;
    this.last.set(key, now);
    return true;
  }

  /** Volume and stereo position of a world point relative to the listener. */
  private place(x: number, y: number): Place {
    const dx = x - this.listenerX;
    const dy = y - this.listenerY;
    const d = Math.hypot(dx, dy);
    const gain = Math.max(0.12, 1 / (1 + (d / 240) ** 2));
    return { gain, pan: Math.max(-0.75, Math.min(0.75, dx / 360)) };
  }

  /** A gain + panner chain into the bus that disconnects itself when its sources end. */
  private output(ctx: AudioContext, place: Place): AudioNode {
    const g = ctx.createGain();
    g.gain.value = place.gain;
    if (place.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = place.pan;
      g.connect(p).connect(this.bus!);
    } else {
      g.connect(this.bus!);
    }
    return g;
  }

  private track(src: AudioScheduledSourceNode, chain: AudioNode[]): void {
    this.voices++;
    src.onended = () => {
      this.voices--;
      for (const n of chain) n.disconnect();
    };
  }

  private tone(out: AudioNode, wave: Wave, f0: number, f1: number, dur: number, vol: number, at = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    this.track(osc, [osc, env]);
  }

  private hiss(out: AudioNode, type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, at = 0, q = 0.9): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.03);
    this.track(src, [src, filter, env]);
  }

  private play(key: string, place: Place, build: (out: AudioNode) => void, essential = true): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (!essential && this.voices > MAX_VOICES) return;
    if (this.voices > MAX_VOICES * 2) return;
    if (!this.allow(key)) return;
    try {
      build(this.output(ctx, place));
    } catch {
      // A failed sound is never worth an exception in the game loop.
    }
  }

  event(ev: AnyEvent, view: ViewState): void {
    try {
      this.setListener(view);
      this.handle(ev, view);
    } catch {
      // ignore
    }
  }

  private handle(ev: AnyEvent, view: ViewState): void {
    switch (ev.e) {
      case 'muzzle':
      case Ev.Fire:
        this.fire(ev.weapon, this.place(ev.x, ev.y));
        return;
      case 'bounce':
        if (ev.kind === Proj.Mine) return;
        this.play(
          'ricochet',
          this.place(ev.x, ev.y),
          (o) => {
            const f = 1300 + Math.random() * 900;
            this.tone(o, 'triangle', f, f * 0.72, 0.06, ev.kind === Proj.Bullet ? 0.12 : 0.07);
          },
          false,
        );
        return;
      case 'expire':
        if (ev.kind === Proj.Bullet || ev.kind === Proj.Gatling || ev.kind === Proj.Pellet) {
          this.play('expire', this.place(ev.x, ev.y), (o) => this.hiss(o, 'highpass', 3000, 3000, 0.05, 0.05), false);
        }
        return;
      case Ev.Hit: {
        const mine = view.tanks.find((t) => t.seat === ev.seat)?.isMe ?? false;
        this.play('hit', mine ? CENTRE : this.place(ev.x, ev.y), (o) => {
          this.hiss(o, 'bandpass', 2200, 900, 0.09, 0.32, 0, 1.2);
          this.tone(o, 'square', mine ? 180 : 320, mine ? 50 : 90, mine ? 0.2 : 0.12, mine ? 0.3 : 0.18);
        });
        return;
      }
      case Ev.Death:
        this.play('death', this.place(ev.x, ev.y), (o) => {
          this.hiss(o, 'lowpass', 4200, 140, 1.1, 0.75, 0, 0.6);
          this.tone(o, 'sine', 95, 28, 0.7, 0.7);
          this.tone(o, 'square', 70, 32, 0.32, 0.16);
          this.hiss(o, 'bandpass', 1400, 400, 0.25, 0.3, 0.12, 2);
        });
        return;
      case Ev.Spawn:
        this.play('spawn', this.place(ev.x, ev.y), (o) => {
          this.tone(o, 'square', 220, 880, 0.28, 0.07);
          this.tone(o, 'triangle', 440, 1760, 0.34, 0.11);
          this.tone(o, 'triangle', 1760, 1760, 0.12, 0.06, 0.3);
        });
        return;
      case Ev.Brick:
        this.brick(ev.hp);
        return;
      case Ev.Crate:
        this.play('crate', CENTRE, (o) => {
          this.tone(o, 'triangle', 1320, 1320, 0.1, 0.07);
          this.tone(o, 'triangle', 1760, 1760, 0.16, 0.06, 0.06);
        });
        return;
      case Ev.Pick:
        this.pick(ev.kind, ev.seat, view);
        return;
      case Ev.Boom:
        this.play('boom', this.place(ev.x, ev.y), (o) => {
          const r = ev.r;
          this.hiss(o, 'lowpass', 3200, 110, 0.4 + r / 60, 0.4 + r / 90, 0, 0.7);
          this.tone(o, 'sine', 110, 30, 0.35 + r / 120, 0.5);
          if (ev.kind === Weapon.Mines) this.hiss(o, 'highpass', 2500, 2500, 0.06, 0.3);
        });
        return;
      case Ev.Beam: {
        const n = ev.pts.length;
        const end = n >= 2 ? this.place(ev.pts[n - 2]!, ev.pts[n - 1]!) : CENTRE;
        if (ev.weapon === Weapon.DeathRay) {
          this.play('beam7', end, (o) => this.hiss(o, 'bandpass', 1800, 300, 0.6, 0.32, 0, 1.5));
        } else {
          this.play('beam1', end, (o) => this.hiss(o, 'highpass', 4000, 2000, 0.14, 0.12));
        }
        return;
      }
      case Ev.Block:
        this.play('block', this.place(ev.x, ev.y), (o) => {
          this.tone(o, 'triangle', 900, 1500, 0.12, 0.16);
          this.tone(o, 'sine', 1900, 1700, 0.22, 0.07, 0.02);
        });
        return;
      case Ev.Charge: {
        const t = view.tanks.find((q) => q.seat === ev.seat);
        this.play('charge', t ? this.place(t.x, t.y) : CENTRE, (o) => this.tone(o, 'sawtooth', 110, 320, 0.22, 0.1));
        return;
      }
      case Ev.Trigger: {
        const mine = view.projectiles.find((q) => q.id === ev.id);
        this.play('trigger', mine ? this.place(mine.x, mine.y) : CENTRE, (o) => {
          for (let i = 0; i < 3; i++) this.tone(o, 'square', 1500, 1500, 0.05, 0.14, i * 0.09);
        });
        return;
      }
      case Ev.Storm:
        this.play('storm', CENTRE, (o) => {
          this.hiss(o, 'lowpass', 900, 90, 1.8, 0.65, 0, 0.8);
          this.tone(o, 'sine', 55, 32, 1, 0.35);
          this.hiss(o, 'highpass', 3000, 1200, 0.15, 0.4);
        });
        return;
      case Ev.Overtime:
        this.play('overtime', CENTRE, (o) => {
          for (let i = 0; i < 4; i++) this.tone(o, 'square', i % 2 ? 900 : 600, i % 2 ? 900 : 600, 0.12, 0.1, i * 0.14);
        });
        return;
    }
  }

  private fire(weapon: Weapon, place: Place): void {
    switch (weapon) {
      case Weapon.Gatling:
        this.play('fire2', place, (o) => {
          this.tone(o, 'square', 1300, 520, 0.045, 0.09);
          this.hiss(o, 'bandpass', 3200, 2000, 0.035, 0.12, 0, 1.5);
        });
        return;
      case Weapon.Shotgun:
        this.play('fire3', place, (o) => {
          this.hiss(o, 'lowpass', 2600, 260, 0.28, 0.55, 0, 0.6);
          this.tone(o, 'triangle', 130, 40, 0.22, 0.45);
          this.tone(o, 'square', 300, 80, 0.06, 0.12);
        });
        return;
      case Weapon.Laser:
        this.play('fire1', place, (o) => {
          this.tone(o, 'sawtooth', 1900, 110, 0.3, 0.17);
          this.tone(o, 'square', 2600, 260, 0.2, 0.06);
          this.hiss(o, 'highpass', 5000, 2500, 0.12, 0.1);
        });
        return;
      case Weapon.Homing:
      case Weapon.Rc:
        this.play('fire4', place, (o) => {
          this.hiss(o, 'bandpass', 400, 2600, 0.45, 0.3, 0, 1.2);
          this.tone(o, 'square', 190, 85, 0.16, 0.12);
          if (weapon === Weapon.Rc) this.tone(o, 'square', 1200, 1200, 0.05, 0.06, 0.12);
        });
        return;
      case Weapon.Frag:
        this.play('fire5', place, (o) => {
          this.tone(o, 'triangle', 240, 60, 0.2, 0.45);
          this.hiss(o, 'lowpass', 700, 300, 0.12, 0.25);
        });
        return;
      case Weapon.Mines:
        this.play('fire6', place, (o) => {
          this.tone(o, 'triangle', 700, 690, 0.05, 0.14);
          this.tone(o, 'triangle', 440, 430, 0.09, 0.14, 0.07);
        });
        return;
      case Weapon.DeathRay:
        this.play('fire7', place, (o) => {
          this.tone(o, 'sawtooth', 95, 38, 0.95, 0.3);
          this.tone(o, 'square', 1700, 55, 0.65, 0.12);
          this.hiss(o, 'lowpass', 3500, 180, 0.9, 0.45, 0, 0.8);
        });
        return;
      default:
        this.play('fire0', place, (o) => {
          const f = 840 + Math.random() * 80;
          this.tone(o, 'square', f, 210, 0.09, 0.15);
          this.hiss(o, 'highpass', 2500, 2500, 0.03, 0.06);
        });
    }
  }

  private brick(hp: number): void {
    if (hp >= BRICK_HP) {
      this.play('regrow', CENTRE, (o) => {
        [330, 440, 554].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.07, 0.05, i * 0.05));
      });
    } else if (hp === 0) {
      this.play('break', CENTRE, (o) => {
        this.hiss(o, 'bandpass', 900, 260, 0.36, 0.45, 0, 1);
        this.tone(o, 'triangle', 130, 55, 0.22, 0.3);
        for (let i = 1; i <= 3; i++) this.hiss(o, 'bandpass', 1500, 900, 0.05, 0.18, i * 0.07, 2);
      });
    } else {
      this.play(
        'chip',
        CENTRE,
        (o) => {
          this.hiss(o, 'bandpass', 1300, 800, 0.07, 0.26, 0, 1.4);
          this.tone(o, 'triangle', 320, 200, 0.05, 0.12);
        },
        false,
      );
    }
  }

  private pick(kind: CrateKind, seat: number, view: ViewState): void {
    const t = view.tanks.find((q) => q.seat === seat);
    const place = t?.isMe ? CENTRE : t ? this.place(t.x, t.y) : CENTRE;
    if (seat < 0) {
      this.play('pick', place, (o) => this.hiss(o, 'bandpass', 2400, 600, 0.25, 0.18, 0, 2));
      return;
    }
    const upgrade = kind >= Upgrade.Shield;
    this.play('pick', place, (o) => {
      if (kind === Upgrade.Repair) {
        this.tone(o, 'sine', 440, 880, 0.25, 0.14);
        [1047, 1319, 1568].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.1, 0.07, 0.12 + i * 0.06));
      } else if (upgrade) {
        [660, 880, 1320, 1760].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.09, 0.09, i * 0.05));
      } else {
        this.hiss(o, 'bandpass', 1800, 1800, 0.04, 0.25, 0, 2);
        this.tone(o, 'square', 220, 220, 0.05, 0.1, 0.05);
        [440, 660, 880].forEach((f, i) => this.tone(o, 'square', f, f, 0.08, 0.08, 0.1 + i * 0.05));
      }
    });
  }

  ui(sound: UiSound): void {
    try {
      switch (sound) {
        case 'click':
          this.play('ui-click', CENTRE, (o) => this.tone(o, 'square', 1200, 1100, 0.03, 0.07));
          return;
        case 'join':
          this.play('ui-join', CENTRE, (o) => {
            this.tone(o, 'triangle', 660, 660, 0.08, 0.14);
            this.tone(o, 'triangle', 990, 990, 0.1, 0.12, 0.07);
          });
          return;
        case 'leave':
          this.play('ui-leave', CENTRE, (o) => this.tone(o, 'triangle', 660, 330, 0.16, 0.13));
          return;
        case 'count':
          this.play('ui-count', CENTRE, (o) => this.tone(o, 'square', 440, 440, 0.12, 0.12));
          return;
        case 'go':
          this.play('ui-go', CENTRE, (o) => {
            this.tone(o, 'square', 880, 880, 0.35, 0.13);
            this.tone(o, 'square', 1320, 1320, 0.35, 0.05);
          });
          return;
        case 'win':
          this.play('ui-win', CENTRE, (o) => {
            [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(o, 'square', f, f, 0.24, 0.1, i * 0.11));
          });
          return;
        case 'lose':
          this.play('ui-lose', CENTRE, (o) => {
            [392, 370, 349, 262].forEach((f, i) => this.tone(o, 'sawtooth', f, f * 0.98, 0.26, 0.08, i * 0.18));
          });
          return;
        case 'error':
          this.play('ui-error', CENTRE, (o) => {
            this.tone(o, 'square', 200, 200, 0.12, 0.1);
            this.tone(o, 'square', 150, 150, 0.16, 0.1, 0.12);
          });
          return;
      }
    } catch {
      // ignore
    }
  }

  private setListener(view: ViewState): void {
    const me = view.tanks.find((t) => t.isMe && t.alive);
    const p = me ?? view.focus;
    if (p) {
      this.listenerX = p.x;
      this.listenerY = p.y;
    } else {
      this.listenerX = (view.maze.w * TILE) / 2;
      this.listenerY = (view.maze.h * TILE) / 2;
    }
  }

  update(view: ViewState): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      this.setListener(view);
      const now = ctx.currentTime;
      const active = view.phase === 'playing' || view.phase === 'countdown';
      let storm = 0;
      if (active && view.storm) {
        const s = view.storm;
        const x = this.listenerX;
        const y = this.listenerY;
        const inside = x > s.x0 && x < s.x1 && y > s.y0 && y < s.y1;
        const edge = inside ? Math.min(x - s.x0, s.x1 - x, y - s.y0, s.y1 - y) : 0;
        const close = 1 - Math.min(1, edge / 160);
        storm = 0.05 + 0.32 * close;
        this.stormFilter?.frequency.setTargetAtTime(160 + close * 520, now, 0.2);
      }
      this.stormGain?.gain.setTargetAtTime(storm, now, 0.35);

      let spin = 0;
      let charge = 0;
      let progress = 0;
      if (active) {
        for (const t of view.tanks) {
          if (!t.alive) continue;
          if (t.flags & TankFlag.Spinning) spin = Math.max(spin, this.place(t.x, t.y).gain);
          if (t.flags & TankFlag.Charging) {
            const g = this.place(t.x, t.y).gain;
            if (g > charge) {
              charge = g;
              progress = Math.min(1, Math.max(0, 1 - (t.chargeUntil - view.tick) / DEATH_RAY.chargeTicks));
            }
          }
        }
      }
      this.spinGain?.gain.setTargetAtTime(spin * 0.09, now, 0.05);
      if (spin > 0) this.spinOsc?.frequency.setTargetAtTime(110, now, 0.1);
      this.chargeGain?.gain.setTargetAtTime(charge * 0.075, now, 0.04);
      if (charge > 0) {
        const f = 140 + 1100 * progress ** 1.6;
        this.chargeOsc?.frequency.setTargetAtTime(f, now, 0.03);
        this.chargeOsc2?.frequency.setTargetAtTime(f * 1.012, now, 0.03);
      }
    } catch {
      // ignore
    }
  }
}

export function createSfx(): Sfx {
  return new SynthSfx();
}
