import '@fontsource/handjet/700.css';
import '@fontsource/handjet/800.css';
import '@fontsource/share-tech-mono/400.css';
import './style.css';
import { CODE_ALPHABET, CODE_LENGTH, isPaletteIndex } from '../shared/constants';
import { normalizeCode, sanitizeName } from '../shared/protocol';
import { Attract } from './attract';
import { createSfx } from './audio';
import { CrtScreen } from './crt';
import { storageGet, storageSet } from './dom';
import { Hud } from './hud';
import { Controls } from './input';
import { createRenderer } from './render';
import { Session } from './session';
import { Ui, type UiHandlers } from './ui';
import { CRT_LEVELS, type CrtLevel, type ViewState } from './view';

const NAME_KEY = 'tanktangle:name';
const PID_KEY = 'tanktangle:pid';
const MUTE_KEY = 'tanktangle:muted';
const CRT_KEY = 'tanktangle:crt';
const COLOR_KEY = 'tanktangle:color';
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

/** The CRT level. Before levels the setting was '1' or '0': on becomes full. */
function savedCrt(): CrtLevel {
  const saved = storageGet('local', CRT_KEY);
  if (saved === '0') return 'off';
  return CRT_LEVELS.find((level) => level === saved) ?? 'full';
}

function savedColor(): number | undefined {
  const color = Number.parseInt(storageGet('local', COLOR_KEY), 10);
  return isPaletteIndex(color) ? color : undefined;
}

const stage = document.getElementById('stage') as HTMLCanvasElement;
const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const prefs: { muted: boolean; crt: CrtLevel } = { muted: storageGet('local', MUTE_KEY) === '1', crt: savedCrt() };
const renderer = createRenderer(stage, overlayCanvas);
const crtScreen = new CrtScreen(uiRoot);
const sfx = createSfx();
sfx.setMuted(prefs.muted);

function applyCrt(): void {
  renderer.setCrt(prefs.crt);
  crtScreen.setLevel(prefs.crt);
}
applyCrt();

let session: Session | null = null;
let attract: Attract | null = null;
let pendingCode = '';
let lastPointer = '';
let pickedColor = -1;

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
  retry: () => session?.retry(),
  settings: (s) => session?.settings(s),
  start: () => session?.start(),
  again: () => session?.again(),
  addBot: (level) => session?.addBot(level),
  removeBot: (id) => session?.removeBot(id),
  team: (team) => session?.team(team),
  color(color) {
    pickedColor = color;
    session?.color(color);
  },
  mute() {
    prefs.muted = !prefs.muted;
    sfx.setMuted(prefs.muted);
    storageSet('local', MUTE_KEY, prefs.muted ? '1' : '0');
    return prefs.muted;
  },
  crt() {
    prefs.crt = CRT_LEVELS[(CRT_LEVELS.indexOf(prefs.crt) + 1) % CRT_LEVELS.length]!;
    applyCrt();
    storageSet('local', CRT_KEY, prefs.crt);
    return prefs.crt;
  },
};
const ui = new Ui(uiRoot, handlers, prefs);

const roomState = () => (session ? { code: session.code, room: session.room, myId: session.myId, status: session.status } : null);

function refreshUi(): void {
  const state = roomState();
  if (state) ui.update(state);
}

/** Remembers a colour pick once the server has given it to us, so a refused pick is not saved. */
function rememberColor(): void {
  const mine = session?.room?.players.find((p) => p.id === session?.myId);
  if (!mine || mine.color !== pickedColor) return;
  storageSet('local', COLOR_KEY, String(pickedColor));
  pickedColor = -1;
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
  hud.setRoom(code);
  session = new Session(code, sanitizeName(name) || 'Player', {
    renderer,
    sfx,
    controls,
    pid: playerId(),
    color: savedColor(),
    hooks: {
      room: () => {
        rememberColor();
        refreshUi();
      },
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
  const { top, bottom, side } = hud.insets();
  const fitBetween = (inset: number) => renderer.setViewport({ x: 8 + inset, y: top, w: w - 16 - 2 * inset, h: Math.max(120, h - top - bottom) });
  fitBetween(side);
  // The side columns narrow the arena. Rather than switch to the follow camera for them, let them overlap it.
  if (side > 0 && renderer.fitScale(view.maze) < 1) fitBetween(0);
  const follow = (matchMedia('(pointer: coarse)').matches && Math.min(w, h) < FOLLOW_BELOW) || renderer.fitScale(view.maze) < 1;
  // The world still fills the screen, but the camera centres and clamps between the HUD bars, so a tank near the
  // maze edge is never parked under them.
  if (follow) renderer.setViewport({ x: 0, y: top, w, h: Math.max(120, h - top - bottom) });
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
let frameFailed = false;
function loop(now: number): void {
  // Scheduled first, so one throw cannot stop the game until a reload.
  requestAnimationFrame(loop);
  try {
    frame(now);
  } catch (err) {
    if (frameFailed) return;
    frameFailed = true;
    console.error(JSON.stringify({ event: 'frame_failed', error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  }
}

function frame(now: number): void {
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
  // Canvas text does not load fonts by itself.
  for (const font of ['700 16px Handjet', '800 16px Handjet', '16px "Share Tech Mono"']) void document.fonts.load(font);
} catch {
  // Font loading API missing: the fallback fonts are used until the files arrive.
}

route();
requestAnimationFrame(loop);
