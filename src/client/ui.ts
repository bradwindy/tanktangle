import { CODE_LENGTH, MAX_SEATS, NAME_MAX, PALETTE, TEAM_COLORS, TEAM_NAMES } from '../shared/constants';
import { mazeSizeFor } from '../shared/maze';
import type { PublicPlayer, RoomMsg } from '../shared/protocol';
import { LIMITS, type Settings } from '../shared/settings';
import { BOT_LEVELS, type BotLevel } from '../shared/types';
import { fill, h, type Child } from './dom';
import type { NetStatus } from './net';

export interface UiHandlers {
  create(name: string): void;
  join(code: string, name: string): void;
  /** Name entered on an invite link. */
  enter(name: string): void;
  leave(): void;
  settings(patch: Partial<Settings>): void;
  start(): void;
  again(): void;
  addBot(level: BotLevel): void;
  removeBot(id: string): void;
  team(team: number): void;
  /** Toggles sound, returns whether it is now muted. */
  mute(): boolean;
  /** Toggles the CRT effect, returns whether it is now on. */
  crt(): boolean;
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
const SPEEDS = ['Slow', 'Easy', 'Normal', 'Fast', 'Turbo'].map((label, value) => ({ value, label }));
const BOT_LABEL: Record<BotLevel, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

const FINAL_TEXT: Partial<Record<NetStatus, { title: string; text: string; reload: boolean }>> = {
  replaced: { title: 'Opened in another tab', text: 'This room is open in another tab or window. Carry on there.', reload: false },
  outdated: { title: 'New version available - reload', text: 'Tank Tangle was updated while you were here.', reload: true },
  full: { title: 'Room is full', text: 'This room already has as many people as it can hold.', reload: false },
};

const coarse = () => matchMedia('(pointer: coarse)').matches;

export const playerColor = (p: PublicPlayer, teams: boolean) => (teams && p.team > 0 ? TEAM_COLORS[p.team]! : PALETTE[p.color] ?? PALETTE[0]);

function logo(small = false): HTMLElement {
  return h('h1', { class: small ? 'logo small' : 'logo' }, h('span', { class: 'l1' }, 'TANK'), h('span', { class: 'l2' }, 'TANGLE'));
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

  constructor(
    private root: HTMLElement,
    private on: UiHandlers,
    private prefs: { muted: boolean; crt: boolean },
  ) {
    this.toastEl = h('div', { class: 'toast hidden', role: 'status' });
    root.append(this.toastEl);
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

  showHome(name: string, error = ''): void {
    this.clear();
    const nameEl = this.nameInput(name);
    const codeEl = h('input', {
      class: 'input code',
      maxLength: CODE_LENGTH,
      placeholder: 'CODE',
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
        class: 'panel start-card',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const n = needName();
          if (n) this.on.create(n);
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Your name'), nameEl),
      h('button', { class: 'btn primary big', type: 'submit' }, 'Create room'),
      h('div', { class: 'or' }, h('span', {}, 'or join with a code')),
      h('div', { class: 'row' }, codeEl, h('button', { class: 'btn', type: 'button', onclick: join }, 'Join')),
      err,
    );
    this.screen = h(
      'main',
      { class: 'screen home' },
      h('div', { class: 'home-inner' }, logo(), h('p', { class: 'tagline' }, 'Maze tank battles for 2 to 12. Share a link, bank your shots, blow up the walls.'), h('div', { class: 'home-cards' }, form, this.howTo())),
    );
    this.root.append(this.screen);
  }

  private howTo(): HTMLElement {
    const key = (k: string) => h('kbd', {}, k);
    return h(
      'section',
      { class: 'panel howto' },
      h('h2', {}, 'How to play'),
      h(
        'ul',
        {},
        h('li', {}, h('b', {}, 'Drive '), key('W'), key('A'), key('S'), key('D'), ' or arrows'),
        h('li', {}, h('b', {}, 'Fire '), key('Space'), ' or ', key('Enter'), ', hold to keep firing'),
        h('li', {}, h('b', {}, 'Phone '), 'left thumb steers, right thumb fires'),
        h('li', {}, 'Bullets bounce off walls. Your own can hit you.'),
        h('li', {}, 'Brick walls break and grow back. Steel never breaks.'),
        h('li', {}, 'Grab crates for lasers, missiles, mines and more.'),
        h('li', {}, key('Esc'), ' opens the menu.'),
      ),
    );
  }

  showNamePrompt(code: string, name: string, back: () => void): void {
    this.clear();
    const nameEl = this.nameInput(name);
    const err = h('p', { class: 'error', role: 'alert' });
    this.screen = h(
      'main',
      { class: 'screen home' },
      h(
        'div',
        { class: 'home-inner narrow' },
        logo(true),
        h(
          'form',
          {
            class: 'panel start-card',
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
          h('p', { class: 'invite' }, "You're invited to room ", h('b', { class: 'room-code inline' }, code)),
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Your name'), nameEl),
          h('button', { class: 'btn primary big', type: 'submit' }, 'Join room'),
          err,
          h('button', { class: 'btn ghost', type: 'button', onclick: back }, 'Back'),
        ),
      ),
    );
    this.root.append(this.screen);
    nameEl.focus();
  }

  showRoom(code: string): void {
    this.clear();
    this.code = code;
    this.panel = h('section', { class: 'panel room-panel hidden' });
    this.conn = h('div', { class: 'conn hidden', role: 'status' });
    this.root.append(this.panel, this.conn);
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
    this.setConn(state.status, !state.room);
    const room = state.room;
    if (!room || FINAL_TEXT[state.status]) {
      this.panel.classList.add('hidden');
      return;
    }
    const key = JSON.stringify([room.phase, room.host, room.settings, room.players, room.result, state.myId]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    if (room.phase === 'lobby') this.renderLobby(room, state.myId);
    else if (room.phase === 'over') this.renderResults(room, state.myId);
    else {
      this.panel.classList.add('hidden');
      return;
    }
    this.panel.classList.remove('hidden');
  }

  private setConn(status: NetStatus, joining: boolean): void {
    if (!this.conn) return;
    const key = `${status}:${joining}`;
    if (key === this.connKey) return;
    this.connKey = key;
    const final = FINAL_TEXT[status];
    this.conn.className = final ? 'conn final' : 'conn';
    if (final) {
      this.conn.replaceChildren(
        h(
          'div',
          { class: 'panel final-card' },
          h('h2', {}, final.title),
          h('p', {}, final.text),
          final.reload
            ? h('button', { class: 'btn primary big', type: 'button', onclick: () => location.reload() }, 'Reload')
            : h('button', { class: 'btn primary big', type: 'button', onclick: () => this.on.leave() }, 'Back home'),
        ),
      );
      return;
    }
    if (status === 'open' && !joining) {
      this.conn.classList.add('hidden');
      return;
    }
    const text = status === 'reconnecting' ? 'Reconnecting' : status === 'open' ? 'Joining room' : 'Connecting';
    this.conn.replaceChildren(h('div', { class: 'banner' }, h('i', { class: 'spinner' }), `${text}...`));
  }

  // ---------------------------------------------------------------------------------------------
  // Lobby

  private renderLobby(room: RoomMsg, myId: string): void {
    const host = room.host === myId;
    const s = room.settings;
    const teams = s.teams > 0;
    const seated = room.players.filter((p) => p.seat >= 0).sort((a, b) => a.seat - b.seat);
    const bench = room.players.filter((p) => p.seat < 0);
    const me = room.players.find((p) => p.id === myId);
    const hostName = room.players.find((p) => p.id === room.host)?.name ?? 'the host';
    const set = (patch: Partial<Settings>) => this.on.settings(patch);

    const blocker = this.startBlocker(room);
    const startLabel = host ? (blocker ?? `Start with ${seated.length} tanks`) : `Waiting for ${hostName} to start`;

    const left: Child[] = [
      h('h2', {}, `Players ${seated.length}/${MAX_SEATS}`),
      h('ul', { class: 'players' }, ...seated.map((p) => this.playerRow(p, room, myId))),
      host &&
        h(
          'div',
          { class: 'setting' },
          h('span', { class: 'label' }, 'Add a bot'),
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Add a bot' },
            ...BOT_LEVELS.map((level) =>
              h('button', { type: 'button', disabled: seated.length >= MAX_SEATS, onclick: () => this.on.addBot(level) }, `+ ${BOT_LABEL[level]}`),
            ),
          ),
        ),
      teams && me && me.seat >= 0 && this.teamPicker(s.teams, me.team),
      bench.length > 0 && h('h3', {}, 'Bench'),
      bench.length > 0 && h('p', { class: 'muted' }, 'Waiting for a free seat. Benched players get seats first next match.'),
      bench.length > 0 && h('ul', { class: 'players bench' }, ...bench.map((p) => this.playerRow(p, room, myId))),
    ];

    const tanks = Math.max(2, seated.length);
    const right: Child[] = [
      h('h2', {}, 'Settings', !host && h('span', { class: 'muted small' }, ' (host picks)')),
      h(
        'div',
        { class: 'settings' },
        this.segmented('Mode', MODES, s.mode, host, (mode) => set({ mode })),
        s.mode === 'lives'
          ? this.stepper('Lives', s.lives, LIMITS.lives, host, (lives) => set({ lives }))
          : this.stepper('Minutes', s.minutes, LIMITS.minutes, host, (minutes) => set({ minutes })),
        this.slider('Maze size', s.mazeSize, LIMITS.mazeSize, host, (v) => this.sizeLabel(v, tanks), (mazeSize) => set({ mazeSize })),
        this.segmented('Teams', TEAMS, s.teams, host, (t) => set({ teams: t })),
        teams && this.segmented('Friendly fire', ON_OFF, s.friendlyFire, host, (friendlyFire) => set({ friendlyFire })),
        this.segmented('Power-ups', POWERUPS, s.powerups, host, (powerups) => set({ powerups })),
        this.segmented('Bricks', BRICKS, s.bricks, host, (bricks) => set({ bricks })),
        this.segmented('Game speed', SPEEDS, s.speed, host, (speed) => set({ speed })),
        this.stepper('Bullet bounces', s.bounces, LIMITS.bounces, host, (bounces) => set({ bounces })),
      ),
    ];

    this.panel!.className = 'panel room-panel lobby';
    this.panel!.replaceChildren(
      h(
        'header',
        { class: 'lobby-head' },
        h('div', { class: 'code-box' }, h('span', { class: 'label' }, 'Room'), h('b', { class: 'room-code' }, this.code)),
        h('button', { class: 'btn primary', type: 'button', onclick: () => void this.share() }, coarse() && 'share' in navigator ? 'Share invite link' : 'Copy invite link'),
      ),
      h('div', { class: 'cols' }, h('div', { class: 'col' }, ...left), h('div', { class: 'col' }, ...right)),
      h(
        'footer',
        { class: 'lobby-foot' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => this.on.leave() }, 'Leave'),
        h('button', { class: 'btn primary big start', type: 'button', disabled: !host || !!blocker, onclick: () => this.on.start() }, startLabel),
      ),
    );
  }

  /** Why the match cannot start yet, or null. Mirrors the server's start guard. */
  private startBlocker(room: RoomMsg): string | null {
    const seated = room.players.filter((p) => p.seat >= 0);
    if (seated.length < 2) return 'Need 2 tanks: add a bot or share the link';
    if (room.settings.teams > 0 && new Set(seated.map((p) => p.team).filter((t) => t > 0)).size < 2) return 'Need tanks on 2 teams';
    return null;
  }

  private sizeLabel(step: number, tanks: number): string {
    const { w, h: hh } = mazeSizeFor(tanks, step);
    const name = step === 0 ? 'Auto' : step > 0 ? `+${step}` : String(step);
    return `${name} (${w}x${hh})`;
  }

  private playerRow(p: PublicPlayer, room: RoomMsg, myId: string): HTMLElement {
    const teams = room.settings.teams > 0;
    const host = room.host === myId;
    return h(
      'li',
      { class: `player${p.id === myId ? ' me' : ''}${p.connected ? '' : ' away'}` },
      h('i', { class: 'swatch', style: { '--c': playerColor(p, teams) } }),
      h('span', { class: 'name' }, p.name),
      p.id === room.host && h('i', { class: 'crown', title: 'Host', 'aria-label': 'Host' }),
      p.id === myId && h('span', { class: 'tag you' }, 'You'),
      p.bot && h('span', { class: 'tag bot' }, `Bot ${BOT_LABEL[p.bot]}`),
      teams && p.seat >= 0 && p.team > 0 && h('span', { class: 'tag team', style: { '--c': TEAM_COLORS[p.team]! } }, TEAM_NAMES[p.team]!),
      !p.connected && h('span', { class: 'tag away' }, 'Away'),
      host && p.bot && h('button', { class: 'remove', type: 'button', title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`, onclick: () => this.on.removeBot(p.id) }, 'x'),
    );
  }

  private teamPicker(count: number, mine: number): HTMLElement {
    const buttons = [];
    for (let t = 1; t <= count; t++) {
      buttons.push(
        h(
          'button',
          { type: 'button', class: t === mine ? 'on' : '', style: { '--c': TEAM_COLORS[t]! }, 'aria-pressed': String(t === mine), onclick: () => this.on.team(t) },
          TEAM_NAMES[t]!,
        ),
      );
    }
    return h('div', { class: 'setting' }, h('span', { class: 'label' }, 'Your team'), h('div', { class: 'seg teams', role: 'group', 'aria-label': 'Your team' }, ...buttons));
  }

  private segmented<T>(label: string, options: Option<T>[], value: T, enabled: boolean, pick: (v: T) => void): HTMLElement {
    return h(
      'div',
      { class: 'setting' },
      h('span', { class: 'label' }, label),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': label },
        ...options.map((o) =>
          h(
            'button',
            {
              type: 'button',
              class: o.value === value ? 'on' : '',
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
      ),
    );
  }

  private stepper(label: string, value: number, [min, max]: readonly [number, number], enabled: boolean, change: (v: number) => void): HTMLElement {
    return h(
      'div',
      { class: 'setting' },
      h('span', { class: 'label' }, label),
      h(
        'div',
        { class: 'stepper' },
        h('button', { type: 'button', disabled: !enabled || value <= min, 'aria-label': `Less ${label}`, onclick: () => change(value - 1) }, '-'),
        h('output', {}, String(value)),
        h('button', { type: 'button', disabled: !enabled || value >= max, 'aria-label': `More ${label}`, onclick: () => change(value + 1) }, '+'),
      ),
    );
  }

  private slider(
    label: string,
    value: number,
    [min, max]: readonly [number, number],
    enabled: boolean,
    describe: (v: number) => string,
    change: (v: number) => void,
  ): HTMLElement {
    const out = h('output', {}, describe(value));
    const input = h('input', { type: 'range', min, max, step: 1, value, disabled: !enabled, 'aria-label': label });
    input.addEventListener('input', () => {
      out.textContent = describe(Number(input.value));
    });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (v !== value) change(v);
    });
    return h('div', { class: 'setting' }, h('span', { class: 'label' }, label), h('div', { class: 'slider' }, input, out));
  }

  // ---------------------------------------------------------------------------------------------
  // Results

  private renderResults(room: RoomMsg, myId: string): void {
    const r = room.result;
    const teams = room.settings.teams > 0;
    const lives = room.settings.mode === 'lives';
    const byId = new Map(room.players.map((p) => [p.id, p]));
    const host = room.host === myId;
    const winners = (r?.winners ?? []).map((id) => byId.get(id)).filter((p): p is PublicPlayer => !!p);
    let title = 'WINNER';
    let name = winners[0]?.name ?? 'Nobody';
    let color = winners[0] ? playerColor(winners[0], teams) : '#ffffff';
    if (!r || r.draw) {
      title = 'DRAW';
      name = winners.length > 1 ? winners.map((p) => p.name).join(' & ') : 'Nobody wins';
      color = '#ffe14d';
    } else if (r.team > 0) {
      title = 'WINNING TEAM';
      name = `${TEAM_NAMES[r.team]} team`;
      color = TEAM_COLORS[r.team]!;
    }
    const iWon = !!r && !r.draw && r.winners.includes(myId);
    const order = r?.standings.length ? r.standings : room.players.filter((p) => p.seat >= 0).map((p) => p.id);
    const rows = order
      .map((id) => byId.get(id))
      .filter((p): p is PublicPlayer => !!p)
      .map((p, i) =>
        h(
          'tr',
          { class: p.id === myId ? 'me' : '' },
          h('td', { class: 'rank' }, String(i + 1)),
          h('td', { class: 'who' }, h('i', { class: 'swatch', style: { '--c': playerColor(p, teams) } }), h('span', {}, p.name), p.bot && h('span', { class: 'tag bot' }, 'Bot')),
          h('td', {}, String(p.kills)),
          h('td', {}, String(p.deaths)),
          lives && h('td', {}, p.out ? 'Out' : String(p.lives)),
        ),
      );
    const awards = (r?.awards ?? []).map((a) => {
      const p = byId.get(a.id);
      return h(
        'div',
        { class: 'award', style: { '--c': p ? playerColor(p, teams) : '#ffffff' } },
        h('b', { class: 'award-title' }, a.title),
        h('span', { class: 'award-name' }, p?.name ?? ''),
        h('span', { class: 'award-text muted' }, a.text),
      );
    });
    this.panel!.className = 'panel room-panel results';
    fill(
      this.panel!,
      h(
        'div',
        { class: `winner${iWon ? ' you' : ''}`, style: { '--c': color } },
        h('span', { class: 'label' }, iWon ? 'YOU WIN' : title),
        h('b', { class: 'wname' }, name),
      ),
      h(
        'table',
        { class: 'standings' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Player'), h('th', { title: 'Kills' }, 'K'), h('th', { title: 'Deaths' }, 'D'), lives && h('th', {}, 'Lives'))),
        h('tbody', {}, ...rows),
      ),
      awards.length > 0 && h('div', { class: 'awards' }, ...awards),
      h(
        'footer',
        { class: 'lobby-foot' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => this.on.leave() }, 'Leave'),
        host
          ? h('button', { class: 'btn primary big', type: 'button', onclick: () => this.on.again() }, 'Play again')
          : h('p', { class: 'muted waiting' }, 'Waiting for the host to start the next round'),
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
    const sound = h('button', { class: 'btn', type: 'button' }, this.prefs.muted ? 'Sound: Off' : 'Sound: On');
    sound.addEventListener('click', () => {
      this.prefs.muted = this.on.mute();
      sound.textContent = this.prefs.muted ? 'Sound: Off' : 'Sound: On';
    });
    const crt = h('button', { class: 'btn', type: 'button' }, this.prefs.crt ? 'CRT effect: On' : 'CRT effect: Off');
    crt.addEventListener('click', () => {
      this.prefs.crt = this.on.crt();
      crt.textContent = this.prefs.crt ? 'CRT effect: On' : 'CRT effect: Off';
    });
    const resume = h('button', { class: 'btn primary', type: 'button', onclick: () => this.closeMenu() }, 'Resume');
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
        { class: 'panel menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu' },
        h('h2', {}, 'Menu'),
        h('p', { class: 'muted' }, 'Room ', h('b', { class: 'room-code inline' }, this.code)),
        resume,
        sound,
        crt,
        h('button', { class: 'btn', type: 'button', onclick: () => void this.share() }, 'Invite link'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => this.on.leave() }, 'Leave room'),
      ),
    );
    this.root.append(this.menuEl);
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
