import { CODE_LENGTH, MAX_SEATS, NAME_MAX, PALETTE, PALETTE_NAMES, TEAM_COLORS, TEAM_NAMES } from '../shared/constants';
import { mazeSizeFor } from '../shared/maze';
import type { PlayerStats, PublicPlayer, RoomMsg } from '../shared/protocol';
import { LIMITS, type Settings } from '../shared/settings';
import { BOT_LEVELS, type BotLevel } from '../shared/types';
import { fill, h, ICONS, icon, initial, svg, type Child } from './dom';
import type { NetStatus } from './net';
import type { CrtLevel } from './view';

export interface UiHandlers {
  create(name: string): void;
  join(code: string, name: string): void;
  /** Name entered on an invite link. */
  enter(name: string): void;
  leave(): void;
  /** Try a full room again. */
  retry(): void;
  settings(patch: Partial<Settings>): void;
  start(): void;
  again(): void;
  addBot(level: BotLevel): void;
  removeBot(id: string): void;
  team(team: number): void;
  /** Picks a PALETTE index. */
  color(color: number): void;
  /** Toggles sound, returns whether it is now muted. */
  mute(): boolean;
  /** Moves the CRT effect to the next level in CRT_LEVELS order, returns the new level. */
  crt(): CrtLevel;
}

export interface RoomState {
  code: string;
  room: RoomMsg | null;
  myId: string;
  status: NetStatus;
}

interface Option<T> {
  value: T;
  label: string;
}

const MODES: Option<Settings['mode']>[] = [
  { value: 'lives', label: 'Lives' },
  { value: 'timed', label: 'Timed' },
];
const TEAMS: Option<Settings['teams']>[] = [
  { value: 0, label: 'Off' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
];
const ON_OFF: Option<boolean>[] = [
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
];
const POWERUPS = ['Off', 'Rare', 'Normal', 'Lots', 'Frantic'].map((label, value) => ({ value, label }));
const BRICKS = ['None', 'Few', 'Half', 'Most', 'All'].map((label, value) => ({ value, label }));
const SPEEDS = ['Slow', 'Calm', 'Normal', 'Fast', 'Turbo'].map((label, value) => ({ value, label }));
const MAZE_SIZES: Option<number>[] = [];
for (let v = LIMITS.mazeSize[0]; v <= LIMITS.mazeSize[1]; v++) MAZE_SIZES.push({ value: v, label: v > 0 ? `+${v}` : String(v) });
const BOT_LABEL: Record<BotLevel, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard', expert: 'Expert' };
const CRT_LABEL: Record<CrtLevel, string> = { full: 'Full', soft: 'Soft', off: 'Off' };

const FINAL_TEXT: Partial<Record<NetStatus, { title: string; text: string; action: 'home' | 'reload' | 'retry' }>> = {
  replaced: { title: 'Opened in another tab', text: 'This room is open in another tab or window. Carry on there.', action: 'home' },
  outdated: { title: 'New version available - reload', text: 'Tank Tangle was updated while you were here.', action: 'reload' },
  full: { title: 'Room is full', text: 'This room already has as many people as it can hold.', action: 'retry' },
};

const AWARD_ICONS: Record<string, readonly string[]> = {
  Kingslayer: ICONS.crown,
  'Ricochet Artist': ICONS.ricochet,
  Sharpshooter: ICONS.target,
  'Wrecking Ball': ICONS.brick,
  'Crate Crasher': ICONS.crate,
  'Own Worst Enemy': ICONS.target,
  Survivor: ICONS.heart,
  'First Blood': ICONS.drop,
  Rampage: ICONS.bolt,
  Untouchable: ICONS.shield,
  'Bullet Magnet': ICONS.magnet,
  'Trigger Happy': ICONS.burst,
  Revenge: ICONS.swap,
  'Two Birds': ICONS.birds,
  Clutch: ICONS.battery,
  'Road Warrior': ICONS.road,
  Turtle: ICONS.gauge,
  Demolition: ICONS.brick,
  'Laser Show': ICONS.beam,
  Nemesis: ICONS.swords,
  'Shield Wall': ICONS.shield,
  Backstabber: ICONS.dagger,
};

/** How long a sent setting is shown before the room confirms it, after the last change. */
const PENDING_MS = 2000;

const coarse = () => matchMedia('(pointer: coarse)').matches;

const paletteColor = (color: number): string => PALETTE[color] ?? PALETTE[0];

/** Tank colour: the team colour in team mode, else the picked colour. */
export const playerColor = (p: { color: number; team: number }, teams: boolean) => (teams && p.team > 0 ? TEAM_COLORS[p.team]! : paletteColor(p.color));


const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const pad2 = (n: number) => String(n).padStart(2, '0');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const crtText = (level: CrtLevel) => `CRT: ${CRT_LABEL[level]}`;

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * The banner in the ANSI Shadow figlet style. # is a full block, the other characters are its double-line shadow:
 * 7 and F are the top right and top left corners, J and L the bottom ones, - and | the straight runs.
 * The font has no block or box-drawing glyphs, so it is drawn as SVG.
 */
const LOGO_WORDS = [
  [
    '########7 #####7 ###7   ##7##7  ##7',
    'L--##F--J##F--##7####7  ##|##| ##FJ',
    '   ##|   #######|##F##7 ##|#####FJ ',
    '   ##|   ##F--##|##|L##7##|##F-##7 ',
    '   ##|   ##|  ##|##| L####|##|  ##7',
    '   L-J   L-J  L-JL-J  L---JL-J  L-J',
  ],
  [
    '########7 #####7 ###7   ##7 ######7 ##7     #######7',
    'L--##F--J##F--##7####7  ##|##F----J ##|     ##F----J',
    '   ##|   #######|##F##7 ##|##|  ###7##|     #####7  ',
    '   ##|   ##F--##|##|L##7##|##|   ##|##|     ##F--J  ',
    '   ##|   ##|  ##|##| L####|L######FJ#######7#######7',
    '   L-J   L-J  L-JL-J  L---J L-----J L------JL------J',
  ],
];
/** A character cell of a monospace font at line-height 1. */
const LOGO_CELL_W = 6;
const LOGO_CELL_H = 10;
const LOGO_WORD_GAP = 7;
/** Each shadow character's two strokes as x, y polylines within its cell. */
const LOGO_STROKES: Record<string, number[][]> = {
  '-': [
    [0, 3.5, 6, 3.5],
    [0, 6.5, 6, 6.5],
  ],
  '|': [
    [1.5, 0, 1.5, 10],
    [4.5, 0, 4.5, 10],
  ],
  '7': [
    [0, 3.5, 4.5, 3.5, 4.5, 10],
    [0, 6.5, 1.5, 6.5, 1.5, 10],
  ],
  F: [
    [6, 3.5, 1.5, 3.5, 1.5, 10],
    [6, 6.5, 4.5, 6.5, 4.5, 10],
  ],
  L: [
    [1.5, 0, 1.5, 6.5, 6, 6.5],
    [4.5, 0, 4.5, 3.5, 6, 3.5],
  ],
  J: [
    [4.5, 0, 4.5, 6.5, 0, 6.5],
    [1.5, 0, 1.5, 3.5, 0, 3.5],
  ],
};

function logoArt(): SVGSVGElement {
  let blocks = '';
  let strokes = '';
  let width = 0;
  let y = 0;
  for (const rows of LOGO_WORDS) {
    for (const row of rows) {
      width = Math.max(width, row.length * LOGO_CELL_W);
      for (let c = 0; c < row.length; c++) {
        const x = c * LOGO_CELL_W;
        if (row[c] === '#') {
          let run = 1;
          while (row[c + run] === '#') run++;
          blocks += `M${x} ${y}h${run * LOGO_CELL_W}v${LOGO_CELL_H}h${-run * LOGO_CELL_W}z`;
          c += run - 1;
          continue;
        }
        for (const line of LOGO_STROKES[row[c]!] ?? []) {
          for (let i = 0; i < line.length; i += 2) strokes += `${i === 0 ? 'M' : 'L'}${x + line[i]!} ${y + line[i + 1]!}`;
        }
      }
      y += LOGO_CELL_H;
    }
    y += LOGO_WORD_GAP;
  }
  return svg(
    'svg',
    { class: 'logo-art', viewBox: `0 0 ${width} ${y - LOGO_WORD_GAP}`, 'aria-hidden': 'true' },
    svg('path', { d: blocks, fill: 'currentColor' }),
    svg('path', { d: strokes, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }),
  );
}

function logo(small = false): HTMLElement {
  return h('h1', { class: small ? 'logo small' : 'logo' }, logoArt(), h('span', { class: 'sr' }, 'Tank Tangle'));
}

/** A terminal line: a > prompt, the text and, when live, a blinking block cursor. */
function prompt(cls: string, cursor: boolean, ...content: Child[]): HTMLElement {
  return h('p', { class: `prompt ${cls}` }, h('span', { class: 'gt', 'aria-hidden': 'true' }, '>'), ...content, cursor && h('i', { class: 'cursor', 'aria-hidden': 'true' }));
}

function brand(...trail: Child[]): HTMLElement {
  return h('div', { class: 'brand' }, h('span', { class: 'tt', 'aria-hidden': 'true' }, 'TT'), ...trail);
}

/** The title that sits on a box's top border, and an optional note on the right of the same border. */
function boxHead(title: string, note?: string): HTMLElement {
  return h('header', { class: 'box-head' }, h('h2', { class: 'box-title' }, title), note ? h('span', { class: 'box-note' }, note) : null);
}

function box(opts: { tag?: 'section' | 'aside'; cls?: string; title: string; note?: string; id?: string }, ...children: Child[]): HTMLElement {
  return h(opts.tag ?? 'section', { class: `box ${opts.cls ?? ''}`, id: opts.id }, boxHead(opts.title, opts.note), ...children);
}

function fieldBox(prefix: string, input: HTMLInputElement): HTMLElement {
  return h('div', { class: 'field-box' }, h('span', { class: 'pfx', 'aria-hidden': 'true' }, prefix), input);
}

/** A row of cells, the first value of them lit: bot levels, setting levels, accuracy. */
function meter(value: number, cells: number): HTMLElement {
  const el = h('span', { class: 'meter', 'aria-hidden': 'true' });
  for (let i = 0; i < cells; i++) el.appendChild(h('i', { class: i < value ? 'on' : '' }));
  return el;
}

const label = (text: string) => h('span', { class: 'bl' }, text);

const tag = (text: string, cls = '') => h('span', { class: `tag ${cls}` }, text);

const teamTag = (team: number) => h('span', { class: 'tag team', style: { '--c': TEAM_COLORS[team]! } }, TEAM_NAMES[team]!);

/** The best value in a stats column, or NaN when nobody stands out (one row, all equal, or nothing scored). */
function best(values: number[], high: boolean): number {
  const seen = values.filter((v) => !Number.isNaN(v));
  if (seen.length < 2) return NaN;
  const top = high ? Math.max(...seen) : Math.min(...seen);
  return seen.every((v) => v === top) || (high && top <= 0) ? NaN : top;
}

/** Screens and panels: home, invite name prompt, lobby, results, the pause menu, toasts and connection states. */
export class Ui {
  private screen: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private conn: HTMLElement | null = null;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private menuEl: HTMLElement | null = null;
  private code = '';
  private panelKey = '';
  private connKey = '';
  private state: RoomState | null = null;
  /** Settings sent from here that no room message has confirmed yet. The panel shows them and builds on them. */
  private pending: Partial<Settings> = {};
  private pendingTimer = 0;
  /** Phones fold the lobby settings behind a summary. Kept across panel rebuilds. */
  private settingsOpen = false;

  constructor(
    private root: HTMLElement,
    private on: UiHandlers,
    private prefs: { muted: boolean; crt: CrtLevel },
  ) {
    this.toastEl = h('div', { class: 'toast hidden', role: 'status' });
    root.appendChild(this.toastEl);
  }

  /** A lobby or results panel covers the arena. */
  get panelOpen(): boolean {
    return !!this.screen || (!!this.panel && !this.panel.classList.contains('hidden'));
  }

  get menuOpen(): boolean {
    return !!this.menuEl;
  }

  private clear(): void {
    this.screen?.remove();
    this.panel?.remove();
    this.conn?.remove();
    this.closeMenu();
    this.screen = this.panel = this.conn = null;
    this.panelKey = this.connKey = '';
    this.code = '';
    this.state = null;
    this.pending = {};
  }

  private nameInput(name: string): HTMLInputElement {
    return h('input', {
      class: 'input',
      value: name,
      maxLength: NAME_MAX,
      placeholder: 'Your name',
      autocomplete: 'nickname',
      spellcheck: false,
      'aria-label': 'Your name',
    });
  }

  private crtButton(cls: string): HTMLButtonElement {
    const text = label(crtText(this.prefs.crt));
    const button = h('button', { class: cls, type: 'button' }, text);
    button.addEventListener('click', () => {
      this.prefs.crt = this.on.crt();
      text.textContent = crtText(this.prefs.crt);
    });
    return button;
  }

  private hostBar(note: string): HTMLElement {
    return h('header', { class: 'bar' }, brand(h('span', { class: 'host' }, location.host)), h('span', { class: 'bar-note' }, note));
  }

  showHome(name: string, error = ''): void {
    this.clear();
    const nameEl = this.nameInput(name);
    const codeEl = h('input', {
      class: 'input code',
      maxLength: CODE_LENGTH,
      placeholder: '_'.repeat(CODE_LENGTH),
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: false,
      enterKeyHint: 'go',
      'aria-label': 'Room code',
    });
    const err = h('p', { class: 'error', role: 'alert' }, error);
    const needName = () => {
      const n = nameEl.value.trim();
      if (!n) {
        err.textContent = 'Pick a name first.';
        nameEl.focus();
      }
      return n;
    };
    const join = () => {
      const n = needName();
      if (!n) return;
      if (!codeEl.value.trim()) {
        err.textContent = `Type the ${CODE_LENGTH}-letter room code.`;
        codeEl.focus();
        return;
      }
      this.on.join(codeEl.value, n);
    };
    codeEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      join();
    });
    codeEl.addEventListener('input', () => {
      codeEl.value = codeEl.value.toUpperCase();
    });
    const form = h(
      'form',
      {
        class: 'box double start',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const n = needName();
          if (n) this.on.create(n);
        },
      },
      boxHead('Start'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Your name'), fieldBox('>', nameEl)),
      h(
        'button',
        { class: 'btn primary big wide', type: 'submit' },
        label('Create room'),
        h('span', { class: 'hint key-hint', 'aria-hidden': 'true' }, 'Enter', icon(ICONS.enter)),
      ),
      h('div', { class: 'or' }, h('span', {}, 'or join with a code')),
      h('div', { class: 'row' }, fieldBox('#', codeEl), h('button', { class: 'btn join', type: 'button', onclick: join }, label('Join'))),
      err,
    );
    this.screen = h(
      'main',
      { class: 'screen home' },
      this.hostBar('2 to 12 players · desktop + phone'),
      h(
        'div',
        { class: 'home-main' },
        h(
          'section',
          { class: 'home-start' },
          logo(),
          prompt('tagline', true, 'Maze tank battles for 2 to 12. Share a link, bank your shots, blow up the walls.'),
          form,
        ),
        this.howTo(),
      ),
      h(
        'footer',
        { class: 'bar foot' },
        h('span', { class: 'ready' }, tag('Ready', 'inv'), h('span', {}, 'Pick a name, then create a room or join one.')),
        h('span', { class: 'foot-right' }, this.crtButton('btn small'), h('span', { class: 'bar-note' }, 'No account needed')),
      ),
    );
    this.root.appendChild(this.screen);
  }

  private howTo(): HTMLElement {
    const key = (k: string) => h('kbd', {}, k);
    const or = () => h('span', { class: 'or-word' }, 'or');
    const row = (name: string, ...content: Child[]) => h('div', { class: 'howto-row' }, h('span', { class: 'howto-k' }, name), h('div', { class: 'howto-v' }, ...content));
    return box(
      { tag: 'aside', cls: 'howto', title: 'How to play' },
      row('Drive', key('W'), key('A'), key('S'), key('D'), or(), key('Arrows')),
      row('Fire', key('Space'), or(), key('Enter'), h('span', { class: 'howto-line' }, 'Hold to keep firing.')),
      row('Phone', 'Left thumb steers, right thumb fires.'),
      row('Bounce', 'Bullets bounce off walls. Your own can hit you.'),
      row(
        'Walls',
        h('span', { class: 'wall-line' }, h('i', { class: 'wall brick' }), 'Brick breaks and grows back.'),
        h('span', { class: 'wall-line' }, h('i', { class: 'wall steel' }), 'Steel never breaks.'),
      ),
      row('Crates', 'Grab them for lasers, missiles, mines and more.'),
      row('Menu', key('Esc'), 'opens the menu.'),
    );
  }

  showNamePrompt(code: string, name: string, back: () => void): void {
    this.clear();
    const nameEl = this.nameInput(name);
    const err = h('p', { class: 'error', role: 'alert' });
    this.screen = h(
      'main',
      { class: 'screen home' },
      this.hostBar(`Invite / ${code}`),
      h(
        'div',
        { class: 'home-main narrow' },
        logo(true),
        h(
          'form',
          {
            class: 'box double start',
            onsubmit: (e: Event) => {
              e.preventDefault();
              const n = nameEl.value.trim();
              if (n) this.on.enter(n);
              else {
                err.textContent = 'Pick a name first.';
                nameEl.focus();
              }
            },
          },
          boxHead('Join room'),
          prompt('invite', false, "You're invited to room ", h('b', { class: 'room-code' }, code)),
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Your name'), fieldBox('>', nameEl)),
          h(
            'button',
            { class: 'btn primary big wide', type: 'submit' },
            label('Join room'),
            h('span', { class: 'hint key-hint', 'aria-hidden': 'true' }, 'Enter', icon(ICONS.enter)),
          ),
          err,
          h('button', { class: 'btn ghost', type: 'button', onclick: back }, label('Back')),
        ),
      ),
    );
    this.root.appendChild(this.screen);
    nameEl.focus();
  }

  showRoom(code: string): void {
    this.clear();
    this.code = code;
    this.panel = h('section', { class: 'room-panel hidden' });
    this.conn = h('div', { class: 'conn hidden', role: 'status' });
    this.root.appendChild(this.panel);
    this.root.appendChild(this.conn);
    this.setConn('connecting', true);
  }

  private inviteUrl(): string {
    return `${location.origin}/r/${this.code}`;
  }

  async share(): Promise<void> {
    const url = this.inviteUrl();
    try {
      if (navigator.share && coarse()) {
        await navigator.share({ title: 'Tank Tangle', text: `Join my Tank Tangle room ${this.code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      this.toast('Invite link copied');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.toast(url, 8000);
    }
  }

  toast(text: string, ms = 2200): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), ms);
  }

  update(state: RoomState): void {
    if (!this.panel) return;
    this.state = state;
    this.setConn(state.status, !state.room);
    const room = state.room;
    if (!room || FINAL_TEXT[state.status]) {
      this.panel.classList.add('hidden');
      return;
    }
    this.confirmSettings(room, state);
    const key = JSON.stringify([room.phase, room.host, room.settings, this.pending, room.players, room.result, state.myId]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    // The panel is rebuilt: put keyboard focus back on the same control.
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.panel.contains(active) ? active.dataset.key : undefined;
    if (room.phase === 'lobby') this.renderLobby(room, state.myId);
    else if (room.phase === 'over') this.renderResults(room, state.myId);
    else {
      this.panel.classList.add('hidden');
      return;
    }
    this.panel.classList.remove('hidden');
    if (focused) [...this.panel.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === focused)?.focus({ preventScroll: true });
  }

  /** Drops pending settings the room now shows, and all of them once this tab cannot be changing settings. */
  private confirmSettings(room: RoomMsg, state: RoomState): void {
    if (room.phase !== 'lobby' || room.host !== state.myId || state.status !== 'open') {
      this.pending = {};
      return;
    }
    for (const key of Object.keys(this.pending) as (keyof Settings)[]) if (room.settings[key] === this.pending[key]) delete this.pending[key];
  }

  /** The host changed a setting: show it now and send it. */
  private changeSettings(patch: Partial<Settings>): void {
    this.pending = { ...this.pending, ...patch };
    this.on.settings(patch);
    // The server drops messages over its rate limit without a reply: once changes stop, go back to what it confirmed.
    clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => {
      this.pending = {};
      if (this.state) this.update(this.state);
    }, PENDING_MS);
    if (this.state) this.update(this.state);
  }

  private setConn(status: NetStatus, joining: boolean): void {
    if (!this.conn) return;
    const key = `${status}:${joining}`;
    if (key === this.connKey) return;
    this.connKey = key;
    const final = FINAL_TEXT[status];
    this.conn.className = final ? 'conn final' : 'conn';
    if (final) {
      const home = (cls: string) => h('button', { class: cls, type: 'button', onclick: () => this.on.leave() }, label('Back home'));
      this.conn.replaceChildren(
        box(
          { cls: 'double final-card', title: final.title },
          prompt('', true, final.text),
          final.action === 'reload' && h('button', { class: 'btn primary big wide', type: 'button', onclick: () => location.reload() }, label('Reload')),
          final.action === 'retry' && h('button', { class: 'btn primary big wide', type: 'button', onclick: () => this.on.retry() }, label('Try again')),
          home(final.action === 'home' ? 'btn primary big wide' : 'btn ghost'),
        ),
      );
      return;
    }
    if (status === 'open' && !joining) {
      this.conn.classList.add('hidden');
      return;
    }
    const text = status === 'reconnecting' ? 'Reconnecting' : status === 'open' ? 'Joining room' : 'Connecting';
    this.conn.replaceChildren(h('div', { class: 'banner' }, `${text}...`, h('i', { class: 'cursor', 'aria-hidden': 'true' })));
  }

  // ---------------------------------------------------------------------------------------------
  // Lobby

  private roomBar(page: string, right: Child): HTMLElement {
    return h('header', { class: 'bar' }, brand(h('b', { class: 'brand-name' }, 'Tank Tangle'), h('span', { class: 'path' }, `/ ${page} / ${this.code}`)), right);
  }

  private renderLobby(room: RoomMsg, myId: string): void {
    const host = room.host === myId;
    const s = { ...room.settings, ...this.pending };
    const teams = s.teams > 0;
    const seated = room.players.filter((p) => p.seat >= 0).sort((a, b) => a.seat - b.seat);
    const bench = room.players.filter((p) => p.seat < 0);
    const me = room.players.find((p) => p.id === myId);
    const hostName = room.players.find((p) => p.id === room.host)?.name ?? 'the host';
    const open = MAX_SEATS - seated.length;
    const set = (patch: Partial<Settings>) => this.changeSettings(patch);
    const blocker = this.startBlocker(room);

    const players = box(
      { cls: 'players-box', title: `Players ${pad2(seated.length)}/${MAX_SEATS}` },
      h(
        'ul',
        { class: 'players' },
        ...seated.map((p, i) => this.playerRow(p, room, myId, pad2(i + 1))),
        open > 0 &&
          h(
            'li',
            { class: 'slots' },
            h('span', { class: 'num' }, open === 1 ? String(MAX_SEATS) : `${pad2(seated.length + 1)}-${MAX_SEATS}`),
            h('i', { class: 'hatch', 'aria-hidden': 'true' }),
            h('span', {}, `${plural(open, 'open slot')}. Share the invite link to fill them.`),
          ),
      ),
    );

    const addBot =
      host &&
      box(
        { cls: 'bots-box', title: 'Add a bot', note: open > 0 ? undefined : 'Room full' },
        h(
          'div',
          { class: 'bots', role: 'group', 'aria-label': 'Add a bot' },
          ...BOT_LEVELS.map((level, i) =>
            h(
              'button',
              { class: 'btn bot-btn', type: 'button', 'data-key': `bot:${level}`, disabled: open <= 0, onclick: () => this.on.addBot(level) },
              h('span', {}, `+ ${BOT_LABEL[level]}`),
              meter(i + 1, BOT_LEVELS.length),
            ),
          ),
        ),
      );

    const tanks = Math.max(2, seated.length);
    const settingsId = 'lobby-settings';
    const settings = box(
      { cls: `double settings-box${this.settingsOpen ? ' open' : ''}`, title: 'Settings', note: host ? 'Host can edit' : 'Read only', id: settingsId },
      this.segmented('Mode', MODES, s.mode, host, (mode) => set({ mode })),
      s.mode === 'lives'
        ? this.stepper('Lives', s.lives, LIMITS.lives, host, (lives) => set({ lives }))
        : this.stepper('Minutes', s.minutes, LIMITS.minutes, host, (minutes) => set({ minutes })),
      this.segmented('Maze size', MAZE_SIZES, s.mazeSize, host, (mazeSize) => set({ mazeSize }), null, this.sizeLabel(s.mazeSize, tanks)),
      this.segmented('Teams', TEAMS, s.teams, host, (t) => set({ teams: t })),
      teams && this.segmented('Friendly fire', ON_OFF, s.friendlyFire, host, (friendlyFire) => set({ friendlyFire })),
      this.segmented('Power-ups', POWERUPS, s.powerups, host, (powerups) => set({ powerups }), meter(s.powerups, LIMITS.powerups[1])),
      this.segmented('Bricks', BRICKS, s.bricks, host, (bricks) => set({ bricks }), meter(s.bricks, LIMITS.bricks[1])),
      this.segmented('Game speed', SPEEDS, s.speed, host, (speed) => set({ speed }), meter(s.speed, LIMITS.speed[1])),
      this.stepper('Bullet bounces', s.bounces, LIMITS.bounces, host, (bounces) => set({ bounces }), `range ${LIMITS.bounces[0]}-${LIMITS.bounces[1]}`),
    );
    const toggle: HTMLButtonElement = h(
      'button',
      {
        class: 'settings-toggle',
        type: 'button',
        'data-key': 'settings-toggle',
        'aria-expanded': String(this.settingsOpen),
        'aria-controls': settingsId,
        onclick: () => {
          this.settingsOpen = !this.settingsOpen;
          settings.classList.toggle('open', this.settingsOpen);
          toggle.setAttribute('aria-expanded', String(this.settingsOpen));
        },
      },
      h('span', { class: 'st-text' }, h('b', {}, label('Settings')), h('span', { class: 'st-sum' }, this.settingsSummary(s))),
      icon(ICONS.chevron),
    );

    const startSub = `${plural(seated.length, 'tank')} · ${s.mode === 'lives' ? `Lives · ${s.lives} each` : `Timed · ${s.minutes} min`}`;
    const foot = h(
      'div',
      { class: 'lobby-foot' },
      h(
        'button',
        { class: 'btn primary big start', type: 'button', 'data-key': 'start', disabled: !host || !!blocker, onclick: () => this.on.start() },
        label(host ? 'Start match' : `Waiting for ${hostName}`),
        h('span', { class: 'hint' }, host ? startSub : 'The host starts the match'),
      ),
      prompt('foot-note', true, host ? (blocker ?? 'Only you can start. Everyone else waits for you.') : `${hostName} picks the settings and starts the match.`),
    );

    this.panel!.className = 'room-panel lobby';
    this.panel!.replaceChildren(
      this.roomBar(
        'lobby',
        h(
          'button',
          { class: 'btn leave', type: 'button', 'data-key': 'leave', 'aria-label': 'Leave room', onclick: () => this.on.leave() },
          icon(ICONS.leave),
          label('Leave room'),
        ),
      ),
      h(
        'div',
        { class: 'page' },
        this.invite(),
        h(
          'div',
          { class: 'lobby-body' },
          h(
            'div',
            { class: 'col' },
            players,
            me && this.colorPicker(room, me, teams),
            teams && me && me.seat >= 0 && this.teamPicker(s.teams, me.team),
            bench.length > 0 &&
              box(
                { cls: 'bench-box', title: `Bench ${pad2(bench.length)}` },
                h('p', { class: 'muted' }, 'Waiting for a free seat. Benched players get seats first next match.'),
                h('ul', { class: 'players bench' }, ...bench.map((p) => this.playerRow(p, room, myId, '--'))),
              ),
          ),
          // Add a bot sits apart from the player list, so its buttons stay put while bots join the list.
          h('div', { class: 'col' }, addBot, toggle, settings, foot),
        ),
      ),
    );
  }

  private invite(): HTMLElement {
    const share = coarse() && 'share' in navigator;
    const url = h('input', { class: 'input url', value: this.inviteUrl(), readOnly: true, spellcheck: false, 'aria-label': 'Invite link' });
    url.addEventListener('focus', () => url.select());
    return h(
      'div',
      { class: 'invite' },
      h(
        'div',
        { class: 'invite-code' },
        h('span', { class: 'label' }, 'Room code'),
        h('div', { class: 'code-cells' }, h('span', { class: 'sr' }, this.code), ...Array.from(this.code, (ch) => h('span', { class: 'code-ch', 'aria-hidden': 'true' }, ch))),
      ),
      h(
        'div',
        { class: 'invite-link' },
        h('span', { class: 'label' }, 'Invite link'),
        h(
          'div',
          { class: 'row' },
          fieldBox('>', url),
          h(
            'button',
            { class: 'btn primary share', type: 'button', 'data-key': 'share', onclick: () => void this.share() },
            icon(share ? ICONS.share : ICONS.copy),
            label(share ? 'Share' : 'Copy invite link'),
          ),
        ),
      ),
    );
  }

  private settingsSummary(s: Settings): string {
    return [
      s.mode === 'lives' ? `Lives ${s.lives}` : `Timed ${s.minutes} min`,
      s.teams > 0 && `${s.teams} teams`,
      `${SPEEDS[s.speed]?.label ?? ''} speed`,
      s.bricks === 0 ? 'No bricks' : `${BRICKS[s.bricks]?.label ?? ''} bricks`,
      plural(s.bounces, 'bounce'),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** Why the match cannot start yet, or null. Mirrors the server's start guard. */
  private startBlocker(room: RoomMsg): string | null {
    const seated = room.players.filter((p) => p.seat >= 0);
    if (seated.length < 2) return 'Need 2 tanks: add a bot or share the link.';
    if (room.settings.teams > 0 && new Set(seated.map((p) => p.team).filter((t) => t > 0)).size < 2) return 'Need tanks on 2 teams.';
    return null;
  }

  private sizeLabel(step: number, tanks: number): string {
    const { w, h: hh } = mazeSizeFor(tanks, step);
    const name = step === 0 ? 'Auto' : `Size ${step > 0 ? '+' : ''}${step}`;
    return `${name}: ${w}x${hh} for ${tanks} tanks`;
  }

  private playerRow(p: PublicPlayer, room: RoomMsg, myId: string, num: string): HTMLElement {
    const teams = room.settings.teams > 0;
    const host = room.host === myId;
    return h(
      'li',
      { class: `player${p.id === myId ? ' me' : ''}${p.connected ? '' : ' away'}` },
      h('span', { class: 'num' }, num),
      h('i', { class: 'swatch', style: { '--c': paletteColor(p.color) } }),
      h(
        'span',
        { class: 'who' },
        h('span', { class: 'name' }, p.name),
        h(
          'span',
          { class: 'tags' },
          p.id === myId && tag('You'),
          p.id === room.host && tag('Host'),
          p.bot && tag(`Bot · ${BOT_LABEL[p.bot]}`),
          teams && p.seat >= 0 && p.team > 0 && teamTag(p.team),
          p.seat < 0 && tag('Bench'),
          !p.connected && tag('Away'),
        ),
      ),
      host && p.bot
        ? h(
            'button',
            { class: 'remove', type: 'button', 'data-key': `remove:${p.id}`, title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`, onclick: () => this.on.removeBot(p.id) },
            icon(ICONS.close, 16, 2.5),
          )
        : h('span', { class: 'remove-slot' }),
    );
  }

  /** Seated people block their colour, seated bots give theirs up, and the bench may share colours with each other. */
  private colorPicker(room: RoomMsg, me: PublicPlayer, teams: boolean): HTMLElement {
    const holders = new Map(room.players.filter((p) => p.seat >= 0 && p.id !== me.id).map((p) => [p.color, p]));
    const swatches = PALETTE.map((hex, i) => {
      const holder = holders.get(i);
      const mine = me.color === i;
      const blocked = !!holder && (!holder.bot || me.seat < 0);
      const name = PALETTE_NAMES[i]!;
      const text = mine ? `${name}, yours` : !holder ? name : blocked ? `${name}, taken by ${holder.name}` : `${name}, held by bot ${holder.name}`;
      const cls = ['pick', mine && 'on', holder && 'held', blocked && 'taken'].filter(Boolean).join(' ');
      return h(
        'button',
        {
          type: 'button',
          class: cls,
          style: { '--c': hex },
          'data-key': `color:${i}`,
          disabled: blocked,
          title: text,
          'aria-label': text,
          'aria-pressed': String(mine),
          onclick: () => {
            if (!mine) this.on.color(i);
          },
        },
        h('span', { class: 'pick-swatch' }, mine ? icon(ICONS.check, 22, 3) : holder ? h('b', { class: 'ini' }, initial(holder.name)) : null),
        h('span', { class: 'pick-name' }, name),
        h('span', { class: 'pick-who' }, mine ? 'You' : !holder ? 'Free' : holder.bot ? `Bot ${holder.name}` : holder.name),
      );
    });
    return box(
      { cls: 'colour-box', title: 'Your colour', note: PALETTE_NAMES[me.color] },
      h('p', { class: 'muted' }, 'One colour per tank. Letters mark who holds the rest.'),
      h('div', { class: 'picks', role: 'group', 'aria-label': 'Your colour' }, ...swatches),
      teams && h('p', { class: 'muted' }, 'Tanks wear team colours in team games. Your colour shows in this list and on the stats board.'),
    );
  }

  private teamPicker(count: number, mine: number): HTMLElement {
    const buttons = [];
    for (let t = 1; t <= count; t++) {
      buttons.push(
        h(
          'button',
          {
            type: 'button',
            class: t === mine ? 'on' : '',
            style: { '--c': TEAM_COLORS[t]! },
            'data-key': `team:${t}`,
            'aria-pressed': String(t === mine),
            onclick: () => this.on.team(t),
          },
          TEAM_NAMES[t]!,
        ),
      );
    }
    return box(
      { cls: 'team-box', title: 'Your team', note: TEAM_NAMES[mine] ? `${TEAM_NAMES[mine]} team` : undefined },
      h('div', { class: 'seg teams', role: 'group', 'aria-label': 'Your team' }, ...buttons),
    );
  }

  /** One settings row: the name (with a level meter or note under it) and its control. */
  private settingRow(name: string, sub: Child, control: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: 'setting' },
      h('span', { class: 'set-label' }, h('span', {}, name), typeof sub === 'string' ? h('span', { class: 'set-sub' }, sub) : sub),
      control,
    );
  }

  private segmented<T>(name: string, options: Option<T>[], value: T, enabled: boolean, pick: (v: T) => void, sub: Child = null, note = ''): HTMLElement {
    const group = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': name },
      ...options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            class: o.value === value ? 'on' : '',
            'data-key': `${name}:${String(o.value)}`,
            disabled: !enabled && o.value !== value,
            'aria-disabled': String(!enabled),
            'aria-pressed': String(o.value === value),
            onclick: () => {
              if (enabled && o.value !== value) pick(o.value);
            },
          },
          o.label,
        ),
      ),
    );
    return this.settingRow(name, sub, note ? h('div', { class: 'ctl' }, group, h('span', { class: 'ctl-note' }, note)) : group);
  }

  private stepper(name: string, value: number, [min, max]: readonly [number, number], enabled: boolean, change: (v: number) => void, sub = ''): HTMLElement {
    return this.settingRow(
      name,
      sub,
      h(
        'div',
        { class: 'stepper' },
        h(
          'button',
          { type: 'button', 'data-key': `${name}:-`, disabled: !enabled || value <= min, 'aria-label': `Less ${name}`, onclick: () => change(value - 1) },
          icon(ICONS.minus, 16, 2.5),
        ),
        meter(value, max),
        h('output', {}, String(value)),
        h(
          'button',
          { type: 'button', 'data-key': `${name}:+`, disabled: !enabled || value >= max, 'aria-label': `More ${name}`, onclick: () => change(value + 1) },
          icon(ICONS.plus, 16, 2.5),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Results

  private renderResults(room: RoomMsg, myId: string): void {
    const r = room.result;
    const teams = room.settings.teams > 0;
    const lives = room.settings.mode === 'lives';
    const byId = new Map(room.players.map((p) => [p.id, p]));
    const host = room.host === myId;
    // Results saved before the stats board only have standings, and kills and deaths on the room's players.
    const standing = (id: string) => (r?.standings.indexOf(id) ?? -1) + 1 || Infinity;
    const stats: PlayerStats[] = r?.stats.length
      ? r.stats
      : room.players
          .filter((p) => p.seat >= 0)
          .sort((a, b) => standing(a.id) - standing(b.id))
          .map((p) => ({ id: p.id, name: p.name, color: p.color, team: p.team, bot: p.bot, kills: p.kills, deaths: p.deaths, shots: 0, hits: 0, damage: 0, bestStreak: 0, crates: 0, bricks: 0 }));
    const statsById = new Map(stats.map((s) => [s.id, s]));
    // A winner who has left the room is only in the stats rows.
    const winners = (r?.winners ?? []).map((id) => byId.get(id) ?? statsById.get(id)).filter((p) => p !== undefined);

    const iWon = !!r && !r.draw && r.winners.includes(myId);
    let title = iWon ? 'You win' : 'Winner:';
    let name = winners[0]?.name ?? 'Nobody';
    let color: string | null = winners[0] ? playerColor(winners[0], teams) : null;
    let summary = '';
    if (!r || r.draw) {
      title = 'Draw';
      name = winners.length > 1 ? winners.map((p) => p.name).join(' & ') : 'Nobody wins';
      color = null;
      summary = winners.length > 1 ? 'Tied at the top.' : 'No tank came out ahead.';
    } else if (r.team > 0) {
      title = iWon ? 'Your team wins' : 'Winning team:';
      name = `${TEAM_NAMES[r.team]} team`;
      color = TEAM_COLORS[r.team]!;
      const members = stats.filter((s) => s.team === r.team);
      summary = `${plural(members.reduce((n, s) => n + s.kills, 0), 'kill')} between ${plural(members.length, 'tank')}.`;
    } else {
      const w = winners[0] && statsById.get(winners[0].id);
      if (w) summary = `${plural(w.kills, 'kill')}, ${plural(w.deaths, 'death')}, best streak ${w.bestStreak}.`;
    }

    const place = stats.findIndex((s) => s.id === myId);
    const mine = stats[place];
    const myAwards = (r?.awards ?? []).filter((a) => a.id === myId).map((a) => a.title);
    const lifeCount = room.settings.lives;
    const matchLine = `Match: ${lives ? `Lives, ${lifeCount} ${lifeCount === 1 ? 'life' : 'lives'}` : `Timed, ${room.settings.minutes} min`}${r?.seconds ? `, ${clock(r.seconds)}` : ''}`;
    const myLine =
      mine &&
      h(
        'div',
        { class: 'my-line' },
        tag('You', 'inv'),
        h('span', {}, `${ordinal(place + 1)} place, ${plural(mine.kills, 'kill')}${myAwards.length > 0 ? `, ${myAwards.join(', ')} ${myAwards.length > 1 ? 'awards' : 'award'}` : ''}`),
      );

    const awards = (r?.awards ?? []).map((a, i) => {
      const p = statsById.get(a.id) ?? byId.get(a.id);
      const yours = a.id === myId;
      return h(
        'article',
        { class: `award${yours ? ' me' : ''}` },
        h('div', { class: 'award-top' }, h('span', { class: 'num' }, yours ? `${pad2(i + 1)} · You` : pad2(i + 1)), icon(AWARD_ICONS[a.title] ?? ICONS.star, 28, 1.8)),
        h('h3', { class: 'award-title' }, a.title),
        h('div', { class: 'award-who' }, h('i', { class: 'swatch', style: { '--c': p ? playerColor(p, teams) : '#e8e8e3' } }), h('span', { class: 'nm' }, p?.name ?? ''), p?.bot && tag('Bot')),
        h('p', { class: 'award-text' }, a.text),
      );
    });

    const leave = h('button', { class: 'btn big', type: 'button', 'data-key': 'leave', onclick: () => this.on.leave() }, label('Leave'));
    this.panel!.className = 'room-panel results';
    fill(
      this.panel!,
      this.roomBar('results', h('span', { class: 'bar-note' }, `${plural(stats.length, 'tank')}${r?.seconds ? ` · ${clock(r.seconds)}` : ''}`)),
      h(
        'div',
        { class: 'page' },
        box(
          { cls: `double bright winner${iWon ? ' you' : ''}`, title: 'Match over' },
          h(
            'div',
            { class: 'win-main' },
            h('span', { class: 'win-label' }, title),
            h('h1', { class: 'win-name' }, color ? h('i', { class: 'win-swatch', style: { '--c': color } }) : null, h('span', {}, name)),
            summary ? prompt('', false, summary) : null,
          ),
          h('div', { class: 'win-side' }, prompt('', false, matchLine), myLine),
        ),
        awards.length > 0 &&
          h(
            'section',
            { class: 'sec' },
            h(
              'div',
              { class: 'sec-head' },
              h('h2', { class: 'sec-title' }, awards.length === 1 ? 'Top award' : `Top ${awards.length} awards`),
              h('span', { class: 'sec-note' }, "Picked from this match's stats"),
            ),
            h('div', { class: 'awards' }, ...awards),
          ),
        stats.length > 0 &&
          h(
            'section',
            { class: 'sec' },
            h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, 'Stats board'), h('span', { class: 'sec-note' }, '[n] = best in column')),
            this.statsBoard(stats, byId, myId, teams, lives),
          ),
        h(
          'footer',
          { class: 'results-foot' },
          host && h('button', { class: 'btn primary big', type: 'button', 'data-key': 'again', onclick: () => this.on.again() }, label('Play again'), tag('Host')),
          leave,
          prompt('foot-note', true, host ? 'Play again keeps the same players and settings.' : 'Waiting for the host to start the next round'),
        ),
      ),
    );
  }

  /** Every seat's numbers in standings order, the best in each column in brackets. Rows show the picked colour, even in team mode. */
  private statsBoard(stats: PlayerStats[], byId: Map<string, PublicPlayer>, myId: string, teams: boolean, lives: boolean): HTMLElement {
    const th = (text: string, title = text, cls = '') => h('th', { scope: 'col', title, class: cls }, text);
    const accuracy = (s: PlayerStats) => (s.shots > 0 ? Math.round((100 * s.hits) / s.shots) : NaN);
    const column = (pick: (s: PlayerStats) => number, high = true) => best(stats.map(pick), high);
    const top = {
      kills: column((s) => s.kills),
      deaths: column((s) => s.deaths, false),
      accuracy: column(accuracy),
      damage: column((s) => s.damage),
      streak: column((s) => s.bestStreak),
      crates: column((s) => s.crates),
      bricks: column((s) => s.bricks),
    };
    const num = (value: number, bestValue: number) => (value === bestValue ? h('td', { class: 'best' }, `[${value}]`) : h('td', {}, String(value)));
    const accCell = (s: PlayerStats) => {
      const pct = accuracy(s);
      if (Number.isNaN(pct)) return h('td', { class: 'l' }, '-');
      const isBest = pct === top.accuracy;
      return h('td', { class: isBest ? 'l best' : 'l' }, h('span', { class: 'acc' }, meter(Math.round(pct / 10), 10), isBest ? `[${pct}%]` : `${pct}%`));
    };
    const livesLeft = (id: string) => {
      const p = byId.get(id);
      return !p ? '-' : p.out ? 'Out' : String(p.lives);
    };
    const rows = stats.map((s, i) =>
      h(
        'tr',
        { class: s.id === myId ? 'me' : '' },
        h('td', { class: 'l rank' }, pad2(i + 1)),
        h(
          'td',
          { class: 'l' },
          h(
            'span',
            { class: 'who' },
            h('i', { class: 'swatch', style: { '--c': paletteColor(s.color) } }),
            h('span', { class: 'nm' }, s.name),
            s.id === myId && tag('You'),
            s.bot && tag(`Bot ${BOT_LABEL[s.bot]}`),
          ),
        ),
        teams && h('td', { class: 'l' }, s.team > 0 && teamTag(s.team)),
        num(s.kills, top.kills),
        num(s.deaths, top.deaths),
        lives && h('td', {}, livesLeft(s.id)),
        accCell(s),
        num(s.damage, top.damage),
        num(s.bestStreak, top.streak),
        num(s.crates, top.crates),
        num(s.bricks, top.bricks),
      ),
    );
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'standings' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            th('#', 'Place', 'l'),
            th('Player', 'Player', 'l'),
            teams && th('Team', 'Team', 'l'),
            th('Kills'),
            th('Deaths'),
            lives && th('Lives', 'Lives left'),
            th('Accuracy', 'Accuracy: hits per shot', 'l'),
            th('Damage', 'Damage dealt'),
            th('Best streak', 'Most kills in one life'),
            th('Crates', 'Crates grabbed'),
            th('Bricks', 'Bricks smashed'),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Menu

  toggleMenu(): void {
    if (this.menuEl) this.closeMenu();
    else this.openMenu();
  }

  openMenu(): void {
    if (this.menuEl || !this.code) return;
    const soundText = label(this.prefs.muted ? 'Sound: Off' : 'Sound: On');
    const sound = h('button', { class: 'btn', type: 'button' }, soundText);
    sound.addEventListener('click', () => {
      this.prefs.muted = this.on.mute();
      soundText.textContent = this.prefs.muted ? 'Sound: Off' : 'Sound: On';
    });
    const resume = h(
      'button',
      { class: 'btn primary', type: 'button', onclick: () => this.closeMenu() },
      label('Resume'),
      h('span', { class: 'hint key-hint', 'aria-hidden': 'true' }, 'Esc'),
    );
    this.menuEl = h(
      'div',
      {
        class: 'menu-wrap',
        onpointerdown: (e: Event) => {
          if (e.target === this.menuEl) this.closeMenu();
        },
      },
      h(
        'div',
        { class: 'box double menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu' },
        boxHead('Menu', `Room ${this.code}`),
        resume,
        sound,
        this.crtButton('btn'),
        h('button', { class: 'btn', type: 'button', onclick: () => void this.share() }, label('Invite link')),
        h('button', { class: 'btn', type: 'button', onclick: () => this.on.leave() }, label('Leave room')),
      ),
    );
    this.root.appendChild(this.menuEl);
    resume.focus();
  }

  closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    // Space and Enter drive the tank; a focused button would take them too.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
}
