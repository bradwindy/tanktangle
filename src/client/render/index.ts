import { TILE } from '../../shared/constants';
import { Ev } from '../../shared/protocol';
import type { MazeState, Rect } from '../../shared/types';
import type { AnyEvent, CameraMode, Renderer, ScreenRect, ViewState } from '../view';
import { cameraView, clampAxis, damp, FIT_MARGIN, fitScale, followScale, toScreen, type CameraView, type ViewRect } from './camera';
import { CrateLayer } from './crates';
import { Effects } from './effects';
import { EventFx, type FxContext } from './events';
import { Minimap } from './minimap';
import { Overlay } from './overlay';
import { mix, VOID } from './palette';
import { Particles } from './particles';
import { ctx2d, makeCanvas } from './pixels';
import { createPresenter, type Presenter } from './post';
import { ProjectileLayer } from './projectiles';
import { dottedPath } from './raster';
import { SpriteBank } from './sprites';
import { StormLayer } from './storm';
import { TankLayer } from './tanks';
import { PAD, World } from './world';

export { weaponIcon } from './icons';

export interface RendererOptions {
  /** Set false to force the Canvas 2D fallback (the lab uses it to check the fallback path). */
  webgl?: boolean;
}

/** Diagnostics for the lab: cost of the last draw and live effect counts. */
export interface RendererStats {
  drawMs: number;
  particles: number;
  presenter: 'webgl' | '2d';
  sceneW: number;
  sceneH: number;
  scale: number;
}

const BLOOM = 0.9;
/** Keeps the low-res scene canvas a sane size even if the arena is squeezed into a tiny viewport. */
const MIN_SCALE = 0.35;

class PixelRenderer implements Renderer {
  private presenter: Presenter;
  private scene = makeCanvas(1, 1);
  private sctx = ctx2d(this.scene, false);
  private overlay: Overlay;
  private sprites = new SpriteBank();
  private particles = new Particles();
  private fx = new Effects();
  private world: World;
  private tanks: TankLayer;
  private projs: ProjectileLayer;
  private crates: CrateLayer;
  private storm: StormLayer;
  private events: EventFx;
  private minimap = new Minimap();
  private maze: MazeState | null = null;
  private mode: CameraMode = 'fit';
  private viewport: ScreenRect | null = null;
  private crt = true;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private sizeDirty = true;
  private camX = 0;
  private camY = 0;
  private camReady = false;
  private cam: CameraView = { scale: 1, left: 0, top: 0 };
  private time = 0;
  private motion = 1;
  private errorLogged = false;
  readonly stats: RendererStats = { drawMs: 0, particles: 0, presenter: '2d', sceneW: 0, sceneH: 0, scale: 1 };

  constructor(
    private stage: HTMLCanvasElement,
    overlayCanvas: HTMLCanvasElement,
    options: RendererOptions,
  ) {
    this.presenter = createPresenter(stage, options.webgl !== false);
    this.stats.presenter = this.presenter.kind;
    this.overlay = new Overlay(overlayCanvas);
    this.events = new EventFx(this.particles);
    this.world = new World(this.sprites, { regrowStep: (x, y) => this.events.regrowStep(x, y) });
    this.tanks = new TankLayer(this.sprites, this.world, this.particles, this.fx);
    this.projs = new ProjectileLayer(this.sprites, this.particles);
    this.crates = new CrateLayer(this.sprites);
    this.storm = new StormLayer(this.fx, this.particles);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this.sizeDirty = true;
      }).observe(stage);
    }
    globalThis.addEventListener?.('resize', () => {
      this.sizeDirty = true;
    });
    try {
      const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
      const apply = () => {
        this.motion = reduce?.matches ? 0.35 : 1;
      };
      apply();
      reduce?.addEventListener?.('change', apply);
    } catch {
      this.motion = 1;
    }
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts) {
      void fonts.ready.then(() => this.overlay.invalidateText());
      fonts.addEventListener?.('loadingdone', () => this.overlay.invalidateText());
    }
  }

  setMaze(maze: MazeState): void {
    this.maze = maze;
    this.world.setMaze(maze);
    this.tanks.reset();
    this.projs.reset();
    this.crates.reset();
    this.particles.clear();
    this.fx.clear();
    this.minimap.invalidate();
    this.camReady = false;
  }

  wallChanged(id: number): void {
    if (!this.maze) return;
    this.world.wallChanged(id, this.time);
    this.minimap.invalidate();
  }

  event(ev: AnyEvent, view: ViewState): void {
    try {
      if (view.maze !== this.maze) this.setMaze(view.maze);
      if (ev.e === Ev.Brick) this.wallChanged(ev.wall);
      this.events.handle(ev, view, this.fxContext(view));
    } catch (err) {
      this.logOnce('render_event_failed', err);
    }
  }

  private fxContext(view: ViewState): FxContext {
    const me = view.tanks.find((t) => t.isMe && t.alive);
    const lx = me?.x ?? view.focus?.x ?? this.camX;
    const ly = me?.y ?? view.focus?.y ?? this.camY;
    const fitted = this.mode === 'fit';
    return {
      now: this.time,
      particles: this.particles,
      fx: this.fx,
      world: this.world,
      tanks: this.tanks,
      crates: this.crates,
      overlay: this.overlay,
      maze: this.maze,
      motion: this.motion,
      near: (x, y) => {
        const d = Math.hypot(x - lx, y - ly);
        return Math.max(fitted ? 0.45 : 0.25, 1 - d / (fitted ? 600 : 360));
      },
    };
  }

  banner(text: string, color = '#ffe14d'): void {
    this.overlay.showBanner(text, color);
  }

  setCamera(mode: CameraMode): void {
    if (mode !== this.mode) this.camReady = false;
    this.mode = mode;
  }

  setViewport(rect: ScreenRect): void {
    this.viewport = { x: rect.x, y: rect.y, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
  }

  private viewRect(): ViewRect {
    return this.viewport ?? { x: 0, y: 0, w: this.cssW, h: this.cssH };
  }

  fitScale(maze: { w: number; h: number }): number {
    if (this.sizeDirty) this.resize();
    return fitScale(maze.w * TILE, maze.h * TILE, this.viewRect());
  }

  setCrt(on: boolean): void {
    this.crt = on;
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return toScreen(this.cam, x, y);
  }

  resize(): void {
    this.sizeDirty = false;
    const w = this.stage.clientWidth || globalThis.innerWidth || 1;
    const h = this.stage.clientHeight || globalThis.innerHeight || 1;
    this.dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    this.cssW = w;
    this.cssH = h;
    const bw = Math.max(1, Math.round(w * this.dpr));
    const bh = Math.max(1, Math.round(h * this.dpr));
    if (this.stage.width !== bw || this.stage.height !== bh) {
      this.stage.width = bw;
      this.stage.height = bh;
    }
    this.overlay.resize(w, h, this.dpr);
  }

  private updateCamera(view: ViewState, dt: number): void {
    const m = view.maze;
    const ww = m.w * TILE;
    const wh = m.h * TILE;
    const vp = this.viewRect();
    let scale: number;
    let tx: number;
    let ty: number;
    if (this.mode === 'fit') {
      scale = fitScale(ww, wh, vp);
      tx = ww / 2;
      ty = wh / 2;
    } else {
      scale = followScale(vp);
      const f = view.focus ?? { x: ww / 2, y: wh / 2 };
      const halfW = vp.w / 2 / scale;
      const halfH = vp.h / 2 / scale;
      tx = clampAxis(f.x, halfW, -FIT_MARGIN, ww + FIT_MARGIN);
      ty = clampAxis(f.y, halfH, -FIT_MARGIN, wh + FIT_MARGIN);
    }
    if (!this.camReady) {
      this.camX = tx;
      this.camY = ty;
      this.camReady = true;
    } else {
      const k = damp(this.mode === 'fit' ? 12 : 7, dt);
      this.camX += (tx - this.camX) * k;
      this.camY += (ty - this.camY) * k;
    }
    this.cam = cameraView(this.camX + this.fx.offsetX, this.camY + this.fx.offsetY, Math.max(MIN_SCALE, scale), vp);
  }

  draw(view: ViewState, dt: number): void {
    const t0 = performance.now();
    try {
      this.frame(view, Math.min(0.1, Math.max(0, dt)));
    } catch (err) {
      this.logOnce('render_draw_failed', err);
    }
    this.stats.drawMs = performance.now() - t0;
    this.stats.particles = this.particles.count;
  }

  private frame(view: ViewState, dt: number): void {
    if (this.sizeDirty) this.resize();
    if (view.maze !== this.maze) this.setMaze(view.maze);
    this.time += dt;
    const now = this.time;
    this.fx.update(dt, now);
    this.updateCamera(view, dt);
    const m = view.maze;
    const ww = m.w * TILE;
    const wh = m.h * TILE;

    this.crates.update(view.crates, now);
    this.tanks.update(view.tanks, view.tick, dt);
    this.projs.update(view.projectiles, dt);
    const mazeRect: Rect = { x0: 0, y0: 0, x1: ww, y1: wh };
    if (this.storm.update(view.storm, mazeRect, dt)) this.fx.flash('#a6ff4a', 0.05 * this.motion);
    this.world.update(dt, now);
    this.particles.update(dt, (x, y, color) => this.world.speck(x, y, color));
    this.overlay.update(dt);

    const cam = this.cam;
    const sceneW = Math.ceil(this.cssW / cam.scale) + 2;
    const sceneH = Math.ceil(this.cssH / cam.scale) + 2;
    if (this.scene.width !== sceneW || this.scene.height !== sceneH) {
      this.scene.width = sceneW;
      this.scene.height = sceneH;
      this.sctx = ctx2d(this.scene, false);
    }
    const ox = Math.floor(cam.left);
    const oy = Math.floor(cam.top);
    const ctx = this.sctx;
    ctx.setTransform(1, 0, 0, 1, -ox, -oy);
    ctx.globalAlpha = 1;
    ctx.fillStyle = VOID;
    ctx.fillRect(ox, oy, sceneW, sceneH);
    this.world.drawFloor(ctx, ox, oy, sceneW, sceneH);
    this.fx.drawGround(ctx);
    this.world.drawWalls(ctx, now, ox, oy, sceneW, sceneH);
    this.crates.draw(ctx, view.crates, now);
    const meTank = view.tanks.find((t) => t.seat === view.me);
    this.projs.drawMines(ctx, view.projectiles, view.me, meTank?.team ?? 0, view.tick, now);
    this.tanks.draw(ctx, view.tanks, view.tick, now);
    this.projs.drawFlying(ctx, view.projectiles, view.tick, now);
    this.fx.draw(ctx, now);
    this.particles.draw(ctx);
    if (view.storm) {
      const sceneRect: Rect = { x0: -PAD / 2, y0: -PAD / 2, x1: ww + PAD / 2, y1: wh + PAD / 2 };
      this.storm.draw(ctx, view.storm, sceneRect, now);
    }
    this.drawAims(ctx, view, meTank?.color ?? '#ffffff', now);

    const s = this.fx.screen;
    this.presenter.present(this.scene, {
      srcX: cam.left - ox,
      srcY: cam.top - oy,
      srcW: this.cssW / cam.scale,
      srcH: this.cssH / cam.scale,
      scale: cam.scale * this.dpr,
      crt: this.crt,
      bloom: BLOOM,
      flash: s.flash,
      flashColor: s.flashColor,
      hurt: s.hurt,
      aberration: s.aberration,
      time: now,
    });
    this.overlay.draw(view, cam, this.viewRect(), view.phase !== 'attract');
    this.stats.sceneW = sceneW;
    this.stats.sceneH = sceneH;
    this.stats.scale = cam.scale;
  }

  private drawAims(ctx: CanvasRenderingContext2D, view: ViewState, color: string, now: number): void {
    if (view.aims.length === 0) return;
    const offset = (now * 24) % 5;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.translate(1, 1);
    ctx.beginPath();
    for (const pts of view.aims) dottedPath(ctx, pts, 5, offset, 1);
    ctx.fill();
    ctx.translate(-1, -1);
    ctx.fillStyle = mix(color, '#ffffff', 0.55);
    ctx.beginPath();
    for (const pts of view.aims) dottedPath(ctx, pts, 5, offset, 1);
    ctx.fill();
  }

  drawMinimap(canvas: HTMLCanvasElement, view: ViewState): void {
    try {
      const vp = this.viewRect();
      const c = this.cam;
      const window =
        this.mode === 'follow'
          ? { x0: c.left + vp.x / c.scale, y0: c.top + vp.y / c.scale, x1: c.left + (vp.x + vp.w) / c.scale, y1: c.top + (vp.y + vp.h) / c.scale }
          : null;
      this.minimap.draw(canvas, view, window, this.time);
    } catch (err) {
      this.logOnce('render_minimap_failed', err);
    }
  }

  private logOnce(event: string, err: unknown): void {
    if (this.errorLogged) return;
    this.errorLogged = true;
    console.error(JSON.stringify({ event, error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  }
}

export function createRenderer(stage: HTMLCanvasElement, overlay: HTMLCanvasElement, options: RendererOptions = {}): Renderer & { readonly stats: RendererStats } {
  return new PixelRenderer(stage, overlay, options);
}
