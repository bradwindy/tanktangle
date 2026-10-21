import '@fontsource/press-start-2p';
import '@fontsource/vt323';
import { BRICK_HP, MAX_HP, MUZZLE, PALETTE, SHIELD_RADIUS, TILE, WALL } from '../shared/constants';
import { cellCenter, emptyMaze, forEachSolidWallNear, hWall, isOuterWall, vWall, wallCount } from '../shared/grid';
import { Ev, tankFlags, type GameEvent } from '../shared/protocol';
import { mulberry32, type Rng } from '../shared/rng';
import { CAUSE_STORM, CRATE_KINDS, Proj, TankFlag, Upgrade, Weapon, WallKind, type Crate, type MazeState, type Rect } from '../shared/types';
import { BLAST, CRATE_NAMES, DEATH_RAY, MINES, PROJ_STATS } from '../shared/weapons';
import { createSfx } from './audio';
import { createRenderer, weaponIcon } from './render';
import { iconSprite } from './render/icons';
import { CELL, ROCKET_SIZE, SpriteBank } from './render/sprites';
import type { AnyEvent, CameraMode, ViewProj, ViewState, ViewTank } from './view';

/** Development lab: every sprite, state, event and banner of the renderer, with stress and perf readouts. */

const stage = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const minimap = document.getElementById('minimap') as HTMLCanvasElement;
const panel = document.getElementById('lab') as HTMLDivElement;
const magnifier = document.createElement('canvas');
magnifier.id = 'magnifier';
magnifier.width = 480;
magnifier.height = 480;
document.body.append(magnifier);
const params = new URLSearchParams(location.search);

const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; height: 100%; background: #08070d; overflow: hidden; color: #e8ecf5; font: 14px VT323, monospace; }
  #stage, #overlay { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
  #overlay { pointer-events: none; }
  #minimap { position: fixed; top: 10px; left: 10px; width: 120px; height: 80px; border: 2px solid #2a2646; border-radius: 4px; }
  #lab { position: fixed; top: 8px; right: 8px; bottom: 8px; width: 300px; overflow: auto; background: rgba(12,10,20,0.88);
    border: 2px solid #2a2646; border-radius: 6px; padding: 8px; box-sizing: border-box; font-size: 16px; }
  #lab.closed { bottom: auto; width: auto; overflow: hidden; }
  #lab.closed > :not(.head) { display: none; }
  #lab h3 { font: 10px "Press Start 2P", monospace; margin: 10px 0 4px; color: #ffe14d; }
  #lab button { font: 15px VT323, monospace; background: #1f1c36; color: #e8ecf5; border: 1px solid #3a3560; border-radius: 3px;
    padding: 2px 6px; margin: 2px; cursor: pointer; }
  #lab button:hover { background: #2f2a4e; }
  #lab button.on { background: #3fd9c0; color: #08070d; }
  #lab .head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  #lab .stats { font-size: 15px; white-space: pre; color: #a6ff4a; }
  #lab .icons { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; background: #1c1930; padding: 4px; }
  #magnifier { position: fixed; left: 8px; bottom: 8px; width: 480px; height: 480px; border: 2px solid #ffe14d; display: none;
    image-rendering: pixelated; background: #000; }
`;
document.head.append(style);

const renderer = createRenderer(stage, overlay, { webgl: !params.has('nogl') });
const sfx = createSfx();
void document.fonts.load('16px "Press Start 2P"');
void document.fonts.load('16px VT323');

type Motion = 'circle' | 'spin' | 'still' | 'drive';

interface LabTank {
  view: ViewTank;
  home: { x: number; y: number };
  motion: Motion;
  phase: number;
  respawnAt: number;
}

const NAMES = ['Bradley', 'Ricochet Rita', 'Gus', 'Mx Boom', 'Tread Lightly', 'Zed', 'Pixel', 'Kai', 'Ash', 'Moss', 'Juno', 'Vex'];

let rng: Rng = mulberry32(7);
let maze: MazeState = buildMaze(14, 9);
let tanks: LabTank[] = [];
let projectiles: ViewProj[] = [];
let crates: Crate[] = [];
let tick = 600;
let nextId = 1;
let mode: CameraMode = 'fit';
let crt = true;
let stormOn = false;
let aimsOn = true;
let paused = false;
let hudInsets = false;
let stress = false;
let focusSeat = 0;
let muted = false;
let pending: { at: number; run: () => void }[] = [];
let wantTanks = 8;
/** Magnifier: copies stage device pixels around a screen point right after each draw, scaled up crisply. */
let magnify = 0;
let magnifyAt: { x: number; y: number } | null = null;

/** A random but repeatable maze: steel outer walls, a mix of steel and brick inside, an open room in the middle. */
function buildMaze(w: number, h: number): MazeState {
  rng = mulberry32(w * 100 + h);
  const m = emptyMaze(w, h);
  const n = wallCount(w, h);
  for (let id = 0; id < n; id++) {
    if (isOuterWall(m, id) || rng() > 0.34) continue;
    const brick = rng() < 0.55;
    m.walls[id] = brick ? WallKind.Brick : WallKind.Steel;
    m.hp[id] = brick ? 1 + Math.floor(rng() * BRICK_HP) : 0;
    if (brick && rng() < 0.5) m.hp[id] = BRICK_HP;
  }
  const rx = Math.floor(w / 2) - 1;
  const ry = Math.floor(h / 2) - 1;
  for (let y = ry; y < ry + 3; y++) {
    for (let x = rx; x < rx + 3; x++) {
      if (y > ry) m.walls[hWall(w, x, y)] = WallKind.None;
      if (x > rx) m.walls[vWall(w, h, x, y)] = WallKind.None;
    }
  }
  return m;
}

function openCells(): { cx: number; cy: number }[] {
  const cells: { cx: number; cy: number }[] = [];
  for (let cy = 0; cy < maze.h; cy++) for (let cx = 0; cx < maze.w; cx++) cells.push({ cx, cy });
  return cells;
}

function tankAt(seat: number, cx: number, cy: number, motion: Motion): LabTank {
  const c = cellCenter(cx, cy);
  const view: ViewTank = {
    seat,
    team: 0,
    x: c.x,
    y: c.y,
    a: rng() * Math.PI * 2,
    hp: MAX_HP,
    alive: true,
    bits: 0,
    steer: 0,
    weapon: Weapon.Gun,
    ammo: 0,
    frozenUntil: 0,
    chargeUntil: 0,
    rc: 0,
    shieldUntil: 0,
    speedUntil: 0,
    aimerUntil: 0,
    protectUntil: 0,
    name: NAMES[seat % NAMES.length]!,
    color: PALETTE[seat % PALETTE.length]!,
    isMe: seat === 0,
    flags: TankFlag.Alive,
  };
  return { view, home: c, motion, phase: rng() * Math.PI * 2, respawnAt: 0 };
}

/** Seats 0..11, each showing a different state. */
function setupTanks(count: number): void {
  const cells = openCells();
  const mid = { cx: Math.floor(maze.w / 2), cy: Math.floor(maze.h / 2) };
  cells.sort((a, b) => Math.hypot(a.cx - mid.cx, a.cy - mid.cy) - Math.hypot(b.cx - mid.cx, b.cy - mid.cy));
  const picks = [cells[0]!, ...cells.filter((_, i) => i > 0 && i % 3 === 0)];
  const motions: Motion[] = ['drive', 'still', 'spin', 'circle', 'still', 'circle', 'still', 'still', 'circle', 'still', 'circle', 'spin'];
  tanks = [];
  for (let seat = 0; seat < count; seat++) {
    const cell = picks[seat % picks.length]!;
    tanks.push(tankAt(seat, cell.cx, cell.cy, motions[seat]!));
  }
  applyStates();
}

function applyStates(): void {
  const far = tick + 1e7;
  for (const t of tanks) {
    const v = t.view;
    switch (v.seat) {
      case 1:
        v.weapon = Weapon.Laser;
        v.shieldUntil = far;
        break;
      case 2:
        v.weapon = Weapon.DeathRay;
        break;
      case 3:
        v.weapon = Weapon.Gatling;
        v.hp = 2;
        break;
      case 4:
        v.weapon = Weapon.Shotgun;
        v.hp = 1;
        break;
      case 5:
        v.weapon = Weapon.Homing;
        v.speedUntil = far;
        break;
      case 6:
        v.weapon = Weapon.Frag;
        v.protectUntil = far;
        break;
      case 7:
        v.weapon = Weapon.Rc;
        v.rc = 99;
        break;
      case 8:
        v.weapon = Weapon.Mines;
        v.aimerUntil = far;
        break;
      case 9:
        v.weapon = Weapon.Laser;
        break;
    }
  }
}

function spawnProjectile(kind: Proj, owner: LabTank, x: number, y: number, a: number): ViewProj {
  const stats = PROJ_STATS[kind];
  const speed = kind === Proj.Mine ? 0 : stats.speed;
  return {
    id: nextId++,
    kind,
    owner: owner.view.seat,
    team: owner.view.team,
    x,
    y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    r: stats.r,
    bornAt: tick,
    dieAt: tick + stats.life,
    bounces: kind === Proj.Bullet ? 6 : stats.bounces,
    deadly: false,
    aux: 0,
    fuseAt: 0,
    hits: 0,
    color: owner.view.color,
    hidden: false,
  };
}

function setupProjectiles(count: number): void {
  projectiles = [];
  const kinds: Proj[] = [Proj.Bullet, Proj.Bullet, Proj.Bullet, Proj.Gatling, Proj.Pellet, Proj.Shrapnel, Proj.Homing, Proj.Frag, Proj.Rc];
  for (let i = 0; i < count; i++) {
    const owner = tanks[i % tanks.length]!;
    const kind = kinds[i % kinds.length]!;
    const cx = Math.floor(rng() * maze.w);
    const cy = Math.floor(rng() * maze.h);
    const c = cellCenter(cx, cy);
    const p = spawnProjectile(kind, owner, c.x + (rng() - 0.5) * 20, c.y + (rng() - 0.5) * 20, rng() * Math.PI * 2);
    if (kind === Proj.Homing) p.aux = i % 2;
    p.dieAt = tick + 100000;
    projectiles.push(p);
  }
  // Mines: mine (owner sees it), an enemy's (faint blink), one triggered.
  const me = tanks[0]!;
  const enemy = tanks[Math.min(8, tanks.length - 1)]!;
  for (const [owner, aux, dx] of [
    [me, 1, -18],
    [enemy, 1, 0],
    [enemy, 2, 18],
    [me, 0, 36],
  ] as const) {
    const p = spawnProjectile(Proj.Mine, owner, me.home.x + dx, me.home.y + TILE, 0);
    p.aux = aux;
    p.dieAt = tick + 1e7;
    if (aux === 2) p.fuseAt = tick + 1e7;
    projectiles.push(p);
  }
}

function setupCrates(): void {
  crates = [];
  const cells = openCells().filter((c) => !tanks.some((t) => Math.abs(t.home.x - cellCenter(c.cx, c.cy).x) < 1 && Math.abs(t.home.y - cellCenter(c.cx, c.cy).y) < 1));
  CRATE_KINDS.forEach((kind, i) => {
    const cell = cells[(i * 7 + 3) % cells.length]!;
    crates.push({ id: nextId++, kind, cx: cell.cx, cy: cell.cy });
  });
}

function reset(w: number, h: number, nTanks: number, nProj: number): void {
  maze = buildMaze(w, h);
  setupTanks(nTanks);
  setupProjectiles(nProj);
  setupCrates();
  pending = [];
  renderer.setMaze(maze);
}

/** Circle vs wall rects: push out and reflect, like the real sim but simpler. */
function stepProjectile(p: ViewProj, dt: number, events: AnyEvent[]): void {
  if (p.kind === Proj.Mine) return;
  const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
  for (let s = 0; s < steps; s++) {
    p.x += (p.vx * dt) / steps;
    p.y += (p.vy * dt) / steps;
    forEachSolidWallNear(maze, p.x, p.y, p.r, (_, r) => {
      const cx = Math.max(r.x0, Math.min(r.x1, p.x));
      const cy = Math.max(r.y0, Math.min(r.y1, p.y));
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy);
      if (d >= p.r) return;
      let nx: number;
      let ny: number;
      if (d > 0.0001) {
        nx = dx / d;
        ny = dy / d;
      } else {
        const pen = [p.x - r.x0, r.x1 - p.x, p.y - r.y0, r.y1 - p.y];
        const k = pen.indexOf(Math.min(...pen));
        nx = k === 0 ? -1 : k === 1 ? 1 : 0;
        ny = k === 2 ? -1 : k === 3 ? 1 : 0;
      }
      p.x = cx + nx * (p.r + 0.01);
      p.y = cy + ny * (p.r + 0.01);
      const dot = p.vx * nx + p.vy * ny;
      if (dot < 0) {
        p.vx -= 2 * dot * nx;
        p.vy -= 2 * dot * ny;
        events.push({ e: 'bounce', x: p.x, y: p.y, kind: p.kind });
      }
    });
  }
}

/** A reflecting zero-width ray, for aim guides and lab laser beams. */
function tracePath(x: number, y: number, a: number, reflections: number, maxLen: number): number[] {
  const pts = [x, y];
  let dx = Math.cos(a);
  let dy = Math.sin(a);
  let len = 0;
  const solidAt = (px: number, py: number) => {
    let hit = false;
    forEachSolidWallNear(maze, px, py, 0, (_, r) => {
      if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) hit = true;
    });
    return hit;
  };
  while (len < maxLen && pts.length / 2 <= reflections + 1) {
    const nx = x + dx;
    const ny = y + dy;
    if (solidAt(nx, ny)) {
      const hitX = solidAt(nx, y);
      const hitY = solidAt(x, ny);
      if (hitX || !hitY) dx = -dx;
      if (hitY || !hitX) dy = -dy;
      pts.push(Math.round(x), Math.round(y));
      continue;
    }
    x = nx;
    y = ny;
    len++;
  }
  pts.push(Math.round(x), Math.round(y));
  return pts;
}

function moveTanks(dt: number, time: number): void {
  for (const t of tanks) {
    const v = t.view;
    if (!v.alive) {
      if (t.respawnAt && time >= t.respawnAt) {
        t.respawnAt = 0;
        v.alive = true;
        v.hp = MAX_HP;
        v.x = t.home.x;
        v.y = t.home.y;
        v.protectUntil = tick + 120;
        emit({ e: Ev.Spawn, seat: v.seat, x: v.x, y: v.y, a: v.a });
      }
      continue;
    }
    if (paused) continue;
    t.phase += dt;
    switch (t.motion) {
      case 'circle': {
        const w = v.speedUntil > tick ? 1.6 : 1.1;
        v.x = t.home.x + Math.cos(t.phase * w) * 10;
        v.y = t.home.y + Math.sin(t.phase * w) * 10;
        v.a = t.phase * w + Math.PI / 2;
        break;
      }
      case 'spin':
        v.a += dt * 1.6;
        break;
      case 'drive': {
        v.x = t.home.x + Math.sin(t.phase * 0.9) * 12;
        v.y = t.home.y;
        v.a = Math.cos(t.phase * 0.9) >= 0 ? 0 : Math.PI;
        break;
      }
      case 'still':
        break;
    }
  }
}

const events: AnyEvent[] = [];
function emit(ev: AnyEvent): void {
  events.push(ev);
}

function later(seconds: number, run: () => void): void {
  pending.push({ at: clock + seconds, run });
}

function viewState(): ViewState {
  const focusTank = tanks.find((t) => t.view.seat === focusSeat && t.view.alive) ?? tanks.find((t) => t.view.alive);
  const me = tanks[0]!.view;
  for (const t of tanks) {
    t.view.flags = tankFlags(t.view, tick) | (t.view.seat === 3 && !paused ? TankFlag.Spinning : 0);
    if (!t.view.alive) t.view.flags &= ~TankFlag.Alive;
  }
  const aims: number[][] = [];
  if (aimsOn && me.alive) {
    aims.push(tracePath(me.x + Math.cos(me.a) * MUZZLE, me.y + Math.sin(me.a) * MUZZLE, me.a, 3, 500));
  }
  return {
    tick,
    phase: 'playing',
    maze,
    tanks: tanks.map((t) => t.view),
    projectiles,
    crates,
    storm: stormOn ? stormRect() : null,
    me: 0,
    focus: focusTank ? { x: focusTank.view.x, y: focusTank.view.y } : null,
    aims,
    countdown: 0,
  };
}

function stormRect(): Rect {
  const w = maze.w * TILE;
  const h = maze.h * TILE;
  const k = 0.18 + 0.1 * Math.sin(clock * 0.4);
  return { x0: w * k, y0: h * k, x1: w * (1 - k), y1: h * (1 - k) };
}

function me(): LabTank {
  return tanks[0]!;
}

function muzzleOf(t: LabTank): { x: number; y: number; a: number } {
  const v = t.view;
  return { x: v.x + Math.cos(v.a) * MUZZLE, y: v.y + Math.sin(v.a) * MUZZLE, a: v.a };
}

function randomTank(): LabTank {
  const alive = tanks.filter((t) => t.view.alive && t.view.seat !== 0);
  return alive[Math.floor(Math.random() * alive.length)] ?? me();
}

function fireWeapon(weapon: Weapon): void {
  const t = me();
  t.view.weapon = weapon;
  const m = muzzleOf(t);
  emit({ e: Ev.Fire, seat: 0, weapon, x: m.x, y: m.y, a: m.a });
  switch (weapon) {
    case Weapon.Gun:
      projectiles.push(spawnProjectile(Proj.Bullet, t, m.x, m.y, m.a));
      break;
    case Weapon.Gatling:
      for (let i = 0; i < 6; i++) {
        later(i * 0.08, () => {
          const mm = muzzleOf(t);
          emit({ e: Ev.Fire, seat: 0, weapon, x: mm.x, y: mm.y, a: mm.a });
          projectiles.push(spawnProjectile(Proj.Gatling, t, mm.x, mm.y, mm.a + (Math.random() - 0.5) * 0.24));
        });
      }
      break;
    case Weapon.Shotgun:
      for (let i = 0; i < 9; i++) projectiles.push(spawnProjectile(Proj.Pellet, t, m.x, m.y, m.a - 0.35 + (i / 8) * 0.7));
      break;
    case Weapon.Laser:
      emit({ e: Ev.Beam, seat: 0, weapon, pts: tracePath(m.x, m.y, m.a, 6, 900) });
      t.view.frozenUntil = tick + 12;
      break;
    case Weapon.Homing: {
      const p = spawnProjectile(Proj.Homing, t, m.x, m.y, m.a);
      projectiles.push(p);
      later(1.5, () => (p.aux = 1));
      break;
    }
    case Weapon.Frag: {
      const p = spawnProjectile(Proj.Frag, t, m.x, m.y, m.a);
      p.dieAt = tick + 150;
      projectiles.push(p);
      later(2.5, () => detonate(p, Weapon.Frag));
      break;
    }
    case Weapon.Mines: {
      const rear = { x: t.view.x - Math.cos(t.view.a) * 12, y: t.view.y - Math.sin(t.view.a) * 12 };
      const p = spawnProjectile(Proj.Mine, t, rear.x, rear.y, 0);
      projectiles.push(p);
      later(MINES.armTicks / 60, () => (p.aux = 1));
      break;
    }
    case Weapon.DeathRay:
      t.view.chargeUntil = tick + DEATH_RAY.chargeTicks;
      emit({ e: Ev.Charge, seat: 0 });
      later(DEATH_RAY.chargeTicks / 60, () => {
        const mm = muzzleOf(t);
        t.view.chargeUntil = 0;
        emit({ e: Ev.Fire, seat: 0, weapon, x: mm.x, y: mm.y, a: mm.a });
        emit({ e: Ev.Beam, seat: 0, weapon, pts: deathRayPath(mm.x, mm.y, mm.a, randomTank().view) });
      });
      break;
    case Weapon.Rc: {
      const p = spawnProjectile(Proj.Rc, t, m.x, m.y, m.a);
      p.dieAt = tick + 240;
      projectiles.push(p);
      t.view.rc = p.id;
      later(3, () => {
        t.view.rc = 0;
        detonate(p, Weapon.Rc);
      });
      break;
    }
  }
}

function deathRayPath(x: number, y: number, a: number, target: { x: number; y: number }): number[] {
  const pts = [x, y];
  let ang = a;
  for (let d = 0; d < 700; d += 16) {
    const want = Math.atan2(target.y - y, target.x - x);
    const diff = Math.atan2(Math.sin(want - ang), Math.cos(want - ang));
    if (Math.abs(diff) < DEATH_RAY.seekCone) ang += Math.max(-0.064, Math.min(0.064, diff));
    x += Math.cos(ang) * 16;
    y += Math.sin(ang) * 16;
    if (x < 0 || y < 0 || x > maze.w * TILE || y > maze.h * TILE) break;
    pts.push(Math.round(x), Math.round(y));
  }
  return pts;
}

function detonate(p: ViewProj, kind: Weapon): void {
  const i = projectiles.indexOf(p);
  if (i < 0) return;
  projectiles.splice(i, 1);
  const blast = BLAST[kind];
  emit({ e: Ev.Boom, x: p.x, y: p.y, r: blast?.r ?? 24, kind });
  const owner = tanks.find((t) => t.view.seat === p.owner) ?? me();
  for (let k = 0; k < (blast?.shrapnel ?? 0); k++) {
    const s = spawnProjectile(Proj.Shrapnel, owner, p.x, p.y, (k / (blast?.shrapnel ?? 1)) * Math.PI * 2);
    projectiles.push(s);
  }
}

function killTank(t: LabTank, self = false): void {
  if (!t.view.alive) return;
  emit({ e: Ev.Death, seat: t.view.seat, by: self ? -1 : 0, cause: Weapon.Gun, x: t.view.x, y: t.view.y, self });
  t.view.alive = false;
  t.respawnAt = clock + 2;
}

/** A brick near the middle with at least `target` hp, or a broken one when target is 0. */
function brickNear(target: number): number {
  const n = wallCount(maze.w, maze.h);
  const mid = cellCenter(Math.floor(maze.w / 2), Math.floor(maze.h / 2));
  let best = -1;
  let bestD = Infinity;
  for (let id = 0; id < n; id++) {
    if (maze.walls[id] !== WallKind.Brick) continue;
    const hp = maze.hp[id]!;
    if (hp < target || (target === 0 && hp !== 0)) continue;
    const isH = id < maze.w * (maze.h + 1);
    const x = isH ? (id % maze.w) * TILE + TILE / 2 : ((id - maze.w * (maze.h + 1)) % (maze.w + 1)) * TILE;
    const y = isH ? Math.floor(id / maze.w) * TILE : Math.floor((id - maze.w * (maze.h + 1)) / (maze.w + 1)) * TILE + TILE / 2;
    const d = Math.hypot(x - mid.x, y - mid.y) + Math.random() * 60;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function setBrick(id: number, hp: number): void {
  if (id < 0) return;
  maze.hp[id] = hp;
  renderer.wallChanged(id);
  emit({ e: Ev.Brick, wall: id, hp });
}

const eventButtons: [string, () => void][] = [
  ['Hit me', () => emit({ e: Ev.Hit, seat: 0, by: 1, x: me().view.x + 4, y: me().view.y - 3, dmg: 1 })],
  [
    'Hit other',
    () => {
      const t = randomTank();
      emit({ e: Ev.Hit, seat: t.view.seat, by: 0, x: t.view.x - 3, y: t.view.y, dmg: 1 + Math.floor(Math.random() * 3) });
    },
  ],
  ['Kill other', () => killTank(randomTank())],
  ['Kill me', () => killTank(me())],
  ['Self kill', () => killTank(randomTank(), true)],
  [
    'Spawn',
    () => {
      const t = randomTank();
      emit({ e: Ev.Spawn, seat: t.view.seat, x: t.view.x, y: t.view.y, a: t.view.a });
      t.view.protectUntil = tick + 120;
    },
  ],
  [
    'Brick chip',
    () => {
      const id = brickNear(2);
      setBrick(id, (maze.hp[id] ?? 1) - 1);
    },
  ],
  ['Brick break', () => setBrick(brickNear(1), 0)],
  ['Brick regrow', () => setBrick(brickNear(0), BRICK_HP)],
  [
    'Crate spawn',
    () => {
      const cell = openCells()[Math.floor(Math.random() * maze.w * maze.h)]!;
      const kind = CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)]!;
      const c: Crate = { id: nextId++, kind, cx: cell.cx, cy: cell.cy };
      crates.push(c);
      emit({ e: Ev.Crate, id: c.id, kind, cx: c.cx, cy: c.cy });
    },
  ],
  [
    'Pick (me)',
    () => {
      const c = crates.shift();
      if (!c) return;
      emit({ e: Ev.Pick, id: c.id, seat: 0, kind: c.kind });
    },
  ],
  [
    'Pick (other)',
    () => {
      const c = crates.shift();
      if (!c) return;
      emit({ e: Ev.Pick, id: c.id, seat: randomTank().view.seat, kind: c.kind });
    },
  ],
  [
    'Crate lost to storm',
    () => {
      const c = crates.shift();
      if (!c) return;
      emit({ e: Ev.Pick, id: c.id, seat: -1, kind: c.kind });
    },
  ],
  ['Boom homing', () => boomAtRandom(Weapon.Homing)],
  ['Boom frag', () => boomAtRandom(Weapon.Frag)],
  ['Boom mine', () => boomAtRandom(Weapon.Mines)],
  ['Boom RC', () => boomAtRandom(Weapon.Rc)],
  [
    'Block',
    () => {
      const t = tanks[1]!.view;
      emit({ e: Ev.Block, seat: 1, x: t.x + SHIELD_RADIUS * 0.7, y: t.y - SHIELD_RADIUS * 0.7 });
    },
  ],
  [
    'Charge',
    () => {
      const t = tanks[2]!;
      t.view.chargeUntil = tick + DEATH_RAY.chargeTicks;
      emit({ e: Ev.Charge, seat: 2 });
      later(DEATH_RAY.chargeTicks / 60, () => {
        const m = muzzleOf(t);
        t.view.chargeUntil = 0;
        emit({ e: Ev.Fire, seat: 2, weapon: Weapon.DeathRay, x: m.x, y: m.y, a: m.a });
        emit({ e: Ev.Beam, seat: 2, weapon: Weapon.DeathRay, pts: deathRayPath(m.x, m.y, m.a, me().view) });
      });
    },
  ],
  [
    'Trigger mine',
    () => {
      const mine = projectiles.find((p) => p.kind === Proj.Mine && p.aux !== 2);
      if (!mine) return;
      mine.aux = 2;
      mine.fuseAt = tick + MINES.fuseTicks;
      emit({ e: Ev.Trigger, id: mine.id });
      later(MINES.fuseTicks / 60, () => detonate(mine, Weapon.Mines));
    },
  ],
  ['Storm starts', () => emit({ e: Ev.Storm })],
  ['Overtime', () => emit({ e: Ev.Overtime })],
  ['Bounce', () => emit({ e: 'bounce', x: me().view.x + 20, y: me().view.y, kind: Proj.Bullet })],
  ['Expire', () => emit({ e: 'expire', x: me().view.x + 20, y: me().view.y, kind: Proj.Bullet })],
  [
    'Local muzzle',
    () => {
      const m = muzzleOf(me());
      emit({ e: 'muzzle', seat: 0, x: m.x, y: m.y, a: m.a, weapon: me().view.weapon });
    },
  ],
];

function boomAtRandom(kind: Weapon): void {
  const t = randomTank().view;
  emit({ e: Ev.Boom, x: t.x + 14, y: t.y + 10, r: BLAST[kind]?.r ?? 24, kind });
}

const banners: [string, string][] = [
  ['3', '#ffe14d'],
  ['2', '#ffe14d'],
  ['1', '#ffe14d'],
  ['GO!', '#5dff6a'],
  ['DOUBLE KILL', '#ff9a3d'],
  ['TRIPLE KILL', '#ff4d4d'],
  ['RAMPAGE', '#d66bff'],
  ['YOU DIED', '#ff4d4d'],
  ['OVERTIME', '#ff7a2a'],
];

function button(label: string, onClick: () => void, parent: HTMLElement): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    sfx.unlock();
    onClick();
  });
  parent.append(b);
  return b;
}

function toggle(label: string, get: () => boolean, set: (v: boolean) => void, parent: HTMLElement): void {
  const b = button(label, () => {
    set(!get());
    b.classList.toggle('on', get());
  }, parent);
  b.classList.toggle('on', get());
}

function section(title: string): HTMLDivElement {
  const h = document.createElement('h3');
  h.textContent = title;
  const div = document.createElement('div');
  panel.append(h, div);
  return div;
}

const statsEl = document.createElement('div');
function buildPanel(): void {
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('strong');
  title.textContent = 'LAB';
  head.append(title);
  button('hide / show', () => panel.classList.toggle('closed'), head);
  panel.append(head);
  statsEl.className = 'stats';
  panel.append(statsEl);

  const view = section('View');
  toggle('Follow cam', () => mode === 'follow', (v) => {
    mode = v ? 'follow' : 'fit';
    renderer.setCamera(mode);
  }, view);
  toggle('CRT', () => crt, (v) => {
    crt = v;
    renderer.setCrt(v);
  }, view);
  toggle('Storm', () => stormOn, (v) => (stormOn = v), view);
  toggle('Aims', () => aimsOn, (v) => (aimsOn = v), view);
  toggle('Pause motion', () => paused, (v) => (paused = v), view);
  toggle('Slow-mo', () => timeScale < 1, (v) => (timeScale = v ? 0.2 : 1), view);
  toggle('HUD insets', () => hudInsets, (v) => {
    hudInsets = v;
    applyViewport();
  }, view);
  button('Magnifier', () => {
    magnify = magnify === 0 ? 3 : magnify === 3 ? 6 : 0;
    magnifier.style.display = magnify ? 'block' : 'none';
  }, view);
  stage.addEventListener('pointerdown', (e) => {
    if (magnify) magnifyAt = { x: e.clientX, y: e.clientY };
  });
  button('Sprite sheet', () => showSheet(sheetPage >= 3 ? -1 : sheetPage + 1), view);
  button('Next focus', () => {
    magnifyAt = null;
    focusSeat = (focusSeat + 1) % tanks.length;
  }, view);
  button(params.has('nogl') ? 'Use WebGL' : 'Use 2D fallback', () => {
    location.search = params.has('nogl') ? '' : '?nogl';
  }, view);

  const size = section('Maze');
  button('2 tanks (8x5)', () => resetWith(8, 5, 2, 12), size);
  button('8 tanks (14x9)', () => resetWith(14, 9, 8, 40), size);
  button('12 tanks (17x11)', () => resetWith(17, 11, 12, 60), size);
  button('Huge (26x16)', () => resetWith(26, 16, 12, 60), size);
  toggle('STRESS 12 tanks + 150 shots', () => stress, (v) => {
    stress = v;
    if (v) resetWith(17, 11, 12, 150);
    else resetWith(14, 9, 8, 40);
  }, size);

  const fire = section('Fire (my tank)');
  for (const [name, w] of Object.entries(Weapon)) button(name, () => fireWeapon(w), fire);

  const ev = section('Events');
  for (const [label, run] of eventButtons) button(label, run, ev);

  const ban = section('Banners');
  for (const [text, color] of banners) button(text, () => renderer.banner(text, color), ban);
  button('Countdown', () => {
    ['3', '2', '1', 'GO!'].forEach((text, i) =>
      later(i, () => {
        renderer.banner(text, text === 'GO!' ? '#5dff6a' : '#ffe14d');
        sfx.ui(text === 'GO!' ? 'go' : 'count');
      }),
    );
  }, ban);

  const snd = section('Sound');
  button('Unlock audio', () => sfx.unlock(), snd);
  toggle('Mute', () => muted, (v) => {
    muted = v;
    sfx.setMuted(v);
  }, snd);
  for (const s of ['click', 'join', 'leave', 'count', 'go', 'win', 'lose', 'error'] as const) button(s, () => sfx.ui(s), snd);

  const icons = section('weaponIcon()');
  for (const px of [16, 24, 32]) {
    const row = document.createElement('div');
    row.className = 'icons';
    const kinds = [Weapon.Gun, ...CRATE_KINDS, CAUSE_STORM] as const;
    for (const k of kinds) {
      const c = weaponIcon(k, px);
      c.title = k === CAUSE_STORM ? 'Storm' : k === Weapon.Gun ? 'Gun' : CRATE_NAMES[k as Exclude<typeof k, 0 | 99>];
      row.append(c);
    }
    icons.append(row);
  }
  if (window.innerWidth < 700) panel.classList.add('closed');
}

function drawMagnifier(view: ViewState): void {
  const ctx = magnifier.getContext('2d');
  if (!ctx) return;
  const dpr = stage.width / Math.max(1, stage.clientWidth);
  const at = magnifyAt ?? (view.focus ? renderer.worldToScreen(view.focus.x, view.focus.y) : { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  const span = magnifier.width / magnify;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, magnifier.width, magnifier.height);
  ctx.drawImage(stage, at.x * dpr - span / 2, at.y * dpr - span / 2, span, span, 0, 0, magnifier.width, magnifier.height);
  ctx.drawImage(overlay, at.x * dpr - span / 2, at.y * dpr - span / 2, span, span, 0, 0, magnifier.width, magnifier.height);
}

/** Sprite sheet pages for pixel inspection at 4 CSS px per sprite pixel. */
const sheet = document.createElement('canvas');
sheet.style.cssText = 'position:fixed;left:0;top:0;display:none;image-rendering:pixelated;background:#14121f;';
document.body.append(sheet);
let sheetPage = -1;
const sheetSprites = new SpriteBank();

function showSheet(page: number): void {
  sheetPage = page;
  if (page < 0) {
    sheet.style.display = 'none';
    return;
  }
  const zoom = 4;
  const cols = 8;
  const rows = 5;
  sheet.width = cols * CELL;
  sheet.height = rows * CELL;
  sheet.style.width = `${sheet.width * zoom}px`;
  sheet.style.height = `${sheet.height * zoom}px`;
  sheet.style.display = 'block';
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#1c1930';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  const tank = (color: string, variant: number, rot: number, x: number, y: number) => {
    ctx.globalAlpha = 0.42;
    ctx.drawImage(sheetSprites.shadows(), rot * CELL, variant * CELL, CELL, CELL, x + 1, y + 2, CELL, CELL);
    ctx.globalAlpha = 1;
    ctx.drawImage(sheetSprites.body(color), rot * CELL, 0, CELL, CELL, x, y, CELL, CELL);
    ctx.drawImage(sheetSprites.weapons(), rot * CELL, variant * CELL, CELL, CELL, x, y, CELL, CELL);
    ctx.drawImage(sheetSprites.body(color), rot * CELL, 3 * CELL, CELL, CELL, x, y, CELL, CELL);
  };
  if (page <= 1) {
    for (let r = 0; r < rows; r++) {
      const variant = page * 5 + r;
      for (let c = 0; c < cols; c++) tank(PALETTE[(r + page * 5) % PALETTE.length]!, variant, c * 2, c * CELL, r * CELL);
    }
  } else if (page === 2) {
    for (let i = 0; i < PALETTE.length; i++) tank(PALETTE[i]!, 0, i < 8 ? 0 : 8, (i % 8) * CELL, Math.floor(i / 8) * CELL);
    CRATE_KINDS.forEach((k, i) => ctx.drawImage(sheetSprites.crate(k), (i % 8) * CELL + 8, (2 + Math.floor(i / 8)) * CELL + 8));
    const rockets = sheetSprites.rockets(PALETTE[1]!);
    for (let i = 0; i < 8; i++) {
      ctx.drawImage(rockets, i * 4 * ROCKET_SIZE, 0, ROCKET_SIZE, ROCKET_SIZE, i * CELL + 2, 4 * CELL + 2, ROCKET_SIZE, ROCKET_SIZE);
      ctx.drawImage(rockets, i * 4 * ROCKET_SIZE, ROCKET_SIZE, ROCKET_SIZE, ROCKET_SIZE, i * CELL + 16, 4 * CELL + 16, ROCKET_SIZE, ROCKET_SIZE);
    }
  } else {
    const kinds = [Weapon.Gun, ...CRATE_KINDS, CAUSE_STORM] as const;
    kinds.forEach((k, i) => ctx.drawImage(iconSprite(k), (i % 8) * CELL + 10, Math.floor(i / 8) * CELL + 10));
  }
}

function resetWith(w: number, h: number, n: number, shots: number): void {
  wantTanks = n;
  reset(w, h, n, shots);
}

function applyViewport(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.resize();
  if (hudInsets) renderer.setViewport({ x: 0, y: 56, w, h: h - 56 - 72 });
  else renderer.setViewport({ x: 0, y: 0, w, h });
  minimap.style.display = mode === 'follow' || hudInsets ? 'block' : 'none';
}

let clock = 0;
let last = performance.now();
let emaDraw = 0;
let maxDraw = 0;
let frames = 0;
let fpsClock = 0;
let fps = 0;
let stressClock = 0;

function stressEffects(dt: number): void {
  if (!stress) return;
  stressClock += dt;
  while (stressClock > 0.12) {
    stressClock -= 0.12;
    const t = randomTank().view;
    const roll = Math.random();
    if (roll < 0.3) emit({ e: Ev.Boom, x: t.x + (Math.random() - 0.5) * 60, y: t.y + (Math.random() - 0.5) * 60, r: 30, kind: Weapon.Frag });
    else if (roll < 0.6) emit({ e: Ev.Hit, seat: t.seat, by: 0, x: t.x, y: t.y, dmg: 1 });
    else if (roll < 0.7) killTank(randomTank());
    else {
      const m = muzzleOf(randomTank());
      emit({ e: Ev.Fire, seat: 1, weapon: Weapon.Shotgun, x: m.x, y: m.y, a: m.a });
    }
  }
  while (projectiles.length < 150) {
    const owner = randomTank();
    const m = muzzleOf(owner);
    projectiles.push(spawnProjectile(Proj.Bullet, owner, m.x, m.y, m.a + (Math.random() - 0.5)));
  }
}

let timeScale = 1;

function frame(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)) * timeScale;
  last = now;
  step(dt);
  requestAnimationFrame(frame);
}

/** One lab frame: lab sim, events, draw. Returns the whole frame's ms (sim + render + effects). */
function step(dt: number): number {
  const t0 = performance.now();
  clock += dt;
  if (!paused) tick += dt * 60;
  const due = pending.filter((p) => p.at <= clock);
  pending = pending.filter((p) => p.at > clock);
  for (const p of due) p.run();
  moveTanks(dt, clock);
  if (!paused) {
    for (const p of projectiles) {
      stepProjectile(p, dt, events);
      if (p.kind === Proj.Mine && p.aux === 0 && tick - p.bornAt > MINES.armTicks) p.aux = 1;
    }
    projectiles = projectiles.filter((p) => {
      if (tick < p.dieAt) return true;
      if (p.kind === Proj.Frag) {
        emit({ e: Ev.Boom, x: p.x, y: p.y, r: 30, kind: Weapon.Frag });
        return false;
      }
      emit({ e: 'expire', x: p.x, y: p.y, kind: p.kind });
      return false;
    });
  }
  const view = viewState();
  stressEffects(dt);
  const batch = events.splice(0, events.length);
  for (const ev of batch) {
    renderer.event(ev, view);
    sfx.event(ev, view);
  }
  renderer.draw(view, dt);
  if (magnify > 0) drawMagnifier(view);
  sfx.update(view, dt);
  if (mode === 'follow' || hudInsets) renderer.drawMinimap(minimap, view);
  const ms = renderer.stats.drawMs;
  emaDraw = emaDraw * 0.95 + ms * 0.05;
  maxDraw = Math.max(maxDraw * 0.995, ms);
  frames++;
  fpsClock += dt;
  if (fpsClock >= 0.5) {
    fps = Math.round(frames / fpsClock);
    frames = 0;
    fpsClock = 0;
    const s = renderer.stats;
    statsEl.textContent =
      `draw ${emaDraw.toFixed(2)} ms (max ${maxDraw.toFixed(1)})  ${fps} fps\n` +
      `${s.presenter}  scene ${s.sceneW}x${s.sceneH}  scale ${s.scale.toFixed(2)}\n` +
      `tanks ${tanks.length}  shots ${projectiles.length}  particles ${s.particles}\n` +
      `fit ${renderer.fitScale(maze).toFixed(2)}  maze ${maze.w}x${maze.h}  wall ${WALL}`;
  }
  return performance.now() - t0;
}

/**
 * Runs n frames synchronously at 60 Hz with a GPU sync after each, so the numbers hold even when the tab is
 * in the background. Returns average and worst frame ms, split into the renderer's draw and the whole frame.
 */
function bench(n: number): Record<string, number> {
  const gl = stage.getContext('webgl');
  let total = 0;
  let worst = 0;
  let draw = 0;
  let drawWorst = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    step(1 / 60);
    gl?.finish();
    const ms = performance.now() - t0;
    total += ms;
    worst = Math.max(worst, ms);
    draw += renderer.stats.drawMs;
    drawWorst = Math.max(drawWorst, renderer.stats.drawMs);
  }
  return { frames: n, avgFrameMs: total / n, worstFrameMs: worst, avgDrawMs: draw / n, worstDrawMs: drawWorst, particles: renderer.stats.particles, projectiles: projectiles.length };
}

declare global {
  interface Window {
    lab: Record<string, unknown>;
  }
}

window.lab = {
  renderer,
  sfx,
  fire: fireWeapon,
  emit: (ev: GameEvent) => emit(ev),
  reset: resetWith,
  setMode: (m: CameraMode) => {
    mode = m;
    renderer.setCamera(m);
    applyViewport();
  },
  setStress: (v: boolean) => {
    stress = v;
    if (v) resetWith(17, 11, 12, 150);
  },
  stats: () => ({ ...renderer.stats, emaDraw, maxDraw, fps, projectiles: projectiles.length, tanks: tanks.length }),
  upgrade: Upgrade,
  magnify: (factor: number, x?: number, y?: number) => {
    magnify = factor;
    magnifyAt = x === undefined || y === undefined ? null : { x, y };
    magnifier.style.display = factor ? 'block' : 'none';
  },
  focus: (seat: number) => {
    focusSeat = seat;
  },
  pause: (v: boolean) => {
    paused = v;
  },
  tank: (seat: number) => tanks[seat]?.view,
  bench,
  run: (label: string) => eventButtons.find(([l]) => l === label)?.[1](),
  storm: (v: boolean) => {
    stormOn = v;
  },
  slowmo: (k: number) => {
    timeScale = k;
  },
  sheet: showSheet,
  crates: () => crates,
  projectiles: () => projectiles,
};

reset(14, 9, wantTanks, 40);
buildPanel();
applyViewport();
new ResizeObserver(applyViewport).observe(stage);
document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
requestAnimationFrame(frame);
