import '@fontsource/press-start-2p';
import '@fontsource/vt323';
import './style.css';
import { CODE_ALPHABET, CODE_LENGTH } from '../shared/constants';
import { normalizeCode, sanitizeName } from '../shared/protocol';
import { Attract } from './attract';
import { createSfx } from './audio';
import { storageGet, storageSet } from './dom';
import { Hud } from './hud';
import { Controls } from './input';
import { createRenderer } from './render';
import { Session } from './session';
import { Ui, type UiHandlers } from './ui';
import type { ViewState } from './view';

const NAME_KEY = 'tanktangle:name';
const PID_KEY = 'tanktangle:pid';
const MUTE_KEY = 'tanktangle:muted';
const CRT_KEY = 'tanktangle:crt';
/** Phones get the follow camera when their short side is below this (CSS px). */
const FOLLOW_BELOW = 700;
const ROOM_PATH = /^\/r\/([^/]+)\/?$/;

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

let memoryPid = '';
/** The secret reconnect id: per tab (sessionStorage), so a reload keeps the seat and a second tab is a new player. */
function playerId(): string {
  let pid = storageGet('session', PID_KEY) || memoryPid;
  if (!pid) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    pid = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    storageSet('session', PID_KEY, pid);
  }
  memoryPid = pid;
  return pid;
}

const savedName = () => sanitizeName(storageGet('local', NAME_KEY));
const saveName = (name: string) => storageSet('local', NAME_KEY, sanitizeName(name));

const stage = document.getElementById('stage') as HTMLCanvasElement;
const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const prefs = { muted: storageGet('local', MUTE_KEY) === '1', crt: storageGet('local', CRT_KEY) !== '0' };
const renderer = createRenderer(stage, overlayCanvas);
const sfx = createSfx();
sfx.setMuted(prefs.muted);
renderer.setCrt(prefs.crt);

let session: Session | null = null;
let attract: Attract | null = null;
let pendingCode = '';
let lastPointer = '';

const controls = new Controls({
  menu: () => {
    if (session) ui.toggleMenu();
  },
  cleared: () => session?.idle(),
  gesture: () => sfx.unlock(),
});

const hud = new Hud(uiRoot, {
  menu: () => ui.toggleMenu(),
  cycle: () => session?.cycleSpectate(),
});
controls.attachTouch(hud.touchLayer, hud.stickBase, hud.stickKnob, hud.fireButton);

const handlers: UiHandlers = {
  create(name) {
    saveName(name);
    const code = randomCode();
    history.pushState(null, '', `/r/${code}`);
    enterRoom(code, name);
  },
  join(raw, name) {
    const code = normalizeCode(raw);
    if (!code) {
      ui.showHome(name, `Room codes are ${CODE_LENGTH} letters and numbers.`);
      return;
    }
    saveName(name);
    history.pushState(null, '', `/r/${code}`);
    enterRoom(code, name);
  },
  enter(name) {
    saveName(name);
    enterRoom(pendingCode, name);
  },
  leave() {
    history.pushState(null, '', '/');
    route();
  },
  settings: (s) => session?.settings(s),
  start: () => session?.start(),
  again: () => session?.again(),
  addBot: (level) => session?.addBot(level),
  removeBot: (id) => session?.removeBot(id),
  team: (team) => session?.team(team),
  mute() {
    prefs.muted = !prefs.muted;
    sfx.setMuted(prefs.muted);
    storageSet('local', MUTE_KEY, prefs.muted ? '1' : '0');
    return prefs.muted;
  },
  crt() {
    prefs.crt = !prefs.crt;
    renderer.setCrt(prefs.crt);
    storageSet('local', CRT_KEY, prefs.crt ? '1' : '0');
    return prefs.crt;
  },
};
const ui = new Ui(uiRoot, handlers, prefs);

const roomState = () => (session ? { code: session.code, room: session.room, myId: session.myId, status: session.status } : null);

function refreshUi(): void {
  const state = roomState();
  if (state) ui.update(state);
}

function leaveSession(): void {
  session?.close();
  session = null;
  controls.enabled = false;
  controls.clear();
  hud.show(false);
  hud.clearFeed();
}

function showHome(error = ''): void {
  leaveSession();
  ui.showHome(savedName(), error);
}

function enterRoom(code: string, name: string): void {
  leaveSession();
  ui.showRoom(code);
  session = new Session(code, sanitizeName(name) || 'Player', {
    renderer,
    sfx,
    controls,
    pid: playerId(),
    hooks: {
      room: () => refreshUi(),
      status: () => refreshUi(),
      error: (reason) => {
        ui.toast(reason, 4000);
        sfx.ui('error');
      },
      feed: (entry) => hud.addFeed(entry, performance.now()),
      matchStarted: () => hud.clearFeed(),
    },
  });
}

function route(): void {
  const match = location.pathname.match(ROOM_PATH);
  if (!match) {
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    showHome();
    return;
  }
  const code = normalizeCode(match[1]!);
  if (!code) {
    history.replaceState(null, '', '/');
    showHome('That room link is not valid.');
    return;
  }
  if (session?.code === code) return;
  const name = savedName();
  if (name) {
    enterRoom(code, name);
    return;
  }
  leaveSession();
  pendingCode = code;
  ui.showNamePrompt(code, '', () => handlers.leave());
}

/** Touch controls show on phones and tablets, and on any device the moment it is used with a finger. */
const touchDevice = () => lastPointer === 'touch' || matchMedia('(pointer: coarse)').matches;

/** Picks the camera and the screen area the arena fits in, around the HUD. */
function layout(view: ViewState, inMatch: boolean): boolean {
  const w = innerWidth;
  const h = innerHeight;
  if (!inMatch || ui.panelOpen) {
    renderer.setViewport({ x: 0, y: 0, w, h });
    renderer.setCamera('fit');
    hud.setFollow(false, null);
    return false;
  }
  const { top, bottom } = hud.insets();
  renderer.setViewport({ x: 8, y: top, w: w - 16, h: Math.max(120, h - top - bottom) });
  const follow = (matchMedia('(pointer: coarse)').matches && Math.min(w, h) < FOLLOW_BELOW) || renderer.fitScale(view.maze) < 1;
  if (follow) renderer.setViewport({ x: 0, y: 0, w, h });
  renderer.setCamera(follow ? 'follow' : 'fit');
  hud.setFollow(follow, view.maze);
  return follow;
}

function syncControls(): void {
  const active = !!session?.playing && !ui.menuOpen;
  if (controls.enabled && !active) {
    controls.enabled = false;
    controls.clear();
  }
  controls.enabled = active;
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  syncControls();
  let view = session?.frame(now, dt) ?? null;
  const inMatch = view !== null;
  if (!view) {
    attract ??= new Attract(crypto.getRandomValues(new Uint32Array(1))[0]!);
    view = attract.frame(dt);
  }
  const model = inMatch ? (session?.hud(now) ?? null) : null;
  hud.show(!!model && !ui.panelOpen);
  hud.setTouch(!!model?.me && touchDevice());
  if (model) hud.update(model, now);
  const follow = layout(view, inMatch);
  renderer.draw(view, dt);
  if (inMatch) {
    session?.dispatch(view, now);
  } else if (attract) {
    for (const ev of attract.events) renderer.event(ev, view);
    attract.events = [];
  }
  sfx.update(view, dt);
  if (follow && model) renderer.drawMinimap(hud.minimap, view);
  requestAnimationFrame(loop);
}

addEventListener('pointerdown', (e) => {
  lastPointer = e.pointerType;
  sfx.unlock();
}, { capture: true });
uiRoot.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('button:not(:disabled)')) sfx.ui('click');
});
// iOS Safari ignores user-scalable=no; stop pinch zoom on the game surface.
document.addEventListener('gesturestart', (e) => e.preventDefault());
addEventListener('popstate', route);
addEventListener('resize', () => renderer.resize());

try {
  void document.fonts.load('16px "Press Start 2P"');
  void document.fonts.load('16px VT323');
} catch {
  // Font loading API missing: the fallback fonts are used until the files arrive.
}

route();
requestAnimationFrame(loop);
